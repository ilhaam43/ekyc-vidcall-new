import http2 from 'node:http2';
import jwt from 'jsonwebtoken';
import { required, value } from '@ekyc/shared/config';
import { assert } from '@ekyc/shared/errors';
export async function sendApn(payload) {
  assert(payload.token && /^[a-f0-9]{64,200}$/i.test(payload.token), 422, 'INVALID_APN_TOKEN');
  const auth = jwt.sign({ iss: required('APN_TEAM_ID'), iat: Math.floor(Date.now() / 1000) }, required('APN_PRIVATE_KEY'), { algorithm: 'ES256', keyid: required('APN_KEY_ID') });
  const client = http2.connect(value('APN_SANDBOX') === 'true' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
  try {
    await new Promise((resolve, reject) => {
      client.once('error', reject);
      const stream = client.request({ ':method': 'POST', ':path': `/3/device/${payload.token}`, authorization: `bearer ${auth}`, 'apns-topic': required('APN_BUNDLE_ID'), 'apns-push-type': 'alert', 'apns-priority': '10' });
      stream.setTimeout(10000, () => { stream.close(); reject(new Error('APN_TIMEOUT')); });
      let status; stream.on('response', headers => { status = headers[':status']; }); stream.on('data', () => {}); stream.on('error', reject);
      stream.on('end', () => { if (status === 200) resolve(); else reject(new Error('APN_REJECTED')); });
      stream.end(JSON.stringify({ aps: { alert: { title: 'eKYC', body: payload.event === 'call.start' ? 'Panggilan verifikasi masuk' : 'Panggilan verifikasi selesai' }, sound: 'default' }, event: payload.event, data: payload.data }));
    });
  } finally { client.close(); }
}
