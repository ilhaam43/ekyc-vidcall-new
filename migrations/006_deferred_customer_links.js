export async function up(db) {
  await db.schema.alterTable('platform_link_grants', table => {
    table.string('external_request_id', 96);
  });
}

export async function down() {
  throw new Error('Destructive rollback is disabled. Restore a verified backup using the migration runbook.');
}
