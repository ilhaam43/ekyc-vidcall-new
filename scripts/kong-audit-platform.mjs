import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createApp as masterApp } from '../ekyc-backend-master/src/app.js';
import { createApp as callsApp } from '../ekyc-vidcall-backend/src/app.js';

// Instantiate the route registries without connecting to a database or storage.
const cfg = { publicOrigin: 'http://127.0.0.1:5173' };
const unavailable = () => { throw new Error('Inventory must not access data'); };
const registries = [['master', masterApp(unavailable, cfg, {})], ['calls', callsApp(unavailable, cfg, {})]];
const proxy = 'http://127.0.0.1:58001';
const origin = 'http://127.0.0.1:5302';
let cookie = '', csrf = '';
async function consoleRequest(path, method = 'GET', body) {
  const response = await fetch(`${origin}/api${path}`, { method, signal: AbortSignal.timeout(15000), headers: { origin, 'x-kong-node': 'local', cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  for (const value of response.headers.getSetCookie()) if (value.startsWith('kong_console_sid=')) cookie = value.split(';')[0];
  const data = await response.json(); assert.ok(response.ok, data.error?.code); return data.data;
}
async function all(entity) {
  const rows = []; let offset;
  do { const data = await consoleRequest(`/${entity}?size=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`); rows.push(...data.data); offset = data.next || data.offset; } while (offset);
  return rows;
}
const session = await consoleRequest('/login', 'POST', { username: process.env.KONG_CONSOLE_USERNAME, password: process.env.KONG_CONSOLE_PASSWORD });
csrf = session.csrf;
const report = { checked_at: new Date().toISOString(), proxy, endpoints: [], failures: [] };
try {
  const services = await all('services'), routes = await all('routes'), plugins = await all('plugins');
  report.services = services.map(({ name, host, port }) => ({ name, host, port }));
  report.routes = routes.map(({ name, paths, methods, strip_path, service }) => ({ name, paths, methods, strip_path, service: services.find(row => row.id === service?.id)?.name }));
  report.plugins = plugins.map(({ name, enabled, route, service, consumer }) => ({ name, enabled, route: routes.find(row => row.id === route?.id)?.name, service: services.find(row => row.id === service?.id)?.name, consumer_scoped: Boolean(consumer) }));
  for (const [backend, app] of registries) {
    for (const layer of app.router.stack.filter(row => row.route)) {
      const route = layer.route;
      for (const path of [route.path].flat()) for (const method of Object.keys(route.methods)) {
        const publicApi = path.startsWith('/api/') || path.startsWith('/v1/');
        const name = backend === 'master' ? 'ekyc-master-api' : 'ekyc-videocall-api';
        const matching = routes.find(row => row.service?.id === services.find(s => s.name === name)?.id && row.paths?.some(prefix => path === prefix || path.startsWith(`${prefix}/`)) && (!row.methods?.length || row.methods.includes(method.toUpperCase())));
        const concrete = path.replace(/:[A-Za-z_]+/g, '00000000-0000-4000-8000-000000000000');
        const response = await fetch(`${proxy}${concrete}`, { method: method.toUpperCase(), signal: AbortSignal.timeout(10000), headers: { origin: cfg.publicOrigin, authorization: 'Bearer kong-audit-invalid-token', 'content-type': 'application/json' }, body: ['get', 'head'].includes(method) ? undefined : '{}' });
        const data = await response.json().catch(() => ({}));
        const forwarded = response.headers.has('x-kong-upstream-latency');
        const passed = publicApi ? Boolean(matching) && matching.strip_path === false && forwarded && response.status >= 400 && response.status < 500 : !forwarded && response.status === 404;
        const result = { backend, method: method.toUpperCase(), path, public: publicApi, route: matching?.name || null, status: response.status, code: data.error?.code || data.message, forwarded, passed };
        report.endpoints.push(result); if (!passed) report.failures.push(result);
      }
    }
  }
  // Bank partner provisioning must be stopped by Kong key-auth without an API key.
  const partner = await fetch(`${proxy}/partner/v1/video-call/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  report.partner = { status: partner.status, blocked_by_gateway: partner.status === 401 && !partner.headers.has('x-kong-upstream-latency') };
  if (!report.partner.blocked_by_gateway) report.failures.push(report.partner);
  for (const path of ['/api/v1/users', '/api/v2/calls/current', '/v1/calls/queues']) {
    const response = await fetch(`${proxy}${path}`, { method: 'OPTIONS', headers: { origin: cfg.publicOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    const passed = response.ok && response.headers.get('access-control-allow-origin') === cfg.publicOrigin;
    (report.cors ||= []).push({ path, status: response.status, passed }); if (!passed) report.failures.push({ path, check: 'cors' });
  }
  const nginx = await readFile(new URL('../infra/nginx.conf', import.meta.url), 'utf8');
  report.frontend_uses_kong = nginx.includes('kong:8000');
  report.summary = { public_endpoints: report.endpoints.filter(row => row.public).length, private_endpoints: report.endpoints.filter(row => !row.public).length, passed: report.endpoints.filter(row => row.passed).length, failures: report.failures.length };
  await mkdir('.local', { recursive: true });
  await writeFile('.local/kong-api-audit.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ summary: report.summary, partner: report.partner, cors: report.cors, frontend_uses_kong: report.frontend_uses_kong, plugins: report.plugins, failures: report.failures }, null, 2));
  assert.equal(report.failures.length, 0, 'See .local/kong-api-audit.json');
} finally { await consoleRequest('/logout', 'POST'); }
