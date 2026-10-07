import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';

const SESSION_SECONDS = 3600;
const DUMMY_HASH = '$2b$12$gWojKD.cLDZEpzBFvgJLKuVNGEQFnYaDTp5U2w1wjYBu5y/HGBHa2';
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
export const loginLimiter = rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });
export const fail = (status, code) => Object.assign(new Error(code), { status, code });
export function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookie(req, name) {
  return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function cookieOptions(cfg) { return { httpOnly: true, sameSite: 'strict', secure: cfg.production, path: '/', maxAge: SESSION_SECONDS * 1000 }; }
export function authRoutes(app, db, redis, cfg, adapters) {
  const prefix = '/dashboard/api/v1';
  app.post(`${prefix}/login`, loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 200) throw fail(401, 'INVALID_CREDENTIALS');
    let account = await db('dashboard_accounts').where({ username, active: true }).first();
    let kind = 'account';
    if (!account) { account = await db('dashboard_officers').where({ username, active: true }).first(); kind = 'officer'; }
    const valid = await bcrypt.compare(password, account?.password_hash || DUMMY_HASH);
    if (!account || !valid) throw fail(401, 'INVALID_CREDENTIALS');
    const sid = token(); const csrf = token();
    await redis.set(`dashboard:sess:${digest(sid)}`, JSON.stringify({ id: account.id, kind, csrf, credential: digest(account.password_hash) }), { EX: SESSION_SECONDS });
    res.cookie('dashboard_sid', sid, cookieOptions(cfg)).set('cache-control', 'no-store').json({ success: true, data: { role: kind === 'officer' ? 'officer' : account.role, csrf } });
  });
  app.use(prefix, async (req, _res, next) => {
    try {
      if (req.path === '/login' || req.path.startsWith('/password/reset/')) return next();
      const sid = cookie(req, 'dashboard_sid');
      if (!sid || sid.length > 100) throw fail(401, 'AUTH_REQUIRED');
      const key = `dashboard:sess:${digest(sid)}`;
      const raw = await redis.get(key); if (!raw) throw fail(401, 'SESSION_EXPIRED');
      const session = JSON.parse(raw);
      const table = session.kind === 'officer' ? 'dashboard_officers' : 'dashboard_accounts';
      const actor = await db(table).where({ id: session.id, active: true }).first();
      if (!actor || session.credential !== digest(actor.password_hash)) { await redis.del(key); throw fail(401, 'SESSION_EXPIRED'); }
      req.dashboard = { id: actor.id, role: session.kind === 'officer' ? 'officer' : actor.role, bank_id: actor.bank_id || null, csrf: session.csrf, key };
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (!secureEqual(req.headers['x-csrf-token'], session.csrf)) throw fail(403, 'CSRF_INVALID');
        const origin = req.headers.origin;
        if (origin && origin !== cfg.origin) throw fail(403, 'INVALID_ORIGIN');
      }
      await redis.expire(key, SESSION_SECONDS); next();
    } catch (error) { next(error); }
  });
  app.get(`${prefix}/session`, (req, res) => res.set('cache-control', 'no-store').json({ success: true, data: { id: req.dashboard.id, role: req.dashboard.role, bank_id: req.dashboard.bank_id, csrf: req.dashboard.csrf } }));
  app.post(`${prefix}/logout`, async (req, res) => { await redis.del(req.dashboard.key); res.clearCookie('dashboard_sid', { path: '/' }).json({ success: true }); });
  app.post(`${prefix}/profile/password`, async (req, res) => {
    const { current_password: current, new_password: next } = req.body || {};
    if (typeof next !== 'string' || next.length < 12 || next.length > 72) throw fail(422, 'PASSWORD_POLICY');
    const table = req.dashboard.role === 'officer' ? 'dashboard_officers' : 'dashboard_accounts';
    const actor = await db(table).where({ id: req.dashboard.id }).first();
    if (!await bcrypt.compare(current || '', actor.password_hash)) throw fail(401, 'INVALID_CREDENTIALS');
    await db(table).where({ id: actor.id }).update({ password_hash: await bcrypt.hash(next, 12), updated_at: new Date() });
    await redis.del(req.dashboard.key); res.clearCookie('dashboard_sid', { path: '/' }).json({ success: true });
  });
  app.post(`${prefix}/password/reset/request`, loginLimiter, async (req, res) => {
    const email = String(req.body?.email || '').slice(0, 254);
    const actor = await db('dashboard_accounts').where({ email, active: true }).first();
    if (actor) {
      const reset = token();
      await db('dashboard_accounts').where({ id: actor.id }).update({ reset_hash: digest(reset), reset_expires_at: new Date(Date.now() + 3600_000) });
      await adapters.email.sendReset({ to: email, url: `${cfg.origin}/reset-password?token=${reset}&email=${encodeURIComponent(email)}` });
    }
    res.json({ success: true, data: { accepted: true, delivery: cfg.mockExternal ? 'mock' : 'email' } });
  });
  app.post(`${prefix}/password/reset/confirm`, loginLimiter, async (req, res) => {
    const { email, token: reset, password } = req.body || {};
    if (typeof password !== 'string' || password.length < 12 || password.length > 72) throw fail(422, 'PASSWORD_POLICY');
    const actor = await db('dashboard_accounts').where({ email }).where('reset_expires_at', '>', new Date()).first();
    if (!actor || !secureEqual(digest(String(reset || '')), actor.reset_hash)) throw fail(400, 'RESET_INVALID');
    await db('dashboard_accounts').where({ id: actor.id, reset_hash: actor.reset_hash }).update({ password_hash: await bcrypt.hash(password, 12), reset_hash: null, reset_expires_at: null, updated_at: new Date() });
    res.json({ success: true, data: { changed: true } });
  });
}
export function requireRole(actor, ...roles) { if (!roles.includes(actor.role)) throw fail(403, 'FORBIDDEN'); }
export function bankScope(actor, bankId) { if (actor.role !== 'superadmin' && actor.role !== 'admin' && actor.bank_id !== bankId) throw fail(403, 'CROSS_BANK_ACCESS'); }
export async function audit(db, actor, action, metadata = {}, bankId = actor.bank_id) {
  await db('dashboard_audit').insert({ actor_id: actor.id, bank_id: bankId || null, action, metadata });
}
