import { expect, test } from 'vitest';
import { monthlyWindow } from '../../ekyc-dashboard-new/server/export-schedule.js';

test('monthly export uses consecutive WIB calendar days', () => {
  expect(monthlyWindow(2026, 9, 21)).toEqual({ due: '2026-09-21', from: '2026-08-21', to: '2026-09-20' });
  expect(monthlyWindow(2027, 1, 1)).toEqual({ due: '2027-01-01', from: '2026-12-01', to: '2026-12-31' });
});
