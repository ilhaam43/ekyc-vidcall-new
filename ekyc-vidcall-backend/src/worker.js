import { drainOne } from '@ekyc/shared/outbox';
import { assert } from '@ekyc/shared/errors';
import { Jibri } from './jibri.js';
import { sendApn } from './apn.js';
import { Uploader } from './uploader.js';
import { customerRooms } from './customer-rooms.js';
export function startWorker(db, cfg, calls, io, integration) {
  const jibri = new Jibri(db, cfg, calls); const uploader = new Uploader(db, cfg, calls.storage, calls); let busy = false;
  const handlers = {
    socket: async event => {
      const rooms = [];
      if (!event.customer_only) rooms.push(`agents:${event.tenant_id}:${event.source || 'basic'}`);
      if (event.user_id) rooms.push(...customerRooms(event.tenant_id, event.user_id, event.source || 'basic', event.data.call_id || event.data.id));
      io.to(rooms).emit(event.name, event.data);
    },
    verification: async payload => {
      const response = await fetch(`${cfg.masterUrl}/internal/verifications`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': cfg.internalSecret }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
      assert(response.ok, 503, 'MASTER_DECISION_UNAVAILABLE'); await calls.complete(payload);
    },
    'recording.start': payload => jibri.start(payload), 'recording.upload': payload => uploader.upload(payload), 'conference.stop': payload => jibri.stop(payload), apn: payload => sendApn(payload),
  };
  let cycle = 0;
  const tick = async () => {
    if (busy) return; busy = true;
    try { for (let n = 0; n < 20 && await drainOne(db, handlers); n++) { /* bounded batch */ } if (++cycle % 10 === 0) { await jibri.poll(); await calls.sweep(); } if (cycle % 3600 === 0) await integration?.sweep(); }
    catch { console.error('{"code":"WORKER_CYCLE_FAILED"}'); } finally { busy = false; }
  };
  const timer = setInterval(tick, 1000); timer.unref(); return () => clearInterval(timer);
}
