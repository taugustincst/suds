# Deployment guide

> **First install?** See [INSTALL.md](INSTALL.md): start the server and finish setup in the browser wizard. The platform policy — web app on the office server as the system of record; the native apps and launchers were removed in 1.9.3 — is [PLATFORM.md](PLATFORM.md). For the governance side of adopting SUDS (code owner, pilot, release cadence, drills, staffing), see [ADOPTION.md](ADOPTION.md). **On a Linux VM, SUDS Server does this for you**: [SELF-HOSTING.md](SELF-HOSTING.md) and [`deploy/linux/`](../deploy/linux/README.md) install SUDS hardened in one command (Ubuntu 24.04, RHEL/Rocky/Alma 9) and `npm run compliance-check` records, weekly in a signed report, whether the host matches §6 below; containers: [`deploy/docker/`](../deploy/docker/README.md). This document covers the environment-variable / service deployment that IT departments typically prefer, and is the reference for everything the installer sets. Both can be mixed: environment variables override anything the wizard wrote to `data/server.json` and `data/keys.json`.

## Requirements

* Node.js 22.13 or newer (uses the built-in `node:sqlite` module). No other runtime dependencies.
* A host with an **encrypted disk** for the data directory (BitLocker, LUKS, or a cloud disk with KMS-backed encryption).
* TLS: either a certificate/key pair for the app itself, or a TLS-terminating reverse proxy (Caddy, nginx, IIS ARR, a cloud load balancer). Never expose plain HTTP beyond localhost.

### Node.js support and the move to 24

SUDS is pinned to Node 22 (`.nvmrc`, the Dockerfile, CI). Node 22 leaves maintenance at the end of April 2027, and `node:sqlite` is still marked experimental in both 22 and 24, so its API can change between releases. The plan:

1. **Now:** CI runs the full `npm test` suite on Node 24 (`node24` in `.github/workflows/ci.yml`). It was advisory until 1.11.0 and is now a required job: the release gate (RELEASE.md, "Release gate") refuses a commit where it failed. `.nvmrc` stays at 22. Both lines are pinned to an exact release checked against a SHA-256 in the workflow (Node 22 since 1.14.0; RELEASE.md, "Bumping the pinned Node versions"). On Node 24 (24.21.0), `node:sqlite` no longer prints the experimental warning it prints on 22, and the API SUDS uses (`DatabaseSync` with `prepare` and `exec`, and the read-only second connection report snapshots use since 1.14.0) behaves the same (the suite passes on it); it is still a young module, so each Node 24 bump runs the whole suite before it is taken.
2. **When the Node 24 job has been green for a full release cycle, and no later than January 2027:** move `.nvmrc`, the Dockerfile base image and `package.json` `engines` to 24 in one release; the Node-22 job becomes the advisory one for a release, then is dropped. The browser suite and a real-device check (ADOPTION.md) run on the release candidate as usual.
3. **Before April 2027 (Node 22's end of life, 30 April 2027):** every county install is on that release, and Node 24 LTS is the supported runtime; Node 22 is then unsupported. Upgrading Node is a host change: install Node 24 LTS, restart the service; the database and `data/` are untouched.

If `node:sqlite` changes shape in a way SUDS cannot absorb, the fallback is to pin the last Node 22 patch until the code is adapted — never to add an npm SQLite binding (CLAUDE.md: zero runtime dependencies).

### Outbound internet

SUDS needs no outbound connection to run. The one everyday feature that uses one is **Resource directory →
Download provider pictures**, which fetches each starter-directory program's picture from the program's own
website over HTTPS (public addresses only; redirects to this machine or a private network are refused). Allow
the server outbound HTTPS (port 443) to the providers' websites if you want it; without it the button reports
"the computer running SUDS could not reach the internet" and every program keeps its generated card.

The optional **AI documentation copilot** (off by default; `docs/AI-COPILOT.md`) calls the AI provider's API
(`https://api.anthropic.com`, or `SUDS_AI_BASE_URL`) with `ANTHROPIC_API_KEY` from the service's environment
(or, with `SUDS_AI_PROVIDER=bedrock` / `vertex`, Amazon Bedrock or Google Vertex AI with their credentials:
`docs/AI-COPILOT.md`, *Providers*), only after an administrator records the programme's BAA/QSOA with the provider and switches it on. Allow
outbound HTTPS to that host if you use it.

The optional **county connection** (off by default; released in 1.18.0; `docs/COUNTY-VIEW.md`,
*Connecting*): a programme's server that an administrator connects to its county posts its county submission file
to the county's SUDS over HTTPS, to that one configured host only (no redirects, one 15-second deadline for the
whole exchange). Allow outbound HTTPS to the county's host. The county's address must be public HTTPS; a county
reached over a VPN or split DNS on a private address (RFC 1918 or IPv6 unique local) is allowed only when the service
is started with `SUDS_COUNTY_ALLOW_PRIVATE=1` — the name is then resolved, checked and the connection pinned to the
checked address, never through `HTTPS_PROXY`, and this machine, link-local and cloud metadata addresses stay refused.
A county certificate issued by its own CA is trusted with `NODE_EXTRA_CA_CERTS=/path/to/county-ca.pem`.

### Inbound from the internet: secure referral links

**Secure referral links** (off by default; `docs/security/REFERRAL-LINKS.md`) are opened by a provider outside
the programme, in their own browser, **on this server**. For them to work the server must be reachable from the
internet over HTTPS — an office server reachable only on the office network cannot serve one. Exposing it
(a TLS reverse proxy, `TRUST_PROXY=1` so the per-address limits see real addresses) is a decision for the
programme's IT and its risk register, and counsel reviews the link design before an administrator switches the
setting on.

### Inbound from the internet: the county connection (a county's server)

A **county** that switches on the county connection (off by default; `docs/COUNTY-VIEW.md`, *Connecting*) must let
its programmes' servers reach `https://<county SUDS>/api/county-connect/v1/` — through its TLS reverse proxy on the
internet, or over a VPN. **`TRUST_PROXY=1` is required** when `county_connect_enabled` is on behind a proxy:
without it every programme is counted as the proxy's one address, so one programme's calls (or a flood of made-up
tokens) count against all of them, and each token's recorded last-use address is the proxy's. County connections
shows a warning when the connection is on, `TRUST_PROXY` is unset and calls arrive carrying `X-Forwarded-For`. The routes need a bearer token (hashed at rest, revocable) and answer 404 while
the switch is off; a county may also allow-list its programmes' addresses at the proxy or WAF for that path only.
Nothing else in SUDS needs inbound access from outside the office.

Behind a county web proxy, Node's built-in `fetch` ignores `HTTPS_PROXY` unless told to use it: set **both**
`HTTPS_PROXY=http://proxy.example.gov:8080` and `NODE_USE_ENV_PROXY=1` in the service's environment (Node 22.21
or newer; `NO_PROXY` is honoured too). A proxy that inspects HTTPS presents its own certificate, which Node
does not trust by default: give it the proxy's CA with `NODE_EXTRA_CA_CERTS=/path/to/county-proxy-ca.pem`.
The download says which of these it ran into.

**How the address checks work with and without a proxy** (`server/outbound.js`; the same guard covers a
picture added from a web address, a FHIR client's JWKS URL and identity-provider endpoints off the issuer's
origin). Without a proxy SUDS connects itself: the name is resolved and every address checked (never this
machine, a private network or the cloud metadata service) in the same step that opens the connection, and the
connection goes to the checked address, so a name that re-resolves somewhere private a moment later (DNS
rebinding) is refused; a name that cannot be resolved is refused. With a proxy in use (`HTTPS_PROXY` **and**
`NODE_USE_ENV_PROXY=1`), the proxy resolves and connects: SUDS still checks the name when it can resolve it
itself, and lets the request go to the proxy unresolved only when this machine cannot resolve outside names
at all (`ENOTFOUND`/`EAI_AGAIN`). In that mode the proxy is the last line: configure it to refuse
private and link-local destinations (RFC 1918, 127/8, 169.254/16, fc00::/7). `HTTPS_PROXY` without
`NODE_USE_ENV_PROXY=1` is not a proxy in use (Node connects directly), so an unresolvable name is refused.

### Single instance only

SUDS is one process, one SQLite database file: there is no clustering, no shared session store, and no distributed rate limiter — sessions, login lockout counters and the API rate limiter all live in that one process's memory. This is a deliberate scope, not a temporary gap: a second process against the same data directory does not add capacity, it risks corrupting the database, so it is refused outright (`server/instance-lock.js`, a pidfile at `data/.suds.lock`) rather than merely discouraged in a document nobody reads before scaling a container to more replicas. A process that exits cleanly releases the lock; a lock left behind by one that crashed is detected as stale and taken over, so a crash never leaves a data directory permanently unable to start. The lock records the pid, the **hostname** (`os.hostname()`), the **container identity** (a digest of the root mount as `/proc/self/mountinfo` describes it — for a container, its own overlay upper directory, kept by a restart of that container and shared with no other — plus the pid namespace, `/proc/self/ns/pid`, and `/etc/machine-id`), the kernel boot id and the process start time, and the running process refreshes the lock file's modification time every 10 seconds (a **heartbeat**). How a leftover lock is judged depends on where it was written:

* **Same hostname and same container identity** (the same machine, or the same container restarted): local facts are conclusive. The identity must match as well as the hostname — the machine id when both locks have one, then the root-mount digest (or, where there is none, the pid namespace) — because two containers can share a hostname and both run node as pid 1: `network_mode: host`, a fixed `hostname:`, a StatefulSet pod rescheduled onto another node. Up to 1.12.0 the second of them took the first's live lock over as "own pid" at once, the first stopped within 10 s, and with restart policies the two alternated. A lock naming this process's own pid (node is PID 1, or tini's child, on every container start), written during a previous boot, naming a pid that is not running, or a pid that now belongs to a process started at a different time is stale and taken over at once. A live process is refused.
* **Different hostname, or the same hostname with a different container identity** (another machine on shared storage such as NFS, or another container — Docker gives each container its own random hostname unless `hostname:` is set or the host's network is shared): its pid and boot id say nothing about processes here (every replica's node has the same pid and they share the host's boot id), so only the heartbeat counts. The lock is stale once it has gone **45 seconds** without a heartbeat (3 × 10 s plus 15 s for clock skew and slow storage — keep the hosts' clocks NTP-synchronised). Start-up waits up to **50 seconds** for that and then takes over; if the heartbeat keeps being refreshed it refuses, naming the other host/container and the heartbeat's age.
* Lock files from 1.12.0 and earlier (a plain pid, or JSON without a hostname or identity) are judged by the same-host rules those versions used. Without `/proc` (not Linux) there is no identity to compare and the hostname decides.

What that means in practice:

| Situation | Result |
| --- | --- |
| systemd restart, or the machine rebooted after a crash | same hostname: dead pid / previous boot → taken over at once |
| `docker compose restart`, or `restart: unless-stopped` after a crash or OOM kill | the container keeps its hostname and its root mount: own pid → taken over at once |
| `docker compose up` recreating the container, or a fresh `docker run` on the same volume, after a crash | new hostname: start-up waits until the old lock is 45 s without a heartbeat (at most 50 s), then takes over; if the crash was longer ago than that, at once |
| A second replica (`--scale suds=2`, `replicas: 2`, `desiredCount: 2`) or a second host on the same NFS volume | the holder's heartbeat is live: refused after 50 s with a message naming the other container/host; with a restart policy it keeps being refused while the first one runs |
| Two containers with the same hostname on one volume — `network_mode: host`, a fixed `hostname:`, a StatefulSet pod rescheduled while the old one still runs — both with node as pid 1 | different container identity: judged by the heartbeat like another host — refused after 50 s while the first one runs (up to 1.12.0: taken over at once as "own pid", and the two alternated) |
| The same, after the first crashed (a StatefulSet pod rescheduled onto another node) | start-up waits until the old lock is 45 s without a heartbeat (at most 50 s), then takes over |
| A holder suspended (VM paused, SIGSTOP) for more than 45 s whose lock was then taken over | its next heartbeat sees the lock is no longer its own and it stops (exit 1) instead of writing alongside the new holder |

A fixed `hostname:` is safe on Linux (the container identity tells the containers apart), but on a platform without `/proc` identical hostnames would still make a second replica look like the first one's own restart, so do not give replicas one there. If a start is refused and you are certain the other instance has stopped, remove `data/.suds.lock` and start again. Run the container with an init process (`init: true` in `docker-compose.yml`, `docker run --init`) so node is not PID 1 and signals and orphaned children are handled properly.

This covers *one program's* worth of staff — dozens, not hundreds. If a deployment is outgrowing a single box, the answer is a bigger box (this is close to zero-overhead per request) or a separate SUDS install per county/program, never multiple instances load-balanced in front of one database.

## 1. Configuration

Copy `.env.example` to `.env` and set:

| Variable | Required | Notes |
| --- | --- | --- |
| `SUDS_ENV=production` | yes | Enforces keys and secure cookies |
| `SUDS_ENCRYPTION_KEY` | yes* | 64 hex chars. `npm run gen-key`. Encrypts all PHI fields. **Losing it makes PHI unrecoverable.** |
| `SUDS_INDEX_KEY` | yes* | 64 hex chars. Used for searchable blind indexes. |
| `SUDS_SIGNING_KEY` | recommended | 64 hex chars (`npm run gen-key`): the Ed25519 private key that signs recovery-drill reports and audit-export manifests (`server/signing.js`). Never stored in the database. If unset it is read from `data/keys.json`, and generated there on first start when absent (it protects no data, so a new one loses nothing — only documents signed before the change stop verifying against the new public key). Its public key is at `GET /api/admin/security/signing-key`; give it to your auditor once. |

\* If not set, the first production start generates both keys into `data/keys.json` (mode 0600) so the browser wizard can run; the wizard and Administration → System offer a key backup download (which includes the signing key).
| `SUDS_DB_PATH` / `SUDS_DATA_DIR` | no | Defaults to `./data/suds.db`. Put on the encrypted volume. |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | recommended | If unset, run behind a TLS proxy. |
| `TRUST_PROXY=1` | when proxied | Use the `X-Forwarded-For` header for audit IPs and rate limiting. Only set behind a proxy you control, and one that **appends** the address it saw to the header (Caddy, nginx `proxy_add_x_forwarded_for`, IIS ARR) — SUDS reads the *last* entry, the one the proxy vouches for, so a client cannot choose its own address by sending the header itself. |
| `SUDS_BACKUP_KEY` | recommended | 64 hex chars. Encrypts backups independently of `SUDS_ENCRYPTION_KEY`, so rotating the PHI key does not orphan the backup set. If unset, backups are keyed from `SUDS_ENCRYPTION_KEY` as before. See "Key rotation runbook". |
| `PUBLIC_APP_INFO=1` | no | Let `GET /api/app/info` (the addresses and certificate fingerprint the `/app` page shows) answer without a session. Off by default: a signed-in browser still gets it. |
| `ALLOW_STATIC_SYNC=1` | no | No effect (kept so existing configurations still start): the on-device web app on GitHub Pages never syncs with an office server; see WEB_APP.md. |
| `LOGIN_RATE_LIMIT` | no | Failed sign-ins accepted per username from one source address per 15 minutes. Default 20. Successful sign-ins are not counted, and from 1.24 one person's wrong guesses no longer hold back everyone else behind the same address. |
| `LOGIN_IP_RATE_LIMIT` | no | Failed sign-ins accepted per source address per 15 minutes, whatever the username: the backstop against someone trying many usernames. Default ten times `LOGIN_RATE_LIMIT` (200). |
| `API_RATE_LIMIT` | no | API requests accepted per source address per minute (every route except sign-in). Default 600. **An office behind one NAT address** shares both limits across every desk: for a day of bulk imports (Import, several people uploading and reviewing spreadsheets at once) or a training session, raise them — e.g. `API_RATE_LIMIT=3000` and `LOGIN_RATE_LIMIT=100` — and restart SUDS; put them back afterwards. Behind a reverse proxy, set `TRUST_PROXY=1` instead where it applies, so each desk is counted by its own address. A request over the limit is answered 429 *Too many requests* and succeeds again a minute later. |
| `SIGNUP_RATE_LIMIT` | no | Account requests (the sign-in page's **Sign up**, `POST /api/auth/signup`) accepted per address per hour. Default 5. Sign up itself is switched on or off under Settings (`self_signup`, on by default). |
| `FHIR_EXPORT_TTL_MINUTES` | no | How long a FHIR bulk export's encrypted output files are kept before they are deleted (default 60). See docs/integration/FHIR.md. |
| `HOST`, `PORT` | no | Default `127.0.0.1:8080`. Use `HOST=0.0.0.0` only inside a container / behind a firewall. |
| `SESSION_IDLE_MINUTES` | no | Default 15 (auto sign-out). |
| `SESSION_ABSOLUTE_HOURS` | no | Default 12. |
| `MFA_REQUIRED_ROLES` | no | Default: every role (`admin,supervisor,clinician,navigator,finance,readonly`). Narrow it only with a documented reason; a navigator's caseload is as much PHI as an administrator's console. |
| `MFA_GRACE_DAYS` | no | Default 3. Days a new account (counted from its creation, or from approval of an access request) in a role that requires two-step verification has to enrol before it can reach nothing but enrolment. `0` = at first sign-in. Settings → Security policy overrides it (`mfa_grace_days`). A value that is not a non-negative number is ignored (3). |
| `LOCAL_MODE_ENABLED` | no | **Default off.** Whether this server hands out the in-browser offline copy of SUDS (`/?local=1` and `/local/kernel.js`). The setup wizard asks (*Allow staff to keep an offline copy on their devices?* — recommended *Yes* for a harm-reduction & outreach programme, *No* for a treatment-adjacent one) and stores the answer in `data/server.json` as `localModeEnabled`; this variable, when set, overrides that answer either way (`true`/`1`/`yes`/`on` turn it on, anything else off). While off, `/?local=1` serves a short explanation instead of the app, `/app` does not mention it, and the device sync routes (`/api/sync/pull`, `/api/sync/push` and the attachment routes) answer 403, so a copy made while it was on can no longer pull or push. A server whose wizard was never asked (or an API setup that leaves the answer out) keeps it off — see PLATFORM.md for the rules local mode runs under. (Until 1.9.2 the default was on.) |
| `ORG_TIMEZONE` | no | IANA zone the programme runs on, e.g. `America/Los_Angeles`. Defaults to the server's own zone. Decides the calendar date of a visit for fiscal-period checks and auto-posted expenditures (a 9pm visit on June 30th stays on June 30th), the days a report or export period covers (a *from*/*to* of June 1–30 runs from local midnight to local midnight, so an evening visit on the 30th is in it), and "today" for reminders and overdue to-dos. Can also be set as `orgTimezone` in `server.json`. An administrator can choose it in **Settings → Programme → Your programme → Organisation time zone**, which overrides this variable (clear it there to fall back to this one); the office sends the zone in force to its devices when they sync. |
| `TZ` | no | The process's time zone (standard for every Node/Unix program), e.g. `America/Los_Angeles`. SUDS stores and logs every timestamp in UTC whatever it is set to; it matters only as the fallback for `ORG_TIMEZONE` (the "server's own zone" above) and is passed on to a recovery drill's restored copy. In the Docker image the container's zone is UTC unless you set `TZ` or `ORG_TIMEZONE` — set `ORG_TIMEZONE` rather than relying on it. |
| `CLIENT_RETENTION_YEARS` | no | Default `7`. Counted from the **last activity** on a record — the latest of its intake and discharge dates, episode openings and closings, and every visit, call, note, addendum, referral, to-do, consent, disclosure, form, overdose event, patient request, time entry and expenditure linked to it. A closed or deceased record (every episode closed) or an inactive one (whether or not an episode was ever closed) whose last activity is older than this, with no legal hold, is hard-deleted from every table once a day. Active and waitlisted records are never purged. Overridable in Administration → Settings; never below 6. |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_ONENOTE_USER` | optional | For direct OneNote import via Microsoft Graph. See IMPORTS.md. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | optional | Single sign-on against a county identity provider. See "Single sign-on" below. |
| `WEBAUTHN_RP_ID` | **required in production** for fingerprint sign-in | The office server's host name for passkeys (fingerprint sign-in and signing, released in 1.19.0; [FINGERPRINT.md](FINGERPRINT.md)), e.g. `suds.county.gov`: the name on the TLS certificate and in the address staff open. Unset in production (and no `WEBAUTHN_ORIGINS` to take it from), no passkey options are issued and Security status shows a red line; outside production it falls back to the request's `Host` header (never `X-Forwarded-Host`). Set it before anyone enrols; passkeys need HTTPS (plain http only on localhost in development) and never work at an IP address. `server.json` `webauthnRpId` also works. |
| `WEBAUTHN_ORIGINS` | no | Comma-separated exact page origins (`https://suds.county.gov`, with a port if one shows) when a proxy makes them differ from what SUDS sees. Default: the request's own scheme and host. |
| `OIDC_LABEL` | no | Button text on the login page. Default "Sign in with county SSO". |
| `UPDATE_FEED_URL` | optional | Lets Administration check for a newer release. See "Upgrades" below. |
| `METRICS_TOKEN`, `LOG_FORMAT` | optional | Prometheus metrics and JSON logging for an existing monitoring stack. See "Monitoring and logs" below. |
| `AUDIT_RETENTION_DAYS` | no | Default 2555 (7 years). Minimum 2190 (6 years, 45 CFR §164.316(b)(2)): a lower value is raised to 2190 with a startup warning and flagged in Security status. |
| `AUDIT_ANCHOR_DIR` | **yes in production** | Where audit anchors are written (`server/audit-anchor.js`): the head of the audit hash chain, sealed with the index key, one write-once file per anchor. Point it at storage the database's administrator cannot rewrite — a WORM / immutable-snapshot NAS share or an object-lock bucket mounted as a directory (how, per storage product: security/LOGGING-AND-AUDIT.md, "Pointing AUDIT_ANCHOR_DIR at write-once storage"). SUDS never creates a configured directory (an unmounted share is an empty mount point); it reports the failure instead. Unset: `<data>/audit-anchors`, which catches a rewrite of the database but not of the whole data directory — **with `SUDS_ENV=production`, unset or inside the data directory is reported as a failure**: red on Security status, a `/api/health` warning (503) and a startup-log warning. The Docker image sets it to the separate `/anchors` volume. |
| `AUDIT_ANCHOR_HOURS` | no | Default 1 (6 before 1.13.0). Hours between anchors — the most recent audit entries a database-and-key attacker could delete undetected; every scheduled backup also writes one. `0` = at backups only. |
| `AUDIT_SYSLOG` | no | Also send each anchor to a syslog collector over UDP (RFC 5424, facility *log audit*), e.g. `udp://siem.county.gov:514`. |
| `DR_DRILL_TIMEOUT_MS` | no | Default 900000 (15 min). How long a recovery drill's restored copy may take before the drill is failed. |
| `SUDS_ADMIN_USERNAME`, `SUDS_ADMIN_PASSWORD` | first run only | Initial admin, called `guest` unless `SUDS_ADMIN_USERNAME` names another. Without `SUDS_ADMIN_PASSWORD` a temporary password is printed once to stdout (never to the log file) and, in production, also written to `data/first-admin-password.txt` (mode 0600), which is deleted the moment an administrator changes their password. |
| `SUDS_SKIP_SETUP=1` | no | Never show the browser setup wizard (it is already skipped when keys come from the environment). |
| `SUDS_ORG_NAME` | first run only | The programme name written into settings (`org_name`) when the first administrator is created — the programme name the app shows. Default "County Harm Reduction and Outreach Program". Afterwards change it in Settings; the variable is not read again. |
| `SUDS_MAX_RESTORE_BYTES` | no | Largest request body accepted by the in-browser restore (`/api/admin/restore*`, the backup file base64-encoded in JSON, so about 4/3 of the file). Default 629145600 (600 MB), enough for a backup of about 450 MB. Raise it for a larger database, or restore on the host (`node scripts/backup.js --restore`, no limit). Other routes keep their own limits. |

Settings that live in the database (Administration → Settings) rather than the environment and matter for this guide: `backup_schedule_hours` (a production install made with the setup wizard starts at **4**; one configured by environment variables starts at 0, which production reports as a problem), `backup_schedule_minutes` / `backup_snapshot_retain` (frequent online snapshots), `sso_trust_idp_mfa` / `sso_mfa_acr_values` (accept the identity provider's MFA), `sso_deprovision_days` (disable SSO accounts the provider has stopped vouching for), `scim_group_roles` / `scim_default_role` (SCIM provisioning).

Store the keys in a secrets manager (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault) or at minimum in a root-only file; back them up separately from the database. **Every secret can be given as a file instead of a value**: `<NAME>_FILE` names a file holding it (`SUDS_ENCRYPTION_KEY_FILE`, `SUDS_INDEX_KEY_FILE`, `SUDS_BACKUP_KEY_FILE`, `SUDS_SIGNING_KEY_FILE`, `METRICS_TOKEN_FILE`, `OIDC_CLIENT_SECRET_FILE`, `MS_CLIENT_SECRET_FILE`, `ANTHROPIC_API_KEY_FILE`) — a systemd credential (`LoadCredential=`, as `deploy/linux/suds.service` does; a credential named after the variable in lower case is also found in `$CREDENTIALS_DIRECTORY` without one), a Docker or Kubernetes secret under `/run/secrets` ([deploy/docker/README.md](../deploy/docker/README.md)). The value is read once and never copied into the process environment; `<NAME>` itself, when set, wins.

### Single sign-on (OIDC)

Optional, and additive: SUDS's own username/password + MFA login keeps working either way, and OIDC never creates or promotes an account by itself. It only ever signs in to a SUDS account an administrator has already linked to the identity provider — the flow that satisfies a county AD/Entra ID/Okta/Keycloak requirement without SUDS holding its own copy of the county's directory.

1. Register a confidential web application (Authorization Code + PKCE) with the identity provider. Redirect URI: `https://<your SUDS address>/api/auth/oidc/callback`.
2. Set `OIDC_ISSUER` (the provider's issuer URL — SUDS reads `{issuer}/.well-known/openid-configuration`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` (must exactly match what was registered), and optionally `OIDC_LABEL`.
3. Restart SUDS. The login page now offers an SSO button above the password form.
4. For each staff member who should use it: Administration → Users → edit their account → **Single sign-on identity**, and paste the `sub` claim the identity provider issues for them (most providers show this in the user's profile, or it can be read from a test token). Leave it blank for anyone who should keep using a SUDS password.

The ID token is verified against the provider's published signing keys (RS256 only — symmetric and unsigned tokens are refused outright), and its issuer, audience, expiry and nonce are all checked before anyone is signed in. Once signed in, an OIDC session behaves exactly like a password one: the same idle/absolute timeouts, the same MFA requirement if the account's role requires it (unless the provider's MFA is trusted, below), and the same audit trail (`auth.oidc.login`, `auth.oidc.failed`). SSO is never offered in local/offline mode — a device with no route to the office server has no route to the identity provider either.

**Requiring SSO.** Once staff are linked, Settings → Security policy → **Require single sign-on** turns password sign-in off for every account except the emergency (break-glass) administrator accounts named beside it — so a leaver is cut off at the identity provider and the county's password and MFA policy applies there. The setting is refused until OIDC is configured and at least one active administrator is named as an emergency account (an identity-provider outage must not lock the programme out). A password sign-in by an emergency account is recorded as `auth.login` with `emergency_account: true` and logged as a warning; a refused one as `auth.login.sso_required`. The check runs only after the password verifies, so it reveals nothing to someone guessing. If OIDC is later unconfigured, the requirement stops being enforced (rather than locking everyone out) and Security status shows it as "Action needed". Local-mode devices sync by password, so with SSO required only emergency accounts can sync a device.

**The identity provider's MFA.** By default SUDS's own TOTP requirement still applies to SSO sign-ins. If the county's provider enforces MFA for SUDS (an Entra ID conditional-access policy requiring MFA for this enterprise application; an Okta authentication policy), Settings → Security policy → **Trust the identity provider's multi-factor sign-in** accepts the provider's assertion instead: an ID token with `amr` containing `mfa`, or naming two factors of different RFC 8176 kinds (knowledge `pwd`/`pin`/`kba`, possession `otp`/`sms`/`tel`/`hwk`/`swk`/`sc`, inherence `fpt`/`face`/`iris`/`retina`/`vbm` — for example `pwd`+`otp` or `hwk`+`pin`), or an `acr` you list. A lone `otp`, `hwk` or `swk` is not enough: under RFC 8176 each can be the only factor (a passwordless key, an emailed code); if your provider reports MFA that way, list the provider's MFA `acr` value instead (and SUDS then requests with `acr_values`). Sign-ins the provider does not mark as multi-factor still need the SUDS code. Each trusted sign-in is audited with `mfa: "idp"`; the setting change is audited as `security.idp_mfa_trust`. Off by default.

**Provisioning and deprovisioning.** SCIM 2.0 at `https://<host>/scim/v2` lets Entra ID or Okta create, update and deactivate accounts: create a token under Settings → Security status → *Provisioning (SCIM)*, enter the URL and token in the provider's provisioning settings, and map groups to roles under Settings → Security policy (`scim_group_roles`). Deactivation there ends the person's sessions immediately and wipes their devices on next sync. Without SCIM, **Disable single sign-on accounts not seen for (days)** (`sso_deprovision_days`) disables linked accounts the provider has not signed in for that long. SAML is not supported (OIDC covers Entra ID, Okta and ADFS 2016+; SAML would need an XML-signature implementation SUDS will not take on without dependencies). Details: security/IDENTITY.md.

## 2. Run

### systemd (Linux)

**On a Linux VM, use SUDS Server** ([SELF-HOSTING.md](SELF-HOSTING.md)): `deploy/linux/install.sh` does everything in this section and the hardening checklist (§6) in one command on Ubuntu 24.04 or RHEL/Rocky/Alma 9, and `npm run compliance-check` records, weekly and signed, whether the host still matches.

The unit is [`deploy/linux/suds.service`](../deploy/linux/suds.service) — the one copy, which the installer installs unchanged and `test/deploy-linux.test.js` checks (this guide carried a second copy until 1.17.1). It runs SUDS as the `suds` user from the read-only `/opt/suds/current` with the pinned Node in `/opt/suds/node`, bound to `127.0.0.1:8080`, with the full systemd sandbox: `ProtectSystem=strict` with only the data directory writable, `NoNewPrivileges`, an empty capability set, the kernel/proc/namespace protections and a `@system-service` system-call filter. The keys are not in its environment: each is a root-only file in `/etc/suds/credentials` handed to the service by `LoadCredential=` and read through `SUDS_*_KEY_FILE` (server/config.js supports a `*_FILE` variable for every secret). Non-secret settings are in `/etc/suds/suds.env`; what differs per site (the anchor and offsite mounts, which it adds to `ReadWritePaths` and `RequiresMountsFor`) is in the drop-in `/etc/systemd/system/suds.service.d/10-site.conf`.

Installing it by hand on another distribution: copy the unit, create the paths it names, and put site changes in a drop-in rather than editing it. `ReadWritePaths` must cover `SUDS_DATA_DIR` and `AUDIT_ANCHOR_DIR`, and the offsite share's mount point when it lives elsewhere. `systemd-analyze security suds` scores the unit. The recovery drill (`npm run dr-drill`, or the button in Settings) forks a second Node process inside the same unit, which these settings allow. Test the unit on a staging host before production: `SystemCallFilter` sets differ slightly between systemd versions.

### Docker

```bash
docker compose up -d
```

`docker-compose.yml` runs the app on an internal network and a Caddy proxy, configured by `./Caddyfile`, that obtains a certificate automatically for `SUDS_DOMAIN` and adds HSTS (one year, `includeSubDomains; preload`) and the other headers only the TLS terminator can vouch for. To use a county-issued certificate instead, add `tls /path/cert.pem /path/key.pem` to the site block. Mount `/data` on an encrypted volume. Images are pinned to a minor line (`node:22.x-alpine` in the Dockerfile, `caddy:2.x-alpine` in the compose file) so a rebuild picks up patch releases only; Dependabot (`.github/dependabot.yml`) proposes the moves.

Release downloads carry a checksum beside them (`suds-v<version>.zip.sha256`); compare with `sha256sum -c` before unpacking.

### Windows Server

Use the **Windows server zip**, `suds-<version>-windows-x64.zip` on each release ([WINDOWS-SERVER.md](WINDOWS-SERVER.md)). It needs no Node.js install. `suds service install` installs the built-in service *SUDS* (WinSW, as `NT SERVICE\SUDS`, automatic delayed start, restart on failure, logs under the data folder, events in the Application log). `suds status`, `suds logs` and `suds backup` manage it. The data folder is `C:\ProgramData\SUDS`, and the environment variables below go in `C:\ProgramData\SUDS\.env`. This replaces the earlier advice to wrap `npm start` in NSSM. For TLS, use `TLS_CERT_PATH`/`TLS_KEY_PATH`, or terminate it with IIS (ARR reverse proxy to `127.0.0.1:8080`) and set `TRUST_PROXY=1`. ARR appends the client address to `X-Forwarded-For`, which is what SUDS reads, so audit logs record client IPs.

The double-click launchers that used to live in `launchers/` were removed in 1.9.3 (PLATFORM.md). A county deployment runs under systemd (above), the Windows service, or Docker.

### Files written by the setup wizard

| File | Contents |
| --- | --- |
| `data/server.json` | host (`127.0.0.1` or `0.0.0.0`), port, `tls` (`none` / `selfsigned`), `trustProxy`, `setupComplete`, `localModeEnabled` (the wizard's offline-copy answer; `LOCAL_MODE_ENABLED` overrides it) |
| `data/keys.json` | encryption and index keys (only when not supplied by the environment) |
| `data/certs/suds.crt`, `suds.key`, `suds-ca.crt` | self-signed ECDSA P-256 certificate covering localhost, the hostname and LAN IPs (825 days), and the private CA that signed it. The CA is name-constrained to exactly those hosts and expires 30 days after the certificate, so a phone that installs it trusts it for this server alone and for no longer than the certificate it was made for. |

Network settings can be changed at runtime under Administration → Network & devices; the listener switches without a restart.

## 3. First login

1. Sign in as `guest` (or the `SUDS_ADMIN_USERNAME` you set) with the initial password; you must change it immediately.
2. Enroll MFA (Profile → Multi-factor authentication) — required for admins.
3. Administration → Settings: set the organization name, county, privacy officer contact, and confirm **Caseload restriction = On**.
4. Administration → Users: create staff accounts. Share temporary passwords in person or by phone, never by email.
5. Budget → add funding sources and budget lines; Resource Directory → enter referral partners.

**An administrator locked out** (forgotten password, lockout, lost authenticator): on the server, as the service
account, run `npm run reset-admin -- <username>` (with the same environment the service runs with, so it opens
the same database and keys; in Docker, `docker compose exec suds node scripts/reset-admin.js <username>`). Shell access
to the server is the proof of ownership. It prints a random temporary password once, sets
`must_change_password`, clears the lockout, failed attempts and two-step verification, revokes the account's
sessions and audits `admin.reset_cli` (never the password); it refuses an account that is not an administrator.
A sign-in rate limit on the address is in memory and clears when SUDS restarts. There is no stock or shared
administrator password. SUDS on this device is different: its records are only in that browser, so its owner
uses the device's recovery code or a backup (WEB_APP.md, *Can't sign in?*).

## 4. Backups

```bash
npm run backup -- /secure/backups        # encrypted, consistent snapshot (VACUUM INTO + AES-256-GCM)
node scripts/backup.js --restore /secure/backups/suds-<stamp>.db.enc /tmp/check.db   # decrypt to a separate file; the live database is not touched
# with SUDS stopped, put a backup in place of the live database (never opens it; moves it and its -wal/-shm aside, sealed):
node scripts/backup.js --restore-in-place /secure/backups/suds-<stamp>.db.enc
```

(`<data dir>/suds.db` is the database: `/var/lib/suds` on SUDS Server, `./data` by default; `/opt/suds` holds only code there.)

**Lower RPO.** For a recovery point in minutes rather than hours, also set **Settings → Scheduled backups → Also snapshot every (minutes)** (e.g. 15): an encrypted online snapshot (SQLite backup API, no downtime; about 1.2 s and at most a ~90 ms pause for a 100 MB database) goes to the offsite directory every N minutes, the newest `backup_snapshot_retain` kept. Security status shows the worst-case RPO. Measurements and sizing: security/BACKUP-AND-DR.md.

Schedule nightly with cron / Task Scheduler and copy off-host, or turn on the built-in schedule instead: Administration → **Settings → Scheduled backups**, set an interval in hours and (optionally) an offsite directory — a mounted network share or drive path SUDS can write to directly. It runs from the same hourly housekeeping timer as audit and tombstone retention (`server/index.js`), keeps the configured number of local copies (oldest pruned first), and records the result under Administration → **System & backups**, including whether the offsite copy succeeded. The offsite directory must already exist: SUDS never creates it, because an unmounted share is an empty mount point and a folder made there would put the "offsite" copy on the very disk it exists to survive losing. An unreachable or missing offsite path never loses the local backup that already succeeded — it is reported as a status (`offsite copy failed: offsite directory does not exist (is the share mounted?)`), not a failure of the backup itself. A backup that cannot be written or read back at all (a full disk, a locked database) is recorded the same way: the status reads `failed: <reason>`, an audit entry `backup.scheduled` with `success: false` is written, `/api/health` answers 503 with the reason, and the page shows "Attention needed". Old copies beyond the retention count are pruned *before* the new one is written, so a disk full of old backups still has room for tonight's. Prove the backups restore with a recovery drill (below) — monthly if you turn the schedule on, and at least quarterly either way. Backups are encrypted with a key derived from `SUDS_ENCRYPTION_KEY`, so a backup without the key is useless to an attacker — and to you.

An administrator can also restore without a shell, from Administration → **System & backups → Restore from a backup**: it reports what the file contains before changing anything, requires the administrator's password, and keeps the replaced database, encrypted like a backup, as `suds.db.before-restore-<stamp>.enc` for 14 days, so a mistaken restore is recoverable (`node scripts/backup.js --restore` opens it). The file format is identical either way — both the manual and scheduled paths use `server/backup.js`.

### Recovery drill (tested RTO and RPO)

```bash
npm run dr-drill                        # restore the newest backup in data/backups into a temporary copy and prove it
npm run dr-drill -- --backup /path/to/offsite/suds-<stamp>.db.enc   # a copy fetched back from the offsite share
npm run dr-drill -- --fresh             # take a backup first, then restore that
npm run dr-drill -- --keys-file /media/escrow/suds-keys-KEEP-SECRET.json   # prove the escrowed key backup opens the backups
npm run dr-drill -- --local             # the local copy even when an offsite directory is configured (default: offsite)
npm run verify-dr-report -- data/backups/dr-drill-<stamp>.json --public-key suds-signing-key.pem   # auditor: public key only
```

or **Settings → System & backups → Run a recovery drill now** (runs in the background; the card shows progress and the result), or monthly from housekeeping (**Settings → Scheduled backups → Recovery drill every month**, off by default). The drill (`server/dr-drill.js`) decrypts the backup into `data/.dr-drill/<random>/` (0700), starts SUDS against that copy in a separate process that is never given the live database's path (`server/dr-drill-child.js`; the keys reach it over the IPC channel, not its environment), and checks: SQLite `integrity_check`; that the keys in custody open it (the key fingerprint); the schema is at this build's version (migrating an older backup, as a real restore would); every table holds the rows the backup was taken with; the whole audit chain verifies and matches the anchors written before the backup; a sample of every `*_enc` column decrypts; `/api/health` answers; and a throwaway administrator with a known second factor signs in (password + TOTP) and reads the records back. The copy is deleted afterwards. It measures **RTO** (seconds from starting the restore to the restored copy serving) and **RPO** (the age of the backup it restored — what a loss at that moment would have cost), compares them with the targets under Settings (`dr_rto_target_minutes`, default 60; `dr_rpo_target_hours`, default the backup interval or 24), and writes `data/backups/dr-drill-<stamp>.json` (SHA-256, an HMAC under the index key and an Ed25519 signature over the canonical report, so an edited report does not verify — and the signature verifies with the public key alone) and a `.txt` copy. With an offsite directory configured it restores the offsite copy (and fails if the share is unreachable); with `--keys-file` (or the key-file upload on the page) it uses the escrowed keys instead of the server's own. Drill copies left behind by a crash are overwritten and removed at the next start. The result is shown on Settings → System & backups and Security status, recorded as the `dr.drill` audit entry, and kept in the `dr_last_drill` setting. See security/BACKUP-AND-DR.md.

The drill measures a restore onto the *same* host. For a disaster that takes the host, the RTO also includes bringing up the standby (see "County hosting options" below); run the drill on the standby with `--backup` against a copy from the offsite share to measure that end to end.

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

Signed notes: a note's signature hash is taken over its ciphertext, so the rotation checks each one under the old key and recomputes those that were intact (the `security.key_rotated` entry counts `signature_hashes_recomputed` and `signature_hashes_left_broken`). A rotation run with SUDS 1.18.0 or earlier did not, and the notes it left "not intact" are **not repaired** by a later one: a note that Verify signature reports as not intact and that was signed before such a rotation (its `security.key_rotated` entry has no `signature_hashes_recomputed`) was left stale by it; one signed after it has been changed. docs/FINGERPRINT.md, "The note's signature hash and key rotation", has the details.

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

## 4a. County hosting options and single-site risk

SUDS is deliberately one process on one SQLite file ("Single instance only" above), so resilience comes from where it runs, how its backups leave the building, and a practised standby — not from clustering. Every option below keeps PHI inside infrastructure the county controls; SUDS has no vendor cloud and no subprocessor (security/DATA-LIFECYCLE.md).

**A. County-hosted VM (the default).** A Linux VM (or Windows Server) in the county data centre, run under the systemd unit above, TLS terminated by the county's proxy or Caddy. The data directory on an encrypted volume; `AUDIT_ANCHOR_DIR` on a WORM/immutable share on a different storage system; scheduled backups every 1–4 hours with the offsite directory on a share at a second site (or replicated to one). Hypervisor snapshots are a convenience, not the backup: a snapshot of a running SQLite file is only crash-consistent — the scheduled backup (`VACUUM INTO`, then encrypted and read back) is the copy to rely on.

**B. County cloud tenant — Azure Government / AWS GovCloud (US), or the commercial regions the county already uses under its BAA.** The same shape, on the county's own subscription or account:

| | Azure (Government) | AWS (GovCloud) |
| --- | --- | --- |
| Host | Linux VM, or a container (ACI/AKS) with exactly one replica | EC2, or ECS with `desiredCount: 1` |
| Data volume | Managed disk, server-side encryption with a customer-managed key in Key Vault | EBS encrypted with a customer-managed KMS key |
| Keys | Key Vault secrets → environment at start | Secrets Manager / SSM Parameter Store (SecureString) → environment |
| Anchors (`AUDIT_ANCHOR_DIR`) | Azure Files share on a storage account with an immutability (WORM) policy | S3 bucket with Object Lock (compliance mode) mounted as a directory (Mountpoint for Amazon S3), or EFS protected by AWS Backup Vault Lock |
| Offsite backups | Storage in the paired region (GRS or object replication) | S3 with Cross-Region Replication to a second region, Object Lock on |
| TLS / edge | Application Gateway or the county's front door | ALB with an ACM certificate |

Run exactly one instance: a container platform must not scale it out (`server/instance-lock.js` refuses a second process on the same data directory). Check that the county's storage choice supports how SUDS writes anchors (a new file per anchor, created exclusively, never modified) before relying on it. Keep the county's BAA with the cloud provider in force; SUDS itself makes no outbound calls except the optional ones in "Outbound internet".

**C. Warm standby (active–passive).** For an RTO shorter than "rebuild a server":

1. Build a second host (another site, availability zone or region) from the same release, with the same keys available from the secrets manager but **SUDS not running** (`systemctl disable --now suds`, or the container scaled to 0). It can read the offsite backup share and the anchor store.
2. Replication is the backup set: scheduled backups every *N* hours (RPO ≈ *N*) copied to the offsite share the standby reads. Do not replicate the live SQLite file (copying it while it is written produces a damaged copy).
3. Prove the standby monthly: on the standby, `npm run dr-drill -- --backup <newest file on the offsite share>`. The report is the evidence that the standby can take over within the RTO, measured on the machine that would.
4. Failover: declare the primary lost and make sure it is stopped or fenced (two live copies would diverge); on the standby, with SUDS stopped, `node scripts/backup.js --restore-in-place <newest offsite backup>`, start SUDS, move the DNS name or proxy target, and tell staff to sign in again. Local-mode devices see the new database generation on their next sync and re-offer what the backup lacked (`server/routes/sync.js`). Record the event in the incident register (Privacy & Part 2 → Incidents & breaches). A restore through Settings → System & backups also writes a `restore` audit anchor, so the anchors from before it are not reported as tampering.
5. Failback is the same procedure in the other direction, from a backup taken on the standby.

What this does not give you: automatic failover or zero data loss. Anything entered after the last backup is lost in a site failure; shorten the backup interval to shorten that window.

## 4b. Monitoring and logs

Three unauthenticated endpoints, for three different questions. Use the right one: a probe that restarts SUDS on an operational warning puts it in a restart loop that fixes nothing.

| Endpoint | Question | 503 when | Use it for |
| --- | --- | --- | --- |
| `GET /api/health/live` | Is the process alive? | the database does not answer `SELECT 1` | **Liveness**: Docker `HEALTHCHECK` (the image and `docker-compose.yml` use it), a Kubernetes `livenessProbe`, a systemd watchdog script. A failure means restart. |
| `GET /api/health/ready` | Can it serve requests now? | the database is not open, is not at this build's schema version, or a restore is replacing it (`{ ok:false, reason }`) | **Readiness**: a load balancer's health check, a Kubernetes `readinessProbe`. A failure means stop sending traffic, not restart. |
| `GET /api/health` | Does an operator need to act? | any of the above, or a warning (below) | **Alerting and dashboards** only — never as a liveness probe. |

`GET /api/health` returns `{ ok, database, uptime_seconds, warnings }`. It answers 503 when the database cannot be read, free disk drops below 100 MB, the audit chain failed verification, the audit log no longer matches its anchors or the anchors are stored in the data directory in production, scheduled backups have stopped or failed, an index `server/schema.sql` declares is missing and could not be created at startup (logged as `db.index_missing`; also on Security status), or the HTTPS certificate is within 60 days of expiry. None of those is fixed by restarting the process, which is why liveness and readiness ignore them: page someone on this endpoint instead. The inventory figures — `version`, `schema_version`, `database_bytes`, `disk_free_bytes` — are included only for an administrator's session or a request carrying `Authorization: Bearer <METRICS_TOKEN>`, since they describe the installation to anyone who can reach the port.

**Kubernetes** (exactly one replica, `strategy: Recreate` — ADR-0001; the instance lock refuses a second process):

```yaml
livenessProbe:  { httpGet: { path: /api/health/live,  port: 8080 }, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 3 }
readinessProbe: { httpGet: { path: /api/health/ready, port: 8080 }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 }
startupProbe:   { httpGet: { path: /api/health/live,  port: 8080 }, periodSeconds: 5, failureThreshold: 120 }   # a migration on a large database can take minutes
```

**systemd** has no HTTP probe of its own; `Restart=always` in the unit above covers a process that exits. To also restart a process that is up but whose database has stopped answering, run a timer every minute with `curl -fsS --max-time 5 http://127.0.0.1:8080/api/health/live || systemctl restart suds` (three consecutive failures before restarting is kinder). Point the county's monitoring (Nagios, Zabbix, Uptime Kuma, Azure Monitor, CloudWatch Synthetics) at `/api/health` for alerts.

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

Schema migrations run automatically at startup (`server/db.js`), each inside a transaction with its version stamp and with `PRAGMA foreign_key_check` before it commits, so a crash midway cannot leave a half-applied schema. Before the first migration of a start-up runs, SUDS takes its own consistent snapshot of the database into `data/pre-migration/suds.db.v<version>.<timestamp>.db` (the last five are kept) and logs where it went; if the snapshot cannot be written — no disk space, no permission — the upgrade stops rather than proceeding unprotected. Once the upgrade has succeeded, the snapshot is sealed with the backup key (`suds.db.v<version>.<timestamp>.db.enc`, the same format as a backup: `node scripts/backup.js --restore <file>.enc` turns it back into a database) and the plaintext copy is overwritten and removed; sealed snapshots are deleted after 14 days. If an upgrade stops with an error, its snapshot stays unsealed for you to put back, and is sealed at the next successful start. An upgrade that encrypted a column finishes with a `VACUUM` (and a 1.13.0 database is vacuumed once, on the first start of 1.14.0), which needs free disk space about the size of the database and takes about a second per hundred megabytes (0.6 s for 103 MB measured); the server logs `db.free_pages_scrubbed`. That snapshot is a convenience, not a substitute for the off-host backup above: it sits on the same disk. SUDS refuses to open a database written by a *newer* build rather than running against a schema it does not understand — so a rollback means restoring the backup that matches the version you are rolling back to.

## 6. Hardening checklist

On SUDS Server every line below that can be checked on the host is checked by `npm run compliance-check` (weekly, signed; [SELF-HOSTING.md](SELF-HOSTING.md), *The compliance check*) and shown on Settings → Security status; the rest are the organisation's ([SELF-HOSTING.md](SELF-HOSTING.md), *Compliance boundary*).

- [ ] TLS 1.2+ only; HSTS enabled (automatic when the app serves TLS; `Caddyfile` sets it when the proxy does).
- [ ] Behind a proxy: `TRUST_PROXY=1` only if the proxy appends to `X-Forwarded-For`; verify a sign-in failure is audited with the real client address.
- [ ] Request body caps left at their defaults (64 KB without a session, 1 MB for signed-in JSON, the 60 MB upload cap only on file routes behind a session — `server/app.js`).
- [ ] Local mode left off (`LOCAL_MODE_ENABLED` unset or `false`, wizard answer *No*) unless a field-work need is documented; if on, only county-managed devices with a passcode, disk encryption and MDM remote wipe.
- [ ] `PUBLIC_APP_INFO` and `ALLOW_STATIC_SYNC` left off unless there is a reason; `/api/setup/status` and `/api/health` give their detail only to a session or the metrics token.
- [ ] Data directory permissions `0700`, database `0600`, owned by the service user.
- [ ] Host firewall allows only 443 from the county network / VPN.
- [ ] OS disk encryption enabled; screen lock policies on workstations.
- [ ] MFA required for all roles (`MFA_REQUIRED_ROLES`, or the "every role" switch in Settings); grace period (`MFA_GRACE_DAYS`, default 3 days, counted from account creation or access-request approval; 0 = at first sign-in) set to what your policy allows.
- [ ] Keys in a secrets manager; key custodian documented.
- [ ] Backups scheduled, encrypted, off-host (snapshots every 15–60 minutes if the RPO target is under an hour); a recovery drill passed within the last quarter using the **escrowed key file** and the **offsite copy** (Settings → System & backups), monthly drill on.
- [ ] `AUDIT_ANCHOR_DIR` on write-once storage outside the data directory; Security status shows the anchors matching and no startup-log warning about it.
- [ ] The signing public key (`GET /api/admin/security/signing-key`) given to the auditor; `SUDS_SIGNING_KEY` (or `keys.json`) backed up with the other keys.
- [ ] Single sign-on configured and required (Settings → Security policy → Require single sign-on) with named, sealed break-glass administrator accounts; two-step verification required for every role.
- [ ] Settings → Security status reviewed with no "Action needed" lines.
- [ ] Settings → Security status → *Hardening checklist* (released in 1.24.0) shows every recommended item done; the same items not yet done are on the administrator's Home under *Finish setting up*. Each is computed from the configuration (`GET /api/admin/security/hardening`), so it cannot be ticked without making the change.
- [ ] Settings › Program › *Security & procurement page*: publish the contact, legal entity, pricing and service-level text an evaluating organization should see (`procurement_*` settings), shown under *This program* (from 1.25.2 apart from the software vendor's own terms, which the page shows as AugustInnovations LLC's); a field left blank reads "Not yet published by this program". They are public (`GET /api/procurement`, no session): never put client information in them.
- [ ] Audit log reviewed monthly (Administration → Audit log → Break-glass events, Access denials, Exports).
- [ ] Business Associate Agreements in place with any hosting provider and with Pocket AI / Microsoft if PHI transits their services.
