import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { assert } from '@ekyc/shared/errors';
import { value, required } from '@ekyc/shared/config';
import { equal } from '@ekyc/shared/auth';
export class Jibri {
  constructor(db, cfg, calls) { this.db = db; this.cfg = cfg; this.calls = calls; }
  url(worker) { assert(/^jibri[1-5]$/.test(worker), 400, 'UNKNOWN_WORKER'); return `http://${worker}:2223/jibri/api/v1.0`; }
  async request(worker, path, payload) {
    const response = await fetch(`${this.url(worker)}/${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    assert(response.ok, 503, 'RECORDER_UNAVAILABLE'); return path === 'health' ? response.json() : null;
  }
  async start({ call_id }) {
    const call = await this.db('platform_calls').where({ id: call_id }).first();
    if (!call || call.state !== 'ringing' || !call.customer_joined_at) return;
    const recording = await this.db('platform_recordings').where({ call_id }).first();
    if (recording.state !== 'reserved') return;
    await this.request(recording.worker_id, 'startService', {
      sessionId: recording.id, sinkType: 'file',
      callParams: { callUrlInfo: { baseUrl: `https://${this.cfg.jitsiDomain}`, callName: call.room } },
      callLoginParams: { domain: value('XMPP_RECORDER_DOMAIN', 'recorder.meet.jitsi'), username: value('JIBRI_RECORDER_USER', 'recorder'), password: required('JIBRI_RECORDER_PASSWORD') },
    });
  }
  async stop({ call_id, room }) {
    // Destroy the conference before stopping the recorder, so unrecorded media cannot continue.
    const target = new URL(`${value('PROSODY_CONTROL_URL', 'http://prosody:5280/ekyc-control')}/stop`);
    const status = await new Promise((resolve, reject) => {
      // Prosody routes HTTP modules by XMPP virtual host, not the Docker hostname.
      const req = httpRequest(target, { method: 'POST', timeout: 5000, headers: { host: value('XMPP_MUC_DOMAIN', 'muc.meet.jitsi'), 'content-type': 'application/json', 'x-internal-secret': this.cfg.internalSecret } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('timeout', () => req.destroy(new Error('CONFERENCE_STOP_TIMEOUT')));
      req.on('error', reject);
      req.end(JSON.stringify({ room }));
    });
    assert(status >= 200 && status < 300, 503, 'CONFERENCE_STOP_UNAVAILABLE');
    const recording = await this.db('platform_recordings').where({ call_id }).first();
    if (recording?.worker_id && !['stopped', 'stored'].includes(recording.state)) {
      await this.request(recording.worker_id, 'stopService', {});
      // A successful stop request is not proof that the file has been finalized. Wait for OFF/finalizer.
    }
  }
  async poll() {
    for (const record of await this.db('platform_recordings').where({ state: 'recording' })) {
      try {
        const health = await this.request(record.worker_id, 'health');
        const good = health.status?.busyStatus === 'BUSY' && health.status?.health?.healthStatus === 'HEALTHY';
        await this.calls.recordingEvent({ event_id: randomUUID(), call_id: record.call_id, recording_id: record.id, worker_id: record.worker_id, status: good ? 'heartbeat' : 'failed' });
      } catch { /* The persistent heartbeat watchdog fails the call if the recorder stays unreachable. */ }
    }
    // A failed call can precede Jibri's final OFF callback. Reconcile its slot
    // only after the recorder itself confirms that it is no longer busy.
    const held = await this.db('platform_recording_slots as slot')
      .join('platform_recordings as recording', 'recording.id', 'slot.recording_id')
      .join('platform_calls as call', 'call.id', 'recording.call_id')
      .whereIn('call.state', ['completed', 'failed', 'canceled', 'missed'])
      .whereIn('recording.state', ['failed', 'stopped', 'stored'])
      .select('slot.id', 'recording.id as recording_id', 'recording.worker_id');
    for (const item of held) {
      try {
        const health = await this.request(item.worker_id, 'health');
        if (health.status?.busyStatus === 'IDLE' && health.status?.health?.healthStatus === 'HEALTHY') {
          await this.db('platform_recording_slots').where({ id: item.id, recording_id: item.recording_id }).update({ recording_id: null });
        }
      } catch { /* Keep the slot reserved until Jibri can confirm it is idle. */ }
    }
  }
  register(app) {
    // Built-in Jibri webhooks cannot add our HMAC header. A per-deployment secret path is confined to the private media network, never proxied publicly.
    app.post('/internal/jibri/:secret/v1/session/status', async (req, res) => {
      assert(equal(req.params.secret, this.cfg.recordingSecret), 401, 'INVALID_RECORDER');
      const session = req.body.session;
      const status = String(session?.status || '').toUpperCase();
      assert(['ON', 'OFF'].includes(status), 422, 'INVALID_JIBRI_EVENT');
      const recording = await this.db('platform_recordings').where({ id: session.sessionId, worker_id: req.body.jibriId }).first(); assert(recording, 404, 'UNKNOWN_RECORDING');
      await this.calls.recordingEvent({ event_id: randomUUID(), call_id: recording.call_id, recording_id: recording.id, worker_id: recording.worker_id, status: status === 'ON' ? 'started' : session.failure ? 'failed' : 'stopped' });
      res.json({ success: true });
    });
    app.post('/internal/jibri/:secret/v1/status', (req, res) => { assert(equal(req.params.secret, this.cfg.recordingSecret), 401, 'INVALID_RECORDER'); res.json({ success: true }); });
  }
}
