import { createDb } from '@ekyc/shared/db';
import { required, value } from '@ekyc/shared/config';
import { fileURLToPath } from 'node:url';
const db = createDb(required('DATABASE_URL'));
try {
  await db.migrate.latest({ directory: fileURLToPath(new URL('../migrations', import.meta.url)), tableName: 'platform_migrations' });
  const slots = Number(value('RECORDING_SLOTS', '5'));
  for (let id = 1; id <= slots; id++) await db('platform_recording_slots').insert({ id }).onConflict('id').ignore();
  console.log('Additive platform migrations complete. Legacy tables were not modified.');
} finally { await db.destroy(); }
