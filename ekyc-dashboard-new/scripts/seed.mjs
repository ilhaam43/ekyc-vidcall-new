import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createDb } from '@ekyc/shared/db';
import { required } from '@ekyc/shared/config';

if (process.env.NODE_ENV === 'production') throw new Error('Synthetic dashboard seed is disabled in production');
const db = createDb(required('DATABASE_URL'));
try {
  const existing = await db('dashboard_banks').where({ username: 'demo-bank' }).first();
  if (existing) { console.log(JSON.stringify({ message: 'Synthetic dashboard already seeded', bankId: existing.id })); process.exit(0); }
  const superPassword = process.env.DASHBOARD_DEMO_PASSWORD || `${randomUUID()}${randomUUID()}`;
  const bankPassword = process.env.DASHBOARD_BANK_PASSWORD || `${randomUUID()}${randomUUID()}`;
  const officerPassword = process.env.DASHBOARD_OFFICER_PASSWORD || `${randomUUID()}${randomUUID()}`;
  let tenant = await db('platform_tenants').where({ name: 'Synthetic pilot tenant' }).first();
  const bankId = randomUUID(), planId = randomUUID(), appId = randomUUID();
  await db.transaction(async trx => {
    if (!tenant) { tenant = { id: randomUUID(), name: 'Synthetic pilot tenant' }; await trx('platform_tenants').insert(tenant); }
    await trx('dashboard_banks').insert({ id: bankId, tenant_id: tenant.id, username: 'demo-bank', name: 'Bank Demo', email: 'bank@example.test' });
    await trx('dashboard_plans').insert({ id: planId, name: 'eKYC Standard', shortname: 'ekyc-standard', description: 'Synthetic local plan', features: JSON.stringify(['user', 'agent', 'api-usage', 'liveness']) });
    await trx('dashboard_applications').insert({ id: appId, bank_id: bankId, plan_id: planId, name: 'Aplikasi Demo', status: 'confirmed', kong_consumer_id: `synthetic-${appId}`, activated_at: new Date() });
    await trx('dashboard_accounts').insert([
      { id: randomUUID(), username: 'dashboard-admin', email: 'admin@example.test', role: 'superadmin', password_hash: await bcrypt.hash(superPassword, 12) },
      { id: randomUUID(), username: 'dashboard-bank', email: 'bank@example.test', role: 'bank', bank_id: bankId, password_hash: await bcrypt.hash(bankPassword, 12) },
    ]);
    await trx('dashboard_officers').insert({ id: randomUUID(), bank_id: bankId, username: 'dashboard-officer', name: 'Petugas Demo', email: 'officer@example.test', password_hash: await bcrypt.hash(officerPassword, 12) });
    const agents = await trx('platform_agents').where({ tenant_id: tenant.id });
    for (const agent of agents) await trx('dashboard_application_agents').insert({ application_id: appId, agent_id: agent.id }).onConflict().ignore();
    const customers = await trx('platform_customers').where({ tenant_id: tenant.id });
    if (!customers.length) { const id = randomUUID(); await trx('platform_customers').insert({ id, tenant_id: tenant.id, data: { name: 'Nasabah Demo', id_number: 'SYNTHETIC-ONLY' }, encryption_format: 'synthetic-plaintext' }); customers.push({ id }); }
    for (const customer of customers) await trx('dashboard_customer_applications').insert({ application_id: appId, customer_id: customer.id }).onConflict().ignore();
    await trx('platform_quotas').insert({ tenant_id: tenant.id, service: 'videocalls.post', remaining: 20 }).onConflict().ignore();
  });
  console.log(JSON.stringify({ notice: 'Synthetic local accounts only; store these temporary passwords securely.', bankId, applicationId: appId, accounts: [{ username: 'dashboard-admin', password: superPassword }, { username: 'dashboard-bank', password: bankPassword }, { username: 'dashboard-officer', password: officerPassword }] }, null, 2));
} finally { await db.destroy(); }
