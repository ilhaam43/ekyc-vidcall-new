import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = process.env.KONG_CONSOLE_ORIGIN || 'http://127.0.0.1:5302';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'CRUD smoke test is restricted to local Kong');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
const page = await browser.newPage();
const fixtures = [];
const name = `crud-smoke-${Date.now()}`;
async function request(path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const session = (await (await fetch('/api/session')).json()).data;
    const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  }, { path, method, body });
}
async function createForm(label) {
  await page.locator('.side').getByRole('button', { name: label, exact: true }).click();
  await page.locator('.resource-controls .primary').click();
  await page.locator('#editor').waitFor();
}
async function submit(path, method = 'POST') {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api${path}` && response.request().method() === method);
  await page.locator('#editor button.primary').click();
  const response = await responsePromise;
  const result = await response.json();
  assert.ok(response.ok(), result.error?.code || `${path}: ${response.status()}`);
  await page.locator('#editor').waitFor({ state: 'detached' });
  return result.data;
}
async function openDetail(label, recordName) {
  await page.locator('.side').getByRole('button', { name: label, exact: true }).click();
  await page.locator('#search').fill(recordName);
  await page.getByRole('button', { name: recordName, exact: true }).click();
}
try {
  await page.goto(base);
  await page.locator('[name=username]').fill(process.env.KONG_CONSOLE_USERNAME || 'kong-admin');
  await page.locator('[name=password]').fill(process.env.KONG_CONSOLE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();

  await createForm('Services');
  await page.locator('#editor [name=name]').fill(`${name}-service`);
  await page.locator('#editor [name=url]').fill('http://synthetic.invalid:8080');
  const service = await submit('/services'); fixtures.unshift(`/services/${service.id}`);
  await openDetail('Services', `${name}-service`);
  await page.locator('.detail-tabs').getByRole('button', { name: 'Plugins' }).click();
  await page.getByRole('button', { name: '+ Add plugin' }).click();
  await page.locator('.plugin-group button').filter({ has: page.locator('strong', { hasText: /^key-auth$/ }) }).click();
  await page.locator('#editor [name="config.key_names"]').fill('x-test-key');
  const plugin = await submit('/plugins'); fixtures.unshift(`/plugins/${plugin.id}`);
  assert.equal(plugin.service.id, service.id);
  assert.deepEqual(plugin.config.key_names, ['x-test-key']);
  await page.locator('.nested-row').filter({ hasText: plugin.id }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#editor [name="config.hide_credentials"]').selectOption('false');
  const editedPlugin = await submit(`/plugins/${plugin.id}`, 'PATCH');
  assert.equal(editedPlugin.config.hide_credentials, false);
  assert.deepEqual(editedPlugin.config.key_names, ['x-test-key']);

  await createForm('Routes');
  await page.locator('#editor [name=name]').fill(`${name}-route`);
  await page.locator('#editor [name=service_id]').selectOption(service.id);
  await page.locator('#editor [name=paths]').fill(`/${name}`);
  await page.locator('#editor [name="advanced.headers"]').fill('X-Bank: lampung');
  await page.locator('#editor [name="advanced.regex_priority"]').fill('7');
  const route = await submit('/routes'); fixtures.unshift(`/routes/${route.id}`);
  assert.deepEqual(route.headers, { 'X-Bank': ['lampung'] });
  assert.equal(route.regex_priority, 7);

  await createForm('Upstreams');
  await page.locator('#editor [name=name]').fill(`${name}-upstream`);
  await page.locator('#editor [name=algorithm]').selectOption('consistent-hashing');
  await page.locator('#editor [name=hash_on]').selectOption('header');
  await page.locator('#editor [name="advanced.hash_on_header"]').fill('X-Bank');
  await page.locator('#editor [name="advanced.healthchecks.active.healthy.interval"]').fill('20');
  const upstream = await submit('/upstreams'); fixtures.unshift(`/upstreams/${upstream.id}`);
  assert.equal(upstream.hash_on_header, 'X-Bank');
  assert.equal(upstream.healthchecks.active.healthy.interval, 20);
  await openDetail('Upstreams', `${name}-upstream`);
  await page.locator('.detail-tabs').getByRole('button', { name: 'Targets' }).click();
  await page.getByRole('button', { name: '+ Add Targets' }).click();
  await page.locator('#editor [name=target]').fill('192.0.2.10:8080');
  const target = await submit(`/upstreams/${upstream.id}/targets`);
  await page.locator('.nested-row').filter({ hasText: target.id }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#editor [name=weight]').fill('50');
  assert.equal((await submit(`/upstreams/${upstream.id}/targets/${target.id}`, 'PATCH')).weight, 50);

  await createForm('Consumers');
  await page.locator('#editor [name=username]').fill(`${name}-consumer`);
  const consumer = await submit('/consumers'); fixtures.unshift(`/consumers/${consumer.id}`);
  await openDetail('Consumers', `${name}-consumer`);
  await page.locator('.detail-tabs').getByRole('button', { name: 'Basic Auth', exact: true }).click();
  await page.getByRole('button', { name: '+ Add Basic Auth' }).click();
  await page.locator('#editor [name=username]').fill('test-staff');
  await page.locator('#editor [name=password]').fill('Synthetic-Only-Password');
  const basic = await submit(`/consumers/${consumer.id}/basic-auth`);
  await page.locator('.nested-row').filter({ hasText: basic.id }).getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.locator('#editor [name=username]').inputValue(), 'test-staff');
  await page.locator('#editor [name=tags]').fill('edited');
  const edited = await submit(`/consumers/${consumer.id}/basic-auth/${basic.id}`, 'PATCH');
  assert.equal(edited.username, 'test-staff'); assert.ok(!Object.hasOwn(edited, 'password'));
  const listed = await request(`/consumers/${consumer.id}/basic-auth`);
  assert.ok(listed.data.data.every(row => !Object.hasOwn(row, 'password')));
  await page.locator('.detail-tabs').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('button', { name: '+ Add plugin' }).waitFor();
  console.log('PASS: live Kong Service, Route headers, scoped Plugin, Upstream health checks, Target weight, and credential edit flows');
} finally {
  const failures = [];
  for (const fixture of fixtures) {
    try { const result = await request(fixture, 'DELETE'); if (result.status !== 200 && result.status !== 404) failures.push(fixture); }
    catch { failures.push(fixture); }
  }
  await browser.close();
  assert.deepEqual(failures, [], 'All test-owned resources must be removed');
}
