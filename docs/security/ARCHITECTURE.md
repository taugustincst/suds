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
| County view (released in 1.18.0; office server only) | On a programme's server: the signed, aggregate **county submission file** (Ed25519 county signing key). On a county's server (which may hold no client data at all): the programmes it accepts, their public keys, the imported submissions and the combined view. | `server/county.js`, `server/routes/county.js`, `../COUNTY-VIEW.md` |
| County-entered figures (released in 1.20.0; office server only) | On a county's server: a grantee not on SUDS registered with no key, and its aggregate figures typed in or imported from a CSV by the county's `county:manage` staff, stored as unsigned county submissions (`source = 'county_entered'`) with the source document encrypted, counted by the combined view's own rules but always outranked by a signed file, and marked in every view, file and read-API answer. | `server/county-entry.js`, `server/routes/county.js`, `../COUNTY-VIEW.md` (*County-entered figures*) |
| County connection (released in 1.18.0; optional, off by default on both sides) | The programme's server posts the same signed file to the county's server over HTTPS with a county-issued connection token, and reads what the county expects; the county's own systems read the combined view with expiring read tokens. | `server/county-connect.js` (county side), `server/county-connect-client.js` (programme side), `server/routes/county-connect.js` |
| County publication releases (released in 1.21.0; office server only) | On a county's server: County view › Publish screens the combined figures for a period with the programme's own small-cell method, audited against every programme's own release, and records what was published, append-only (`county_publications`, migration 61). | `server/county-publication.js`, `server/county-publication-audit.js`, `server/sdc.js`, `../COUNTY-VIEW.md` (*Publication*) |
| Field devices (released in 1.21.0; off by default) | A synced device marked *field* receives and may change only its worker's own recent caseload, with contact, intake, legal and clinical columns blank; the office reads the scope from its own record of the device on every pull and push (migration 62). | `server/field-scope.js`, `server/routes/sync.js`, `server/rules/push.js`, `../PLATFORM.md` (*Field devices*) |
| Passkeys (released in 1.19.0; office server only) | WebAuthn sign-in, second step and signature/approval confirmation, verified with `node:crypto`; the device's authenticator matches the finger and signs, and the server stores public keys and signed evidence only. | `server/webauthn.js`, `server/passkeys.js`, `server/routes/passkeys.js`, `../FINGERPRINT.md` |
| Authenticator allow-list (released in 1.21.0; office server only, off by default) | Passkeys only on listed authenticator models, each proven by its attestation (`packed`, `fido-u2f`, `tpm`, `android-key`) against the roots of a FIDO Metadata Service file the administrator loads; no outbound call (migration 63). | `server/attestation.js`, `server/authenticator-allowlist.js`, `../FINGERPRINT.md` (*Authenticator allow-list*) |
| SUDS Server (released in 1.18.0; optional) | The Linux installer for Ubuntu 24.04 / RHEL 9 (LUKS data disk, pinned Node and Caddy, sandboxed systemd unit on 127.0.0.1, keys as root-only credentials, firewall), and a weekly compliance check that runs as root, separately from the SUDS service, and writes a report signed with its own key. | `deploy/linux/`, `scripts/compliance-check.js`, `server/compliance-report.js`, `server/compliance-rules.js`, `../SELF-HOSTING.md` |

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
   AUDIT_ANCHOR_DIR is write-once only when the county points it at WORM storage; unset, anchors go to <data>/audit-anchors.
```

**The county view and the county connection (1.18.0; aggregates only, office servers only):**

```
 programme (CBO) server                                                  county's SUDS server (may hold no client data)
 ┌────────────────────────────────┐                                      ┌──────────────────────────────────────────────┐
 │ Settlement outcomes (aggregate)│  county submission file, signed      │ /api/county/submissions  (import, a person)  │
 │  └─▶ county.js payloadFrom     │  with the CBO's Ed25519 key          │   checks: county code, registered key,       │
 │      allow-list, signFile ─────┼─ by email / upload (default) ──────▶ │   signature, allow-list, period              │
 │                                │                                      │                                              │
 │ county-connect-client.js ──────┼─ HTTPS, Bearer sudscc_… (optional) ▶ │ /api/county-connect/v1/submissions, /status  │
 │  (https only, no redirects,    │ ◀── receipt, expected periods ────── │   (the same import path; 256 KB cap; limits) │
 │   15 s, no private addresses)  │                                      │ /api/county-connect/v1/combined, /programs   │
 └────────────────────────────────┘                                      │   ◀── county BI tools, Bearer sudscr_… (exp.)│
                                                                         └──────────────────────────────────────────────┘
```

From 1.20.0 the county's server has a third way in, with no programme involved: its own staff enter or import the
figures of a grantee not on SUDS (`/api/county/programmes/:id/entries`, `…/entries/import`; `county:manage`). They
are stored unsigned and marked `county_entered`, so nothing downstream can take them for a signed file, and a signed
file for the same period always counts over them.

## Where PHI goes

| Flow | PHI? | Protection | Code |
| --- | --- | --- | --- |
| Browser ⇄ server | Yes | TLS (native or proxy); HSTS; CSRF header required on state-changing requests; `Cache-Control: no-store` on every API answer and HTML page (the app's own code files and icons, which hold no PHI, are `no-cache` with an ETag, 1.14.0); JSON answers of 1 kB or more compressed when the browser accepts it, which is not a BREACH risk because the session cookie is `SameSite=Strict` ([PERFORMANCE.md](../PERFORMANCE.md)); the service worker never caches API responses | `server/http.js` `securityHeaders`, `sendJsonTo`, `sendFile`, `server/app.js`, `public/sw.js` |
| Server → database | Yes | Identifiers and free text encrypted per field (AES-256-GCM) before write; blind-index HMACs for search | `server/crypto.js`, `server/clients-model.js` |
| Server → backups | Yes | Whole-database AES-256-GCM, key derived from `SUDS_BACKUP_KEY` or the PHI key; each scheduled backup is read back and opened to verify it | `server/backup.js`, `server/scheduled-backup.js` |
| Server → offsite directory | Yes (encrypted file) | Same ciphertext; the directory is never auto-created (an unmounted share is detected) | `server/scheduled-backup.js` |
| Server → audit anchors / syslog | No | Integers, hashes, a timestamp and a host name only | `server/audit-anchor.js` |
| Server → log files | No | Route errors log path and message only; logs 0600, 30-day retention | `server/log.js` |
| Server → metrics / health | No | Aggregate counts; token-gated detail | `server/metrics.js`, `server/routes/app.js` |
| Server ⇄ identity provider | No | Authorization Code + PKCE; ID token RS256 verified against JWKS; issuer/audience/expiry/nonce checked | `server/oidc.js` |
| Identified export / referral | Yes (a disclosure) | Consent / lawful basis checked; accounting-of-disclosure row written | `server/disclosure.js`, `server/exports.js` |
| Server ⇄ local-mode device | Yes | HTTPS; scoped to what the user may see (the whole programme under the 1.16.0 role defaults, a caseload after a deny of `clients:all`; on a field device, from 1.21.0, only the worker's own recent caseload with contact, intake, legal and clinical columns blank); audited; revocable/wipeable device registry; off by default | `server/routes/sync.js`, `server/devices.js` |
| Optional outbound: AI documentation copilot (off by default) | Yes: the session text a worker gives for one client, with that client's known identifiers replaced | Only after an administrator records the BAA/QSOA and switches it on; HTTPS from the server (never the browser); key only in the server environment; audited per call, never the text; monthly cap | `server/ai-copilot.js`, `server/routes/ai.js`, `docs/AI-COPILOT.md` |
| Optional outbound: OneNote (Graph), update check, provider pictures | Graph: note text the user imports; others: no | Admin-configured only | `server/importers/`, `server/update.js`, `server/region-pictures.js` |
| County submission file (1.18.0) | No: aggregate counts and money for the funds a person ticks, no client, code, name, date of birth or single event | An allow-list checked when made and on import; signed (Ed25519); addressed to one county code; audited without the figures; carried by a person by default | `server/county.js`, `server/routes/county.js` |
| County publication release (1.21.0) | No: county totals screened for small cells, programme names and labels; money and counts not of people exact | Prepared and reviewed before publishing (the SHA-256 reviewed must match); `checkAggregate` refuses any other key; overlapping periods refused; recorded append-only; files and the read API's `/publications` need `county:view` (files also `export:read`); audited without figures | `server/county-publication.js`, `server/routes/county.js`, `server/routes/county-connect.js` |
| Optional outbound: county connection, programme → county (1.18.0; off by default) | No: the same signed file; back, the county's receipt and expected periods | HTTPS only, certificate checked against the county's host, no redirects, one 15-second deadline, answer read to 64 KB, public addresses through `server/outbound.js` (private ones only with `SUDS_COUNTY_ALLOW_PRIVATE=1`, never loopback, link-local or metadata); the token stored encrypted and never shown again; every send logged and audited | `server/county-connect-client.js` |
| County staff entering a grantee's figures on a county's server (1.20.0) | No: aggregate figures from a grantee's report, with the document they came from | `county:manage` only; the signed files' allow-list, strict numbers and text rules; a CSV bounded (5,000 rows, 256 KB, 12 periods) and read only for the programme named; the source document encrypted (`source_ref_enc`) and shown to `county:manage` only; refusals throttled per person; audited without figures or typed text (`county.entry.*`) | `server/county-entry.js`, `server/routes/county.js` |
| Inbound on a county's server: county connection and read API (1.18.0; off by default) | No: aggregate submissions in, the combined view out (from 1.20.0 with county-entered figures marked `source: "county_entered"`, and `entered=exclude` to leave them out) | 404 while off; connection tokens per programme and expiring read tokens, SHA-256 at rest, revocable; a file still verifies under the calling programme's registered key; rate limits per token, per address and globally; `TRUST_PROXY=1` required behind a proxy; audited without figures | `server/county-connect.js`, `server/routes/county-connect.js` |
| Browser authenticator ⇄ server: passkeys (1.19.0) | No, and no biometric data: a public key at enrolment, then signatures over server challenges | HTTPS and the server's own host (`WEBAUTHN_RP_ID`); origin checked, `crossOrigin` refused, user verification required; challenges hashed, single-use, two minutes, bound to purpose, user and session (and, for signing, to a statement of exactly what is signed); the evidence stored encrypted | `server/webauthn.js`, `server/passkeys.js` |
| SUDS Server compliance check → report files (1.18.0) | No: settings, file modes, service state and results; no records | Runs as root from its own timer, reads a private copy of the database, signs with a key the SUDS service never holds; reports created new, never through a path the `suds` user controls | `scripts/compliance-check.js`, `server/compliance-report.js` |

## Trust boundaries

1. **Network edge → SUDS.** Everything from the network is untrusted: body size caps decided before reading (64 KB unauthenticated, 1 MB JSON, 60 MB file routes behind a session), rate limits (API 600/min per address, sign-in 20 failures/15 min per address, account lockout after 5 failures), CSRF header, strict CSP (`server/app.js`, `server/http.js`).
2. **Session → data.** Every route requires a session that has passed the MFA gate, then a permission from the role matrix (`server/auth.js` `PERMS`), then caseload scoping for client data for anyone without `clients:all` (since 1.16.0 only a person an administrator has denied it; finance and read-only never open client records). Denials are audited (`authz.denied`).
3. **Application → database file.** The database holds ciphertext for PHI; the keys are outside it. A copy of `suds.db` without the keys reveals no names, but does reveal equality between blind-indexed values (documented in `../HIPAA.md`, risk register).
4. **Database administrator → audit evidence.** Someone with the database and the index key could rebuild the audit chain. Anchors on write-once storage outside the host (`AUDIT_ANCHOR_DIR`) and the log collector are the boundary that person cannot cross ([LOGGING-AND-AUDIT.md](LOGGING-AND-AUDIT.md)).
5. **Office server → device (local mode).** A device holds what its user may see — the whole programme under the 1.16.0 role defaults, or a caseload for a person denied `clients:all` — and its keys in the browser profile; from 1.21.0 a field device holds only its worker's own recent caseload without contact, intake, legal or clinical details, a scope the office enforces from its own record of the device (the scope limits what the device holds, not what its user's account may reach elsewhere); the county decides whether local mode is allowed (off by default) and on which devices ([../PLATFORM.md](../PLATFORM.md)).
6. **Recovery drill.** The drill's child process gets a temporary directory and the keys over IPC; it is never given the live database's path (`server/dr-drill.js` `runChild`).
7. **Programme ⇄ county (1.18.0).** The county's server trusts a submission only for its signature under a key it registered for that programme out of band, never for the channel: a connection token only says which programme is calling, and a file signed by another programme's key is refused with the same words as an unknown key. The programme's server treats the county as untrusted input: its county code, name and list of outstanding periods are checked before anything is stored, signed or sent, and a changed county code stops all sending until an administrator confirms it ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *The trust model*). Figures the county's own staff enter for a grantee not on SUDS (1.20.0) carry no signature and claim none: they are trusted only as far as the county's staff and the source document they name, marked as county-entered wherever shown, never counted as received on the county connection, and outranked by any signed file for the same period (*County-entered figures*, decisions D1–D5).
8. **Authenticator → server (1.19.0).** The server trusts a passkey assertion only for its signature over a challenge it issued, from its own origin and relying party, with user verification; a counter that goes backwards disables the passkey. With the allow-list on (1.21.0), it trusts an authenticator's model only for an attestation that chains to the roots the FIDO Metadata Service lists for it, from a file whose signature chains to the embedded FIDO root. It never sees the finger ([../FINGERPRINT.md](../FINGERPRINT.md)).
9. **SUDS service → compliance evidence (SUDS Server, 1.18.0).** The SUDS service cannot sign a compliance report about itself: the check's signing key is root-only and the check never follows a path the `suds` user controls ([../SELF-HOSTING.md](../SELF-HOSTING.md), *The compliance check*).

## Deployment shapes

County VM (systemd), SUDS Server (`deploy/linux/install.sh` on Ubuntu 24.04 or RHEL 9, 1.18.0; tested against a fake root with stub system commands and run for real on Ubuntu 24.04 in a systemd container, whose findings 1.20.0 fixes; a run on a real VM, and any run on RHEL 9, still owed), container (Dockerfile, docker-compose with a read-only root filesystem), or the county's own cloud tenant; a warm standby for site failure. A county that only receives its programmes' county submissions can run a county-only install with no client data ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *A county-only install*). See `../DEPLOYMENT.md`, "County hosting options and single-site risk". There is no vendor-hosted (SaaS) SUDS: the county is the operator.
