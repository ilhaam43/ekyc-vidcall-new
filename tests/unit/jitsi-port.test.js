import { expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { Calls } from '../../ekyc-vidcall-backend/src/calls.js';

test.each(['agent', 'customer'])('custom HTTPS port preserves room and %s authorization', async role => {
  const query = { where() { return this; }, orderBy() { return this; }, async first() { return { id: 'recording', state: 'recording' }; } };
  const trx = () => query;
  const cfg = { jitsiDomain: 'meet.localtest.me:9443', jitsiAppId: 'ekyc', jitsiSecret: 'synthetic-test-signing-key' };
  const calls = new Calls({ transaction: callback => callback(trx) }, cfg);
  calls.get = async () => ({ id: 'call', tenant_id: 'tenant', user_id: 'customer', agent_id: 'agent', state: 'active', room: 'verifikasi-test', consented_at: new Date() });
  const admission = await calls.admission('call', { role, sub: role, sid: 'session', tenant_id: 'tenant' });
  expect(admission.domain).toBe('meet.localtest.me:9443');
  expect(admission.server_url).toBe('https://meet.localtest.me:9443');
  const claims = jwt.verify(admission.jwt, cfg.jitsiSecret);
  expect(claims.sub).toBe('meet.localtest.me');
  expect(claims.room).toBe('verifikasi-test');
  expect(claims.moderator).toBe(role === 'agent');
  expect(claims.context.user.affiliation).toBe(role === 'agent' ? 'owner' : 'member');
});
