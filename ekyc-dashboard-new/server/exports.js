import { randomUUID, createHash } from 'node:crypto';
import { makeXlsx } from './xlsx.js';
import { fail, requireRole, bankScope, audit } from './auth.js';

const allowed = ['users', 'call_history', 'user_actions'];
const isoDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00+07:00`));
const safeCell = value => { const result = String(value ?? ''); return /^[=+@-]/.test(result) ? `'${result}` : result; };
const csv = rows => rows.map(row => row.map(cell => `"${safeCell(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
export function exportRoutes(app, db, storage, cfg) {
  const p = '/dashboard/api/v1';
  const scoped = async (actor, applicationId) => {
    const appRow = await db('dashboard_applications').where({ id: applicationId }).first(); if (!appRow) throw fail(404, 'APPLICATION_NOT_FOUND');
    bankScope(actor, appRow.bank_id); return appRow;
  };
  app.get(`${p}/exports`, async (req, res) => { requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const application = await scoped(req.dashboard, req.query.application_id); res.json({ success: true, data: await db('dashboard_exports').select('id', 'state', 'request', 'sha256', 'error', 'created_at', 'updated_at').where({ application_id: application.id }).orderBy('created_at', 'desc').limit(50) }); });
  app.post(`${p}/exports`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const application = await scoped(req.dashboard, req.body?.application_id);
    const { from, to, format = 'xlsx', entities = ['users', 'call_history'] } = req.body;
    if (!isoDay(from) || !isoDay(to) || from > to || !['xlsx', 'csv'].includes(format) || !Array.isArray(entities) || !entities.length || !entities.every(x => allowed.includes(x))) throw fail(422, 'INVALID_EXPORT_REQUEST');
    const [row] = await db('dashboard_exports').insert({ id: randomUUID(), application_id: application.id, requested_by: req.dashboard.role === 'officer' ? null : req.dashboard.id, request: { from, to, format, entities } }).returning('id', 'state', 'request', 'created_at');
    await audit(db, req.dashboard, 'export.requested', { id: row.id }, application.bank_id); res.status(202).json({ success: true, data: row });
  });
  app.get(`${p}/exports/:id/download`, async (req, res) => {
    requireRole(req.dashboard, 'superadmin', 'admin', 'bank'); const row = await db('dashboard_exports').where({ id: req.params.id }).first(); if (!row) throw fail(404, 'EXPORT_NOT_FOUND'); const application = await scoped(req.dashboard, row.application_id);
    if (row.state !== 'ready' || !row.object_key) throw fail(409, 'EXPORT_NOT_READY'); const bank = await db('dashboard_banks').where({ id: application.bank_id }).first();
    const object = await storage.get(cfg.exportBucket, row.object_key); res.type(row.request.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set({ 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="export-${row.id}.${row.request.format}"` });
    await audit(db, req.dashboard, 'export.downloaded', { id: row.id }, bank.id); for await (const chunk of object.Body) res.write(chunk); res.end();
  });
}

export async function processOneExport(db, storage, cfg) {
  const job = await db.transaction(async trx => {
    const candidate = await trx('dashboard_exports').where(q => q.where({ state: 'queued' }).orWhere(q2 => q2.where({ state: 'running' }).where('lease_until', '<', new Date()))).where('attempts', '<', 5).orderBy('created_at').forUpdate().skipLocked().first();
    if (!candidate) return null;
    await trx('dashboard_exports').where({ id: candidate.id }).update({ state: 'running', attempts: candidate.attempts + 1, lease_until: new Date(Date.now() + 5 * 60_000), updated_at: new Date() }); return candidate;
  });
  if (!job) return false;
  try {
    const application = await db('dashboard_applications').where({ id: job.application_id }).first(); const bank = await db('dashboard_banks').where({ id: application.bank_id }).first();
    const start = new Date(`${job.request.from}T00:00:00+07:00`); const end = new Date(Date.parse(`${job.request.to}T00:00:00+07:00`) + 86_400_000);
    const sheets = [];
    if (job.request.entities.includes('users')) {
      const rows = await db('platform_customers as c').join('dashboard_customer_applications as m', 'c.id', 'm.customer_id').where({ 'm.application_id': application.id, 'c.tenant_id': bank.tenant_id }).where('c.created_at', '>=', start).where('c.created_at', '<', end).select('c.id', 'c.verification_status', 'c.created_at').limit(50_001);
      sheets.push(['users', ['id', 'verification_status', 'created_at'], rows.map(row => [row.id, row.verification_status, row.created_at?.toISOString()])]);
    }
    if (job.request.entities.includes('call_history')) {
      const rows = await db('platform_calls as c').join('dashboard_customer_applications as m', 'c.user_id', 'm.customer_id').where({ 'm.application_id': application.id, 'c.tenant_id': bank.tenant_id }).where('c.created_at', '>=', start).where('c.created_at', '<', end).select('c.id', 'c.user_id', 'c.state', 'c.outcome', 'c.reason', 'c.started_at', 'c.ended_at').limit(50_001);
      sheets.push(['call_history', ['id', 'user_id', 'state', 'outcome', 'reason', 'started_at', 'ended_at'], rows.map(row => [row.id, row.user_id, row.state, row.outcome, row.reason, row.started_at?.toISOString(), row.ended_at?.toISOString()])]);
    }
    if (job.request.entities.includes('user_actions')) {
      const rows = await db('platform_audit').where({ tenant_id: bank.tenant_id }).where('created_at', '>=', start).where('created_at', '<', end).select('id', 'subject_id', 'action', 'created_at').limit(50_001);
      sheets.push(['user_actions', ['id', 'subject_id', 'action', 'created_at'], rows.map(row => [row.id, row.subject_id, row.action, row.created_at?.toISOString()])]);
    }
    if (sheets.some(([, , rows]) => rows.length > 50_000)) throw fail(422, 'EXPORT_ROW_LIMIT');
    let output;
    if (job.request.format === 'csv') output = Buffer.from(sheets.flatMap(([name, columns, rows]) => [[name], columns, ...rows, []]).map(row => csv([row])).join('\r\n'));
    else output = makeXlsx(sheets.map(([name, columns, rows]) => [name, columns, rows.map(row => row.map(safeCell))]));
    const sha256 = createHash('sha256').update(output).digest('hex'); const objectKey = `${bank.tenant_id}/${application.id}/${job.id}.${job.request.format}`;
    await storage.ensureBucket(cfg.exportBucket); await storage.put(cfg.exportBucket, objectKey, output, job.request.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { sha256 });
    const check = await storage.checksum(cfg.exportBucket, objectKey); if (check.sha256 !== sha256) throw fail(502, 'EXPORT_CHECKSUM_MISMATCH');
    await db('dashboard_exports').where({ id: job.id }).update({ state: 'ready', object_key: objectKey, sha256, error: null, lease_until: null, updated_at: new Date() });
  } catch (error) { await db('dashboard_exports').where({ id: job.id }).update({ state: job.attempts + 1 >= 5 ? 'failed' : 'queued', error: error.code || 'EXPORT_FAILED', lease_until: null, updated_at: new Date() }); }
  return true;
}
