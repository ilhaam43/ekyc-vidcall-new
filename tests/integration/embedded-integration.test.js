import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { hash } from '@ekyc/shared/auth';
import request from 'supertest';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDb } from '@ekyc/shared/db';
import { createApp } from '../../ekyc-vidcall-backend/src/app.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test') || process.env.NODE_ENV === 'production') throw new Error('Integration tests require an isolated *_test PostgreSQL database');
const db = createDb(testUrl);
const tenantId = randomUUID(); const otherTenantId = randomUUID();
const customerId = randomUUID(); const otherCustomerId = randomUUID();
const agentIds = Array.from({ length: 4 }, () => randomUUID());
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const cfg = {
  jwtSecret: 'local-integration-test-jwt-secret-long-enough', gatewaySecret: 'local-integration-test-gateway-secret',
  internalSecret: 'local-integration-test-internal-secret', recordingSecret: 'local-integration-test-recording-secret',
  publicOrigin: 'http://localhost:5173', production: false, recordingSlots: 5,
  jitsiAppId: 'ekyc', jitsiDomain: 'meet.localhost', jitsiSecret: 'local-integration-test-jitsi-secret-long-enough',
};
const app = createApp(db, cfg, { checksum: async () => ({ sha256: 'a'.repeat(64), bytes: 200_000 }) });
const sign = (scope, sub, extra = {}) => jwt.sign({ tenant_id: tenantId, scope, ...extra }, privateKey, { algorithm: 'RS256', issuer: 'test-partner', audience: 'ekyc-integration', subject: sub, jwtid: randomUUID(), expiresIn: 60 });

beforeAll(async () => {
  await db('platform_tenants').insert([{ id: tenantId, name: 'Embedded integration test' }, { id: otherTenantId, name: 'Other tenant' }]);
  await db('platform_customers').insert([
    { id: customerId, tenant_id: tenantId, data: { name: 'Synthetic customer' }, encryption_format: 'synthetic-plaintext' },
    { id: otherCustomerId, tenant_id: otherTenantId, data: { name: 'Other customer' }, encryption_format: 'synthetic-plaintext' },
  ]);
  await db('platform_agents').insert(agentIds.map((id, index) => ({ id, tenant_id: tenantId, username: `embedded-${id}`, name: `Agent ${index + 1}`, password_hash: 'unused' })));
  await db('platform_agent_identities').insert(agentIds.map((id, index) => ({ tenant_id: tenantId, external_subject: `staff-${index + 1}`, agent_id: id })));
  await db('platform_integrations').insert({ tenant_id: tenantId, issuer: 'test-partner', audience: 'ekyc-integration', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }), staff_origin: 'http://localhost:5173', agent_launch_url: 'http://localhost:5173/integrations/agent', customer_entry_url: 'http://localhost:5173/partner/customer', active: true });
  await db('platform_quotas').insert({ tenant_id: tenantId, service: 'videocalls.post', remaining: 10 });
});

afterAll(async () => {
  const callIds = (await db('platform_calls').where({ tenant_id: tenantId }).select('id')).map(row => row.id);
  await db('platform_sessions').where({ tenant_id: tenantId }).del();
  await db('platform_link_grants').where({ tenant_id: tenantId }).del();
  await db('platform_integration_jtis').where({ tenant_id: tenantId }).del();
  await db('platform_outbox').whereRaw("payload->>'tenant_id' = ?", [tenantId]).del();
  await db('platform_audit').where({ tenant_id: tenantId }).del();
  await db('platform_recording_slots').whereIn('recording_id', db('platform_recordings').select('id').whereIn('call_id', callIds)).update({ recording_id: null });
  await db('platform_recordings').whereIn('call_id', callIds).del();
  await db('platform_calls').where({ tenant_id: tenantId }).del();
  await db('platform_quotas').where({ tenant_id: tenantId }).del();
  await db('platform_agent_identities').where({ tenant_id: tenantId }).del();
  await db('platform_integrations').where({ tenant_id: tenantId }).del();
  await db('platform_agents').where({ tenant_id: tenantId }).del();
  await db('platform_customers').whereIn('tenant_id', [tenantId, otherTenantId]).del();
  await db('platform_tenants').whereIn('id', [tenantId, otherTenantId]).del();
  await db.destroy();
});

test('individual agent links are single-use and reject replay or unmapped staff', async () => {
  for (let index = 0; index < 4; index++) {
    const assertion = sign('agent:launch', `staff-${index + 1}`);
    const link = await request(app).post('/api/v2/integrations/agent-links').send({ assertion }).expect(200);
    expect(link.body.data.agent_url).toContain('/integrations/agent#code=');
    await request(app).post('/api/v2/integrations/agent-links').send({ assertion }).expect(409);
    const code = new URL(link.body.data.agent_url).hash.slice('#code='.length);
    const exchanged = await request(app).post('/api/v2/sessions/agent/link').send({ code }).expect(200);
    expect(exchanged.body.role).toBe('agent');
    expect(exchanged.body.source).toBe('integration');
    await request(app).post('/api/v2/sessions/agent/link').send({ code }).expect(401);
  }
  await request(app).post('/api/v2/integrations/agent-links').send({ assertion: sign('agent:launch', 'unmapped') }).expect(403);
  await request(app).post('/api/v2/integrations/agent-links').send({ assertion: sign('queue:create', 'staff-1') }).expect(401);
  const expired = jwt.sign({ tenant_id: tenantId, scope: 'agent:launch', iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 }, privateKey, { algorithm: 'RS256', issuer: 'test-partner', audience: 'ekyc-integration', subject: 'staff-1', jwtid: randomUUID() });
  await request(app).post('/api/v2/integrations/agent-links').send({ assertion: expired }).expect(401);
  const expiring = await request(app).post('/api/v2/integrations/agent-links').send({ assertion: sign('agent:launch', 'staff-1') }).expect(200);
  const expiringCode = new URL(expiring.body.data.agent_url).hash.slice('#code='.length);
  await db('platform_link_grants').where({ code_hash: hash(expiringCode) }).update({ expires_at: new Date(Date.now() - 1000) });
  await request(app).post('/api/v2/sessions/agent/link').send({ code: expiringCode }).expect(401);
});

test('queue link retries use one call and customer sessions cannot access another call', async () => {
  const body = { customer_id: customerId, external_request_id: 'request-12345678' };
  const first = await request(app).post('/api/v2/integrations/queue-links').set('Authorization', `Bearer ${sign('queue:create', 'partner-backend')}`).send(body).expect(200);
  const second = await request(app).post('/api/v2/integrations/queue-links').set('Authorization', `Bearer ${sign('queue:create', 'partner-backend')}`).send(body).expect(200);
  expect(second.body.data.call_id).toBe(first.body.data.call_id);
  expect(second.body.data.customer_url).not.toBe(first.body.data.customer_url);
  expect((await db('platform_quotas').where({ tenant_id: tenantId, service: 'videocalls.post' }).first()).remaining).toBe(9);
  const code = new URL(first.body.data.customer_url).hash.slice('#code='.length);
  const customer = await request(app).post('/api/v2/sessions/customer').send({ code }).expect(200);
  expect(customer.body.call_id).toBe(first.body.data.call_id);
  await request(app).post('/api/v2/sessions/customer').send({ code }).expect(401);
  await request(app).get(`/api/v2/calls/${first.body.data.call_id}`).set('Authorization', `Bearer ${customer.body.access_token}`).expect(200);
  const other = await db('platform_calls').insert({ id: randomUUID(), tenant_id: tenantId, user_id: customerId, room: `other-${randomUUID()}`, registration_key: randomUUID(), source: 'integration', state: 'completed' }).returning('*');
  await request(app).get(`/api/v2/calls/${other[0].id}`).set('Authorization', `Bearer ${customer.body.access_token}`).expect(404);
  await request(app).post(`/api/v2/calls/${other[0].id}/consent`).set('Authorization', `Bearer ${customer.body.access_token}`).send({ accepted: true, version: 'recording-v1' }).expect(404);
  const customerClaims = jwt.decode(customer.body.access_token);
  await request(app).post('/internal/jitsi/admission').set('x-internal-secret', cfg.internalSecret).send({ session_id: customerClaims.sid, user_id: customerId, room: other[0].room }).expect(403);
  const basic = await app.locals.sessions.create('agent', agentIds[0], tenantId);
  await request(app).get('/v1/calls/queues').set('Authorization', `Bearer ${basic.token}`).expect(200).then(response => expect(response.body.data).toEqual([]));
  await request(app).get(`/api/v2/calls/${first.body.data.call_id}`).set('Authorization', `Bearer ${basic.token}`).expect(404);
  await request(app).post(`/api/v2/calls/${first.body.data.call_id}/claim`).set('Authorization', `Bearer ${basic.token}`).expect(409);
  await request(app).post('/api/v2/integrations/queue-links').set('Authorization', `Bearer ${sign('queue:create', 'partner-backend')}`).send({ customer_id: otherCustomerId, external_request_id: 'request-99999999' }).expect(404);
  await request(app).post('/api/v2/integrations/queue-links').set('Authorization', `Bearer ${sign('queue:create', 'partner-backend')}`).send({ customer_id: customerId, external_request_id: 'request-different' }).expect(409);
});

test('direct-call launch checks tenant and assignment, then one agent claims the call', async () => {
  const call = await db('platform_calls').where({ tenant_id: tenantId, registration_key: 'integration:request-12345678' }).first();
  const tokens = [];
  for (let index = 0; index < 4; index++) {
    const link = await request(app).post('/api/v2/integrations/agent-links').send({ assertion: sign('agent:launch', `staff-${index + 1}`, { call_id: call.id }) }).expect(200);
    const code = new URL(link.body.data.agent_url).hash.slice('#code='.length);
    const session = await request(app).post('/api/v2/sessions/agent/link').send({ code }).expect(200);
    expect(session.body.launch_call_id).toBe(call.id);
    tokens.push(session.body.access_token);
  }
  const claims = await Promise.all(tokens.map(token => request(app).post(`/api/v2/calls/${call.id}/claim`).set('Authorization', `Bearer ${token}`)));
  expect(claims.filter(response => response.status === 200)).toHaveLength(1);
  expect(claims.filter(response => response.status === 409)).toHaveLength(3);
  const winner = claims.find(response => response.status === 200).body.data.agent_id;
  const winnerToken = tokens[agentIds.indexOf(winner)];
  await request(app).post('/api/v2/integrations/agent-links').send({ assertion: sign('agent:launch', `staff-${agentIds.findIndex(id => id !== winner) + 1}`, { call_id: call.id }) }).expect(403);
  const customerLink = await request(app).post('/api/v2/integrations/queue-links').set('Authorization', `Bearer ${sign('queue:create', 'partner-backend')}`).send({ customer_id: customerId, external_request_id: 'request-12345678' }).expect(200);
  const customerCode = new URL(customerLink.body.data.customer_url).hash.slice('#code='.length);
  const customerSession = await request(app).post('/api/v2/sessions/customer').send({ code: customerCode }).expect(200);
  await request(app).post(`/api/v2/calls/${call.id}/consent`).set('Authorization', `Bearer ${customerSession.body.access_token}`).send({ accepted: true, version: 'recording-v1' }).expect(200);
  const agentRoom = await request(app).post(`/api/v2/calls/${call.id}/admission`).set('Authorization', `Bearer ${winnerToken}`).send({ room_label: 'Synthetic customer' }).expect(200);
  expect(agentRoom.headers['cache-control']).toBe('no-store');
  expect(agentRoom.body.data).toMatchObject({ server_url: `https://${cfg.jitsiDomain}`, role: 'agent' });
  const agentJitsiClaims = jwt.verify(agentRoom.body.data.jwt, cfg.jitsiSecret);
  expect(agentRoom.body.data.token_expires_at).toBe(new Date(agentJitsiClaims.exp * 1000).toISOString());
  expect(agentJitsiClaims.moderator).toBe(true);
  expect(agentJitsiClaims.context.user).toMatchObject({ moderator: true, affiliation: 'owner' });
  const room = agentRoom.body.data.room;
  await request(app).post('/internal/jitsi/participant-joined').set('x-internal-secret', cfg.internalSecret).send({ session_id: jwt.decode(winnerToken).sid, user_id: winner, room }).expect(200);
  const customerRoom = await request(app).post(`/api/v2/calls/${call.id}/admission`).set('Authorization', `Bearer ${customerSession.body.access_token}`).send({}).expect(200);
  expect(customerRoom.body.data).toMatchObject({ server_url: `https://${cfg.jitsiDomain}`, room, role: 'customer' });
  const customerJitsiClaims = jwt.verify(customerRoom.body.data.jwt, cfg.jitsiSecret);
  expect(customerJitsiClaims.moderator).toBe(false);
  expect(customerJitsiClaims.context.user).toMatchObject({ moderator: false, affiliation: 'member' });
  await request(app).post('/internal/jitsi/participant-joined').set('x-internal-secret', cfg.internalSecret).send({ session_id: jwt.decode(customerSession.body.access_token).sid, user_id: customerId, room }).expect(200);
  const recording = await db('platform_recordings').where({ call_id: call.id }).first();
  await app.locals.calls.recordingEvent({ event_id: randomUUID(), call_id: call.id, recording_id: recording.id, worker_id: recording.worker_id, status: 'failed' });
  await request(app).get(`/api/v2/calls/${call.id}`).set('Authorization', `Bearer ${customerSession.body.access_token}`).expect(200).then(response => expect(response.body.data.state).toBe('failed'));
  await request(app).post(`/api/v2/calls/${call.id}/decision`).set('Authorization', `Bearer ${winnerToken}`).send({ outcome: 'verified' }).expect(409);
  const wrongTenantCall = randomUUID();
  await db('platform_calls').insert({ id: wrongTenantCall, tenant_id: otherTenantId, user_id: otherCustomerId, room: `other-${randomUUID()}`, registration_key: randomUUID(), state: 'waiting' });
  await request(app).post('/api/v2/integrations/agent-links').send({ assertion: sign('agent:launch', 'staff-1', { call_id: wrongTenantCall }) }).expect(403);
  await db('platform_calls').where({ id: wrongTenantCall }).del();
});
