import { Link } from 'react-router-dom';
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  BankOutlined,
  BarChartOutlined,
  CalendarOutlined,
  PhoneOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';

const formatDate = () => new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric',
}).format(new Date());

export default function DashboardHome({ data, actor, banks }) {
  const bank = banks.find(item => item.id === actor.bank_id);
  const isCentral = ['admin', 'superadmin'].includes(actor.role);
  const workspacePath = isCentral ? '/banks' : '/apps';
  const workspaceLabel = isCentral ? 'Buka daftar bank' : 'Buka aplikasi';
  const stats = [
    { label: 'Bank', value: data?.banks, icon: BankOutlined, href: isCentral ? '/banks' : workspacePath, note: 'Mitra terdaftar' },
    { label: 'Aplikasi', value: data?.applications, icon: AppstoreOutlined, href: workspacePath, note: 'Layanan eKYC' },
    { label: 'Agent', value: data?.agents, icon: TeamOutlined, href: workspacePath, note: 'Petugas terdaftar' },
    { label: 'Nasabah', value: data?.customers, icon: UserOutlined, href: workspacePath, note: 'Profil aktif' },
  ];
  const quickLinks = isCentral
    ? [
      { label: 'Kelola bank', description: 'Profil mitra dan aplikasi', icon: BankOutlined, href: '/banks' },
      { label: 'Tinjau permintaan', description: 'Persetujuan aplikasi baru', icon: AppstoreOutlined, href: '/app-requests' },
      { label: 'Pantau kuota', description: 'Sisa layanan per bank', icon: BarChartOutlined, href: '/quota' },
    ]
    : [
      { label: 'Buka aplikasi', description: 'Pelanggan, agent, dan panggilan', icon: AppstoreOutlined, href: '/apps' },
      { label: 'Lihat penyimpanan', description: 'Dokumen dan rekaman', icon: PhoneOutlined, href: '/storage' },
      { label: 'Daftar petugas', description: 'Akun operasional bank', icon: TeamOutlined, href: '/officers' },
    ];

  return <div className="dashboard-home">
    <section className="dashboard-hero" aria-label="Ringkasan dashboard">
      <div className="hero-copy">
        <div className="hero-kicker"><span className="hero-kicker-mark"/> LINTASARTA / EKYC MANAGEMENT</div>
        <h1>Ruang kerja verifikasi<br/><em>yang lebih terarah.</em></h1>
        <p>Pantau layanan, kelola akses, dan lanjutkan pekerjaan operasional dari satu tempat.</p>
        <Link className="hero-link" to={workspacePath}>{workspaceLabel}<ArrowRightOutlined/></Link>
      </div>
      <div className="hero-meta">
        <CalendarOutlined/>
        <span className="hero-meta-label">HARI INI · WIB</span>
        <strong>{formatDate()}</strong>
        <div className="hero-meta-rule"/>
        <span className="hero-meta-label">RUANG KERJA</span>
        <strong>{bank?.name || 'Operasional pusat'}</strong>
      </div>
    </section>

    <div className="dashboard-section-heading">
      <div><span className="section-index">01 / OVERVIEW</span><h2>Ringkasan operasional</h2></div>
      <span className="section-caption">Data sesuai hak akses Anda</span>
    </div>
    <div className="stat-grid">
      {stats.map(({ label, value, icon: Icon, href, note }, index) => <Link className="stat" to={href} key={label}>
        <span className="stat-top"><span className="stat-icon"><Icon/></span><span className="stat-index">0{index + 1}</span></span>
        <strong>{value ?? '—'}</strong>
        <span className="stat-label">{label}</span>
        <span className="stat-bottom"><span>{note}</span><ArrowRightOutlined/></span>
      </Link>)}
    </div>

    <div className="dashboard-bottom">
      <section className="quick-panel">
        <div className="panel-heading"><div><span className="section-index">02 / SHORTCUTS</span><h2>Akses cepat</h2></div><span>Mulai dari sini</span></div>
        <div className="quick-links">{quickLinks.map(({ label, description, icon: Icon, href }) => <Link to={href} key={label}>
          <span className="quick-icon"><Icon/></span><span className="quick-copy"><strong>{label}</strong><small>{description}</small></span><ArrowRightOutlined className="quick-arrow"/>
        </Link>)}</div>
      </section>
      <section className="guide-panel">
        <span className="section-index">WORKFLOW / EKYC</span>
        <h2>Dari pendaftaran<br/>hingga verifikasi.</h2>
        <p>Pilih aplikasi untuk meninjau data nasabah, memantau panggilan, dan mengunduh laporan.</p>
        <div className="guide-steps"><span>01 <b>Nasabah</b></span><span>02 <b>Video call</b></span><span>03 <b>Hasil</b></span></div>
      </section>
    </div>
  </div>;
}
