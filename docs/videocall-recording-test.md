# Local recorded video-call verification

Verified on 7 October 2026 WIB using real Kong, PostgreSQL, Prosody, Jicofo,
Videobridge, Jibri and SeaweedFS. Playwright supplied synthetic camera and audio
devices in two independent browser sessions; no real customer data was used.

## Result

Nine live checks passed: bank API link creation through Kong; deferred queue
creation on opening the customer link; agent assignment and invitation;
recorder reservation before customer join; actual customer Jitsi join and
authenticated Jibri ON event; verified completion after storage; downloaded
object checksum reconciliation; admin history and recording detail; customer
completion notification.

- Call: `b3c20ec9-b7ad-40bb-a84e-b291648e0d6e`
- Bank: `Recording test 2bd9ba17`
- Outcome: `verified`; call: `completed`; recording: `stored`
- Duration: 19.667 seconds; codecs: H.264 video and AAC audio
- Bytes: 1,097,052
- SHA-256: `318494fae7833c36c37f4b8f1dc294fa188f0bee4b7171508b7810a0a4a297c1`
- Bucket: `ekyc-recordings`
- Object: `36a05110-e852-4781-9de9-5224d6512391/9168684b-a775-4efd-b5c2-28c71c3c3994/b3c20ec9-b7ad-40bb-a84e-b291648e0d6e/5c882abe-b48e-4f6d-802f-f782016d0cdd.mp4`
- Admin: <http://127.0.0.1:5301/banks/@recording-2bd9ba17/apps/ec728574-af01-45c1-a750-7b7057d8e06c/calls>
- Report, screenshots and downloaded MP4: `.local/recording-test-2bd9ba17/`

The recording was downloaded from SeaweedFS, independently checked with
ffprobe, and a frame at eight seconds inspected. Both synthetic participant
camera feeds are present. Admin Detail contains recording metadata; there is
currently no inline playback control in that dashboard modal. The object
remains private and is available through authenticated storage access.

Synthetic fixtures are retained for inspection. The fixture application is
inactive, the test agent is disabled, and the temporary superadmin was removed.
Existing admin accounts can inspect the saved history. Earlier failed test
attempts are also retained as synthetic diagnostic history.

## Corrections discovered by the live test

1. Basic customer sessions bound to a call subscribed to a different realtime
   room than the worker used. The worker now delivers to both the legacy room
   and its call-scoped room; room routing regression tests pass.
2. Jicofo's JWT authentication domain gate rejected Jibri's separately
   authenticated recorder domain. `JICOFO_ENABLE_AUTH=0` delegates participant
   authentication to Prosody's JWT validation and eKYC admission guard.
   Agent/customer affiliation checks, nonempty JWT requirements and recorder
   credentials remain enforced. These are separate configuration controls in
   the [official Jicofo template](https://github.com/jitsi/docker-jitsi-meet/blob/master/jicofo/rootfs/defaults/jicofo.conf).
3. The saved pilot bridge addresses were stale on this laptop. Local Compose
   now requires `JVB_LOCAL_ADVERTISE_IPS` with the current host Wi-Fi/Ethernet
   IPv4, while preserving private candidates for Jibri. Loopback alone did
   not connect the host browser media. This machine currently uses
   `192.168.0.147`; update `.env` after switching networks. Linux pilot
   configuration continues to use `JVB_ADVERTISE_IPS`.

Lint, five call/integration API tests and full local Compose validation passed.
This is a single local recorded-call test, not a five-call capacity or mobile
device acceptance test.

## Repeat

Start the local stack including Jitsi and Kong, then run from the repository
root:

```powershell
node --env-file=.env scripts/test-videocall-recording-live.mjs
```

The script creates a fresh synthetic bank and call and retains the output for
review. The local DB, Chrome installation, dashboard and recording stack must
be running. Do not run this fixture script against production.
