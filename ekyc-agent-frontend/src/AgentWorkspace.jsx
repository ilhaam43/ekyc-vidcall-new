import { Button, Drawer, Empty, Tag } from 'antd';
import { DashboardOutlined, TeamOutlined, UserOutlined, LogoutOutlined, ReloadOutlined, PhoneFilled, ClockCircleOutlined, CheckCircleOutlined, ArrowRightOutlined } from '@ant-design/icons';
import logo from './assets/lintasarta-logo-top.png';

function QueueCard({ item, index, busy, onClaim, onDetail, selected }) {
  return <article className={`queue-item${selected ? ' queue-item-selected' : ''}`}>
    <div className="queue-item-head">
      <span className="queue-order">{String(index + 1).padStart(2, '0')}</span>
      {selected ? <span className="queue-next">Dari tautan staf</span> : index === 0 && <span className="queue-next">Berikutnya</span>}
    </div>
    <h3>Nasabah {item.user_id.slice(0, 8)}</h3>
    <p className="queue-id">ID {item.user_id}</p>
    <div className="queue-item-meta"><ClockCircleOutlined/> Terdaftar {new Date(item.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })} WIB</div>
    <div className="queue-item-actions">
      <Button type="primary" loading={busy} onClick={() => onClaim(item.user_id, item.id)} icon={<PhoneFilled/>}>Panggil</Button>
      <Button onClick={() => onDetail(item.user_id)}>Detail</Button>
    </div>
  </article>;
}

function Dashboard({ queue, stats, busy, onClaim, onPage }) {
  const cards = [
    { icon: <CheckCircleOutlined/>, value: stats.done || 0, title: 'Verifikasi berhasil', note: 'Total sesi selesai', tone: 'success' },
    { icon: <ClockCircleOutlined/>, value: stats.canceled || 0, title: 'Sesi tidak selesai', note: 'Dibatalkan atau gagal', tone: 'muted' },
    { icon: <TeamOutlined/>, value: queue.length, title: 'Nasabah menunggu', note: 'Dalam antrean saat ini', tone: 'queue' },
  ];
  return <>
    <div className="page-heading"><div><h1>Ringkasan</h1><p>Aktivitas verifikasi video Anda</p></div></div>
    <div className="overview-grid">
      {cards.map(card => <article className={`overview-card ${card.tone}`} key={card.title}>
        <span className="overview-icon">{card.icon}</span><div className="overview-value">{card.value}</div>
        <h3>{card.title}</h3><p>{card.note}</p>
      </article>)}
    </div>
    <section className="dashboard-next">
      <div className="next-copy"><span className="next-kicker">ANTREAN NASABAH</span>
        <h2>{queue.length ? 'Siap melayani nasabah berikutnya?' : 'Belum ada nasabah yang menunggu'}</h2>
        <p>{queue.length ? `Nasabah ${queue[0].user_id.slice(0, 8)} berada di urutan pertama.` : 'Nasabah baru akan muncul di halaman antrean setelah mendaftar.'}</p>
      </div>
      <div className="next-actions">{queue.length > 0 && <Button type="primary" size="large" icon={<PhoneFilled/>} loading={busy} onClick={() => onClaim()}>Panggil berikutnya</Button>}
        <Button size="large" onClick={() => onPage('queue')}>Buka antrean <ArrowRightOutlined/></Button>
      </div>
    </section>
  </>;
}

function Queue({ queue, busy, onClaim, onDetail, launchCallId }) {
  return <>
    <section className="queue-page-head"><div><h1>Antrean nasabah</h1><p>Nasabah diurutkan berdasarkan waktu pendaftaran.</p></div><div className="queue-head-actions"><Tag>{queue.length} menunggu</Tag><Button type="primary" icon={<PhoneFilled/>} disabled={!queue.length} loading={busy} onClick={() => onClaim()}>Panggil berikutnya</Button></div></section>
    {queue.length ? <div className="queue-grid">{queue.map((item, index) => <QueueCard key={item.id} item={item} index={index} busy={busy} onClaim={onClaim} onDetail={onDetail} selected={item.id === launchCallId}/>)}</div> : <div className="queue-empty"><Empty description="Belum ada nasabah dalam antrean"/></div>}
  </>;
}

export default function AgentWorkspace({ page, onPage, profile, queue, stats, call, launchCallId, connected, error, onErrorClose, busy, onClaim, onReload, onLogout, detail, onDetail, renderCall, renderAccount, renderCustomer }) {
  const title = call ? 'Sesi video' : page === 'queue' ? 'Queue' : page === 'account' ? 'Akun saya' : 'Dashboard';
  return <div className="workspace">
    <aside className="sidebar">
      <div className="sidebar-logo"><img src={logo} alt="Lintasarta"/></div>
      <nav aria-label="Navigasi petugas">
        {[["dashboard", DashboardOutlined, 'Dashboard'], ['queue', TeamOutlined, 'Queue'], ['account', UserOutlined, 'Akun saya']].map(([key, Icon, label]) => <button key={key} className={`nav ${page === key && !call ? 'active' : ''}`} onClick={() => onPage(key)}><Icon/><span>{label}</span>{key === 'queue' && queue.length > 0 && <b>{queue.length}</b>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-product">eKYC Agent</div><button className="nav logout" onClick={onLogout}><LogoutOutlined/><span>Keluar</span></button></div>
    </aside>
    <div className="workspace-body">
      <header className="topbar"><div className="topbar-title">{title}</div><div className="topbar-right"><Button type="text" size="small" icon={<ReloadOutlined/>} onClick={onReload} aria-label="Perbarui data"/><span className={`connection ${connected ? 'online' : ''}`}><i/>{connected ? 'Terhubung' : 'Menghubungkan'}</span><div className="topbar-divider"/><div className="avatar">{profile?.name?.slice(0, 1) || 'P'}</div><div className="profile-name"><strong>{profile?.name || 'Petugas'}</strong><small>{profile?.username || 'Agent'}</small></div></div></header>
      <main>{error && <div className="workspace-error"><Tag color="error">Gangguan</Tag>{error}<button onClick={onErrorClose} aria-label="Tutup pesan">×</button></div>}
        {call ? renderCall() : page === 'account' ? renderAccount() : page === 'queue' ? <Queue queue={queue} busy={busy} onClaim={onClaim} onDetail={onDetail} launchCallId={launchCallId}/> : <Dashboard queue={queue} stats={stats} busy={busy} onClaim={onClaim} onPage={onPage}/>}
      </main>
      <footer className="workspace-footer">© Lintasarta × Mechlab · {new Date().getFullYear()}</footer>
    </div>
    <Drawer title="Data nasabah" open={!!detail} onClose={() => onDetail(null)} size="large">{detail && renderCustomer()}</Drawer>
  </div>;
}
