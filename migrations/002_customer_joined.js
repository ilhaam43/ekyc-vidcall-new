export async function up(db) {
  await db.schema.alterTable('platform_calls', table => {
    table.timestamp('customer_joined_at', { useTz: true });
  });
}

export async function down() {
  throw new Error('Destructive rollback is disabled. Restore a verified backup using the migration runbook.');
}
