# Infinid eKYC replacement

JavaScript workspace in a new directory. The original repositories are untouched. See [implementation status](docs/status.md), [live video test steps](docs/test-video.md), [embedded partner integration](docs/embedded-integration.md), and [legacy inventory](docs/legacy-inventory.md) before deployment.

For synthetic local development, use Node.js 24 and Docker Compose:

```sh
npm ci
npm run secrets:generate
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres valkey storage
docker compose -f compose.yaml -f compose.dev.yaml run --rm migrate
docker compose -f compose.yaml -f compose.dev.yaml run --rm master node scripts/seed.mjs
npm run build
```

Create a separate `ekyc_test` database and run the migrations against `TEST_DATABASE_URL` before `npm run test:integration`. The integration suite refuses a non-test database.

The rebuilt management dashboard runs at `http://127.0.0.1:5301`:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build dashboard dashboard-worker
docker compose -f compose.yaml -f compose.dev.yaml exec dashboard node ekyc-dashboard-new/scripts/seed.mjs
```

The seed prints temporary local dashboard credentials. See [dashboard setup](ekyc-dashboard-new/README.md) and [feature inventory](docs/dashboard-inventory.md) for supported workflows and migration gates.

Kong Gateway management is a separate application at `http://127.0.0.1:5302`, with its own login. Add `compose.kong.yaml` to the Compose command to run a writable local Kong Gateway and proxy at `http://127.0.0.1:58001`. Bank API plans remain assigned in the eKYC dashboard; approval and reassignment apply API key authentication, ACL membership, and rate limits in Kong. See [Kong Control](kong-console/README.md).

With the local video-call Compose stack running, open [the embedded integration demo](http://127.0.0.1:5174/) to get a staff URL in the format `/staff/<staff-id>` and generate a customer URL through its API button. Generating that link does not enqueue the customer; the customer enters the queue when they open it. No separate `npm run demo:embedded` process is required. See [embedded integration](docs/embedded-integration.md) for the API and call sequence.

Native Android and iOS apps can join the same self-hosted Jitsi rooms using the call admission response. See [mobile Jitsi SDK integration](docs/mobile-jitsi-sdk.md) for the API sequence and SDK options. A physical device needs a routable HTTPS Jitsi domain and trusted certificate; the localhost media configuration is for desktop testing.

The generated `.env` contains local random secrets and enables a synthetic encryption mock. Never point it at actual customer data. For the Linux media pilot, supply a real `JITSI_DOMAIN`, `DOCKER_HOST_ADDRESS`, TLS configuration, and external encryption service, then run `npm run jitsi:prepare`. The full pilot composition is:

```sh
docker compose -f compose.yaml -f infra/jitsi/upstream/docker-compose.yml -f infra/jitsi/compose.pilot.yaml config
```

Do not launch the full pilot with customer traffic until the gates in `docs/status.md` have passed. Jitsi sources and provenance are in `infra/jitsi/upstream`.
