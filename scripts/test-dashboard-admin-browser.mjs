import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { chromium } from '@playwright/test';
import { createDb } from '@ekyc/shared/db';
import { Storage } from '@ekyc/shared/storage';

const url = new URL(process.env.TEST_DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.ok(url.pathname.endsWith('_test'));
url.pathname = '/ekyc'; // Live local UI, uniquely identified synthetic fixtures only.
const db = createDb(url.toString()), adminId = randomUUID(), suffix = randomUUID().slice(0, 8);
const username = `ui-test-${suffix}`, password = randomUUID() + randomUUID();
const base = 'http://127.0.0.1:5301', directory = '.local/dashboard-admin-test';
const statusOnly = process.argv.includes('--status-only');
const storage = new Storage({ objectEndpoint: 'http://127.0.0.1:58333', objectAccess: process.env.OBJECT_ACCESS_KEY, objectSecret: process.env.OBJECT_SECRET_KEY });
await mkdir(directory, { recursive: true });
let browser, bank, plan, application, cookie = '', csrf = '';
const report = { date: new Date().toISOString(), checks: [], errors: [] };
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}/dashboard/api/v1${path}`, { method, headers: { cookie, origin: base, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  for (const value of response.headers.getSetCookie()) if (value.startsWith('dashboard_sid=')) cookie = value.split(';')[0];
  const data = await response.json(); assert.ok(response.ok, `${path}: ${data.error?.code}`); return data.data;
}
try {
  await db('dashboard_accounts').insert({ id: adminId, username, role: 'superadmin', password_hash: await bcrypt.hash(password, 12) });
  csrf = (await api('/login', 'POST', { username, password })).csrf;
  bank = await api('/banks', 'POST', { name: `UI test bank ${suffix}`, username: `ui-${suffix}` });
  plan = await api('/plans', 'POST', { name: `UI plan ${suffix}`, shortname: `ui-${suffix}`, features: ['user', 'agent'] });
  application = await api('/applications', 'POST', { bank_id: bank.id, plan_id: plan.id, name: `UI application ${suffix}` });
  for (const format of statusOnly ? [] : ['xlsx', 'csv']) {
    const job = await api('/exports', 'POST', { application_id: application.id, from: '2020-01-01', to: '2030-12-31', format });
    let saved;
    for (let attempt = 0; attempt < 30; attempt++) {
      saved = await db('dashboard_exports').where({ id: job.id }).first();
      if (['ready', 'failed'].includes(saved.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(saved.state, 'ready', `Live worker export failed: ${saved.error || saved.state}`);
    const response = await fetch(`${base}/dashboard/api/v1/exports/${job.id}/download`, { headers: { cookie } }); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.sha256);
    report.checks.push({ check: `Live ${format} export worker, SeaweedFS storage and authenticated download checksum`, passed: true });
  }
  const bankBase = `/banks/@${bank.username}`, appBase = `${bankBase}/apps/${application.id}`;
  const pages = statusOnly ? [appBase] : ['/', '/banks', '/plans', '/app-requests', '/quota', '/accounts', '/officers', '/links', bankBase, `${bankBase}/apps`, `${bankBase}/accounts`, `${bankBase}/storage`, `${bankBase}/officers`, appBase, ...['users', 'agents', 'calls', 'liveness', 'ocr', 'usage', 'exports'].map(name => `${appBase}/${name}`), '/profile/change-password'];
  if (statusOnly) await db('dashboard_applications').where({ id: application.id }).update({ status: 'confirmed', kong_consumer_id: `synthetic-${application.id}` });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport }); const page = await context.newPage();
    page.on('pageerror', error => report.errors.push({ device, type: 'javascript', message: error.message }));
    page.on('response', response => { if (response.url().includes('/dashboard/api/') && response.status() >= 400 && !/\/(session|ocr|liveness)(\?|$)/.test(response.url())) report.errors.push({ device, type: 'api', status: response.status(), path: new URL(response.url()).pathname }); });
    await page.goto(`${base}/login`); await page.getByLabel('Username', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Masuk', exact: true }).click(); await page.getByRole('heading', { name: /Ruang kerja verifikasi/ }).waitFor();
    for (const path of pages) {
      await page.goto(`${base}${path}`); await page.locator('main.content').waitFor(); await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      report.checks.push({ device, path, rendered: true, horizontal_overflow: overflow });
      if (overflow) report.errors.push({ device, path, type: 'layout', message: 'Page overflows viewport horizontally' });
      if (['/', '/banks', '/plans', appBase, `${appBase}/agents`].includes(path)) await page.screenshot({ path: `${directory}/${device}-${path === '/' ? 'home' : path.split('/').at(-1)}.png`, fullPage: true });
    }
    if (statusOnly) {
      await page.getByRole('button', { name: 'Nonaktifkan layanan', exact: true }).click();
      await page.getByRole('button', { name: 'Aktifkan kembali', exact: true }).waitFor();
      assert.equal((await db('dashboard_applications').where({ id: application.id }).first()).status, 'inactive');
      await page.getByRole('button', { name: 'Aktifkan kembali', exact: true }).click();
      await page.getByRole('button', { name: 'Nonaktifkan layanan', exact: true }).waitFor();
      assert.equal((await db('dashboard_applications').where({ id: application.id }).first()).status, 'confirmed');
      report.checks.push({ device, check: 'Deactivate and reactivate application through UI', passed: true });
      await page.getByRole('button', { name: 'Keluar', exact: true }).click(); await page.getByRole('button', { name: 'Masuk', exact: true }).waitFor();
      await context.close(); continue;
    }
    for (const [oldPath, expected] of [['/banks/create', '/banks'], ['/plans/create', '/plans'], ['/officers/create', '/officers'], [`${appBase}/usage/export-xlsx`, `${appBase}/exports`]]) {
      await page.goto(`${base}${oldPath}`); await page.waitForURL(`${base}${expected}`); report.checks.push({ device, legacy_redirect: oldPath, passed: true });
    }
    await page.goto(`${base}/banks`); await page.getByRole('button', { name: /Tambah$/ }).click();
    await page.getByLabel('Bank name', { exact: true }).fill(`UI form bank ${suffix}-${device}`); await page.getByLabel('Username', { exact: true }).fill(`ui-form-${suffix}-${device}`); await page.getByLabel('Email', { exact: true }).fill(`${device}-${suffix}@example.test`);
    const modal = page.locator('form.modal'); await modal.getByRole('button', { name: /Simpan/ }).click(); await modal.waitFor({ state: 'hidden' });
    await page.getByText(`UI form bank ${suffix}-${device}`, { exact: true }).waitFor(); report.checks.push({ device, check: 'Create bank through UI form', passed: true });
    if (device === 'desktop') {
      await page.goto(`${base}/plans`); await page.getByRole('row').filter({ hasText: `UI plan ${suffix}` }).getByRole('button', { name: 'Detail' }).click();
      page.once('dialog', async dialog => { report.errors.push({ device, type: 'form', message: dialog.message() }); await dialog.accept(); });
      await page.getByLabel('Plan name', { exact: true }).fill(`UI plan edited ${suffix}`);
      await page.getByLabel('API policy JSON: requests_per_minute and acl_group').fill('{"requests_per_minute":100}');
      await page.locator('form.modal').getByRole('button', { name: 'Simpan', exact: true }).click();
      try { await page.locator('form.modal').waitFor({ state: 'hidden', timeout: 3000 }); assert.equal((await db('dashboard_plans').where({ id: plan.id }).first()).limits.requests_per_minute, 100); report.checks.push({ device, check: 'Edit existing plan through UI form', passed: true }); }
      catch { report.errors.push({ device, type: 'form', message: 'Plan edit did not save' }); await page.locator('form.modal').getByRole('button', { name: 'Batal' }).click(); }
    }
    if (device === 'mobile') { await page.getByRole('button', { name: 'Buka menu' }).click(); await page.locator('.sidebar.open').waitFor(); await page.locator('.sidebar').getByRole('link', { name: /Plans$/ }).click(); await page.waitForURL(`${base}/plans`); report.checks.push({ device, check: 'Mobile menu navigation', passed: true }); }
    await page.getByRole('button', { name: 'Keluar', exact: true }).click(); await page.getByRole('button', { name: 'Masuk', exact: true }).waitFor(); report.checks.push({ device, check: 'Logout', passed: true });
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  if (csrf) await api('/logout', 'POST', {});
  if (application) for (const row of await db('dashboard_exports').where({ application_id: application.id })) if (row.object_key) await storage.delete(process.env.DASHBOARD_EXPORT_BUCKET || 'ekyc-dashboard-exports', row.object_key);
  await db.transaction(async trx => {
    const fixtures = await trx('dashboard_banks').whereIn('username', [`ui-${suffix}`, `ui-form-${suffix}-desktop`, `ui-form-${suffix}-mobile`]);
    if (application) { await trx('dashboard_exports').where({ application_id: application.id }).delete(); await trx('dashboard_applications').where({ id: application.id }).delete(); }
    if (plan) await trx('dashboard_plans').where({ id: plan.id }).delete();
    for (const row of fixtures) { await trx('dashboard_banks').where({ id: row.id }).delete(); await trx('platform_tenants').where({ id: row.tenant_id }).delete(); }
    await trx('dashboard_audit').where({ actor_id: adminId }).delete(); await trx('dashboard_accounts').where({ id: adminId }).delete();
  }); await db.destroy();
  report.cleanup = 'Temporary admin, banks, plan, application and sessions removed';
  await writeFile(`${directory}/${statusOnly ? 'status-report' : 'report'}.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(report.errors, []);
