export const platformServices = [
  { name: 'ekyc-master-api', protocol: 'http', host: 'master', port: 8080, path: null, connect_timeout: 10000, read_timeout: 60000, write_timeout: 60000, retries: 2, tags: ['ekyc-platform', 'master'] },
  { name: 'ekyc-videocall-api', protocol: 'http', host: 'calls', port: 5030, path: null, connect_timeout: 10000, read_timeout: 75000, write_timeout: 60000, retries: 2, tags: ['ekyc-platform', 'videocall'] },
];
export const platformRoutes = [
  { name: 'ekyc-master-v1', serviceName: 'ekyc-master-api', paths: ['/api/v1'], tags: ['ekyc-platform', 'master'] },
  { name: 'ekyc-videocall-v1', serviceName: 'ekyc-videocall-api', paths: ['/v1'], tags: ['ekyc-platform', 'videocall', 'legacy-compatible'] },
  { name: 'ekyc-videocall-v2', serviceName: 'ekyc-videocall-api', paths: ['/api/v2'], tags: ['ekyc-platform', 'videocall'] },
  { name: 'ekyc-videocall-realtime', serviceName: 'ekyc-videocall-api', paths: ['/socket.io'], tags: ['ekyc-platform', 'videocall', 'realtime'] },
];
async function all(client, entity) {
  const rows = []; let offset;
  do {
    const result = await client.request(`/${entity}?size=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`);
    rows.push(...(result.data || [])); offset = result.next || result.offset;
  } while (offset);
  return rows;
}
function matches(current, desired) {
  return Object.entries(desired).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value));
}
export async function ensurePlatformRoutes(client) {
  const services = await all(client, 'services'), routes = await all(client, 'routes');
  const result = { services: [], routes: [] }, ids = new Map();
  for (const desired of platformServices) {
    let current = services.find(row => row.name === desired.name);
    // A name collision with another upstream needs an explicit operator decision.
    if (current && (current.host !== desired.host || current.port !== desired.port)) throw new Error(`PLATFORM_SERVICE_CONFLICT:${desired.name}`);
    const action = !current ? 'created' : matches(current, desired) ? 'unchanged' : 'updated';
    if (action !== 'unchanged') current = await client.request(current ? `/services/${current.id}` : '/services', { method: current ? 'PATCH' : 'POST', body: desired });
    ids.set(desired.name, current.id); result.services.push({ name: desired.name, id: current.id, action, upstream: `${desired.protocol}://${desired.host}:${desired.port}` });
  }
  for (const { serviceName, ...route } of platformRoutes) {
    const desired = { ...route, service: { id: ids.get(serviceName) }, strip_path: false, preserve_host: false, protocols: ['http', 'https'] };
    let current = routes.find(row => row.name === desired.name);
    if (current && current.service?.id !== desired.service.id) throw new Error(`PLATFORM_ROUTE_CONFLICT:${desired.name}`);
    const action = !current ? 'created' : matches(current, desired) ? 'unchanged' : 'updated';
    if (action !== 'unchanged') current = await client.request(current ? `/routes/${current.id}` : '/routes', { method: current ? 'PATCH' : 'POST', body: desired });
    result.routes.push({ name: desired.name, id: current.id, action, paths: desired.paths, service: serviceName });
  }
  return result;
}
