import { config } from '@ekyc/shared/config';
import { createDb } from '@ekyc/shared/db';
import { Storage } from '@ekyc/shared/storage';
import { assert } from '@ekyc/shared/errors';

if (process.env.NODE_ENV === 'production' && process.argv.includes('--dry-run') === false && process.env.CONFIRM_RECORDING_REORGANIZATION !== 'yes') {
  throw new Error('Production moves require CONFIRM_RECORDING_REORGANIZATION=yes');
}
const dryRun = process.argv.includes('--dry-run');
const callId = process.argv.find(value => /^[0-9a-f-]{36}$/i.test(value));
const cfg = config(); const db = createDb(cfg.databaseUrl); const storage = new Storage(cfg);
try {
  const query = db('platform_recordings').where({ state: 'stored' }).whereNotNull('object_key').orderBy('created_at');
  if (callId) query.where({ call_id: callId });
  const rows = await query;
  for (const recording of rows) {
    const call = await db('platform_calls').where({ id: recording.call_id }).first();
    assert(call && call.tenant_id === recording.tenant_id, 409, 'RECORDING_CALL_MISMATCH');
    const target = `${call.tenant_id}/${call.user_id}/${call.id}/${recording.id}.mp4`;
    if (recording.object_key === target) continue;
    let before;
    try { before = await storage.checksum(cfg.recordingBucket, recording.object_key); }
    catch (error) { if (error.name === 'NoSuchKey' || error.name === 'NotFound') { console.error(`missing source; leaving database unchanged: ${recording.object_key}`); continue; } throw error; }
    assert(before.sha256 === recording.sha256 && Number(before.bytes) === Number(recording.bytes), 409, 'SOURCE_CHECKSUM_MISMATCH');
    console.log(`${dryRun ? 'would move' : 'moving'} ${recording.object_key} -> ${target}`);
    if (dryRun) continue;
    try {
      const existing = await storage.checksum(cfg.recordingBucket, target);
      assert(existing.sha256 === before.sha256 && Number(existing.bytes) === Number(before.bytes), 409, 'TARGET_CHECKSUM_MISMATCH');
    } catch (error) {
      if (!['NoSuchKey', 'NotFound'].includes(error.name) && !['NoSuchKey', 'NotFound'].includes(error.code)) throw error;
      await storage.copy(cfg.recordingBucket, recording.object_key, target);
      const copied = await storage.checksum(cfg.recordingBucket, target);
      assert(copied.sha256 === before.sha256 && Number(copied.bytes) === Number(before.bytes), 409, 'COPY_CHECKSUM_MISMATCH');
    }
    await db.transaction(async trx => {
      const updated = await trx('platform_recordings').where({ id: recording.id, object_key: recording.object_key, state: 'stored' }).update({ object_key: target, updated_at: new Date() });
      assert(updated === 1, 409, 'RECORDING_CHANGED_DURING_MOVE');
    });
    await storage.delete(cfg.recordingBucket, recording.object_key);
  }
} finally { await db.destroy(); }
