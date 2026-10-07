export async function up(db) {
  await db.schema.createTable('platform_integrations', table => {
    table.uuid('tenant_id').primary().references('id').inTable('platform_tenants');
    table.string('issuer').notNullable();
    table.string('audience').notNullable();
    table.text('public_key_pem').notNullable();
    table.text('agent_launch_url').notNullable();
    table.text('customer_entry_url').notNullable();
    table.text('staff_origin').notNullable();
    table.boolean('active').notNullable().defaultTo(false);
    table.timestamps(true, true);
  });
  await db.schema.createTable('platform_agent_identities', table => {
    table.uuid('tenant_id').notNullable().references('id').inTable('platform_tenants');
    table.string('external_subject', 255).notNullable();
    table.uuid('agent_id').notNullable().references('id').inTable('platform_agents');
    table.primary(['tenant_id', 'external_subject']);
    table.unique(['tenant_id', 'agent_id']);
  });
  await db.schema.createTable('platform_integration_jtis', table => {
    table.uuid('tenant_id').notNullable().references('id').inTable('platform_tenants');
    table.string('jti_hash', 64).notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.primary(['tenant_id', 'jti_hash']);
  });
  await db.schema.createTable('platform_link_grants', table => {
    table.string('code_hash', 64).primary();
    table.uuid('tenant_id').notNullable().references('id').inTable('platform_tenants');
    table.string('kind').notNullable();
    table.uuid('subject_id').notNullable();
    table.uuid('call_id').references('id').inTable('platform_calls');
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('consumed_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    table.index(['tenant_id', 'expires_at']);
  });
  await db.schema.alterTable('platform_sessions', table => {
    table.uuid('call_id').references('id').inTable('platform_calls');
    table.string('source').notNullable().defaultTo('basic');
  });
  await db.schema.alterTable('platform_calls', table => {
    table.string('source').notNullable().defaultTo('basic');
    table.string('external_request_id', 96);
  });
  await db.schema.alterTable('platform_calls', table => {
    table.unique(['tenant_id', 'external_request_id']);
  });
}

export async function down() {
  throw new Error('Destructive rollback is disabled. Restore a verified backup using the migration runbook.');
}
