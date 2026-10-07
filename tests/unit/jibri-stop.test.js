import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { Jibri } from '../../ekyc-vidcall-backend/src/jibri.js';

const previousUrl = process.env.PROSODY_CONTROL_URL;
afterEach(() => {
  if (previousUrl === undefined) delete process.env.PROSODY_CONTROL_URL;
  else process.env.PROSODY_CONTROL_URL = previousUrl;
});

test('conference stop targets the Prosody MUC HTTP virtual host', async () => {
  let received;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received = { host: req.headers.host, path: req.url, secret: req.headers['x-internal-secret'], body: JSON.parse(body) }; res.writeHead(200).end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.PROSODY_CONTROL_URL = `http://127.0.0.1:${server.address().port}/ekyc-control`;
  try {
    const db = () => ({ where: () => ({ first: async () => null }) });
    await new Jibri(db, { internalSecret: 'test-secret' }, null).stop({ call_id: 'call-id', room: 'verifikasi-nasabah-demo-12345678' });
    expect(received).toEqual({ host: 'muc.meet.jitsi', path: '/ekyc-control/stop', secret: 'test-secret', body: { room: 'verifikasi-nasabah-demo-12345678' } });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
