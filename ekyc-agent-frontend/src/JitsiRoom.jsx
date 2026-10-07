import { useEffect, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';
const scripts = new Map();
function load(domain) {
  if (!scripts.has(domain)) scripts.set(domain, new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = `https://${domain}/external_api.js`; script.async = true;
    script.onload = resolve; script.onerror = () => { scripts.delete(domain); reject(new Error('Server video tidak dapat dihubungi')); }; document.head.appendChild(script);
  })); return scripts.get(domain);
}
export default function JitsiRoom({ admission, onLeft, displayName, meetingSubject, moderator = false }) {
  const container = useRef(null); const leaveHandler = useRef(onLeft); const details = useRef({ displayName, meetingSubject }); const apiRef = useRef(null); const [error, setError] = useState(null); const [ready, setReady] = useState(false);
  details.current = { displayName, meetingSubject };
  useEffect(() => { leaveHandler.current = onLeft; }, [onLeft]);
  useEffect(() => {
    if (!ready || !apiRef.current) return;
    if (displayName) apiRef.current.executeCommand('displayName', displayName);
    if (meetingSubject) apiRef.current.executeCommand(moderator ? 'subject' : 'localSubject', meetingSubject);
  }, [displayName, meetingSubject, moderator, ready]);
  useEffect(() => {
    let disposed = false; let api;
    setReady(false); setError(null);
    load(admission.domain).then(() => {
      if (disposed) return;
      api = new window.JitsiMeetExternalAPI(admission.domain, { parentNode: container.current, roomName: admission.room, jwt: admission.jwt, userInfo: { displayName: details.current.displayName || 'Peserta verifikasi' }, width: '100%', height: '100%', configOverwrite: { prejoinConfig: { enabled: false }, disableDeepLinking: true, startAudioMuted: 0, startVideoMuted: 0, startWithAudioMuted: false, startWithVideoMuted: false, disableModeratorIndicator: !moderator, disabledNotifications: moderator ? [] : ['notify.moderator'], participantsPane: moderator ? undefined : { hideModeratorSettingsTab: true, hideMoreActionsButton: true, hideMuteAllButton: true }, toolbarButtons: ['microphone', 'camera', 'chat', 'settings', 'tileview'], p2p: { enabled: false } } });
      apiRef.current = api;
      api.addEventListener('videoConferenceJoined', async () => {
        if (details.current.displayName) api.executeCommand('displayName', details.current.displayName);
        if (details.current.meetingSubject) api.executeCommand(moderator ? 'subject' : 'localSubject', details.current.meetingSubject);
        if (disposed) return;
        setReady(true);
        try {
          // The server and saved browser settings can still start muted despite configOverwrite.
          const [audioMuted, videoMuted] = await Promise.all([api.isAudioMuted(), api.isVideoMuted()]);
          if (disposed) return;
          if (audioMuted) api.executeCommand('toggleAudio');
          if (videoMuted) api.executeCommand('toggleVideo');
        } catch { /* Device errors are reported by Jitsi below. */ }
      });
      api.addEventListener('micError', () => { if (!disposed) setError(`Mikrofon tidak dapat diakses. Izinkan mikrofon untuk ${admission.domain} dan pilih perangkat di pengaturan video.`); });
      api.addEventListener('cameraError', () => { if (!disposed) setError(`Kamera tidak dapat diakses. Izinkan kamera untuk ${admission.domain} dan pilih perangkat di pengaturan video.`); });
      api.addEventListener('videoConferenceLeft', () => { if (!disposed) leaveHandler.current?.(); });
    }).catch(err => { if (!disposed) setError(err.message); });
    return () => { disposed = true; apiRef.current = null; api?.dispose(); };
  }, [admission.domain, admission.room, admission.jwt, moderator]);
  return <div className="jitsi-wrap">{error && <Alert type="error" title={error}/>} {!ready && !error && <div className="video-loading"><Spin/><p>Menghubungkan video…</p></div>}<div className="jitsi-frame" ref={container}/></div>;
}
