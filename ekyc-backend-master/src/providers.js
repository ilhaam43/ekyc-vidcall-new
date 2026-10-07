import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { value } from '@ekyc/shared/config';
import { assert, AppError } from '@ekyc/shared/errors';
const ajv = new Ajv({ strict: false });
export class Providers {
  constructor(settings) { this.settings = settings ?? JSON.parse(value('PROVIDERS_CONFIG_FILE') ? readFileSync(value('PROVIDERS_CONFIG_FILE'), 'utf8') : '{}'); }
  async execute(tenantId, provider, operation, input, idempotencyKey) {
    const cfg = this.settings[tenantId]?.[provider]?.[operation];
    assert(cfg && cfg.url && cfg.inputSchema && cfg.outputSchema, 503, 'PROVIDER_NOT_CONFIGURED');
    assert(ajv.validate(cfg.inputSchema, input), 422, 'INVALID_PROVIDER_REQUEST');
    const url = new URL(cfg.url); assert(url.protocol === 'https:' || (cfg.testOnly === true && process.env.NODE_ENV === 'test'), 500, 'INSECURE_PROVIDER_URL');
    // Config owns hosts, credentials, and mappings. Incoming headers are never forwarded.
    const method = cfg.method || 'POST';
    const headers = { 'content-type': 'application/json', ...cfg.headers };
    if (cfg.idempotencyHeader && idempotencyKey) headers[cfg.idempotencyHeader] = idempotencyKey;
    if (cfg.oauth) {
      const tokenUrl = new URL(cfg.oauth.url); assert(tokenUrl.protocol === 'https:', 500, 'INSECURE_PROVIDER_URL');
      const response = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.oauth.clientId, client_secret: cfg.oauth.clientSecret, ...(cfg.oauth.scope ? { scope: cfg.oauth.scope } : {}) }), signal: AbortSignal.timeout(10000), redirect: 'error' });
      const token = await response.json(); assert(response.ok && token.access_token, 502, 'PROVIDER_AUTH_FAILED'); headers.authorization = `Bearer ${token.access_token}`;
    }
    const payload = { ...cfg.defaults, ...input };
    for (const [target, source] of Object.entries(cfg.fieldMap || {})) { payload[target] = input[source]; if (target !== source) delete payload[source]; }
    if (method === 'GET') for (const [key, val] of Object.entries(payload)) { assert(typeof val !== 'object', 422, 'INVALID_PROVIDER_QUERY'); url.searchParams.set(key, String(val)); }
    const attempts = method === 'GET' ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (response.status >= 500 && attempt + 1 < attempts) continue;
        assert(response.ok, response.status >= 500 ? 502 : 422, 'PROVIDER_REJECTED');
        const result = await response.json(); assert(ajv.validate(cfg.outputSchema, result), 502, 'INVALID_PROVIDER_RESPONSE'); return result;
      } catch (err) { if (err instanceof AppError) throw err; if (attempt + 1 === attempts) throw new AppError(502, 'PROVIDER_UNAVAILABLE'); }
    }
  }
}
// Preserve route names. Provider behavior is enabled only with an explicit validated contract.
export const legacyProviderRoutes = [
  ['post', '/verify_selfie', 'asliri', 'verify_selfie'], ['post', '/verify_identity', 'vida', 'ocr'], ['post', '/verify_identity_dukcapil', 'vida', 'fraud'],
  ['post', '/sivInitiateFlow', 'onekyc-staging', 'initiate_flow'], ['post', '/initiateFlowSDK', 'onekyc-staging', 'initiate_flow'], ['get', '/goto-partner-token', 'onekyc-staging', 'partner_token'],
  ...['staging', 'prod'].flatMap(env => [
    ['get', `/onekyc_la_auth_${env}/user-token`, `onekyc-${env}`, 'user_token'],
    ...[['get', 'user-token', 'user_token'], ['post', 'ocr-launch-url', 'ocr_launch'], ['get', 'ocr-result', 'ocr_result'], ['post', 'liveness-launch-url', 'liveness_launch'], ['get', 'liveness-result', 'liveness_result'], ['get', 'esign-url', 'esign_url'], ['put', 'esign-confirm-submission', 'esign_confirm'], ['get', 'esign-result', 'esign_result'], ['get', 'esign-result-detail/:submissionId', 'esign_detail']].map(([method, path, op]) => [method, `/onekyc_la_${env}/${path}`, `onekyc-${env}`, op]),
  ]),
  ...['goto-ktp', 'liveness-gtf', 'facematch-gtf'].flatMap(prefix => [['get', 'partner-token'], ['get', 'presigned-url'], ['put', 'confirm-upload'], ['get', 'status-polling'], ['get', 'result-details'], ...(prefix === 'facematch-gtf' ? [['post', 'initiate-flow']] : [])].map(([method, path]) => [method, `/${prefix}/${prefix === 'goto-ktp' ? '' : `${prefix}-`}${path}`, 'onekyc-staging', `${prefix}_${path}`])),
];
