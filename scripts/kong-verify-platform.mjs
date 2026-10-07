import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { platformServices, platformRoutes } from '../kong-console/platform-routes.js';

const consoleOrigin = process.env.KONG_CONSOLE_ORIGIN || 'http://127.0.0.1:5302';
const proxy = 'http://127.0.0.1:58001';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(consoleOrigin).hostname), 'Local console required');
for (const path of ['/api/v1/users', '/v1/agents/profile', '/api/v2/calls/current']) {
  const response = await fetch(`${proxy}${path}`, { signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  assert.equal(response.status, 401, `${path} reaches the backend authentication middleware`);
  assert.ok(data.error?.code && response.headers.has('x-kong-upstream-latency'), `${path} returns the upstream response`);
  console.log(`${path}: forwarded; authentication required`);
}
const internal = await fetch(`${proxy}/internal/verifications`);
assert.equal(internal.status, 404);
const polling = await fetch(`${proxy}/socket.io/?EIO=4&transport=polling`);
assert.equal(polling.status, 400); assert.ok(polling.headers.has('x-kong-upstream-latency'), 'WebSocket-only backend rejects polling through Kong');
await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${proxy.replace('http:', 'ws:')}/socket.io/?EIO=4&transport=websocket`);
  const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket handshake timeout')); }, 10000);
  socket.addEventListener('message', event => { clearTimeout(timer); socket.close(); try { assert.ok(String(event.data).startsWith('0{'), 'Socket.IO WebSocket handshake'); resolve(); } catch (error) { reject(error); } }, { once: true });
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket handshake failed')); }, { once: true });
});
console.log('/socket.io: WebSocket handshake passed; polling remains disabled by the backend');

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage(); await page.goto(consoleOrigin);
  await page.locator('[name=username]').fill(process.env.KONG_CONSOLE_USERNAME || 'kong-admin');
  await page.locator('[name=password]').fill(process.env.KONG_CONSOLE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  for (const [label, rows] of [['Services', platformServices], ['Routes', platformRoutes]]) {
    await page.locator('.side').getByRole('button', { name: label, exact: true }).click();
    for (const row of rows) await page.getByRole('button', { name: row.name, exact: true }).waitFor();
    console.log(`${label}: all platform objects visible in Kong Control`);
  }
  await page.getByRole('button', { name: 'Sign out' }).click();
} finally { await browser.close(); }
