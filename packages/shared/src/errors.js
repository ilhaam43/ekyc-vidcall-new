export class AppError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export function assert(condition, status, code, message) { if (!condition) throw new AppError(status, code, message); }
export function errorHandler(err, req, res, _next) {
  const conflict = err.code === '23505';
  const status = err.status || (conflict ? 409 : 500);
  if (status >= 500) console.error(JSON.stringify({ level: 'error', requestId: req.id, code: err.code || 'INTERNAL_ERROR' }));
  res.status(status).json({ success: false, error: { code: conflict ? 'CONFLICT' : err.code || 'INTERNAL_ERROR', message: status >= 500 ? 'Service temporarily unavailable' : err.message }, request_id: req.id });
}
