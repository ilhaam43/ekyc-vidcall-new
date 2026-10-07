import { KongError } from './kong-client.js';

export const resourceNames = ['services', 'routes', 'consumers', 'plugins', 'upstreams', 'certificates', 'ca_certificates', 'snis'];
const fields = {
  services: ['name', 'protocol', 'host', 'port', 'path', 'retries', 'connect_timeout', 'write_timeout', 'read_timeout', 'tags'],
  routes: ['name', 'service', 'paths', 'hosts', 'methods', 'protocols', 'strip_path', 'preserve_host', 'tags'],
  consumers: ['username', 'custom_id', 'tags'],
  plugins: ['name', 'enabled', 'service', 'route', 'consumer', 'config', 'tags'],
  upstreams: ['name', 'algorithm', 'hash_on', 'slots', 'tags'],
  certificates: ['cert', 'key', 'tags'],
  ca_certificates: ['cert', 'tags'],
  snis: ['name', 'certificate', 'tags'],
};
const pick = (row, names) => Object.fromEntries(names.filter(name => row[name] !== undefined && row[name] !== null).map(name => [name, row[name]]));
const clean = (row, name) => pick(row, fields[name]);
const enc = value => encodeURIComponent(value);

export async function all(client, endpoint, max = 10000) {
  let result = [], offset = null, pages = 0;
  do {
    const params = new URLSearchParams({ size: '100' });
    if (offset) params.set('offset', offset);
    const page = await client.request(`${endpoint}?${params}`);
    result = result.concat(page.data || []);
    offset = page.offset || null;
    if (++pages > 100 || result.length > max) throw new KongError(413, 'RESOURCE_LIMIT_EXCEEDED');
  } while (offset);
  return result;
}

export async function capture(client) {
  const data = Object.fromEntries(await Promise.all(resourceNames.map(async name => [name, await all(client, `/${name}`)])));
  data.credentials = {};
  for (const consumer of data.consumers) {
    const record = {};
    for (const kind of ['key-auth', 'acls', 'basic-auth', 'jwt', 'hmac-auth']) {
      try { record[kind] = await all(client, `/consumers/${enc(consumer.id)}/${kind}`); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    data.credentials[consumer.id] = record;
  }
  data.targets = {};
  for (const upstream of data.upstreams) data.targets[upstream.id] = await all(client, `/upstreams/${enc(upstream.id)}/targets`);
  return data;
}

export function snapshotCounts(data) {
  return Object.fromEntries(resourceNames.map(name => [name, data[name]?.length || 0]));
}

export async function restorePreview(client, data) {
  const current = Object.fromEntries(await Promise.all(resourceNames.map(async name => [name, await all(client, `/${name}`)])));
  const occupied = Object.fromEntries(Object.entries(current).filter(([, rows]) => rows.length).map(([name, rows]) => [name, rows.length]));
  const warnings = [];
  for (const types of Object.values(data.credentials || {})) {
    if (types['basic-auth']?.length) warnings.push('BASIC_AUTH_PASSWORD_HASH_NOT_RESTORABLE');
    if (types['key-auth']?.some(row => !row.key)) warnings.push('KEY_AUTH_SECRET_MISSING');
    if (types['hmac-auth']?.some(row => !row.secret)) warnings.push('HMAC_SECRET_MISSING');
  }
  if (data.certificates?.some(row => !row.cert || !row.key)) warnings.push('CERTIFICATE_KEY_MISSING');
  return { ready: !Object.keys(occupied).length && !warnings.length, occupied, warnings: [...new Set(warnings)], counts: snapshotCounts(data) };
}

export async function restoreToEmptyNode(client, data) {
  const preview = await restorePreview(client, data);
  if (preview.warnings.length) throw new KongError(422, 'SNAPSHOT_HAS_UNRESTORABLE_SECRETS');
  if (!preview.ready) throw new KongError(409, 'TARGET_NODE_NOT_EMPTY');
  const map = new Map(), counts = {}, createdObjects = [];
  const mapped = ref => ref?.id ? { id: map.get(ref.id) || ref.id } : undefined;
  const create = async (name, original, extra = {}) => {
    const body = { ...clean(original, name), ...extra };
    const created = await client.request(`/${name}`, { method: 'POST', body });
    createdObjects.push({ name, id: created.id });
    map.set(original.id, created.id); counts[name] = (counts[name] || 0) + 1;
  };
  try {
    for (const name of ['upstreams', 'services', 'consumers', 'certificates', 'ca_certificates']) {
      for (const row of data[name] || []) await create(name, row);
    }
    for (const row of data.snis || []) await create('snis', row, { certificate: mapped(row.certificate) });
    for (const row of data.routes || []) await create('routes', row, { service: mapped(row.service) });
    for (const row of data.plugins || []) await create('plugins', row, { service: mapped(row.service), route: mapped(row.route), consumer: mapped(row.consumer) });
    for (const [oldId, types] of Object.entries(data.credentials || {})) {
      const consumerId = map.get(oldId); if (!consumerId) continue;
      for (const [kind, rows] of Object.entries(types)) {
        const allowed = { 'key-auth': ['key', 'ttl', 'tags'], acls: ['group', 'tags'], 'basic-auth': ['username', 'password', 'tags'], jwt: ['key', 'secret', 'algorithm', 'rsa_public_key', 'tags'], 'hmac-auth': ['username', 'secret', 'tags'] }[kind];
        if (!allowed) continue;
        for (const row of rows) { await client.request(`/consumers/${enc(consumerId)}/${kind}`, { method: 'POST', body: pick(row, allowed) }); counts[kind] = (counts[kind] || 0) + 1; }
      }
    }
    for (const [oldId, targets] of Object.entries(data.targets || {})) {
      const upstreamId = map.get(oldId); if (!upstreamId) continue;
      for (const row of targets) { await client.request(`/upstreams/${enc(upstreamId)}/targets`, { method: 'POST', body: pick(row, ['target', 'weight', 'tags']) }); counts.targets = (counts.targets || 0) + 1; }
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const item of createdObjects.reverse()) {
      try { await client.request(`/${item.name}/${enc(item.id)}`, { method: 'DELETE' }); }
      catch { rollbackFailed = true; }
    }
    throw new KongError(rollbackFailed ? 500 : 422, rollbackFailed ? 'RESTORE_ROLLBACK_INCOMPLETE' : `RESTORE_FAILED:${error.code || 'KONG_ERROR'}`);
  }
  return counts;
}

export function validateConsumerImport(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) throw new KongError(422, 'INVALID_IMPORT_SIZE');
  const seen = new Set();
  return rows.map((row, index) => {
    const username = String(row.username || '').trim(), custom_id = String(row.custom_id || '').trim();
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(username) || username.startsWith('ekyc-application-') || seen.has(username)) throw new KongError(422, `INVALID_IMPORT_ROW_${index + 1}`);
    seen.add(username);
    const tags = Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',').map(item => item.trim()).filter(Boolean);
    return { username, ...(custom_id ? { custom_id } : {}), ...(tags.length ? { tags } : {}) };
  });
}

export async function importConsumers(client, rows) {
  const valid = validateConsumerImport(rows), existing = new Set((await all(client, '/consumers')).map(row => row.username));
  const result = { created: [], skipped: [] };
  for (const row of valid) {
    if (existing.has(row.username)) { result.skipped.push(row.username); continue; }
    const created = await client.request('/consumers', { method: 'POST', body: row });
    result.created.push({ id: created.id, username: created.username });
  }
  return result;
}
