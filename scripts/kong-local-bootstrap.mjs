import { ensurePlatformRoutes } from '../kong-console/platform-routes.js';
const base = process.env.KONG_ADMIN_URL || 'http://kong:8001';
const routeId = process.env.KONG_API_ROUTE_ID || 'a9fc87a6-e1a8-4ec3-a017-c294c7bfeb39';
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(path, base), { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${data.message || ''}`);
  return data;
}
let service = await request('/services/ekyc-partner-api');
if (!service) service = await request('/services', 'POST', { name: 'ekyc-partner-api', url: 'http://dashboard:5301' });
let route = await request(`/routes/${routeId}`);
if (!route) route = await request('/routes', 'POST', { id: routeId, name: 'ekyc-partner-v1', service: { id: service.id }, paths: ['/partner/v1'], strip_path: false });
if (route.id !== routeId) throw new Error('Kong partner route ID mismatch');
const plugins = (await request(`/routes/${routeId}/plugins`))?.data || [];
if (!plugins.some(item => item.name === 'key-auth')) await request(`/routes/${routeId}/plugins`, 'POST', { name: 'key-auth', config: { key_names: ['apikey'], hide_credentials: true, key_in_header: true, key_in_query: false, key_in_body: false } });
if (!plugins.some(item => item.name === 'acl')) await request(`/routes/${routeId}/plugins`, 'POST', { name: 'acl', config: { allow: ['bootstrap-deny-all'], hide_groups_header: true } });
console.log(JSON.stringify({ service_id: service.id, route_id: route.id, proxy_path: '/partner/v1' }));
console.log(JSON.stringify(await ensurePlatformRoutes({ request: (path, options = {}) => request(path, options.method, options.body) })));
