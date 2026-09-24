# Deployment guide

> **First install?** See [INSTALL.md](INSTALL.md): start the server and finish setup in the browser wizard. The platform policy — web app on the office server as the system of record; the native apps and launchers were removed in 1.9.3 — is [PLATFORM.md](PLATFORM.md). For the governance side of adopting SUDS (code owner, pilot, release cadence, drills, staffing), see [ADOPTION.md](ADOPTION.md). This document covers the environment-variable / service deployment that IT departments typically prefer. Both can be mixed: environment variables override anything the wizard wrote to `data/server.json` and `data/keys.json`.

## Requirements

* Node.js 22.13 or newer (uses the built-in `node:sqlite` module). No other runtime dependencies.
* A host with an **encrypted disk** for the data directory (BitLocker, LUKS, or a cloud disk with KMS-backed encryption).
* TLS: either a certificate/key pair for the app itself, or a TLS-terminating reverse proxy (Caddy, nginx, IIS ARR, a cloud load balancer). Never expose plain HTTP beyond localhost.

### Node.js support and the move to 24

SUDS is pinned to Node 22 (`.nvmrc`, the Dockerfile, CI). Node 22 leaves maintenance at the end of April 2027, and `node:sqlite` is still marked experimental in both 22 and 24, so its API can change between releases. The plan:

1. **Now:** CI runs the full `npm test` suite on Node 24 in an advisory job (`node24` in `.github/workflows/ci.yml`, `continue-on-error`). A failure there is a warning to fix, not a blocked release. `.nvmrc` stays at 22.
2. **When the Node 24 job has been green for a full release cycle, and no later than January 2027:** move `.nvmrc`, the Dockerfile base image and `package.json` `engines` to 24 in one release; the Node-22 job becomes the advisory one for a release, then is dropped. The browser suite and a real-device check (ADOPTION.md) run on the release candidate as usual.
3. **Before April 2027:** every county install is on that release. Upgrading Node is a host change: install Node 24 LTS, restart the service; the database and `data/` are untouched.

If `node:sqlite` changes shape in a way SUDS cannot absorb, the fallback is to pin the last Node 22 patch until the code is adapted — never to add an npm SQLite binding (CLAUDE.md: zero runtime dependencies).

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
| `TRUST_PROXY=1` | when proxied | Use the `X-Forwarded-For` header for audit IPs and rate limiting. Only set behind a proxy you control, and one that **appends** the address it saw to the header (Caddy, nginx `proxy_add_x_forwarded_for`, IIS ARR) — SUDS reads the *last* entry, the one the proxy vouches for, so a client cannot choose its own address by sending the header itself. |
| `SUDS_BACKUP_KEY` | recommended | 64 hex chars. Encrypts backups independently of `SUDS_ENCRYPTION_KEY`, so rotating the PHI key does not orphan the backup set. If unset, backups are keyed from `SUDS_ENCRYPTION_KEY` as before. See "Key rotation runbook". |
| `PUBLIC_APP_INFO=1` | no | Let `GET /api/app/info` (the addresses and certificate fingerprint the `/app` page shows) answer without a session. Off by default: a signed-in browser still gets it. |
| `ALLOW_STATIC_SYNC=1` | no | Let the demo/evaluation build of the web app served from a static host (GitHub Pages) sync with this server. Off by default; see WEB_APP.md. |
| `HOST`, `PORT` | no | Default `127.0.0.1:8080`. Use `HOST=0.0.0.0` only inside a container / behind a firewall. |
| `SESSION_IDLE_MINUTES` | no | Default 15 (auto sign-out). |
| `SESSION_ABSOLUTE_HOURS` | no | Default 12. |
| `MFA_REQUIRED_ROLES` | no | Default: every role (`admin,supervisor,clinician,navigator,finance,readonly`). Narrow it only with a documented reason; a navigator's caseload is as much PHI as an administrator's console. |
| `LOCAL_MODE_ENABLED` | no | **Default off.** Whether this server hands out the in-browser offline copy of SUDS (`/?local=1` and `/local/kernel.js`). The setup wizard asks (*Allow staff to keep an offline copy on their devices? Recommended: No*) and stores the answer in `data/server.json` as `localModeEnabled`; this variable, when set, overrides that answer either way (`true`/`1`/`yes`/`on` turn it on, anything else off). While off, `/?local=1` serves a short explanation instead of the app, `/app` does not mention it, and the device sync routes (`/api/sync/pull`, `/api/sync/push` and the attachment routes) answer 403, so a copy made while it was on can no longer pull or push. Turn it on only for a documented field-work need — see PLATFORM.md for the rules local mode runs under. (Until 1.9.2 the default was on.) |
| `ORG_TIMEZONE` | no | IANA zone the programme runs on, e.g. `America/Los_Angeles`. Defaults to the server's own zone. Decides the calendar date of a visit for fiscal-period checks and auto-posted expenditures (a 9pm visit on June 30th stays on June 30th), the days a report or export period covers (a *from*/*to* of June 1–30 runs from local midnight to local midnight, so an evening visit on the 30th is in it), and "today" for reminders and overdue to-dos. Can also be set as `orgTimezone` in `server.json`. |
| `CLIENT_RETENTION_YEARS` | no | Default `7`. Counted from the **last activity** on a record — the latest of its intake and discharge dates, episode openings and closings, and every visit, call, note, addendum, referral, to-do, consent, disclosure, form, overdose event, patient request, time entry and expenditure linked to it. A closed or deceased record (every episode closed) or an inactive one (whether or not an episode was ever closed) whose last activity is older than this, with no legal hold, is hard-deleted from every table once a day. Active and waitlisted records are never purged. Overridable in Administration → Settings; never below 6. |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_ONENOTE_USER` | optional | For direct OneNote import via Microsoft Graph. See IMPORTS.md. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | optional | Single sign-on against a county identity provider. See "Single sign-on" below. |
| `OIDC_LABEL` | no | Button text on the login page. Default "Sign in with county SSO". |
| `UPDATE_FEED_URL` | optional | Lets Administration check for a newer release. See "Upgrades" below. |
| `METRICS_TOKEN`, `LOG_FORMAT` | optional | Prometheus metrics and JSON logging for an existing monitoring stack. See "Monitoring and logs" below. |
| `AUDIT_RETENTION_DAYS` | no | Default 2555 (7 years). |
| `SUDS_ADMIN_USERNAME`, `SUDS_ADMIN_PASSWORD` | first run only | Initial admin. Otherwise a temporary password is printed once to stdout (never to the log file) and, in production, also written to `data/first-admin-password.txt` (mode 0600), which is deleted the moment an administrator changes their password. |
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

`docker-compose.yml` runs the app on an internal network and a Caddy proxy, configured by `./Caddyfile`, that obtains a certificate automatically for `SUDS_DOMAIN` and adds HSTS (one year, `includeSubDomains; preload`) and the other headers only the TLS terminator can vouch for. To use a county-issued certificate instead, add `tls /path/cert.pem /path/key.pem` to the site block. Mount `/data` on an encrypted volume. Images are pinned to a minor line (`node:22.x-alpine` in the Dockerfile, `caddy:2.x-alpine` in the compose file) so a rebuild picks up patch releases only; Dependabot (`.github/dependabot.yml`) proposes the moves.

Release downloads carry a checksum beside them (`suds-v<version>.zip.sha256`); compare with `sha256sum -c` before unpacking.

### Windows Server

Run under a service wrapper (NSSM or `sc.exe`) with the same environment variables, and terminate TLS with IIS (ARR reverse proxy to `127.0.0.1:8080`). Set `X-Forwarded-For` (ARR appends the client address, which is what SUDS reads) so audit logs record client IPs.

The double-click launchers that used to live in `launchers/` were removed in 1.9.3 (PLATFORM.md). A county deployment runs under systemd (above), NSSM or Docker.

### Files written by the setup wizard

| File | Contents |
| --- | --- |
| `data/server.json` | host (`127.0.0.1` or `0.0.0.0`), port, `tls` (`none` / `selfsigned`), `trustProxy`, `setupComplete`, `localModeEnabled` (the wizard's offline-copy answer; `LOCAL_MODE_ENABLED` overrides it) |
| `data/keys.json` | encryption and index keys (only when not supplied by the environment) |
| `data/certs/suds.crt`, `suds.key`, `suds-ca.crt` | self-signed ECDSA P-256 certificate covering localhost, the hostname and LAN IPs (825 days), and the private CA that signed it. The CA is name-constrained to exactly those hosts and expires 30 days after the certificate, so a phone that installs it trusts it for this server alone and for no longer than the certificate it was made for. |

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

Schedule nightly with cron / Task Scheduler and copy off-host, or turn on the built-in schedule instead: Administration → **Settings → Scheduled backups**, set an interval in hours and (optionally) an offsite directory — a mounted network share or drive path SUDS can write to directly. It runs from the same hourly housekeeping timer as audit and tombstone retention (`server/index.js`), keeps the configured number of local copies (oldest pruned first), and records the result under Administration → **System & backups**, including whether the offsite copy succeeded. The offsite directory must already exist: SUDS never creates it, because an unmounted share is an empty mount point and a folder made there would put the "offsite" copy on the very disk it exists to survive losing. An unreachable or missing offsite path never loses the local backup that already succeeded — it is reported as a status (`offsite copy failed: offsite directory does not exist (is the share mounted?)`), not a failure of the backup itself. A backup that cannot be written or read back at all (a full disk, a locked database) is recorded the same way: the status reads `failed: <reason>`, an audit entry `backup.scheduled` with `success: false` is written, `/api/health` answers 503 with the reason, and the page shows "Attention needed". Old copies beyond the retention count are pruned *before* the new one is written, so a disk full of old backups still has room for tonight's. Test restores quarterly either way. Backups are encrypted with a key derived from `SUDS_ENCRYPTION_KEY`, so a backup without the key is useless to an attacker — and to you.

An administrator can also restore without a shell, from Administration → **System & backups → Restore from a backup**: it reports what the file contains before changing anything, requires the administrator's password, and keeps the replaced database as `suds.db.before-restore-<stamp>` so a mistaken restore is recoverable. The file format is identical either way — both the manual and scheduled paths use `server/backup.js`.

### Key rotation runbook

SUDS has three keys, each rotatable on its own. Rotate on the schedule your policy sets (annually is typical), after any suspected exposure, and when a key custodian leaves. All three procedures run with the server stopped, after a backup, in a maintenance window; none is reversible except by restoring that backup.

| Key | Protects | Rotated by |
| --- | --- | --- |
| `SUDS_ENCRYPTION_KEY` | every PHI column (`*_enc`); backups, unless `SUDS_BACKUP_KEY` is set | `npm run rotate-key` |
| `SUDS_INDEX_KEY` | the searchable blind indexes (`*_idx`) and the audit chain's HMAC (one key, two uses — see HIPAA.md, "Risk register notes") | `npm run rotate-index-key` |
| `SUDS_BACKUP_KEY` | backups only (optional; recommended so the two above can rotate without touching the backup set) | change the variable; the next backup uses it |

**1. The PHI encryption key**

```bash
systemctl stop suds
npm run backup -- /secure/backups                       # take one first; this is not reversible
NEW_ENCRYPTION_KEY=$(npm run -s gen-key) npm run rotate-key
# set SUDS_ENCRYPTION_KEY to the new value (environment, or SUDS_ENCRYPTION_KEY in data/keys.json), then:
systemctl start suds
```

The columns to re-encrypt are discovered from the database, not from a list in the script, so every encrypted field — including completed county forms and their attachments — is covered.

**2. The index key**

```bash
systemctl stop suds
npm run backup -- /secure/backups
NEW_INDEX_KEY=$(npm run -s gen-key) npm run rotate-index-key
# the script updates data/keys.json or the development key file itself when the key came from there;
# from the environment, set SUDS_INDEX_KEY to the new value. Then:
systemctl start suds
```

Every blind index is re-derived from the decrypted value it was computed from, in one transaction, and the audit chain is re-signed in id order under the new key with its continuity preserved (the anchor hash a retention purge left behind is kept). The chain is verified under the old key before anything is touched — a chain that already fails is evidence, and the rotation refuses to alter it — and again under the new key before the transaction commits. The rotation itself is recorded as `security.index_key_rotated`. A blind-index column the script has no derivation for stops the rotation rather than being skipped, and `test/rotate-index-key.test.js` fails if the schema gains one.

**3. Retired keys and the backup set**

A backup is readable only with the key that was current when it was taken. So, with each rotation:

- Set `SUDS_BACKUP_KEY` once, before any rotation if you can. From then on backups do not depend on the PHI key at all, and rotating `SUDS_ENCRYPTION_KEY` or `SUDS_INDEX_KEY` leaves every existing backup readable. Rotate the backup key itself rarely, and only with step 3 below.
- Keep every retired `SUDS_ENCRYPTION_KEY` (or `SUDS_BACKUP_KEY`) in the secrets manager, labelled with the date range of the backups it opens, for as long as those backups are retained. A restore of an old backup under a retired key: `node scripts/backup.js --restore` with `SUDS_ENCRYPTION_KEY` (or `SUDS_BACKUP_KEY`) temporarily set to the retired value, then rotate forward again.
- Take a fresh backup immediately after each rotation, so the most recent backup always matches the current keys. Download a fresh key backup from Administration → System if the keys live in `data/keys.json`.
- Record who rotated what and when in the county's key-custodian log; the audit entries `security.key_rotated` and `security.index_key_rotated` are the system's side of that record.

## 4a. Monitoring and logs

`GET /api/health` needs no authentication and returns `{ ok, database, uptime_seconds, warnings }`. It answers 503 when the database cannot be read, free disk drops below 100 MB, the audit chain failed verification, scheduled backups have stopped or the HTTPS certificate is within 60 days of expiry, so it works directly as a liveness and readiness probe (the Docker image uses it). The inventory figures — `version`, `schema_version`, `database_bytes`, `disk_free_bytes` — are included only for an administrator's session or a request carrying `Authorization: Bearer <METRICS_TOKEN>`, since they describe the installation to anyone who can reach the port.

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

- [ ] TLS 1.2+ only; HSTS enabled (automatic when the app serves TLS; `Caddyfile` sets it when the proxy does).
- [ ] Behind a proxy: `TRUST_PROXY=1` only if the proxy appends to `X-Forwarded-For`; verify a sign-in failure is audited with the real client address.
- [ ] Request body caps left at their defaults (64 KB without a session, 1 MB for signed-in JSON, the 60 MB upload cap only on file routes behind a session — `server/app.js`).
- [ ] Local mode left off (`LOCAL_MODE_ENABLED` unset or `false`, wizard answer *No*) unless a field-work need is documented; if on, only county-managed devices with a passcode, disk encryption and MDM remote wipe.
- [ ] `PUBLIC_APP_INFO` and `ALLOW_STATIC_SYNC` left off unless there is a reason; `/api/setup/status` and `/api/health` give their detail only to a session or the metrics token.
- [ ] Data directory permissions `0700`, database `0600`, owned by the service user.
- [ ] Host firewall allows only 443 from the county network / VPN.
- [ ] OS disk encryption enabled; screen lock policies on workstations.
- [ ] MFA required for all roles (`MFA_REQUIRED_ROLES`); grace period (`MFA_GRACE_DAYS`, default 14) set to what your policy allows.
- [ ] Keys in a secrets manager; key custodian documented.
- [ ] Backups scheduled, encrypted, off-host, restore tested.
- [ ] Audit log reviewed monthly (Administration → Audit log → Break-glass events, Access denials, Exports).
- [ ] Business Associate Agreements in place with any hosting provider and with Pocket AI / Microsoft if PHI transits their services.
