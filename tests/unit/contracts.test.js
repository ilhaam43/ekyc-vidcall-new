import { expect, test } from 'vitest';
import { validate } from '../../packages/shared/src/contracts.js';
test('recording callback rejects unknown fields and invalid digests', () => {
  const valid = { event_id: '63d0760b-eb55-4870-8a61-d4fd67f19652', recording_id: '8002d9aa-9cef-439d-ad98-cebb880e166a', key: 'tenant/call/recording.mp4', sha256: 'a'.repeat(64), bytes: 10 };
  expect(validate('recordingStored', valid)).toEqual(valid);
  expect(() => validate('recordingStored', { ...valid, sha256: 'bad' })).toThrow();
  expect(() => validate('recordingStored', { ...valid, tenant_id: 'forged' })).toThrow();
});
test('customer consent requires exact version and affirmative choice', () => {
  expect(() => validate('consent', { accepted: false, version: 'recording-v1' })).toThrow();
  expect(validate('consent', { accepted: true, version: 'recording-v1' }).accepted).toBe(true);
});
