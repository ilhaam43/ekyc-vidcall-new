import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, lstat, realpath, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assert } from '@ekyc/shared/errors';
import { value } from '@ekyc/shared/config';
export class Uploader {
  constructor(db, cfg, storage, calls) { this.db = db; this.cfg = cfg; this.storage = storage; this.calls = calls; this.root = path.resolve(value('RECORDING_STAGING_DIR', '/recordings')); }
  async upload({ recording_id, call_id }) {
    const recording = await this.db('platform_recordings').where({ id: recording_id, call_id }).first(); assert(recording, 404, 'RECORDING_NOT_FOUND');
    if (recording.state === 'stored') return;
    assert(recording.state === 'stopped', 409, 'RECORDING_NOT_STOPPED');
    const call = await this.db('platform_calls').where({ id: call_id }).first(); assert(call && call.state === 'completing', 409, 'CALL_NOT_COMPLETING');
    assert(/^[0-9a-f-]{36}$/.test(recording.id), 500, 'INVALID_RECORDING_ID');
    const directory = path.join(this.root, recording.id);
    const base = await realpath(directory).catch(() => null);
    assert(base && base === directory, 503, 'RECORDING_FILE_PENDING');
    const files = (await readdir(base, { withFileTypes: true })).filter(file => file.isFile() && !file.isSymbolicLink() && file.name.endsWith('.mp4'));
    assert(files.length === 1, 503, 'RECORDING_FILE_PENDING');
    const file = path.join(base, files[0].name);
    const stat = await lstat(file); assert(stat.isFile() && stat.size >= 100_000, 503, 'RECORDING_FILE_PENDING');
    // Jibri emits its stop event before ffmpeg has necessarily written the MP4 index.
    // A checksum alone can authenticate an empty, unplayable container.
    let probe;
    try {
      const result = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { timeout: 10_000 });
      probe = JSON.parse(result.stdout);
    } catch { assert(false, 503, 'RECORDING_FILE_PENDING'); }
    assert(Number(probe.format?.duration) >= 5 && probe.streams?.some(stream => stream.codec_type === 'video') && probe.streams?.some(stream => stream.codec_type === 'audio'), 503, 'RECORDING_FILE_PENDING');
    const settled = await lstat(file); assert(settled.size === stat.size, 503, 'RECORDING_FILE_PENDING');
    const localHash = createHash('sha256'); for await (const chunk of createReadStream(file)) localHash.update(chunk);
    const sha256 = localHash.digest('hex'); const key = `${call.tenant_id}/${call.user_id}/${call.id}/${recording.id}.mp4`;
    await this.storage.uploadFile(this.cfg.recordingBucket, key, file, sha256);
    const actual = await this.storage.checksum(this.cfg.recordingBucket, key);
    assert(actual.sha256 === sha256 && actual.bytes === stat.size, 503, 'UPLOAD_CHECKSUM_MISMATCH');
    await this.calls.stored({ event_id: randomUUID(), recording_id, key, sha256, bytes: stat.size });
    // The database now points to a verified object. Only the exact file pair is removed.
    await unlink(file); try { await rmdir(directory); } catch { /* Preserve metadata and unexpected files for inspection. */ }
  }
}
