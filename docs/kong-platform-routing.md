# Local platform API routing

Kong Control (`http://127.0.0.1:5302`) manages the Services and Routes below. Kong's public proxy is `http://127.0.0.1:58001`.

| Service | Upstream | Route | Public path |
| --- | --- | --- | --- |
| ekyc-master-api | http://master:8080 | ekyc-master-v1 | /api/v1 |
| ekyc-videocall-api | http://calls:5030 | ekyc-videocall-v1 | /v1 |
| ekyc-videocall-api | http://calls:5030 | ekyc-videocall-v2 | /api/v2 |
| ekyc-videocall-api | http://calls:5030 | ekyc-videocall-realtime | /socket.io |

All methods under these prefixes forward to the same paths on their backends (`strip_path=false`). This covers the implemented customer/document/provider APIs, agent and customer sessions, queue operations, integration links, call lifecycle, recording metadata, and Socket.IO WebSocket traffic. The call backend supports WebSocket transport only. Internal callback paths under `/internal` have no public Kong route.

Authentication continues to run in the backends: agent/customer tokens, partner gateway credentials, signed integration assertions, and recording/internal signatures. The existing `/partner/v1` bank integration route retains its API key, ACL, and per-consumer rate-limit policy. The new session endpoints do not require a bank API key in addition to their existing authentication.

Apply the mapping to a running local console using the credentials configured in `.env`:

```powershell
node --env-file=.env scripts/kong-assign-platform.mjs
```

The script signs into local Kong Control, uses its authenticated API with CSRF protection, and logs out afterward. It creates missing objects and updates only the named platform objects. Repeated runs reuse the same IDs. Conflicting upstreams or route assignments stop with an explicit error. Docker's Kong bootstrap invokes the same provisioning logic on startup.

Examples through Kong:

```text
GET  http://127.0.0.1:58001/api/v1/users
POST http://127.0.0.1:58001/api/v2/sessions/agent
GET  http://127.0.0.1:58001/v1/calls/queues
WS   ws://127.0.0.1:58001/socket.io/?EIO=4&transport=websocket
```

Application authentication is required where applicable. Browser clients must also use an origin allowed by the existing application configuration. Registering Kong Routes does not change the frontend's configured API origin.

## Routing audit

Run the complete HTTP route audit and the WebSocket/console check:

```powershell
node --env-file=.env scripts/kong-audit-platform.mjs
node --env-file=.env scripts/kong-verify-platform.mjs
```

The audit derives endpoints from the actual Express route registries, including aliases and dynamically generated provider routes. It checks live Kong service assignments, method coverage, preserved paths, upstream responses to invalid credentials or empty inputs, private-path exclusion, partner API-key rejection, and browser CORS. It does not create calls, modify customers, invoke providers with valid credentials, or test recording completion. Results are saved in `.local/kong-api-audit.json` without credentials or customer data.

Local results on 2026-10-07: all 71 master and 39 video-call public method/path combinations forwarded successfully; all 11 health/internal combinations remained unmapped; CORS, Socket.IO WebSocket, and console visibility passed. Bank key-auth and ACL apply to `/partner/v1`, with two consumer-scoped rate-limit policies installed. Full bank-plan enforcement and authenticated business workflows are separate tests.

The current frontend Nginx and Vite proxies still target master/calls directly. Requests explicitly sent to port 58001 traverse Kong; existing frontend requests do not automatically traverse Kong. This setup establishes gateway availability, not exclusive gateway enforcement.

## Live bank-plan test

On local Docker only, run this PowerShell command from the workspace root:

```powershell
Get-Content -Raw scripts/test-dashboard-kong-live.mjs | docker compose -f compose.yaml -f compose.dev.yaml -f compose.kong.yaml exec -T -w /app/scripts dashboard node --input-type=module
```

The test creates a temporary admin, bank, two plans, and an application. Dashboard API approval provisions a real Kong consumer, key, ACL membership, and rate limit. It verifies repeated approval, missing/invalid-key rejection, a two-request limit with HTTP 429 on the third request, HTTP 403 without ACL membership, and a plan change to 100 requests per minute while preserving the key. Empty partner request bodies reach bank-scoped validation without creating customer records or calls. Cleanup removes only these fixtures and their Kong memberships, retaining unrelated ACL groups. All eight checks passed locally on 2026-10-07.

Database-backed Kong workers need time to pick up policy changes. The test allows 6.5 seconds after each policy change; an immediate request after approval can temporarily return ACL HTTP 403 before propagation completes.

## Inactive bank application subscriptions

An admin can open **Banks → Applications → application details → Nonaktifkan layanan**. This sets the assigned application to `inactive`, removes that consumer's ACL memberships and blocks its partner API access. Customer records, call history, the shared plan, consumer and API key are retained. **Aktifkan kembali** restores the current plan's ACL/rate policy using the same key; the bank itself must be active. Another bank or application using the same plan is unaffected.

The CSRF-protected admin API is `POST /dashboard/api/v1/applications/:id/status` with `{ "status": "inactive" }` or `{ "status": "confirmed" }`. Only approved or inactive applications can transition; waiting/rejected requests still use approval. Transitions are audited and repeat requests are idempotent. Kong failures return an error rather than reporting a successful state change. Basic agent/customer sessions and ongoing calls are not terminated by this subscription control.

Validation: 23 dashboard feature integration tests passed; the live Kong test now has 10 passing checks including HTTP 403 for an inactive key and successful restoration with the same key. Desktop/mobile button tests passed using `node --env-file=.env scripts/test-dashboard-admin-browser.mjs --status-only`. Temporary fixtures were removed.
