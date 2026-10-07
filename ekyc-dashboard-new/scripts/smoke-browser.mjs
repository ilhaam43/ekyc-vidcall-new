import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '@playwright/test';

const base = process.env.DASHBOARD_URL || 'http://127.0.0.1:5301';
const username = process.env.DASHBOARD_TEST_USERNAME;
const password = process.env.DASHBOARD_TEST_PASSWORD;
if (!username || !password) throw new Error('Set DASHBOARD_TEST_USERNAME and DASHBOARD_TEST_PASSWORD');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/login`);
    const shotDirectory = process.env.DASHBOARD_SCREENSHOT_DIR || os.tmpdir();
    await page.screenshot({ path: path.join(shotDirectory, `dashboard-login-${device}.png`), fullPage: true });
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Masuk' }).click();
    await page.getByRole('heading', { name: /Ruang kerja verifikasi/ }).waitFor();
    await page.screenshot({ path: path.join(shotDirectory, `dashboard-home-${device}.png`), fullPage: true });
    if (device === 'desktop' && username === 'dashboard-admin') {
      await page.goto(`${base}/officers/create`);
      await page.getByRole('heading', { name: 'Officers', exact: true }).waitFor();
      await page.getByText('Petugas Demo').waitFor();
      assert.ok(page.url().endsWith('/officers'));
    }
    await page.goto(`${base}/banks/@demo-bank/apps`);
    await page.getByRole('heading', { name: 'Applications', exact: true }).waitFor();
    await page.getByText('Aplikasi Demo').waitFor();
    if (device === 'desktop' && username !== 'dashboard-officer') {
      const applicationId = await page.evaluate(async () => (await (await fetch('/dashboard/api/v1/applications')).json()).data.find(item => item.name === 'Aplikasi Demo').id);
      await page.goto(`${base}/banks/@demo-bank/apps/${applicationId}/users`);
      await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
      await page.getByText('Nasabah Demo').waitFor();
      await page.goto(`${base}/banks/@demo-bank/apps`);
      await page.getByRole('heading', { name: 'Applications', exact: true }).waitFor();
    }
    if (device === 'mobile') { await page.getByRole('button', { name: 'Buka menu' }).click(); await page.getByRole('link', { name: 'Applications' }).first().waitFor(); await page.waitForTimeout(250); }
    const screenshot = path.join(process.env.DASHBOARD_SCREENSHOT_DIR || os.tmpdir(), `dashboard-${device}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(errors, [], `${device} page errors`);
    console.log(JSON.stringify({ device, screenshot, title: await page.title() }));
    await page.close();
  }
} finally { await browser.close(); }
