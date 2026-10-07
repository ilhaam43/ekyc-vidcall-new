import { randomUUID, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import multer from 'multer';
import { baseApp, finishApp, loginLimiter } from '@ekyc/shared/http';
import { auth, gateway, internal, hash } from '@ekyc/shared/auth';
import { body } from '@ekyc/shared/contracts';
import { assert } from '@ekyc/shared/errors';
import { audit } from '@ekyc/shared/outbox';
import { Encryption } from '@ekyc/shared/encryption';
import { Customers } from './customers.js';
import { Providers, legacyProviderRoutes } from './providers.js';
export function createApp(db, cfg, storage, providers = new Providers()) {
  const app = baseApp(cfg, db); const encryption = new Encryption(cfg); const customers = new Customers(db, encryption);
  const member = auth(cfg, db); const partner = gateway(cfg);
  const actor = (req, res, next) => req.headers.authorization ? member(req, res, next) : partner(req, res, next);
  const send = (res, data) => res.json({ success: true, data });
  const root = '/api/v1';
  app.post('/internal/verifications', internal(cfg), async (req, res) => {
    const { call_id, tenant_id, user_id, outcome } = req.body; send(res, await customers.applyDecision({ call_id, tenant_id, user_id, outcome }));
  });
  app.use(root, actor);
  app.get(`${root}/users`, async (req, res) => {
    assert(req.auth.role !== 'customer', 403, 'FORBIDDEN');
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20)); const page = Math.max(0, Number(req.query.page) || 0);
    const query = db('platform_customers').where({ tenant_id: req.auth.tenant_id }).whereNull('deleted_at');
    const total = await query.clone().count('* as count').first(); const rows = await query.select('id').orderBy('created_at', 'desc').limit(size).offset(page * size);
    send(res, { results: await Promise.all(rows.map(row => customers.get(req.auth, row.id))), total: Number(total.count) });
  });
  app.get(`${root}/users/:id`, async (req, res) => send(res, await customers.get(req.auth, req.params.id)));
  app.post(`${root}/users`, body('customer'), async (req, res) => send(res, await customers.create(req.auth, req.body)));
  app.put(`${root}/users/:id`, body('customer'), async (req, res) => send(res, await customers.update(req.auth, req.params.id, req.body)));
  app.post(`${root}/users/:id`, body('customer'), async (req, res) => send(res, await customers.update(req.auth, req.params.id, req.body)));
  app.post(`${root}/users/softdelete/:id`, async (req, res) => { await customers.remove(req.auth, req.params.id); send(res, null); });
  app.delete(`${root}/users/:id`, (_req, res) => res.status(409).json({ success: false, error: { code: 'RETENTION_POLICY_REQUIRED', message: 'Use soft deletion. Permanent deletion requires an audited retention policy.' } }));
  for (const action of ['verify', 'reject']) app.put(`${root}/users/:id/${action}`, (_req, res) => res.status(409).json({ success: false, error: { code: 'USE_RECORDED_CALL_DECISION' } }));
  app.put(`${root}/users/:id/face-verification`, async (req, res) => { assert(req.auth.role === 'partner', 403, 'PARTNER_REQUIRED'); const { score, epsilon } = req.body; assert([score, epsilon].every(x => typeof x === 'number' && x >= 0 && x <= 1), 422, 'INVALID_FACE_SCORE'); send(res, await customers.update(req.auth, req.params.id, { face_verification_score: score, face_verification_epsilon: epsilon })); });
  app.post(`${root}/actors`, async (req, res) => { assert(req.auth.role === 'partner', 403, 'PARTNER_REQUIRED'); const [row] = await db('platform_actors').insert({ id: randomUUID(), tenant_id: req.auth.tenant_id }).returning('*'); send(res, row); });
  app.get(`${root}/actors/:id/apikey`, (_req, res) => res.status(410).json({ success: false, error: { code: 'USE_SCOPED_CUSTOMER_GRANTS' } }));
  app.get(`${root}/options/:category`, async (req, res) => send(res, (await db('platform_reference').where({ category: req.params.category })).map(row => ({ id: row.id, ...row.data }))));
  app.get(`${root}/postal/search`, async (req, res) => send(res, (await db('platform_reference').where({ category: 'postal' }).whereRaw('data::text ILIKE ?', [`%${String(req.query.q || '').slice(0, 100)}%`]).limit(20)).map(row => ({ id: row.id, ...row.data }))));
  app.get(`${root}/postal/:id`, async (req, res) => { const row = await db('platform_reference').where({ category: 'postal', id: req.params.id }).first(); assert(row, 404, 'POSTAL_NOT_FOUND'); send(res, { id: row.id, ...row.data }); });
  app.get(`${root}/skip-otp`, (_req, res) => res.json({ skip_otp: 0 }));
  app.post(`${root}/quota/videocalls`, async (req, res) => { const row = await db('platform_quotas').where({ tenant_id: req.auth.tenant_id, service: 'videocalls.post' }).first(); send(res, { quotaRemaining: row?.remaining || 0 }); });
  app.post(`${root}/videocalls`, (_req, res) => res.status(409).json({ success: false, error: { code: 'USE_CALL_REGISTER', message: 'Register with /v1/calls/register and an Idempotency-Key.' } }));
  app.post(`${root}/audit-trail`, async (req, res) => { assert(req.auth.role === 'partner', 403, 'PARTNER_REQUIRED'); assert(typeof req.body.action === 'string' && req.body.action.length <= 100, 422, 'ACTION_REQUIRED'); await audit(db, req.auth.tenant_id, null, null, `partner.${req.body.action}`); send(res, null); });
  app.get(`${root}/audit-trail`, async (req, res) => { assert(req.auth.role !== 'customer', 403, 'FORBIDDEN'); send(res, await db('platform_audit').where({ tenant_id: req.auth.tenant_id }).orderBy('id', 'desc').limit(100)); });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 } });
  app.post(`${root}/document`, upload.single('file'), async (req, res) => {
    assert(req.auth.role !== 'customer', 403, 'FORBIDDEN'); await customers.row(req.auth, req.body.user_id);
    assert(req.file && typeof req.body.type === 'string' && /^[a-z0-9_-]{1,40}$/i.test(req.body.type), 422, 'INVALID_DOCUMENT');
    const bytes = req.file.buffer; const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255; const pdf = bytes.subarray(0, 5).toString() === '%PDF-';
    assert(png || jpeg || pdf, 422, 'UNSUPPORTED_DOCUMENT'); const mimetype = png ? 'image/png' : jpeg ? 'image/jpeg' : 'application/pdf';
    const id = randomUUID(); const key = `${req.auth.tenant_id}/${req.body.user_id}/${id}`;
    await storage.put(cfg.documentBucket, key, bytes, mimetype, { sha256: hash(bytes) });
    try { const [doc] = await db('platform_documents').insert({ id, tenant_id: req.auth.tenant_id, user_id: req.body.user_id, type: req.body.type, object_key: key, bucket: cfg.documentBucket, mimetype, bytes: bytes.length, sha256: hash(bytes) }).returning('*'); send(res, { id: doc.id, type: doc.type, mimetype: doc.mimetype, path: doc.id }); } catch (e) { await storage.delete(cfg.documentBucket, key); throw e; }
  });
  app.get(`${root}/document/:userId`, async (req, res) => { await customers.row(req.auth, req.params.userId); send(res, (await db('platform_documents').where({ tenant_id: req.auth.tenant_id, user_id: req.params.userId })).map(doc => ({ id: doc.id, type: doc.type, mimetype: doc.mimetype, path: doc.id }))); });
  app.get(`${root}/document/:userId/:id`, async (req, res) => {
    await customers.row(req.auth, req.params.userId); const doc = await db('platform_documents').where({ id: req.params.id, user_id: req.params.userId, tenant_id: req.auth.tenant_id }).first(); assert(doc, 404, 'DOCUMENT_NOT_FOUND');
    const object = await storage.get(doc.bucket, doc.object_key); res.type(doc.mimetype).set({ 'cache-control': 'private, no-store', 'content-disposition': `inline; filename="${doc.id}"` }); await pipeline(object.Body, res);
  });
  app.post(`${root}/otp/send`, loginLimiter(), async (req, res) => {
    await customers.row(req.auth, req.body.user_id); const phone = String(req.body.phone_number || '').replace(/^0/, req.body.country_code || '+62'); assert(/^\+?[1-9][0-9]{7,14}$/.test(phone), 422, 'INVALID_PHONE');
    const data = await providers.execute(req.auth.tenant_id, 'infobip', 'send', { phone_number: phone }, req.headers['idempotency-key']); assert(typeof data.pinId === 'string', 502, 'INVALID_PROVIDER_RESPONSE');
    await db('platform_otps').insert({ id: data.pinId, tenant_id: req.auth.tenant_id, user_id: req.body.user_id, phone_hash: hash(phone), expires_at: new Date(Date.now() + 300000) }); send(res, { pin_id: data.pinId });
  });
  app.post(`${root}/otp/verify`, loginLimiter(), async (req, res) => {
    await customers.row(req.auth, req.body.user_id); const otp = await db('platform_otps').where({ id: req.body.pin_id, tenant_id: req.auth.tenant_id, user_id: req.body.user_id }).where('expires_at', '>', new Date()).whereNull('verified_at').first(); assert(otp, 422, 'OTP_EXPIRED');
    const data = await providers.execute(req.auth.tenant_id, 'infobip', 'verify', { pin_id: req.body.pin_id, pin: req.body.pin }); assert(data.verified === true && hash(data.msisdn) === otp.phone_hash, 422, 'OTP_INVALID');
    await db('platform_otps').where({ id: otp.id }).update({ verified_at: new Date() });
    await customers.update({ ...req.auth, role: 'partner' }, otp.user_id, { phone_number: data.msisdn, phone_verified: true }); send(res, { verified: true });
  });
  app.post(`${root}/otp/resend`, loginLimiter(), async (req, res) => { const otp = await db('platform_otps').where({ id: req.body.pin_id, tenant_id: req.auth.tenant_id }).where('expires_at', '>', new Date()).whereNull('verified_at').first(); assert(otp, 422, 'OTP_EXPIRED'); await customers.row(req.auth, otp.user_id); send(res, await providers.execute(req.auth.tenant_id, 'infobip', 'resend', { pin_id: otp.id })); });
  app.post(`${root}/secure-transactions`, async (req, res) => {
    assert(req.auth.role === 'partner', 403, 'PARTNER_REQUIRED'); const tenant = await customers.tenant(req.auth.tenant_id); const material = { key: randomBytes(32).toString('base64'), iv: randomBytes(16).toString('base64') };
    const keys = await encryption.keys(tenant); const encrypted = await encryption.request('encrypt', { key: keys.encryption_key, IV: keys.iv, data: material });
    const id = randomUUID(); const expires_at = new Date(Date.now() + 86400000); await db('platform_secure_transactions').insert({ id, tenant_id: tenant.id, encrypted_material: encrypted, expires_at }); res.set('cache-control', 'no-store'); send(res, { id, ...material, expired_at: expires_at });
  });
  for (const [method, path, provider, operation] of legacyProviderRoutes) app[method](`${root}${path}`, async (req, res) => { assert(req.auth.role === 'partner', 403, 'PARTNER_REQUIRED'); send(res, await providers.execute(req.auth.tenant_id, provider, operation, { ...req.query, ...req.body, ...req.params }, req.headers['idempotency-key'])); });
  app.post(`${root}/callback`, async (req, res) => {
    assert(req.auth.role === 'partner', 403, 'PARTNER_REQUIRED'); const rows = Array.isArray(req.body) ? req.body : [req.body]; assert(rows.length <= 100, 422, 'BATCH_TOO_LARGE');
    await db.transaction(async trx => { for (const data of rows) { assert(typeof data.submissionId === 'string' && typeof data.status === 'string', 422, 'INVALID_CALLBACK'); await trx('platform_callbacks').insert({ id: randomUUID(), tenant_id: req.auth.tenant_id, provider: 'onekyc', submission_id: data.submissionId, event_hash: hash(JSON.stringify(data)), data }).onConflict(['tenant_id', 'provider', 'event_hash']).ignore(); } }); send(res, { accepted: rows.length });
  });
  app.get(`${root}/callback`, async (req, res) => { assert(req.auth.role === 'partner', 403, 'PARTNER_REQUIRED'); send(res, (await db('platform_callbacks').where({ tenant_id: req.auth.tenant_id }).orderBy('created_at', 'desc').limit(100)).map(x => x.data)); });
  app.locals.customers = customers;
  return finishApp(app);
}
