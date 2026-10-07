export async function up(db) {
  await db.schema.createTable('platform_tenants', t => {
    t.uuid('id').primary(); t.string('name').notNullable(); t.boolean('active').notNullable().defaultTo(true);
    t.jsonb('encryption').notNullable().defaultTo('{}'); t.integer('recording_retention_days'); t.boolean('legal_hold').notNullable().defaultTo(false); t.timestamps(true, true);
  });
  await db.schema.createTable('platform_agents', t => {
    t.uuid('id').primary(); t.uuid('tenant_id').references('id').inTable('platform_tenants').notNullable();
    t.string('username').unique().notNullable(); t.string('name').notNullable(); t.string('password_hash').notNullable(); t.boolean('active').notNullable().defaultTo(true); t.timestamps(true, true);
  });
  await db.schema.createTable('platform_sessions', t => {
    t.uuid('id').primary(); t.uuid('tenant_id').notNullable(); t.uuid('subject_id').notNullable(); t.string('role').notNullable();
    t.string('refresh_hash').unique(); t.timestamp('expires_at', { useTz: true }).notNullable(); t.timestamp('revoked_at', { useTz: true }); t.timestamps(true, true);
  });
  await db.schema.createTable('platform_actors', t => { t.uuid('id').primary(); t.uuid('tenant_id').notNullable().references('id').inTable('platform_tenants'); t.timestamps(true, true); });
  await db.schema.createTable('platform_customers', t => {
    t.uuid('id').primary(); t.uuid('tenant_id').notNullable().references('id').inTable('platform_tenants'); t.uuid('actor_id');
    t.jsonb('data').notNullable(); t.string('encryption_format').notNullable().defaultTo('legacy-v1');
    t.string('verification_status').notNullable().defaultTo('waiting'); t.timestamp('deleted_at', { useTz: true }); t.timestamps(true, true); t.index(['tenant_id', 'deleted_at']);
  });
  await db.schema.createTable('platform_documents', t => {
    t.uuid('id').primary(); t.uuid('tenant_id').notNullable(); t.uuid('user_id').references('id').inTable('platform_customers'); t.uuid('actor_id');
    t.string('type').notNullable(); t.text('object_key').notNullable(); t.string('bucket').notNullable(); t.string('mimetype').notNullable(); t.bigInteger('bytes'); t.string('sha256'); t.timestamps(true, true);
  });
  await db.schema.createTable('platform_calls', t => {
    t.uuid('id').primary(); t.uuid('tenant_id').notNullable().references('id').inTable('platform_tenants'); t.uuid('user_id').notNullable().references('id').inTable('platform_customers');
    t.uuid('agent_id').references('id').inTable('platform_agents'); t.string('room').notNullable().unique(); t.string('state').notNullable().defaultTo('waiting');
    t.string('outcome'); t.text('reason'); t.jsonb('notification').notNullable().defaultTo('{}'); t.string('registration_key').notNullable();
    t.timestamp('consented_at', { useTz: true }); t.string('consent_version'); t.timestamp('started_at', { useTz: true }); t.timestamp('ended_at', { useTz: true });
    t.timestamp('agent_seen_at', { useTz: true }); t.timestamp('customer_seen_at', { useTz: true }); t.integer('version').notNullable().defaultTo(0); t.timestamps(true, true);
    t.unique(['tenant_id', 'registration_key']); t.index(['tenant_id', 'state', 'created_at']);
  });
  await db.raw("CREATE UNIQUE INDEX platform_one_agent_call ON platform_calls(agent_id) WHERE agent_id IS NOT NULL AND state IN ('assigned','preparing_recording','ringing','active','completing')");
  await db.raw("CREATE UNIQUE INDEX platform_one_customer_call ON platform_calls(tenant_id,user_id) WHERE state IN ('waiting','assigned','preparing_recording','ringing','active','completing')");
  await db.schema.createTable('platform_recordings', t => {
    t.uuid('id').primary(); t.uuid('call_id').notNullable().references('id').inTable('platform_calls'); t.uuid('tenant_id').notNullable();
    t.string('state').notNullable().defaultTo('reserved'); t.string('worker_id'); t.text('object_key'); t.string('sha256'); t.bigInteger('bytes');
    t.timestamp('started_at', { useTz: true }); t.timestamp('stopped_at', { useTz: true }); t.timestamp('heartbeat_at', { useTz: true }); t.timestamps(true, true);
  });
  await db.raw("CREATE UNIQUE INDEX platform_recording_worker ON platform_recordings(worker_id) WHERE state IN ('recording','stopping') AND worker_id IS NOT NULL");
  await db.schema.createTable('platform_recording_slots', t => { t.integer('id').primary(); t.uuid('recording_id').unique().references('id').inTable('platform_recordings'); });
  await db.schema.createTable('platform_events', t => { t.uuid('id').primary(); t.string('digest').notNullable(); t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now()); });
  await db.schema.createTable('platform_decisions', t => { t.uuid('call_id').primary(); t.uuid('tenant_id').notNullable(); t.uuid('user_id').notNullable(); t.string('outcome').notNullable(); t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now()); });
  await db.schema.createTable('platform_outbox', t => {
    t.uuid('id').primary(); t.string('topic').notNullable(); t.string('dedupe_key').notNullable().unique(); t.jsonb('payload').notNullable();
    t.integer('attempts').notNullable().defaultTo(0); t.timestamp('available_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.timestamp('delivered_at', { useTz: true }); t.string('last_error'); t.timestamps(true, true);
  });
  await db.schema.createTable('platform_audit', t => { t.bigIncrements('id'); t.uuid('tenant_id').notNullable(); t.uuid('subject_id'); t.uuid('actor_id'); t.string('action').notNullable(); t.jsonb('metadata').notNullable().defaultTo('{}'); t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now()); });
  await db.schema.createTable('platform_reference', t => { t.string('category').notNullable(); t.string('id').notNullable(); t.jsonb('data').notNullable(); t.primary(['category', 'id']); });
  await db.schema.createTable('platform_quotas', t => { t.uuid('tenant_id').notNullable(); t.string('service').notNullable(); t.integer('remaining').notNullable(); t.primary(['tenant_id', 'service']); });
  await db.schema.createTable('platform_otps', t => { t.string('id').primary(); t.uuid('tenant_id').notNullable(); t.uuid('user_id').notNullable(); t.string('phone_hash').notNullable(); t.timestamp('expires_at', { useTz: true }).notNullable(); t.timestamp('verified_at', { useTz: true }); });
  await db.schema.createTable('platform_secure_transactions', t => { t.uuid('id').primary(); t.uuid('tenant_id').notNullable(); t.jsonb('encrypted_material').notNullable(); t.timestamp('expires_at', { useTz: true }).notNullable(); });
  await db.schema.createTable('platform_callbacks', t => { t.uuid('id').primary(); t.uuid('tenant_id').notNullable(); t.string('provider').notNullable(); t.string('submission_id').notNullable(); t.string('event_hash').notNullable(); t.jsonb('data').notNullable(); t.timestamps(true, true); t.unique(['tenant_id', 'provider', 'event_hash']); });
}
export async function down() { throw new Error('Destructive rollback is disabled. Restore a verified backup using the migration runbook.'); }
