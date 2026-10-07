import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import bcrypt from 'bcryptjs';
import { fail, requireRole, audit } from './auth.js';

const json = (res, data) => res.json({ success: true, data });
const limit = req => Math.min(100, Math.max(1, Number(req.query.limit) || 25));
const offset = req => Math.max(0, Number(req.query.page) || 0) * limit(req);
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function platformRoutes(app, db, cfg, storage, adapters, management) {
  const p = '/dashboard/api/v1';
  async function context(id, actor) {
    const application = await management.appRow(id, actor);
    const bank = await management.bank(application.bank_id);
    return { application, bank };
  }
  async function master(tenantId, path, { method = 'GET', body } = {}) {
    let response;
    try { response = await fetch(`${cfg.masterUrl}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-gateway-secret': cfg.gatewaySecret, 'x-application-id': tenantId }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000), redirect: 'error' }); }
    catch { throw fail(503, 'MASTER_UNAVAILABLE'); }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw fail(response.status >= 500 ? 503 : response.status, result?.error?.code || 'MASTER_REQUEST_FAILED');
    return result?.data;
  }
  async function kongApplication(req) {
    if (!cfg.mockExternal && !cfg.trustKongConsumerHeader) throw fail(503, 'KONG_CONSUMER_HEADER_TRUST_NOT_CONFIGURED');
    const consumerId = req.headers['x-consumer-id'];
    if (typeof consumerId !== 'string' || consumerId.length > 128) throw fail(401, 'KONG_CONSUMER_REQUIRED');
    const row = await db('dashboard_applications as a').join('dashboard_banks as b', 'a.bank_id', 'b.id').leftJoin('dashboard_plans as p', 'a.plan_id', 'p.id')
      .where({ 'a.kong_consumer_id': consumerId, 'a.status': 'confirmed', 'b.active': true }).select('a.*', 'b.tenant_id', 'b.name as bank_name', 'b.id as mapped_bank_id', 'p.features as plan_features').first();
    if (!row) throw fail(403, 'KONG_CONSUMER_NOT_MAPPED');
    if (req.headers['x-consumer-username'] && req.headers['x-consumer-username'] !== `ekyc-application-${row.id}` && !cfg.mockExternal) throw fail(403, 'KONG_CONSUMER_MISMATCH');
    return row;
  }
  app.post('/partner/v1/video-call/users', async (req, res) => {
    const application = await kongApplication(req);
    const planFeatures = Array.isArray(application.plan_features) ? application.plan_features : [];
    if (!planFeatures.includes('user') || !planFeatures.includes('agent')) throw fail(403, 'VIDEO_CALL_NOT_INCLUDED_IN_PLAN');
    const externalRequestId = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,96}$/.test(externalRequestId)) throw fail(422, 'IDEMPOTENCY_KEY_REQUIRED');
    const customer = req.body?.customer;
    if (!customer || typeof customer !== 'object' || Array.isArray(customer) || typeof customer.name !== 'string' || typeof customer.id_number !== 'string' || !customer.name.trim() || !customer.id_number.trim()) throw fail(422, 'NAME_AND_ID_NUMBER_REQUIRED');
    const payloadSha = createHash('sha256').update(stableJson(customer)).digest('hex');
    let reservation = await db('dashboard_video_call_requests').where({ application_id: application.id, external_request_id: externalRequestId }).first();
    if (!reservation) {
      const candidate = { application_id: application.id, external_request_id: externalRequestId, customer_id: randomUUID(), payload_sha256: payloadSha };
      await db('dashboard_video_call_requests').insert(candidate).onConflict(['application_id', 'external_request_id']).ignore();
      reservation = await db('dashboard_video_call_requests').where({ application_id: application.id, external_request_id: externalRequestId }).first();
    }
    if (reservation.payload_sha256 !== payloadSha) throw fail(409, 'IDEMPOTENCY_KEY_REUSED');
    let customerRecord;
    try { customerRecord = await master(application.tenant_id, `/users/${reservation.customer_id}`); }
    catch (error) {
      if (error.code !== 'CUSTOMER_NOT_FOUND') throw error;
      try { customerRecord = await master(application.tenant_id, '/users', { method: 'POST', body: { ...customer, id: reservation.customer_id } }); }
      catch (createError) {
        // Concurrent retries may both observe a missing customer and race to create it.
        try { customerRecord = await master(application.tenant_id, `/users/${reservation.customer_id}`); }
        catch { throw createError; }
      }
    }
    await db('dashboard_customer_applications').insert({ application_id: application.id, customer_id: reservation.customer_id }).onConflict(['application_id', 'customer_id']).ignore();
    const linkRequestId = `video-${createHash('sha256').update(`${application.id}:${externalRequestId}`).digest('hex').slice(0, 64)}`;
    let linkResponse;
    try {
      linkResponse = await fetch(`${cfg.callsUrl.replace(/\/$/, '')}/api/v2/customer-links`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-secret': cfg.gatewaySecret, 'x-application-id': application.tenant_id }, body: JSON.stringify({ user_id: reservation.customer_id, external_request_id: linkRequestId }), signal: AbortSignal.timeout(8000), redirect: 'error' });
    } catch { throw fail(503, 'CALLS_UNAVAILABLE'); }
    const linkResult = await linkResponse.json().catch(() => null);
    if (!linkResponse.ok) throw fail(linkResponse.status >= 500 ? 503 : linkResponse.status, linkResult?.error?.code || 'CALL_LINK_FAILED');
    await audit(db, { id: null, bank_id: application.mapped_bank_id }, 'partner.video_call_link_created', { application_id: application.id, customer_id: reservation.customer_id, external_request_id: externalRequestId }, application.mapped_bank_id);
    res.status(201).json({ success: true, data: { customer_id: customerRecord.id || reservation.customer_id, customer_url: linkResult.data.customer_url, expires_in: linkResult.data.expires_in, call_created_when_opened: true } });
  });
  app.get(`${p}/agents`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank');
    const { application, bank } = await context(req.query.application_id, req.dashboard);
    const rows = await db('platform_agents as a').join('dashboard_application_agents as x', 'a.id', 'x.agent_id').where({ 'x.application_id': application.id, 'a.tenant_id': bank.tenant_id }).select('a.id', 'a.username', 'a.name', 'a.active', 'a.created_at').orderBy('a.name'); json(res, rows);
  });
  app.post(`${p}/agents`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.body?.application_id, req.dashboard);
    const username = String(req.body?.username || '').trim(); const name = String(req.body?.name || '').trim(); const password = req.body?.password;
    if (!username || username.length > 100 || !name || name.length > 150 || typeof password !== 'string' || password.length < 12 || password.length > 72) throw fail(422, 'INVALID_AGENT');
    const id = randomUUID(); await db.transaction(async trx => { await trx('platform_agents').insert({ id, tenant_id: bank.tenant_id, username, name, password_hash: await bcrypt.hash(password, 12) }); await trx('dashboard_application_agents').insert({ application_id: application.id, agent_id: id }); await audit(trx, req.dashboard, 'agent.created', { id, application_id: application.id }, bank.id); }); json(res, { id, username, name, active: true });
  });
  app.patch(`${p}/agents/:id`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.body?.application_id, req.dashboard);
    const mapped = await db('dashboard_application_agents').where({ agent_id: req.params.id, application_id: application.id }).first(); if (!mapped) throw fail(404, 'AGENT_NOT_FOUND');
    const patch = { updated_at: new Date() }; if (req.body.name !== undefined) patch.name = String(req.body.name).trim().slice(0, 150); if (req.body.active !== undefined) patch.active = Boolean(req.body.active); if (req.body.password !== undefined) { if (typeof req.body.password !== 'string' || req.body.password.length < 12 || req.body.password.length > 72) throw fail(422, 'PASSWORD_POLICY'); patch.password_hash = await bcrypt.hash(req.body.password, 12); }
    await db('platform_agents').where({ id: req.params.id, tenant_id: bank.tenant_id }).update(patch); if (patch.password_hash || patch.active === false) await db('platform_sessions').where({ subject_id: req.params.id }).update({ revoked_at: new Date(), refresh_hash: null }); await audit(db, req.dashboard, 'agent.updated', { id: req.params.id }, bank.id); json(res, await db('platform_agents').select('id', 'username', 'name', 'active').where({ id: req.params.id }).first());
  });
  app.delete(`${p}/agents/:id`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.query.application_id, req.dashboard); if (!await db('dashboard_application_agents').where({ application_id: application.id, agent_id: req.params.id }).first()) throw fail(404, 'AGENT_NOT_FOUND'); await db('platform_agents').where({ id: req.params.id, tenant_id: bank.tenant_id }).update({ active: false, updated_at: new Date() }); await db('platform_sessions').where({ subject_id: req.params.id }).update({ revoked_at: new Date(), refresh_hash: null }); await audit(db, req.dashboard, 'agent.deactivated', { id: req.params.id }, bank.id); json(res, { active: false }); });
  app.get(`${p}/customers`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.query.application_id, req.dashboard);
    const ids = await db('dashboard_customer_applications').where({ application_id: application.id }).select('customer_id').limit(limit(req)).offset(offset(req));
    const data = await Promise.all(ids.map(row => master(bank.tenant_id, `/users/${encodeURIComponent(row.customer_id)}`)));
    json(res, data);
  });
  app.get(`${p}/customers/:id`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.query.application_id, req.dashboard); if (!await db('dashboard_customer_applications').where({ application_id: application.id, customer_id: req.params.id }).first()) throw fail(404, 'CUSTOMER_NOT_FOUND'); json(res, await master(bank.tenant_id, `/users/${encodeURIComponent(req.params.id)}`)); });
  app.delete(`${p}/customers/:id`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.query.application_id, req.dashboard); if (!await db('dashboard_customer_applications').where({ application_id: application.id, customer_id: req.params.id }).first()) throw fail(404, 'CUSTOMER_NOT_FOUND'); await master(bank.tenant_id, `/users/softdelete/${encodeURIComponent(req.params.id)}`, { method: 'POST' }); await audit(db, req.dashboard, 'customer.soft_deleted', { id: req.params.id }, bank.id); json(res, { deleted: true }); });
  app.get(`${p}/calls`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.query.application_id, req.dashboard);
    const rows = await db('platform_calls as c').join('dashboard_customer_applications as x', 'c.user_id', 'x.customer_id').where({ 'x.application_id': application.id, 'c.tenant_id': bank.tenant_id }).select('c.id', 'c.user_id', 'c.agent_id', 'c.state', 'c.outcome', 'c.reason', 'c.started_at', 'c.ended_at', 'c.created_at').orderBy('c.created_at', 'desc').limit(limit(req)).offset(offset(req)); json(res, rows);
  });
  app.get(`${p}/calls/:id`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.query.application_id, req.dashboard);
    const call = await db('platform_calls as c').join('dashboard_customer_applications as x', 'c.user_id', 'x.customer_id').where({ 'c.id': req.params.id, 'c.tenant_id': bank.tenant_id, 'x.application_id': application.id }).select('c.*').first(); if (!call) throw fail(404, 'CALL_NOT_FOUND');
    const recording = await db('platform_recordings').where({ call_id: call.id }).select('id', 'state', 'sha256', 'bytes', 'created_at').first(); json(res, { ...call, notification: undefined, registration_key: undefined, recording });
  });
  app.get(`${p}/customers/:id/documents`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.query.application_id, req.dashboard); if (!await db('dashboard_customer_applications').where({ application_id: application.id, customer_id: req.params.id }).first()) throw fail(404, 'CUSTOMER_NOT_FOUND'); json(res, await master(bank.tenant_id, `/document/${encodeURIComponent(req.params.id)}`)); });
  app.get(`${p}/documents/:id/download`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const { application, bank } = await context(req.query.application_id, req.dashboard);
    const doc = await db('platform_documents').where({ id: req.params.id, tenant_id: bank.tenant_id }).first(); if (!doc || !await db('dashboard_customer_applications').where({ application_id: application.id, customer_id: doc.user_id }).first()) throw fail(404, 'DOCUMENT_NOT_FOUND');
    const object = await storage.get(doc.bucket, doc.object_key); res.type(doc.mimetype).set({ 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="${doc.id}"` }); await pipeline(object.Body, res);
  });
  app.get(`${p}/quota`, async (req, res) => { const q = db('platform_quotas as q').join('dashboard_banks as b', 'q.tenant_id', 'b.tenant_id').select('q.service', 'q.remaining', 'b.id as bank_id', 'b.name as bank_name').orderBy('b.name'); if (req.dashboard.role === 'bank' || req.dashboard.role === 'officer') q.where('b.id', req.dashboard.bank_id); else if (req.query.bank_id) q.where('b.id', req.query.bank_id); json(res, await q); });
  app.get(`${p}/usage`, async (req, res) => { const { application } = await context(req.query.application_id, req.dashboard); if (!/\d{4}-\d{2}-\d{2}/.test(req.query.from || '') || !/\d{4}-\d{2}-\d{2}/.test(req.query.to || '')) throw fail(422, 'DATE_RANGE_REQUIRED'); json(res, await adapters.usage.forApplication(application, req.query.from, req.query.to)); });
  app.get(`${p}/storage`, async (req, res) => { const bankId = ['bank', 'officer'].includes(req.dashboard.role) ? req.dashboard.bank_id : req.query.bank_id; if (!bankId) throw fail(422, 'BANK_ID_REQUIRED'); const bank = await management.bank(bankId); if (['bank', 'officer'].includes(req.dashboard.role) && bank.id !== req.dashboard.bank_id) throw fail(403, 'CROSS_BANK_ACCESS'); const docs = await db('platform_documents').where({ tenant_id: bank.tenant_id }).count('* as count').first(); const recordings = await db('platform_recordings').where({ tenant_id: bank.tenant_id, state: 'stored' }).count('* as count').first(); json(res, { provider: 'seaweedfs', documents: Number(docs.count), recordings: Number(recordings.count), tenant_id: bank.tenant_id }); });
  for (const feature of ['ocr', 'liveness']) app.get(`${p}/${feature}`, async (req, _res) => { await context(req.query.application_id, req.dashboard); throw fail(503, `${feature.toUpperCase()}_HISTORY_NOT_MIGRATED`); });
}
