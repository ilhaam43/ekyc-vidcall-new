import { ensurePlatformRoutes } from '../kong-console/platform-routes.js';

const origin = process.env.KONG_CONSOLE_ORIGIN || 'http://127.0.0.1:5302';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('LOCAL_KONG_CONSOLE_REQUIRED');
let cookie = '', csrf = '';
async function request(endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(`${origin}/api${endpoint}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { origin, 'x-kong-node': 'local', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const value of response.headers.getSetCookie()) if (value.startsWith('kong_console_sid=')) cookie = value.split(';')[0];
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code || `HTTP_${response.status}`);
  return result.data;
}
const session = await request('/login', { method: 'POST', body: { username: process.env.KONG_CONSOLE_USERNAME || 'kong-admin', password: process.env.KONG_CONSOLE_PASSWORD } });
csrf = session.csrf;
try { console.log(JSON.stringify(await ensurePlatformRoutes({ request }), null, 2)); }
finally { await request('/logout', { method: 'POST' }); }
