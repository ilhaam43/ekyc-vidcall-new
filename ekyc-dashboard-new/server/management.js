import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { fail, requireRole, bankScope, audit } from './auth.js';
import { planPolicy } from './integrations.js';

const text = (value, max = 150) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const email = value => { const result = text(value, 254); if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw fail(422, 'INVALID_EMAIL'); return result || null; };
const password = async value => { if (typeof value !== 'string' || value.length < 12 || value.length > 72) throw fail(422, 'PASSWORD_POLICY'); return bcrypt.hash(value, 12); };
const json = (res, data) => res.json({ success: true, data });
const admin = actor => requireRole(actor, 'superadmin', 'admin');
const bankMember = actor => requireRole(actor, 'superadmin', 'admin', 'bank', 'officer');
const page = req => ({ limit: Math.min(100, Math.max(1, Number(req.query.limit) || 25)), offset: Math.max(0, Number(req.query.page) || 0) * Math.min(100, Math.max(1, Number(req.query.limit) || 25)) });
const safeAccount = row => { const { password_hash: _password, reset_hash: _reset, reset_expires_at: _expiry, ...safe } = row; return safe; };

export function managementRoutes(app, db, adapters) {
  const p = '/dashboard/api/v1';
  const bank = async id => { const row = await db('dashboard_banks').where({ id }).first(); if (!row) throw fail(404, 'BANK_NOT_FOUND'); return row; };
  const appRow = async (id, actor) => { const row = await db('dashboard_applications').where({ id }).first(); if (!row) throw fail(404, 'APPLICATION_NOT_FOUND'); bankScope(actor, row.bank_id); return row; };
  app.get(`${p}/summary`, async (req, res) => {
    const actor = req.dashboard; const bankId = ['bank', 'officer'].includes(actor.role) ? actor.bank_id : null;
    const banks = await db('dashboard_banks').modify(q => { if (bankId) q.where({ id: bankId }); }).count('* as count').first();
    const applications = await db('dashboard_applications').modify(q => { if (bankId) q.where({ bank_id: bankId }); }).count('* as count').first();
    const agents = await db('platform_agents').modify(q => { if (bankId) q.where({ tenant_id: db('dashboard_banks').select('tenant_id').where({ id: bankId }) }); }).count('* as count').first();
    const customers = await db('platform_customers').whereNull('deleted_at').modify(q => { if (bankId) q.where({ tenant_id: db('dashboard_banks').select('tenant_id').where({ id: bankId }) }); }).count('* as count').first();
    json(res, { banks: Number(banks.count), applications: Number(applications.count), agents: Number(agents.count), customers: Number(customers.count) });
  });
  app.get(`${p}/banks`, async (req, res) => { const q = db('dashboard_banks').orderBy('name'); if (['bank', 'officer'].includes(req.dashboard.role)) q.where({ id: req.dashboard.bank_id }); json(res, await q); });
  app.get(`${p}/banks/:id`, async (req, res) => { bankScope(req.dashboard, req.params.id); json(res, await bank(req.params.id)); });
  app.post(`${p}/banks`, async (req, res) => {
    admin(req.dashboard); const username = text(req.body?.username, 80).toLowerCase(); const name = text(req.body?.name);
    if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(username) || !name) throw fail(422, 'INVALID_BANK');
    const id = randomUUID(); const tenantId = randomUUID();
    const row = await db.transaction(async trx => {
      await trx('platform_tenants').insert({ id: tenantId, name });
      const [created] = await trx('dashboard_banks').insert({ id, tenant_id: tenantId, username, name, email: email(req.body.email) }).returning('*');
      await audit(trx, req.dashboard, 'bank.created', { id }, id); return created;
    }); json(res, row);
  });
  app.patch(`${p}/banks/:id`, async (req, res) => { admin(req.dashboard); const row = await bank(req.params.id); const patch = { updated_at: new Date() }; if (req.body.name !== undefined) { patch.name = text(req.body.name); if (!patch.name) throw fail(422, 'INVALID_BANK'); } if (req.body.email !== undefined) patch.email = email(req.body.email); if (req.body.active !== undefined) patch.active = Boolean(req.body.active); await db.transaction(async trx => { await trx('dashboard_banks').where({ id: row.id }).update(patch); if (patch.active !== undefined) await trx('platform_tenants').where({ id: row.tenant_id }).update({ active: patch.active }); await audit(trx, req.dashboard, 'bank.updated', { id: row.id }, row.id); }); json(res, await bank(row.id)); });
  app.delete(`${p}/banks/:id`, async (req, res) => { admin(req.dashboard); const row = await bank(req.params.id); if (await db('dashboard_applications').where({ bank_id: row.id, status: 'confirmed' }).first()) throw fail(409, 'BANK_HAS_ACTIVE_APPLICATIONS'); await db.transaction(async trx => { await trx('dashboard_banks').where({ id: row.id }).update({ active: false }); await trx('platform_tenants').where({ id: row.tenant_id }).update({ active: false }); await audit(trx, req.dashboard, 'bank.deactivated', { id: row.id }, row.id); }); json(res, { active: false }); });

  app.get(`${p}/plans`, async (_req, res) => json(res, await db('dashboard_plans').orderBy('name')));
  app.post(`${p}/plans`, async (req, res) => { admin(req.dashboard); const name = text(req.body?.name), shortname = text(req.body?.shortname, 60).toLowerCase(); if (!name || !/^[a-z0-9_-]{2,60}$/.test(shortname)) throw fail(422, 'INVALID_PLAN'); const features = req.body.features; if (!Array.isArray(features) || !features.every(x => typeof x === 'string' && x.length < 60)) throw fail(422, 'INVALID_PLAN_FEATURES'); const limits = req.body.limits && typeof req.body.limits === 'object' ? req.body.limits : {}; planPolicy({ shortname, limits }); const [row] = await db('dashboard_plans').insert({ id: randomUUID(), name, shortname, description: text(req.body.description, 1000), features: JSON.stringify(features), limits: JSON.stringify(limits) }).returning('*'); await audit(db, req.dashboard, 'plan.created', { id: row.id }); json(res, row); });
  app.patch(`${p}/plans/:id`, async (req, res) => { admin(req.dashboard); const current = await db('dashboard_plans').where({ id: req.params.id }).first(); if (!current) throw fail(404, 'PLAN_NOT_FOUND'); const patch = { updated_at: new Date() }; if (req.body.name !== undefined) patch.name = text(req.body.name); if (req.body.description !== undefined) patch.description = text(req.body.description, 1000); if (req.body.features !== undefined) { if (!Array.isArray(req.body.features)) throw fail(422, 'INVALID_PLAN_FEATURES'); patch.features = JSON.stringify(req.body.features); } if (req.body.limits !== undefined) { if (await db('dashboard_applications').where({ plan_id: current.id, status: 'confirmed' }).first()) throw fail(409, 'PLAN_IN_USE_ASSIGN_NEW_PLAN'); planPolicy({ ...current, limits: req.body.limits }); patch.limits = JSON.stringify(req.body.limits); } await db('dashboard_plans').where({ id: current.id }).update(patch); await audit(db, req.dashboard, 'plan.updated', { id: current.id }); json(res, await db('dashboard_plans').where({ id: current.id }).first()); });
  app.delete(`${p}/plans/:id`, async (req, res) => { admin(req.dashboard); if (await db('dashboard_applications').where({ plan_id: req.params.id }).first()) throw fail(409, 'PLAN_IN_USE'); await db('dashboard_plans').where({ id: req.params.id }).del(); await audit(db, req.dashboard, 'plan.deleted', { id: req.params.id }); json(res, { deleted: true }); });

  app.get(`${p}/applications`, async (req, res) => { bankMember(req.dashboard); const q = db('dashboard_applications as a').join('dashboard_banks as b', 'a.bank_id', 'b.id').leftJoin('dashboard_plans as p', 'a.plan_id', 'p.id').select('a.*', 'b.name as bank_name', 'b.username as bank_username', 'p.name as plan_name').orderBy('a.created_at', 'desc'); if (['bank', 'officer'].includes(req.dashboard.role)) q.where('a.bank_id', req.dashboard.bank_id); else if (req.query.bank_id) q.where('a.bank_id', req.query.bank_id); if (req.query.status) q.where('a.status', req.query.status); const { limit, offset } = page(req); json(res, await q.limit(limit).offset(offset)); });
  app.get(`${p}/app-requests`, async (req, res) => { admin(req.dashboard); json(res, await db('dashboard_applications').where({ status: 'waiting' }).orderBy('created_at')); });
  app.post(`${p}/applications`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); if (req.dashboard.role === 'bank' && req.body?.bank_id && req.body.bank_id !== req.dashboard.bank_id) throw fail(403, 'CROSS_BANK_ACCESS'); const bankId = req.dashboard.role === 'bank' ? req.dashboard.bank_id : req.body.bank_id; bankScope(req.dashboard, bankId); await bank(bankId); const plan = await db('dashboard_plans').where({ id: req.body.plan_id }).first(); if (!plan) throw fail(404, 'PLAN_NOT_FOUND'); const name = text(req.body.name); if (!name) throw fail(422, 'NAME_REQUIRED'); const [row] = await db('dashboard_applications').insert({ id: randomUUID(), bank_id: bankId, plan_id: plan.id, name, description: text(req.body.description, 1000) }).returning('*'); await audit(db, req.dashboard, 'application.requested', { id: row.id }, bankId); json(res, row); });
  app.get(`${p}/applications/:id`, async (req, res) => json(res, await appRow(req.params.id, req.dashboard)));
  app.patch(`${p}/applications/:id`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const row = await appRow(req.params.id, req.dashboard); if (!['waiting', 'rejected'].includes(row.status)) throw fail(409, 'APPLICATION_LOCKED'); const patch = { updated_at: new Date() }; if (req.body.name !== undefined) patch.name = text(req.body.name); if (req.body.description !== undefined) patch.description = text(req.body.description, 1000); if (req.body.plan_id !== undefined) { if (!await db('dashboard_plans').where({ id: req.body.plan_id }).first()) throw fail(404, 'PLAN_NOT_FOUND'); patch.plan_id = req.body.plan_id; } await db('dashboard_applications').where({ id: row.id }).update(patch); await audit(db, req.dashboard, 'application.updated', { id: row.id }, row.bank_id); json(res, await appRow(row.id, req.dashboard)); });
  app.post(`${p}/applications/:id/approve`, async (req, res) => {
    admin(req.dashboard);
    const approved = await db.transaction(async trx => {
      const row = await trx('dashboard_applications').where({ id: req.params.id }).forUpdate().first();
      if (!row) throw fail(404, 'APPLICATION_NOT_FOUND');
      bankScope(req.dashboard, row.bank_id);
        if (row.status === 'confirmed') return { row, consumer: null };
      if (row.status !== 'waiting') throw fail(409, 'APPLICATION_NOT_WAITING');
      const plan = await trx('dashboard_plans').where({ id: row.plan_id }).first();
      if (!plan) throw fail(404, 'PLAN_NOT_FOUND');
      const consumer = await adapters.kong.provision(row, plan);
      await trx('dashboard_applications').where({ id: row.id }).update({ status: 'confirmed', kong_consumer_id: consumer.id, activated_at: new Date(), updated_at: new Date() });
      await audit(trx, req.dashboard, 'application.approved', { id: row.id, mode: consumer.mode || 'kong', rate_limit_per_minute: consumer.rate_limit_per_minute }, row.bank_id);
      return { row: { ...row, status: 'confirmed', kong_consumer_id: consumer.id, activated_at: new Date() }, consumer };
    });
    json(res, { ...approved.row, ...(approved.consumer?.api_key ? { api_key: approved.consumer.api_key, api_key_delivery: 'one_time' } : {}), ...(approved.consumer?.rate_limit_per_minute ? { rate_limit_per_minute: approved.consumer.rate_limit_per_minute, acl_group: approved.consumer.acl_group } : {}) });
  });
  app.post(`${p}/applications/:id/plan`, async (req, res) => {
    admin(req.dashboard);
    const result = await db.transaction(async trx => {
      const row = await trx('dashboard_applications').where({ id: req.params.id }).forUpdate().first();
      if (!row) throw fail(404, 'APPLICATION_NOT_FOUND');
      const plan = await trx('dashboard_plans').where({ id: req.body?.plan_id }).first();
      if (!plan) throw fail(404, 'PLAN_NOT_FOUND');
      if (row.status === 'confirmed' && !row.kong_consumer_id) throw fail(409, 'CONSUMER_NOT_MAPPED');
      const oldPlan = row.plan_id ? await trx('dashboard_plans').where({ id: row.plan_id }).first() : null;
      const policy = row.status === 'confirmed' ? await adapters.kong.applyPlan(row.kong_consumer_id, plan, oldPlan) : planPolicy(plan);
      await trx('dashboard_applications').where({ id: row.id }).update({ plan_id: plan.id, updated_at: new Date() });
      await audit(trx, req.dashboard, 'application.plan_assigned', { id: row.id, plan_id: plan.id, rate_limit_per_minute: policy.rate_limit_per_minute || policy.minute, acl_group: policy.acl_group || policy.group }, row.bank_id);
      return { ...row, plan_id: plan.id, policy };
    });
    json(res, result);
  });
  app.post(`${p}/applications/:id/status`, async (req, res) => {
    admin(req.dashboard);
    const status = req.body?.status;
    if (!['confirmed', 'inactive'].includes(status)) throw fail(422, 'INVALID_APPLICATION_STATUS');
    const result = await db.transaction(async trx => {
      const row = await trx('dashboard_applications').where({ id: req.params.id }).forUpdate().first();
      if (!row) throw fail(404, 'APPLICATION_NOT_FOUND');
      bankScope(req.dashboard, row.bank_id);
      if (!['confirmed', 'inactive'].includes(row.status)) throw fail(409, 'APPLICATION_NOT_APPROVED');
      if (!row.kong_consumer_id) throw fail(409, 'CONSUMER_NOT_MAPPED');
      if (status === 'inactive') await adapters.kong.deactivate(row.kong_consumer_id);
      else {
        const bankRow = await trx('dashboard_banks').where({ id: row.bank_id }).first();
        if (!bankRow.active) throw fail(409, 'BANK_INACTIVE');
        const plan = await trx('dashboard_plans').where({ id: row.plan_id }).first();
        if (!plan) throw fail(404, 'PLAN_NOT_FOUND');
        await adapters.kong.applyPlan(row.kong_consumer_id, plan);
      }
      if (row.status !== status) {
        await trx('dashboard_applications').where({ id: row.id }).update({ status, updated_at: new Date() });
        await audit(trx, req.dashboard, status === 'inactive' ? 'application.deactivated' : 'application.reactivated', { id: row.id, consumer_id: row.kong_consumer_id }, row.bank_id);
      }
      return { ...row, status };
    });
    json(res, result);
  });
  app.post(`${p}/applications/:id/connect-kong`, async (req, res) => {
    admin(req.dashboard);
    const result = await db.transaction(async trx => {
      const row = await trx('dashboard_applications').where({ id: req.params.id }).forUpdate().first();
      if (!row) throw fail(404, 'APPLICATION_NOT_FOUND');
      if (row.status !== 'confirmed' || !row.kong_consumer_id?.startsWith('synthetic-')) throw fail(409, 'APPLICATION_NOT_SYNTHETIC');
      const plan = await trx('dashboard_plans').where({ id: row.plan_id }).first();
      if (!plan) throw fail(404, 'PLAN_NOT_FOUND');
      const consumer = await adapters.kong.provision(row, plan);
      if (consumer.mode !== 'kong') throw fail(503, 'KONG_NOT_CONNECTED');
      await trx('dashboard_applications').where({ id: row.id }).update({ kong_consumer_id: consumer.id, updated_at: new Date() });
      await audit(trx, req.dashboard, 'application.kong_connected', { id: row.id, consumer_id: consumer.id, rate_limit_per_minute: consumer.rate_limit_per_minute, acl_group: consumer.acl_group }, row.bank_id);
      return { ...row, kong_consumer_id: consumer.id, api_key: consumer.api_key, api_key_delivery: 'one_time', rate_limit_per_minute: consumer.rate_limit_per_minute, acl_group: consumer.acl_group };
    });
    json(res, result);
  });
  app.post(`${p}/applications/:id/reject`, async (req, res) => { admin(req.dashboard); const row = await appRow(req.params.id, req.dashboard); if (row.status !== 'waiting') throw fail(409, 'APPLICATION_NOT_WAITING'); await db('dashboard_applications').where({ id: row.id }).update({ status: 'rejected', updated_at: new Date() }); await audit(db, req.dashboard, 'application.rejected', { id: row.id, reason: text(req.body?.reason, 500) }, row.bank_id); json(res, await appRow(row.id, req.dashboard)); });

  app.get(`${p}/accounts`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const q = db('dashboard_accounts').orderBy('username'); if (req.dashboard.role === 'bank') q.where({ bank_id: req.dashboard.bank_id }); else if (req.query.bank_id) q.where({ bank_id: req.query.bank_id }); json(res, (await q).map(safeAccount)); });
  app.post(`${p}/accounts`, async (req, res) => { admin(req.dashboard); const role = req.body?.role; if (!['superadmin', 'admin', 'bank'].includes(role)) throw fail(422, 'INVALID_ROLE'); if (role === 'superadmin') requireRole(req.dashboard, 'superadmin'); const bankId = role === 'bank' ? req.body.bank_id : null; if (role === 'bank') await bank(bankId); const username = text(req.body.username, 100); if (!username) throw fail(422, 'USERNAME_REQUIRED'); const [row] = await db('dashboard_accounts').insert({ id: randomUUID(), username, email: email(req.body.email), role, bank_id: bankId, password_hash: await password(req.body.password) }).returning('*'); await audit(db, req.dashboard, 'account.created', { id: row.id }, bankId); json(res, safeAccount(row)); });
  app.patch(`${p}/accounts/:id`, async (req, res) => { admin(req.dashboard); const current = await db('dashboard_accounts').where({ id: req.params.id }).first(); if (!current) throw fail(404, 'ACCOUNT_NOT_FOUND'); if (current.role === 'superadmin') requireRole(req.dashboard, 'superadmin'); const patch = { updated_at: new Date() }; if (req.body.email !== undefined) patch.email = email(req.body.email); if (req.body.active !== undefined) patch.active = Boolean(req.body.active); if (req.body.password !== undefined) patch.password_hash = await password(req.body.password); await db('dashboard_accounts').where({ id: current.id }).update(patch); await audit(db, req.dashboard, 'account.updated', { id: current.id }, current.bank_id); json(res, safeAccount(await db('dashboard_accounts').where({ id: current.id }).first())); });
  app.delete(`${p}/accounts/:id`, async (req, res) => { admin(req.dashboard); if (req.params.id === req.dashboard.id) throw fail(409, 'CANNOT_DISABLE_SELF'); const row = await db('dashboard_accounts').where({ id: req.params.id }).first(); if (!row) throw fail(404, 'ACCOUNT_NOT_FOUND'); if (row.role === 'superadmin') requireRole(req.dashboard, 'superadmin'); await db('dashboard_accounts').where({ id: row.id }).update({ active: false }); await audit(db, req.dashboard, 'account.deactivated', { id: row.id }, row.bank_id); json(res, { active: false }); });

  app.get(`${p}/officers`, async (req, res) => { bankMember(req.dashboard); const q = db('dashboard_officers').orderBy('name'); if (['bank', 'officer'].includes(req.dashboard.role)) q.where({ bank_id: req.dashboard.bank_id }); else if (req.query.bank_id) q.where({ bank_id: req.query.bank_id }); json(res, (await q).map(safeAccount)); });
  app.post(`${p}/officers`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const bankId = req.dashboard.role === 'bank' ? req.dashboard.bank_id : req.body.bank_id; bankScope(req.dashboard, bankId); await bank(bankId); const username = text(req.body.username, 100), name = text(req.body.name); if (!username || !name) throw fail(422, 'INVALID_OFFICER'); const [row] = await db('dashboard_officers').insert({ id: randomUUID(), bank_id: bankId, username, name, email: email(req.body.email), password_hash: await password(req.body.password) }).returning('*'); await audit(db, req.dashboard, 'officer.created', { id: row.id }, bankId); json(res, safeAccount(row)); });
  app.patch(`${p}/officers/:id`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const row = await db('dashboard_officers').where({ id: req.params.id }).first(); if (!row) throw fail(404, 'OFFICER_NOT_FOUND'); bankScope(req.dashboard, row.bank_id); const patch = { updated_at: new Date() }; if (req.body.name !== undefined) patch.name = text(req.body.name); if (req.body.email !== undefined) patch.email = email(req.body.email); if (req.body.active !== undefined) patch.active = Boolean(req.body.active); if (req.body.password !== undefined) patch.password_hash = await password(req.body.password); await db('dashboard_officers').where({ id: row.id }).update(patch); await audit(db, req.dashboard, 'officer.updated', { id: row.id }, row.bank_id); json(res, safeAccount(await db('dashboard_officers').where({ id: row.id }).first())); });
  app.delete(`${p}/officers/:id`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const row = await db('dashboard_officers').where({ id: req.params.id }).first(); if (!row) throw fail(404, 'OFFICER_NOT_FOUND'); bankScope(req.dashboard, row.bank_id); await db('dashboard_officers').where({ id: row.id }).update({ active: false }); await audit(db, req.dashboard, 'officer.deactivated', { id: row.id }, row.bank_id); json(res, { active: false }); });

  app.get(`${p}/links`, async (_req, res) => json(res, await db('dashboard_links').orderBy('name')));
  app.post(`${p}/links`, async (req, res) => { requireRole(req.dashboard, 'superadmin'); const url = text(req.body.url, 2000); if (!/^https:\/\//.test(url)) throw fail(422, 'HTTPS_URL_REQUIRED'); const [row] = await db('dashboard_links').insert({ id: randomUUID(), name: text(req.body.name), url }).returning('*'); await audit(db, req.dashboard, 'link.created', { id: row.id }); json(res, row); });
  app.patch(`${p}/links/:id`, async (req, res) => { requireRole(req.dashboard, 'superadmin'); const patch = { updated_at: new Date() }; if (req.body.name !== undefined) patch.name = text(req.body.name); if (req.body.url !== undefined) { patch.url = text(req.body.url, 2000); if (!/^https:\/\//.test(patch.url)) throw fail(422, 'HTTPS_URL_REQUIRED'); } if (req.body.active !== undefined) patch.active = Boolean(req.body.active); await db('dashboard_links').where({ id: req.params.id }).update(patch); await audit(db, req.dashboard, 'link.updated', { id: req.params.id }); json(res, await db('dashboard_links').where({ id: req.params.id }).first()); });
  app.delete(`${p}/links/:id`, async (req, res) => { requireRole(req.dashboard, 'superadmin'); await db('dashboard_links').where({ id: req.params.id }).del(); await audit(db, req.dashboard, 'link.deleted', { id: req.params.id }); json(res, { deleted: true }); });
  return { appRow, bank };
}
