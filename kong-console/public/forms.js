const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const list = value => Array.isArray(value) ? value.join(', ') : '';
const split = value => String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean);
const field = (name, label, value = '', options = {}) => `<label class="field ${options.wide ? 'wide' : ''}"><span class="field-label">${escape(label)} <em>(${options.required ? 'required' : 'optional'})</em></span>${options.multiline ? `<textarea name="${name}" rows="${options.rows || 5}" ${options.required ? 'required' : ''} placeholder="${escape(options.placeholder || '')}">${escape(value)}</textarea>` : `<input name="${name}" type="${options.type || 'text'}" value="${escape(value)}" ${options.required ? 'required' : ''} ${options.list ? `list="${escape(options.list)}"` : ''} ${options.min !== undefined ? `min="${options.min}"` : ''} placeholder="${escape(options.placeholder || '')}">`}${options.hint ? `<small>${escape(options.hint)}</small>` : ''}</label>`;
const choice = (name, label, value, values, options = {}) => `<label class="field ${options.wide ? 'wide' : ''}"><span class="field-label">${escape(label)} <em>(${options.required ? 'required' : 'optional'})</em></span><select name="${name}" ${options.required ? 'required' : ''}>${values.map(([key, title]) => `<option value="${escape(key)}" ${String(value ?? '') === String(key) ? 'selected' : ''}>${escape(title)}</option>`).join('')}</select>${options.hint ? `<small>${escape(options.hint)}</small>` : ''}</label>`;
const check = (name, label, value) => `<label class="check-field"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}><span>${escape(label)}</span></label>`;
const ref = (name, label, value, rows) => choice(name, label, value?.id || value || '', [['', 'None'], ...rows.map(row => [row.id, row.name || row.username || row.id])]);
const tags = value => field('tags', 'Tags', list(value), { wide: true, placeholder: 'finance, production', hint: 'Separate tags with commas.' });
const configValue = (config, path) => path.split('.').reduce((current, key) => current?.[key], config);
const secretField = name => /password|secret|token|credential|private|(?:^|[._])key(?:$|[._])/i.test(name) && !['key_names', 'key_claim_name', 'public_key', 'rsa_public_key'].includes(name.split('.').at(-1));
function schemaFields(fields, config, path = '', prefix = 'config', mode = 'create') {
  return (fields || []).map(entry => {
    const [key, rule] = Object.entries(entry)[0] || [];
    if (!key || !rule) return '';
    const name = path ? `${path}.${key}` : key, value = configValue(config, name) ?? (mode === 'edit' && secretField(name) ? undefined : rule.default);
    if (rule.type === 'record' && rule.fields) return `<div class="form-section wide"><strong>${escape(name.replaceAll('.', ' / ').replaceAll('_', ' '))}</strong></div>${schemaFields(rule.fields, config, name, prefix, mode)}`;
    const label = key.replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());
    const hint = rule.description || '', required = Boolean(rule.required);
    const inputName = `${prefix}.${name}`;
    if (rule.type === 'boolean') return choice(inputName, label, String(value ?? ''), [['', 'Use gateway default'], ['true', 'Yes'], ['false', 'No']], { hint });
    if (rule.one_of?.length) return choice(inputName, label, String(value ?? ''), [['', 'Select…'], ...rule.one_of.map(item => [String(item), String(item)])], { hint, required });
    if (['array', 'set'].includes(rule.type) && ['string', 'integer', 'number'].includes(rule.elements?.type)) return field(inputName, label, list(value), { hint: `${hint}${hint ? ' ' : ''}Separate values with commas.`, required });
    if (rule.type === 'map' && rule.keys?.type === 'string' && ['array', 'set'].includes(rule.values?.type) && rule.values.elements?.type === 'string') return field(inputName, label, Object.entries(value || {}).map(([name, values]) => `${name}: ${values.join(', ')}`).join('\n'), { multiline: true, hint: `${hint} One header per line: Header-Name: value, another-value.` });
    if (['array', 'set'].includes(rule.type) && rule.elements?.type === 'record' && rule.elements.fields?.some(entry => entry.ip)) return field(inputName, label, (value || []).map(item => `${item.ip || ''}, ${item.port || ''}`).join('\n'), { multiline: true, hint: 'One address per line: IP address or CIDR, port (port optional).' });
    if (['string', 'integer', 'number'].includes(rule.type)) return field(inputName, label, secretField(name) ? '' : value ?? '', { hint: secretField(name) && mode === 'edit' ? 'Leave blank to keep the existing secret.' : hint, required: required && !(secretField(name) && mode === 'edit'), type: secretField(name) ? 'password' : ['integer', 'number'].includes(rule.type) ? 'number' : 'text' });
    return `<div class="unsupported-field">${escape(label)} requires a complex value. Existing values are preserved when editing.</div>`;
  }).join('');
}
const advancedKeys = {
  services: ['tls_verify', 'tls_verify_depth', 'ca_certificates', 'enabled'],
  routes: ['headers', 'snis', 'sources', 'destinations', 'path_handling', 'https_redirect_status_code', 'regex_priority', 'request_buffering', 'response_buffering'],
  upstreams: ['hash_fallback', 'hash_on_header', 'hash_fallback_header', 'hash_on_cookie', 'hash_on_cookie_path', 'hash_on_query_arg', 'hash_fallback_query_arg', 'hash_on_uri_capture', 'hash_fallback_uri_capture', 'host_header', 'healthchecks'],
};
function advancedFields(editor) {
  const entries = (editor.schema?.fields || []).filter(entry => advancedKeys[editor.entity]?.includes(Object.keys(entry)[0]));
  return entries.length ? `<div class="form-section wide"><strong>Advanced settings</strong></div>${editor.entity === 'services' ? ref('client_certificate_id', 'Client certificate', editor.value?.client_certificate, editor.refs?.certificates || []) : ''}${schemaFields(entries, editor.value || {}, '', 'advanced', editor.mode)}` : '';
}
export function schemaPayload(fields, data, prefix, mode = 'create', original = {}) {
  const result = {};
  const lookup = (entries, path) => { const rule = entries?.find(entry => Object.hasOwn(entry, path[0]))?.[path[0]]; return path.length === 1 ? rule : lookup(rule?.fields, path.slice(1)); };
  for (const [key, rawValue] of data) {
    if (!key.startsWith(`${prefix}.`)) continue;
    const name = key.slice(prefix.length + 1), path = name.split('.');
    if (path.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Invalid setting name');
    const rule = lookup(fields, path); if (!rule) continue;
    const raw = String(rawValue).trim();
    if (secretField(name) && !raw) continue;
    if (!raw && ['array', 'set', 'map'].includes(rule.type) && !rule.required && (mode === 'create' || configValue(original, name) == null)) continue;
    let value;
    if (['array', 'set'].includes(rule.type)) {
      if (rule.elements?.type === 'record') value = raw ? raw.split(/\r?\n/).filter(Boolean).map(line => { const [ip, port] = line.split(',').map(item => item.trim()); if (!ip && !port) throw new Error(`Enter an address or port for ${name}`); const item = {}; if (ip) item.ip = ip; if (port) { item.port = Number(port); if (!Number.isInteger(item.port) || item.port < 1 || item.port > 65535) throw new Error(`Invalid port for ${name}`); } return item; }) : [];
      else value = split(raw).map(item => ['integer', 'number'].includes(rule.elements?.type) ? Number(item) : item);
      if (value.some(item => typeof item === 'number' && !Number.isFinite(item))) throw new Error(`Invalid number for ${name}`);
    } else if (rule.type === 'map') { value = {}; for (const line of raw.split(/\r?\n/).filter(Boolean)) { const separator = line.indexOf(':'); if (separator < 1) throw new Error(`Use Header-Name: value for ${name}`); const header = line.slice(0, separator).trim(); if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(header) || ['__proto__', 'prototype', 'constructor'].includes(header)) throw new Error('Invalid header name'); value[header] = split(line.slice(separator + 1)); } }
    else if (raw === '') { if (mode === 'edit' && rule.type === 'string' && configValue(original, name) != null) value = null; else continue; }
    else if (rule.type === 'boolean') { if (!['true', 'false'].includes(raw)) throw new Error(`Invalid boolean for ${name}`); value = raw === 'true'; }
    else if (['integer', 'number'].includes(rule.type)) { value = Number(raw); if (!Number.isFinite(value) || rule.type === 'integer' && !Number.isInteger(value)) throw new Error(`Invalid number for ${name}`); }
    else value = raw;
    let cursor = result; for (const part of path.slice(0, -1)) cursor = cursor[part] ||= {}; cursor[path.at(-1)] = value;
  }
  return result;
}
const preset = {
  'key-auth': { key_names: ['apikey'], hide_credentials: true },
  acl: { allow: ['plan-standard'], hide_groups_header: true },
  'rate-limiting': { minute: 60, policy: 'local' },
  cors: { origins: ['https://example.com'], methods: ['GET', 'POST'], credentials: false },
};
export const pluginPreset = name => preset[name] || {};
const configRows = config => Object.entries(config || {}).filter(([, value]) => value !== null && typeof value !== 'object' || Array.isArray(value)).map(([key, value]) => ({ key, type: Array.isArray(value) ? 'list' : typeof value, value: Array.isArray(value) ? value.join(', ') : String(value) }));
export function renderConfigRows(rows) {
  return rows.map((row, index) => `<div class="config-row"><input name="config_key_${index}" aria-label="Setting name" placeholder="Setting name" value="${escape(row.key)}" required><select name="config_type_${index}" aria-label="Setting type">${['string', 'number', 'boolean', 'list'].map(type => `<option value="${type}" ${type === row.type ? 'selected' : ''}>${type}</option>`).join('')}</select><input name="config_value_${index}" aria-label="Setting value" placeholder="Value" value="${escape(row.value)}"><button type="button" class="subtle" data-action="remove-config" data-index="${index}" aria-label="Remove setting">×</button></div>`).join('');
}
export function editorFields(editor) { return basicEditorFields(editor) + advancedFields(editor); }
function basicEditorFields(editor) {
  const v = editor.value || {}, refs = editor.refs || {};
  switch (editor.entity) {
    case 'services': return field('name', 'Name', v.name, { required: true, placeholder: 'customer-api', hint: 'A unique name for this Service.' }) + tags(v.tags) + field('url', 'URL', '', { type: 'url', placeholder: 'http://service:8080', hint: 'Optional shortcut. When set, its protocol, host, port, and path are used.' }) + choice('protocol', 'Protocol', v.protocol || 'http', [['http', 'http'], ['https', 'https']]) + field('host', 'Host', v.host, { placeholder: 'service.internal', hint: 'Required when URL is empty.' }) + field('port', 'Port', v.port ?? 80, { type: 'number', min: 1 }) + field('path', 'Path', v.path || '', { placeholder: '/api' }) + field('retries', 'Retries', v.retries ?? 5, { type: 'number', min: 0 }) + field('connect_timeout', 'Connect timeout (ms)', v.connect_timeout ?? 60000, { type: 'number', min: 1 }) + field('write_timeout', 'Write timeout (ms)', v.write_timeout ?? 60000, { type: 'number', min: 1 }) + field('read_timeout', 'Read timeout (ms)', v.read_timeout ?? 60000, { type: 'number', min: 1 });
    case 'routes': return field('name', 'Route name', v.name, { required: true }) + ref('service_id', 'Service', v.service, refs.services || []) + field('paths', 'Paths', list(v.paths), { placeholder: '/partner/v1, /partner/v2' }) + field('hosts', 'Hosts', list(v.hosts), { placeholder: 'api.example.com' }) + field('methods', 'Methods', list(v.methods), { placeholder: 'GET, POST' }) + field('protocols', 'Protocols', list(v.protocols || ['http', 'https']), { placeholder: 'http, https' }) + check('strip_path', 'Strip matched path before proxying', v.strip_path ?? true) + check('preserve_host', 'Preserve incoming Host header', v.preserve_host ?? false) + tags(v.tags);
    case 'consumers': return field('username', 'Username', v.username, { required: true }) + field('custom_id', 'External ID', v.custom_id) + tags(v.tags);
    case 'plugins': return `<div class="field"><span class="field-label">Plugin</span><input name="name" value="${escape(v.name || 'key-auth')}" readonly></div>` + check('enabled', 'Enabled', v.enabled ?? true) + `<div class="form-section wide"><strong>Apply to</strong><span>Combine Service, Route, and Consumer scopes, or leave all empty for a global plugin.</span></div>` + ref('service_id', 'Service', v.service, refs.services || []) + ref('route_id', 'Route', v.route, refs.routes || []) + ref('consumer_id', 'Consumer', v.consumer, refs.consumers || []) + `<div class="form-section wide"><strong>Plugin settings</strong><span>Configure the selected plugin below.</span></div>${editor.schema ? schemaFields(editor.schema.fields?.find(entry => entry.config)?.config?.fields, v.config || pluginPreset(v.name || 'key-auth'), '', 'config', editor.mode) : ''}<div class="form-section wide"><strong>Additional settings</strong><span>Use these rows for settings not covered by the fields above.</span></div><div class="config-list wide" id="config-list">${renderConfigRows(editor.configRows || (editor.schema ? [] : configRows(v.config || pluginPreset(v.name || 'key-auth'))))}</div><button type="button" class="subtle wide add-setting" data-action="add-config">+ Add setting</button>` + tags(v.tags);
    case 'upstreams': return field('name', 'Upstream name', v.name, { required: true, placeholder: 'api.internal' }) + choice('algorithm', 'Algorithm', v.algorithm || 'round-robin', [['round-robin', 'Round robin'], ['consistent-hashing', 'Consistent hashing'], ['least-connections', 'Least connections'], ['latency', 'Latency']]) + choice('hash_on', 'Hash on', v.hash_on || 'none', [['none', 'None'], ['consumer', 'Consumer'], ['ip', 'IP address'], ['header', 'Header'], ['cookie', 'Cookie'], ['path', 'Path']]) + field('slots', 'Slots', v.slots ?? 10000, { type: 'number', min: 1 }) + tags(v.tags);
    case 'certificates': return field('cert', 'Certificate PEM', '', { multiline: true, wide: true, rows: 7, required: editor.mode === 'create', hint: editor.mode === 'edit' ? 'Leave blank to keep the current certificate.' : '' }) + field('key', 'Private key PEM', '', { multiline: true, wide: true, rows: 7, required: editor.mode === 'create', hint: editor.mode === 'edit' ? 'Leave blank to keep the current private key.' : '' }) + tags(v.tags);
    case 'ca_certificates': return field('cert', 'CA certificate PEM', editor.mode === 'create' ? '' : v.cert, { multiline: true, wide: true, rows: 8, required: true }) + tags(v.tags);
    case 'snis': return field('name', 'Hostname', v.name, { required: true, placeholder: 'api.example.com' }) + ref('certificate_id', 'Certificate', v.certificate, refs.certificates || []) + tags(v.tags);
    case 'key-auth': return field('key', 'API key', '', { hint: editor.mode === 'edit' ? 'Leave blank to keep the existing key.' : 'Leave blank to generate a secure key automatically.' }) + field('ttl', 'Expiry (seconds)', v.ttl ?? '', { type: 'number', min: 1, hint: 'Leave blank to keep the current expiry when editing.' }) + tags(v.tags);
    case 'acls': return field('group', 'ACL group', v.group, { required: true, placeholder: 'plan-standard' }) + tags(v.tags);
    case 'basic-auth': return field('username', 'Basic Auth username', v.username, { required: true }) + field('password', 'Password', '', { required: editor.mode === 'create', type: 'password', hint: editor.mode === 'edit' ? 'Leave blank to keep the current password.' : '' }) + tags(v.tags);
    case 'jwt': return field('key', 'JWT key', v.key || '', { hint: 'Kong generates a key on creation when blank.' }) + field('secret', 'JWT secret', '', { type: 'password', hint: editor.mode === 'edit' ? 'Leave blank to keep the current secret.' : 'Optional for HMAC algorithms; generated when blank.' }) + choice('algorithm', 'Algorithm', v.algorithm || 'HS256', [['HS256', 'HS256'], ['HS384', 'HS384'], ['HS512', 'HS512'], ['RS256', 'RS256'], ['ES256', 'ES256']]) + field('rsa_public_key', 'Public key PEM', v.rsa_public_key || '', { multiline: true, wide: true }) + tags(v.tags);
    case 'hmac-auth': return field('username', 'HMAC username', v.username, { required: true }) + field('secret', 'HMAC secret', '', { type: 'password', hint: editor.mode === 'edit' ? 'Leave blank to keep the current secret.' : 'Kong generates a secret when blank.' }) + tags(v.tags);
    case 'targets': return field('target', 'Target host and port', v.target, { required: true, placeholder: 'api.internal:8080' }) + field('weight', 'Weight', v.weight ?? 100, { type: 'number', min: 0 }) + tags(v.tags);
    default: return '';
  }
}
export function readConfigRows(form) {
  const rows = [...form.querySelectorAll('.config-row')];
  return rows.map(row => ({ key: row.querySelector('[name^="config_key_"]').value.trim(), type: row.querySelector('[name^="config_type_"]').value, value: row.querySelector('[name^="config_value_"]').value }));
}
export function serializeEditor(editor, form) {
  const data = new FormData(form), value = key => String(data.get(key) ?? '').trim(), body = {}, add = (key, input = key) => { if (value(input)) body[key] = value(input); }, number = key => { if (value(key)) body[key] = Number(value(key)); }, array = key => { if (value(key)) body[key] = split(value(key)); };
  switch (editor.entity) {
    case 'services': { add('name'); if (value('url')) { const url = new URL(value('url')); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Service URL must use HTTP or HTTPS'); Object.assign(body, { protocol: url.protocol.slice(0, -1), host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), path: url.pathname === '/' ? null : url.pathname }); } else { if (!value('host')) throw new Error('Enter a Service host or URL'); add('protocol'); add('host'); number('port'); body.path = value('path') || null; } ['retries', 'connect_timeout', 'write_timeout', 'read_timeout'].forEach(number); break; }
    case 'routes': add('name'); if (value('service_id') || editor.mode === 'edit') body.service = value('service_id') ? { id: value('service_id') } : null; ['paths', 'hosts', 'methods', 'protocols'].forEach(key => { body[key] = split(value(key)); }); body.strip_path = data.has('strip_path'); body.preserve_host = data.has('preserve_host'); if (!body.paths.length && !body.hosts.length && !body.methods.length) throw new Error('Add at least one path, host, or method'); break;
    case 'consumers': add('username'); if (value('custom_id') || editor.mode === 'edit') body.custom_id = value('custom_id') || null; break;
    case 'plugins': {
      add('name'); body.enabled = data.has('enabled');
      for (const scope of ['service', 'route', 'consumer']) if (value(`${scope}_id`) || editor.mode === 'edit') body[scope] = value(`${scope}_id`) ? { id: value(`${scope}_id`) } : null;
      const entries = editor.schema?.fields?.find(entry => entry.config)?.config?.fields;
      const config = schemaPayload(entries, data, 'config', editor.mode, editor.value?.config);
      for (const row of readConfigRows(form)) {
        if (!row.key) continue;
        if (['__proto__', 'constructor', 'prototype'].includes(row.key)) throw new Error('Invalid setting name');
        if (Object.hasOwn(config, row.key)) throw new Error(`Duplicate setting: ${row.key}`);
        if (row.type === 'number') { if (row.value.trim() === '' || !Number.isFinite(Number(row.value))) throw new Error(`Invalid number for ${row.key}`); config[row.key] = Number(row.value); }
        else if (row.type === 'boolean') { if (!['true', 'false'].includes(row.value.trim().toLowerCase())) throw new Error(`${row.key} must be true or false`); config[row.key] = row.value.trim().toLowerCase() === 'true'; }
        else if (row.type === 'list') config[row.key] = split(row.value);
        else config[row.key] = row.value;
      }
      body.config = config; break;
    }
    case 'upstreams': add('name'); add('algorithm'); add('hash_on'); number('slots'); break;
    case 'certificates': add('cert'); add('key'); break;
    case 'ca_certificates': add('cert'); break;
    case 'snis': add('name'); if (!value('certificate_id')) throw new Error('Select a certificate'); body.certificate = { id: value('certificate_id') }; break;
    case 'key-auth': add('key'); number('ttl'); break;
    case 'acls': add('group'); break;
    case 'basic-auth': add('username'); add('password'); break;
    case 'jwt': add('key'); add('secret'); add('algorithm'); add('rsa_public_key'); break;
    case 'hmac-auth': add('username'); add('secret'); break;
    case 'targets': add('target'); number('weight'); break;
  }
  array('tags');
  if (editor.mode === 'edit' && !value('tags')) body.tags = [];
  Object.assign(body, schemaPayload(editor.schema?.fields, data, 'advanced', editor.mode, editor.value));
  if (editor.entity === 'services' && data.has('client_certificate_id')) body.client_certificate = value('client_certificate_id') ? { id: value('client_certificate_id') } : null;
  return body;
}
