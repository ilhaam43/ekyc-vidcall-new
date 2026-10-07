# Implementation status and release gates

The replacement is an additive JavaScript workspace. Existing `infinid-*` source directories remain intact. The new database uses `platform_*` tables so the importer can preserve old identifiers and ciphertext without running the historical MySQL exports against PostgreSQL.

## Implemented

- Agent and customer browser routes with a scoped customer grant exchange, consent, waiting view, Jitsi External API view, reconnect state refresh, and agent queue/decision controls.
- Agent sessions, refresh rotation and revocation; signed gateway traffic; tenant-scoped queries; versioned call endpoints and `/v1` adapters for core calls.
- PostgreSQL call and recording state, transactionally claimed queues, five reserved recorder slots, server-confirmed customer-join trigger for Jibri, decision/outbox workflow, and SeaweedFS upload with post-upload SHA-256 verification.
- Synthetic fixture script, generated legacy source inventory, and a database-backed lifecycle integration test.
- Base Compose stack, official pinned Jitsi release files, and a five-Jibri pilot overlay that passes `docker compose config` validation.
- Opt-in partner integration with signed individual-agent iframe links, call-bound customer links, separate basic/integration queues, and an embedded frontend build profile. API and database integration tests cover replay, tenant isolation, duplicate queue requests, and competing agents.

## Unfinished gates

- **No production cutover.** The actual PostgreSQL schema and migration history, tenant mappings, active provider contracts, encryption service staging access, DNS/TLS, and mobile/partner client changes have not been supplied or validated. The old MySQL exports are not a valid substitute.
- End-to-end Jitsi/Prosody/Jibri admission and webhook behavior, five simultaneous recorded calls for 30 minutes, Linux media networking/TURN, and iOS Safari/Android Chrome have not been exercised. The custom Prosody guard must be integration tested against the pinned image before real customers are admitted.
- The master API is a partial replacement. Legacy integrations are adapter stubs requiring staging contracts and credentials; remaining reference, document, actor, OTP, callback, quota and retention behavior needs parity testing. An explicit unavailable error is preferable to a false success.
- Historical PostgreSQL import and object migration need real schema mappings and source storage access. Do not enable two writers for a tenant.
- Container digest pinning, TLS termination, backup/restore rehearsal, vulnerability and secret scans, and CI release gates remain.

`npm run release:check` enforces only local configuration and database preconditions. Passing it does not assert the manual integration and load gates above.
