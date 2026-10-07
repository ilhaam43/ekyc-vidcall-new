# Kong Control

This is a standalone Kong Gateway management application at `http://127.0.0.1:5302`. It has its own login and session. It is not served by the eKYC management dashboard. The browser talks only to the Kong Control API; the Kong Admin API stays on the private Docker network.

The management UI follows Konga's navigation pattern: Dashboard, Gateway Info, Kong resources, then application operations. Dashboard shows live connection counters and resource counts for the selected node; Info shows node details. The sidebar, status panels, resource tables, detail view, and responsive mobile layout use a Konga-inspired visual design. This is an independent implementation for Kong 3.9, rather than Konga's archived Kong 1.x application.

The console manages Services, Routes, Consumers, Plugins, Upstreams, Certificates, CA Certificates, and SNIs using the Kong Admin API. Consumer details include API keys and ACL group membership; Upstream details include Targets. Every create and edit action uses labeled fields. Plugin creation follows a categorized catalog like Konga, then opens a typed settings form; plugin settings use typed name/value rows, so administrators can configure additional Kong plugins without writing JSON. Nested consumer credentials and upstream targets support create, edit, and delete. API key values are returned once at creation and are never returned by list endpoints. The eKYC partner route, its Service, its key-auth/ACL plugins, and mapped consumers' ACL/rate-limit settings are controlled by the bank application workflow; the console lets administrators inspect these resources and rotate their keys.

The Operations section adds Konga-style management workflows:

Plugin creation lists only plugins installed on the selected gateway. Its forms load the gateway's plugin schemas and support nested records, primitive lists, and header maps. Consumer detail pages include a Plugins tab, with scoped creation and editing. Route forms include header matching, SNIs, source/destination addresses, regex priority, path handling, HTTPS redirects, and buffering settings when supported by the gateway schema. Service forms include client certificates and TLS settings; Upstream forms include fallback hashing and active/passive health checks. Secret fields left blank while editing are retained server-side; nested configuration changes preserve untouched values. Complex plugin values beyond these field types are identified explicitly.

To verify the local CRUD workflows, run `node --env-file=.env kong-console/scripts/smoke-crud.mjs` from the repository root. It creates synthetic resources against the local gateway and removes only those resources afterward. It exercises Service and Route creation, scoped plugin creation/editing, Upstream health checks, Target updates, and credential edits. `scripts/smoke-browser.mjs` covers desktop/mobile navigation, forms, sessions, user revocation, and snapshots.

| Feature | Behavior |
| --- | --- |
| Nodes | Switch between the local Kong and explicitly allowlisted HTTPS Admin API origins. Tokens are encrypted in Valkey and never returned to the browser. |
| Users | Create admin/viewer accounts, disable or delete them, and revoke their active sessions. The environment account remains available. |
| Snapshots | Capture encrypted gateway configuration and credentials; preview and restore to an **empty** selected node after typing its name. A failed restore attempts to remove newly created objects. |
| Health | Check the selected node, its database connection, and upstream target health. |
| Notifications | Monitor node transitions every minute and send HTTPS/Slack webhook and/or SMTP email alerts when configured. |
| Consumer import | Import up to 500 Consumers from CSV or an allowlisted HTTPS API. Existing usernames are skipped. |
| Credentials | Manage Key Auth, ACL, Basic Auth, JWT, and HMAC credentials on Consumers. |

This is a modern Kong 3.9 console inspired by Konga's feature set, not a copy of Konga's legacy Kong 1.x code. It does not import directly from arbitrary databases, manage Enterprise-only objects, or restore over a populated node. Basic Auth passwords are hashed in Kong's Admin API output and cannot be restored as plaintext; a preview blocks such snapshots rather than silently creating invalid credentials. A restore must be tested on a separate empty node before production use. A snapshot contains credentials and certificate keys, so protect `KONG_CONSOLE_DATA_KEY`, keep Valkey backups private, and rotate the key through a planned re-encryption process.

For additional nodes, set `KONG_CONSOLE_ALLOWED_NODE_ORIGINS` to a comma-separated list of HTTPS origins. For Slack or another webhook, set `KONG_CONSOLE_ALLOWED_WEBHOOK_ORIGINS`. API import uses `KONG_CONSOLE_ALLOWED_IMPORT_ORIGINS` and an optional server-side `KONG_CONSOLE_IMPORT_API_TOKEN`. Email alerts require `KONG_CONSOLE_SMTP_URL` and `KONG_CONSOLE_SMTP_FROM`. In production, set a stable `KONG_CONSOLE_DATA_KEY` of at least 32 characters independently of the login password.

For local development, set `KONG_CONSOLE_USERNAME`, a unique `KONG_CONSOLE_PASSWORD` of at least 16 characters, and `KONG_DB_PASSWORD` in `.env`, then run:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml -f compose.kong.yaml up -d --build kong-console dashboard
```

This starts a separate PostgreSQL-backed Kong Gateway and bootstraps the local `/partner/v1` route. The gateway proxy is at `http://127.0.0.1:58001`; the Admin API is not published on the host. The console is at `http://127.0.0.1:5302`. The eKYC dashboard remains at `http://127.0.0.1:5301` and assigns API plans to bank applications. With this overlay, Kong provisioning is live while other local dashboard integrations remain mocked. Without the overlay, Kong Control reports an unavailable gateway and the eKYC dashboard uses synthetic Kong provisioning.

Each eKYC plan defines `limits.requests_per_minute` and `limits.acl_group`. Approving a bank application creates the Kong Consumer and API key, adds it to the ACL group, and applies the per-consumer rate limit. Reassigning a confirmed application to another plan updates ACL membership and its rate limit without rotating the existing key. Plan limits already used by confirmed applications are immutable; create another plan and reassign those applications.

Production requires HTTPS for Kong Control, a private Kong Admin API, separately managed credentials, backup/restore of Kong's PostgreSQL database, and validation of the bank application path through Kong's proxy. The local OSS gateway relies on network isolation; it does not expose Kong Enterprise RBAC.

