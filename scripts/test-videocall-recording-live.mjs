import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { chromium } from '@playwright/test';
import { createDb } from '@ekyc/shared/db';
import { Storage } from '@ekyc/shared/storage';

const url = new URL(process.env.TEST_DATABASE_URL); assert.equal(url.hostname, '127.0.0.1'); url.pathname = '/ekyc';
const db = createDb(url.toString()), suffix = randomUUID().slice(0, 8), adminId = randomUUID();
const adminUsername = `record-test-${suffix}`, adminPassword = randomUUID() + randomUUID();
const agentUsername = `record-agent-${suffix}`, agentPassword = randomUUID() + randomUUID();
const dashboard = 'http://127.0.0.1:5301', proxy = 'http://127.0.0.1:58001';
const directory = `.local/recording-test-${suffix}`; await mkdir(directory, { recursive: true });
const storage = new Storage({ objectEndpoint: 'http://127.0.0.1:58333', objectAccess: process.env.OBJECT_ACCESS_KEY, objectSecret: process.env.OBJECT_SECRET_KEY });
let cookie = '', csrf = '', browser, agentPage, customerPage, bank, application, agent, call, token;
const report = { date: new Date().toISOString(), checks: [] };
function passed(check) { report.checks.push(check); console.log(`PASS: ${check}`); }
async function api(path, method = 'GET', body) {
  const response = await fetch(`${dashboard}/dashboard/api/v1${path}`, { method, signal: AbortSignal.timeout(30000), headers: { cookie, origin: dashboard, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  for (const value of response.headers.getSetCookie()) if (value.startsWith('dashboard_sid=')) cookie = value.split(';')[0];
  const result = await response.json(); assert.ok(response.ok, `${path}: ${result.error?.code}`); return result.data;
}
async function waitForCall(state, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const row = await db('platform_calls').where({ tenant_id: bank.tenant_id }).orderBy('created_at', 'desc').first();
    if (row) { call = row; if (row.state === state) return row; if (['failed', 'missed', 'canceled'].includes(row.state)) throw new Error(`Call ${row.state}: ${row.reason}`); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${state}; current state=${call?.state}`);
}
try {
  await db('dashboard_accounts').insert({ id: adminId, username: adminUsername, role: 'superadmin', password_hash: await bcrypt.hash(adminPassword, 12) });
  csrf = (await api('/login', 'POST', { username: adminUsername, password: adminPassword })).csrf;
  bank = await api('/banks', 'POST', { username: `recording-${suffix}`, name: `Recording test ${suffix}` });
  const plan = await api('/plans', 'POST', { name: `Recording test plan ${suffix}`, shortname: `recording-${suffix}`, features: ['user', 'agent'], limits: { requests_per_minute: 100 } });
  application = await api('/applications', 'POST', { bank_id: bank.id, plan_id: plan.id, name: `Recorded video call ${suffix}` });
  const approved = await api(`/applications/${application.id}/approve`, 'POST', {});
  await db('platform_quotas').insert({ tenant_id: bank.tenant_id, service: 'videocalls.post', remaining: 5 });
  agent = await api('/agents', 'POST', { application_id: application.id, username: agentUsername, password: agentPassword, name: `Petugas uji ${suffix}` });
  await new Promise(resolve => setTimeout(resolve, 6500));
  const linkResponse = await fetch(`${proxy}/partner/v1/video-call/users`, { method: 'POST', headers: { apikey: approved.api_key, 'content-type': 'application/json', 'idempotency-key': `recording-test-${suffix}` }, body: JSON.stringify({ customer: { name: `Nasabah uji ${suffix}`, id_number: 'SYNTHETIC-ONLY' } }) });
  const linkResult = await linkResponse.json(); assert.equal(linkResponse.status, 201, JSON.stringify(linkResult)); const link = linkResult.data;
  report.bank_id = bank.id; report.customer_id = link.customer_id; report.application_id = application.id;
  assert.equal((await db('platform_calls').where({ tenant_id: bank.tenant_id })).length, 0); passed('Kong bank API generates customer link without creating a queued call');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] });
  const agentContext = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const customerContext = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  agentPage = await agentContext.newPage(); customerPage = await customerContext.newPage();
  await agentPage.goto('http://127.0.0.1:5173'); await agentPage.getByLabel('Username').fill(agentUsername); await agentPage.getByLabel('Password', { exact: true }).fill(agentPassword); await agentPage.getByRole('button', { name: /Masuk ke workspace/ }).click();
  await customerPage.goto(link.customer_url); await waitForCall('waiting'); report.call_id = call.id;
  passed('Opening the customer link creates the waiting call');
  await customerPage.getByRole('button', { name: /Periksa kamera dan mikrofon/ }).click(); await customerPage.getByRole('checkbox').check();
  await agentPage.getByRole('button', { name: /Panggil berikutnya/ }).click(); await agentPage.getByRole('button', { name: /Masuk ruang video/ }).click();
  await waitForCall('ringing'); assert.equal(call.customer_joined_at, null);
  const reserved = await db('platform_recordings').where({ call_id: call.id }).first(); assert.equal(reserved.state, 'reserved'); passed('Agent joins; recorder reserved but recording does not start before customer joins');
  await customerPage.getByRole('button', { name: /Gabung dengan petugas/ }).click(); await waitForCall('active');
  assert.ok(call.customer_joined_at); assert.ok(call.started_at); passed('Customer joins real Jitsi room; Jibri confirms recording and call becomes active');
  await agentPage.screenshot({ path: `${directory}/agent-active.png`, fullPage: true }); await customerPage.screenshot({ path: `${directory}/customer-active.png`, fullPage: true });
  await new Promise(resolve => setTimeout(resolve, 15000));
  await agentPage.getByRole('button', { name: /Selesaikan verifikasi/ }).click(); await agentPage.getByRole('combobox').click(); await agentPage.getByText('Identitas terverifikasi', { exact: true }).click();
  await agentPage.getByRole('button', { name: /Simpan hasil dan akhiri panggilan/ }).click(); await waitForCall('completed', 120000);
  assert.equal(call.outcome, 'verified'); passed('Agent decision completes only after recording is stored');
  const record = await db('platform_recordings').where({ call_id: call.id }).first(); assert.equal(record.state, 'stored'); assert.ok(Number(record.bytes) > 10000);
  const bucket = process.env.RECORDING_BUCKET || 'ekyc-recordings'; const checksum = await storage.checksum(bucket, record.object_key); assert.equal(checksum.sha256, record.sha256); assert.equal(checksum.bytes, Number(record.bytes));
  const object = await storage.get(bucket, record.object_key); const chunks = []; for await (const chunk of object.Body) chunks.push(chunk); await writeFile(`${directory}/${call.id}.mp4`, Buffer.concat(chunks));
  report.recording = { id: record.id, bucket, key: record.object_key, bytes: checksum.bytes, sha256: checksum.sha256, local_file: `${directory}/${call.id}.mp4` }; passed('SeaweedFS recording exists; actual bytes and SHA-256 match database');
  const detail = await api(`/calls/${call.id}?application_id=${application.id}`); assert.equal(detail.recording.state, 'stored'); assert.equal(detail.recording.sha256, record.sha256);
  assert.ok((await api(`/calls?application_id=${application.id}`)).some(row => row.id === call.id)); passed('Admin call history/detail contains completed call and stored recording metadata');
  const adminContext = await browser.newContext(); await adminContext.addCookies([{ name: 'dashboard_sid', value: cookie.split('=').slice(1).join('='), url: dashboard }]);
  const adminPage = await adminContext.newPage(); report.dashboard_url = `${dashboard}/banks/@${bank.username}/apps/${application.id}/calls`;
  await adminPage.goto(report.dashboard_url); await adminPage.getByRole('row').filter({ hasText: call.id }).getByRole('button', { name: 'Detail' }).click();
  await adminPage.getByRole('heading', { name: 'Detail panggilan' }).waitFor(); await adminPage.locator('.modal').getByText(/stored/).waitFor(); await adminPage.screenshot({ path: `${directory}/admin-recording.png`, fullPage: true }); passed('Recording metadata is visible in admin call detail UI');
  await customerPage.getByRole('heading', { name: 'Verifikasi berhasil' }).waitFor({ timeout: 30000 }); passed('Customer sees the verified completion result');
  report.success = true;
} catch (error) {
  report.success = false; report.error = error.message;
  if (agentPage) await agentPage.screenshot({ path: `${directory}/agent-error.png`, fullPage: true }).catch(() => {});
  if (customerPage) await customerPage.screenshot({ path: `${directory}/customer-error.png`, fullPage: true }).catch(() => {});
  if (call) {
    report.call_id = call.id; report.call_state = (await db('platform_calls').where({ id: call.id }).first()).state;
    const response = await fetch(`${proxy}/api/v2/sessions/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: agentUsername, password: agentPassword }) });
    token = (await response.json()).access_token;
    if (token && !['completed', 'completing', 'failed', 'canceled', 'missed'].includes(report.call_state)) await fetch(`${proxy}/api/v2/calls/${call.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  }
} finally {
  if (browser) await browser.close();
  if (application) await api(`/applications/${application.id}/status`, 'POST', { status: 'inactive' });
  if (agent) await api(`/agents/${agent.id}`, 'PATCH', { application_id: application.id, active: false });
  if (csrf) await api('/logout', 'POST', {});
  await db('dashboard_accounts').where({ id: adminId }).delete(); await db.destroy();
  report.fixture_policy = 'Synthetic bank/customer/call/recording retained for review; test API and agent access disabled, temporary admin removed';
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
assert.equal(report.success, true, report.error);
