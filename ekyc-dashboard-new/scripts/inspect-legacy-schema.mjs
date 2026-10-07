import { createDb } from '@ekyc/shared/db';

const url = process.env.LEGACY_DATABASE_URL;
if (!url) throw new Error('Set LEGACY_DATABASE_URL to a read-only copy of the legacy PostgreSQL database');
const db = createDb(url);
try {
  const columns = await db('information_schema.columns')
    .select('table_name', 'column_name', 'data_type', 'is_nullable')
    .where({ table_schema: process.env.LEGACY_SCHEMA || 'public' })
    .orderBy(['table_name', 'ordinal_position']);
  const tables = {};
  for (const column of columns) (tables[column.table_name] ||= []).push({ name: column.column_name, type: column.data_type, nullable: column.is_nullable === 'YES' });
  console.log(JSON.stringify({ schema: process.env.LEGACY_SCHEMA || 'public', tables }, null, 2));
} finally { await db.destroy(); }
