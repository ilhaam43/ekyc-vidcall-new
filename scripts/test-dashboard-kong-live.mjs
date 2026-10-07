import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createDb } from '@ekyc/shared/db';
import { dashboardConfig } from '../ekyc-dashboard-new/server/config.js';

// Run only inside the local dashboard container. Every fixture is unique and removed.
const cfg = dashboardConfig();
assert.equal(cfg.production, false);
assert.equal(cfg.kongMock, false);
assert.equal(new URL(cfg.kongUrl).hostname, 'kong');
assert.equal(new URL(cfg.databaseUrl).hostname, 'postgres');
const db = createDb(cfg.databaseUrl), adminId = randomUUID(), suffix = randomUUID().slice(0, 8);
const password = randomUUID() + randomUUID(), username = `kong-test-${suffix}`;
const results = [], plans = [], groups = [];
let cookie = '', csrf = '', bank, application, consumerId;
async function api(path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:5301/dashboard/api/v1${path}`, { method, signal: AbortSignal.timeout(30000), headers: { cookie, origin: cfg.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  for (const value of response.headers.getSetCookie()) if (value.startsWith('dashboard_sid=')) cookie = value.split(';')[0];
  const data = await response.json(); assert.ok(response.ok, `${method} ${path}: ${data.error?.code}`); return data.data;
}
async function kong(path, method = 'GET', body) {
  const response = await fetch(`${cfg.kongUrl}${path}`, { method, signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok || response.status === 404, `${method} Kong ${path}: ${response.status}`);
  return response.status === 204 || response.status === 404 ? null : response.json();
}
async function partner(key) {
  const response = await fetch('http://kong:8000/partner/v1/video-call/users', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { apikey: key } : {}) }, body: '{}' });
  return { status: response.status, limit: response.headers.get('x-ratelimit-limit-minute'), data: await response.json() };
}
function passed(check) { results.push({ check, passed: true }); console.log(`PASS: ${check}`); }
// Kong's database-backed workers poll configuration changes every five seconds.
const propagate = () => new Promise(resolve => setTimeout(resolve, 6500));
try {
  await db('dashboard_accounts').insert({ id: adminId, username, role: 'superadmin', password_hash: await bcrypt.hash(password, 12) });
  csrf = (await api('/login', 'POST', { username, password })).csrf;
  bank = await api('/banks', 'POST', { username: `test-bank-${suffix}`, name: `Kong integration test ${suffix}` });
  assert.ok(bank.tenant_id); passed('Bank creation maps to a platform tenant');
  for (const [label, minute] of [['initial', 2], ['upgrade', 100]]) {
    const group = `test-${label}-${suffix}`; groups.push(group);
    plans.push(await api('/plans', 'POST', { name: `Test ${label} ${suffix}`, shortname: `test-${label}-${suffix}`, features: ['user', 'agent'], limits: { requests_per_minute: minute, acl_group: group } }));
  }
  application = await api('/applications', 'POST', { bank_id: bank.id, plan_id: plans[0].id, name: `Test application ${suffix}` });
  const approved = await api(`/applications/${application.id}/approve`, 'POST', {});
  consumerId = approved.kong_consumer_id;
  assert.equal(approved.status, 'confirmed'); assert.ok(approved.api_key?.length >= 16); assert.ok(!consumerId.startsWith('synthetic-'));
  const consumer = await kong(`/consumers/${consumerId}`); assert.equal(consumer.custom_id, application.id);
  assert.equal(consumer.username, `ekyc-application-${application.id}`); passed('Approval creates a real application-scoped consumer and API key');
  const credentials = await kong(`/consumers/${consumerId}/key-auth`); assert.equal(credentials.data.length, 1); assert.equal(credentials.data[0].key, approved.api_key);
  const memberships = await kong(`/consumers/${consumerId}/acls`); assert.ok(memberships.data.some(row => row.group === groups[0]));
  const plugins = await kong(`/consumers/${consumerId}/plugins`); assert.equal(plugins.data.find(row => row.name === 'rate-limiting').config.minute, 2);
  passed('Plan assigns ACL membership and a two-request-per-minute consumer limit');
  assert.ok((await kong(`/routes/${cfg.kongApiRouteId}/plugins`)).data.find(row => row.name === 'acl').config.allow.includes(groups[0]));
  await propagate();
  const repeat = await api(`/applications/${application.id}/approve`, 'POST', {}); assert.equal(repeat.kong_consumer_id, consumerId); assert.equal(repeat.api_key, undefined);
  assert.equal((await kong(`/consumers/${consumerId}/key-auth`)).data.length, 1); passed('Repeated approval does not duplicate the consumer or API key');
  assert.equal((await partner()).status, 401); assert.equal((await partner('invalid-test-key')).status, 401); passed('Missing and invalid API keys are rejected by Kong');
  for (let i = 0; i < 2; i++) { const response = await partner(approved.api_key); assert.equal(response.status, 422, JSON.stringify(response)); assert.equal(response.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED'); assert.equal(Number(response.limit), 2); }
  assert.equal((await partner(approved.api_key)).status, 429); passed('Valid API key reaches the mapped bank; the third request is rate-limited');
  const membership = memberships.data.find(row => row.group === groups[0]);
  await kong(`/consumers/${consumerId}/acls/${membership.id}`, 'DELETE');
  await propagate();
  assert.equal((await partner(approved.api_key)).status, 403); passed('Valid API key without allowed ACL membership is rejected');
  const changed = await api(`/applications/${application.id}/plan`, 'POST', { plan_id: plans[1].id }); assert.equal(changed.plan_id, plans[1].id);
  await propagate();
  const updatedAcls = (await kong(`/consumers/${consumerId}/acls`)).data;
  assert.ok(updatedAcls.some(row => row.group === groups[1])); assert.ok(!updatedAcls.some(row => row.group === groups[0]));
  assert.equal((await kong(`/consumers/${consumerId}/plugins`)).data.find(row => row.name === 'rate-limiting').config.minute, 100);
  const response = await partner(approved.api_key); assert.equal(response.status, 422); assert.equal(response.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED'); assert.equal(Number(response.limit), 100);
  passed('Changing plan updates ACL and rate limit while preserving the API key');
  const inactive = await api(`/applications/${application.id}/status`, 'POST', { status: 'inactive' }); assert.equal(inactive.status, 'inactive');
  assert.equal((await kong(`/consumers/${consumerId}/acls`)).data.length, 0);
  await api(`/applications/${application.id}/status`, 'POST', { status: 'inactive' });
  await propagate(); assert.equal((await partner(approved.api_key)).status, 403);
  assert.equal((await kong(`/consumers/${consumerId}/key-auth`)).data[0].key, approved.api_key);
  passed('Inactive application loses ACL access while retaining its consumer and API key');
  await api(`/applications/${application.id}/status`, 'POST', { status: 'confirmed' });
  await propagate(); assert.equal((await partner(approved.api_key)).status, 422);
  assert.equal((await kong(`/consumers/${consumerId}/key-auth`)).data.length, 1);
  passed('Reactivation restores the current plan with the same API key');
} finally {
  // Remove only this run's identities/policies; retain unrelated route ACL groups.
  const found = application ? await kong(`/consumers?custom_id=${application.id}`) : null;
  const id = consumerId || found?.data?.find(row => row.custom_id === application.id)?.id;
  if (id) await kong(`/consumers/${id}`, 'DELETE');
  const routePlugins = await kong(`/routes/${cfg.kongApiRouteId}/plugins`);
  const acl = routePlugins.data.find(row => row.name === 'acl');
  if (acl) await kong(`/plugins/${acl.id}`, 'PATCH', { config: { ...acl.config, allow: acl.config.allow.filter(group => !groups.includes(group)) } });
  if (csrf) await api('/logout', 'POST', {});
  await db.transaction(async trx => {
    if (application) await trx('dashboard_applications').where({ id: application.id }).delete();
    for (const plan of plans) await trx('dashboard_plans').where({ id: plan.id }).delete();
    if (bank) { await trx('dashboard_banks').where({ id: bank.id }).delete(); await trx('platform_tenants').where({ id: bank.tenant_id }).delete(); }
    await trx('dashboard_audit').where({ actor_id: adminId }).delete();
    await trx('dashboard_accounts').where({ id: adminId }).delete();
  });
  await db.destroy();
  console.log('CLEANUP: temporary bank, tenant, plans, application, admin, Kong consumer, key, and ACL groups removed');
}
console.log(JSON.stringify({ passed: results.length, results }));
