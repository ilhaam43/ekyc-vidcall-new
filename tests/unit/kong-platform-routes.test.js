import { expect, test } from 'vitest';
import { ensurePlatformRoutes } from '../../kong-console/platform-routes.js';

test('platform provisioning is idempotent and preserves the existing bank partner route', async () => {
  const entities = { services: [{ id: 'partner', name: 'ekyc-partner-api', host: 'dashboard', port: 5301 }], routes: [{ id: 'partner-route', name: 'ekyc-partner-v1', service: { id: 'partner' }, paths: ['/partner/v1'] }] };
  const writes = [];
  const client = { request: async (path, options = {}) => {
    const entity = path.split('/')[1].split('?')[0];
    if (!options.method) return { data: structuredClone(entities[entity]) };
    writes.push(path);
    const row = { id: `created-${writes.length}`, ...structuredClone(options.body) };
    entities[entity].push(row); return row;
  } };
  const first = await ensurePlatformRoutes(client);
  expect(first.services).toHaveLength(2); expect(first.routes).toHaveLength(4);
  expect(first.routes.every(row => row.action === 'created')).toBe(true);
  const second = await ensurePlatformRoutes(client);
  expect(second.routes.every(row => row.action === 'unchanged')).toBe(true);
  expect(writes).toHaveLength(6);
  expect(entities.routes[0]).toEqual({ id: 'partner-route', name: 'ekyc-partner-v1', service: { id: 'partner' }, paths: ['/partner/v1'] });
  expect(entities.routes.slice(1).every(row => row.strip_path === false)).toBe(true);
});

test('conflicting platform service names do not replace another upstream', async () => {
  const client = { request: async path => ({ data: path.startsWith('/services') ? [{ name: 'ekyc-master-api', host: 'other', port: 443 }] : [] }) };
  await expect(ensurePlatformRoutes(client)).rejects.toThrow('PLATFORM_SERVICE_CONFLICT');
});
