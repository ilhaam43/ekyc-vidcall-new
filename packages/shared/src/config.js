import { readFileSync } from 'node:fs';
export function value(name, fallback) {
  const file = process.env[`${name}_FILE`];
  return file ? readFileSync(file, 'utf8').trim() : process.env[name] ?? fallback;
}
export function required(name) {
  const result = value(name);
  if (!result) throw new Error(`Missing required configuration: ${name}`);
  return result;
}
export function secret(name) {
  const result = required(name);
  if (result.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return result;
}
export function config() {
  return {
    databaseUrl: required('DATABASE_URL'), jwtSecret: secret('JWT_SECRET'), internalSecret: secret('INTERNAL_SECRET'),
    gatewaySecret: secret('GATEWAY_SECRET'), recordingSecret: secret('RECORDING_SECRET'),
    publicOrigin: value('PUBLIC_ORIGIN', 'http://localhost:5173'),
    masterUrl: value('MASTER_URL', 'http://localhost:8080'), callsUrl: value('CALLS_URL', 'http://localhost:5030'),
    jitsiDomain: value('JITSI_DOMAIN', 'meet.localhost'), jitsiSecret: secret('JITSI_JWT_SECRET'),
    jitsiAppId: value('JITSI_APP_ID', 'ekyc'), production: value('NODE_ENV') === 'production',
    encryptionUrl: value('ENCRYPTION_URL'), encryptionMock: value('ENCRYPTION_MOCK') === 'true',
    objectEndpoint: required('OBJECT_ENDPOINT'), objectAccess: required('OBJECT_ACCESS_KEY'), objectSecret: secret('OBJECT_SECRET_KEY'),
    recordingBucket: value('RECORDING_BUCKET', 'ekyc-recordings'), documentBucket: value('DOCUMENT_BUCKET', 'ekyc-documents'),
    valkeyUrl: value('VALKEY_URL', 'redis://localhost:6379'), recordingSlots: Number(value('RECORDING_SLOTS', '5')),
    recordingTimeout: Number(value('RECORDING_TIMEOUT_SECONDS', '90')), reconnectGrace: Number(value('RECONNECT_GRACE_SECONDS', '60')),
  };
}
