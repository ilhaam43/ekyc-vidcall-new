import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createDb } from '@ekyc/shared/db';
import { required } from '@ekyc/shared/config';
if (process.env.NODE_ENV === 'production') throw new Error('Synthetic seed is disabled in production');
const db = createDb(required('DATABASE_URL'));
try {
  const tenantId = randomUUID(); const agentId = randomUUID(); const customerId = randomUUID();
  const username = `demo-${tenantId.slice(0, 8)}`;
  const password = randomUUID() + randomUUID();
  await db.transaction(async trx => {
    await trx('platform_tenants').insert({ id: tenantId, name: 'Synthetic pilot tenant' });
    await trx('platform_agents').insert({ id: agentId, tenant_id: tenantId, username, name: 'Petugas Demo', password_hash: await bcrypt.hash(password, 12) });
    await trx('platform_customers').insert({ id: customerId, tenant_id: tenantId, data: { name: 'Nasabah Demo', id_number: 'SYNTHETIC-ONLY' }, encryption_format: 'synthetic-plaintext' });
    await trx('platform_quotas').insert({ tenant_id: tenantId, service: 'videocalls.post', remaining: 20 });
  });
  console.log(JSON.stringify({ tenantId, agentId, customerId, username, password, notice: 'Synthetic data and temporary credentials only. Do not use with production data.' }));
} finally { await db.destroy(); }
