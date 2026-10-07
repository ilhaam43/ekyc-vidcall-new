import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { errorHandler } from './errors.js';
export function baseApp(cfg, db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: cfg.publicOrigin, credentials: true }));
  app.use((req, res, next) => { req.id = randomUUID(); res.set('x-request-id', req.id); next(); });
  app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => { await db.raw('select 1'); res.json({ status: 'ready' }); });
  return app;
}
export const loginLimiter = () => rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
export function finishApp(app) { app.use((_req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })); app.use(errorHandler); return app; }
export function listen(app, port, db) {
  const server = app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', port })));
  let closing = false;
  const stop = () => { if (closing) return; closing = true; server.close(async () => { await db.destroy(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}
