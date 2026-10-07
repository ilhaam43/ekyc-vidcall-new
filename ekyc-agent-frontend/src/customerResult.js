export function customerResult(call) {
  if (call.state === 'completing') return {
    tone: 'pending', title: 'Hasil sedang diproses',
    description: 'Rekaman dan keputusan petugas sedang disimpan. Halaman ini akan menampilkan hasil setelah proses selesai.',
  };
  if (call.state === 'completed' && call.outcome === 'verified') return {
    tone: 'verified', title: 'Verifikasi berhasil',
    description: 'Identitas Anda telah diverifikasi. Hasilnya telah dikirim ke penyedia layanan Anda.',
  };
  if (call.state === 'completed' && call.outcome === 'not_verified') return {
    tone: 'not-verified', title: 'Verifikasi belum berhasil',
    description: 'Petugas belum dapat memverifikasi identitas Anda. Hubungi penyedia layanan untuk langkah berikutnya.',
  };
  if (call.state === 'canceled') return {
    tone: 'ended', title: 'Panggilan diakhiri',
    description: 'Sesi video berakhir sebelum ada keputusan verifikasi. Hubungi penyedia layanan jika perlu menjadwalkan ulang.',
  };
  if (call.state === 'missed') return {
    tone: 'ended', title: 'Panggilan tidak terjawab',
    description: 'Sesi video telah berakhir. Hubungi penyedia layanan untuk mencoba kembali.',
  };
  return {
    tone: 'ended', title: 'Sesi video berakhir',
    description: 'Verifikasi tidak dapat diselesaikan. Hubungi penyedia layanan untuk mencoba kembali.',
  };
}
