import { randomUUID } from 'node:crypto';
export async function enqueue(trx, topic, dedupeKey, payload) {
  await trx('platform_outbox').insert({ id: randomUUID(), topic, dedupe_key: dedupeKey, payload }).onConflict('dedupe_key').ignore();
}
export async function audit(trx, tenantId, actorId, subjectId, action, metadata = {}) {
  await trx('platform_audit').insert({ tenant_id: tenantId, actor_id: actorId, subject_id: subjectId, action, metadata });
}
export async function drainOne(db, handlers) {
  const item = await db.transaction(async trx => {
    const item = await trx('platform_outbox').whereNull('delivered_at').where('available_at', '<=', new Date()).whereIn('topic', Object.keys(handlers)).orderBy('created_at').forUpdate().skipLocked().first();
    if (!item) return null;
    await trx('platform_outbox').where({ id: item.id }).update({ available_at: new Date(Date.now() + 600000) });
    return item;
  });
  if (!item) return false;
  try {
    await handlers[item.topic](item.payload, item.id);
    await db('platform_outbox').where({ id: item.id }).update({ delivered_at: new Date(), last_error: null });
  } catch (err) {
    await db('platform_outbox').where({ id: item.id }).update({ attempts: item.attempts + 1, last_error: String(err.code || err.name || 'DELIVERY_FAILED').slice(0, 100), available_at: new Date(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(item.attempts, 8))) });
  }
  return true;
}
