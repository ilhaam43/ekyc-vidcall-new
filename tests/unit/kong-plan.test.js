import { expect, test } from 'vitest';
import { planPolicy } from '../../ekyc-dashboard-new/server/integrations.js';

test('bank API plan resolves explicit rate limit and ACL group', () => {
  expect(planPolicy({ shortname: 'standard', limits: { requests_per_minute: 120, acl_group: 'bank-standard' } })).toEqual({ minute: 120, group: 'bank-standard' });
  expect(planPolicy({ shortname: 'standard', limits: '{}' })).toEqual({ minute: 60, group: 'plan-standard' });
});

test('bank API plan rejects invalid rate limits and ACL groups', () => {
  expect(() => planPolicy({ shortname: 'standard', limits: { requests_per_minute: 0 } })).toThrow();
  expect(() => planPolicy({ shortname: 'standard', limits: { acl_group: 'bad group' } })).toThrow();
});
