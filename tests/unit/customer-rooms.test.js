import { expect, test } from 'vitest';
import { customerRooms } from '../../ekyc-vidcall-backend/src/customer-rooms.js';

test('basic deferred customer receives events in its call-bound room and legacy session room', () => {
  expect(customerRooms('tenant', 'customer', 'basic', 'call')).toEqual(['customer:tenant:customer:basic', 'customer:tenant:customer:basic:call']);
});
test('integration rooms preserve tenant, customer, source and call isolation', () => {
  const rooms = customerRooms('tenant', 'customer', 'integration', 'call');
  expect(rooms).toContain('customer:tenant:customer:integration:call');
  expect(rooms).not.toContain('customer:tenant:customer:basic:call');
  expect(rooms).not.toContain('customer:tenant:customer:integration:other-call');
  expect(rooms).not.toContain('customer:other-tenant:customer:integration:call');
});
test('legacy events without a call id do not invent a call-bound destination', () => {
  expect(customerRooms('tenant', 'customer')).toEqual(['customer:tenant:customer:basic']);
});
