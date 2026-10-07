# Embedded agent and partner customer integration

This is an opt-in flow. The ordinary agent password login, `/v1` calls, and built-in `/customer` page remain available. Never put a platform password, gateway secret, or the partner's JWT private key in the browser. All integration URLs and public keys are configured per tenant on the server.

## Try it on localhost

Start the local Compose stack with `compose.dev.yaml` as described in the root README. The synthetic demo portal starts with Compose; no separate npm process is needed. Open the index to see the current synthetic IDs and links:

<http://127.0.0.1:5174/>

The links use `/staff/<staff-id>` and `/customer/<customer-id>`. The server checks each ID against the synthetic demo tenant. Opening the staff link only opens the agent queue; it does not create a call. The home page's **Generate customer URL** button calls the local demo API to create a five-minute, single-use customer link. Creating the link does not create a call or consume quota. The call enters the queue when the customer opens the link and the customer page exchanges its code. Open the staff portal first, then generate and open the customer link in a second browser profile. The agent sees the new queue entry, clicks **Panggil**, then **Masuk ruang video**. The customer checks camera and microphone, accepts recording consent, and joins. Jibri starts recording after the customer joins. Finish the call from the agent workspace and check recording status there. A fresh generated link is needed for each customer attempt; the signing key remains on the demo server and is never embedded in the browser.

For partner backends, use `POST /api/v2/integrations/customer-links` with a short-lived RS256 assertion in `Authorization: Bearer ...`, scope `customer:link`, and JSON body `{ "customer_id": "...", "external_request_id": "..." }`. The API validates the tenant and customer, then returns `customer_url` and `expires_in`; it does not enqueue the customer. When the customer page exchanges the code at `POST /api/v2/sessions/customer`, the platform creates the integration call transactionally and publishes the queue update. Use a new external request ID for each intended attempt. The existing `POST /api/v2/integrations/queue-links` remains available for integrations that intentionally queue immediately when generating a link.

This uses the built-in customer page as a stand-in for the partner's page. For a real integration test, replace it with the partner customer frontend and the same-origin staff proxy. If the browser blocks the local Jitsi certificate, open `https://meet.localtest.me/` once and accept the development certificate before joining.

## Provision a tenant

Create the platform tenant, customers, and active agents through the existing provisioning process. The partner keeps the RSA private key; the platform receives only its PEM public key. Set the following values in the deployment secret environment, then run the command once per external staff identity. The script also activates the tenant integration configuration.

```text
INTEGRATION_ISSUER=partner-staff-backend
INTEGRATION_AUDIENCE=ekyc-integration
INTEGRATION_PUBLIC_KEY_FILE=/run/secrets/partner-sso-public.pem
INTEGRATION_STAFF_ORIGIN=https://staff.bank.example
INTEGRATION_AGENT_LAUNCH_URL=https://staff.bank.example/ekyc-agent/integrations/agent
INTEGRATION_CUSTOMER_ENTRY_URL=https://customer.bank.example/video-verification
```

```sh
node --env-file=.env scripts/configure-integration.mjs TENANT_UUID EXTERNAL_STAFF_ID AGENT_UUID
```

The external staff ID maps to exactly one existing agent in that tenant. Configure all four staff members individually. To rotate the public key, update the configured file and rerun the script; coordinate the rotation with the partner because in-flight assertions signed by the old key will stop working. Start the optional `embedded-frontend` Compose service with `docker compose --profile integration up -d --build embedded-frontend`. It builds the same React code with `/ekyc-agent/` as its asset/API prefix; the ordinary frontend remains on `/`. Use [the Nginx example](../infra/partner-embed.nginx.example.conf) for the staff and customer origin proxies. The parent staff page embeds `<iframe src="AGENT_URL" allow="camera; microphone; fullscreen; display-capture" />`. Its Content Security Policy must allow the iframe and self-hosted Jitsi domain. Test camera and microphone in the actual target browsers.

## Server-to-server requests

The partner signs RS256 JWT assertions with `iss`, `aud`, `sub`, `tenant_id`, `scope`, `jti`, `iat`, and `exp`; lifetime must be at most 90 seconds. Each `jti` can be used once. `sub` is the external staff ID for an agent launch and a stable backend service name for queue creation. The configured issuer, audience, key, and tenant must match. All calls below use HTTPS outside localhost development.

For a Node.js partner backend, create a fresh assertion for **each** request; never reuse the JWT on retry:

```js
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
const assertion = jwt.sign({ tenant_id: tenantId, scope: 'agent:launch', call_id: optionalCallId }, privateKeyFromSecretManager, {
  algorithm: 'RS256', issuer: 'partner-staff-backend', audience: 'ekyc-integration',
  subject: externalStaffId, jwtid: randomUUID(), expiresIn: '60s',
});
```

To open an agent iframe, send `POST /api/v2/integrations/agent-links` with JSON `{ "assertion": "SIGNED_JWT" }` and `scope: "agent:launch"`. An optional signed `call_id` claim highlights that waiting call in the queue or resumes a call already assigned to the same agent. The response contains `data.agent_url` and `data.expires_in: 300`. The staff portal sets that URL as the iframe source. The iframe exchanges the fragment code through `POST /api/v2/sessions/agent/link`, clears the fragment, and uses a normal agent session. The code cannot be reused. Opening the iframe never claims a waiting call; the agent must press **Panggil** first. Normal recording-capacity checks apply when the call is claimed.

To create a queue link, send `POST /api/v2/integrations/queue-links` with `Authorization: Bearer SIGNED_JWT`, `scope: "queue:create"`, and JSON:

```json
{ "customer_id": "EXISTING_CUSTOMER_UUID", "external_request_id": "bank-request-unique-id" }
```

The response contains `data.call_id`, `data.state`, `data.customer_url`, and `data.expires_in: 300`. The partner sends `customer_url` to its customer using its own notification mechanism. The URL points only to the configured customer page and carries a one-time code in its fragment. Repeating the same request ID with a new assertion returns the same active call and a fresh code; a different request ID cannot take over an already queued customer. The platform's existing call-registration quota rule applies once when that call is created.

The two flows are isolated by session source. An integration agent sees and claims integration calls only; a password-login agent sees and claims basic calls only. A single agent identity still cannot hold two active calls across the flows. A customer who is already queued in one flow cannot be registered into the other until that call is terminal.

## Partner customer page

On page load, read `code` from `location.hash`, immediately remove the fragment with `history.replaceState`, and exchange it using `POST /ekyc-api/api/v2/sessions/customer` with JSON `{ "code": "..." }`. Store the returned access token in memory. The response includes the bound `call_id`. Never send the code or access token to analytics or logging. Route all further requests through the same-origin `/ekyc-api/` proxy, sending `Authorization: Bearer ACCESS_TOKEN`. Refresh with `POST /ekyc-api/api/v2/sessions/refresh` and `{ "role": "customer" }`; the refresh cookie is HttpOnly and limited to the proxy path.

Read `GET /ekyc-api/api/v2/calls/:call_id` or `GET /ekyc-api/api/v2/calls/current`; poll or use authenticated Socket.IO for changes. Before joining, obtain camera/microphone permission and explicit recording consent, then call `POST /ekyc-api/api/v2/calls/:call_id/consent` with `{ "accepted": true, "version": "recording-v1" }`. Wait for `ringing`; call `POST /ekyc-api/api/v2/calls/:call_id/admission` and use the returned Jitsi domain, room, and short-lived JWT with the self-hosted Jitsi External API. Send `POST /ekyc-api/api/v2/calls/:call_id/heartbeat` every 15 seconds while active. On reconnect, refresh the session and fetch the persisted call state. Do not display a successful verification until state is `completed`; recording must first be stored. The customer token cannot access another call, even for the same customer ID.

The partner's backend and staff site must not log launch URLs or customer-link fragments. Production requires real HTTPS domains, an RSA public key and identity map, proxy rules, and a Jitsi/Jibri staging test with two-way media and a playable stored recording.
