import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assert } from '@ekyc/shared/errors';
import { hash, opaqueToken, issueToken } from '@ekyc/shared/auth';
import { audit } from '@ekyc/shared/outbox';
import { activeStates } from '@ekyc/shared/db';
export class Sessions {
  constructor(db, cfg, calls) { this.db = db; this.cfg = cfg; this.calls = calls; }
  claims(session) { return { sub: session.subject_id, tenant_id: session.tenant_id, role: session.role, sid: session.id, source: session.source || 'basic', ...(session.call_id ? { call_id: session.call_id } : {}) }; }
  async create(role, subjectId, tenantId, trx = this.db, options = {}) {
    const refresh = opaqueToken();
    const [session] = await trx('platform_sessions').insert({ id: randomUUID(), subject_id: subjectId, tenant_id: tenantId, role, refresh_hash: hash(refresh), call_id: options.call_id || null, source: options.source || 'basic', expires_at: new Date(Date.now() + 8 * 3600000) }).returning('*');
    return { session, refresh, token: issueToken(this.cfg, this.claims(session)) };
  }
  async login(username, password) {
    const agent = await this.db('platform_agents').where({ username, active: true }).first();
    const valid = await bcrypt.compare(password, agent?.password_hash || '$2b$12$gWojKD.cLDZEpzBFvgJLKuVNGEQFnYaDTp5U2w1wjYBu5y/HGBHa2');
    assert(agent && valid, 401, 'INVALID_CREDENTIALS');
    assert(await this.db('platform_tenants').where({ id: agent.tenant_id, active: true }).first(), 403, 'TENANT_INACTIVE');
    return this.create('agent', agent.id, agent.tenant_id);
  }
  async refresh(token, origin) {
    assert(typeof token === 'string' && token.length >= 32, 401, 'SESSION_EXPIRED');
    return this.db.transaction(async trx => {
      const session = await trx('platform_sessions').where({ refresh_hash: hash(token) }).whereNull('revoked_at').where('expires_at', '>', new Date()).forUpdate().first();
      assert(session && ['agent', 'customer'].includes(session.role), 401, 'SESSION_EXPIRED');
      if (origin && origin !== this.cfg.publicOrigin) {
        const integration = session.source === 'integration' && await trx('platform_integrations').where({ tenant_id: session.tenant_id, active: true }).first();
        assert(integration && (origin === integration.staff_origin || (session.role === 'customer' && origin === new URL(integration.customer_entry_url).origin)), 403, 'INVALID_ORIGIN');
      }
      const refresh = opaqueToken(); await trx('platform_sessions').where({ id: session.id }).update({ refresh_hash: hash(refresh) });
      return { session, refresh, token: issueToken(this.cfg, this.claims(session)) };
    });
  }
  async grant(tenantId, userId) {
    assert(await this.db('platform_customers').where({ id: userId, tenant_id: tenantId }).first(), 404, 'CUSTOMER_NOT_FOUND');
    const grant = opaqueToken(); await this.db('platform_sessions').insert({ id: randomUUID(), subject_id: userId, tenant_id: tenantId, role: 'grant', refresh_hash: hash(grant), expires_at: new Date(Date.now() + 300000) });
    return { code: grant, expires_in: 300, join_url: `${this.cfg.publicOrigin}/customer#code=${grant}` };
  }
  async integrationCustomerGrant(tenantId, userId, callId) {
    const code = opaqueToken();
    await this.db.transaction(async trx => {
      const call = await trx('platform_calls').where({ id: callId, tenant_id: tenantId, user_id: userId, source: 'integration' }).first();
      assert(call && activeStates.includes(call.state), 409, 'CALL_NOT_AVAILABLE');
      await trx('platform_link_grants').insert({ code_hash: hash(code), tenant_id: tenantId, kind: 'customer', subject_id: userId, call_id: callId, expires_at: new Date(Date.now() + 300000) });
      await audit(trx, tenantId, null, userId, 'integration.customer_link_issued', { call_id: callId });
    });
    return { code };
  }
  async deferredCustomerLink(tenantId, userId, externalRequestId) {
    assert(typeof userId === 'string' && /^[0-9a-f-]{36}$/i.test(userId), 422, 'INVALID_CUSTOMER_ID');
    assert(typeof externalRequestId === 'string' && /^[A-Za-z0-9._:-]{8,96}$/.test(externalRequestId), 422, 'INVALID_EXTERNAL_REQUEST_ID');
    const tenant = await this.db('platform_tenants').where({ id: tenantId, active: true }).first(); assert(tenant, 403, 'TENANT_INACTIVE');
    const customer = await this.db('platform_customers').where({ id: userId, tenant_id: tenantId }).whereNull('deleted_at').first(); assert(customer, 404, 'CUSTOMER_NOT_FOUND');
    const integration = await this.db('platform_integrations').where({ tenant_id: tenantId, active: true }).first();
    const entry = integration?.customer_entry_url || `${this.cfg.publicOrigin}/customer`;
    const url = new URL(entry); assert(url.protocol === 'https:' || (!this.cfg.production && ['localhost', '127.0.0.1'].includes(url.hostname)), 503, 'CUSTOMER_ENTRY_URL_NOT_SECURE');
    const code = opaqueToken();
    await this.db('platform_link_grants').insert({ code_hash: hash(code), tenant_id: tenantId, kind: 'customer_pending_basic', subject_id: userId, external_request_id: externalRequestId, expires_at: new Date(Date.now() + 300000) });
    url.hash = new URLSearchParams({ code }).toString();
    return { customer_url: url.toString(), expires_in: 300 };
  }
  async exchangeAgentLink(code, origin) {
    assert(typeof code === 'string' && code.length >= 32, 401, 'INVALID_LINK');
    return this.db.transaction(async trx => {
      const grant = await trx('platform_link_grants').where({ code_hash: hash(code), kind: 'agent' }).whereNull('consumed_at').where('expires_at', '>', new Date()).forUpdate().first();
      assert(grant, 401, 'INVALID_LINK');
      const agent = await trx('platform_agents').where({ id: grant.subject_id, tenant_id: grant.tenant_id, active: true }).first();
      const integration = await trx('platform_integrations').where({ tenant_id: grant.tenant_id, active: true }).first();
      const tenant = await trx('platform_tenants').where({ id: grant.tenant_id, active: true }).first();
      assert(agent && integration && tenant, 403, 'AGENT_INACTIVE');
      assert(!origin || origin === integration.staff_origin || origin === this.cfg.publicOrigin, 403, 'INVALID_ORIGIN');
      if (grant.call_id) {
        const call = await trx('platform_calls').where({ id: grant.call_id, tenant_id: grant.tenant_id }).first();
        assert(call && call.source === 'integration' && (call.state === 'waiting' || (call.agent_id === agent.id && activeStates.includes(call.state))), 409, 'CALL_NOT_AVAILABLE_TO_AGENT');
      }
      await trx('platform_link_grants').where({ code_hash: grant.code_hash }).update({ consumed_at: new Date() });
      return { ...(await this.create('agent', agent.id, grant.tenant_id, trx, { source: 'integration' })), launch_call_id: grant.call_id };
    });
  }
  async exchange(code) {
    assert(typeof code === 'string', 401, 'INVALID_GRANT');
    return this.db.transaction(async trx => {
      const scoped = await trx('platform_link_grants').where({ code_hash: hash(code), kind: 'customer' }).whereNull('consumed_at').where('expires_at', '>', new Date()).forUpdate().first();
      if (scoped) {
        const call = await trx('platform_calls').where({ id: scoped.call_id, tenant_id: scoped.tenant_id, user_id: scoped.subject_id, source: 'integration' }).first();
        assert(call && activeStates.includes(call.state), 409, 'CALL_NOT_AVAILABLE');
        assert(await trx('platform_integrations').where({ tenant_id: scoped.tenant_id, active: true }).first(), 403, 'INTEGRATION_NOT_CONFIGURED');
        await trx('platform_link_grants').where({ code_hash: scoped.code_hash }).update({ consumed_at: new Date() });
        return this.create('customer', scoped.subject_id, scoped.tenant_id, trx, { call_id: scoped.call_id, source: 'integration' });
      }
      const pending = await trx('platform_link_grants').where({ code_hash: hash(code), kind: 'customer_pending' }).whereNull('consumed_at').where('expires_at', '>', new Date()).forUpdate().first();
      if (pending) {
        assert(await trx('platform_integrations').where({ tenant_id: pending.tenant_id, active: true }).first(), 403, 'INTEGRATION_NOT_CONFIGURED');
        const call = await this.calls.register({ tenant_id: pending.tenant_id }, { user_id: pending.subject_id }, `integration:${pending.external_request_id}`, 'integration', pending.external_request_id, trx);
        await trx('platform_link_grants').where({ code_hash: pending.code_hash }).update({ consumed_at: new Date(), call_id: call.id });
        return this.create('customer', pending.subject_id, pending.tenant_id, trx, { call_id: call.id, source: 'integration' });
      }
      const basicPending = await trx('platform_link_grants').where({ code_hash: hash(code), kind: 'customer_pending_basic' }).whereNull('consumed_at').where('expires_at', '>', new Date()).forUpdate().first();
      if (basicPending) {
        assert(await trx('platform_tenants').where({ id: basicPending.tenant_id, active: true }).first(), 403, 'TENANT_INACTIVE');
        const call = await this.calls.register({ tenant_id: basicPending.tenant_id }, { user_id: basicPending.subject_id }, `partner:${basicPending.tenant_id}:${basicPending.external_request_id}`, 'basic', basicPending.external_request_id, trx);
        await trx('platform_link_grants').where({ code_hash: basicPending.code_hash }).update({ consumed_at: new Date(), call_id: call.id });
        return this.create('customer', basicPending.subject_id, basicPending.tenant_id, trx, { call_id: call.id, source: 'basic' });
      }
      const grant = await trx('platform_sessions').where({ refresh_hash: hash(code), role: 'grant' }).whereNull('revoked_at').where('expires_at', '>', new Date()).forUpdate().first(); assert(grant, 401, 'INVALID_GRANT');
      await trx('platform_sessions').where({ id: grant.id }).update({ revoked_at: new Date(), refresh_hash: null });
      return this.create('customer', grant.subject_id, grant.tenant_id, trx);
    });
  }
  async password(actor, current, next) {
    await this.db.transaction(async trx => {
      const agent = await trx('platform_agents').where({ id: actor.sub, tenant_id: actor.tenant_id }).forUpdate().first();
      assert(await bcrypt.compare(current, agent.password_hash), 401, 'INVALID_CREDENTIALS');
      await trx('platform_agents').where({ id: actor.sub }).update({ password_hash: await bcrypt.hash(next, 12), updated_at: new Date() });
      await trx('platform_sessions').where({ subject_id: actor.sub }).update({ revoked_at: new Date(), refresh_hash: null });
      await audit(trx, actor.tenant_id, actor.sub, actor.sub, 'agent.password_changed');
    });
  }
}
export function sessionReply(req, res, cfg, result) {
  const cookieName = result.session.role === 'customer' ? 'customer_refresh' : 'agent_refresh';
  res.cookie(cookieName, result.refresh, { httpOnly: true, secure: cfg.production, sameSite: 'strict', path: '/', maxAge: 8 * 3600000 });
  res.set('cache-control', 'no-store').json({ success: true, access_token: result.token, access_token_expire_in: 600, role: result.session.role, source: result.session.source, ...(result.session.call_id ? { call_id: result.session.call_id } : {}), ...(result.launch_call_id ? { launch_call_id: result.launch_call_id } : {}), services: ['document.post', 'face-recognition.post', 'videocalls.post'] });
}
export function cookie(req, name) { return req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1); }
