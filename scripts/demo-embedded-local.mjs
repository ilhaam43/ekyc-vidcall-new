const base = 'http://127.0.0.1:5174';
let ready = false;
try {
  const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
  ready = response.ok;
} catch { /* The local Compose service has not started yet. */ }

if (!ready) {
  console.error('Embedded demo is not running. Start the local Docker Compose stack with compose.dev.yaml.');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    staff_portal_url: `${base}/staff`,
    customer_url: `${base}/customer`,
    note: 'These URLs are stable. Opening either page obtains a fresh one-time launch code.',
  }, null, 2));
}
