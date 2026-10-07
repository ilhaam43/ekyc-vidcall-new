import { afterEach, expect, test } from 'vitest';
import { capture, importConsumers, restorePreview, restoreToEmptyNode, validateConsumerImport } from '../../kong-console/control-ops.js';
import { createControlStore, validateNode } from '../../kong-console/control-store.js';
import { parseConsumerCsv } from '../../kong-console/public/management.js';

const previous = process.env.KONG_CONSOLE_ALLOWED_NODE_ORIGINS;
afterEach(() => { if (previous === undefined) delete process.env.KONG_CONSOLE_ALLOWED_NODE_ORIGINS; else process.env.KONG_CONSOLE_ALLOWED_NODE_ORIGINS = previous; });

test('remote Kong nodes require an explicitly allowed origin', () => {
  process.env.KONG_CONSOLE_ALLOWED_NODE_ORIGINS = 'https://kong.example.com';
  expect(validateNode({ name: 'Staging', url: 'https://kong.example.com' })).toMatchObject({ name: 'Staging', url: 'https://kong.example.com' });
  expect(() => validateNode({ name: 'Metadata', url: 'http://169.254.169.254' })).toThrow('HTTPS_REQUIRED_FOR_REMOTE_NODE');
  expect(() => validateNode({ name: 'Other', url: 'https://other.example.com' })).toThrow('NODE_ORIGIN_NOT_ALLOWED');
});

test('password change increments session version and rejects the old password', async () => {
  const values = new Map();
  const redis = {
    hExists: async (key, field) => values.has(`${key}:${field}`),
    hSet: async (key, field, value) => values.set(`${key}:${field}`, value),
    hGet: async (key, field) => values.get(`${key}:${field}`),
  };
  const store = createControlStore(redis, { name: 'Local', url: 'http://kong:8001' });
  await store.addUser({ username: 'operator', password: 'old-password-strong', role: 'viewer' });
  expect((await store.password('operator', 'old-password-strong')).version).toBe(1);
  await store.changePassword('operator', 'old-password-strong', 'new-password-strong');
  expect(await store.password('operator', 'old-password-strong')).toBeNull();
  expect((await store.password('operator', 'new-password-strong')).version).toBe(2);
});

test('CSV import parses quoted cells, validates rows and skips existing users', async () => {
  const rows = parseConsumerCsv('username,custom_id,tags\nnew-partner,"bank, 1","one,two"\n');
  expect(rows).toEqual([{ username: 'new-partner', custom_id: 'bank, 1', tags: 'one,two' }]);
  expect(() => validateConsumerImport([{ username: 'ekyc-application-owned' }])).toThrow();
  const calls = [];
  const client = { request: async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith('/consumers?')) return { data: [{ username: 'existing' }] };
    return { id: 'new-id', username: options.body.username };
  } };
  expect(await importConsumers(client, [{ username: 'existing' }, { username: 'new-partner' }])).toEqual({ created: [{ id: 'new-id', username: 'new-partner' }], skipped: ['existing'] });
  expect(calls.filter(call => call.options?.method === 'POST')).toHaveLength(1);
});

test('snapshot capture retains credentials and restore refuses a nonempty target', async () => {
  const source = { request: async path => {
    if (path.startsWith('/consumers?')) return { data: [{ id: 'consumer-1', username: 'partner' }] };
    if (path.startsWith('/consumers/consumer-1/key-auth?')) return { data: [{ id: 'credential-1', key: 'secret' }] };
    return { data: [] };
  } };
  const data = await capture(source);
  expect(data.credentials['consumer-1']['key-auth'][0].key).toBe('secret');
  const occupied = { request: async path => ({ data: path.startsWith('/services?') ? [{ id: 'existing' }] : [] }) };
  await expect(restoreToEmptyNode(occupied, data)).rejects.toThrow('TARGET_NODE_NOT_EMPTY');
});

test('restore remaps references to newly created gateway IDs', async () => {
  const posts = [];
  const client = { request: async (path, options) => {
    if (!options) return { data: [] };
    posts.push({ path, body: options.body });
    return { id: `new-${posts.length}` };
  } };
  const data = { upstreams: [], services: [{ id: 'old-service', name: 'api', protocol: 'http', host: 'backend' }], consumers: [], certificates: [], snis: [], routes: [{ id: 'old-route', name: 'route', paths: ['/api'], service: { id: 'old-service' } }], plugins: [], credentials: {}, targets: {} };
  expect(await restoreToEmptyNode(client, data)).toMatchObject({ services: 1, routes: 1 });
  expect(posts[1].body.service).toEqual({ id: 'new-1' });
});

test('restore blocks snapshots with Basic Auth password hashes', async () => {
  const client = { request: async () => ({ data: [] }) };
  const data = { services: [], routes: [], consumers: [], plugins: [], upstreams: [], certificates: [], ca_certificates: [], snis: [], credentials: { c1: { 'basic-auth': [{ username: 'user', password: 'hashed' }] } }, targets: {} };
  expect((await restorePreview(client, data)).warnings).toContain('BASIC_AUTH_PASSWORD_HASH_NOT_RESTORABLE');
  await expect(restoreToEmptyNode(client, data)).rejects.toThrow('SNAPSHOT_HAS_UNRESTORABLE_SECRETS');
});
