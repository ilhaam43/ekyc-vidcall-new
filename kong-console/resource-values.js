const secretName = /password|secret|token|credential|private|(?:^|_)key(?:$|_)/i;
export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !secretName.test(key) || ['key_names', 'key_claim_name', 'public_key', 'rsa_public_key'].includes(key) || typeof item === 'boolean' || typeof item === 'number').map(([key, item]) => [key, redactConfig(item)]));
}
export function mergeConfig(current, patch) {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length ? mergeConfig(current?.[key], value) : {} : value;
  }
  return result;
}
export function credentialMetadata(kind, row) {
  if (!['key-auth', 'basic-auth', 'jwt', 'hmac-auth'].includes(kind)) return row;
  return { id: row.id, username: row.username, key: kind === 'jwt' ? row.key : undefined, algorithm: row.algorithm, rsa_public_key: row.rsa_public_key, ttl: row.ttl, created_at: row.created_at, tags: row.tags };
}
