export async function up(db) {
  await db.schema.createTable('dashboard_banks', t => {
    t.uuid('id').primary(); t.uuid('tenant_id').notNullable().unique().references('id').inTable('platform_tenants');
    t.string('username').notNullable().unique(); t.string('name').notNullable(); t.string('email'); t.boolean('active').notNullable().defaultTo(true); t.timestamps(true, true);
  });
  await db.schema.createTable('dashboard_plans', t => {
    t.uuid('id').primary(); t.string('shortname').notNullable().unique(); t.string('name').notNullable();
    t.text('description'); t.jsonb('features').notNullable().defaultTo('[]'); t.jsonb('limits').notNullable().defaultTo('{}'); t.timestamps(true, true);
  });
  await db.schema.createTable('dashboard_applications', t => {
    t.uuid('id').primary(); t.uuid('bank_id').notNullable().references('id').inTable('dashboard_banks');
    t.uuid('plan_id').references('id').inTable('dashboard_plans'); t.string('name').notNullable(); t.text('description');
    t.string('status').notNullable().defaultTo('waiting'); t.string('kong_consumer_id'); t.timestamp('activated_at', { useTz: true }); t.timestamps(true, true);
    t.index(['bank_id', 'status']);
  });
  await db.schema.createTable('dashboard_accounts', t => {
    t.uuid('id').primary(); t.uuid('bank_id').references('id').inTable('dashboard_banks'); t.string('username').notNullable().unique();
    t.string('email').unique(); t.string('password_hash').notNullable(); t.string('role').notNullable();
    t.boolean('active').notNullable().defaultTo(true); t.string('reset_hash'); t.timestamp('reset_expires_at', { useTz: true }); t.timestamps(true, true);
  });
  await db.schema.createTable('dashboard_officers', t => {
    t.uuid('id').primary(); t.uuid('bank_id').notNullable().references('id').inTable('dashboard_banks');
    t.string('username').notNullable().unique(); t.string('name').notNullable(); t.string('email'); t.string('password_hash').notNullable();
    t.boolean('active').notNullable().defaultTo(true); t.timestamps(true, true);
  });
  await db.schema.createTable('dashboard_application_agents', t => {
    t.uuid('application_id').notNullable().references('id').inTable('dashboard_applications');
    t.uuid('agent_id').notNullable().references('id').inTable('platform_agents'); t.primary(['application_id', 'agent_id']);
  });
  await db.schema.createTable('dashboard_customer_applications', t => {
    t.uuid('application_id').notNullable().references('id').inTable('dashboard_applications');
    t.uuid('customer_id').notNullable().references('id').inTable('platform_customers'); t.primary(['application_id', 'customer_id']);
  });
  await db.schema.createTable('dashboard_links', t => {
    t.uuid('id').primary(); t.string('name').notNullable(); t.text('url').notNullable(); t.boolean('active').notNullable().defaultTo(true); t.timestamps(true, true);
  });
  await db.schema.createTable('dashboard_exports', t => {
    t.uuid('id').primary(); t.uuid('application_id').notNullable().references('id').inTable('dashboard_applications');
    t.uuid('requested_by').references('id').inTable('dashboard_accounts'); t.string('state').notNullable().defaultTo('queued');
    t.jsonb('request').notNullable().defaultTo('{}'); t.text('object_key'); t.string('sha256'); t.text('error');
    t.integer('attempts').notNullable().defaultTo(0); t.timestamp('lease_until', { useTz: true }); t.timestamps(true, true);
  });
  await db.schema.createTable('dashboard_id_map', t => {
    t.string('entity').notNullable(); t.string('legacy_id').notNullable(); t.uuid('platform_id').notNullable(); t.primary(['entity', 'legacy_id']);
  });
  await db.schema.createTable('dashboard_audit', t => {
    t.bigIncrements('id'); t.uuid('actor_id'); t.uuid('bank_id'); t.string('action').notNullable();
    t.jsonb('metadata').notNullable().defaultTo('{}'); t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
  });
}
export async function down() { throw new Error('Dashboard rollback requires a verified backup.'); }
