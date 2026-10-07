# eKYC management dashboard

This is the replacement for `../../infinid-dashboard`. The original repository is untouched. The dashboard is a React 19/Vite 8 client and a Node 24/Express 5 API. Browser traffic stays on one origin (`http://127.0.0.1:5301` locally). The API owns management data in PostgreSQL, stores sessions in Valkey, and reads customer/call data from the newer eKYC platform.

## Local development

From `ekyc-vidcall-new`:

```powershell
npm ci
docker compose -f compose.yaml -f compose.dev.yaml up -d --build dashboard dashboard-worker
docker compose -f compose.yaml -f compose.dev.yaml exec dashboard node ekyc-dashboard-new/scripts/seed.mjs
```

The seed prints **temporary synthetic** credentials; it is idempotent and creates no real customer identities. Open `http://127.0.0.1:5301/login`. Re-running the seed does not reset account passwords. `npm run lint`, `npm run test:integration`, and `npm run build -w @ekyc/dashboard` verify the JavaScript workspace. The integration tests use `TEST_DATABASE_URL`, not production data.

To verify the running UI and export worker, set `DASHBOARD_TEST_USERNAME` and `DASHBOARD_TEST_PASSWORD` to one of the seed accounts, then run `node ekyc-dashboard-new/scripts/smoke-browser.mjs` and `node ekyc-dashboard-new/scripts/smoke-export.mjs` from the workspace root. The browser check needs local Chrome or `CHROME_PATH`; it checks desktop and mobile navigation. The export check creates a synthetic XLSX job, downloads it, and compares its SHA-256 checksum with the worker record.

The separate worker also enqueues monthly customer/call exports for confirmed applications whose plans include `user` and `agent`. It schedules at midnight WIB on the day after activation (or the 1st when that day would exceed the 28th), covering the preceding monthly interval. A unique schedule key prevents duplicate jobs after restarts, and the worker catches up the current and previous due periods. Longer outages need operator reconciliation against the export manifest.

The Docker development override sets `DASHBOARD_MOCK_EXTERNALS=true`. Without `compose.kong.yaml`, approval, usage, and email are simulations; an approved synthetic application does not have a real Kong consumer or API credential. The Kong overlay sets `DASHBOARD_KONG_MOCK=false`, so new approvals use live local Kong while usage and email remain mocked. Password-reset email is not delivered in this mode. Use the seed password for local login, or test the reset API with an injected mail adapter. OCR and liveness history explicitly return `503` pending their legacy callback contract.

## Kong integration and plan assignment

Gateway administration has its own application at `http://127.0.0.1:5302` with separate credentials; see [Kong Control](../kong-console/README.md). The eKYC dashboard remains responsible for banks, applications, and plans. A plan's `limits` JSON defines `requests_per_minute` and `acl_group`, for example `{"requests_per_minute":60,"acl_group":"plan-standard"}`. When an administrator approves a bank application, the dashboard creates its Kong Consumer and API key, assigns its ACL group, and applies its consumer rate limit. On an application detail page, administrators can assign a different plan; this updates the Kong ACL membership and limit without issuing another key. Changing the limits of a plan already used by a confirmed application is blocked; create a new plan and reassign applications to keep Kong policy in sync.

The local Kong overlay (`compose.kong.yaml`) provides a writable Kong instance and a dedicated console. Without it, the ordinary development profile continues using synthetic Kong provisioning. Applications previously approved in simulation keep their `synthetic-` consumer ID until an admin opens the application and uses **Connect to Kong**; the resulting real API key is displayed once. Browser code never receives the Kong Admin API address or token.

## Bank video-call API through Kong

Each bank integration belongs to a dashboard **application**. An administrator approves that application against a plan with both `user` and `agent` features. The plan's `limits` JSON controls Kong's per-consumer request limit, for example `{"requests_per_minute":60}`. Approval provisions (or configures) a Kong Consumer mapped to that application, enables `key-auth` on the configured partner API route using the `apikey` header, and applies a consumer-scoped `rate-limiting` plugin. The generated API key is shown once in the dashboard approval dialog; deliver it to the bank through a secret manager. Do not put it in frontend JavaScript or customer links.

The bank backend creates a customer and requests a video-call link through:

```http
POST /partner/v1/video-call/users
apikey: <bank-application-api-key>
Idempotency-Key: bank-request-123456
Content-Type: application/json

{
  "customer": {
    "name": "Synthetic Test Customer",
    "id_number": "SYNTHETIC-12345",
    "notes": "Optional initial notes"
  }
}
```

Kong authenticates the key, applies the application's rate limit, and forwards its trusted `X-Consumer-ID` to the dashboard. The dashboard resolves that consumer to its confirmed application and mapped bank/tenant; the caller cannot choose another tenant. Calls with the same `Idempotency-Key` and same customer body return the same customer mapping and deferred customer link. Reusing the key with a changed body returns `409 IDEMPOTENCY_KEY_REUSED`. The response includes `customer_id`, `customer_url`, `expires_in`, and `call_created_when_opened`. The customer is created immediately, but enters the video-call queue only when they open the link and exchange its one-time code. Opening the URL repeatedly does not create additional calls.

For a local mock-only request, use the seeded application's consumer ID (`synthetic-<applicationId>`) as `X-Consumer-ID` when calling `http://127.0.0.1:5301/partner/v1/video-call/users`. The local development profile does not run Kong and its synthetic header is not authentication; it exists only to exercise bank-to-tenant mapping. To test key-auth and rate limiting themselves, configure a real Kong instance, set its private Admin URL/token and API route ID in the dashboard environment, provision an application, then send the returned API key to the Kong-proxied route. In production, make the partner API reachable only through Kong and prevent direct public access to the dashboard service so clients cannot forge Kong identity headers.

Kong provisioning uses the Kong Admin API from the server only. The default `local` rate-limit policy is appropriate for one Kong node; use a secured shared Redis policy for multi-node Kong. Kong, its key-auth/rate-limiting plugins, route ID, and network trust boundary must be verified in staging before production. See the official [Kong Consumer rate-limit guide](https://developer.konghq.com/how-to/add-rate-limiting-for-a-consumer-with-kong-gateway/) and [Key Authentication plugin](https://developer.konghq.com/plugins/key-auth/).

## Ownership and authentication

`/dashboard/api/v1` is the only browser API. Admin, bank, and officer sessions are HTTP-only cookies backed by Valkey; mutations require a session CSRF token and same-origin requests. A bank can only access its own application, customer, call, officer, quota, and document mapping. The login compares bcrypt hashes and rejects an incorrect password. A password change or reset invalidates all existing sessions for that account. The API never returns a password hash or reset token.

The dashboard database migration is `migrations/003_dashboard.js`. New management records use `dashboard_*` tables; `dashboard_id_map`, `dashboard_customer_applications`, and `dashboard_application_agents` map legacy/application ownership onto platform IDs. Importing real legacy records is intentionally **not automatic**: the supplied dashboard SQL is MySQL-style and cannot establish the actual PostgreSQL schema or encryption contract. Do not point a new writer at live legacy tables before schema and ID mapping are validated.

For a read-only schema inventory from a sanitized PostgreSQL copy, set `LEGACY_DATABASE_URL` to a read-only account and run `node ekyc-dashboard-new/scripts/inspect-legacy-schema.mjs`. The command prints table and column metadata, without customer rows. Compare the result with the feature inventory before authoring additive import migrations.

## Production and staging gates

The local Compose setup is a pilot. Before staging, obtain a sanitized legacy PostgreSQL schema and verify every migration against it; provide real Kong, search, mail, encryption, and storage contracts; test each role and legacy URL against the inventory; and validate backups, restores, and single-writer cutover. Real Kong provisioning requires the configured private Admin API, the route ID, compatible key-auth and rate-limiting plugins, and a verified proxy trust boundary. Real OCR/liveness history is also unavailable until its source contract is mapped. Object migration from legacy MinIO to SeaweedFS still needs a checksummed manifest and reconciliation against the real stores. These are release blockers, not silent fallback behavior.

See [the feature inventory](../docs/dashboard-inventory.md) for the route and ownership matrix, and [the source inventory](../docs/dashboard-source-inventory.md) for every legacy controller action, model file, route declaration, and EJS page.
