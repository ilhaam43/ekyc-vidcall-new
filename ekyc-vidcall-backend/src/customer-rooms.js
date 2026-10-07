export function customerRooms(tenantId, userId, source = 'basic', callId) {
  const base = `customer:${tenantId}:${userId}:${source}`;
  return callId ? [base, `${base}:${callId}`] : [base];
}
