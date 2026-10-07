import { config, value } from '@ekyc/shared/config';
import { createDb } from '@ekyc/shared/db';
const cfg = config();
const failures = [];
if (!cfg.production) failures.push('NODE_ENV must be production');
if (cfg.encryptionMock) failures.push('ENCRYPTION_MOCK must be false');
if (!cfg.encryptionUrl) failures.push('ENCRYPTION_URL must point to the verified legacy encryption service');
if (cfg.jitsiDomain.endsWith('.localhost')) failures.push('JITSI_DOMAIN must be a real HTTPS host');
if (!value('JVB_ADVERTISE_IPS')) failures.push('JVB_ADVERTISE_IPS is required for public media');
if (!value('TLS_CERT_PATH') || !value('TLS_KEY_PATH')) failures.push('TLS certificate and key paths are required');
const db = createDb(cfg.databaseUrl);
try {
  const missing = await db('platform_tenants').whereNull('recording_retention_days').count('* as count').first();
  if (Number(missing.count)) failures.push(`${missing.count} tenants have no explicit recording retention setting`);
  const stuck = await db('platform_recordings').whereIn('state', ['reserved', 'recording', 'stopped', 'failed']).count('* as count').first();
  if (Number(stuck.count)) failures.push(`${stuck.count} recordings require reconciliation`);
} finally { await db.destroy(); }
if (failures.length) { console.error(failures.map(x => `- ${x}`).join('\n')); process.exitCode = 1; }
else console.log('Configuration and database release preconditions passed. Human load, integration, backup and restore evidence is still required.');
