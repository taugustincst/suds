# Incident response and breach notification

SUDS supports the county's incident-response plan; it does not replace it. The plan, the people (privacy officer, security officer, counsel), and the notification decisions belong to the county (HIPAA §164.308(a)(6), Breach Notification Rule §§164.400–414, 42 CFR §2.16).

## Recording an incident

Incidents are recorded in SUDS's incident register: **Settings → Incidents** (available to administrators). Use it to log a suspected or confirmed security incident or breach, its discovery date, what was affected, the risk assessment and the notification decisions and dates, so the record the Breach Notification Rule requires is kept beside the evidence. (The register is delivered as its own feature; this document describes how the rest of SUDS supplies the evidence for it.)

## Detection signals SUDS produces

| Signal | Where it shows | Code |
| --- | --- | --- |
| Audit chain fails verification (edited, deleted or truncated entries) | Audit log tab (red badge), Security status, `/api/health` 503, error log line, `audit.verify.failed` audit entry | `server/audit.js` |
| Audit log no longer matches its anchors outside the database (wholesale rewrite) | Audit log tab, Security status, `/api/health` 503, `audit.anchor.verify.failed` | `server/audit-anchor.js` |
| Repeated sign-in failures, lockouts, MFA failures, refused password sign-in while SSO is required, emergency-account use | Audit log (filter `auth.`) | `server/auth.js` |
| Access outside a caseload, permission denials | Audit log → *Access denials* (`authz.denied`) | `server/auth.js` |
| Break-glass reads of clinical notes | Supervision → Break-glass access (must be acknowledged by someone else) | `server/routes/notes.js`, `server/routes/supervision.js` |
| Identified exports | Audit log → *Exports*; accounting of disclosures per client | `server/exports.js` |
| Backups failing or stopping, certificate expiry, low disk | System & backups, Security status, `/api/health` 503 | `server/scheduled-backup.js`, `server/routes/app.js` |
| A lost or stolen device (local mode) | Settings → Synced devices (revoke, wipe on next contact) | `server/devices.js` |

Point the county's monitoring at `/api/health` and ship `<data>/logs` to the SIEM so these reach the people on call rather than waiting for someone to open the page.

## Containment actions available

* Deactivate an account (sessions end, devices queued for wipe); force a password change; revoke an API key.
* Revoke or wipe a local-mode device; turn local mode off (`LOCAL_MODE_ENABLED=false`) to stop all device sync.
* Require SSO (Settings → Security policy) to cut off password use; disable a person at the identity provider.
* Rotate keys (`../DEPLOYMENT.md`, "Key rotation runbook") after suspected key exposure.
* Take the server off the network; restore from a known-good backup (the drill report shows which backups verify).

## Evidence preservation

1. Download an audit export (`GET /api/admin/audit/export`) immediately and verify it (`npm run verify-audit-export`); store it with the incident record.
2. Copy the anchor files and the log files (`<data>/logs`) for the period.
3. Take a backup (Settings → *Run a backup now*) before any restore, so the state at discovery is preserved (a browser restore also keeps the replaced database as `suds.db.before-restore-<time>`).
4. Record who did what in the incident register; every action taken in SUDS is itself audited.

## Assessing a breach

The accounting of disclosures (`server/disclosure.js`) and the audit log's `client_id` column identify which clients' records an account opened or exported, which is what the four-factor risk assessment and any notification list need. Audit details contain no PHI, so the audit export can be shared with investigators without itself being a disclosure of record content.
