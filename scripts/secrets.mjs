import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
const hex = () => randomBytes(32).toString('hex');
const jwt = hex();
const values = {
  NODE_ENV: 'development', ENCRYPTION_MOCK: 'true', POSTGRES_PASSWORD: hex(), JWT_SECRET: hex(), INTERNAL_SECRET: hex(), GATEWAY_SECRET: hex(), RECORDING_SECRET: hex(),
  JITSI_JWT_SECRET: jwt, JWT_APP_SECRET: jwt, JWT_APP_ID: 'ekyc', JITSI_APP_ID: 'ekyc', OBJECT_ACCESS_KEY: 'ekyc', OBJECT_SECRET_KEY: hex(),
  JICOFO_AUTH_PASSWORD: hex(), JVB_AUTH_PASSWORD: hex(), JIBRI_RECORDER_PASSWORD: hex(), JIBRI_XMPP_PASSWORD: hex(), TURN_CREDENTIALS: hex(),
  PUBLIC_ORIGIN: 'http://localhost:5173', JITSI_DOMAIN: 'meet.localhost', PUBLIC_URL: 'https://meet.localhost', CONFIG: './.local/jitsi',
  HTTP_PORT: '127.0.0.1:58000', HTTPS_PORT: '127.0.0.1:58443', JVB_COLIBRI_PORT: '58081',
  JITSI_IMAGE_VERSION: 'stable-11248', ENABLE_AUTH: '1', AUTH_TYPE: 'jwt', JWT_ALLOW_EMPTY: '0', ENABLE_GUESTS: '0', ENABLE_AUTO_OWNER: '0',
  ENABLE_RECORDING: '1', ENABLE_P2P: '0', ENABLE_WELCOME_PAGE: '0', ENABLE_PREJOIN_PAGE: '0', ENABLE_XMPP_WEBSOCKET: '1',
  XMPP_DOMAIN: 'meet.jitsi', XMPP_AUTH_DOMAIN: 'auth.meet.jitsi', XMPP_MUC_DOMAIN: 'muc.meet.jitsi', XMPP_INTERNAL_MUC_DOMAIN: 'internal-muc.meet.jitsi', XMPP_RECORDER_DOMAIN: 'recorder.meet.jitsi', XMPP_HIDDEN_DOMAIN: 'recorder.meet.jitsi', XMPP_SERVER: 'xmpp.meet.jitsi',
  JIBRI_RECORDER_USER: 'recorder', JIBRI_XMPP_USER: 'jibri', JIBRI_BREWERY_MUC: 'jibribrewery', JIBRI_RECORDING_DIR: '/storage/recordings', JIBRI_HTTP_API_EXTERNAL_PORT: '2222',
};
values.DATABASE_URL = `postgres://ekyc:${values.POSTGRES_PASSWORD}@127.0.0.1:55432/ekyc`;
values.TEST_DATABASE_URL = `postgres://ekyc:${values.POSTGRES_PASSWORD}@127.0.0.1:55432/ekyc_test`;
values.OBJECT_ENDPOINT = 'http://127.0.0.1:58333';
values.VALKEY_URL = 'redis://127.0.0.1:56379';
values.MASTER_URL = 'http://127.0.0.1:58080';
values.CALLS_URL = 'http://127.0.0.1:55030';
await writeFile('.env', Object.entries(values).map(([key, val]) => `${key}=${val}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
await mkdir('.local', { recursive: true });
console.log('Created .env with random local credentials. Existing files are never overwritten. Encryption mock is for synthetic development data only.');
