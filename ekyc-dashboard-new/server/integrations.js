import { randomBytes } from 'node:crypto';
import { fail } from './auth.js';

async function jsonRequest(url, { method = 'GET', body, headers = {} } = {}) {
  let response;
  try { response = await fetch(url, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000), redirect: 'error' }); }
  catch { throw fail(503, 'INTEGRATION_UNAVAILABLE'); }
  if (!response.ok) throw fail(response.status >= 500 ? 503 : 502, `INTEGRATION_HTTP_${response.status}`);
  if (response.status === 204) return { deleted: true };
  try { return await response.json(); } catch { throw fail(502, 'INTEGRATION_INVALID_RESPONSE'); }
}

async function kongRequest(cfg, endpoint, options) {
  const headers = cfg.kongToken ? { [cfg.kongAdminTokenHeader]: cfg.kongToken } : {};
  return jsonRequest(new URL(endpoint.replace(/^\//, ''), `${cfg.kongUrl.replace(/\/$/, '')}/`).toString(), { ...options, headers: { ...headers, ...(options?.headers || {}) } });
}

function asRows(result) { return Array.isArray(result?.data) ? result.data : []; }
function intLimit(value, fallback, max) { const limit = Number(value ?? fallback); if (!Number.isInteger(limit) || limit < 1 || limit > max) throw fail(422, 'INVALID_PLAN_RATE_LIMIT'); return limit; }
export function planPolicy(plan) {
  const limits = typeof plan.limits === 'string' ? JSON.parse(plan.limits) : (plan.limits || {});
  const minute = intLimit(limits.requests_per_minute, 60, 1000000);
  const group = limits.acl_group || `plan-${plan.shortname}`;
  if (typeof group !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(group)) throw fail(422, 'INVALID_PLAN_ACL_GROUP');
  return { minute, group };
}

async function ensureRoutePlugin(cfg, routeId, name, config) {
  const path = `/routes/${encodeURIComponent(routeId)}/plugins`;
  const existing = asRows(await kongRequest(cfg, path));
  const plugin = existing.find(item => item.name === name);
  if (plugin) return kongRequest(cfg, `/plugins/${encodeURIComponent(plugin.id)}`, { method: 'PATCH', body: { config } });
  return kongRequest(cfg, path, { method: 'POST', body: { name, config } });
}

async function applyKongPlan(cfg, consumerId, plan, oldPlan = null) {
  const { minute, group } = planPolicy(plan);
  const rateConfig = { minute, limit_by: 'consumer', policy: cfg.kongRateLimitPolicy };
  if (cfg.kongRateLimitPolicy === 'redis') {
    if (!cfg.kongRateRedisHost) throw fail(503, 'KONG_RATE_LIMIT_REDIS_NOT_CONFIGURED');
    Object.assign(rateConfig, { redis_host: cfg.kongRateRedisHost, redis_port: cfg.kongRateRedisPort, redis_database: cfg.kongRateRedisDatabase, ...(cfg.kongRateRedisPassword ? { redis_password: cfg.kongRateRedisPassword } : {}), ...(cfg.kongRateRedisUsername ? { redis_username: cfg.kongRateRedisUsername } : {}), redis_ssl: cfg.kongRateRedisSsl });
  }
  await ensureRoutePlugin(cfg, cfg.kongApiRouteId, 'key-auth', { key_names: ['apikey'], hide_credentials: true, key_in_header: true, key_in_query: false, key_in_body: false });
  const routePath = `/routes/${encodeURIComponent(cfg.kongApiRouteId)}/plugins`;
  const routePlugins = asRows(await kongRequest(cfg, routePath));
  const acl = routePlugins.find(item => item.name === 'acl');
  if (acl?.config?.deny?.length) throw fail(409, 'KONG_ACL_DENY_CONFLICT');
  const allow = [...new Set([...(acl?.config?.allow || []), group])];
  if (acl) await kongRequest(cfg, `/plugins/${encodeURIComponent(acl.id)}`, { method: 'PATCH', body: { config: { ...acl.config, allow, hide_groups_header: true } } });
  else await kongRequest(cfg, routePath, { method: 'POST', body: { name: 'acl', config: { allow, hide_groups_header: true } } });
  const aclPath = `/consumers/${encodeURIComponent(consumerId)}/acls`;
  const memberships = asRows(await kongRequest(cfg, aclPath));
  if (!memberships.some(item => item.group === group)) await kongRequest(cfg, aclPath, { method: 'POST', body: { group } });
  const oldGroup = oldPlan ? planPolicy(oldPlan).group : null;
  for (const item of memberships) if (oldGroup && oldGroup !== group && item.group === oldGroup) await kongRequest(cfg, `${aclPath}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
  const pluginPath = `/consumers/${encodeURIComponent(consumerId)}/plugins`;
  const plugins = asRows(await kongRequest(cfg, pluginPath));
  const rate = plugins.find(item => item.name === 'rate-limiting');
  if (rate) await kongRequest(cfg, `/plugins/${encodeURIComponent(rate.id)}`, { method: 'PATCH', body: { config: rateConfig } });
  else await kongRequest(cfg, pluginPath, { method: 'POST', body: { name: 'rate-limiting', config: rateConfig } });
  return { rate_limit_per_minute: minute, acl_group: group };
}

export function integrations(cfg) {
  const kongMock = cfg.kongMock ?? cfg.mockExternal;
  return {
    kong: {
      async request(endpoint, options) {
        if (kongMock) throw fail(503, 'KONG_MOCK_READ_ONLY');
        if (!cfg.kongUrl) throw fail(503, 'KONG_NOT_CONFIGURED');
        return kongRequest(cfg, endpoint, options);
      },
      async provision(application, plan) {
        const policy = planPolicy(plan);
        if (kongMock) return { id: `synthetic-${application.id}`, mode: 'synthetic', api_key: `synthetic_${randomBytes(24).toString('base64url')}`, rate_limit_per_minute: policy.minute, acl_group: policy.group };
        if (!cfg.kongUrl || !cfg.kongApiRouteId) throw fail(503, 'KONG_NOT_CONFIGURED');
        const features = Array.isArray(plan?.features) ? plan.features : [];
        if (!features.includes('user') || !features.includes('agent')) throw fail(422, 'PLAN_REQUIRES_USER_AND_AGENT_FEATURES');
        const search = await kongRequest(cfg, `/consumers?custom_id=${encodeURIComponent(application.id)}`);
        let consumer = asRows(search).find(row => row.custom_id === application.id);
        if (!consumer) consumer = await kongRequest(cfg, '/consumers', { method: 'POST', body: { username: `ekyc-application-${application.id}`, custom_id: application.id } });
        let credential;
        try {
          credential = await kongRequest(cfg, `/consumers/${encodeURIComponent(consumer.id)}/key-auth`, { method: 'POST', body: {} });
          await applyKongPlan(cfg, consumer.id, plan);
        } catch (error) {
          if (credential?.id) await kongRequest(cfg, `/consumers/${encodeURIComponent(consumer.id)}/key-auth/${encodeURIComponent(credential.id)}`, { method: 'DELETE' }).catch(() => {});
          throw error;
        }
        if (typeof credential?.key !== 'string' || credential.key.length < 16) throw fail(502, 'KONG_API_KEY_NOT_RETURNED');
        return { id: consumer.id, api_key: credential.key, rate_limit_per_minute: policy.minute, acl_group: policy.group, mode: 'kong' };
      },
      async applyPlan(consumerId, plan, oldPlan) {
        const policy = planPolicy(plan);
        if (kongMock || consumerId.startsWith('synthetic-')) return { rate_limit_per_minute: policy.minute, acl_group: policy.group, mode: 'synthetic' };
        if (!cfg.kongUrl || !cfg.kongApiRouteId) throw fail(503, 'KONG_NOT_CONFIGURED');
        return applyKongPlan(cfg, consumerId, plan, oldPlan);
      },
      async deactivate(consumerId) {
        if (kongMock || consumerId.startsWith('synthetic-')) return { mode: 'synthetic' };
        if (!cfg.kongUrl) throw fail(503, 'KONG_NOT_CONFIGURED');
        // Remove this application's memberships only. Shared plans and other consumers stay intact.
        const memberships = asRows(await kongRequest(cfg, `/consumers/${encodeURIComponent(consumerId)}/acls`));
        for (const membership of memberships) await kongRequest(cfg, `/consumers/${encodeURIComponent(consumerId)}/acls/${encodeURIComponent(membership.id)}`, { method: 'DELETE' });
        return { mode: 'kong' };
      },
    },
    usage: {
      async forApplication(app, from, to) {
        if (cfg.mockExternal) return { source: 'synthetic', totals: [], timeline: [] };
        if (!cfg.searchUrl || !app.kong_consumer_id) throw fail(503, 'USAGE_NOT_CONFIGURED');
        const url = new URL('/logstash-*/_search', cfg.searchUrl);
        const basic = Buffer.from(`${cfg.searchUser || ''}:${cfg.searchPassword || ''}`).toString('base64');
        const result = await jsonRequest(url, { method: 'POST', headers: { authorization: `Basic ${basic}` }, body: { size: 0, query: { bool: { filter: [{ term: { 'consumer.id.keyword': app.kong_consumer_id } }, { range: { '@timestamp': { gte: from, lte: to } } }] } }, aggs: { services: { terms: { field: 'route.name.keyword', size: 100 } }, timeline: { date_histogram: { field: '@timestamp', calendar_interval: 'day' } } } } });
        return { source: 'elasticsearch', totals: result.aggregations?.services?.buckets || [], timeline: result.aggregations?.timeline?.buckets || [] };
      },
    },
    email: {
      async sendReset({ to, url }) {
        if (cfg.mockExternal) return { delivered: false, mode: 'synthetic' };
        if (!cfg.emailUrl || !cfg.emailToken) throw fail(503, 'EMAIL_NOT_CONFIGURED');
        return jsonRequest(cfg.emailUrl, { method: 'POST', headers: { authorization: `Bearer ${cfg.emailToken}` }, body: { to, template: 'dashboard-password-reset', variables: { reset_url: url } } });
      },
    },
  };
}
