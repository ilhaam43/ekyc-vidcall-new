import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { config } from '@ekyc/shared/config';
import { createDb } from '@ekyc/shared/db';
import { Storage } from '@ekyc/shared/storage';

const callId = process.argv[2];
if (process.env.NODE_ENV === 'production') throw new Error('Local recording export is disabled in production');
if (!/^[0-9a-f-]{36}$/i.test(callId || '')) throw new Error('Usage: node scripts/export-local-recording.mjs CALL_UUID');
const cfg = config(); const db = createDb(cfg.databaseUrl);
try {
  const recording = await db('platform_recordings').where({ call_id: callId, state: 'stored' }).first();
  if (!recording || !recording.object_key) throw new Error('Stored recording not found');
  const outputDir = path.join(process.env.RECORDING_STAGING_DIR || '/recordings', 'exports');
  await mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, `${callId}.mp4`);
  const object = await new Storage(cfg).get(cfg.recordingBucket, recording.object_key);
  await pipeline(object.Body, createWriteStream(output));
  console.log(output);
} finally { await db.destroy(); }
