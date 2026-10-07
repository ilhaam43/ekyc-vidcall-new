import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const base = process.env.KONG_CONSOLE_ORIGIN || 'http://127.0.0.1:5302';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('input[name="username"]').fill(process.env.KONG_CONSOLE_USERNAME || 'kong-admin');
    await page.locator('input[name="password"]').fill(process.env.KONG_CONSOLE_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await page.locator('.dashboard-stat').first().waitFor();
    const bars = await page.locator('progress.traffic-track, progress.composition-track').evaluateAll(items => items.map(item => ({ value: item.value, max: item.max })));
    assert.equal(bars.length, 7, 'dashboard shows three traffic and four resource bars');
    for (const bar of bars) assert.ok(bar.value >= 0 && bar.value <= bar.max, 'bar value stays within its range');
    await page.screenshot({ path: path.join(os.tmpdir(), `kong-control-${device}-dashboard.png`), fullPage: true });
    await page.getByRole('button', { name: 'Info', exact: true }).click();
    await page.getByRole('heading', { name: 'Gateway Info' }).waitFor();
    await page.getByRole('button', { name: 'Consumers', exact: true }).click();
    await page.getByRole('heading', { name: 'Consumers', exact: true }).first().waitFor();
    await page.getByText('ekyc-application-', { exact: false }).first().waitFor();
    for (const entity of ['Services', 'Routes', 'Consumers', 'Plugins', 'Upstreams', 'Certificates', 'CA Certificates', 'SNIs']) {
      await page.getByRole('button', { name: entity, exact: true }).click();
      await page.locator('.resource-controls .primary').click();
      if (entity === 'Plugins') await page.locator('.plugin-group button').filter({ hasText: 'key-auth' }).click();
      await page.locator('#editor').waitFor();
      assert.equal(await page.locator('#editor textarea[name="payload"]').count(), 0, `${entity} must use fields instead of JSON`);
      assert.ok(await page.locator('#editor input, #editor select, #editor textarea').count() >= 2, `${entity} form fields`);
      await page.locator('#editor').screenshot({ path: path.join(os.tmpdir(), `kong-control-${device}-${entity.toLowerCase()}-form.png`) });
      await page.getByRole('button', { name: 'Cancel' }).click();
    }
    await page.getByRole('button', { name: 'Services', exact: true }).click();
    await page.locator('.resource-link').first().click();
    const routesResponse = page.waitForResponse(response => /\/api\/services\/[^/]+\/routes/.test(response.url()));
    await page.locator('.detail-tabs').getByRole('button', { name: 'Routes' }).click();
    assert.equal((await routesResponse).status(), 200, 'service route tab loads its Kong resources');
    await page.getByRole('heading', { name: 'Routes' }).first().waitFor();
    const pluginsResponse = page.waitForResponse(response => /\/api\/services\/[^/]+\/plugins/.test(response.url()));
    await page.locator('.detail-tabs').getByRole('button', { name: 'Plugins' }).click();
    assert.equal((await pluginsResponse).status(), 200, 'service plugin tab loads its Kong resources');
    await page.getByRole('heading', { name: 'Plugins' }).first().waitFor();
    await page.getByRole('button', { name: 'Consumers', exact: true }).click();
    if (device === 'desktop') {
      await page.locator('.resource-table .resource-link').first().waitFor();
      while (await page.locator('tr').filter({ hasText: 'ui-smoke-' }).count()) {
        const stale = page.locator('tr').filter({ hasText: 'ui-smoke-' }).first();
        page.once('dialog', dialog => dialog.accept());
        await stale.getByRole('button', { name: 'Delete' }).click();
        await stale.waitFor({ state: 'detached' });
      }
      const username = `ui-smoke-${Date.now()}`;
      await page.locator('.resource-controls .primary').click();
      await page.locator('#editor input[name="username"]').fill(username);
      await page.locator('#editor input[name="custom_id"]').fill(username);
      await page.getByRole('button', { name: 'SUBMIT CONSUMER' }).click();
      await page.locator('#search').fill(username);
      await page.getByRole('button', { name: username, exact: true }).waitFor();
      const row = page.getByRole('row').filter({ hasText: username });
      await row.getByRole('button', { name: 'Edit' }).click();
      await page.locator('#editor input[name="custom_id"]').fill('ui-smoke-updated');
      await page.getByRole('button', { name: 'SAVE CONSUMER' }).click();
      await page.getByText('ui-smoke-updated').waitFor();
      page.once('dialog', dialog => dialog.accept());
      await row.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('button', { name: username, exact: true }).waitFor({ state: 'detached' });
    }
    for (const [navigation, heading] of [['Connections', 'Nodes'], ['Health', 'Health'], ['Snapshots', 'Snapshots'], ['Users', 'Users'], ['Notifications', 'Notifications'], ['Import Consumers', 'Import Consumers'], ['My Account', 'My Account']]) {
      await page.getByRole('button', { name: navigation, exact: true }).click();
      await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
      assert.deepEqual(errors, [], `${navigation} browser errors`);
    }
    if (device === 'desktop') {
      const username = `console-smoke-${Date.now()}`;
      const password = `Temp-${Date.now()}-Password`;
      await page.getByRole('button', { name: 'Users', exact: true }).click();
      await page.locator('#user-form input[name="username"]').fill(username);
      await page.locator('#user-form input[name="password"]').fill(password);
      await page.getByRole('button', { name: 'Create user' }).click();
      try { await page.getByText(username).waitFor({ timeout: 5000 }); }
      catch (error) { console.log('User create feedback:', await page.locator('.notice').allTextContents()); throw error; }
      const viewer = await browser.newPage({ viewport });
      await viewer.goto(base);
      await viewer.locator('input[name="username"]').fill(username);
      await viewer.locator('input[name="password"]').fill(password);
      await viewer.getByRole('button', { name: 'Sign in' }).click();
      await viewer.getByRole('heading', { name: 'Dashboard' }).waitFor();
      assert.equal(await viewer.locator('.resource-controls .primary').count(), 0, 'viewer cannot create resources');
      const forbidden = await viewer.evaluate(async () => {
        const session = await (await fetch('/api/session')).json();
        const response = await fetch('/api/consumers', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': session.data.csrf }, body: JSON.stringify({ username: 'should-not-create' }) });
        return response.status;
      });
      assert.equal(forbidden, 403, 'viewer write is denied by the API');
      page.once('dialog', dialog => dialog.accept());
      await page.locator('.management-row').filter({ hasText: username }).getByRole('button', { name: 'Delete' }).click();
      await page.getByText(username).waitFor({ state: 'detached' });
      assert.equal((await viewer.request.get(`${base}/api/session`)).status(), 401, 'deleted user session is revoked');
      await viewer.close();
      await page.getByRole('button', { name: 'Snapshots', exact: true }).click();
      await page.getByRole('button', { name: '+ Capture snapshot' }).click();
      await page.getByRole('button', { name: 'Restore preview' }).first().click();
      await page.getByText('The target contains existing objects:', { exact: false }).waitFor();
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    }
    const screenshot = path.join(os.tmpdir(), `kong-control-${device}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(errors, [], `${device} browser errors`);
    console.log(JSON.stringify({ device, screenshot }));
    await page.close();
  }
} finally { await browser.close(); }
