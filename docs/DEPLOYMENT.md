# Deployment guide

> **No terminal?** See [INSTALL.md](INSTALL.md): double-click a launcher and finish setup in the browser. This document covers the environment-variable / service deployment that IT departments typically prefer. Both can be mixed: environment variables override anything the wizard wrote to `data/server.json` and `data/keys.json`.

## Requirements

* Node.js 22.13 or newer (uses the built-in `node:sqlite` module). No other runtime dependencies.
* A host with an **encrypted disk** for the data directory (BitLocker, LUKS, or a cloud disk with KMS-backed encryption).
* TLS: either a certificate/key pair for the app itself, or a TLS-terminating reverse proxy (Caddy, nginx, IIS ARR, a cloud load balancer). Never expose plain HTTP beyond localhost.

### Single instance only

SUDS is one process, one SQLite database file: there is no clustering, no shared session store, and no distributed rate limiter — sessions, login lockout counters and the API rate limiter all live in that one process's memory. This is a deliberate scope, not a temporary gap: a second process against the same data directory does not add capacity, it risks corrupting the database, so it is refused outright (`server/instance-lock.js`, a pidfile at `data/.suds.lock`) rather than merely discouraged in a document nobody reads before scaling a container to more replicas. A process that exits cleanly releases the lock; a lock left behind by one that crashed is detected as stale (its pid is no longer running) and taken over automatically, so a crash never leaves a data directory permanently unable to start.

This covers *one program's* worth of staff — dozens, not hundreds. If a deployment is outgrowing a single box, the answer is a bigger box (this is close to zero-overhead per request) or a separate SUDS install per county/program, never multiple instances load-balanced in front of one database.

## 1. Configuration

Copy `.env.example` to `.env` and set:

| Variable | Required | Notes |
| --- | --- | --- |
| `SUDS_ENV=production` | yes | Enforces keys and secure cookies |
| `SUDS_ENCRYPTION_KEY` | yes* | 64 hex chars. `npm run gen-key`. Encrypts all PHI fields. **Losing it makes PHI unrecoverable.** |
| `SUDS_INDEX_KEY` | yes* | 64 hex chars. Used for searchable blind indexes. |

\* If not set, the first production start generates both keys into `data/keys.json` (mode 0600) so the browser wizard can run; the wizard and Administration → System offer a key backup download.
| `SUDS_DB_PATH` / `SUDS_DATA_DIR` | no | Defaults to `./data/suds.db`. Put on the encrypted volume. |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | recommended | If unset, run behind a TLS proxy. |
| `TRUST_PROXY=1` | when proxied | Use the `X-Forwarded-For` header for audit IPs and rate limiting. Only set behind a proxy you control. |
| `HOST`, `PORT` | no | Default `127.0.0.1:8080`. Use `HOST=0.0.0.0` only inside a container / behind a firewall. |
| `SESSION_IDLE_MINUTES` | no | Default 15 (auto sign-out). |
| `SESSION_ABSOLUTE_HOURS` | no | Default 12. |
| `MFA_REQUIRED_ROLES` | no | Default `admin,supervisor`. Set to `admin,supervisor,clinician,navigator,finance` to require MFA for everyone (recommended). |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_ONENOTE_USER` | optional | For direct OneNote import via Microsoft Graph. See IMPORTS.md. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | optional | Single sign-on against a county identity provider. See "Single sign-on" below. |
| `OIDC_LABEL` | no | Button text on the login page. Default "Sign in with county SSO". |
| `UPDATE_FEED_URL` | optional | Lets Administration check for a newer release. See "Upgrades" below. |
| `METRICS_TOKEN`, `LOG_FORMAT` | optional | Prometheus metrics and JSON logging for an existing monitoring stack. See "Monitoring and logs" below. |
| `AUDIT_RETENTION_DAYS` | no | Default 2555 (7 years). |
| `SUDS_ADMIN_USERNAME`, `SUDS_ADMIN_PASSWORD` | first run only | Initial admin. Otherwise a temporary password is printed once. |
| `SUDS_SKIP_SETUP=1` | no | Never show the browser setup wizard (it is already skipped when keys come from the environment). |

Store the keys in a secrets manager (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault) or at minimum in a root-only file; back them up separately from the database.

### Single sign-on (OIDC)

Optional, and additive: SUDS's own username/password + MFA login keeps working either way, and OIDC never creates or promotes an account by itself. It only ever signs in to a SUDS account an administrator has already linked to the identity provider — the flow that satisfies a county AD/Entra ID/Okta/Keycloak requirement without SUDS holding its own copy of the county's directory.

1. Register a confidential web application (Authorization Code + PKCE) with the identity provider. Redirect URI: `https://<your SUDS address>/api/auth/oidc/callback`.
2. Set `OIDC_ISSUER` (the provider's issuer URL — SUDS reads `{issuer}/.well-known/openid-configuration`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` (must exactly match what was registered), and optionally `OIDC_LABEL`.
3. Restart SUDS. The login page now offers an SSO button above the password form.
4. For each staff member who should use it: Administration → Users → edit their account → **Single sign-on identity**, and paste the `sub` claim the identity provider issues for them (most providers show this in the user's profile, or it can be read from a test token). Leave it blank for anyone who should keep using a SUDS password.

The ID token is verified against the provider's published signing keys (RS256 only — symmetric and unsigned tokens are refused outright), and its issuer, audience, expiry and nonce are all checked before anyone is signed in. Once signed in, an OIDC session behaves exactly like a password one: the same idle/absolute timeouts, the same MFA requirement if the account's role requires it, and the same audit trail (`auth.oidc.login`, `auth.oidc.failed`). SSO is never offered in local/offline mode — a device with no route to the office server has no route to the identity provider either.

## 2. Run

### systemd (Linux)

```ini
[Unit]
Description=SUDS SUD Navigator Services Tracker
After=network.target

[Service]
User=suds
WorkingDirectory=/opt/suds
EnvironmentFile=/etc/suds/suds.env
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning server/index.js
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/suds/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Docker

```bash
docker compose up -d
```

`docker-compose.yml` runs the app on an internal network and a Caddy proxy that obtains a certificate automatically for `SUDS_DOMAIN`. Mount `/data` on an encrypted volume.

### Windows Server

Run under a service wrapper (NSSM or `sc.exe`) with the same environment variables, and terminate TLS with IIS (ARR reverse proxy to `127.0.0.1:8080`). Set `X-Forwarded-For` so audit logs record client IPs.

### Files written by the setup wizard

| File | Contents |
| --- | --- |
| `data/server.json` | host (`127.0.0.1` or `0.0.0.0`), port, `tls` (`none` / `selfsigned`), `trustProxy`, `setupComplete` |
| `data/keys.json` | encryption and index keys (only when not supplied by the environment) |
| `data/certs/suds.crt`, `suds.key` | self-signed ECDSA P-256 certificate covering localhost, the hostname and LAN IPs (825 days) |

Network settings can be changed at runtime under Administration → Network & devices; the listener switches without a restart.

## 3. First login

1. Sign in as `admin` with the initial password; you must change it immediately.
2. Enroll MFA (Profile → Multi-factor authentication) — required for admins.
3. Administration → Settings: set the organization name, county, privacy officer contact, and confirm **Caseload restriction = On**.
4. Administration → Users: create staff accounts. Share temporary passwords in person or by phone, never by email.
5. Budget → add funding sources and budget lines; Resource Directory → enter referral partners.

## 4. Backups

```bash
npm run backup -- /secure/backups        # encrypted, consistent snapshot (VACUUM INTO + AES-256-GCM)
node scripts/backup.js --restore /secure/backups/suds-<stamp>.db.enc /opt/suds/data/suds.db
```

Schedule nightly with cron / Task Scheduler and copy off-host, or turn on the built-in schedule instead: Administration → **Settings → Scheduled backups**, set an interval in hours and (optionally) an offsite directory — a mounted network share or drive path SUDS can write to directly. It runs from the same hourly housekeeping timer as audit and tombstone retention (`server/index.js`), keeps the configured number of local copies (oldest pruned first), and records the result under Administration → **System & backups**, including whether the offsite copy succeeded. An unreachable offsite path never loses the local backup that already succeeded — it is reported as a status, not a failure of the backup itself. Test restores quarterly either way. Backups are encrypted with a key derived from `SUDS_ENCRYPTION_KEY`, so a backup without the key is useless to an attacker — and to you.

An administrator can also restore without a shell, from Administration → **System & backups → Restore from a backup**: it reports what the file contains before changing anything, requires the administrator's password, and keeps the replaced database as `suds.db.before-restore-<stamp>` so a mistaken restore is recoverable. The file format is identical either way — both the manual and scheduled paths use `server/backup.js`.

### Rotating the encryption key

```bash
systemctl stop suds
npm run backup -- /secure/backups                       # take one first; this is not reversible
NEW_ENCRYPTION_KEY=$(npm run -s gen-key) npm run rotate-key
# set SUDS_ENCRYPTION_KEY to the new value, then:
systemctl start suds
```

The columns to re-encrypt are discovered from the database, not from a list in the script, so every encrypted field — including completed county forms and their attachments — is covered.

## 4a. Monitoring and logs

`GET /api/health` needs no authentication and returns `{ ok, version, schema_version, database, database_bytes, disk_free_bytes, uptime_seconds }`. It answers 503 when the database cannot be read or free disk drops below 100 MB, so it works directly as a liveness and readiness probe (the Docker image uses it).

For a fuller picture in an existing monitoring stack, set `METRICS_TOKEN` and point Prometheus (or anything that scrapes Prometheus-format text) at `GET /api/metrics` with that value as its `bearer_token`. Off (404) until that variable is set; once set, every request needs `Authorization: Bearer <token>` or it is refused — a scraper has no way to sign in interactively, so this is its own credential, not the usual session. Reports uptime, active users/sessions, client and audit-log row counts, synced-device count, database file size and free disk — aggregate operational numbers, never PHI (`server/metrics.js`).

Console output is also written to `data/logs/suds-<date>.log` (mode 0600), rolled at 8 MB and kept 30 days, in the same human-readable format as the console by default. Set `LOG_FORMAT=json` to switch both the console and that file to newline-delimited JSON (`{time, level, msg}` per line) for a log collector (Loki, CloudWatch, an ELK stack) that expects structured input rather than parsing free text. Log lines never contain PHI either way: route errors record the path and the error message only. Audit retention (`AUDIT_RETENTION_DAYS`, default 2555) and tombstone retention (`TOMBSTONE_RETENTION_DAYS`, default 180) are enforced on the same hourly pass; a device offline longer than the tombstone horizon is told to resync from scratch rather than silently keeping deleted records.

## 5. Upgrades

For a git-checkout install, `scripts/update.js` does the sequence below as one command, refusing to run with uncommitted changes and stopping (without restarting the service) if the tests fail after pulling. It needs `git` and network access to the repository, and its `npm ci` step installs the *development* dependencies (the bundler used to rebuild the on-device kernel, the browser used by the test suite); the running server still needs none of them. A packaged (zip) install is updated by hand as INSTALL.md describes:

```bash
node scripts/update.js --check                                          # what would change; touches nothing
node scripts/update.js --apply                                          # back up, pull, reinstall, rebuild, test
node scripts/update.js --apply --restart-cmd "systemctl restart suds"   # and restart once it succeeds
```

Equivalently, by hand:

```bash
npm run backup -- /secure/backups     # first, always
git pull && npm ci && npm test && systemctl restart suds
```

A packaged (non-git, zip) or Docker install has no code for `scripts/update.js` to pull — take a backup, then replace the application files (Docker: pull the new image tag) with the next release and restart; `data/` is never touched by either path.

Administration → System & backups can also check whether a newer release exists (`GET /api/admin/update/check`) — off by default, since it means an outbound call to whatever `UPDATE_FEED_URL` is set to (typically `https://api.github.com/repos/<owner>/<repo>/releases/latest`, or an internal mirror for an air-gapped county). It only ever runs when an administrator clicks the button; nothing polls automatically, and it never applies anything itself — applying is always the explicit `scripts/update.js --apply` or manual step above.

Schema migrations run automatically at startup (`server/db.js`), each inside a transaction with its version stamp and with `PRAGMA foreign_key_check` before it commits, so a crash midway cannot leave a half-applied schema. Before the first migration of a start-up runs, SUDS takes its own consistent snapshot of the database into `data/pre-migration/suds.db.v<version>.<timestamp>.db` (the last five are kept) and logs where it went; if the snapshot cannot be written — no disk space, no permission — the upgrade stops rather than proceeding unprotected. That snapshot is a convenience, not a substitute for the off-host backup above: it sits on the same disk. SUDS refuses to open a database written by a *newer* build rather than running against a schema it does not understand — so a rollback means restoring the backup that matches the version you are rolling back to.

## 6. Hardening checklist

- [ ] TLS 1.2+ only; HSTS enabled (automatic when the app serves TLS).
- [ ] Data directory permissions `0700`, database `0600`, owned by the service user.
- [ ] Host firewall allows only 443 from the county network / VPN.
- [ ] OS disk encryption enabled; screen lock policies on workstations.
- [ ] MFA required for all roles (`MFA_REQUIRED_ROLES`); grace period (`MFA_GRACE_DAYS`, default 14) set to what your policy allows.
- [ ] Keys in a secrets manager; key custodian documented.
- [ ] Backups scheduled, encrypted, off-host, restore tested.
- [ ] Audit log reviewed monthly (Administration → Audit log → Break-glass events, Access denials, Exports).
- [ ] Business Associate Agreements in place with any hosting provider and with Pocket AI / Microsoft if PHI transits their services.
