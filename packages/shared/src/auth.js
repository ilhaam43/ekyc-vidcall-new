import jwt from 'jsonwebtoken';
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { assert } from './errors.js';
export const hash = input => createHash('sha256').update(input).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');
export function equal(a, b) { const x = Buffer.from(a || ''); const y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); }
export function issueToken(cfg, claims, expiresIn = '10m') { return jwt.sign(claims, cfg.jwtSecret, { algorithm: 'HS256', issuer: 'ekyc', audience: 'ekyc-app', expiresIn }); }
export async function authenticate(token, cfg, db) {
  let claims;
  try { claims = jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'], issuer: 'ekyc', audience: 'ekyc-app' }); } catch { assert(false, 401, 'UNAUTHORIZED'); }
  const session = await db('platform_sessions').where({ id: claims.sid, tenant_id: claims.tenant_id, subject_id: claims.sub, role: claims.role }).whereNull('revoked_at').where('expires_at', '>', new Date()).first();
  assert(session, 401, 'SESSION_EXPIRED');
  assert((session.call_id || null) === (claims.call_id || null), 401, 'SESSION_EXPIRED');
  assert((session.source || 'basic') === (claims.source || 'basic'), 401, 'SESSION_EXPIRED');
  if (claims.role === 'agent') assert(await db('platform_agents').where({ id: claims.sub, tenant_id: claims.tenant_id, active: true }).first(), 401, 'AGENT_INACTIVE');
  return claims;
}
export const auth = (cfg, db, roles = ['agent', 'customer']) => async (req, _res, next) => {
  req.auth = await authenticate(req.headers.authorization?.replace(/^Bearer /, ''), cfg, db);
  assert(roles.includes(req.auth.role), 403, 'FORBIDDEN'); next();
};
export const gateway = cfg => (req, _res, next) => {
  assert(equal(req.headers['x-gateway-secret'], cfg.gatewaySecret), 401, 'UNTRUSTED_GATEWAY');
  assert(typeof req.headers['x-application-id'] === 'string' && /^[a-f0-9-]{36}$/i.test(req.headers['x-application-id']), 400, 'TENANT_REQUIRED');
  req.auth = { role: 'partner', tenant_id: req.headers['x-application-id'] }; next();
};
export const internal = cfg => (req, _res, next) => { assert(equal(req.headers['x-internal-secret'], cfg.internalSecret), 401, 'UNTRUSTED_SERVICE'); next(); };
export function signature(secret, timestamp, raw) { return createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex'); }
export const signedRecording = cfg => (req, _res, next) => {
  const timestamp = req.headers['x-event-timestamp'];
  assert(timestamp && Math.abs(Date.now() - Number(timestamp)) < 300000, 401, 'STALE_EVENT');
  assert(equal(signature(cfg.recordingSecret, timestamp, req.rawBody || Buffer.alloc(0)), req.headers['x-event-signature']), 401, 'INVALID_SIGNATURE'); next();
};
