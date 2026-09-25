# Architecture, data flows and trust boundaries

## Components

| Component | What it is | Where |
| --- | --- | --- |
| Office server | One Node.js 22 process, no npm runtime dependencies (built-ins only: `node:http`, `node:sqlite`, `node:crypto`). Serves the API and the web app's static files. | `server/index.js`, `server/app.js` (request pipeline, route list), `server/routes/*` |
| Database | One SQLite file (`<data>/suds.db`, mode 0600) with WAL. PHI columns (`*_enc`) are encrypted by the application before they reach SQLite. | `server/db.js`, `server/schema.sql` |
| Web app | Vanilla ES modules, no build step, no third-party scripts, strict CSP. | `public/` |
| Scheduled jobs | Hourly housekeeping inside the server process: session expiry, audit/tombstone/log retention, client-record retention, audit verification, scheduled backups, audit anchors, the optional monthly recovery drill. | `server/index.js` (`housekeeping`) |
| Backups | Encrypted snapshots in `<data>/backups`, optionally copied to an offsite directory. | `server/backup.js`, `server/scheduled-backup.js` |
| Audit anchors | Write-once files in `AUDIT_ANCHOR_DIR`, optional syslog. | `server/audit-anchor.js` |
| Recovery drill | A child process started against a throwaway restored copy. | `server/dr-drill.js`, `server/dr-drill-child.js` |
| Reverse proxy (optional) | Caddy / nginx / IIS ARR / a cloud load balancer terminating TLS. | `Caddyfile`, `docker-compose.yml` |
| Identity provider (optional) | The county's OIDC IdP (Entra ID, Okta, Keycloak…). | `server/oidc.js`, `server/routes/oidc.js` |
| Local mode (optional, off by default) | A copy of the server logic running in a browser (sql.js/WebAssembly) that syncs with the office server. | `local/`, `public/local/kernel.js`, `server/routes/sync.js`; policy in `../PLATFORM.md` |
| SUDS on this device | The same browser kernel published as a static site (GitHub Pages); records stay in that browser and never sync. | `scripts/build-static-site.js`, `../WEB_APP.md` |

## Data flow diagram (office server)

```
             county network / VPN                                  county-controlled host
 ┌──────────────────────────┐      TLS 1.2+       ┌────────────────────────────────────────────────────────┐
 │ Staff browser            │ ──────────────────▶ │ TLS proxy (optional) ──▶ SUDS process (Node 22)        │
 │  web app (public/)       │ ◀────────────────── │                          │                             │
 │  session cookie          │  JSON over HTTPS    │   auth.js: session, RBAC, caseload, MFA gate           │
 │  (HttpOnly, Secure,      │                     │   routes/*: every PHI read/write → audit.log           │
 │   SameSite=Strict)       │                     │   crypto.js: AES-256-GCM encrypt/decrypt, HMAC index   │
 └──────────┬───────────────┘                     │        │                                               │
            │ OIDC redirect (optional)            │        ▼                                               │
            ▼                                     │   SQLite suds.db (0600) on an encrypted volume          │
 ┌──────────────────────────┐  back channel:      │     *_enc  ciphertext   *_idx  HMAC   audit_log chain  │
 │ County IdP (OIDC)        │ ◀── code exchange,  │        │                                               │
 │  (no PHI sent to it)     │     discovery, JWKS │        ├─▶ <data>/backups/*.db.enc (AES-256-GCM)       │
 └──────────────────────────┘                     │        │        └─▶ offsite dir (share at second site) │
                                                  │        ├─▶ AUDIT_ANCHOR_DIR (WORM)  ─▶ syslog (opt.)   │
                                                  │        └─▶ <data>/logs (no PHI) ─▶ log collector       │
                                                  └────────────────────────────────────────────────────────┘
   Keys: SUDS_ENCRYPTION_KEY, SUDS_INDEX_KEY, SUDS_BACKUP_KEY — environment (secrets manager) or <data>/keys.json (0600)
```

## Where PHI goes

| Flow | PHI? | Protection | Code |
| --- | --- | --- | --- |
| Browser ⇄ server | Yes | TLS (native or proxy); HSTS; CSRF header required on state-changing requests; `Cache-Control: no-store`; the service worker never caches API responses | `server/http.js` `securityHeaders`, `server/app.js`, `public/sw.js` |
| Server → database | Yes | Identifiers and free text encrypted per field (AES-256-GCM) before write; blind-index HMACs for search | `server/crypto.js`, `server/clients-model.js` |
| Server → backups | Yes | Whole-database AES-256-GCM, key derived from `SUDS_BACKUP_KEY` or the PHI key; each scheduled backup is read back and opened to verify it | `server/backup.js`, `server/scheduled-backup.js` |
| Server → offsite directory | Yes (encrypted file) | Same ciphertext; the directory is never auto-created (an unmounted share is detected) | `server/scheduled-backup.js` |
| Server → audit anchors / syslog | No | Integers, hashes, a timestamp and a host name only | `server/audit-anchor.js` |
| Server → log files | No | Route errors log path and message only; logs 0600, 30-day retention | `server/log.js` |
| Server → metrics / health | No | Aggregate counts; token-gated detail | `server/metrics.js`, `server/routes/app.js` |
| Server ⇄ identity provider | No | Authorization Code + PKCE; ID token RS256 verified against JWKS; issuer/audience/expiry/nonce checked | `server/oidc.js` |
| Identified export / referral | Yes (a disclosure) | Consent / lawful basis checked; accounting-of-disclosure row written | `server/disclosure.js`, `server/exports.js` |
| Server ⇄ local-mode device | Yes | HTTPS; caseload-scoped; audited; revocable/wipeable device registry; off by default | `server/routes/sync.js`, `server/devices.js` |
| Optional outbound: OneNote (Graph), update check, provider pictures | Graph: note text the user imports; others: no | Admin-configured only | `server/importers/`, `server/update.js`, `server/region-pictures.js` |

## Trust boundaries

1. **Network edge → SUDS.** Everything from the network is untrusted: body size caps decided before reading (64 KB unauthenticated, 1 MB JSON, 60 MB file routes behind a session), rate limits (API 600/min per address, sign-in 20 failures/15 min per address, account lockout after 5 failures), CSRF header, strict CSP (`server/app.js`, `server/http.js`).
2. **Session → data.** Every route requires a session that has passed the MFA gate, then a permission from the role matrix (`server/auth.js` `PERMS`), then caseload scoping for client data. Denials are audited (`authz.denied`).
3. **Application → database file.** The database holds ciphertext for PHI; the keys are outside it. A copy of `suds.db` without the keys reveals no names, but does reveal equality between blind-indexed values (documented in `../HIPAA.md`, risk register).
4. **Database administrator → audit evidence.** Someone with the database and the index key could rebuild the audit chain. Anchors on write-once storage outside the host (`AUDIT_ANCHOR_DIR`) and the log collector are the boundary that person cannot cross ([LOGGING-AND-AUDIT.md](LOGGING-AND-AUDIT.md)).
5. **Office server → device (local mode).** A device holds a caseload and its keys in the browser profile; the county decides whether local mode is allowed (off by default) and on which devices ([../PLATFORM.md](../PLATFORM.md)).
6. **Recovery drill.** The drill's child process gets a temporary directory and the keys over IPC; it is never given the live database's path (`server/dr-drill.js` `runChild`).

## Deployment shapes

County VM (systemd), container (Dockerfile, docker-compose with a read-only root filesystem), or the county's own cloud tenant; a warm standby for site failure. See `../DEPLOYMENT.md`, "County hosting options and single-site risk". There is no vendor-hosted (SaaS) SUDS: the county is the operator.
