# Infinid dashboard migration inventory

Static source review of `infinid-dashboard` identified 16 controllers, 30 model files, 53 EJS pages, the route files under `routes/`, scheduled export code, and external Kong, Elasticsearch, MinIO, email, and encryption dependencies. This matrix distinguishes features running in the local replacement from features requiring a real legacy or staging contract. The supplied MySQL-style SQL is not a PostgreSQL import baseline.

| Legacy route / feature | Legacy controller or model | Replacement route / owner | Status |
| --- | --- | --- | --- |
| `/login`, `/logout`, `/forgot-password`, `/reset-password`, `/profile/change-password` | Dashboard, ForgotPassword, Profile; Admin, Officer | React routes; `/dashboard/api/v1/login`, `logout`, `password/reset/*`, `profile/password`; dashboard API | Implemented locally. Wrong passwords rejected; reset delivery mocked locally. |
| `/`, `/dashboard` | Dashboard; Bank, Application, Agent, User | Dashboard summary | Implemented locally from platform and dashboard tables. |
| `/banks`, `/banks/create`, `/banks/@:username`, `/banks/@:username/edit` | Bank; Bank, BankSetting | React legacy URLs; `/banks` management API | Implemented for new management records. Real legacy import pending schema. |
| `/banks/@:username/accounts/*`, `/accounts/*` | Admin, Bank; Admin, BankAccount | React legacy URLs; `/accounts` API | Implemented, role restricted. Password hashes from real legacy data not imported yet. |
| `/plans/*` | Plan; Plan, PlanService, ApplicationRatelimit | React legacy URLs; `/plans` API | Implemented for new plan metadata. Kong service/rate-limit provisioning blocked pending validated contract. |
| `/app-requests`, `/banks/@:username/apps/*`, `/apps/*` | Application; Application, Plan | React legacy URLs; `/applications` and `/app-requests` API | Request/edit/reject/approve implemented for synthetic local data. Real Kong approval fails closed. |
| `/officers/*`, bank officers | Officer; Officer | React legacy URLs; `/officers` API | Implemented, tenant scoped. |
| `.../agents/*` | Agent; Agent | React legacy URLs; `/agents` API; platform agent tables | Implemented for mapped applications; revokes platform sessions on credential change. |
| `.../users/*`, customer export | User; User, Actor, Address, Occupation, AccountPurpose, Fund, FundSource, Income, BusinessSector, PostalCode, UserOccupation, UserLogActivity, VerificationStatus | React legacy URLs; `/customers` API and export worker; master eKYC API | Mapped customers can be listed/read and soft deleted. Full legacy demographics/reference-data import awaits actual schema and encryption service. |
| Customer documents / downloads | Document; Document, ExportedDocument | `/customers/:id/documents`, `/documents/:id/download`; master and SeaweedFS | Implemented for mapped platform documents; MinIO import pending manifest. |
| `.../calls/*` | Call; Call, CallHistory, Transaction | React legacy URLs; `/calls` API; video-call platform tables | Implemented for mapped platform calls. Legacy history import awaits actual schema. |
| `.../liveness/*`, `.../ocr/*` | Liveness, OCR | React legacy URLs; explicit `503` API | Not migrated. Real callback and data contract required; no false empty result. |
| `/quota`, `.../usage`, usage JSON/XLSX | Quota, Application; ApplicationRatelimit | `/quota`, `/usage`, `/exports`; platform quota and search adapter | Quota implemented from platform. Local usage synthetic; real Elasticsearch contract and report reconciliation pending. |
| Scheduled/customer/document exports | Application, User, Liveness, OCR; ExportedDocument | Durable `dashboard_exports` worker, CSV/XLSX and S3-compatible storage | Customer/call export and idempotent monthly scheduling implemented locally with retry state. Other report types await source contracts. |
| `/links/*` | Link; Link | React legacy URLs; `/links` API | Implemented. |
| Bank storage settings, secret rotation | Bank; BankSetting | `/storage` API | Read-only platform storage summary implemented. Legacy key rotation and MinIO data movement are blocked until real storage contract and checksum manifest are available. |

Legacy route trees under `routes/admin.js`, `routes/resources/bank.js`, `officer.js`, `app.js`, `agent.js`, `user.js`, `call.js`, `ocr.js`, `liveness.js`, `quota.js`, `account.js`, `plan.js`, and `link.js` are represented by the React legacy paths or explicit unavailable responses above. Legacy `GET /banks/recreate-all-storage-accounts` mutated external state and is retired rather than carried over as a GET. Legacy placeholder pages and public download are not treated as working features.

The account/officer login path in the old Passport strategy logged an incorrect password and still completed authentication. The new session API requires `bcrypt.compare` to succeed and includes an integration regression test. The newer API adds same-origin CSRF checks, scoped bank access, audit records, session revocation, and private server-side integration credentials.

Local mocks deliberately do not represent real Kong approval, email delivery, encryption, usage totals, or object migration. Before cutover: capture the actual PostgreSQL schema, enumerate old IDs against `dashboard_id_map`, test encrypted-field readability, reconcile customer/call/report counts, reconcile object SHA-256 checksums, verify backup and restore, and pilot one bank without concurrent old/new writers.
