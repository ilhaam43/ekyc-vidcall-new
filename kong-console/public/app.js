import { editorFields, pluginPreset, readConfigRows, renderConfigRows, serializeEditor } from './forms.js';
import { managementLabels, managementPage, parseConsumerCsv } from './management.js';
const app = document.getElementById('app');
const labels = { services: 'Services', routes: 'Routes', consumers: 'Consumers', plugins: 'Plugins', upstreams: 'Upstreams', certificates: 'Certificates', ca_certificates: 'CA Certificates', snis: 'SNIs' };
const descriptions = {
  services: 'Services represent your upstream APIs and define how Kong connects to them.',
  routes: 'Routes match incoming requests and send them to the associated Service.',
  consumers: 'Consumers represent the clients that access APIs through Kong.',
  plugins: 'Plugins add authentication, traffic control, logging, and other policies to requests.',
  upstreams: 'Upstreams distribute requests across one or more healthy Targets.',
  certificates: 'Certificates provide TLS identities for gateway hostnames.',
  ca_certificates: 'CA Certificates establish trust for upstream TLS connections.',
  snis: 'SNIs map TLS hostnames to gateway Certificates.',
};
const defaults = { plugins: { name: 'key-auth', enabled: true }, routes: { strip_path: true }, upstreams: { algorithm: 'round-robin', hash_on: 'none', slots: 10000 } };
const state = { csrf: '', username: '', environmentUsername: '', role: 'admin', nodeId: sessionStorage.getItem('kong-node') || 'local', nodeName: 'Local Kong', nodes: [], view: 'dashboard', requestId: 0, extra: null, restorePreview: null, importResult: null, upstreamHealth: [], entity: 'services', rows: [], next: null, overview: null, selected: null, detailTab: 'details', relatedRows: [], nested: 'key-auth', nestedRows: [], secret: '', search: '', pageSize: 25, page: 1, error: '', editor: null, catalog: null, loading: false };
const pluginGroups = {
  Authentication: ['basic-auth', 'key-auth', 'oauth2', 'hmac-auth', 'jwt', 'ldap-auth', 'session'],
  Security: ['acl', 'ip-restriction', 'bot-detection', 'cors', 'request-size-limiting'],
  'Traffic Control': ['rate-limiting', 'response-ratelimiting', 'request-termination', 'proxy-cache'],
  Serverless: ['aws-lambda', 'azure-functions', 'pre-function', 'post-function'],
  'Analytics & Monitoring': ['prometheus', 'statsd', 'datadog', 'zipkin', 'opentelemetry', 'correlation-id'],
  Transformations: ['request-transformer', 'response-transformer', 'grpc-web', 'grpc-gateway'],
  Logging: ['http-log', 'tcp-log', 'udp-log', 'file-log', 'syslog', 'loggly'],
};
const pluginGroup = name => Object.entries(pluginGroups).find(([, names]) => names.includes(name))?.[0] || 'Other';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function pluginCatalog() {
  const grouped = Object.groupBy(state.catalog.names, pluginGroup);
  return `<div class="konga-title"><h2>Add ${state.catalog.initialValue ? 'Scoped' : 'Global'} Plugin</h2><p>Choose a plugin installed on ${esc(state.nodeName)}, then configure its settings.</p></div><section class="plugin-catalog">${Object.entries(grouped).map(([group, names]) => `<div class="plugin-group"><h3>${esc(group)}</h3><div>${names.map(name => `<button data-action="plugin-select" data-value="${esc(name)}"><strong>${esc(name)}</strong><span>${esc(group)}</span></button>`).join('')}</div></div>`).join('') || '<p>No plugins are installed on this gateway.</p>'}<button class="subtle" data-action="plugin-cancel">Back</button></section>`;
}
async function openCatalog(initialValue) { state.catalog = { names: await api('/plugins/catalog'), initialValue }; workspace(); }
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { 'x-kong-node': state.nodeId, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(!['GET', 'HEAD'].includes(method) && state.csrf ? { 'x-csrf-token': state.csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.code || `HTTP_${response.status}`);
  return result.data;
}
function login() {
  app.innerHTML = `<div class="login"><section class="login-form-wrap"><form class="login-form" id="login"><div class="login-wordmark"><span class="brand-mark"></span><strong>KONGA</strong><small>CONTROL</small></div><h2>Sign in to Kong Control</h2><p>Gateway administration</p>${state.error ? `<div class="notice" role="alert">${esc(state.error)}</div>` : ''}<label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></section></div>`;
}
const dateLabel = value => {
  if (!value) return '—';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(date);
};
function rowSummary(row) {
  const tags = row.tags?.join(', ') || '—';
  const created = dateLabel(row.created_at);
  if (state.entity === 'services') return [row.name || row.id, row.host || '—', tags, created];
  if (state.entity === 'routes') return [row.name || row.id, (row.paths || []).join(', ') || '—', row.service?.id || '—', created];
  if (state.entity === 'consumers') return [row.username || row.id, row.custom_id || '—', tags, created];
  if (state.entity === 'plugins') return [row.name || row.id, row.route?.id ? 'Route' : row.service?.id ? 'Service' : 'Global', row.consumer?.id || row.route?.id || row.service?.id || 'All requests', created];
  if (state.entity === 'upstreams') return [row.name || row.id, row.algorithm || 'round-robin', row.slots ?? '—', created];
  if (state.entity === 'certificates') return [row.id, (row.snis || []).join(', ') || '—', tags, created];
  if (state.entity === 'ca_certificates') return [row.id, row.cert ? 'Configured' : '—', tags, created];
  return [row.name || row.id, row.certificate?.id || '—', tags, created];
}
function table() {
  const rows = state.rows.filter(row => !state.search || JSON.stringify(row).toLowerCase().includes(state.search.toLowerCase()));
  const headers = {
    services: ['Name', 'Host', 'Tags', 'Created'],
    routes: ['Name / ID', 'Paths', 'Service', 'Created'],
    consumers: ['Username', 'Custom ID', 'Tags', 'Created'],
    plugins: ['Name', 'Scope', 'Apply to', 'Created'],
    upstreams: ['Name', 'Algorithm', 'Slots', 'Created'],
    certificates: ['ID', 'SNIs', 'Tags', 'Created'],
    ca_certificates: ['ID', 'Certificate', 'Tags', 'Created'],
    snis: ['Hostname', 'Certificate', 'Tags', 'Created'],
  };
  const from = (state.page - 1) * state.pageSize;
  const visible = rows.slice(from, from + state.pageSize);
  return `<div class="table-wrap"><table><thead><tr><th class="view-column"></th>${headers[state.entity].map(label => `<th>${esc(label)}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${visible.map(row => {
    const [first, second, third, fourth] = rowSummary(row);
    const managed = state.entity === 'consumers' && row.username?.startsWith('ekyc-application-');
    return `<tr><td class="view-column"><button class="view-icon" data-action="detail" data-id="${esc(row.id)}" aria-label="View ${esc(first)}">◉</button></td><td><button class="resource-link" data-action="detail" data-id="${esc(row.id)}">${esc(first)}</button>${managed ? '<small>Managed by eKYC plan</small>' : ''}</td><td><code>${esc(second)}</code></td><td><code>${esc(third)}</code></td><td>${esc(fourth)}</td><td class="row-actions"><button data-action="detail" data-id="${esc(row.id)}">Details</button>${managed || state.role !== 'admin' ? '' : `<button data-action="edit" data-id="${esc(row.id)}">Edit</button><button class="danger" data-action="delete" data-id="${esc(row.id)}">Delete</button>`}</td></tr>`;
  }).join('') || `<tr><td colspan="6" class="empty">${state.loading ? 'Loading gateway resources…' : 'No resources found.'}</td></tr>`}</tbody></table></div><div class="list-footer"><span>Showing ${rows.length ? from + 1 : 0}–${Math.min(from + state.pageSize, rows.length)} of ${rows.length}${state.next ? '+' : ''} loaded records</span><div><button class="subtle" data-action="page-prev" ${state.page <= 1 ? 'disabled' : ''}>‹ Previous</button><span>Page ${state.page}</span><button class="subtle" data-action="page-next" ${from + state.pageSize >= rows.length && !state.next ? 'disabled' : ''}>Next ›</button></div></div>`;
}
function nestedPanel() {
  if (state.detailTab === 'plugins') return relatedPanel();
  if (!state.selected || !['consumers', 'upstreams'].includes(state.entity)) return '';
  const readOnly = state.nested === 'acls' && state.entity === 'consumers' && state.selected.username?.startsWith('ekyc-application-');
  const title = ({ 'key-auth': 'API keys', acls: 'ACL groups', 'basic-auth': 'Basic Auth', jwt: 'JWT', 'hmac-auth': 'HMAC', targets: 'Targets' })[state.nested];
  return `<div class="detail-section-head"><div><h3>${esc(title)}</h3><p>Credentials and policies assigned to this ${esc(state.entity === 'consumers' ? 'Consumer' : 'Upstream')}.</p></div>${readOnly || state.role !== 'admin' ? '' : `<button class="primary" data-action="nested-create">+ Add ${esc(title)}</button>`}</div>
    ${state.secret ? `<div class="secret"><strong>New credential — shown once</strong><code>${esc(state.secret)}</code><button class="subtle" data-action="copy">Copy credential</button></div>` : ''}
    ${readOnly ? '<p class="muted pad">This ACL membership is assigned by the eKYC application plan.</p>' : ''}
    <div class="nested-list">${state.nestedRows.map(row => `<div class="nested-row"><span><strong>${esc(row.group || row.target || row.username || row.key || row.id)}</strong> <code>${esc(row.id || '')}</code></span>${readOnly || state.role !== 'admin' ? '' : `<span><button class="link-button" data-action="nested-edit" data-id="${esc(row.id)}">Edit</button><button class="link-button danger" data-action="nested-delete" data-id="${esc(row.id)}">Delete</button></span>`}</div>`).join('') || '<p class="muted">No records.</p>'}</div>`;
}
function relatedPanel() {
  const kind = state.detailTab;
  const title = kind === 'routes' ? 'Routes' : 'Plugins';
  return `<div class="detail-section-head"><div><h3>${title}</h3><p>${kind === 'routes' ? 'Routes attached to this Service.' : 'Policies assigned to this resource.'}</p></div>${state.role === 'admin' ? `<button class="primary" data-action="related-create">+ Add ${kind === 'routes' ? 'route' : 'plugin'}</button>` : ''}</div><div class="nested-list">${state.relatedRows.map(row => `<div class="nested-row"><span><strong>${esc(row.name || row.id)}</strong><code>${esc(kind === 'routes' ? (row.paths || []).join(', ') || row.id : row.id)}</code></span>${state.role === 'admin' ? `<span><button class="link-button" data-action="related-edit" data-id="${esc(row.id)}">Edit</button><button class="link-button danger" data-action="related-delete" data-id="${esc(row.id)}">Delete</button></span>` : ''}</div>`).join('') || '<p class="muted pad">No associated records.</p>'}</div>`;
}
function details() {
  if (state.catalog) return pluginCatalog();
  if (!state.selected) return '';
  const fields = Object.entries(state.selected).filter(([key]) => !['key', 'secret', 'password'].includes(key) && state.selected[key] !== null);
  const display = value => Array.isArray(value) ? value.join(', ') || '—' : typeof value === 'object' ? (value.id || JSON.stringify(value)) : String(value);
  const tabs = [['details', 'Details'], ...(state.entity === 'services' ? [['routes', 'Routes'], ['plugins', 'Plugins']] : state.entity === 'routes' ? [['plugins', 'Plugins']] : state.entity === 'consumers' ? [['plugins', 'Plugins'], ['key-auth', 'API keys'], ['acls', 'ACL groups'], ['basic-auth', 'Basic Auth'], ['jwt', 'JWT'], ['hmac-auth', 'HMAC']] : state.entity === 'upstreams' ? [['targets', 'Targets']] : [])];
  const title = state.selected.name || state.selected.username || state.selected.id;
  return `<div class="konga-title detail-title"><h2>${esc(labels[state.entity].slice(0, -1))} ${esc(title)}</h2><button data-action="close">${esc(labels[state.entity])} / Show</button></div><nav class="detail-tabs" aria-label="Resource sections">${tabs.map(([key, label]) => `<button class="${state.detailTab === key ? 'active' : ''}" data-action="detail-tab" data-value="${key}">${esc(label)}</button>`).join('')}</nav><section class="detail">${state.detailTab === 'details' ? `<div class="detail-head"><h3>Resource details</h3>${state.role === 'admin' ? `<button class="subtle" data-action="detail-edit">Edit ${esc(labels[state.entity].slice(0, -1))}</button>` : ''}</div><dl class="detail-fields">${fields.map(([key, value]) => `<div><dt>${esc(key.replaceAll('_', ' '))}</dt><dd><code>${esc(display(value))}</code></dd></div>`).join('')}</dl>` : ['services', 'routes'].includes(state.entity) ? relatedPanel() : nestedPanel()}</section>`;
}
function editor() {
  if (!state.editor) return '';
  return `<div class="overlay" data-action="cancel"><form class="editor" id="editor"><div class="editor-heading"><h2>${state.editor.mode === 'create' ? 'CREATE' : 'EDIT'} ${esc(state.editor.label.toUpperCase())}</h2><button type="button" data-action="cancel" aria-label="Close form">×</button></div><p class="form-intro">Configure the ${esc(state.editor.label)} fields below. Changes are applied to ${esc(state.nodeName)} when submitted.</p>${state.editor.error ? `<div class="notice" role="alert">${esc(state.editor.error)}</div>` : ''}<div class="form-grid">${editorFields(state.editor)}</div><div class="editor-actions"><button type="button" class="subtle" data-action="cancel">Cancel</button><button class="primary">${state.editor.mode === 'create' ? 'SUBMIT' : 'SAVE'} ${esc(state.editor.label.toUpperCase())}</button></div></form></div>`;
}
const navigationIcons = { dashboard: '▦', info: 'ⓘ', services: '◫', routes: '↗', consumers: '♙', plugins: '⬡', upstreams: '⇄', certificates: '▣', ca_certificates: '◈', snis: '◎', nodes: '◉', health: '♡', snapshots: '▤', users: '♧', notifications: '♢', import: '⇥', account: '♙' };
const connectionMetrics = server => ({ active: server?.connections_active, reading: server?.connections_reading, writing: server?.connections_writing, waiting: server?.connections_waiting, accepted: server?.connections_accepted, handled: server?.connections_handled });
function dashboard() {
  const overview = state.overview || { counts: {} };
  const health = state.extra || {};
  const counts = overview.counts || {};
  const metrics = connectionMetrics(health.server);
  const resourceRows = [['services', 'Services'], ['routes', 'Routes'], ['consumers', 'Consumers'], ['plugins', 'Plugins']];
  const maxCount = Math.max(1, ...resourceRows.map(([key]) => Number(counts[key]) || 0));
  const active = Math.max(1, Number(metrics.active) || 0);
  return `<div class="gateway-banner"><div class="gateway-banner-main"><span class="banner-kicker">SELECTED GATEWAY</span><h2>${esc(state.nodeName)}</h2><p><span class="status-dot ${health.online ? '' : 'offline'}"></span>${health.online ? 'Connected to Kong Admin API' : 'Gateway unavailable'} <span class="banner-separator">/</span> Kong ${esc(health.version || overview.version || '—')}</p></div><div class="banner-actions"><span class="banner-database">DATABASE <strong>${esc(health.database || '—')}</strong></span><button data-action="reload-view">↻ &nbsp; Refresh status</button></div></div>
    <div class="section-caption"><span>GATEWAY OBJECTS</span><span>Live configuration</span></div>
    <div class="dashboard-stats">${[['services', 'Services', '◫'], ['routes', 'Routes', '↗'], ['consumers', 'Consumers', '♙'], ['plugins', 'Plugins', '⬡']].map(([key, label, icon]) => `<button class="dashboard-stat" data-action="entity" data-value="${key}"><span class="metric-icon">${icon}</span><span class="metric-data"><strong>${esc(counts[key] ?? '—')}</strong><small>${label}</small></span><span class="metric-arrow">↗</span></button>`).join('')}</div>
    <div class="dashboard-grid"><section class="card traffic-card"><div class="card-head"><div><h2>Gateway traffic</h2><p>Live counters from the selected Kong node</p></div><span class="live-label"><span class="status-dot ${health.online ? '' : 'offline'}"></span>LIVE</span></div><div class="traffic-feature"><div><small>ACCEPTED CONNECTIONS</small><strong>${esc(metrics.accepted ?? '—')}</strong><span>${esc(metrics.handled ?? '—')} handled</span></div><div class="traffic-activity"><span>ACTIVE NOW</span><strong>${esc(metrics.active ?? '—')}</strong></div></div><div class="traffic-breakdown">${[['Reading', metrics.reading], ['Writing', metrics.writing], ['Waiting', metrics.waiting]].map(([name, value]) => `<div class="traffic-line"><span>${name}</span><progress class="traffic-track traffic-${name.toLowerCase()}" value="${Math.max(0, Number(value) || 0)}" max="${active}"></progress><strong>${esc(value ?? '—')}</strong></div>`).join('')}</div></section><section class="card"><div class="card-head"><div><h2>Node information</h2><p>Connection and runtime details</p></div><button class="link-button" data-action="view" data-value="info">All details →</button></div><dl class="info-list"><div><dt>Node</dt><dd>${esc(state.nodeName)}</dd></div><div><dt>Kong version</dt><dd>${esc(health.version || overview.version || '—')}</dd></div><div><dt>Datastore</dt><dd>${esc(health.database || '—')}</dd></div><div><dt>Admin API</dt><dd>${esc(state.nodes.find(node => node.id === state.nodeId)?.url || '—')}</dd></div></dl><div class="node-card-footer"><span>Gateway configuration</span><button data-action="view" data-value="health">View health checks →</button></div></section></div>
    <div class="dashboard-bottom"><section class="card composition-card"><div class="card-head"><div><h2>Resource distribution</h2><p>Objects configured on this gateway</p></div></div><div class="composition-list">${resourceRows.map(([key, label]) => `<button data-action="entity" data-value="${key}"><span>${label}</span><progress class="composition-track" value="${Math.max(0, Number(counts[key]) || 0)}" max="${maxCount}"></progress><strong>${esc(counts[key] ?? '—')}</strong></button>`).join('')}</div></section><section class="card quick-actions"><div class="card-head"><div><h2>Quick access</h2><p>Common gateway operations</p></div></div><div class="quick-grid"><button data-action="entity" data-value="services">Manage services <span>→</span></button><button data-action="entity" data-value="routes">Configure routes <span>→</span></button><button data-action="entity" data-value="consumers">View consumers <span>→</span></button><button data-action="view" data-value="snapshots">Open snapshots <span>→</span></button></div></section></div>`;
}
function nodeInfo() {
  const health = state.extra || {};
  const metrics = connectionMetrics(health.server);
  return `<div class="dashboard-status"><div><span class="status-dot ${health.online ? '' : 'offline'}"></span><strong>${esc(state.nodeName)}</strong><span>${health.online ? 'Online' : 'Unavailable'}</span></div><button class="subtle" data-action="reload-view">Refresh status</button></div><div class="dashboard-grid"><section class="card"><div class="card-head"><h2>Node details</h2></div><dl class="info-list"><div><dt>Name</dt><dd>${esc(state.nodeName)}</dd></div><div><dt>Admin API</dt><dd>${esc(state.nodes.find(node => node.id === state.nodeId)?.url || '—')}</dd></div><div><dt>Kong version</dt><dd>${esc(health.version || '—')}</dd></div><div><dt>Database</dt><dd>${esc(health.database || '—')}</dd></div><div><dt>Last checked</dt><dd>${esc(health.checkedAt ? new Date(health.checkedAt).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' }) + ' WIB' : '—')}</dd></div></dl></section><section class="card"><div class="card-head"><h2>Connections</h2></div><div class="traffic-grid">${[['Active', metrics.active], ['Reading', metrics.reading], ['Writing', metrics.writing], ['Waiting', metrics.waiting], ['Accepted', metrics.accepted], ['Handled', metrics.handled]].map(([name, value]) => `<div><strong>${esc(value ?? '—')}</strong><span>${name}</span></div>`).join('')}</div></section></div>${health.error ? `<div class="notice">${esc(health.error)}</div>` : ''}`;
}
async function openEditor(mode, entity, target, parent) {
  const references = entity === 'routes' ? ['services'] : entity === 'plugins' ? ['services', 'routes', 'consumers'] : ['services', 'snis'].includes(entity) ? ['certificates'] : [];
  const refs = Object.fromEntries(await Promise.all(references.map(async name => [name, (await api(`/${name}`)).data])));
  const value = target || defaults[entity] || {};
  const schema = entity === 'plugins' ? await api(`/plugins/schema/${encodeURIComponent(value.name)}`) : ['services', 'routes', 'upstreams'].includes(entity) ? await api(`/schemas/${entity}`) : undefined;
  state.editor = { mode, entity, label: ({ 'key-auth': 'API key', acls: 'ACL group', targets: 'target', 'basic-auth': 'Basic Auth credential', jwt: 'JWT credential', 'hmac-auth': 'HMAC credential' })[entity] || labels[entity].toLowerCase().slice(0, -1), target, parent, value, refs, schema };
  workspace();
}
function workspace() {
  const overview = state.overview || { connected: false, counts: {} };
  const resourcePage = state.selected ? details() : state.catalog && state.entity === 'plugins' ? pluginCatalog() : `<div class="konga-title"><h2>${esc(labels[state.entity])}</h2><p>${esc(descriptions[state.entity])}</p></div><div class="resource-controls"><div>${state.role === 'admin' ? `<button class="primary" data-action="create" ${state.loading ? 'disabled' : ''}>+ ${state.entity === 'services' ? 'Add new service' : `Create ${labels[state.entity].slice(0, -1).toLowerCase()}`}</button>` : ''}<button class="subtle" data-action="refresh">Refresh</button></div><div class="resource-filters"><label class="resource-search">⌕ <input class="search" id="search" type="search" placeholder="Search..." value="${esc(state.search)}"></label><label class="results-select">Results: <select id="page-size" aria-label="Results per page">${[10, 25, 50, 100].map(size => `<option value="${size}" ${state.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}</select></label></div></div><section class="card resource-table">${table()}</section>`;
  const title = state.view === 'resources' ? labels[state.entity] : ({ dashboard: 'Dashboard', info: 'Gateway Info', ...managementLabels })[state.view];
  const navItem = (action, value, label) => `<button class="${(action === 'entity' ? state.view === 'resources' && state.entity === value : state.view === value) ? 'active' : ''}" data-action="${action}" data-value="${value}"><span class="nav-icon" aria-hidden="true">${navigationIcons[value]}</span><span>${esc(label)}</span></button>`;
  app.innerHTML = `<div class="shell"><aside class="side"><div class="side-brand"><span class="brand-mark"></span><span>KONGA <small>CONTROL</small></span></div>
    <nav class="nav nav-home">${navItem('view', 'dashboard', 'Dashboard')}</nav><small>API GATEWAY</small><nav class="nav">${navItem('view', 'info', 'Info')}${Object.entries(labels).map(([key, label]) => navItem('entity', key, label)).join('')}</nav>
    <small>APPLICATION</small><nav class="nav">${Object.entries(managementLabels).filter(([key]) => state.role === 'admin' || ['nodes', 'health', 'account'].includes(key)).map(([key, label]) => navItem('view', key, label === 'Nodes' ? 'Connections' : label)).join('')}</nav>
    <div class="side-foot"><span class="status-dot ${overview.connected ? '' : 'offline'}"></span>${esc(state.nodeName)}</div></aside>
    <div class="main"><header class="top"><div class="top-breadcrumb">Konga <span>/</span> ${esc(title)}</div><div class="top-controls"><label class="node-picker">NODE <select id="node-select" aria-label="Gateway node">${state.nodes.map(node => `<option value="${esc(node.id)}" ${node.id === state.nodeId ? 'selected' : ''}>${esc(node.name)}</option>`).join('')}</select></label><span class="user-chip">${esc(state.username)} <small>${esc(state.role)}</small></span><button data-action="logout">Sign out</button></div></header>
    <main class="page ${state.view === 'resources' ? 'resource-view' : ''}"><div class="page-head"><div><small class="eyebrow">KONG ADMIN API · ${esc(state.nodeName.toUpperCase())}</small><h1>${esc(title)}</h1><p>${state.view === 'dashboard' ? 'Gateway overview and operations at a glance.' : state.view === 'resources' ? `Configure and inspect ${esc(title.toLowerCase())} on this node.` : 'Manage and inspect the selected gateway.'}</p></div><span class="badge ${overview.connected ? '' : 'off'}">${overview.connected ? `● Connected · ${esc(overview.version || 'Kong')}` : '● Gateway unavailable'}</span></div>
    ${state.error ? `<div class="notice" role="alert">${esc(state.error)}</div>` : ''}${state.view === 'dashboard' ? dashboard() : state.view === 'info' ? nodeInfo() : state.view === 'resources' ? resourcePage : managementPage(state, esc)}</main></div></div>${editor()}`;
}
async function loadNodes() {
  try { state.nodes = await api('/nodes'); }
  catch (error) { if (error.message !== 'NODE_NOT_FOUND') throw error; state.nodeId = 'local'; sessionStorage.setItem('kong-node', 'local'); state.nodes = await api('/nodes'); }
  if (!state.nodes.some(node => node.id === state.nodeId)) { state.nodeId = 'local'; sessionStorage.setItem('kong-node', 'local'); }
  state.nodeName = state.nodes.find(node => node.id === state.nodeId)?.name || 'Local Kong';
}
async function loadView() {
  state.catalog = null; state.error = ''; state.extra = null; state.restorePreview = null;
  if (state.view === 'resources') return refresh();
  const requestId = ++state.requestId;
  state.loading = true;
  workspace();
  try {
    if (state.view === 'dashboard') {
      const [overview, health] = await Promise.all([api('/overview'), api('/health')]);
      if (requestId === state.requestId) { state.overview = overview; state.extra = health; }
    } else if (state.view === 'info') {
      const health = await api('/health');
      if (requestId === state.requestId) state.extra = health;
    } else if (state.view === 'health') {
      const [health, upstreams] = await Promise.all([api('/health'), api('/upstreams')]);
      const upstreamHealth = await Promise.all(upstreams.data.map(async row => {
        try { const result = await api(`/upstreams/${encodeURIComponent(row.id)}/health`); const targets = result.data || []; return { id: row.id, name: row.name, healthy: targets.filter(target => target.health === 'HEALTHY').length, unhealthy: targets.filter(target => target.health === 'UNHEALTHY').length }; }
        catch (error) { return { id: row.id, name: row.name, error: error.message }; }
      }));
      if (requestId === state.requestId) { state.extra = health; state.upstreamHealth = upstreamHealth; }
    } else if (state.view !== 'account' && state.view !== 'import') { const extra = await api(`/${state.view}`); if (requestId === state.requestId) state.extra = extra; }
  } catch (error) { if (requestId === state.requestId) state.error = error.message; }
  if (requestId !== state.requestId) return;
  state.loading = false;
  workspace();
}
async function refresh() {
  const requestId = ++state.requestId, entity = state.entity;
  state.loading = true; state.error = ''; state.rows = []; state.next = null; state.page = 1; workspace();
  try { const [overview, result] = await Promise.all([api('/overview'), api(`/${entity}`)]); if (requestId === state.requestId) { state.overview = overview; state.rows = result.data; state.next = result.next; } }
  catch (error) { if (requestId === state.requestId) { state.error = error.message; state.rows = []; state.next = null; } }
  finally { if (requestId === state.requestId) { state.loading = false; workspace(); } }
}
async function loadNested() {
  if (!state.selected) return;
  try { const result = await api(`/${state.entity}/${encodeURIComponent(state.selected.id)}/${state.nested}`); state.nestedRows = result.data; }
  catch (error) { state.error = error.message; state.nestedRows = []; }
  workspace();
}
async function loadRelated() {
  if (!state.selected || !['routes', 'plugins'].includes(state.detailTab)) return;
  const selectedId = state.selected.id, entity = state.entity, kind = state.detailTab;
  state.relatedRows = []; workspace();
  try {
    const result = await api(`/${entity}/${encodeURIComponent(selectedId)}/${kind}`);
    if (state.selected?.id === selectedId && state.detailTab === kind) state.relatedRows = result.data || [];
  } catch (error) { state.error = error.message; }
  workspace();
}
async function task(run) { try { state.error = ''; await run(); } catch (error) { state.error = error.message; workspace(); } }
app.addEventListener('submit', event => {
  if (event.target.id === 'login') { event.preventDefault(); task(async () => { const form = new FormData(event.target); const result = await api('/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } }); state.csrf = result.csrf; state.username = result.username; state.environmentUsername = result.environmentUsername; state.role = result.role; await loadNodes(); await loadView(); }); }
  if (event.target.id === 'editor') {
    event.preventDefault(); const form = event.target;
    task(async () => {
      try {
        const body = serializeEditor(state.editor, form), { mode, entity, target, parent } = state.editor;
        const root = parent ? `/${parent.entity}/${encodeURIComponent(parent.id)}/${entity}` : `/${entity}`;
        const result = await api(mode === 'edit' ? `${root}/${encodeURIComponent(target.id)}` : root, { method: mode === 'edit' ? 'PATCH' : 'POST', body });
        state.secret = result.one_time ? result.key : ''; state.editor = null;
        if (parent) await loadNested();
        else if (state.selected && state.detailTab === entity && ['routes', 'plugins'].includes(entity)) await loadRelated();
        else { state.selected = null; await refresh(); }
      } catch (error) {
        if (!state.editor) throw error;
        state.editor.error = error.message;
        const notice = form.querySelector('.notice');
        if (notice) notice.textContent = error.message;
        else form.querySelector('.editor-heading').insertAdjacentHTML('afterend', `<div class="notice" role="alert">${esc(error.message)}</div>`);
      }
    });
  }
  if (event.target.id === 'node-form') { event.preventDefault(); task(async () => { const form = new FormData(event.target); await api('/nodes', { method: 'POST', body: Object.fromEntries(form) }); await loadNodes(); await loadView(); }); }
  if (event.target.id === 'user-form') { event.preventDefault(); task(async () => { const form = new FormData(event.target); await api('/users', { method: 'POST', body: Object.fromEntries(form) }); await loadView(); }); }
  if (event.target.id === 'password-form') { event.preventDefault(); task(async () => { const form = new FormData(event.target); await api('/account/password', { method: 'POST', body: Object.fromEntries(form) }); Object.assign(state, { csrf: '', username: '', role: 'admin', error: '' }); login(); }); }
  if (event.target.id === 'notification-form') { event.preventDefault(); task(async () => { const form = new FormData(event.target); await api('/notifications', { method: 'PUT', body: { webhookEnabled: form.has('webhookEnabled'), webhookUrl: form.get('webhookUrl'), emailEnabled: form.has('emailEnabled'), emailTo: form.get('emailTo') } }); await loadView(); }); }
  if (event.target.id === 'import-form') { event.preventDefault(); task(async () => { const form = new FormData(event.target); const file = form.get('file'); const csv = file?.size ? await file.text() : String(form.get('csv') || ''); const rows = parseConsumerCsv(csv); if (!confirm(`Import ${rows.length} consumers into ${state.nodeName}? Existing usernames will be skipped.`)) return; state.importResult = await api('/import/consumers', { method: 'POST', body: { rows } }); workspace(); }); }
  if (event.target.id === 'import-url-form') { event.preventDefault(); task(async () => { const url = new FormData(event.target).get('url'); if (!confirm(`Import Consumers from ${url} into ${state.nodeName}?`)) return; state.importResult = await api('/import/consumers/url', { method: 'POST', body: { url } }); workspace(); }); }
});
app.addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  if (button.dataset.action === 'cancel' && event.target !== button) return;
  const { action, id: rowId, value } = button.dataset;
  if (action === 'entity') { state.catalog = null; state.view = 'resources'; state.entity = value; state.selected = null; state.secret = ''; state.search = ''; state.page = 1; loadView(); }
  if (action === 'view') { state.catalog = null; state.view = value; state.selected = null; loadView(); }
  if (action === 'reload-view') loadView();
  if (action === 'refresh') refresh();
  if (action === 'logout') task(async () => { await api('/logout', { method: 'POST' }); Object.assign(state, { csrf: '', username: '', rows: [], selected: null, secret: '', error: '' }); login(); });
  if (action === 'select-node') { state.nodeId = rowId; sessionStorage.setItem('kong-node', rowId); state.nodeName = state.nodes.find(node => node.id === rowId)?.name || rowId; loadView(); }
  if (action === 'delete-node') task(async () => { if (!confirm('Remove this gateway connection? Gateway configuration is not deleted.')) return; await api(`/nodes/${encodeURIComponent(rowId)}`, { method: 'DELETE' }); if (state.nodeId === rowId) { state.nodeId = 'local'; sessionStorage.setItem('kong-node', 'local'); } await loadNodes(); await loadView(); });
  if (action === 'create-snapshot') task(async () => { await api('/snapshots', { method: 'POST', body: {} }); await loadView(); });
  if (action === 'preview-restore') task(async () => { state.restorePreview = await api(`/snapshots/${encodeURIComponent(rowId)}/preview`); workspace(); });
  if (action === 'restore-snapshot') task(async () => { const confirmation = document.getElementById('restore-confirmation').value; if (confirmation !== `RESTORE ${state.nodeName}`) throw new Error('RESTORE_CONFIRMATION_REQUIRED'); await api(`/snapshots/${encodeURIComponent(rowId)}/restore`, { method: 'POST', body: { confirmation, sha256: state.restorePreview.sha256 } }); await loadView(); });
  if (action === 'delete-snapshot') task(async () => { if (!confirm('Delete this encrypted snapshot?')) return; await api(`/snapshots/${encodeURIComponent(rowId)}`, { method: 'DELETE' }); await loadView(); });
  if (action === 'toggle-user') task(async () => { await api(`/users/${encodeURIComponent(rowId)}`, { method: 'PATCH', body: { active: value === 'enable' } }); await loadView(); });
  if (action === 'delete-user') task(async () => { if (!confirm('Delete this console user? Their sessions will be revoked.')) return; await api(`/users/${encodeURIComponent(rowId)}`, { method: 'DELETE' }); await loadView(); });
  if (action === 'create') task(() => state.entity === 'plugins' ? openCatalog() : openEditor('create', state.entity));
  if (action === 'plugin-select') task(async () => { const scope = state.catalog?.initialValue; state.catalog = null; await openEditor('create', 'plugins', { ...scope, name: value, enabled: true }); });
  if (action === 'plugin-cancel') { state.catalog = false; workspace(); }
  if (action === 'edit') task(() => openEditor('edit', state.entity, state.rows.find(item => item.id === rowId)));
  if (action === 'delete') task(async () => { if (!confirm('Delete this Kong resource? This may interrupt API traffic.')) return; await api(`/${state.entity}/${encodeURIComponent(rowId)}`, { method: 'DELETE' }); state.selected = null; await refresh(); });
  if (action === 'detail') { state.catalog = false; state.selected = state.rows.find(item => item.id === rowId); state.detailTab = 'details'; state.nestedRows = []; state.relatedRows = []; state.secret = ''; workspace(); }
  if (action === 'close') { state.selected = null; state.secret = ''; workspace(); }
  if (action === 'detail-tab') { state.detailTab = value; state.secret = ''; if (['services', 'routes', 'consumers'].includes(state.entity) && ['routes', 'plugins'].includes(value)) loadRelated(); else if (state.entity === 'consumers' || state.entity === 'upstreams') { state.nested = value; if (value === 'details') workspace(); else loadNested(); } else workspace(); }
  if (action === 'detail-edit') task(() => openEditor('edit', state.entity, state.selected));
  if (action === 'related-create') task(() => state.detailTab === 'routes' ? openEditor('create', 'routes', { service: { id: state.selected.id }, strip_path: true }) : openCatalog({ [({ services: 'service', routes: 'route', consumers: 'consumer' })[state.entity]]: { id: state.selected.id } }));
  if (action === 'related-edit') task(() => openEditor('edit', state.detailTab, state.relatedRows.find(row => row.id === rowId)));
  if (action === 'related-delete') task(async () => { if (!confirm('Delete this Kong resource? This may interrupt API traffic.')) return; await api(`/${state.detailTab}/${encodeURIComponent(rowId)}`, { method: 'DELETE' }); await loadRelated(); });
  if (action === 'nested-create') task(() => openEditor('create', state.nested, null, { entity: state.entity, id: state.selected.id }));
  if (action === 'nested-edit') task(() => openEditor('edit', state.nested, state.nestedRows.find(row => row.id === rowId), { entity: state.entity, id: state.selected.id }));
  if (action === 'nested-delete') task(async () => { if (!confirm('Delete this credential, ACL group, or upstream target?')) return; await api(`/${state.entity}/${encodeURIComponent(state.selected.id)}/${state.nested}/${encodeURIComponent(rowId)}`, { method: 'DELETE' }); await loadNested(); });
  if (action === 'copy') navigator.clipboard.writeText(state.secret);
  if (action === 'cancel') { state.editor = null; workspace(); }
  if (action === 'add-config' || action === 'remove-config') { const form = document.getElementById('editor'); const rows = readConfigRows(form); if (action === 'add-config') rows.push({ key: '', type: 'string', value: '' }); else rows.splice(Number(button.dataset.index), 1); state.editor.configRows = rows; form.querySelector('#config-list').innerHTML = renderConfigRows(rows); }
  if (action === 'page-prev') { state.page = Math.max(1, state.page - 1); workspace(); }
  if (action === 'page-next') task(async () => { if (state.page * state.pageSize >= state.rows.length && state.next) { const result = await api(`/${state.entity}?offset=${encodeURIComponent(state.next)}`); state.rows.push(...result.data); state.next = result.next; } if (state.page * state.pageSize < state.rows.length) state.page += 1; workspace(); });
});
app.addEventListener('input', event => { if (event.target.id === 'search') { state.search = event.target.value.toLowerCase(); state.page = 1; const start = event.target.selectionStart; workspace(); const input = document.getElementById('search'); input.focus(); input.setSelectionRange(start, start); } });
app.addEventListener('change', event => { if (event.target.name === 'name' && state.editor?.entity === 'plugins' && state.editor.mode === 'create') { const rows = Object.entries(pluginPreset(event.target.value.trim())).map(([key, value]) => ({ key, type: Array.isArray(value) ? 'list' : typeof value, value: Array.isArray(value) ? value.join(', ') : String(value) })); state.editor.configRows = rows; document.getElementById('config-list').innerHTML = renderConfigRows(rows); } });
app.addEventListener('change', event => { if (event.target.id === 'page-size') { state.pageSize = Number(event.target.value); state.page = 1; workspace(); } });
app.addEventListener('change', event => { if (event.target.id === 'node-select') { state.nodeId = event.target.value; sessionStorage.setItem('kong-node', state.nodeId); state.nodeName = state.nodes.find(node => node.id === state.nodeId)?.name || state.nodeId; state.selected = null; loadView(); } });
api('/session').then(async result => { state.csrf = result.csrf; state.username = result.username; state.environmentUsername = result.environmentUsername; state.role = result.role; await loadNodes(); await loadView(); }).catch(() => { state.nodeId = 'local'; sessionStorage.setItem('kong-node', 'local'); login(); });
