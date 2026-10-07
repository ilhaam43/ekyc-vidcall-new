import { createClient } from 'redis';
import { createDb } from '@ekyc/shared/db';
import { Storage } from '@ekyc/shared/storage';
import { dashboardConfig } from './config.js';
import { integrations } from './integrations.js';
import { createDashboardApp } from './app.js';

const cfg = dashboardConfig(); const db = createDb(cfg.databaseUrl); const redis = createClient({ url: cfg.valkeyUrl });
redis.on('error', () => console.error('{"event":"dashboard_valkey_error"}'));
await redis.connect();
const app = createDashboardApp(db, redis, cfg, new Storage(cfg), integrations(cfg));
const server = app.listen(cfg.port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'dashboard_listening', port: cfg.port })));
let closing = false;
async function stop() { if (closing) return; closing = true; server.close(async () => { await Promise.allSettled([redis.quit(), db.destroy()]); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
