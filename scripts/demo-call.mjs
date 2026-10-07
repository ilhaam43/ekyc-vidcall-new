import { randomUUID } from 'node:crypto';
import { required, value } from '@ekyc/shared/config';

const [tenantId, customerId] = process.argv.slice(2);
if (process.env.NODE_ENV === 'production') throw new Error('Demo call creation is disabled in production');
if (![tenantId, customerId].every(id => /^[0-9a-f-]{36}$/i.test(id || ''))) throw new Error('Usage: npm run demo:call -- <tenant-uuid> <customer-uuid>');
const api = value('CALLS_URL', 'http://127.0.0.1:55030');
const headers = { 'content-type': 'application/json', 'x-gateway-secret': required('GATEWAY_SECRET'), 'x-application-id': tenantId };
async function post(path, payload, extra = {}) {
  const response = await fetch(`${api}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error?.code || response.status}`);
  return data.data;
}
const call = await post('/api/v2/calls', { user_id: customerId }, { 'idempotency-key': randomUUID() });
const grant = await post('/api/v2/customer-grants', { user_id: customerId });
console.log(JSON.stringify({ call_id: call.id, state: call.state, customer_url: grant.join_url, expires_in_seconds: grant.expires_in }, null, 2));
