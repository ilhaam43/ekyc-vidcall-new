import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { required, value } from '@ekyc/shared/config';

const [tenantId, customerId, username, password] = process.argv.slice(2);
if (process.env.NODE_ENV === 'production') throw new Error('Local media smoke test is disabled in production');
if (![tenantId, customerId, username, password].every(Boolean)) throw new Error('Usage: node --env-file=.env scripts/smoke-local.mjs TENANT_ID CUSTOMER_ID USERNAME PASSWORD');
const api = value('CALLS_URL', 'http://127.0.0.1:55030');
const headers = { 'content-type': 'application/json', 'x-gateway-secret': required('GATEWAY_SECRET'), 'x-application-id': tenantId };
async function post(path, data, extra = {}) {
  const response = await fetch(`${api}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  const json = await response.json(); if (!response.ok) throw new Error(`${path}: ${json.error?.code || response.status}`); return json.data;
}
const call = await post('/api/v2/calls', { user_id: customerId }, { 'idempotency-key': randomUUID() });
const grant = await post('/api/v2/customer-grants', { user_id: customerId });
console.log('Synthetic call:', call.id);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--no-sandbox'] });
const agent = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
const customer = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
const a = await agent.newPage(); const c = await customer.newPage();
for (const [label, page] of [['agent', a], ['customer', c]]) {
  page.on('console', msg => { if (msg.type() === 'error') console.log(`${label} console: ${msg.text().slice(0, 300)}`); });
  page.on('pageerror', error => console.log(`${label} page error: ${error.message.slice(0, 300)}`));
}
try {
  await a.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
  await a.getByLabel('Username').fill(username);
  await a.getByLabel('Password').fill(password);
  await a.getByRole('button', { name: /Masuk ke workspace/ }).click();
  await a.getByRole('button', { name: /Panggil berikutnya/ }).waitFor({ timeout: 15000 });
  await c.goto(grant.join_url, { waitUntil: 'domcontentloaded' });
  await c.getByRole('button', { name: /Periksa kamera dan mikrofon/ }).click();
  await c.getByRole('checkbox').check();
  await a.getByRole('button', { name: /Panggil berikutnya/ }).click();
  await a.getByRole('button', { name: /Masuk ruang video/ }).click();
  await c.getByRole('button', { name: /Gabung dengan petugas/ }).click({ timeout: 60000 });
  await a.getByText('Rekaman aktif', { exact: true }).waitFor({ timeout: 90000 });
  console.log('Jibri recording started');
  await a.getByText('Sedang berlangsung', { exact: true }).waitFor({ timeout: 60000 });
  await a.getByText('Menghubungkan video…').waitFor({ state: 'hidden', timeout: 45000 });
  await c.getByText('Menghubungkan video…').waitFor({ state: 'hidden', timeout: 45000 });
  console.log('Customer admitted; call active');
  await new Promise(resolve => setTimeout(resolve, 20_000));
  await a.getByRole('button', { name: /Selesaikan verifikasi/ }).click();
  await a.getByRole('combobox').click();
  await a.getByText('Identitas terverifikasi', { exact: true }).click();
  await a.getByRole('button', { name: /Simpan hasil dan akhiri panggilan/ }).click();
  const login = await fetch(`${api}/api/v2/sessions/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!login.ok) throw new Error(`Recording check login failed: ${login.status}`);
  const accessToken = (await login.json()).access_token;
  const until = Date.now() + 120000; let state; let recording;
  do {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const response = await fetch(`${api}/v1/calls/${customerId}`, { headers });
    state = (await response.json()).data?.state;
    const media = await fetch(`${api}/api/v2/calls/${call.id}/recording`, { headers: { authorization: `Bearer ${accessToken}` } });
    recording = (await media.json()).data;
  } while (state !== 'completed' && state !== 'failed' && Date.now() < until);
  if (state !== 'completed' || recording?.state !== 'stored' || recording.bytes < 100_000) throw new Error(`Recording not verified; call=${state}, recording=${recording?.state}, bytes=${recording?.bytes}`);
  console.log(`Verified completion and playable recording (${recording.bytes} bytes):`, call.id);
} catch (error) {
  await a.screenshot({ path: '.local/smoke-agent.png' }).catch(() => {});
  await c.screenshot({ path: '.local/smoke-customer.png' }).catch(() => {});
  console.error('Local smoke test stopped:', error.message);
  console.error('Agent URL:', a.url(), 'Customer URL:', c.url());
  process.exitCode = 1;
} finally { await browser.close(); }
