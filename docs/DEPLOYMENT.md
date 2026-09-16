# Deployment guide

## Requirements

* Node.js 22.13 or newer (uses the built-in `node:sqlite` module). No other runtime dependencies.
* A host with an **encrypted disk** for the data directory (BitLocker, LUKS, or a cloud disk with KMS-backed encryption).
* TLS: either a certificate/key pair for the app itself, or a TLS-terminating reverse proxy (Caddy, nginx, IIS ARR, a cloud load balancer). Never expose plain HTTP beyond localhost.

## 1. Configuration

Copy `.env.example` to `.env` and set:

| Variable | Required | Notes |
| --- | --- | --- |
| `SUDS_ENV=production` | yes | Enforces keys and secure cookies |
| `SUDS_ENCRYPTION_KEY` | yes | 64 hex chars. `npm run gen-key`. Encrypts all PHI fields. **Losing it makes PHI unrecoverable.** |
| `SUDS_INDEX_KEY` | yes | 64 hex chars. Used for searchable blind indexes. |
| `SUDS_DB_PATH` / `SUDS_DATA_DIR` | no | Defaults to `./data/suds.db`. Put on the encrypted volume. |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | recommended | If unset, run behind a TLS proxy. |
| `HOST`, `PORT` | no | Default `127.0.0.1:8080`. Use `HOST=0.0.0.0` only inside a container / behind a firewall. |
| `SESSION_IDLE_MINUTES` | no | Default 15 (auto sign-out). |
| `SESSION_ABSOLUTE_HOURS` | no | Default 12. |
| `MFA_REQUIRED_ROLES` | no | Default `admin,supervisor`. Set to `admin,supervisor,clinician,navigator,finance` to require MFA for everyone (recommended). |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_ONENOTE_USER` | optional | For direct OneNote import via Microsoft Graph. See IMPORTS.md. |
| `AUDIT_RETENTION_DAYS` | no | Default 2555 (7 years). |
| `SUDS_ADMIN_USERNAME`, `SUDS_ADMIN_PASSWORD` | first run only | Initial admin. Otherwise a temporary password is printed once. |

Store the keys in a secrets manager (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault) or at minimum in a root-only file; back them up separately from the database.

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

Schedule nightly with cron / Task Scheduler and copy off-host. Backups are encrypted with a key derived from `SUDS_ENCRYPTION_KEY`, so a backup without the key is useless to an attacker — and to you. Test restores quarterly.

## 5. Upgrades

```bash
git pull && npm test && systemctl restart suds
```

Schema migrations run automatically at startup (`server/db.js`); take a backup first.

## 6. Hardening checklist

- [ ] TLS 1.2+ only; HSTS enabled (automatic when the app serves TLS).
- [ ] Data directory permissions `0700`, database `0600`, owned by the service user.
- [ ] Host firewall allows only 443 from the county network / VPN.
- [ ] OS disk encryption enabled; screen lock policies on workstations.
- [ ] MFA required for all roles.
- [ ] Keys in a secrets manager; key custodian documented.
- [ ] Backups scheduled, encrypted, off-host, restore tested.
- [ ] Audit log reviewed monthly (Administration → Audit log → Break-glass events, Access denials, Exports).
- [ ] Business Associate Agreements in place with any hosting provider and with Pocket AI / Microsoft if PHI transits their services.
