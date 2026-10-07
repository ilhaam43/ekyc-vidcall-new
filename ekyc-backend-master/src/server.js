import { config, value } from '@ekyc/shared/config';
import { createDb } from '@ekyc/shared/db';
import { Storage } from '@ekyc/shared/storage';
import { listen } from '@ekyc/shared/http';
import { createApp } from './app.js';
const cfg = config(); const db = createDb(cfg.databaseUrl); const storage = new Storage(cfg);
await storage.ensureBucket(cfg.documentBucket); await storage.ensureBucket(cfg.recordingBucket);
listen(createApp(db, cfg, storage), Number(value('PORT', '8080')), db);
