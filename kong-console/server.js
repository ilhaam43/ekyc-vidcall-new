import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createClient } from 'redis';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KongError, kongClient } from './kong-client.js';
import { createControlStore } from './control-store.js';
import { capture, importConsumers, restorePreview, restoreToEmptyNode, validateConsumerImport } from './control-ops.js';
import { credentialMetadata, mergeConfig, redactConfig } from './resource-values.js';

const app = express();
const cfg = {
  username: process.env.KONG_CONSOLE_USERNAME || 'kong-admin', password: process.env.KONG_CONSOLE_PASSWORD,
  origin: process.env.KONG_CONSOLE_ORIGIN || 'http://127.0.0.1:5302', port: Number(process.env.KONG_CONSOLE_PORT || 5302),
  redis: process.env.VALKEY_URL || 'redis://valkey:6379',
};
if (!cfg.password || cfg.password.length < 16) throw new Error('KONG_CONSOLE_PASSWORD must be at least 16 characters');
if (process.env.NODE_ENV === 'production' && String(process.env.KONG_CONSOLE_DATA_KEY || '').length < 32) throw new Error('KONG_CONSOLE_DATA_KEY must be at least 32 characters in production');
const redis = createClient({ url: cfg.redis });
const kong = kongClient({ url: process.env.KONG_ADMIN_URL, token: process.env.KONG_ADMIN_TOKEN, tokenHeader: process.env.KONG_ADMIN_TOKEN_HEADER || 'Kong-Admin-Token' });
const store = createControlStore(redis, { name: 'Local Kong', url: process.env.KONG_ADMIN_URL || '', token: process.env.KONG_ADMIN_TOKEN || '', tokenHeader: process.env.KONG_ADMIN_TOKEN_HEADER || 'Kong-Admin-Token' });
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => { const x = Buffer.from(hash(a)); const y = Buffer.from(hash(b)); return timingSafeEqual(x, y); };
const reply = (res, data) => res.set('cache-control', 'no-store').json({ success: true, data });
const bad = (status, code) => { throw new KongError(status, code); };
const id = value => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value);
const fields = (body, allowed) => Object.fromEntries(Object.entries(body || {}).filter(([key]) => allowed.includes(key)));
const safe = (entity, row) => {
  if (entity === 'plugins') {
    return { ...row, config: redactConfig(row.config) };
  }
  if (entity === 'certificates') return { ...row, key: undefined, cert: row.cert ? '[configured]' : undefined };
  if (entity === 'consumers') return { ...row, key: undefined };
  return row;
};
const entities = {
  services: ['name', 'url', 'protocol', 'host', 'port', 'path', 'retries', 'connect_timeout', 'write_timeout', 'read_timeout', 'client_certificate', 'tls_verify', 'tls_verify_depth', 'ca_certificates', 'enabled', 'tags'],
  routes: ['name', 'service', 'paths', 'hosts', 'methods', 'protocols', 'strip_path', 'preserve_host', 'headers', 'snis', 'sources', 'destinations', 'path_handling', 'https_redirect_status_code', 'regex_priority', 'request_buffering', 'response_buffering', 'tags'],
  consumers: ['username', 'custom_id', 'tags'],
  plugins: ['name', 'enabled', 'service', 'route', 'consumer', 'config', 'tags'],
  upstreams: ['name', 'algorithm', 'hash_on', 'hash_fallback', 'hash_on_header', 'hash_fallback_header', 'hash_on_cookie', 'hash_on_cookie_path', 'hash_on_query_arg', 'hash_fallback_query_arg', 'hash_on_uri_capture', 'hash_fallback_uri_capture', 'host_header', 'healthchecks', 'slots', 'tags'],
  certificates: ['cert', 'key', 'tags'],
  ca_certificates: ['cert', 'tags'],
  snis: ['name', 'certificate', 'tags'],
};
async function managedConsumer(req, consumerId) {
  if (req.node.id !== 'local') return false;
  const consumer = await req.kong.request(`/consumers/${consumerId}`);
  return /^ekyc-application-/.test(consumer.username || '');
}
const clientFor = node => kongClient(node);
const adminOnly = (req, _res, next) => req.role === 'admin' ? next() : next(new KongError(403, 'ADMIN_REQUIRED'));
app.disable('x-powered-by'); app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '256kb' }));
app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (_req, res) => { await redis.ping(); res.json({ status: 'ready', kong_configured: kong.configured }); });
app.post('/api/login', rateLimit({ windowMs: 60000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
  if (req.headers.origin && req.headers.origin !== cfg.origin) bad(403, 'INVALID_ORIGIN');
  if (typeof req.body?.username !== 'string' || typeof req.body?.password !== 'string') bad(401, 'INVALID_CREDENTIALS');
  const account = req.body.username === cfg.username && equal(req.body.password, cfg.password) ? { username: cfg.username, role: 'admin' } : await store.password(req.body.username, req.body.password);
  if (!account) bad(401, 'INVALID_CREDENTIALS');
  const sid = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await redis.set(`kong-console:${hash(sid)}`, JSON.stringify({ csrf, username: account.username, role: account.role, version: account.version }), { EX: 3600 });
  res.cookie('kong_console_sid', sid, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 3600000 });
  reply(res, { csrf, username: account.username, role: account.role, environmentUsername: cfg.username });
});
app.use('/api', async (req, _res, next) => {
  try {
    const sid = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('kong_console_sid='))?.slice(17);
    if (!sid || sid.length > 100) bad(401, 'AUTH_REQUIRED');
    const sessionKey = `kong-console:${hash(sid)}`; const raw = await redis.get(sessionKey);
    if (!raw) bad(401, 'SESSION_EXPIRED');
    let session; try { session = JSON.parse(raw); } catch { session = { csrf: raw, username: cfg.username, role: 'admin' }; }
    if (session.username !== cfg.username) { const user = await store.user(session.username); if (!user?.active || session.version !== user.version) bad(401, 'SESSION_REVOKED'); session.role = user.role; }
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers.origin !== cfg.origin) bad(403, 'INVALID_ORIGIN');
      if (!equal(String(req.headers['x-csrf-token'] || ''), session.csrf)) bad(403, 'CSRF_INVALID');
      if (session.role !== 'admin' && !['/logout', '/account/password'].includes(req.path)) bad(403, 'READ_ONLY');
    }
    const node = await store.node(req.headers['x-kong-node'] || 'local');
    await redis.expire(sessionKey, 3600); req.sessionKey = sessionKey; req.csrf = session.csrf; req.username = session.username; req.role = session.role; req.node = node; req.kong = node.id === 'local' ? kong : clientFor(node); next();
  } catch (error) { next(error); }
});
app.get('/api/session', (req, res) => reply(res, { csrf: req.csrf, username: req.username, role: req.role, nodeId: req.node.id, environmentUsername: cfg.username }));
app.post('/api/logout', async (req, res) => { await redis.del(req.sessionKey); res.clearCookie('kong_console_sid', { path: '/' }); reply(res, { logged_out: true }); });
app.post('/api/account/password', async (req, res) => {
  if (req.username === cfg.username) bad(409, 'ENV_ACCOUNT_PASSWORD');
  const result = await store.changePassword(req.username, req.body?.currentPassword, req.body?.newPassword);
  await redis.del(req.sessionKey); res.clearCookie('kong_console_sid', { path: '/' }); reply(res, result);
});
app.get('/api/nodes', async (_req, res) => reply(res, await store.nodes()));
app.post('/api/nodes', adminOnly, async (req, res) => reply(res, await store.addNode(req.body)));
app.delete('/api/nodes/:id', adminOnly, async (req, res) => reply(res, await store.removeNode(req.params.id)));
app.get('/api/users', adminOnly, async (_req, res) => reply(res, [{ username: cfg.username, role: 'admin', active: true, managed: true }, ...await store.users()]));
app.post('/api/users', adminOnly, async (req, res) => reply(res, await store.addUser(req.body)));
app.patch('/api/users/:username', adminOnly, async (req, res) => reply(res, await store.setUserActive(req.params.username, req.body?.active)));
app.delete('/api/users/:username', adminOnly, async (req, res) => reply(res, await store.removeUser(req.params.username)));
app.get('/api/health', async (req, res) => {
  try {
    const [root, status] = await Promise.all([req.kong.request('/'), req.kong.request('/status')]);
    reply(res, { online: true, node: { id: req.node.id, name: req.node.name }, version: root.version, database: status.database?.reachable === true ? 'reachable' : status.database?.reachable === false ? 'unreachable' : 'unknown', server: status.server || {}, checkedAt: new Date().toISOString() });
  } catch (error) { reply(res, { online: false, node: { id: req.node.id, name: req.node.name }, error: error.code || 'KONG_UNAVAILABLE', checkedAt: new Date().toISOString() }); }
});
app.get('/api/upstreams/:id/health', async (req, res) => { if (!id(req.params.id)) bad(422, 'INVALID_ID'); reply(res, await req.kong.request(`/upstreams/${req.params.id}/health`)); });
app.get('/api/plugins/catalog', async (req, res) => {
  const result = await req.kong.request('/plugins/enabled');
  reply(res, (result.enabled_plugins || []).filter(id).sort());
});
app.get('/api/schemas/:entity', async (req, res) => {
  if (!['services', 'routes', 'upstreams'].includes(req.params.entity)) bad(404, 'ENTITY_NOT_FOUND');
  reply(res, await req.kong.request(`/schemas/${req.params.entity}`));
});
app.get('/api/plugins/schema/:name', async (req, res) => {
  if (!id(req.params.name)) bad(422, 'INVALID_PLUGIN_NAME');
  const result = await req.kong.request(`/schemas/plugins/${req.params.name}`);
  reply(res, result);
});
for (const [scope, related] of [['services', 'routes'], ['services', 'plugins'], ['routes', 'plugins'], ['consumers', 'plugins']]) {
  app.get(`/api/${scope}/:id/${related}`, async (req, res) => {
    if (!id(req.params.id)) bad(422, 'INVALID_ID');
    const params = new URLSearchParams({ size: '100' });
    if (typeof req.query.offset === 'string' && req.query.offset.length <= 512) params.set('offset', req.query.offset);
    const result = await req.kong.request(`/${scope}/${req.params.id}/${related}?${params}`);
    reply(res, { data: (result.data || []).map(row => safe(related, row)), next: result.offset || null });
  });
}
app.get('/api/snapshots', adminOnly, async (_req, res) => reply(res, await store.snapshots()));
app.post('/api/snapshots', adminOnly, async (req, res) => reply(res, await store.saveSnapshot(req.node.id, await capture(req.kong))));
app.get('/api/snapshots/:id/preview', adminOnly, async (req, res) => {
  const snapshot = await store.snapshot(req.params.id);
  reply(res, { ...await restorePreview(req.kong, snapshot.data), sourceNodeId: snapshot.nodeId, targetNodeId: req.node.id, snapshotId: snapshot.id, sha256: snapshot.sha256 });
});
app.post('/api/snapshots/:id/restore', adminOnly, async (req, res) => {
  const snapshot = await store.snapshot(req.params.id);
  if (req.body?.confirmation !== `RESTORE ${req.node.name}` || req.body?.sha256 !== snapshot.sha256) bad(422, 'RESTORE_CONFIRMATION_REQUIRED');
  reply(res, { restored: await restoreToEmptyNode(req.kong, snapshot.data), targetNodeId: req.node.id });
});
app.delete('/api/snapshots/:id', adminOnly, async (req, res) => reply(res, await store.removeSnapshot(req.params.id)));
app.get('/api/notifications', adminOnly, async (_req, res) => { const config = await store.notification(); reply(res, { ...config, webhookUrl: '', webhookConfigured: Boolean(config.webhookUrl) }); });
app.put('/api/notifications', adminOnly, async (req, res) => reply(res, await store.saveNotification(req.body)));
app.post('/api/import/consumers', adminOnly, async (req, res) => { validateConsumerImport(req.body?.rows); reply(res, await importConsumers(req.kong, req.body.rows)); });
app.post('/api/import/consumers/url', adminOnly, async (req, res) => {
  let source; try { source = new URL(String(req.body?.url || '')); } catch { bad(422, 'INVALID_IMPORT_URL'); }
  const allowed = String(process.env.KONG_CONSOLE_ALLOWED_IMPORT_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (source.protocol !== 'https:' || source.username || source.password || !allowed.includes(source.origin)) bad(422, 'IMPORT_ORIGIN_NOT_ALLOWED');
  const remote = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json', ...(process.env.KONG_CONSOLE_IMPORT_API_TOKEN ? { authorization: `Bearer ${process.env.KONG_CONSOLE_IMPORT_API_TOKEN}` } : {}) } });
  if (!remote.ok) bad(502, 'IMPORT_SOURCE_UNAVAILABLE');
  const reader = remote.body.getReader(); let chunks = [], size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1048576) { await reader.cancel(); bad(413, 'IMPORT_SOURCE_TOO_LARGE'); } chunks.push(value); }
  let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { bad(422, 'INVALID_IMPORT_RESPONSE'); }
  const rows = Array.isArray(parsed) ? parsed : parsed?.data;
  validateConsumerImport(rows);
  reply(res, await importConsumers(req.kong, rows));
});
app.get('/api/overview', async (req, res) => {
  if (!req.kong.configured) return reply(res, { connected: false, counts: {} });
  const root = await req.kong.request('/');
  const totals = await Promise.all(Object.keys(entities).map(async entity => {
    let count = 0, offset = null, pages = 0;
    do {
      const params = new URLSearchParams({ size: '100' }); if (offset) params.set('offset', offset);
      const result = await req.kong.request(`/${entity}?${params}`);
      count += result.data?.length || 0; offset = result.offset || null; pages += 1;
    } while (offset && pages < 20);
    return [entity, count, Boolean(offset)];
  }));
  reply(res, { connected: true, version: root.version, counts: Object.fromEntries(totals.map(([entity, count]) => [entity, count])), approximate: totals.some(([, , truncated]) => truncated) });
});
app.get('/api/:entity', async (req, res) => {
  const { entity } = req.params; if (!entities[entity]) bad(404, 'ENTITY_NOT_FOUND');
  const params = new URLSearchParams({ size: '100' }); if (typeof req.query.offset === 'string' && req.query.offset.length <= 512) params.set('offset', req.query.offset);
  const result = await req.kong.request(`/${entity}?${params}`);
  reply(res, { data: (result.data || []).map(row => safe(entity, row)), next: result.offset || null });
});
app.post('/api/:entity', async (req, res) => {
  const { entity } = req.params; if (!entities[entity]) bad(404, 'ENTITY_NOT_FOUND');
  const body = fields(req.body, entities[entity]); if (!Object.keys(body).length) bad(422, 'EMPTY_BODY');
  const result = await req.kong.request(`/${entity}`, { method: 'POST', body }); reply(res, safe(entity, result));
});
app.patch('/api/:entity/:id', async (req, res) => {
  const { entity, id: entityId } = req.params; if (!entities[entity] || !id(entityId)) bad(404, 'ENTITY_NOT_FOUND');
  if (req.node.id === 'local' && entity === 'routes' && entityId === process.env.KONG_API_ROUTE_ID) bad(409, 'MANAGED_EKYC_ROUTE');
  if (entity === 'consumers' && await managedConsumer(req, entityId)) bad(409, 'MANAGED_EKYC_CONSUMER');
  const body = fields(req.body, entities[entity]); if (!Object.keys(body).length) bad(422, 'EMPTY_BODY');
  if (entity === 'plugins') {
    const current = await req.kong.request(`/plugins/${entityId}`);
    if (req.node.id === 'local' && current.route?.id === process.env.KONG_API_ROUTE_ID && ['key-auth', 'acl'].includes(current.name)) bad(409, 'MANAGED_EKYC_PLUGIN');
    if (current.consumer?.id && current.name === 'rate-limiting' && await managedConsumer(req, current.consumer.id)) bad(409, 'MANAGED_EKYC_RATE_LIMIT');
    if (body.config && typeof body.config === 'object') body.config = mergeConfig(current.config, body.config);
  }
  if (entity === 'upstreams' && body.healthchecks) { const current = await req.kong.request(`/upstreams/${entityId}`); body.healthchecks = mergeConfig(current.healthchecks, body.healthchecks); }
  const result = await req.kong.request(`/${entity}/${entityId}`, { method: 'PATCH', body }); reply(res, safe(entity, result));
});
app.delete('/api/:entity/:id', async (req, res) => {
  const { entity, id: entityId } = req.params; if (!entities[entity] || !id(entityId)) bad(404, 'ENTITY_NOT_FOUND');
  if (req.node.id === 'local' && entity === 'routes' && entityId === process.env.KONG_API_ROUTE_ID) bad(409, 'MANAGED_EKYC_ROUTE');
  if (req.node.id === 'local' && entity === 'services' && process.env.KONG_API_ROUTE_ID) { const route = await req.kong.request(`/routes/${process.env.KONG_API_ROUTE_ID}`); if (route.service?.id === entityId) bad(409, 'MANAGED_EKYC_SERVICE'); }
  if (entity === 'plugins') { const plugin = await req.kong.request(`/plugins/${entityId}`); if (req.node.id === 'local' && plugin.route?.id === process.env.KONG_API_ROUTE_ID && ['key-auth', 'acl'].includes(plugin.name)) bad(409, 'MANAGED_EKYC_PLUGIN'); if (plugin.consumer?.id && plugin.name === 'rate-limiting' && await managedConsumer(req, plugin.consumer.id)) bad(409, 'MANAGED_EKYC_RATE_LIMIT'); }
  if (entity === 'consumers' && await managedConsumer(req, entityId)) bad(409, 'MANAGED_EKYC_CONSUMER');
  reply(res, await req.kong.request(`/${entity}/${entityId}`, { method: 'DELETE' }));
});
for (const [scope, sub, allowed] of [['consumers', 'key-auth', ['key', 'ttl', 'tags']], ['consumers', 'acls', ['group', 'tags']], ['consumers', 'basic-auth', ['username', 'password', 'tags']], ['consumers', 'jwt', ['key', 'secret', 'algorithm', 'rsa_public_key', 'tags']], ['consumers', 'hmac-auth', ['username', 'secret', 'tags']], ['upstreams', 'targets', ['target', 'weight', 'tags']]]) {
  app.get(`/api/${scope}/:id/${sub}`, async (req, res) => { if (!id(req.params.id)) bad(422, 'INVALID_ID'); const params = new URLSearchParams({ size: '100' }); if (typeof req.query.offset === 'string' && req.query.offset.length <= 512) params.set('offset', req.query.offset); const result = await req.kong.request(`/${scope}/${req.params.id}/${sub}?${params}`); reply(res, { data: (result.data || []).map(row => credentialMetadata(sub, row)), next: result.offset || null }); });
  app.post(`/api/${scope}/:id/${sub}`, async (req, res) => { if (!id(req.params.id)) bad(422, 'INVALID_ID'); if (sub === 'acls' && await managedConsumer(req, req.params.id)) bad(409, 'MANAGED_EKYC_ACL'); const body = fields(req.body, allowed); if (!Object.keys(body).length && sub !== 'key-auth' && sub !== 'jwt') bad(422, 'EMPTY_BODY'); const result = await req.kong.request(`/${scope}/${req.params.id}/${sub}`, { method: 'POST', body }); reply(res, ['key-auth', 'jwt', 'hmac-auth'].includes(sub) ? { id: result.id, key: sub === 'key-auth' ? result.key : result.secret, one_time: true } : { id: result.id, username: result.username, group: result.group, target: result.target, weight: result.weight, tags: result.tags }); });
  app.patch(`/api/${scope}/:id/${sub}/:child`, async (req, res) => {
    if (!id(req.params.id) || !id(req.params.child)) bad(422, 'INVALID_ID');
    if (sub === 'acls' && await managedConsumer(req, req.params.id)) bad(409, 'MANAGED_EKYC_ACL');
    const body = fields(req.body, allowed); if (!Object.keys(body).length) bad(422, 'EMPTY_BODY');
    const result = await req.kong.request(`/${scope}/${req.params.id}/${sub}/${req.params.child}`, { method: 'PATCH', body });
    const changedSecret = sub === 'key-auth' && body.key ? result.key : ['jwt', 'hmac-auth'].includes(sub) && body.secret ? result.secret : undefined;
    reply(res, { ...credentialMetadata(sub, result), ...(changedSecret ? { key: changedSecret, one_time: true } : {}) });
  });
  app.delete(`/api/${scope}/:id/${sub}/:child`, async (req, res) => { if (!id(req.params.id) || !id(req.params.child)) bad(422, 'INVALID_ID'); if (sub === 'acls' && await managedConsumer(req, req.params.id)) bad(409, 'MANAGED_EKYC_ACL'); if (sub === 'key-auth') { const current = await req.kong.request(`/${scope}/${req.params.id}/${sub}?size=100`); if (current.data?.length <= 1 && await managedConsumer(req, req.params.id)) bad(409, 'LAST_EKYC_KEY'); } reply(res, await req.kong.request(`/${scope}/${req.params.id}/${sub}/${req.params.child}`, { method: 'DELETE' })); });
}
app.use('/api', (_req, _res, next) => next(new KongError(404, 'NOT_FOUND')));
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root, 'public'), { index: false }));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'public', 'index.html')));
app.use((error, _req, res, _next) => { const status = error.status || 500; if (status >= 500) console.error(JSON.stringify({ event: 'kong_console_error', code: error.code || 'INTERNAL_ERROR' })); res.status(status).json({ success: false, error: { code: status === 500 ? 'INTERNAL_ERROR' : error.code || 'REQUEST_FAILED' } }); });
await redis.connect();
async function monitorNodes() {
  const notification = await store.notification();
  for (const node of await store.nodes()) {
    let online = false;
    try { await clientFor(await store.node(node.id)).request('/status'); online = true; } catch { /* reported as offline */ }
    const key = `kong-console:monitor:${node.id}`, previous = await redis.get(key);
    await redis.set(key, online ? 'online' : 'offline', { EX: 86400 });
    if (previous && previous !== (online ? 'online' : 'offline')) {
      const status = online ? 'online' : 'offline', occurredAt = new Date().toISOString(), message = `Kong node ${node.name} is ${status}`;
      if (notification.webhookEnabled) {
        try {
          const response = await fetch(notification.webhookUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: message, event: 'kong.node.status', node: { id: node.id, name: node.name }, status, occurred_at: occurredAt }) });
          if (!response.ok) throw new Error(`HTTP_${response.status}`);
        } catch (error) { console.error(JSON.stringify({ event: 'kong_webhook_failed', node_id: node.id, code: error.message })); }
      }
      if (notification.emailEnabled) {
        try {
          const transport = nodemailer.createTransport(process.env.KONG_CONSOLE_SMTP_URL, { requireTLS: true, tls: { minVersion: 'TLSv1.2' }, connectionTimeout: 8000, socketTimeout: 8000 });
          await transport.sendMail({ from: process.env.KONG_CONSOLE_SMTP_FROM, to: notification.emailTo, subject: message, text: `${message}\nTime: ${occurredAt}\nNode ID: ${node.id}` });
          transport.close();
        } catch (error) { console.error(JSON.stringify({ event: 'kong_email_failed', node_id: node.id, code: error.code || 'SMTP_ERROR' })); }
      }
    }
  }
}
setInterval(() => monitorNodes().catch(error => console.error(JSON.stringify({ event: 'kong_monitor_failed', code: error.code || 'INTERNAL_ERROR' }))), 60000).unref();
app.listen(cfg.port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'kong-console', port: cfg.port })));
