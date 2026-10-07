export async function up(db) {
  await db.schema.alterTable('dashboard_exports', table => {
    table.string('schedule_key').unique();
  });
}
export async function down() { throw new Error('Destructive rollback is disabled. Restore a verified backup.'); }
