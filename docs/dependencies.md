# Legacy dependency decisions

The source manifests contain version ranges, so the exact installed legacy versions require their lockfiles. This register distinguishes old versions from packages whose use should end; it does not label every old package deprecated.

| Legacy dependency | Current disposition |
|---|---|
| `react@^16`, `react-dom@^16`, `react-scripts@^3`, CRACO and LESS override | Replaced with React 19, Vite 8 and direct CSS. Create React App is sunset. |
| `antd@^4`, `@ant-design/icons@^4` | Replaced with supported v6 icon/UI packages. |
| `express@^4`, `body-parser` | Replaced with Express 5 and built-in JSON parsing; route patterns reviewed. |
| `knex@^0.20`/`^2.5`, Objection 2/3 | Replaced with one pinned Knex layer and explicit service-owned queries. |
| `mysql@^2.17` | Removed from the new runtime. Historical MySQL SQL is retained as reference only; the target uses PostgreSQL. |
| `redis@^2.8` | Replaced with Valkey and a current client/Socket.IO adapter. |
| `request@^2.88`, old Axios | Replaced with bounded native `fetch`; provider adapters validate outputs. |
| `uuid@^3` | Replaced with `crypto.randomUUID()`. |
| `node-apn@^3` | Replaced with an HTTP/2 APNs sender. |
| `minio@^7` | Replaced with an object adapter using SeaweedFS's S3-compatible protocol on self-hosted storage. |
| `xss-clean@^0.1` | Removed; output escaping, body validation, authorization and headers belong at their specific boundaries. |
| `@hapi/joi`, `joi`, `express-validation` | Consolidated into shared JSON Schema and Ajv validation. |
| `@tropos/kong-admin-api-client` | Gateway management remains an external dependency; no credential-bearing management client is bundled. |
| `dd-trace`, `winston`, `node-schedule` | Not copied automatically. Structured runtime logs and explicit jobs are implemented per service as needed; production telemetry remains a release task. |

The new lockfile is committed to the replacement directory. Its current install completed with zero npm audit findings; this is a point-in-time result, not a substitute for ongoing CI scanning.
