import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { authenticate } from '@ekyc/shared/auth';
export async function realtime(server, cfg, db) {
  const pub = createClient({ url: cfg.valkeyUrl }); const sub = pub.duplicate();
  pub.on('error', () => console.error('{"code":"VALKEY_UNAVAILABLE"}')); sub.on('error', () => {});
  await Promise.all([pub.connect(), sub.connect()]);
  const io = new Server(server, { cors: { origin: cfg.publicOrigin, credentials: true }, transports: ['websocket'] }); io.adapter(createAdapter(pub, sub));
  io.use(async (socket, next) => { try { socket.data.actor = await authenticate(socket.handshake.auth?.token, cfg, db); next(); } catch { next(new Error('UNAUTHORIZED')); } });
  io.on('connection', async socket => {
    const actor = socket.data.actor; socket.join(`session:${actor.sid}`);
    const source = actor.source || 'basic';
    if (actor.role === 'agent') { socket.join(`agents:${actor.tenant_id}:${source}`); socket.join(`agent:${actor.sub}:${source}`); }
    else socket.join(`customer:${actor.tenant_id}:${actor.sub}:${source}${actor.call_id ? `:${actor.call_id}` : ''}`);
    const report = async () => { const room = `agents:${actor.tenant_id}:${source}`; const agents = await io.in(room).fetchSockets(); io.to(room).emit('online.changed', new Set(agents.map(s => s.data.actor.sub)).size); };
    await report(); socket.on('disconnect', () => { report().catch(() => {}); });
    // An expired/revoked access token must not leave an indefinitely authorized socket.
    const timer = setInterval(async () => { try { await authenticate(socket.handshake.auth?.token, cfg, db); } catch { socket.emit('session.expired'); socket.disconnect(true); } }, 15000);
    socket.on('disconnect', () => clearInterval(timer));
  });
  io.on('close', () => { pub.quit(); sub.quit(); }); return io;
}
