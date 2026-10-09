# Platform ports and deployment domains

The complete platform needs one domain name with subdomains. Separate domain
purchases are not required. The ports below describe the current local Compose
configuration, including the development, Kong, and local Jitsi overlays.

## Local ports

| Service | Host port | Container port | Purpose |
|---|---:|---:|---|
| Agent and customer frontend | 5173/TCP | 8080/TCP | Agent workspace and built-in customer page |
| Embedded integration demo | 5174/TCP | 5174/TCP | Local partner staff/customer simulation |
| eKYC admin dashboard | 5301/TCP | 5301/TCP | Bank, application, agent, quota, and call administration |
| Kong control panel | 5302/TCP | 5302/TCP | Gateway management UI |
| Kong API gateway | 58001/TCP | 8000/TCP | Bank integration API traffic |
| Master backend | 58080/TCP | 8080/TCP | Direct development access |
| Video-call backend | 55030/TCP | 5030/TCP | Direct development access |
| Storage management UI | 58082/TCP | 8080/TCP | Authenticated object browser |
| SeaweedFS S3 API | 58333/TCP | 8333/TCP | Authenticated object API |
| PostgreSQL | 55432/TCP | 5432/TCP | Platform database |
| Valkey | 56379/TCP | 6379/TCP | Sessions, presence, and coordination |
| Jitsi HTTPS | 9443/TCP | 8443/TCP | Jitsi website, SDK signaling, and External API |
| Jitsi HTTP | 58000/TCP | 8000/TCP | Local HTTP endpoint |
| Jitsi Videobridge media | 10000/UDP | 10000/UDP | Video and audio transport |
| Jicofo diagnostics | 8888/TCP | 8888/TCP | Local diagnostics |
| Videobridge diagnostics | 58081/TCP | 8080/TCP | Local diagnostics |

Most development host ports bind to `127.0.0.1`. Jitsi HTTPS and its UDP media
port have separate bindings. These values are configuration, not a guarantee
that every container is currently running.

Kong Admin API uses port `8001` inside Docker and has no host publication in
the Kong overlay. Jibri control uses `2222`/`2223` internally. Prosody and the
Kong database also communicate over private Docker networks. They do not need
public domains.

## Local access URLs

| Application | URL |
|---|---|
| Agent frontend | <http://127.0.0.1:5173> |
| Built-in customer page | <http://127.0.0.1:5173/customer> |
| Embedded demo | <http://127.0.0.1:5174> |
| Admin dashboard | <http://127.0.0.1:5301> |
| Kong control panel | <http://127.0.0.1:5302> |
| Kong gateway | <http://127.0.0.1:58001> |
| Storage management UI | <http://127.0.0.1:58082> |
| SeaweedFS S3 endpoint | <http://127.0.0.1:58333> |
| Jitsi | <https://meet.localtest.me:9443> |

Customer access requires an API-generated link or a valid customer session.
Opening `/customer` alone does not create an authorized verification session.

## Deployment domains

Six subdomains give each application a clear entry point:

| Example subdomain | Purpose | Reverse-proxy destination |
|---|---|---|
| `verify.example.com` | Agent frontend and customer `/customer` page | Frontend on container port 8080 |
| `admin.example.com` | eKYC admin dashboard | Dashboard on container port 5301 |
| `api.example.com` | Bank integration APIs | Kong proxy on container port 8000 |
| `meet.example.com` | Jitsi web, External API, and mobile SDK server | Jitsi web, with its signaling paths |
| `gateway.example.com` | Kong control panel | Kong Console on container port 5302 |
| `storage.example.com` | Authenticated storage management UI | Storage UI on container port 8080 |

These are recommended deployment names, not DNS entries already provisioned.
Replace `example.com` with the chosen domain. The subdomains can resolve to
the same server; the reverse proxy selects the destination by hostname.
Storage and gateway management can instead be limited to a VPN or private
network. The S3 object API does not need a public domain unless an authorized
external client specifically requires access.

Master and video-call backends do not need separate public domains. The API
gateway and frontend proxy handle their browser and partner routes. Preserve
Socket.IO WebSocket upgrades when configuring the reverse proxy.

For an embedded integration, the partner staff site proxies the embedded
agent page, API, and Socket.IO paths under its configured origin. The partner
owns its customer frontend domain. The local demo on port 5174 is a simulation
and is not a production partner portal.

## Public network ports

| Port | Purpose |
|---|---|
| 443/TCP | HTTPS websites, APIs, and Jitsi signaling |
| 80/TCP | HTTP-to-HTTPS redirects and HTTP certificate validation, if used |
| 10000/UDP | Jitsi media traffic to the Videobridge |

Keep direct backend, database, Valkey, Kong Admin API, Jibri control, and
diagnostic ports private. A shared server requires a reverse proxy or load
balancer to own public port 443 and route all HTTPS hostnames; the current
local Jitsi binding must be adjusted for that deployment.

TLS certificates must cover the chosen hostnames. A wildcard certificate or
individual certificates can be used with the deployment's certificate manager.

## Jitsi media address and TURN

For Docker Desktop, set `JVB_LOCAL_ADVERTISE_IPS` to the current host
Wi-Fi/Ethernet IPv4 address. Update it after changing networks. Jibri also
needs the private Docker candidate. Loopback alone did not connect browser
media in the recorded-call test.

For the Linux pilot, set `JVB_ADVERTISE_IPS` to the externally reachable media
address and make the UDP media port reachable through the firewall/NAT.

TURN is not configured in the current stack. Adding it for restrictive
networks requires configured TURN/TURNS listener ports and a bounded relay
port range. `turn.example.com` can be a seventh subdomain of the same domain;
its exact ports depend on the TURN deployment.

## Configuration references

- `compose.yaml`: application services and shared infrastructure.
- `compose.dev.yaml`: development host port publications.
- `compose.kong.yaml`: local Kong gateway and private Admin API.
- `infra/jitsi/upstream/docker-compose.yml`: Jitsi service ports.
- `infra/jitsi/compose.pilot.yaml`: recording and authenticated admission.
- `infra/jitsi/compose.local.yaml`: Docker Desktop media overrides.
- `.env.example`: configuration template; real secrets belong in injected
  environment variables or a secret manager.

This document is based on the local configuration reviewed on 9 October 2026
(Asia/Jakarta). Deployment DNS, TLS, TURN, and reverse-proxy provisioning remain
separate setup steps.
