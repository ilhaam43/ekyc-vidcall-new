import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { createDb } from '@ekyc/shared/db';
import { createDashboardApp } from '../../ekyc-dashboard-new/server/app.js';
import { scheduleMonthlyExports } from '../../ekyc-dashboard-new/server/export-schedule.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test') || process.env.NODE_ENV === 'production') throw new Error('Dashboard integration tests require isolated *_test PostgreSQL');
const db = createDb(testUrl);
const tenantA = randomUUID(), tenantB = randomUUID(), bankA = randomUUID(), bankB = randomUUID(), appId = randomUUID(), planId = randomUUID(), adminId = randomUUID(), bankAccountId = randomUUID();
const sessions = new Map(); const redis = { set: async (key, value) => sessions.set(key, value), get: async key => sessions.get(key), del: async key => sessions.delete(key), expire: async () => true, ping: async () => 'PONG' };
const cfg = { origin: 'http://localhost:5301', production: false, mockExternal: true, exportBucket: 'test', masterUrl: 'http://localhost:8080', gatewaySecret: 'test-secret' };
const storage = { get: async () => { throw new Error('unused'); } };
let kongFailure = false;
const adapters = { kong: { provision: async () => { if (kongFailure) throw Object.assign(new Error('down'), { status: 503, code: 'KONG_UNAVAILABLE' }); return { id: `synthetic-${appId}`, mode: 'synthetic' }; } }, usage: { forApplication: async () => ({ source: 'synthetic', totals: [] }) }, email: { sendReset: async () => ({ delivered: true }) } };
const app = createDashboardApp(db, redis, cfg, storage, adapters);
beforeAll(async () => {
  await db.migrate.latest({ directory: new URL('../../migrations', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), tableName: 'platform_migrations' });
  await db('platform_tenants').insert([{ id: tenantA, name: 'Dashboard test A' }, { id: tenantB, name: 'Dashboard test B' }]);
  await db('dashboard_banks').insert([{ id: bankA, tenant_id: tenantA, name: 'Test bank A', username: `bank-${bankA}` }, { id: bankB, tenant_id: tenantB, name: 'Test bank B', username: `bank-${bankB}` }]);
  await db('dashboard_plans').insert({ id: planId, name: 'Test plan', shortname: `plan-${planId}`, features: JSON.stringify(['user', 'agent']) });
  await db('dashboard_applications').insert({ id: appId, bank_id: bankA, plan_id: planId, name: 'Test app' });
  await db('dashboard_accounts').insert([{ id: adminId, username: `admin-${adminId}`, role: 'superadmin', password_hash: await bcrypt.hash('correct-password-123', 12) }, { id: bankAccountId, bank_id: bankA, username: `bank-${bankAccountId}`, role: 'bank', password_hash: await bcrypt.hash('correct-password-123', 12) }]);
});
afterAll(async () => { await db('dashboard_audit').whereIn('bank_id', [bankA, bankB]).del(); await db('dashboard_audit').whereNull('bank_id').del(); await db('dashboard_accounts').whereIn('id', [adminId, bankAccountId]).del(); await db('dashboard_applications').where({ id: appId }).del(); await db('dashboard_plans').where({ id: planId }).del(); await db('dashboard_banks').whereIn('id', [bankA, bankB]).del(); await db('platform_tenants').whereIn('id', [tenantA, tenantB]).del(); await db.destroy(); });

test('incorrect password never creates a session', async () => { const response = await request(app).post('/dashboard/api/v1/login').send({ username: `bank-${bankAccountId}`, password: 'incorrect-password' }); expect(response.status).toBe(401); expect(response.body.error.code).toBe('INVALID_CREDENTIALS'); expect(sessions.size).toBe(0); });
test('bank session enforces CSRF and cross-bank isolation', async () => {
  const client = request.agent(app); const login = await client.post('/dashboard/api/v1/login').send({ username: `bank-${bankAccountId}`, password: 'correct-password-123' }); expect(login.status).toBe(200);
  expect((await client.get(`/dashboard/api/v1/banks/${bankB}`)).status).toBe(403);
  const list = await client.get(`/dashboard/api/v1/applications?bank_id=${bankB}`); expect(list.status).toBe(200); expect(list.body.data.map(row => row.id)).toContain(appId);
  expect((await client.post('/dashboard/api/v1/applications').send({ bank_id: bankB, name: 'Forged', plan_id: planId })).status).toBe(403);
  expect((await client.post('/dashboard/api/v1/logout')).status).toBe(403);
  expect((await client.post('/dashboard/api/v1/logout').set('x-csrf-token', login.body.data.csrf)).status).toBe(200);
  expect((await client.get('/dashboard/api/v1/session')).status).toBe(401);
});
test('application approval remains waiting when Kong fails, then confirms once', async () => {
  const client = request.agent(app); const login = await client.post('/dashboard/api/v1/login').send({ username: `admin-${adminId}`, password: 'correct-password-123' }); const headers = { 'x-csrf-token': login.body.data.csrf };
  kongFailure = true; const failed = await client.post(`/dashboard/api/v1/applications/${appId}/approve`).set(headers).send({}); expect(failed.status).toBe(503);
  expect((await db('dashboard_applications').where({ id: appId }).first()).status).toBe('waiting');
  kongFailure = false; const approved = await client.post(`/dashboard/api/v1/applications/${appId}/approve`).set(headers).send({}); expect(approved.status).toBe(200); expect(approved.body.data.status).toBe('confirmed');
  const repeated = await client.post(`/dashboard/api/v1/applications/${appId}/approve`).set(headers).send({}); expect(repeated.body.data.kong_consumer_id).toBe(approved.body.data.kong_consumer_id);
});
test('password change revokes every existing session for the account', async () => {
  const id = randomUUID(), username = `session-${id}`;
  await db('dashboard_accounts').insert({ id, username, role: 'bank', bank_id: bankA, password_hash: await bcrypt.hash('original-password-123', 12) });
  try {
    const first = request.agent(app), second = request.agent(app);
    const login1 = await first.post('/dashboard/api/v1/login').send({ username, password: 'original-password-123' });
    const login2 = await second.post('/dashboard/api/v1/login').send({ username, password: 'original-password-123' });
    expect(login1.status).toBe(200); expect(login2.status).toBe(200);
    expect((await first.post('/dashboard/api/v1/profile/password').set('x-csrf-token', login1.body.data.csrf).send({ current_password: 'original-password-123', new_password: 'replacement-password-123' })).status).toBe(200);
    expect((await second.get('/dashboard/api/v1/session')).status).toBe(401);
    expect((await request(app).post('/dashboard/api/v1/login').send({ username, password: 'original-password-123' })).status).toBe(401);
    expect((await request(app).post('/dashboard/api/v1/login').send({ username, password: 'replacement-password-123' })).status).toBe(200);
  } finally { await db('dashboard_accounts').where({ id }).del(); }
});
test('monthly export scheduler catches up once per due period', async () => {
  const id = randomUUID();
  await db('dashboard_applications').insert({ id, bank_id: bankA, plan_id: planId, name: 'Scheduled test', status: 'confirmed', activated_at: new Date('2026-07-20T00:00:00+07:00') });
  try {
    const now = new Date('2026-09-21T01:00:00+07:00');
    expect(await scheduleMonthlyExports(db, now)).toBe(2);
    expect(await scheduleMonthlyExports(db, now)).toBe(0);
    const jobs = await db('dashboard_exports').where({ application_id: id }).orderBy('schedule_key');
    expect(jobs.map(job => job.request.from)).toEqual(['2026-07-21', '2026-08-21']);
  } finally { await db('dashboard_exports').where({ application_id: id }).del(); await db('dashboard_applications').where({ id }).del(); }
});
