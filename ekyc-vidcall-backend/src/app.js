import { baseApp, finishApp, loginLimiter } from '@ekyc/shared/http';
import { auth, gateway, internal, signedRecording } from '@ekyc/shared/auth';
import { body } from '@ekyc/shared/contracts';
import { assert } from '@ekyc/shared/errors';
import { activeStates } from '@ekyc/shared/db';
import { Calls, snapshot } from './calls.js';
import { Sessions, sessionReply, cookie } from './sessions.js';
import { Jibri } from './jibri.js';
import { Integration } from './integration.js';
import { rateLimit } from 'express-rate-limit';
export function createApp(db, cfg, storage) {
  const app = baseApp(cfg, db); const calls = new Calls(db, cfg, storage); const sessions = new Sessions(db, cfg, calls);
  const integration = new Integration(db, calls, sessions);
  const integrationLimiter = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
  const linkExchangeLimiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  const member = auth(cfg, db), agent = auth(cfg, db, ['agent']), partner = gateway(cfg);
  const send = (res, data) => res.json({ success: true, data });
  new Jibri(db, cfg, calls).register(app);
  app.post('/internal/jitsi/admission', internal(cfg), async (req, res) => {
    const session = await db('platform_sessions').where({ id: req.body.session_id, subject_id: req.body.user_id }).whereNull('revoked_at').where('expires_at', '>', new Date()).first();
    assert(session && ['agent', 'customer'].includes(session.role), 403, 'SESSION_EXPIRED');
    const actor = { sub: session.subject_id, tenant_id: session.tenant_id, role: session.role, source: session.source, call_id: session.call_id };
    await db.transaction(async trx => {
      const call = await trx('platform_calls').where({ room: req.body.room, tenant_id: session.tenant_id }).forUpdate().first(); assert(call, 404, 'CALL_NOT_FOUND');
      assert(call.source === session.source, 403, 'CALL_NOT_JOINABLE');
      if (session.call_id) assert(call.id === session.call_id, 403, 'CALL_NOT_JOINABLE');
      if (actor.role === 'agent') {
        calls.owns(call, actor); assert(['preparing_recording', 'ringing', 'active'].includes(call.state), 403, 'CALL_NOT_JOINABLE');
      } else {
        assert(call.user_id === actor.sub && call.consented_at && ['ringing', 'active'].includes(call.state), 403, 'CALL_NOT_JOINABLE');
        assert(await trx('platform_recordings').where({ call_id: call.id }).whereIn('state', ['reserved', 'recording']).first(), 403, 'RECORDING_NOT_RESERVED');
      }
    }); send(res, { role: session.role });
  });
  app.post('/internal/jitsi/participant-joined', internal(cfg), async (req, res) => {
    const session = await db('platform_sessions').where({ id: req.body.session_id, subject_id: req.body.user_id }).whereNull('revoked_at').where('expires_at', '>', new Date()).first();
    assert(session && ['agent', 'customer'].includes(session.role), 403, 'SESSION_EXPIRED');
    if (session.call_id) {
      const call = await db('platform_calls').where({ room: req.body.room, tenant_id: session.tenant_id }).first();
      assert(call?.id === session.call_id, 403, 'CALL_NOT_JOINABLE');
    }
    send(res, await calls.participantJoined({ sub: session.subject_id, tenant_id: session.tenant_id, role: session.role, source: session.source, call_id: session.call_id }, req.body.room));
  });
  app.post(['/v1/agents/login', '/api/v2/sessions/agent'], loginLimiter(), body('login'), async (req, res) => sessionReply(req, res, cfg, await sessions.login(req.body.username, req.body.password)));
  app.post(['/v1/agents/refresh-token', '/api/v2/sessions/refresh'], loginLimiter(), async (req, res) => {
    const name = req.body.role === 'customer' ? 'customer_refresh' : 'agent_refresh';
    sessionReply(req, res, cfg, await sessions.refresh(cookie(req, name) || req.headers.authorization?.replace(/^Bearer /, ''), req.headers.origin));
  });
  app.post('/api/v2/integrations/agent-links', integrationLimiter, async (req, res) => send(res, await integration.agentLink(req.body?.assertion)));
  app.post('/api/v2/sessions/agent/link', linkExchangeLimiter, async (req, res) => sessionReply(req, res, cfg, await sessions.exchangeAgentLink(req.body?.code, req.headers.origin)));
  app.post('/api/v2/integrations/queue-links', integrationLimiter, async (req, res) => send(res, await integration.queueLink(req.headers.authorization?.replace(/^Bearer /, ''), req.body || {})));
  app.post('/api/v2/integrations/customer-links', integrationLimiter, async (req, res) => send(res, await integration.customerLink(req.headers.authorization?.replace(/^Bearer /, ''), req.body || {})));
  app.post('/api/v2/customer-grants', partner, async (req, res) => send(res, await sessions.grant(req.auth.tenant_id, req.body.user_id)));
  app.post('/api/v2/customer-links', partner, async (req, res) => send(res, await sessions.deferredCustomerLink(req.auth.tenant_id, req.body.user_id, req.body.external_request_id)));
  app.post('/api/v2/sessions/customer', loginLimiter(), async (req, res) => sessionReply(req, res, cfg, await sessions.exchange(req.body.code)));
  app.post(['/v1/agents/logout', '/api/v2/sessions/logout'], member, async (req, res) => {
    await db('platform_sessions').where({ id: req.auth.sid }).update({ revoked_at: new Date(), refresh_hash: null });
    res.clearCookie(req.auth.role === 'agent' ? 'agent_refresh' : 'customer_refresh', { path: '/' });
    app.locals.io?.in(`session:${req.auth.sid}`).disconnectSockets(true); send(res, null);
  });
  app.post('/api/v2/agents/password', agent, body('password'), async (req, res) => { await sessions.password(req.auth, req.body.current_password, req.body.new_password); app.locals.io?.in(`agent:${req.auth.sub}`).disconnectSockets(true); send(res, null); });
  app.get('/v1/agents/profile', agent, async (req, res) => { const user = await db('platform_agents').select('id', 'name', 'username', 'tenant_id', 'active').where({ id: req.auth.sub }).first(); send(res, user); });
  app.get('/v1/agents/analytics', agent, async (req, res) => {
    const rows = await db('platform_calls').where({ tenant_id: req.auth.tenant_id, agent_id: req.auth.sub, source: req.auth.source || 'basic' }).select('state').count('* as count').groupBy('state');
    send(res, { totals: rows, calls_total: { done: Number(rows.find(x => x.state === 'completed')?.count || 0), canceled: rows.filter(x => ['failed', 'missed', 'canceled'].includes(x.state)).reduce((sum, x) => sum + Number(x.count), 0) } });
  });
  app.post('/v1/agents/register', (_req, res) => res.status(403).json({ success: false, error: { code: 'ADMIN_PROVISIONING_REQUIRED' } }));
  app.post(['/v1/calls/register', '/api/v2/calls'], partner, body('register'), async (req, res) => send(res, snapshot(await calls.register(req.auth, req.body, req.headers['idempotency-key']))));
  app.get('/v1/calls/queues', agent, async (req, res) => send(res, (await db('platform_calls').where({ tenant_id: req.auth.tenant_id, source: req.auth.source || 'basic', state: 'waiting' }).orderBy('created_at')).map(snapshot)));
  app.get('/v1/calls/queue-count', agent, async (req, res) => { const row = await db('platform_calls').where({ tenant_id: req.auth.tenant_id, source: req.auth.source || 'basic', state: 'waiting' }).count('* as total').first(); send(res, Number(row.total)); });
  app.post('/v1/calls/start', agent, async (req, res) => send(res, snapshot(await calls.claim(req.auth))));
  app.post('/v1/calls/start/:userId', agent, async (req, res) => send(res, snapshot(await calls.claim(req.auth, req.params.userId))));
  app.post('/api/v2/calls/:id/claim', agent, async (req, res) => send(res, snapshot(await calls.claim(req.auth, null, req.params.id))));
  const current = async actor => db('platform_calls').where({ tenant_id: actor.tenant_id, source: actor.source || 'basic', [actor.role === 'agent' ? 'agent_id' : 'user_id']: actor.sub, ...(actor.role === 'customer' && actor.call_id ? { id: actor.call_id } : {}) }).whereIn('state', activeStates).orderBy('created_at', 'desc').first();
  app.get(['/v1/calls/current', '/api/v2/calls/current'], member, async (req, res) => { const call = await current(req.auth); send(res, call ? snapshot(call) : null); });
  app.post('/v1/calls/stop', agent, async (req, res) => { const call = await current(req.auth); assert(call, 404, 'NO_ACTIVE_CALL'); const { validate } = await import('@ekyc/shared/contracts'); const data = validate('decision', { outcome: req.body.call_status }); send(res, snapshot(await calls.decide(call.id, req.auth, data))); });
  app.post('/v1/calls/missed', agent, async (req, res) => { const call = await current(req.auth); send(res, call ? snapshot(await calls.cancel(call.id, req.auth, 'NO_RESPONSE', 'missed')) : null); });
  app.post('/v1/calls/invite-user', agent, async (req, res) => { const call = await current(req.auth); assert(call && ['ringing', 'active'].includes(call.state), 409, 'RECORDING_NOT_READY'); send(res, { invited: true }); });
  app.post('/v1/calls/unregister/:userId', partner, async (req, res) => { const call = await db('platform_calls').where({ tenant_id: req.auth.tenant_id, user_id: req.params.userId }).whereIn('state', activeStates).first(); send(res, call ? snapshot(await calls.cancel(call.id, req.auth)) : null); });
  app.get('/v1/calls/room/:room', internal(cfg), async (req, res) => { const call = await db('platform_calls').where({ room: req.params.room }).first(); assert(call, 404, 'CALL_NOT_FOUND'); const recording = await db('platform_recordings').where({ call_id: call.id }).first(); send(res, { call_id: call.id, tenant_id: call.tenant_id, recording_id: recording?.id, object_key: recording?.object_key || `${call.tenant_id}/${call.user_id}/${call.id}/${recording?.id}.mp4`, state: call.state }); });
  app.get('/v1/calls/:userId', partner, async (req, res) => { const call = await db('platform_calls').where({ tenant_id: req.auth.tenant_id, user_id: req.params.userId }).orderBy('created_at', 'desc').first(); assert(call, 404, 'CALL_NOT_FOUND'); send(res, snapshot(call)); });
  app.get('/api/v2/calls/:id', member, async (req, res) => send(res, snapshot(await calls.get(req.params.id, req.auth))));
  app.post('/api/v2/calls/:id/consent', auth(cfg, db, ['customer']), body('consent'), async (req, res) => send(res, snapshot(await calls.consent(req.params.id, req.auth, req.body.version))));
  app.post('/api/v2/calls/:id/admission', member, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    send(res, await calls.admission(req.params.id, req.auth, req.auth.role === 'agent' ? req.body?.room_label : undefined));
  });
  app.post('/api/v2/calls/:id/heartbeat', member, async (req, res) => send(res, await calls.heartbeat(req.params.id, req.auth)));
  app.post('/api/v2/calls/:id/decision', agent, body('decision'), async (req, res) => send(res, snapshot(await calls.decide(req.params.id, req.auth, req.body))));
  app.post('/api/v2/calls/:id/cancel', member, async (req, res) => send(res, snapshot(await calls.cancel(req.params.id, req.auth))));
  app.get('/api/v2/calls/:id/recording', agent, async (req, res) => { const call = await calls.get(req.params.id, req.auth); const recording = await db('platform_recordings').where({ call_id: call.id }).first(); send(res, recording ? { id: recording.id, state: recording.state, bytes: recording.bytes, sha256: recording.sha256 } : null); });
  app.post('/internal/recordings/events', signedRecording(cfg), body('recordingEvent'), async (req, res) => send(res, snapshot(await calls.recordingEvent(req.body))));
  app.post('/internal/recordings/stored', signedRecording(cfg), body('recordingStored'), async (req, res) => send(res, snapshot(await calls.stored(req.body))));
  app.locals.calls = calls; app.locals.sessions = sessions; app.locals.integration = integration;
  return finishApp(app);
}
