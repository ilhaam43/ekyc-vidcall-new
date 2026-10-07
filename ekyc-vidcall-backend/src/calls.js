import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { assert } from '@ekyc/shared/errors';
import { activeStates } from '@ekyc/shared/db';
import { enqueue, audit } from '@ekyc/shared/outbox';
import { hash } from '@ekyc/shared/auth';

const terminal = ['completed', 'canceled', 'missed', 'failed'];
function roomLabel(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'nasabah';
}
export function snapshot(call) {
  const { notification: _notification, registration_key: _key, ...safe } = call;
  return { ...safe, application_id: call.tenant_id, status: call.state === 'completed' ? 'done' : ['assigned', 'preparing_recording', 'ringing', 'active', 'completing'].includes(call.state) ? 'calling' : call.state, verification_status: call.outcome || 'waiting' };
}
export class Calls {
  constructor(db, cfg, storage) { this.db = db; this.cfg = cfg; this.storage = storage; }
  async get(id, actor, trx = this.db, lock = false) {
    let query = trx('platform_calls').where({ id, tenant_id: actor.tenant_id });
    if (actor.role === 'customer') query = query.where({ user_id: actor.sub, ...(actor.call_id ? { id: actor.call_id } : {}) });
    if (['agent', 'customer'].includes(actor.role)) query = query.where({ source: actor.source || 'basic' });
    if (lock) query = query.forUpdate();
    const call = await query.first(); assert(call, 404, 'CALL_NOT_FOUND'); return call;
  }
  owns(call, actor) { assert(actor.role === 'agent' && call.agent_id === actor.sub, 403, 'CALL_NOT_ASSIGNED_TO_AGENT'); }
  async emit(trx, call, name = 'call.state') {
    const payload = snapshot(call);
    await enqueue(trx, 'socket', `${call.id}:${call.version}:${name}`, { tenant_id: call.tenant_id, source: call.source, user_id: call.user_id, agent_id: call.agent_id, name, data: payload });
    if (name !== 'queue.change') await enqueue(trx, 'socket', `${call.id}:${call.version}:queue.change`, { tenant_id: call.tenant_id, source: call.source, name: 'queue.change', data: { call_id: call.id, call: payload } });
  }
  async update(trx, call, patch) {
    const [updated] = await trx('platform_calls').where({ id: call.id }).update({ ...patch, version: call.version + 1, updated_at: new Date() }).returning('*');
    await this.emit(trx, updated); return updated;
  }
  async inviteCustomer(trx, call) {
    await enqueue(trx, 'socket', `${call.id}:invite`, { tenant_id: call.tenant_id, source: call.source, user_id: call.user_id, customer_only: true, name: 'call.start', data: { call_id: call.id, room: { name: call.room } } });
    if (call.notification.providers?.includes('apn')) await enqueue(trx, 'apn', `${call.id}:invite:apn`, { token: call.notification.device_token, event: 'call.start', data: { call_id: call.id, room: { name: call.room } } });
  }
  async register(actor, data, key, source = 'basic', externalRequestId = null, transaction = null) {
    assert(typeof key === 'string' && key.length >= 8 && key.length <= 128, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const register = async trx => {
      // Serialize registration per tenant before checking deduplication and quota.
      const tenant = await trx('platform_tenants').where({ id: actor.tenant_id, active: true }).forUpdate().first(); assert(tenant, 403, 'TENANT_INACTIVE');
      const prior = await trx('platform_calls').where({ tenant_id: actor.tenant_id, registration_key: key }).first();
      if (prior) { assert(prior.user_id === data.user_id && prior.source === source, 409, 'IDEMPOTENCY_KEY_REUSED'); return prior; }
      const user = await trx('platform_customers').where({ id: data.user_id, tenant_id: actor.tenant_id }).first(); assert(user, 404, 'CUSTOMER_NOT_FOUND');
      const existing = await trx('platform_calls').where({ tenant_id: actor.tenant_id, user_id: data.user_id }).whereIn('state', activeStates).first();
      if (existing) {
        assert(existing.source === source, 409, 'CUSTOMER_ALREADY_QUEUED');
        if (source === 'integration') assert(existing.registration_key === key, 409, 'CUSTOMER_ALREADY_QUEUED');
        return existing;
      }
      const quota = await trx('platform_quotas').where({ tenant_id: actor.tenant_id, service: 'videocalls.post' }).forUpdate().first();
      assert(quota && quota.remaining > 0, 403, 'CALL_QUOTA_EXHAUSTED');
      await trx('platform_quotas').where({ tenant_id: actor.tenant_id, service: 'videocalls.post' }).decrement('remaining', 1);
      const id = randomUUID();
      // Keep the Jitsi room opaque and collision-resistant, but make its purpose
      // recognizable in Jitsi's built-in room title.
      const room = `verifikasi-${id.replaceAll('-', '').slice(0, 20)}`;
      const [call] = await trx('platform_calls').insert({ id, tenant_id: actor.tenant_id, user_id: data.user_id, room, registration_key: key, source, external_request_id: externalRequestId, notification: { providers: data.notif_provider || ['socketio'], device_token: data.device_token } }).returning('*');
      await this.emit(trx, call); await audit(trx, actor.tenant_id, null, user.id, 'call.registered', { call_id: id }); return call;
    };
    return transaction ? register(transaction) : this.db.transaction(register);
  }
  async claim(actor, userId, callId) {
    return this.db.transaction(async trx => {
      const agent = await trx('platform_agents').where({ id: actor.sub, tenant_id: actor.tenant_id, active: true }).forUpdate().first(); assert(agent, 401, 'AGENT_INACTIVE');
      const current = await trx('platform_calls').where({ agent_id: actor.sub, tenant_id: actor.tenant_id }).whereIn('state', activeStates).first();
      if (current) { assert(current.source === (actor.source || 'basic') && (!callId || current.id === callId), 409, 'AGENT_ALREADY_IN_CALL'); return current; }
      let query = trx('platform_calls').where({ tenant_id: actor.tenant_id, source: actor.source || 'basic', state: 'waiting' }).orderBy('created_at').forUpdate().skipLocked();
      if (userId) query = query.where({ user_id: userId });
      if (callId) query = query.where({ id: callId });
      const call = await query.first(); assert(call, 409, 'QUEUE_EMPTY');
      const slot = await trx('platform_recording_slots').whereNull('recording_id').where('id', '<=', this.cfg.recordingSlots || 5).orderBy('id').forUpdate().skipLocked().first(); assert(slot, 409, 'RECORDING_CAPACITY_UNAVAILABLE');
      const recordingId = randomUUID();
      await trx('platform_recordings').insert({ id: recordingId, call_id: call.id, tenant_id: call.tenant_id, worker_id: `jibri${slot.id}` });
      await trx('platform_recording_slots').where({ id: slot.id }).update({ recording_id: recordingId });
      const updated = await this.update(trx, call, { agent_id: actor.sub, state: 'assigned', agent_seen_at: new Date() });
      await audit(trx, actor.tenant_id, actor.sub, call.user_id, 'call.assigned', { call_id: call.id }); return updated;
    });
  }
  async consent(id, actor, version) {
    return this.db.transaction(async trx => {
      const call = await this.get(id, actor, trx, true);
      assert(actor.role === 'customer' && !terminal.includes(call.state), 409, 'CALL_NOT_AVAILABLE');
      if (call.consented_at) return call;
      return this.update(trx, call, { consented_at: new Date(), consent_version: version, customer_seen_at: new Date() });
    });
  }
  async admission(id, actor, displayLabel) {
    return this.db.transaction(async trx => {
      let call = await this.get(id, actor, trx, true);
      const recording = await trx('platform_recordings').where({ call_id: id }).orderBy('created_at', 'desc').first();
      if (actor.role === 'agent') {
        this.owns(call, actor); assert(['assigned', 'preparing_recording', 'ringing', 'active'].includes(call.state), 409, 'CALL_NOT_JOINABLE');
        if (call.state === 'assigned') {
          const slug = roomLabel(displayLabel);
          const room = `verifikasi-${slug}-${call.id.replaceAll('-', '').slice(0, 8)}`;
          call = await this.update(trx, call, { room, state: 'preparing_recording' });
        }
      } else {
        assert(call.consented_at, 409, 'CONSENT_REQUIRED');
        assert(['ringing', 'active'].includes(call.state) && ['reserved', 'recording'].includes(recording?.state), 409, 'RECORDING_NOT_RESERVED');
      }
      const moderator = actor.role === 'agent';
      const token = jwt.sign({ aud: this.cfg.jitsiAppId, iss: this.cfg.jitsiAppId, sub: this.cfg.jitsiDomain, room: call.room, moderator, context: { user: { id: actor.sub, session_id: actor.sid, name: moderator ? 'Petugas verifikasi' : 'Nasabah', moderator, affiliation: moderator ? 'owner' : 'member' }, features: { recording: false } } }, this.cfg.jitsiSecret, { algorithm: 'HS256', expiresIn: '5m' });
      return {
        domain: this.cfg.jitsiDomain,
        server_url: `https://${this.cfg.jitsiDomain}`,
        room: call.room,
        jwt: token,
        token_expires_at: new Date(jwt.decode(token).exp * 1000).toISOString(),
        role: actor.role,
        recording_id: recording?.id,
        call: snapshot(call),
      };
    });
  }
  async participantJoined(actor, room) {
    return this.db.transaction(async trx => {
      const call = await trx('platform_calls').where({ room, tenant_id: actor.tenant_id }).forUpdate().first(); assert(call, 404, 'CALL_NOT_FOUND');
      assert(call.source === (actor.source || 'basic') && (!actor.call_id || call.id === actor.call_id), 403, 'CALL_NOT_JOINABLE');
      const recording = await trx('platform_recordings').where({ call_id: call.id }).forUpdate().first(); assert(recording, 404, 'RECORDING_NOT_RESERVED');
      if (actor.role === 'agent') {
        this.owns(call, actor);
        assert(['preparing_recording', 'ringing', 'active'].includes(call.state), 409, 'CALL_NOT_JOINABLE');
        if (call.state === 'preparing_recording') {
          const updated = await this.update(trx, call, { state: 'ringing', agent_seen_at: new Date() });
          await this.inviteCustomer(trx, updated);
          return updated;
        }
        if (call.state === 'ringing') await trx('platform_calls').where({ id: call.id }).update({ agent_seen_at: new Date() });
        return call;
      }
      assert(actor.role === 'customer' && call.user_id === actor.sub && call.consented_at, 403, 'CALL_NOT_JOINABLE');
      assert(['ringing', 'active'].includes(call.state), 409, 'CALL_NOT_JOINABLE');
      const joinedAt = new Date();
      const updated = call.customer_joined_at ? call : await this.update(trx, call, { customer_seen_at: joinedAt, customer_joined_at: joinedAt });
      if (call.customer_joined_at) await trx('platform_calls').where({ id: call.id }).update({ customer_seen_at: joinedAt });
      if (call.state === 'ringing' && recording.state === 'reserved') {
        await enqueue(trx, 'recording.start', `${call.id}:record`, { call_id: call.id });
      }
      return updated;
    });
  }
  async once(trx, event) {
    const digest = hash(JSON.stringify(event));
    const inserted = await trx('platform_events').insert({ id: event.event_id, digest }).onConflict('id').ignore().returning('id');
    if (!inserted.length) { const prior = await trx('platform_events').where({ id: event.event_id }).first(); assert(prior.digest === digest, 409, 'EVENT_ID_REUSED'); return false; }
    return true;
  }
  async recordingEvent(event) {
    return this.db.transaction(async trx => {
      const call = await trx('platform_calls').where({ id: event.call_id }).forUpdate().first(); assert(call, 404, 'CALL_NOT_FOUND');
      const recording = await trx('platform_recordings').where({ id: event.recording_id, call_id: call.id }).forUpdate().first(); assert(recording, 404, 'RECORDING_NOT_FOUND');
      if (!await this.once(trx, event)) return call;
      if (event.status === 'started') {
        if (recording.state === 'recording') { assert(recording.worker_id === event.worker_id, 409, 'WRONG_RECORDER'); return call; }
        assert(call.state === 'ringing' && call.customer_joined_at && recording.state === 'reserved' && recording.worker_id === event.worker_id, 409, 'UNEXPECTED_RECORDING_START');
        await trx('platform_recordings').where({ id: recording.id }).update({ state: 'recording', worker_id: event.worker_id, started_at: new Date(), heartbeat_at: new Date() });
        const updated = await this.update(trx, call, { state: 'active', started_at: new Date() });
        return updated;
      }
      assert(!recording.worker_id || recording.worker_id === event.worker_id, 409, 'WRONG_RECORDER');
      if (event.status === 'heartbeat') { assert(recording.state === 'recording', 409, 'RECORDING_NOT_ACTIVE'); await trx('platform_recordings').where({ id: recording.id }).update({ heartbeat_at: new Date() }); return call; }
      if (recording.state === 'stored') return call;
      if (terminal.includes(call.state)) {
        await trx('platform_recordings').where({ id: recording.id }).update({ state: event.status === 'failed' ? 'failed' : 'stopped', stopped_at: new Date() });
        await trx('platform_recording_slots').where({ recording_id: recording.id }).update({ recording_id: null }); return call;
      }
      if (event.status === 'failed' || call.state !== 'completing') return this.failLocked(trx, call, 'RECORDING_INTERRUPTED');
      await trx('platform_recordings').where({ id: recording.id }).update({ state: 'stopped', stopped_at: new Date() });
      await enqueue(trx, 'recording.upload', `${recording.id}:upload`, { recording_id: recording.id, call_id: call.id });
      await trx('platform_recording_slots').where({ recording_id: recording.id }).update({ recording_id: null }); return call;
    });
  }
  async stored(event) {
    const record = await this.db('platform_recordings').where({ id: event.recording_id }).first(); assert(record, 404, 'RECORDING_NOT_FOUND');
    const callForKey = await this.db('platform_calls').where({ id: record.call_id }).first(); assert(callForKey, 404, 'CALL_NOT_FOUND');
    const expected = `${record.tenant_id}/${callForKey.user_id}/${record.call_id}/${record.id}.mp4`;
    assert(event.key === expected, 422, 'INVALID_OBJECT_KEY');
      const actual = await this.storage.checksum(this.cfg.recordingBucket, expected);
      assert(actual.sha256 === event.sha256 && actual.bytes === event.bytes, 422, 'CHECKSUM_MISMATCH');
      assert(actual.bytes >= 100_000, 422, 'RECORDING_INCOMPLETE');
    return this.db.transaction(async trx => {
      const call = await trx('platform_calls').where({ id: record.call_id }).forUpdate().first();
      const recording = await trx('platform_recordings').where({ id: record.id }).forUpdate().first();
      if (!await this.once(trx, event)) return call;
      assert(recording.started_at, 409, 'RECORDING_NEVER_STARTED');
      assert(['stopped', 'stored', 'failed'].includes(recording.state), 409, 'RECORDING_NOT_FINALIZED');
      await trx('platform_recordings').where({ id: record.id }).update({ state: 'stored', object_key: expected, sha256: actual.sha256, bytes: actual.bytes, updated_at: new Date() });
      if (call.state === 'completing') await enqueue(trx, 'verification', `${call.id}:verification`, { call_id: call.id, tenant_id: call.tenant_id, user_id: call.user_id, outcome: call.outcome });
      await audit(trx, call.tenant_id, null, call.user_id, 'recording.stored', { call_id: call.id, recording_id: record.id }); return call;
    });
  }
  async decide(id, actor, data) {
    return this.db.transaction(async trx => {
      const call = await this.get(id, actor, trx, true); this.owns(call, actor);
      if (['completing', 'completed'].includes(call.state)) { assert(call.outcome === data.outcome, 409, 'DECISION_ALREADY_RECORDED'); return call; }
      assert(call.state === 'active', 409, 'CALL_NOT_ACTIVE');
      const recording = await trx('platform_recordings').where({ call_id: id, state: 'recording' }).first(); assert(recording && call.consented_at, 409, 'RECORDED_CONSENT_REQUIRED');
      const updated = await this.update(trx, call, { state: 'completing', outcome: data.outcome, reason: data.reason || null, ended_at: new Date() });
      await enqueue(trx, 'conference.stop', `${id}:stop`, { call_id: id, room: call.room });
      await audit(trx, actor.tenant_id, actor.sub, call.user_id, 'call.decision_pending', { call_id: id, outcome: data.outcome }); return updated;
    });
  }
  async failLocked(trx, call, reason, state = 'failed') {
    if (terminal.includes(call.state)) return call;
    const updated = await this.update(trx, call, { state, outcome: null, reason, ended_at: new Date() });
    // Never free an occupied slot until the recorder confirms stop. A watchdog alert requires operator reconciliation if it is unreachable.
    const records = await trx('platform_recordings').where({ call_id: call.id }).whereIn('state', ['reserved', 'recording']).returning('*').update({ state: 'failed', updated_at: new Date() });
    for (const recording of records) if (!recording.started_at) await trx('platform_recording_slots').where({ recording_id: recording.id }).update({ recording_id: null });
    await enqueue(trx, 'conference.stop', `${call.id}:stop`, { call_id: call.id, room: call.room });
    await this.emit(trx, updated, state === 'missed' ? 'call.missed' : 'call.end'); return updated;
  }
  async cancel(id, actor, reason = 'USER_CANCELED', state = 'canceled') {
    return this.db.transaction(async trx => { const call = await this.get(id, actor, trx, true); if (actor.role === 'agent') this.owns(call, actor); assert(call.state !== 'completing', 409, 'COMPLETION_PENDING'); return this.failLocked(trx, call, reason, state); });
  }
  async complete(payload) {
    return this.db.transaction(async trx => {
      const call = await trx('platform_calls').where({ id: payload.call_id, tenant_id: payload.tenant_id }).forUpdate().first(); assert(call, 404, 'CALL_NOT_FOUND');
      if (call.state === 'completed') return call;
      assert(call.state === 'completing', 409, 'CALL_NOT_COMPLETING');
      const decision = await trx('platform_decisions').where({ call_id: call.id, outcome: call.outcome }).first(); assert(decision, 409, 'MASTER_DECISION_PENDING');
      const updated = await this.update(trx, call, { state: 'completed' }); await this.emit(trx, updated, 'call.end');
      if (call.notification.providers?.includes('apn')) await enqueue(trx, 'apn', `${call.id}:end:apn`, { token: call.notification.device_token, event: 'call.end', data: { user_id: call.user_id, status: call.outcome } });
      return updated;
    });
  }
  async heartbeat(id, actor) {
    const call = await this.get(id, actor); if (actor.role === 'agent') this.owns(call, actor);
    if (!terminal.includes(call.state)) await this.db('platform_calls').where({ id }).update({ [actor.role === 'agent' ? 'agent_seen_at' : 'customer_seen_at']: new Date() });
    return snapshot(call);
  }
  async sweep() {
    const pending = await this.db('platform_calls').whereIn('state', ['assigned', 'preparing_recording', 'ringing', 'active']);
    for (const item of pending) await this.db.transaction(async trx => {
      const call = await trx('platform_calls').where({ id: item.id }).forUpdate().first();
      if (!['assigned', 'preparing_recording', 'ringing', 'active'].includes(call.state)) return;
      const recording = await trx('platform_recordings').where({ call_id: call.id }).first();
      const age = (date) => (Date.now() - new Date(date).getTime()) / 1000;
      if (age(call.agent_seen_at) > this.cfg.reconnectGrace) return this.failLocked(trx, call, 'AGENT_DISCONNECTED');
      if (recording.state === 'reserved' && age(recording.created_at) > this.cfg.recordingTimeout) return this.failLocked(trx, call, call.state === 'ringing' ? 'CUSTOMER_JOIN_TIMEOUT' : 'RECORDING_TIMEOUT');
      if (recording.state === 'recording' && age(recording.heartbeat_at) > 45) return this.failLocked(trx, call, 'RECORDER_HEARTBEAT_LOST');
    });
  }
}
