# Tenant cutover and recovery runbook

This is a procedure to rehearse after the source PostgreSQL schema and migration history are obtained. It must not be used as a production cutover checklist until the evidence fields are completed.

1. Export a sanitized schema and migration list from the real PostgreSQL database. Map each legacy tenant, agent, actor, customer, document, call, recording, quota and audit column to a `platform_*` field. Keep UUIDs, password hashes and ciphertext byte-for-byte. Verify the external encryption service can decrypt sampled imported values. Never run the historical MySQL exports on this database.
2. Take a consistent source database snapshot and object-storage inventory. Record counts and SHA-256 manifests by tenant and object key. Restore both into an isolated rehearsal environment and compare counts and checksums before writing migration code for the source schema.
3. Run additive migrations and an importer with resumable checkpoints. Stage objects in SeaweedFS under opaque keys; store source-key to destination-key mappings and metadata, then verify full-stream SHA-256 and playback. Migration should be repeatable without duplicate rows or objects.
4. Select one tenant, stop new legacy admissions, drain active calls, then freeze legacy writes for that tenant. Take a final delta snapshot, import it, reconcile the tenant and issue new client credentials. Only then route its browser, mobile and partner traffic to the replacement.
5. Run the recorded call workflow and restoration drill in staging. Prove five simultaneous 30-minute recordings and one excess queued call. Verify each object can be fetched, all five checksum values match, and no verification completes before upload.
6. Monitor queue depth, missing Jibri heartbeats, outbox retries, incomplete recordings, storage integrity and provider callbacks. Reopen legacy writes only through an audited rollback procedure that accounts for any new-platform writes made since the freeze. DNS reversal alone loses those writes.

Current state: steps 1–6 are unexecuted for production. The supplied repositories contain old MySQL exports but no authoritative PostgreSQL schema snapshot. No customer data has been copied, no tenant traffic has been switched, and no retention deletion job is enabled. Every tenant needs an explicit retention value and approved policy before release.
