# Admin dashboard validation — 7 October 2026 (WIB)

The local admin dashboard was tested with unique synthetic fixtures. Existing bank/customer records and passwords were preserved. Temporary accounts, banks, tenants, plans, applications, sessions, and live export files were removed afterward.

## Results

| Validation | Result |
| --- | --- |
| Existing dashboard integration suite | 5 passed |
| Expanded management/platform integration suite | 22 passed |
| Export formatting, monthly scheduling and Kong plan unit checks | 4 passed |
| Live browser/worker checks | 60 passed, zero reported errors |
| Desktop/mobile pages | 22 pages per viewport; no horizontal page overflow |
| ESLint | Passed |
| Dashboard production build and Docker rebuild | Passed |

## Feature coverage

| Area | Checks and limits |
| --- | --- |
| Authentication | Wrong password, unauthenticated requests, CSRF, forged origin, logout, expiry, password change/reset, session revocation, single-use reset token |
| Permissions | Ordinary admin cannot create superadmins or manage global links; bank role cannot access another bank's applications, customers, agents, calls, documents or exports |
| Banks | Creation, tenant mapping, list/detail/update, validation, deactivation, active-application deletion guard |
| Plans | Creation/update/delete, invalid limits, protected deletion, policy selection; live UI editing changes the rate limit |
| Applications | Request/edit/approve/reject, rejected/confirmed state guards, plan reassignment, Kong failure recovery and repeated approval |
| Accounts/officers | Create/list/update/deactivate, password policy, hidden password hashes, self-disable prevention |
| Agents | Application/tenant mapping, list/update/deactivate, password change revokes platform sessions |
| Links | Create/edit/delete; insecure URLs rejected |
| Customers/documents | Master backend contract with real HTTP in isolated tests; listing, detail, soft deletion, authorized document listing/download, history preserved |
| Calls | History/detail, recording metadata, private notification/registration fields withheld; synthetic terminal calls used |
| Quotas/storage | Bank-scoped quota rows and storage counts |
| Exports | Request validation, pending download rejection, CSV/XLSX generation, checksum retry recovery, authenticated downloads, monthly scheduling; live Docker worker writes to SeaweedFS and download checksums match |
| Navigation | Desktop 1440×900 and mobile 390×844, mobile menu, selected legacy redirects, create-bank form, plan-edit form and logout |

The HTTP workflow tests use isolated PostgreSQL (`*_test`), a real master HTTP server, and explicit storage/email/Kong/usage test adapters. The live browser tests use the running dashboard and real export worker/SeaweedFS. The separate live bank-plan test documented in `kong-platform-routing.md` already validated real Kong consumer creation, API keys, ACL rejection and HTTP 429 rate limiting; that test is not included in the 31 tests above.

## Bug found and fixed

An existing plan could not be edited: the form attempted to parse a saved policy object as JSON text and also serialized edited text twice. The editor now initializes policy text once and preserves the text while typing. The local dashboard container was rebuilt, and the live browser test saved a policy of 100 requests per minute successfully.

## Unavailable/external features

- OCR and liveness history intentionally return `503 *_HISTORY_NOT_MIGRATED`. The UI displays an unavailable message; these are not accepted as working history integrations.
- Local usage results and reset-email delivery are mocked. Real Elasticsearch reporting and email delivery need staging services.
- These checks do not certify production migrations, backup/restore, real identity-provider calls, every possible input or concurrency scenario, or a new end-to-end Jitsi/Jibri recorded call. UI page coverage also does not mean every management operation was submitted through a browser form; full CRUD coverage above includes API tests.

## Reproduce

From the platform root:

```powershell
node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.integration.config.js tests/integration/dashboard.test.js tests/integration/dashboard-features.test.js
npx vitest run tests/unit/dashboard-schedule.test.js tests/unit/dashboard-xlsx.test.js tests/unit/kong-plan.test.js
node --env-file=.env scripts/test-dashboard-admin-browser.mjs
npm run lint -- --quiet
npm run build -w @ekyc/dashboard
```

The browser script requires local Chrome, the live local Docker services, `TEST_DATABASE_URL` pointing at the local test database, and the local storage credentials from `.env`. It explicitly targets the live local `ekyc` database only for uniquely named synthetic fixtures, and removes them on exit. Its detailed report and screenshots are in `.local/dashboard-admin-test/`.
