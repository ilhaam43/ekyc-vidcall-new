# Synthetic Jitsi video-call test

## Windows localhost (Docker Desktop)

This profile runs one Jibri recorder and is for a local synthetic test. Start Docker Desktop with at least 8 GB assigned. From this repository in PowerShell, after generating and configuring `.env` with `npm run secrets:generate` and `npm run jitsi:prepare`, set `JITSI_DOMAIN=meet.localtest.me`, `PUBLIC_URL=https://meet.localtest.me`, `HTTPS_PORT=443`, `HTTP_PORT=127.0.0.1:58000`, and `CONFIG=./.local/jitsi`. Set `JVB_ADVERTISE_IPS` initially to your Windows LAN IPv4 address (for example from `Get-NetIPAddress -AddressFamily IPv4`). Do not use an IP copied from another machine.

```powershell
$files = @('-f','compose.yaml','-f','compose.dev.yaml','-f','infra/jitsi/upstream/docker-compose.yml','-f','infra/jitsi/compose.pilot.yaml','-f','infra/jitsi/compose.local.yaml')
docker compose @files up -d --build
docker compose @files ps
docker compose @files exec -T jvb hostname -i
docker compose @files exec -T master node scripts/seed.mjs
```

Append the printed JVB Docker address to `JVB_ADVERTISE_IPS` in `.env` as `WINDOWS_LAN_IP,JVB_DOCKER_IP`, then run `docker compose @files up -d jvb`. The Docker address can change if the network is recreated; check it again if video stops working. Both browsers and Jibri must reach UDP port 10000. Windows firewall or VPN rules can block this path.

Save the generated tenant ID, customer ID, agent username and password. Create a call and customer link from the host:

```powershell
npm run demo:call -- TENANT_UUID CUSTOMER_UUID
```

Open `https://meet.localtest.me/` once and accept the local self-signed certificate warning. Then open `http://127.0.0.1:5173/` for the agent and the printed `customer_url` in another browser profile or device. Follow steps 5 and 6 below. The customer grant expires after five minutes; rerun `npm run demo:call` for another link. Docker Desktop media forwarding varies by machine, so confirm two-way audio/video and play the saved MP4 before trusting a completed verification.

For an automated synthetic Chrome test, run `node --env-file=.env scripts/smoke-local.mjs TENANT_UUID CUSTOMER_UUID USERNAME PASSWORD` from the repository. This requires a local Chrome installation. It checks that both embedded Jitsi rooms join and that completion has a stored recording of at least 100 KB. Manual playback remains necessary to confirm visible and audible participants.

To export a **synthetic** stored recording for local playback, set `DATABASE_URL` to the development PostgreSQL port (`127.0.0.1:55432`), `OBJECT_ENDPOINT=http://127.0.0.1:58333`, and `RECORDING_STAGING_DIR` to `.local/jitsi/storage/jibri/recordings`, then run `node --env-file=.env scripts/export-local-recording.mjs CALL_UUID`. This helper refuses production mode.

The local development overlay provides the authenticated S3 Web UI at `http://127.0.0.1:58082/` on the host loopback interface only. Sign in with `OBJECT_UI_ADMIN_EMAIL` and `OBJECT_UI_ADMIN_PASSWORD` from `.env`, then open the configured SeaweedFS connection and `ekyc-recordings` bucket. The key path is `<bank/tenant_id>/<nasabah/customer_id>/<call_id>/<recording_id>.mp4`; opaque IDs keep names and identity numbers out of object paths. The local console account is an administrator and can browse every bucket exposed by its configured S3 key; it does not yet provide separate per-bank logins. To reorganize older stored recordings after deployment, run `node --env-file=.env scripts/organize-recordings.mjs --dry-run`, review the proposed moves, then run the same command without `--dry-run`. The S3 API remains at `http://127.0.0.1:58333`.

Local containers use `TZ=Asia/Jakarta` (WIB, UTC+7). The agent queue explicitly renders timestamps in WIB. Database timestamps and S3 protocol dates retain their unambiguous instant/UTC representation; changing the display zone does not shift existing recordings or expiry times.

## Linux pilot (five Jibri recorders)

The default local Compose stack starts the application, PostgreSQL, Valkey and SeaweedFS. It does **not** start Jitsi. A live recorded test needs the Linux pilot deployment, real DNS and HTTPS for the Jitsi web host, an externally reachable JVB media address, and a browser-accessible frontend URL. Jitsi documents `443/tcp` and `10000/udp` as external ports and `JVB_ADVERTISE_IPS` for the advertised media address. See the [official Docker guide](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/).

1. On a Linux Docker host, configure `.env` for a **synthetic, nonproduction** pilot: `NODE_ENV=development`, `ENCRYPTION_MOCK=true`, `JITSI_DOMAIN`, `PUBLIC_URL=https://<JITSI_DOMAIN>`, `JVB_ADVERTISE_IPS=<public-IP>`, `PUBLIC_ORIGIN=<browser-accessible-frontend-URL>`, TLS settings and random secrets. Use the official Jitsi guide for HTTPS and host networking. Size the host for five Jibri instances and recordings.
2. In the new repository run `npm ci`, `npm run jitsi:prepare`, then:

   ```sh
   docker compose -f compose.yaml -f infra/jitsi/upstream/docker-compose.yml -f infra/jitsi/compose.pilot.yaml config --quiet
   docker compose -f compose.yaml -f infra/jitsi/upstream/docker-compose.yml -f infra/jitsi/compose.pilot.yaml up -d --build
   docker compose -f compose.yaml -f infra/jitsi/upstream/docker-compose.yml -f infra/jitsi/compose.pilot.yaml ps
   ```

   Verify `web`, `prosody`, `jicofo`, `jvb`, `jibri1` through `jibri5`, and all application services are running. If a service is unhealthy, inspect `docker compose ... logs <service>` before proceeding.
3. Create synthetic records in that pilot database:

   ```sh
   docker compose -f compose.yaml -f infra/jitsi/upstream/docker-compose.yml -f infra/jitsi/compose.pilot.yaml exec -T master node scripts/seed.mjs
   ```

   Save its printed `tenantId`, `customerId`, agent `username`, and `password`. These are new pilot fixtures; the Windows demo IDs are tied to the Windows local database.
4. Create a queued call and a one-time customer link, replacing the two UUIDs with the printed values:

   ```sh
   docker compose -f compose.yaml -f infra/jitsi/upstream/docker-compose.yml -f infra/jitsi/compose.pilot.yaml exec -T calls node scripts/demo-call.mjs TENANT_UUID CUSTOMER_UUID
   ```

   The returned customer link expires in five minutes. If it expires, run the command again to issue a new grant for the existing active call.
5. Open the frontend in two browser sessions. Log in as the agent in one. Open `customer_url` in a separate private window or device. On the agent page choose **Panggil berikutnya**, then **Masuk ruang video**. Once the agent has joined, the customer receives the invitation. On the customer page allow the camera/microphone, consent to recording, and join. Jibri starts after Prosody confirms that the customer joined; both pages should then show the recording as active. Do not begin verification until that status appears.
6. Confirm two-way audio/video. As the agent choose **Selesaikan verifikasi**, select an outcome, and wait for `completed`. Check the recording state via `GET /api/v2/calls/:id/recording` with the agent bearer token. It must be `stored`, with bytes and SHA-256. Verify the object in SeaweedFS and play it back. A browser recording indicator by itself is not proof of durable recording.

This procedure has **not yet passed** as a real Jitsi/Jibri run. The custom Prosody admission guard and webhook integration need validation on the target Linux host. If admission or recording fails, do not bypass the recording gate; inspect Prosody, Jibri and call-service logs and keep the verification incomplete. Current automated coverage is `npm run test:integration`, which checks the database lifecycle without live media.
