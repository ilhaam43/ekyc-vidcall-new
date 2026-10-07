import { expect, test } from 'vitest';
import { customerResult } from '../../ekyc-agent-frontend/src/customerResult.js';

test.each([
  [{ state: 'completed', outcome: 'verified' }, 'verified', 'Verifikasi berhasil'],
  [{ state: 'completed', outcome: 'not_verified' }, 'not-verified', 'Verifikasi belum berhasil'],
  [{ state: 'completing', outcome: 'verified' }, 'pending', 'Hasil sedang diproses'],
  [{ state: 'canceled' }, 'ended', 'Panggilan diakhiri'],
  [{ state: 'missed' }, 'ended', 'Panggilan tidak terjawab'],
  [{ state: 'failed' }, 'ended', 'Sesi video berakhir'],
])('customer result for %j', (call, tone, title) => {
  expect(customerResult(call)).toMatchObject({ tone, title });
});
