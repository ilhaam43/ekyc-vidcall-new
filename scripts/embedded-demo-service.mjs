import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createDb } from '@ekyc/shared/db';
import { required, value } from '@ekyc/shared/config';

if (process.env.NODE_ENV === 'production') throw new Error('Synthetic embedded demo is disabled in production');

const frontend = value('EMBEDDED_DEMO_FRONTEND_URL', 'http://127.0.0.1:5173').replace(/\/$/, '');
const callsUrl = value('CALLS_URL', 'http://127.0.0.1:55030').replace(/\/$/, '');
const port = Number(value('EMBEDDED_DEMO_PORT', '5174'));
const host = value('EMBEDDED_DEMO_HOST', '127.0.0.1');
const parsedFrontend = new URL(frontend);
if (!['127.0.0.1', 'localhost'].includes(parsedFrontend.hostname) || parsedFrontend.protocol !== 'http:') throw new Error('Demo frontend must be local');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid demo port');

const db = createDb(required('DATABASE_URL'));
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const demoName = 'Synthetic embedded portal (persistent URLs)';
let fixture;
let queueTurn = Promise.resolve();

async function prepareFixture() {
  const key = publicKey.export({ type: 'spki', format: 'pem' });
  return db.transaction(async trx => {
    let tenant = await trx('platform_tenants').where({ name: demoName }).first();
    if (!tenant) {
      const id = randomUUID();
      await trx('platform_tenants').insert({ id, name: demoName });
      tenant = { id };
    }
    let agent = await trx('platform_agents').where({ tenant_id: tenant.id, username: 'embedded-portal-agent' }).first();
    if (!agent) {
      const id = randomUUID();
      await trx('platform_agents').insert({ id, tenant_id: tenant.id, username: 'embedded-portal-agent', name: 'Petugas Demo', password_hash: await bcrypt.hash(randomUUID(), 12) });
      agent = { id };
    }
    let customer = await trx('platform_customers').where({ tenant_id: tenant.id }).whereNull('deleted_at').orderBy('created_at').first();
    if (!customer) {
      const id = randomUUID();
      await trx('platform_customers').insert({ id, tenant_id: tenant.id, data: { name: 'Nasabah Demo', id_number: 'SYNTHETIC-ONLY' }, encryption_format: 'synthetic-plaintext' });
      customer = { id };
    }
    await trx('platform_quotas').insert({ tenant_id: tenant.id, service: 'videocalls.post', remaining: 100 }).onConflict(['tenant_id', 'service']).ignore();
    await trx('platform_integrations').insert({ tenant_id: tenant.id, issuer: 'localhost-demo', audience: 'ekyc-integration', public_key_pem: key, staff_origin: frontend, agent_launch_url: `${frontend}/integrations/agent`, customer_entry_url: `${frontend}/customer`, active: true })
      .onConflict('tenant_id').merge({ public_key_pem: key, staff_origin: frontend, agent_launch_url: `${frontend}/integrations/agent`, customer_entry_url: `${frontend}/customer`, active: true, updated_at: new Date() });
    await trx('platform_agent_identities').insert({ tenant_id: tenant.id, external_subject: 'demo-staff-1', agent_id: agent.id }).onConflict(['tenant_id', 'external_subject']).merge({ agent_id: agent.id });
    return { tenantId: tenant.id, agentId: agent.id, customerId: customer.id };
  });
}

function sign(scope, subject, extra = {}) {
  return jwt.sign({ tenant_id: fixture.tenantId, scope, ...extra }, privateKey, { algorithm: 'RS256', issuer: 'localhost-demo', audience: 'ekyc-integration', subject, jwtid: randomUUID(), expiresIn: '60s' });
}

async function post(path, payload, authorization) {
  const response = await fetch(`${callsUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: ${json.error?.code || response.status}`);
  return json.data;
}

async function createCustomerLink(customerId) {
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  const previous = queueTurn;
  queueTurn = turn;
  await previous;
  try {
    const customer = await db('platform_customers').where({ id: customerId, tenant_id: fixture.tenantId }).whereNull('deleted_at').first();
    if (!customer) throw new Error('CUSTOMER_NOT_FOUND');
    return await post('/api/v2/integrations/customer-links', { customer_id: customerId, external_request_id: `demo-${randomUUID()}` }, sign('customer:link', 'localhost-demo-backend'));
  } finally { release(); }
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 4096) throw new Error('REQUEST_TOO_LARGE');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('INVALID_JSON'); }
}

const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const html = body => `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulasi integrasi eKYC</title><style>body{margin:0;font:14px system-ui;background:#eef2f7;color:#18304e}.bar{padding:12px 20px;background:#fff;border-bottom:1px solid #dce4ed;display:flex;align-items:center;justify-content:space-between;gap:16px}.bar strong{display:block;font-size:16px}.bar span{color:#64748b}.bar a{color:#2459c5}iframe{display:block;width:100%;height:calc(100vh - 68px);border:0}.home{max-width:560px;margin:10vh auto;background:#fff;padding:32px;border-radius:12px}.home a{display:block;margin:16px 0;padding:14px;background:#eaf0ff;color:#1646a7;border-radius:8px;text-decoration:none}</style>${body}</html>`;

async function serve(request, response) {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/health') { response.writeHead(200, headers).end('ok'); return; }
  if (path === '/api/customer-links' && request.method === 'POST') {
    try {
      const payload = await readJson(request);
      const customerId = payload.customer_id;
      if (typeof customerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(customerId)) { response.writeHead(422, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ error: 'INVALID_CUSTOMER_ID' })); return; }
      const result = await createCustomerLink(customerId);
      response.writeHead(201, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ customer_id: customerId, customer_url: result.customer_url, expires_in: result.expires_in, note: 'Generating this link does not enqueue the customer. The call is created when the customer opens the link.' }));
    } catch (error) {
      const status = error.message === 'CUSTOMER_NOT_FOUND' ? 404 : 503;
      response.writeHead(status, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (request.method !== 'GET') { response.writeHead(405, headers).end(); return; }
  if (path === '/') {
    response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    response.end(html(`<main class="home"><h1>Simulasi integrasi eKYC</h1><p>Portal staf membuka antrean kosong. Customer baru masuk antrean setelah membuka link yang dibuat lewat API.</p><a href="/staff/${fixture.agentId}">Buka portal staf · ${fixture.agentId}</a><button id="generate">Generate customer URL · ${fixture.customerId}</button><p id="result"></p><p>Format portal staf: /staff/&lt;staff-id&gt;</p><script>document.querySelector('#generate').onclick=async()=>{const response=await fetch('/api/customer-links',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customer_id:'${fixture.customerId}'})});const data=await response.json();document.querySelector('#result').innerHTML=response.ok?'Link: <a href="'+data.customer_url+'">Open customer page</a><br><code>'+data.customer_url+'</code>':'Gagal membuat link: '+data.error}</script></main>`));
    return;
  }
  try {
    const staffMatch = path.match(/^\/staff\/([0-9a-f-]{36})$/i);
    const customerMatch = path.match(/^\/customer\/([0-9a-f-]{36})$/i);
    if (!staffMatch && !customerMatch) { response.writeHead(404, headers).end(); return; }
    if (customerMatch) {
      const link = await createCustomerLink(customerMatch[1]);
      response.writeHead(302, { ...headers, location: link.customer_url }).end();
      return;
    }
    const staff = await db('platform_agents').where({ id: staffMatch[1], tenant_id: fixture.tenantId, active: true }).first();
    const identity = staff && await db('platform_agent_identities').where({ tenant_id: fixture.tenantId, agent_id: staff.id }).first();
    if (!staff || !identity) { response.writeHead(404, headers).end('Staff not found'); return; }
    const agent = await post('/api/v2/integrations/agent-links', { assertion: sign('agent:launch', identity.external_subject) });
    const escapedUrl = agent.agent_url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; frame-src ${frontend}; style-src 'unsafe-inline'` });
    response.end(html(`<div class="bar"><div><strong>Portal staf · ${staff.name}</strong><span>Nasabah masuk antrean setelah membuka link yang dikirim oleh bank.</span></div></div><iframe src="${escapedUrl}" title="eKYC Agent" allow="camera; microphone; fullscreen; display-capture"></iframe>`));
  } catch (error) {
    console.error('Embedded demo request failed:', error.message);
    response.writeHead(503, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    response.end(html('<main class="home"><h1>Demo belum siap</h1><p>Periksa container API panggilan dan coba muat ulang halaman.</p></main>'));
  }
}

try {
  fixture = await prepareFixture();
  const server = createServer((request, response) => { void serve(request, response); });
  server.listen(port, host, () => console.log(`Embedded demo ready on ${host}:${port}`));
} catch (error) {
  await db.destroy();
  throw error;
}
