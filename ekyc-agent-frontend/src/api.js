let token = null;
let role = location.pathname.startsWith('/customer') ? 'customer' : 'agent';
let renewing;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
export const localPath = path => `${basePath}${path}`;
export const session = { get token() { return token; }, set(value) { token = value; }, get role() { return role; }, setRole(value) { role = value; } };
export async function request(path, { method = 'GET', body, retry = true, ...options } = {}) {
  const response = await fetch(localPath(path), { credentials: 'include', ...options, method, headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  if (response.status === 401 && retry && !path.includes('/sessions/') && !path.endsWith('/login')) {
    renewing ||= refresh().finally(() => { renewing = null; }); await renewing; return request(path, { method, body, retry: false, ...options });
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    const err = new Error(response.ok ? 'Respons server tidak valid. Coba lagi.' : 'Layanan sementara tidak tersedia. Coba lagi.');
    err.code = 'INVALID_API_RESPONSE';
    throw err;
  }
  const result = await response.json();
  if (!response.ok || result.success === false) { const err = new Error(result.error?.message || result.error?.code || 'Permintaan gagal. Silakan coba lagi.'); err.code = result.error?.code; throw err; }
  return result.data === undefined ? result : result.data;
}
export async function refresh() { const result = await request('/api/v2/sessions/refresh', { method: 'POST', body: { role }, retry: false }); token = result.access_token; return result; }
export async function logout() { try { await request('/api/v2/sessions/logout', { method: 'POST' }); } finally { token = null; } }
export async function documentUrl(userId, documentId) {
  const response = await fetch(localPath(`/api/v1/document/${userId}/${documentId}`), { headers: { authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error('Dokumen tidak dapat dimuat'); return URL.createObjectURL(await response.blob());
}
