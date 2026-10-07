import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.env.CONFIG || './.local/jitsi');
for (const name of ['web', 'prosody/config', 'prosody/prosody-plugins-custom', 'jicofo', 'jvb', 'storage/jibri/recordings', 'storage/jibri/logs', 'storage/web', 'storage/prosody', 'storage/transcripts', 'tmp/web-load-test', ...Array.from({ length: 5 }, (_, i) => `jibri${i + 1}`)]) {
  await mkdir(path.join(root, name), { recursive: true });
}
await copyFile('infra/jitsi/mod_ekyc_guard.lua', path.join(root, 'prosody/prosody-plugins-custom/mod_ekyc_guard.lua'));
console.log('Prepared isolated Jitsi volumes and the admission plugin.');
