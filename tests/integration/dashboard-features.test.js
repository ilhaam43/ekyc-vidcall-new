import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { createDb } from '@ekyc/shared/db';
import { createDashboardApp } from '../../ekyc-dashboard-new/server/app.js';
import { createApp as createMasterApp } from '../../ekyc-backend-master/src/app.js';
import { processOneExport } from '../../ekyc-dashboard-new/server/exports.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Isolated test database required');
const db = createDb(url), suffix = randomUUID(), adminId = randomUUID();
const sessions = new Map(), objects = new Map(), banks = [], plans = [], accounts = [], links = [];
const redis = { set: async (key, value) => sessions.set(key, value), get: async key => sessions.get(key), del: async key => sessions.delete(key), expire: async () => true };
let corruptChecksum = false, deactivateFailure = false, mail, masterServer, client, headers, bank, application, customerId, callId, documentId;
const storage = {
  ensureBucket: async () => {},
  put: async (bucket, key, bytes) => objects.set(`${bucket}/${key}`, bytes),
  checksum: async (bucket, key) => ({ sha256: corruptChecksum ? 'wrong' : createHash('sha256').update(objects.get(`${bucket}/${key}`)).digest('hex') }),
  get: async (bucket, key) => ({ Body: Readable.from(objects.get(`${bucket}/${key}`)) }),
};
const cfg = { origin: 'http://localhost:5301', production: false, mockExternal: true, exportBucket: 'test', gatewaySecret: 'dashboard-test-gateway-secret', encryptionMock: true };
const adapters = { kong: { provision: async row => ({ id: `synthetic-${row.id}`, mode: 'synthetic', api_key: 'synthetic-test-key' }), applyPlan: async () => ({ rate_limit_per_minute: 100, acl_group: 'test' }), deactivate: async () => { if (deactivateFailure) throw Object.assign(new Error('down'), { status: 503, code: 'KONG_UNAVAILABLE' }); } }, usage: { forApplication: async () => ({ source: 'synthetic', totals: [] }) }, email: { sendReset: async data => { mail = data; } } };
const app = createDashboardApp(db, redis, cfg, storage, adapters), p = '/dashboard/api/v1';
async function send(method, path, body, status = 200) {
  const response = await client[method](`${p}${path}`).set(headers).send(body); expect(response.status, JSON.stringify(response.body)).toBe(status); return response.body.data;
}
beforeAll(async () => {
  await db.migrate.latest({ directory: new URL('../../migrations', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), tableName: 'platform_migrations' });
  await db('dashboard_accounts').insert({ id: adminId, username: `features-${suffix}`, email: `${suffix}@example.test`, role: 'superadmin', password_hash: await bcrypt.hash('dashboard-test-password', 12) });
  masterServer = createMasterApp(db, { ...cfg, documentBucket: 'documents' }, storage).listen(0, '127.0.0.1');
  await new Promise(resolve => masterServer.once('listening', resolve)); cfg.masterUrl = `http://127.0.0.1:${masterServer.address().port}`;
  client = request.agent(app); const login = await client.post(`${p}/login`).send({ username: `features-${suffix}`, password: 'dashboard-test-password' }); expect(login.status).toBe(200); headers = { 'x-csrf-token': login.body.data.csrf };
  bank = await send('post', '/banks', { name: 'Feature test bank', username: `feature-${suffix}` }); banks.push(bank);
  const plan = await send('post', '/plans', { name: 'Feature plan', shortname: `feature-${suffix}`, features: ['user', 'agent'], limits: { requests_per_minute: 60 } }); plans.push(plan);
  application = await send('post', '/applications', { bank_id: bank.id, plan_id: plan.id, name: 'Feature app' });
  customerId = randomUUID(); callId = randomUUID(); documentId = randomUUID();
  await db('platform_customers').insert({ id: customerId, tenant_id: bank.tenant_id, data: { name: 'Synthetic customer', id_number: 'SYNTHETIC-ONLY' }, encryption_format: 'synthetic-plaintext' });
  await db('dashboard_customer_applications').insert({ application_id: application.id, customer_id: customerId });
  await db('platform_calls').insert({ id: callId, tenant_id: bank.tenant_id, user_id: customerId, room: `test-${callId}`, registration_key: callId, state: 'completed', outcome: 'verified', notification: { secret: 'must-not-leak' } });
  await db('platform_recordings').insert({ id: randomUUID(), call_id: callId, tenant_id: bank.tenant_id, state: 'stored', bytes: 10, sha256: 'test-checksum' });
  await db('platform_documents').insert({ id: documentId, tenant_id: bank.tenant_id, user_id: customerId, type: 'identity', bucket: 'documents', object_key: documentId, mimetype: 'application/pdf' }); objects.set(`documents/${documentId}`, Buffer.from('%PDF-synthetic'));
  await db('platform_quotas').insert({ tenant_id: bank.tenant_id, service: 'videocalls.post', remaining: 20 });
});
afterAll(async () => {
  await new Promise(resolve => masterServer.close(resolve));
  await db.transaction(async trx => {
    await trx('dashboard_exports').where({ application_id: application.id }).del();
    await trx('dashboard_application_agents').where({ application_id: application.id }).del();
    await trx('platform_sessions').where({ tenant_id: bank.tenant_id }).del();
    await trx('platform_agents').where({ tenant_id: bank.tenant_id }).del();
    await trx('platform_recordings').where({ call_id: callId }).del(); await trx('platform_calls').where({ id: callId }).del();
    await trx('platform_documents').where({ user_id: customerId }).del(); await trx('dashboard_customer_applications').where({ application_id: application.id }).del();
    await trx('platform_customers').where({ id: customerId }).del(); await trx('platform_audit').where({ tenant_id: bank.tenant_id }).del();
    await trx('platform_quotas').where({ tenant_id: bank.tenant_id }).del();
    await trx('dashboard_applications').where({ bank_id: bank.id }).del();
    await trx('dashboard_officers').where({ bank_id: bank.id }).del();
    await trx('dashboard_accounts').whereIn('id', [adminId, ...accounts]).del();
    await trx('dashboard_links').whereIn('id', links).del();
    await trx('dashboard_plans').whereIn('id', plans.map(row => row.id)).del();
    await trx('dashboard_audit').where({ actor_id: adminId }).del();
    for (const row of banks) { await trx('dashboard_banks').where({ id: row.id }).del(); await trx('platform_tenants').where({ id: row.tenant_id }).del(); }
  }); await db.destroy();
});
test('unauthenticated requests, CSRF and forged origins are rejected', async () => {
  expect((await request(app).get(`${p}/summary`)).status).toBe(401);
  expect((await client.post(`${p}/banks`).send({})).status).toBe(403);
  expect((await client.post(`${p}/banks`).set(headers).set('origin', 'https://forged.test').send({})).status).toBe(403);
});
test('summary, bank list/detail/update and invalid bank input', async () => {
  expect((await send('get', '/summary')).banks).toBeGreaterThan(0);
  expect((await send('get', '/banks')).some(row => row.id === bank.id)).toBe(true);
  expect((await send('get', `/banks/${bank.id}`)).tenant_id).toBe(bank.tenant_id);
  expect((await send('patch', `/banks/${bank.id}`, { name: 'Updated feature bank' })).name).toBe('Updated feature bank');
  await send('post', '/banks', { username: '!' }, 422);
});
test('plan list/update, invalid limits and protected deletion', async () => {
  expect((await send('get', '/plans')).some(row => row.id === plans[0].id)).toBe(true);
  await send('patch', `/plans/${plans[0].id}`, { description: 'Updated' });
  await send('post', '/plans', { name: 'Bad plan', shortname: 'bad', features: [], limits: { requests_per_minute: -1 } }, 422);
  await send('delete', `/plans/${plans[0].id}`, undefined, 409);
  const spare = await send('post', '/plans', { name: 'Unused', shortname: `unused-${suffix}`, features: [] }); plans.push(spare);
  await send('delete', `/plans/${spare.id}`);
});
test('application edit, approval, plan reassignment and locked edits', async () => {
  expect((await send('get', '/app-requests')).some(row => row.id === application.id)).toBe(true);
  await send('patch', `/applications/${application.id}`, { name: 'Edited app' });
  expect((await send('post', `/applications/${application.id}/approve`, {})).status).toBe('confirmed');
  await send('patch', `/applications/${application.id}`, { name: 'Locked' }, 409);
  await send('post', `/applications/${application.id}/plan`, { plan_id: plans[0].id });
  await send('delete', `/banks/${bank.id}`, undefined, 409);
});
test('application rejection returns reason in audit and cannot approve rejected requests', async () => {
  const row = await send('post', '/applications', { bank_id: bank.id, plan_id: plans[0].id, name: 'Rejected test' });
  expect((await send('post', `/applications/${row.id}/reject`, { reason: 'Test reason' })).status).toBe('rejected');
  await send('post', `/applications/${row.id}/approve`, {}, 409);
  expect((await db('dashboard_audit').where({ action: 'application.rejected', actor_id: adminId }).first()).metadata.reason).toBe('Test reason');
});
test('application suspension/reactivation preserves data, validates bank status and is idempotent', async () => {
  deactivateFailure = true;
  await send('post', `/applications/${application.id}/status`, { status: 'inactive' }, 503);
  expect((await db('dashboard_applications').where({ id: application.id }).first()).status).toBe('confirmed'); deactivateFailure = false;
  const inactive = await send('post', `/applications/${application.id}/status`, { status: 'inactive' }); expect(inactive.status).toBe('inactive');
  await send('post', `/applications/${application.id}/status`, { status: 'inactive' });
  expect((await db('dashboard_audit').where({ actor_id: adminId, action: 'application.deactivated' })).length).toBe(1);
  expect((await db('platform_customers').where({ id: customerId }).first()).deleted_at).toBeNull();
  expect((await db('platform_calls').where({ id: callId }).first()).state).toBe('completed');
  const partner = await request(app).post('/partner/v1/video-call/users').set('x-consumer-id', inactive.kong_consumer_id).send({}); expect(partner.status).toBe(403);
  await send('patch', `/banks/${bank.id}`, { active: false });
  await send('post', `/applications/${application.id}/status`, { status: 'confirmed' }, 409);
  await send('patch', `/banks/${bank.id}`, { active: true });
  const active = await send('post', `/applications/${application.id}/status`, { status: 'confirmed' }); expect(active.kong_consumer_id).toBe(inactive.kong_consumer_id); expect(active.status).toBe('confirmed');
  await send('post', `/applications/${application.id}/status`, { status: 'deleted' }, 422);
});
test('account creation/update/deactivation hides password hashes and prevents self-disable', async () => {
  const row = await send('post', '/accounts', { username: `account-${suffix}`, email: `bank-${suffix}@example.test`, role: 'bank', bank_id: bank.id, password: 'test-account-password' }); accounts.push(row.id);
  expect(row.password_hash).toBeUndefined();
  expect((await send('get', '/accounts')).every(item => !item.password_hash)).toBe(true);
  await send('patch', `/accounts/${row.id}`, { email: `changed-${suffix}@example.test` });
  await send('delete', `/accounts/${adminId}`, undefined, 409);
  await send('delete', `/accounts/${row.id}`); expect((await db('dashboard_accounts').where({ id: row.id }).first()).active).toBe(false);
});
test('officer create/update/list/deactivate and password policy', async () => {
  const row = await send('post', '/officers', { bank_id: bank.id, username: `officer-${suffix}`, name: 'Test officer', password: 'test-officer-password' });
  expect(row.password_hash).toBeUndefined(); await send('patch', `/officers/${row.id}`, { name: 'Updated officer' });
  expect((await send('get', '/officers')).some(item => item.id === row.id)).toBe(true);
  await send('patch', `/officers/${row.id}`, { password: 'short' }, 422); await send('delete', `/officers/${row.id}`);
});
test('agent provisioning maps tenant/application and password change revokes sessions', async () => {
  const row = await send('post', '/agents', { application_id: application.id, username: `agent-${suffix}`, name: 'Test agent', password: 'test-agent-password' });
  expect((await send('get', `/agents?application_id=${application.id}`)).some(item => item.id === row.id)).toBe(true);
  const sid = randomUUID(); await db('platform_sessions').insert({ id: sid, tenant_id: bank.tenant_id, subject_id: row.id, role: 'agent', expires_at: new Date(Date.now() + 60000) });
  await send('patch', `/agents/${row.id}`, { application_id: application.id, name: 'Updated agent', password: 'new-agent-password' });
  expect((await db('platform_sessions').where({ id: sid }).first()).revoked_at).toBeTruthy();
  await send('delete', `/agents/${row.id}?application_id=${application.id}`); expect((await db('platform_agents').where({ id: row.id }).first()).active).toBe(false);
});
test('links create/edit/delete and insecure URLs are rejected', async () => {
  await send('post', '/links', { name: 'Bad', url: 'http://example.test' }, 422);
  const row = await send('post', '/links', { name: 'Test link', url: 'https://example.test' }); links.push(row.id);
  await send('patch', `/links/${row.id}`, { name: 'Updated link' }); expect((await send('get', '/links')).some(item => item.id === row.id)).toBe(true);
  await send('delete', `/links/${row.id}`);
});
test('customer list/detail/documents are delegated to the master contract', async () => {
  expect((await send('get', `/customers?application_id=${application.id}`))[0].name).toBe('Synthetic customer');
  expect((await send('get', `/customers/${customerId}?application_id=${application.id}`)).id).toBe(customerId);
  expect((await send('get', `/customers/${customerId}/documents?application_id=${application.id}`))[0].id).toBe(documentId);
  const response = await client.get(`${p}/documents/${documentId}/download?application_id=${application.id}`).set(headers); expect(response.status).toBe(200); expect(response.headers['content-type']).toContain('application/pdf'); expect(response.headers['cache-control']).toBe('private, no-store');
  await send('get', `/customers/${randomUUID()}?application_id=${application.id}`, undefined, 404);
});
test('call history/detail includes recording metadata but hides notification secrets', async () => {
  expect((await send('get', `/calls?application_id=${application.id}`))[0].id).toBe(callId);
  const detail = await send('get', `/calls/${callId}?application_id=${application.id}`); expect(detail.recording.state).toBe('stored'); expect(detail.notification).toBeUndefined(); expect(detail.registration_key).toBeUndefined();
});
test('quotas, storage counters and usage input validation', async () => {
  expect((await send('get', `/quota?bank_id=${bank.id}`))[0].remaining).toBe(20);
  expect(await send('get', `/storage?bank_id=${bank.id}`)).toMatchObject({ documents: 1, recordings: 1, provider: 'seaweedfs' });
  await send('get', `/usage?application_id=${application.id}`, undefined, 422);
  expect((await send('get', `/usage?application_id=${application.id}&from=2026-01-01&to=2026-12-31`)).source).toBe('synthetic');
});
for (const feature of ['ocr', 'liveness']) test(`${feature} history explicitly reports unavailable`, async () => {
  const response = await client.get(`${p}/${feature}?application_id=${application.id}`).set(headers); expect(response.status).toBe(503); expect(response.body.error.code).toBe(`${feature.toUpperCase()}_HISTORY_NOT_MIGRATED`);
});
for (const format of ['xlsx', 'csv']) test(`${format} export queues, generates, reconciles checksum and downloads`, async () => {
  const row = await send('post', '/exports', { application_id: application.id, from: '2020-01-01', to: '2030-12-31', format, entities: ['users', 'call_history', 'user_actions'] }, 202);
  await send('get', `/exports/${row.id}/download`, undefined, 409);
  await processOneExport(db, storage, cfg);
  const saved = await db('dashboard_exports').where({ id: row.id }).first(); expect(saved.state).toBe('ready');
  expect(saved.sha256).toBe(createHash('sha256').update(objects.get(`test/${saved.object_key}`)).digest('hex'));
  const response = await client.get(`${p}/exports/${row.id}/download`).set(headers); expect(response.status).toBe(200); expect(response.headers['content-disposition']).toContain(`.${format}`);
  expect((await send('get', `/exports?application_id=${application.id}`)).some(item => item.id === row.id)).toBe(true);
});
test('export invalid input and checksum failure remain recoverable', async () => {
  await send('post', '/exports', { application_id: application.id, from: 'bad', to: 'bad' }, 422);
  const row = await send('post', '/exports', { application_id: application.id, from: '2020-01-01', to: '2030-12-31', format: 'csv' }, 202);
  corruptChecksum = true; await processOneExport(db, storage, cfg); corruptChecksum = false;
  expect((await db('dashboard_exports').where({ id: row.id }).first()).error).toBe('EXPORT_CHECKSUM_MISMATCH');
  await processOneExport(db, storage, cfg); expect((await db('dashboard_exports').where({ id: row.id }).first()).state).toBe('ready');
});
test('customer deletion delegates soft-delete while preserving history', async () => {
  await send('delete', `/customers/${customerId}?application_id=${application.id}`);
  expect((await db('platform_customers').where({ id: customerId }).first()).deleted_at).toBeTruthy();
  expect((await db('platform_calls').where({ id: callId }).first()).state).toBe('completed');
});
test('ordinary admin cannot create superadmins or manage global links', async () => {
  const row = await send('post', '/accounts', { username: `limited-${suffix}`, role: 'admin', password: 'limited-admin-password' }); accounts.push(row.id);
  const limited = request.agent(app), login = await limited.post(`${p}/login`).send({ username: row.username, password: 'limited-admin-password' }); expect(login.status).toBe(200);
  const csrf = { 'x-csrf-token': login.body.data.csrf };
  expect((await limited.post(`${p}/accounts`).set(csrf).send({ username: 'forged-superadmin', role: 'superadmin', password: 'forged-password-123' })).status).toBe(403);
  expect((await limited.post(`${p}/links`).set(csrf).send({ name: 'Forbidden', url: 'https://example.test' })).status).toBe(403);
  expect((await limited.patch(`${p}/accounts/${adminId}`).set(csrf).send({ active: false })).status).toBe(403);
});
test('expired session is rejected and unused bank deactivation updates its tenant', async () => {
  const row = await send('post', '/banks', { name: 'Spare test bank', username: `spare-${suffix}` }); banks.push(row);
  await send('delete', `/banks/${row.id}`); expect((await db('platform_tenants').where({ id: row.tenant_id }).first()).active).toBe(false);
  const expired = request.agent(app), login = await expired.post(`${p}/login`).send({ username: `features-${suffix}`, password: 'dashboard-test-password' }); expect(login.status).toBe(200);
  const key = [...sessions].find(([, raw]) => JSON.parse(raw).csrf === login.body.data.csrf)[0]; sessions.delete(key);
  expect((await expired.get(`${p}/session`)).status).toBe(401);
});
test('bank role cannot access another bank application, agents, customers, calls, documents or exports', async () => {
  const otherBank = await send('post', '/banks', { name: 'Isolation bank', username: `isolation-${suffix}` }); banks.push(otherBank);
  const account = await send('post', '/accounts', { username: `isolation-${suffix}`, role: 'bank', bank_id: otherBank.id, password: 'isolation-bank-password' }); accounts.push(account.id);
  const scoped = request.agent(app), login = await scoped.post(`${p}/login`).send({ username: account.username, password: 'isolation-bank-password' }); expect(login.status).toBe(200);
  for (const path of [`/applications/${application.id}`, `/agents?application_id=${application.id}`, `/customers?application_id=${application.id}`, `/calls?application_id=${application.id}`, `/customers/${customerId}/documents?application_id=${application.id}`, `/documents/${documentId}/download?application_id=${application.id}`, `/exports?application_id=${application.id}`]) expect((await scoped.get(`${p}${path}`)).status, path).toBe(403);
  expect((await scoped.get(`${p}/applications`)).body.data).toEqual([]);
  expect((await scoped.post(`${p}/banks`).set('x-csrf-token', login.body.data.csrf).send({ name: 'Forbidden', username: 'forged' })).status).toBe(403);
  expect((await scoped.post(`${p}/applications/${application.id}/status`).set('x-csrf-token', login.body.data.csrf).send({ status: 'inactive' })).status).toBe(403);
});
test('password reset consumes its token once and revokes existing sessions', async () => {
  await client.post(`${p}/password/reset/request`).send({ email: `${suffix}@example.test` }); expect(mail.to).toBe(`${suffix}@example.test`);
  const token = new URL(mail.url).searchParams.get('token'), body = { email: mail.to, token, password: 'replacement-test-password' };
  expect((await request(app).post(`${p}/password/reset/confirm`).send(body)).status).toBe(200);
  expect((await request(app).post(`${p}/password/reset/confirm`).send(body)).status).toBe(400);
  expect((await client.get(`${p}/session`)).status).toBe(401);
});
