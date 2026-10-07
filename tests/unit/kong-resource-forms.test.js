import { expect, test } from 'vitest';
import { credentialMetadata, mergeConfig, redactConfig } from '../../kong-console/resource-values.js';
import { editorFields, schemaPayload } from '../../kong-console/public/forms.js';

test('partial plugin and health-check updates preserve untouched nested values but clear explicit collections', () => {
  const current = { active: { timeout: 5, healthy: { interval: 20, successes: 3 }, headers: { Authorization: ['secret'] } }, redis: { password: 'secret', port: 6379 }, allow: ['old'] };
  expect(mergeConfig(current, { active: { healthy: { interval: 10 }, headers: {} }, redis: { port: 6380 }, allow: [] })).toEqual({ active: { timeout: 5, healthy: { interval: 10, successes: 3 }, headers: {} }, redis: { password: 'secret', port: 6380 }, allow: [] });
  expect(current.active.healthy.interval).toBe(20);
});

test('plugin and credential responses redact nested secrets and hashes', () => {
  expect(redactConfig({ key_names: ['apikey'], redis: { password: 'secret', port: 6379 }, secret: 'token', records: [{ private_key: 'private', name: 'public' }] })).toEqual({ key_names: ['apikey'], redis: { port: 6379 }, records: [{ name: 'public' }] });
  expect(credentialMetadata('basic-auth', { id: 'credential', username: 'operator', password: 'hashed' })).not.toHaveProperty('password');
  expect(credentialMetadata('key-auth', { id: 'credential', key: 'api-secret', ttl: 60 })).toMatchObject({ id: 'credential', ttl: 60 });
  expect(credentialMetadata('key-auth', { key: 'api-secret' }).key).toBeUndefined();
  expect(redactConfig({ hide_credentials: false, key_in_header: true, key_claim_name: 'iss', secret: 'hidden' })).toEqual({ hide_credentials: false, key_in_header: true, key_claim_name: 'iss' });
});

test('schema form payload supports cleared lists, nested numeric and boolean settings, and blank secret preservation', () => {
  const fields = [{ allow: { type: 'array', elements: { type: 'string' } } }, { redis: { type: 'record', fields: [{ password: { type: 'string' } }, { port: { type: 'integer' } }, { ssl: { type: 'boolean' } }] } }];
  const data = new FormData(); data.set('config.allow', ''); data.set('config.redis.password', ''); data.set('config.redis.port', '6380'); data.set('config.redis.ssl', 'false');
  expect(schemaPayload(fields, data, 'config', 'edit', { allow: ['old'] })).toEqual({ allow: [], redis: { port: 6380, ssl: false } });
  data.set('config.redis.port', '1.5'); expect(() => schemaPayload(fields, data, 'config')).toThrow('Invalid number');
});

test('route header and source forms parse without raw JSON and reject malformed values', () => {
  const fields = [{ headers: { type: 'map', keys: { type: 'string' }, values: { type: 'array', elements: { type: 'string' } } } }, { sources: { type: 'array', elements: { type: 'record', fields: [{ ip: { type: 'string' } }, { port: { type: 'integer' } }] } } }];
  const data = new FormData(); data.set('advanced.headers', 'X-Bank: lampung, pusat'); data.set('advanced.sources', '192.0.2.0/24, 443');
  expect(schemaPayload(fields, data, 'advanced')).toEqual({ headers: { 'X-Bank': ['lampung', 'pusat'] }, sources: [{ ip: '192.0.2.0/24', port: 443 }] });
  data.set('advanced.headers', 'invalid header'); expect(() => schemaPayload(fields, data, 'advanced')).toThrow('Header-Name');
  data.set('advanced.headers', '__proto__: bad'); expect(() => schemaPayload(fields, data, 'advanced')).toThrow('Invalid header');
});

test('editing credentials prepopulates identity and JWT algorithm while leaving secrets empty', () => {
  const basic = editorFields({ entity: 'basic-auth', mode: 'edit', value: { username: 'staff' } });
  expect(basic).toContain('value="staff"'); expect(basic).not.toMatch(/name="password"[^>]+required/);
  const jwt = editorFields({ entity: 'jwt', mode: 'edit', value: { algorithm: 'RS256', key: 'issuer' } });
  expect(jwt).toContain('value="RS256" selected'); expect(jwt).toContain('value="issuer"');
});
