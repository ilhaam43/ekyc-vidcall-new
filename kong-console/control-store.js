import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { KongError } from './kong-client.js';

const prefix = 'kong-console:v2';
const hash = value => createHash('sha256').update(value).digest('hex');
const key = createHash('sha256').update(process.env.KONG_CONSOLE_DATA_KEY || process.env.KONG_CONSOLE_PASSWORD || '').digest();
const encrypt = value => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
};
const decrypt = value => {
  const raw = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
};
const nodeKey = `${prefix}:nodes`;
const userKey = `${prefix}:users`;
const snapshotsKey = `${prefix}:snapshots`;
const notificationKey = `${prefix}:notification`;
const counts = data => Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, Array.isArray(rows) ? rows.length : Object.values(rows).reduce((total, item) => total + (Array.isArray(item) ? item.length : Object.values(item).reduce((sum, nested) => sum + nested.length, 0)), 0)]));

export function validateNode(input) {
  const name = String(input?.name || '').trim(), address = String(input?.url || '').trim();
  if (!name || name.length > 80) throw new KongError(422, 'INVALID_NODE_NAME');
  let url; try { url = new URL(address); } catch { throw new KongError(422, 'INVALID_NODE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new KongError(422, 'INVALID_NODE_URL');
  if (url.protocol !== 'https:') throw new KongError(422, 'HTTPS_REQUIRED_FOR_REMOTE_NODE');
  const allowed = String(process.env.KONG_CONSOLE_ALLOWED_NODE_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!allowed.includes(url.origin)) throw new KongError(422, 'NODE_ORIGIN_NOT_ALLOWED');
  const tokenHeader = String(input?.tokenHeader || 'Kong-Admin-Token');
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(tokenHeader)) throw new KongError(422, 'INVALID_TOKEN_HEADER');
  return { name, url: url.origin, token: String(input?.token || ''), tokenHeader };
}
export function createControlStore(redis, defaultNode) {
  const publicNode = node => ({ id: node.id, name: node.name, url: node.url, managed: node.id === 'local' });
  return {
    async nodes() {
      const saved = await redis.hGetAll(nodeKey);
      return [publicNode({ ...defaultNode, id: 'local' }), ...Object.entries(saved).map(([id, sealed]) => publicNode({ ...decrypt(sealed), id }))];
    },
    async node(id = 'local') {
      if (id === 'local') return { ...defaultNode, id };
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new KongError(404, 'NODE_NOT_FOUND');
      const sealed = await redis.hGet(nodeKey, id);
      if (!sealed) throw new KongError(404, 'NODE_NOT_FOUND');
      return { ...validateNode(decrypt(sealed)), id };
    },
    async addNode(input) {
      const node = { ...validateNode(input), id: randomUUID() };
      await redis.hSet(nodeKey, node.id, encrypt(node));
      return publicNode(node);
    },
    async removeNode(id) {
      if (id === 'local') throw new KongError(409, 'DEFAULT_NODE');
      if (!await redis.hDel(nodeKey, id)) throw new KongError(404, 'NODE_NOT_FOUND');
      return { deleted: true };
    },
    async users() {
      return Object.entries(await redis.hGetAll(userKey)).map(([username, raw]) => { const user = JSON.parse(raw); return { username, role: user.role, active: user.active }; });
    },
    async user(username) { const raw = await redis.hGet(userKey, username); return raw ? JSON.parse(raw) : null; },
    async addUser(input) {
      const username = String(input?.username || '').trim();
      if (!/^[A-Za-z0-9._-]{3,64}$/.test(username) || username === process.env.KONG_CONSOLE_USERNAME) throw new KongError(422, 'INVALID_USERNAME');
      if (await redis.hExists(userKey, username)) throw new KongError(409, 'USER_EXISTS');
      const password = String(input?.password || '');
      if (password.length < 16) throw new KongError(422, 'WEAK_PASSWORD');
      const role = input?.role === 'viewer' ? 'viewer' : 'admin', salt = randomBytes(16).toString('base64url');
      await redis.hSet(userKey, username, JSON.stringify({ role, active: true, version: 1, salt, passwordHash: scryptSync(password, salt, 64).toString('base64url') }));
      return { username, role, active: true };
    },
    async password(username, password) {
      const user = await this.user(username); if (!user || !user.active) return null;
      const candidate = scryptSync(String(password), user.salt, 64), expected = Buffer.from(user.passwordHash, 'base64url');
      return candidate.length === expected.length && timingSafeEqual(candidate, expected) ? { username, role: user.role, version: user.version } : null;
    },
    async removeUser(username) {
      if (!await redis.hDel(userKey, username)) throw new KongError(404, 'USER_NOT_FOUND');
      return { deleted: true };
    },
    async setUserActive(username, active) {
      const user = await this.user(username); if (!user) throw new KongError(404, 'USER_NOT_FOUND');
      await redis.hSet(userKey, username, JSON.stringify({ ...user, active: Boolean(active), version: (user.version || 0) + 1 }));
      return { username, role: user.role, active: Boolean(active) };
    },
    async changePassword(username, previous, replacement) {
      if (!await this.password(username, previous)) throw new KongError(401, 'INVALID_CREDENTIALS');
      if (String(replacement || '').length < 16) throw new KongError(422, 'WEAK_PASSWORD');
      const user = await this.user(username), salt = randomBytes(16).toString('base64url');
      await redis.hSet(userKey, username, JSON.stringify({ ...user, version: (user.version || 0) + 1, salt, passwordHash: scryptSync(replacement, salt, 64).toString('base64url') }));
      return { changed: true };
    },
    async saveSnapshot(nodeId, data) {
      const snapshot = { id: randomUUID(), nodeId, createdAt: new Date().toISOString(), sha256: hash(JSON.stringify(data)), data };
      await redis.hSet(snapshotsKey, snapshot.id, encrypt(snapshot));
      return { id: snapshot.id, nodeId, createdAt: snapshot.createdAt, sha256: snapshot.sha256, counts: counts(data) };
    },
    async snapshots() {
      return Object.values(await redis.hGetAll(snapshotsKey)).map(sealed => { const { data, ...meta } = decrypt(sealed); return { ...meta, counts: counts(data) }; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async snapshot(id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new KongError(404, 'SNAPSHOT_NOT_FOUND');
      const sealed = await redis.hGet(snapshotsKey, id); if (!sealed) throw new KongError(404, 'SNAPSHOT_NOT_FOUND');
      return decrypt(sealed);
    },
    async removeSnapshot(id) { if (!await redis.hDel(snapshotsKey, id)) throw new KongError(404, 'SNAPSHOT_NOT_FOUND'); return { deleted: true }; },
    async notification() { const sealed = await redis.get(notificationKey); return sealed ? decrypt(sealed) : { webhookEnabled: false, webhookUrl: '', emailEnabled: false, emailTo: '' }; },
    async saveNotification(input) {
      const webhookEnabled = Boolean(input?.webhookEnabled), webhookUrl = String(input?.webhookUrl || (await this.notification()).webhookUrl || '').trim();
      const emailEnabled = Boolean(input?.emailEnabled), emailTo = String(input?.emailTo || '').trim();
      const allowed = String(process.env.KONG_CONSOLE_ALLOWED_WEBHOOK_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean);
      if (webhookEnabled) {
        let origin; try { origin = new URL(webhookUrl).origin; } catch { throw new KongError(422, 'INVALID_WEBHOOK_URL'); }
        const parsed = new URL(webhookUrl);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowed.includes(origin)) throw new KongError(422, 'WEBHOOK_ORIGIN_NOT_ALLOWED');
      }
      if (emailEnabled && (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(emailTo) || !process.env.KONG_CONSOLE_SMTP_URL || !process.env.KONG_CONSOLE_SMTP_FROM)) throw new KongError(422, 'EMAIL_NOT_CONFIGURED');
      const config = { webhookEnabled, webhookUrl, emailEnabled, emailTo };
      await redis.set(notificationKey, encrypt(config)); return config;
    },
  };
}
