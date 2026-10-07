export class KongError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function kongClient({ url, token = '', tokenHeader = 'Kong-Admin-Token' }) {
  if (!url) return { configured: false, request: async () => { throw new KongError(503, 'KONG_NOT_CONFIGURED'); } };
  const base = new URL(`${url.replace(/\/$/, '')}/`);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid Kong Admin URL');
  return {
    configured: true,
    async request(endpoint, { method = 'GET', body } = {}) {
      if (!endpoint.startsWith('/') || endpoint.startsWith('//')) throw new KongError(400, 'INVALID_KONG_PATH');
      let response;
      try {
        response = await fetch(new URL(endpoint.slice(1), base), {
          method, redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { [tokenHeader]: token } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch { throw new KongError(503, 'KONG_UNAVAILABLE'); }
      if (response.status === 204) return { deleted: true };
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new KongError(response.status === 404 ? 404 : response.status >= 500 ? 503 : 422, `KONG_HTTP_${response.status}:${result?.message || 'request failed'}`);
      return result;
    },
  };
}
