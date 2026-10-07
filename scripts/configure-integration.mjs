import { readFileSync } from 'node:fs';
import { createDb } from '@ekyc/shared/db';
import { required } from '@ekyc/shared/config';

const [tenantId, externalSubject, agentId] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuid.test(tenantId || '') || Boolean(externalSubject) !== Boolean(agentId) || (agentId && !uuid.test(agentId))) {
  throw new Error('Usage: node --env-file=.env scripts/configure-integration.mjs TENANT_UUID [EXTERNAL_STAFF_ID AGENT_UUID]');
}
const origin = required('INTEGRATION_STAFF_ORIGIN');
const agentLaunch = new URL(required('INTEGRATION_AGENT_LAUNCH_URL'));
const customerEntry = new URL(required('INTEGRATION_CUSTOMER_ENTRY_URL'));
const allowHttp = process.env.NODE_ENV !== 'production';
for (const url of [new URL(origin), agentLaunch, customerEntry]) {
  if (url.protocol !== 'https:' && !(allowHttp && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Integration URLs must use HTTPS outside localhost development');
}
if (new URL(origin).origin !== origin || agentLaunch.origin !== origin || !agentLaunch.pathname.endsWith('/integrations/agent') || agentLaunch.search || agentLaunch.hash || customerEntry.search || customerEntry.hash) {
  throw new Error('Invalid configured staff origin, launch route, or customer entry URL');
}
const db = createDb(required('DATABASE_URL'));
try {
  await db.transaction(async trx => {
    if (!await trx('platform_tenants').where({ id: tenantId, active: true }).first()) throw new Error('Active tenant not found');
    await trx('platform_integrations').insert({
      tenant_id: tenantId, issuer: required('INTEGRATION_ISSUER'), audience: required('INTEGRATION_AUDIENCE'),
      public_key_pem: readFileSync(required('INTEGRATION_PUBLIC_KEY_FILE'), 'utf8'),
      staff_origin: origin, agent_launch_url: agentLaunch.toString(), customer_entry_url: customerEntry.toString(), active: true,
    }).onConflict('tenant_id').merge();
    if (externalSubject) {
      if (!await trx('platform_agents').where({ id: agentId, tenant_id: tenantId, active: true }).first()) throw new Error('Active agent not found in tenant');
      await trx('platform_agent_identities').insert({ tenant_id: tenantId, external_subject: externalSubject, agent_id: agentId })
        .onConflict(['tenant_id', 'external_subject']).merge({ agent_id: agentId });
    }
  });
  console.log(JSON.stringify({ tenant_id: tenantId, mapped_staff: externalSubject || null, active: true }));
} finally { await db.destroy(); }
