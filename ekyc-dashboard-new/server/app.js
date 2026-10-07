import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRoutes, fail } from './auth.js';
import { managementRoutes } from './management.js';
import { platformRoutes } from './platform.js';
import { exportRoutes } from './exports.js';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
export function createDashboardApp(db, redis, cfg, storage, adapters) {
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] } } }));
  app.use(express.json({ limit: '1mb' }));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => { await Promise.all([db.raw('select 1'), redis.ping()]); res.json({ status: 'ready' }); });
  authRoutes(app, db, redis, cfg, adapters);
  const management = managementRoutes(app, db, adapters);
  platformRoutes(app, db, cfg, storage, adapters, management);
  exportRoutes(app, db, storage, cfg);
  app.use('/dashboard/api', (_req, _res, next) => next(fail(404, 'NOT_FOUND')));
  app.use(express.static(path.join(root, 'dist'), { index: false, maxAge: '1h' }));
  app.get('/{*path}', (req, res, next) => { if (req.path.startsWith('/dashboard/api') || req.path.startsWith('/health')) return next(fail(404, 'NOT_FOUND')); res.set('cache-control', 'no-store').sendFile(path.join(root, 'dist', 'index.html')); });
  app.use((error, _req, res, _next) => { const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : error.code === '23505' ? 409 : 500; const code = status === 500 ? 'INTERNAL_ERROR' : error.code === '23505' ? 'ALREADY_EXISTS' : error.code || 'REQUEST_FAILED'; if (status >= 500) console.error(JSON.stringify({ event: 'dashboard_error', code })); res.status(status).json({ success: false, error: { code } }); });
  return app;
}
