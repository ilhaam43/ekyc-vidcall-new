import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp, Button, Input, Form, Alert, Tag, Space, Modal, Empty, Spin, Checkbox, Select } from 'antd';
import { VideoCameraOutlined, SafetyCertificateOutlined, ArrowRightOutlined, FileTextOutlined, PhoneOutlined, UserOutlined, CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { io } from 'socket.io-client';
import { request, refresh, session, logout, documentUrl, localPath } from './api';
import JitsiRoom from './JitsiRoom';
import AgentWorkspace from './AgentWorkspace';
import { customerResult } from './customerResult';
import loginLogo from './assets/lintasarta-logo.png';
import './style.css';
import './agent.css';
const labels = { waiting: 'Dalam antrean', assigned: 'Dialokasikan', preparing_recording: 'Menyiapkan rekaman', ringing: 'Menunggu nasabah', active: 'Sedang berlangsung', completing: 'Menyimpan hasil', completed: 'Selesai', failed: 'Gangguan teknis', canceled: 'Dibatalkan', missed: 'Tidak terjawab' };
const terminal = ['completed', 'failed', 'canceled', 'missed'];
function Brand() { return <div className="brand"><span className="brand-icon"><VideoCameraOutlined/></span><div>eKYC<span>VERIFIKASI VIDEO</span></div></div>; }
function Status({ state, customerJoinedAt }) { const text = state === 'ringing' ? customerJoinedAt ? 'Menghubungkan perekam' : 'Menunggu nasabah' : labels[state] || state; return <Tag color={state === 'active' ? 'green' : state === 'failed' ? 'red' : 'blue'}>{text}</Tag>; }
function useRealtime(onChange, onQueueChange) {
  const handler = useRef({ onChange, onQueueChange }); const [connected, setConnected] = useState(false);
  useEffect(() => { handler.current = { onChange, onQueueChange }; }, [onChange, onQueueChange]);
  useEffect(() => {
    const socket = io({ path: localPath('/socket.io'), auth: cb => cb({ token: session.token }), transports: ['websocket'], autoConnect: true });
    let renewing = false;
    const reconnect = async () => {
      if (renewing) return;
      renewing = true;
      try {
        await refresh();
        // A server-initiated disconnect does not automatically reconnect.
        if (socket.connected) socket.disconnect();
        socket.connect();
      } catch { setConnected(false); }
      finally { renewing = false; }
    };
    socket.on('connect', () => { setConnected(true); handler.current.onChange(); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('queue.change', data => { handler.current.onQueueChange?.(data); handler.current.onChange(); });
    for (const name of ['call.start', 'call.state', 'call.end', 'call.missed']) socket.on(name, () => handler.current.onChange());
    socket.on('session.expired', reconnect);
    socket.on('connect_error', error => { setConnected(false); if (error.message === 'UNAUTHORIZED') reconnect(); });
    const timer = setInterval(() => { if (!socket.connected) handler.current.onChange(); }, 10000);
    const visible = () => { if (document.visibilityState === 'visible') handler.current.onChange(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); socket.disconnect(); };
  }, []);
  return connected;
}
function Login({ onLogin }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(data) { setBusy(true); setError(''); try { const result = await request('/v1/agents/login', { method: 'POST', body: data }); session.set(result.access_token); onLogin(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <div className="login-page"><div className="login-center"><img className="login-logo" src={loginLogo} alt="Lintasarta"/><div className="login-panel"><h1>Masuk ke eKYC</h1><p>Portal petugas verifikasi video</p>{error && <Alert type="error" title={error} showIcon/>}<Form layout="vertical" onFinish={submit}><Form.Item label="Username" name="username" rules={[{ required: true, message: 'Masukkan username' }]}><Input size="large" autoComplete="username" prefix={<UserOutlined/>}/></Form.Item><Form.Item label="Password" name="password" rules={[{ required: true, message: 'Masukkan password' }]}><Input.Password size="large" autoComplete="current-password"/></Form.Item><Button block size="large" type="primary" htmlType="submit" loading={busy}>Masuk ke workspace</Button></Form></div><div className="login-copyright">© Lintasarta × Mechlab · {new Date().getFullYear()}</div></div></div>;
}
function CustomerDetails({ userId }) {
  const [customer, setCustomer] = useState(null); const [docs, setDocs] = useState([]); const [error, setError] = useState(''); const [editing, setEditing] = useState(false); const [preview, setPreview] = useState(null); const [busy, setBusy] = useState(false);
  const { message } = AntApp.useApp();
  const load = useCallback(async () => { try { const [user, files] = await Promise.all([request(`/api/v1/users/${userId}`), request(`/api/v1/document/${userId}`)]); setCustomer(user); setDocs(files); setError(''); } catch (e) { setError(e.message); } }, [userId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  async function save(data) { setBusy(true); try { await request(`/api/v1/users/${userId}`, { method: 'PUT', body: data }); setEditing(false); await load(); message.success('Data nasabah diperbarui'); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function open(doc) { try { setPreview({ ...doc, url: await documentUrl(userId, doc.id) }); } catch (e) { setError(e.message); } }
  if (!customer) return error ? <Alert type="error" title={error}/> : <Spin/>;
  return <div className="customer-details">{error && <Alert type="error" title={error}/>}<div className="section-heading"><h3>Data nasabah</h3><Button size="small" onClick={() => setEditing(!editing)}>{editing ? 'Batal' : 'Edit data'}</Button></div>{editing ? <Form layout="vertical" initialValues={customer} onFinish={save}>{[['name', 'Nama lengkap'], ['id_number', 'NIK'], ['phone_number', 'Nomor telepon'], ['email', 'Email']].map(([key, label]) => <Form.Item key={key} name={key} label={label}><Input/></Form.Item>)}<Button type="primary" htmlType="submit" loading={busy}>Simpan perubahan</Button></Form> : <dl>{[['name', 'Nama lengkap'], ['id_number', 'NIK'], ['phone_number', 'Nomor telepon'], ['email', 'Email'], ['birth_date', 'Tanggal lahir']].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{customer[key] || '—'}</dd></div>)}</dl>}{customer.face_verification_score != null && <div className="face-score"><SafetyCertificateOutlined/><span>Kecocokan wajah</span><strong>{Math.round(customer.face_verification_score * 100)}%</strong></div>}<h3>Dokumen pendukung</h3>{docs.length ? docs.map(doc => <button className="document-item" key={doc.id} onClick={() => open(doc)}><FileTextOutlined/><span>{doc.type}</span><ArrowRightOutlined/></button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Belum ada dokumen"/>}<Modal title={preview?.type} open={!!preview} onCancel={() => setPreview(null)} footer={null} width={800}>{preview?.mimetype === 'application/pdf' ? <iframe title="Pratinjau dokumen" src={preview.url} style={{ width: '100%', height: 550 }}/> : preview && <img alt="Dokumen nasabah" src={preview.url} style={{ maxWidth: '100%' }}/>}</Modal></div>;
}
function CallPanel({ call, reload, agentName }) {
  const [admission, setAdmission] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [decisionOpen, setDecisionOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  useEffect(() => { let live = true; request(`/api/v1/users/${call.user_id}`).then(customer => { if (live) setCustomerName(customer.name || ''); }).catch(() => {}); return () => { live = false; }; }, [call.user_id]);
  useEffect(() => { const tick = () => request(`/api/v2/calls/${call.id}/heartbeat`, { method: 'POST' }).catch(() => {}); tick(); const timer = setInterval(tick, 15000); return () => clearInterval(timer); }, [call.id]);
  async function join() { setBusy(true); try { let label = customerName; if (!label) { try { label = (await request(`/api/v1/users/${call.user_id}`)).name || ''; } catch { /* The call remains joinable without a customer label. */ } } setAdmission(await request(`/api/v2/calls/${call.id}/admission`, { method: 'POST', body: { room_label: label } })); await reload(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function decide(data) { setBusy(true); try { await request(`/api/v2/calls/${call.id}/decision`, { method: 'POST', body: data }); setDecisionOpen(false); setAdmission(null); await reload(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function cancel() { setBusy(true); try { await request(`/api/v2/calls/${call.id}/cancel`, { method: 'POST' }); setAdmission(null); await reload(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <div className="call-layout"><section className="call-main"><div className="section-heading"><div><div className="eyebrow">SESI VERIFIKASI</div><h2>{customerName ? `Percakapan dengan ${customerName}` : 'Percakapan dengan nasabah'}</h2></div><Status state={call.state} customerJoinedAt={call.customer_joined_at}/></div>{error && <Alert type="error" title={error} closable onClose={() => setError('')}/>}<div className="video-stage">{admission && call.state !== 'completing' ? <JitsiRoom admission={admission} displayName={agentName} meetingSubject={customerName || 'Verifikasi eKYC'} moderator onLeft={() => { setAdmission(null); reload(); }}/> : <div className="video-placeholder"><VideoCameraOutlined/><h3>{call.state === 'completing' ? 'Menyimpan rekaman dan hasil' : 'Ruang verifikasi siap'}</h3><p>{call.state === 'completing' ? 'Status nasabah diperbarui setelah rekaman tersimpan dengan aman.' : 'Rekaman akan dimulai otomatis setelah nasabah bergabung.'}</p>{call.state !== 'completing' && <Button type="primary" size="large" onClick={join} loading={busy}>Masuk ruang video</Button>}</div>}</div><div className="call-footer"><span><span className={`record-dot ${call.state === 'active' ? 'on' : ''}`}/>{call.state === 'active' ? 'Rekaman aktif' : call.state === 'ringing' ? call.customer_joined_at ? 'Menunggu perekam mengonfirmasi' : 'Menunggu nasabah bergabung' : 'Rekaman wajib'}</span><Space>{call.state !== 'completing' && <Button danger onClick={() => Modal.confirm({ title: 'Batalkan sesi verifikasi?', content: 'Nasabah tidak akan dinyatakan terverifikasi.', onOk: cancel })} icon={<PhoneOutlined/>}>Batalkan</Button>}<Button type="primary" disabled={call.state !== 'active'} onClick={() => setDecisionOpen(true)}>Selesaikan verifikasi</Button></Space></div></section><aside className="call-customer"><CustomerDetails userId={call.user_id}/></aside><Modal title="Hasil verifikasi" open={decisionOpen} onCancel={() => setDecisionOpen(false)} footer={null}><Form layout="vertical" onFinish={decide}><Form.Item name="outcome" label="Keputusan" rules={[{ required: true }]}><Select options={[{ value: 'verified', label: 'Identitas terverifikasi' }, { value: 'not_verified', label: 'Identitas tidak terverifikasi' }]}/></Form.Item><Form.Item name="reason" label="Catatan petugas"><Input.TextArea maxLength={2000}/></Form.Item><Alert type="info" title="Hasil menunggu rekaman tersimpan sebelum menjadi final."/><Button type="primary" htmlType="submit" loading={busy} block style={{ marginTop: 20 }}>Simpan hasil dan akhiri panggilan</Button></Form></Modal></div>;
}
function Agent({ onLogout, launchCallId, embedded }) {
  const [page, setPage] = useState(embedded ? 'queue' : 'dashboard'); const [profile, setProfile] = useState(null); const [queue, setQueue] = useState([]); const [call, setCall] = useState(null); const [stats, setStats] = useState({}); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [detail, setDetail] = useState(null);
  const reloadSequence = useRef(0);
  const reload = useCallback(async () => { const sequence = ++reloadSequence.current; try { const [q, c, s] = await Promise.all([request('/v1/calls/queues'), request('/v1/calls/current'), request('/v1/agents/analytics')]); if (sequence === reloadSequence.current) { setQueue(q); setCall(c); setStats(s.calls_total || {}); setError(''); } } catch (e) { if (sequence === reloadSequence.current) setError(e.message); } }, []);
  const queueChanged = useCallback(data => {
    if (!data?.call) return;
    ++reloadSequence.current;
    setQueue(previous => {
      const withoutCall = previous.filter(item => item.id !== data.call.id);
      if (data.call.state !== 'waiting') return withoutCall;
      return [...withoutCall, data.call].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    });
  }, []);
  const connected = useRealtime(reload, queueChanged);
  useEffect(() => { request('/v1/agents/profile').then(setProfile).catch(e => setError(e.message)); reload(); }, [reload]);
  async function claim(userId, callId) { setBusy(true); setError(''); try { const path = callId ? `/api/v2/calls/${callId}/claim` : `/v1/calls/start${userId ? `/${userId}` : ''}`; const c = await request(path, { method: 'POST' }); setCall(c); await reload(); } catch (e) { setError(e.code === 'RECORDING_CAPACITY_UNAVAILABLE' ? 'Semua perekam sedang digunakan. Antrean tetap tersimpan.' : e.message); } finally { setBusy(false); } }
  return <AgentWorkspace page={page} onPage={setPage} profile={profile} queue={queue} stats={stats} call={call} launchCallId={launchCallId} connected={connected} error={error} onErrorClose={() => setError('')} busy={busy} onClaim={claim} onReload={reload} onLogout={async () => { await logout(); onLogout(); }} detail={detail} onDetail={setDetail} renderCall={() => <CallPanel key={call.id} call={call} reload={reload} agentName={profile?.name}/>} renderAccount={() => <Account profile={profile} onLogout={onLogout}/>} renderCustomer={() => <CustomerDetails key={detail} userId={detail}/>}/>;
}
function Account({ profile, onLogout }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function change(data) { setBusy(true); try { await request('/api/v2/agents/password', { method: 'POST', body: data }); await logout(); onLogout(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <div className="account-card"><h1>Akun petugas</h1><p>{profile?.name} · {profile?.username}</p><h3>Ganti password</h3>{error && <Alert type="error" title={error}/>}<Form layout="vertical" onFinish={change}><Form.Item label="Password saat ini" name="current_password" rules={[{ required: true }]}><Input.Password autoComplete="current-password"/></Form.Item><Form.Item label="Password baru" name="new_password" rules={[{ required: true, min: 12, max: 72 }]}><Input.Password autoComplete="new-password"/></Form.Item><Button type="primary" htmlType="submit" loading={busy}>Simpan dan masuk ulang</Button></Form></div>;
}
function CustomerFinish({ call }) {
  const result = customerResult(call);
  const Icon = result.tone === 'verified' ? CheckCircleOutlined : result.tone === 'not-verified' ? CloseCircleOutlined : result.tone === 'pending' ? ClockCircleOutlined : PhoneOutlined;
  return <div className={`customer-finish customer-finish--${result.tone}`} role="status" aria-live="polite"><span className="customer-finish-icon"><Icon/></span><div className="eyebrow">STATUS SESI VIDEO</div><h1>{result.title}</h1><p>{result.description}</p></div>;
}
function Customer() {
  const [ready, setReady] = useState(false); const [error, setError] = useState(''); const [call, setCall] = useState(null); const [admission, setAdmission] = useState(null); const [consent, setConsent] = useState(false); const [devices, setDevices] = useState(false); const [busy, setBusy] = useState(false);
  const video = useRef(null); const stream = useRef(null); const knownId = useRef(sessionStorage.getItem('customer_call_id'));
  const load = useCallback(async () => { if (!session.token) return; try { const current = await request('/api/v2/calls/current'); if (current) { knownId.current = current.id; sessionStorage.setItem('customer_call_id', current.id); setCall(current); } else if (knownId.current) setCall(await request(`/api/v2/calls/${knownId.current}`)); setError(''); } catch (e) { setError(e.message); } }, []);
  useEffect(() => { let live = true; const code = new URLSearchParams(location.hash.slice(1)).get('code'); history.replaceState(null, '', location.pathname); if (code) { knownId.current = null; sessionStorage.removeItem('customer_call_id'); } (code ? request('/api/v2/sessions/customer', { method: 'POST', body: { code }, retry: false }).then(result => session.set(result.access_token)) : refresh()).then(() => { if (live) { setReady(true); load(); } }).catch(() => { if (live) setError('Tautan sesi tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.'); }); return () => { live = false; stream.current?.getTracks().forEach(track => track.stop()); }; }, [load]);
  async function checkDevices() { try { stream.current?.getTracks().forEach(track => track.stop()); stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true }); if (video.current) video.current.srcObject = stream.current; setDevices(true); setError(''); } catch { setError('Izinkan akses kamera dan mikrofon, lalu coba lagi.'); } }
  async function join() { setBusy(true); try { await request(`/api/v2/calls/${call.id}/consent`, { method: 'POST', body: { accepted: true, version: 'recording-v1' } }); let displayName = 'Nasabah'; try { displayName = (await request(`/api/v1/users/${call.user_id}`)).name || displayName; } catch { displayName = 'Nasabah'; } stream.current?.getTracks().forEach(track => track.stop()); const grant = await request(`/api/v2/calls/${call.id}/admission`, { method: 'POST' }); setAdmission({ ...grant, display_name: displayName }); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <div className="customer-page"><header><Brand/><Tag icon={<SafetyCertificateOutlined/>} color="green">Sesi aman</Tag></header><main>{error && <Alert type="error" title={error}/>} {ready && <CustomerSync call={call} reload={load}/>} {admission && call && !terminal.includes(call.state) && call.state !== 'completing' ? <><JitsiRoom admission={admission} displayName={admission.display_name} meetingSubject={`Verifikasi eKYC — ${admission.display_name || 'Nasabah'}`} onLeft={() => { setAdmission(null); load(); }}/><p className="record-label"><span className={`record-dot ${call.state === 'active' ? 'on' : ''}`}/>{call.state === 'active' ? 'Sesi verifikasi sedang direkam' : 'Menghubungkan perekam. Mohon tunggu sebelum memulai verifikasi.'}</p></> : call && (terminal.includes(call.state) || call.state === 'completing') ? <CustomerFinish call={call}/> : <div className="customer-prejoin"><div className="eyebrow">VERIFIKASI IDENTITAS ONLINE</div><h1>Sedikit persiapan,<br/>sebelum kita terhubung.</h1><p className="muted">Siapkan kartu identitas dan pastikan Anda berada di tempat yang terang dan tenang.</p><div className="camera-preview"><video ref={video} muted playsInline autoPlay/>{!devices && <div><VideoCameraOutlined/><p>Pratinjau kamera Anda</p></div>}</div><Button block size="large" onClick={checkDevices}>Periksa kamera dan mikrofon</Button><div className="consent"><Checkbox checked={consent} onChange={e => setConsent(e.target.checked)}>Saya memahami dan menyetujui bahwa sesi video ini direkam untuk proses verifikasi identitas.</Checkbox></div><Button size="large" type="primary" block loading={busy} disabled={!ready || !devices || !consent || !call || !['ringing', 'active'].includes(call.state)} onClick={join}>Gabung dengan petugas <ArrowRightOutlined/></Button><p className="waiting-status"><ClockCircleOutlined/> {call ? labels[call.state] : ready ? 'Menunggu pendaftaran antrean dari penyedia layanan' : 'Memeriksa sesi…'}</p></div>}</main><footer>Data dan rekaman Anda hanya dapat diakses oleh pihak yang berwenang.</footer></div>;
}
function CustomerSync({ call, reload }) { useRealtime(reload); useEffect(() => { if (!call || terminal.includes(call.state)) return; const tick = () => request(`/api/v2/calls/${call.id}/heartbeat`, { method: 'POST' }).catch(() => {}); tick(); const t = setInterval(tick, 15000); return () => clearInterval(t); }, [call?.id, call?.state]); useEffect(() => { if (call?.state !== 'completing') return; const t = setInterval(reload, 3000); return () => clearInterval(t); }, [call?.state, reload]); return null; }
function App() {
  const customer = location.pathname.endsWith('/customer');
  const embedded = location.pathname.endsWith('/integrations/agent');
  const [authenticated, setAuthenticated] = useState(false); const [loading, setLoading] = useState(!customer);
  const [launchCallId, setLaunchCallId] = useState(null);
  const [linkError, setLinkError] = useState(false);
  useEffect(() => {
    if (customer) return;
    if (!embedded) { refresh().then(() => setAuthenticated(true)).catch(() => {}).finally(() => setLoading(false)); return; }
    const code = new URLSearchParams(location.hash.slice(1)).get('code');
    history.replaceState(null, '', location.pathname + location.search);
    const exchange = code ? request('/api/v2/sessions/agent/link', { method: 'POST', body: { code }, retry: false }) : refresh();
    exchange.then(result => { if (result.source !== 'integration') throw new Error('INVALID_LINK'); session.set(result.access_token); setLaunchCallId(result.launch_call_id || null); setAuthenticated(true); })
      .catch(() => setLinkError(true)).finally(() => setLoading(false));
  }, [customer, embedded]);
  if (customer) return <Customer/>; if (loading) return <div className="boot"><Spin size="large"/></div>;
  if (embedded && (!authenticated || linkError)) return <div className="integration-link-error"><h1>Tautan petugas tidak berlaku</h1><p>Minta tautan baru melalui aplikasi staf Anda. Tautan hanya dapat digunakan sekali dan berlaku lima menit.</p></div>;
  return authenticated ? <Agent embedded={embedded} launchCallId={launchCallId} onLogout={() => setAuthenticated(false)}/> : <Login onLogin={() => setAuthenticated(true)}/>;
}
createRoot(document.getElementById('root')).render(<ConfigProvider theme={{ token: { colorPrimary: '#175cd3', borderRadius: 9, fontFamily: 'Inter, Segoe UI, sans-serif', colorText: '#172b4d' } }}><AntApp><App/></AntApp></ConfigProvider>);
