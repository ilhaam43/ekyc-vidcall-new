export async function up(db) {
  await db.schema.createTable('dashboard_video_call_requests', table => {
    table.uuid('application_id').notNullable().references('id').inTable('dashboard_applications');
    table.string('external_request_id', 96).notNullable();
    table.uuid('customer_id').notNullable();
    table.string('payload_sha256', 64).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    table.primary(['application_id', 'external_request_id']);
    table.index(['customer_id']);
  });
}

export async function down() {
  throw new Error('Destructive rollback is disabled. Restore a verified backup using the migration runbook.');
}
