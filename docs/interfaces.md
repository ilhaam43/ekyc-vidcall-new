# Call and customer interfaces

All browser tokens are short-lived bearer tokens issued by the call service. Agent refresh tokens and customer refresh tokens use separate HttpOnly cookies. Partner requests use a trusted gateway secret plus `X-Application-Id`; the gateway must authenticate its upstream client and set that tenant ID itself. Internal service endpoints require `X-Internal-Secret`. Jibri webhooks use a private-network URL containing a dedicated random secret. Neither internal service ports nor the Jibri webhook route should be exposed by the public proxy.

| Operation | Endpoint | Credential |
|---|---|---|
| Agent login/refresh/logout | `POST /api/v2/sessions/agent`, `/refresh`, `/logout` | Password, refresh cookie, bearer respectively |
| Partner agent launch/exchange | `POST /api/v2/integrations/agent-links`, `/api/v2/sessions/agent/link` | Backend RS256 assertion, then one-time five-minute code |
| Partner queue/customer link | `POST /api/v2/integrations/queue-links` | Backend RS256 assertion; existing customer ID and external request ID |
| Issue/exchange customer grant | `POST /api/v2/customer-grants`, `/api/v2/sessions/customer` | Trusted gateway, one-time five-minute grant |
| Register call | `POST /api/v2/calls` | Gateway, `Idempotency-Key` |
| Queue/claim | `GET /v1/calls/queues`, `POST /v1/calls/start` | Agent bearer |
| Direct call claim | `POST /api/v2/calls/:id/claim` | Agent bearer; session flow and tenant checked |
| State/consent/admission/heartbeat | `GET /api/v2/calls/:id`, `POST /api/v2/calls/:id/{consent,admission,heartbeat}` | Agent/customer bearer scoped to call |
| Decision/cancel/recording state | `POST /api/v2/calls/:id/{decision,cancel}`, `GET /api/v2/calls/:id/recording` | Assigned agent; customer may cancel own call |
| Trusted recording events | `POST /internal/recordings/{events,stored}` | HMAC timestamp and body signature |
| Jitsi participant join confirmation | `POST /internal/jitsi/participant-joined` | Private Prosody plugin plus internal service secret; starts recording only after customer joins |
| Master completion | `POST /internal/verifications` | Internal service secret |

`POST /api/v2/calls/:id/admission` also supports native Jitsi Meet SDK clients. It returns `server_url`, `room`, `jwt`, `token_expires_at`, and `role` alongside the existing browser fields. The SDK must use the returned server, room, and JWT together. The response has `Cache-Control: no-store`; request fresh admission when a client reconnects after token expiry. See [mobile SDK integration](mobile-jitsi-sdk.md).

The call snapshot states are `waiting`, `assigned`, `preparing_recording`, `ringing`, `active`, `completing`, `completed`, `canceled`, `missed`, and `failed`. A verification outcome is either `verified` or `not_verified` and is only committed after the recording object is stored with matching SHA-256 and byte length. Socket.IO emits `queue.change`, `call.start`, `call.end`, `call.missed`, and `call.state`; clients authenticate with an access token in the Socket.IO handshake and refresh state through HTTP after reconnect.

Existing `/v1` call routes and `/api/v1` customer routes have core adapters. Clients must migrate away from customer-ID-only sockets and any unsupervised room admission. The legacy event name alone does not authorize a client.

The optional [embedded partner flow](embedded-integration.md) uses the same call lifecycle but separate `basic` and `integration` session sources. Integration customer sessions are additionally bound to one `call_id`, including refresh, HTTP access, Jitsi admission, and realtime delivery.
