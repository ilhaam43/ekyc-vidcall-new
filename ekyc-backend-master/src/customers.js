import { randomUUID } from 'node:crypto';
import { assert } from '@ekyc/shared/errors';
import { audit } from '@ekyc/shared/outbox';
import { activeStates } from '@ekyc/shared/db';
export class Customers {
  constructor(db, encryption) { this.db = db; this.encryption = encryption; }
  async tenant(id) { const tenant = await this.db('platform_tenants').where({ id, active: true }).first(); assert(tenant, 403, 'TENANT_INACTIVE'); return tenant; }
  async row(actor, id, trx = this.db) {
    if (actor.role === 'customer') assert(actor.sub === id, 403, 'FORBIDDEN');
    const row = await trx('platform_customers').where({ id, tenant_id: actor.tenant_id }).whereNull('deleted_at').first(); assert(row, 404, 'CUSTOMER_NOT_FOUND'); return row;
  }
  async get(actor, id) {
    const row = await this.row(actor, id); const data = await this.encryption.transform('decrypt', await this.tenant(actor.tenant_id), row.data);
    return { ...data, id: row.id, actor_id: row.actor_id, application_id: row.tenant_id, verification_status: row.verification_status, created_at: row.created_at, updated_at: row.updated_at };
  }
  async create(actor, data) {
    assert(actor.role === 'partner', 403, 'PARTNER_REQUIRED');
    assert(data.name && data.id_number, 422, 'NAME_AND_ID_NUMBER_REQUIRED');
    const tenant = await this.tenant(actor.tenant_id);
    const { id = randomUUID(), actor_id: actorId, ...fields } = data;
    if (actorId) assert(await this.db('platform_actors').where({ id: actorId, tenant_id: actor.tenant_id }).first(), 404, 'ACTOR_NOT_FOUND');
    const encrypted = await this.encryption.transform('encrypt', tenant, fields);
    await this.db.transaction(async trx => { await trx('platform_customers').insert({ id, tenant_id: actor.tenant_id, actor_id: actorId, data: encrypted, encryption_format: this.encryption.cfg.encryptionMock ? 'synthetic-plaintext' : 'legacy-v1' }); await audit(trx, actor.tenant_id, actorId, id, 'customer.created'); });
    return this.get(actor, id);
  }
  async update(actor, id, changes) {
    assert(['agent', 'partner'].includes(actor.role), 403, 'FORBIDDEN');
    assert(!changes.id && !changes.actor_id, 422, 'IMMUTABLE_IDENTIFIER');
    const tenant = await this.tenant(actor.tenant_id);
    await this.db.transaction(async trx => {
      const row = await trx('platform_customers').where({ id, tenant_id: actor.tenant_id }).whereNull('deleted_at').forUpdate().first(); assert(row, 404, 'CUSTOMER_NOT_FOUND');
      const plain = await this.encryption.transform('decrypt', tenant, row.data);
      const encrypted = await this.encryption.transform('encrypt', tenant, { ...plain, ...changes });
      await trx('platform_customers').where({ id }).update({ data: encrypted, updated_at: new Date() });
      await audit(trx, actor.tenant_id, actor.sub, id, 'customer.updated', { fields: Object.keys(changes) });
    }); return this.get(actor, id);
  }
  async remove(actor, id) {
    assert(actor.role === 'partner', 403, 'PARTNER_REQUIRED');
    await this.db.transaction(async trx => {
      const row = await trx('platform_customers').where({ id, tenant_id: actor.tenant_id }).forUpdate().first(); assert(row, 404, 'CUSTOMER_NOT_FOUND');
      assert(!await trx('platform_calls').where({ user_id: id }).whereIn('state', activeStates).first(), 409, 'CUSTOMER_HAS_ACTIVE_CALL');
      await trx('platform_customers').where({ id }).update({ deleted_at: new Date() }); await audit(trx, actor.tenant_id, actor.sub, id, 'customer.soft_deleted');
    });
  }
  async applyDecision(data) {
    assert(['verified', 'not_verified'].includes(data.outcome), 422, 'INVALID_OUTCOME');
    return this.db.transaction(async trx => {
      const call = await trx('platform_calls').where({ id: data.call_id, tenant_id: data.tenant_id, user_id: data.user_id }).forUpdate().first();
      assert(call && ['completing', 'completed'].includes(call.state) && call.outcome === data.outcome, 409, 'CALL_DECISION_MISMATCH');
      assert(call.consented_at, 409, 'CONSENT_REQUIRED');
      assert(await trx('platform_recordings').where({ call_id: call.id, state: 'stored' }).whereNotNull('sha256').first(), 409, 'RECORDING_NOT_STORED');
      const prior = await trx('platform_decisions').where({ call_id: call.id }).first(); if (prior) { assert(prior.outcome === data.outcome, 409, 'DECISION_CONFLICT'); return prior; }
      const updated = await trx('platform_customers').where({ id: data.user_id, tenant_id: data.tenant_id }).whereNull('deleted_at').update({ verification_status: data.outcome, updated_at: new Date() }); assert(updated, 404, 'CUSTOMER_NOT_FOUND');
      const [decision] = await trx('platform_decisions').insert(data).returning('*');
      await audit(trx, data.tenant_id, call.agent_id, data.user_id, 'customer.verification_completed', { call_id: call.id, outcome: data.outcome }); return decision;
    });
  }
}
