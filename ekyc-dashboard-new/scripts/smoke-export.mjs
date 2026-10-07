import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = `${process.env.DASHBOARD_URL || 'http://127.0.0.1:5301'}/dashboard/api/v1`;
const username = process.env.DASHBOARD_TEST_USERNAME;
const password = process.env.DASHBOARD_TEST_PASSWORD;
if (!username || !password) throw new Error('Set DASHBOARD_TEST_USERNAME and DASHBOARD_TEST_PASSWORD');
const loginResponse = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
assert.equal(loginResponse.status, 200);
const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
const csrf = (await loginResponse.json()).data.csrf;
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(payload)}`);
  return payload.data;
}
const applications = await api('/applications');
const application = applications.find(item => item.name === 'Aplikasi Demo');
assert.ok(application, 'Synthetic application missing');
const job = await api('/exports', { method: 'POST', body: { application_id: application.id, from: '2020-01-01', to: '2030-12-31', format: 'xlsx', entities: ['users', 'call_history'] } });
let ready;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const jobs = await api(`/exports?application_id=${application.id}`);
  ready = jobs.find(item => item.id === job.id);
  if (ready?.state === 'ready' || ready?.state === 'failed') break;
}
assert.equal(ready?.state, 'ready', `Export state: ${ready?.state}; error: ${ready?.error}`);
const response = await fetch(`${base}/exports/${job.id}/download`, { headers: { cookie } });
assert.equal(response.status, 200);
const buffer = Buffer.from(await response.arrayBuffer());
assert.equal(buffer.subarray(0, 2).toString(), 'PK');
assert.equal(createHash('sha256').update(buffer).digest('hex'), ready.sha256);
console.log(JSON.stringify({ export_id: job.id, bytes: buffer.length, sha256: ready.sha256 }));
