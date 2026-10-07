import jwt from 'jsonwebtoken';
import { assert } from '@ekyc/shared/errors';
import { hash, opaqueToken } from '@ekyc/shared/auth';
import { audit } from '@ekyc/shared/outbox';
import { activeStates } from '@ekyc/shared/db';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configuredUrl(raw, name) {
  let url;
  try { url = new URL(raw); } catch { assert(false, 503, `${name}_NOT_CONFIGURED`); }
  assert(url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)), 503, `${name}_NOT_SECURE`);
  assert(!url.search && !url.hash && !url.username && !url.password, 503, `${name}_INVALID`);
  return url;
}

export class Integration {
  constructor(db, calls, sessions) { this.db = db; this.calls = calls; this.sessions = sessions; }

  async assertion(raw, scope) {
    assert(typeof raw === 'string' && raw.length <= 8192, 401, 'INVALID_INTEGRATION_ASSERTION');
    const untrusted = jwt.decode(raw);
    assert(untrusted && typeof untrusted.tenant_id === 'string' && uuid.test(untrusted.tenant_id), 401, 'INVALID_INTEGRATION_ASSERTION');
    const config = await this.db('platform_integrations').where({ tenant_id: untrusted.tenant_id, active: true }).first();
    assert(config, 401, 'INTEGRATION_NOT_CONFIGURED');
    let claims;
    try { claims = jwt.verify(raw, config.public_key_pem, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience, clockTolerance: 5 }); }
    catch { assert(false, 401, 'INVALID_INTEGRATION_ASSERTION'); }
    assert(claims.tenant_id === config.tenant_id && claims.scope === scope && typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 255, 401, 'INVALID_INTEGRATION_ASSERTION');
    assert(typeof claims.jti === 'string' && claims.jti.length >= 8 && claims.jti.length <= 255 && Number.isInteger(claims.iat) && Number.isInteger(claims.exp) && claims.exp - claims.iat <= 90, 401, 'INVALID_INTEGRATION_ASSERTION');
    return { config, claims };
  }

  async consumeAssertion(trx, config, claims) {
    const inserted = await trx('platform_integration_jtis').insert({ tenant_id: config.tenant_id, jti_hash: hash(claims.jti), expires_at: new Date(claims.exp * 1000) }).onConflict(['tenant_id', 'jti_hash']).ignore().returning('jti_hash');
    assert(inserted.length, 409, 'INTEGRATION_ASSERTION_REPLAYED');
  }

  async agentLink(assertion) {
    const { config, claims } = await this.assertion(assertion, 'agent:launch');
    const url = configuredUrl(config.agent_launch_url, 'AGENT_LAUNCH_URL');
    const code = opaqueToken();
    const callId = claims.call_id || null;
    await this.db.transaction(async trx => {
      await this.consumeAssertion(trx, config, claims);
      const mapping = await trx('platform_agent_identities as identity').join('platform_agents as agent', 'identity.agent_id', 'agent.id')
        .where({ 'identity.tenant_id': config.tenant_id, 'identity.external_subject': claims.sub, 'agent.tenant_id': config.tenant_id, 'agent.active': true }).select('agent.id').first();
      assert(mapping, 403, 'AGENT_MAPPING_NOT_FOUND');
      if (callId) {
        assert(typeof callId === 'string' && uuid.test(callId), 422, 'INVALID_CALL_ID');
        const call = await trx('platform_calls').where({ id: callId, tenant_id: config.tenant_id }).first();
        assert(call && call.source === 'integration' && (call.state === 'waiting' || (call.agent_id === mapping.id && activeStates.includes(call.state))), 403, 'CALL_NOT_AVAILABLE_TO_AGENT');
      }
      await trx('platform_link_grants').insert({ code_hash: hash(code), tenant_id: config.tenant_id, kind: 'agent', subject_id: mapping.id, call_id: callId, expires_at: new Date(Date.now() + 300000) });
      await audit(trx, config.tenant_id, mapping.id, mapping.id, 'integration.agent_link_issued', { call_id: callId });
    });
    url.hash = new URLSearchParams({ code }).toString();
    return { agent_url: url.toString(), expires_in: 300 };
  }

  async queueLink(assertion, data) {
    const { config, claims } = await this.assertion(assertion, 'queue:create');
    const url = configuredUrl(config.customer_entry_url, 'CUSTOMER_ENTRY_URL');
    assert(typeof data.customer_id === 'string' && uuid.test(data.customer_id), 422, 'INVALID_CUSTOMER_ID');
    assert(typeof data.external_request_id === 'string' && /^[A-Za-z0-9._:-]{8,96}$/.test(data.external_request_id), 422, 'INVALID_EXTERNAL_REQUEST_ID');
    await this.db.transaction(trx => this.consumeAssertion(trx, config, claims));
    const call = await this.calls.register({ tenant_id: config.tenant_id }, { user_id: data.customer_id }, `integration:${data.external_request_id}`, 'integration', data.external_request_id);
    const grant = await this.sessions.integrationCustomerGrant(config.tenant_id, data.customer_id, call.id);
    url.hash = new URLSearchParams({ code: grant.code }).toString();
    return { call_id: call.id, state: call.state, customer_url: url.toString(), expires_in: 300 };
  }

  async customerLink(assertion, data) {
    const { config, claims } = await this.assertion(assertion, 'customer:link');
    const url = configuredUrl(config.customer_entry_url, 'CUSTOMER_ENTRY_URL');
    assert(typeof data.customer_id === 'string' && uuid.test(data.customer_id), 422, 'INVALID_CUSTOMER_ID');
    assert(typeof data.external_request_id === 'string' && /^[A-Za-z0-9._:-]{8,96}$/.test(data.external_request_id), 422, 'INVALID_EXTERNAL_REQUEST_ID');
    const code = opaqueToken();
    await this.db.transaction(async trx => {
      await this.consumeAssertion(trx, config, claims);
      const customer = await trx('platform_customers').where({ id: data.customer_id, tenant_id: config.tenant_id }).whereNull('deleted_at').first();
      assert(customer, 404, 'CUSTOMER_NOT_FOUND');
      await trx('platform_link_grants').insert({ code_hash: hash(code), tenant_id: config.tenant_id, kind: 'customer_pending', subject_id: customer.id, external_request_id: data.external_request_id, expires_at: new Date(Date.now() + 300000) });
      await audit(trx, config.tenant_id, null, customer.id, 'integration.customer_link_issued', { deferred: true });
    });
    url.hash = new URLSearchParams({ code }).toString();
    return { customer_url: url.toString(), expires_in: 300 };
  }

  async sweep() {
    const cutoff = new Date(Date.now() - 86400000);
    await this.db('platform_integration_jtis').where('expires_at', '<', cutoff).del();
    await this.db('platform_link_grants').where('expires_at', '<', cutoff).del();
  }
}
