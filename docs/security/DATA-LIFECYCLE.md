# Data lifecycle: collection, retention, deletion, residency

## Residency and subprocessors

* **Data stays where the county hosts it.** SUDS is software the county runs on its own server, VM or cloud tenant. The records, backups, logs and anchors are written only to paths the county configures (`SUDS_DATA_DIR`, the offsite directory, `AUDIT_ANCHOR_DIR`). Choosing a US region / GovCloud tenant / on-premises host is the county's residency control.
* **No subprocessors.** The SUDS project operates no service: no hosted database, no telemetry, no analytics, no crash reporting to a vendor, no license server, no update service that receives data. Nothing is sent to the SUDS project or to GitHub by a running office server.
* **Outbound connections exist only when an administrator configures them** (`../DEPLOYMENT.md`, "Outbound internet"; `../HIPAA.md`): the county identity provider (OIDC; no PHI), Microsoft Graph for OneNote import (the county's own tenant, if used), the release feed (`UPDATE_FEED_URL`; no data sent), provider pictures for the resource directory (public websites; no PHI), and a syslog collector for anchors (no PHI). Each of these is the county's own service or a public website — none is a SUDS subprocessor; where PHI transits the county's Microsoft tenant, the county's BAA with Microsoft governs it.

### The GitHub Pages build ("SUDS on this device")

A second, separate way to run SUDS (`../WEB_APP.md`, `../PLATFORM.md`): the app's code is served from GitHub Pages and the records live only in that one browser, encrypted, with their keys beside them. GitHub never receives record data (no sync, no network calls with records), so it is not a business associate, but: the code is served by GitHub (a repository compromise could serve altered code — self-host the static build to remove that dependency), the records have no server-side copy (loss of the browser profile loses everything not in a device backup), and there is no central audit or retention. Counties that need central retention, audit review or residency controls should use the office server; a county may prohibit the on-device app by policy.

## Retention

| Data | Default | Setting | Mechanism |
| --- | --- | --- | --- |
| Client records (every table) | 7 years after the **last activity** on the record, once every episode is closed or the record is inactive; never below 6 years | `client_retention_years` (Settings), `CLIENT_RETENTION_YEARS` | Daily hard delete from every client-linked table in one transaction; legal hold exempts; purge audited by client code only (`server/retention.js`) |
| Audit log | 7 years (2,555 days) | `AUDIT_RETENTION_DAYS` | Oldest entries purged hourly; the purge is recorded so the chain stays verifiable (`server/audit.js` `purge`) |
| Deletion tombstones (for devices) | 180 days | `TOMBSTONE_RETENTION_DAYS` | `server/audit.js` `purgeTombstones` |
| Sessions | Expired / revoked sessions removed hourly (revoked kept 24 h) | Session policy | `server/index.js` |
| Operational logs | 30 days, rolled at 8 MB | — | `server/log.js` |
| Idempotency replies | 24 hours | — | `server/idempotency.js` |
| Local backups | Newest 14 | `backup_retain_count` | `server/scheduled-backup.js` |
| Offsite backups, anchors | Not pruned by SUDS | County storage policy (object lifecycle / WORM retention) | — |
| Recovery-drill reports | Not pruned | — | `<data>/backups/dr-drill-*` |

Settings → Security status shows the retention period and when the retention job last ran.

## Deletion

* **Soft delete** (with a required reason) is the everyday action for records staff remove, so an erroneous deletion is recoverable and audited.
* **Hard delete** happens by retention (above), by merge of duplicates, and by removal of fictional sample data. Retention deletes rows from every table at once, not just the client row, so nothing identifiable is left behind in child tables; financial and time rows keep their amounts with the client link removed.
* **Backups** age out by the retention count locally; offsite copies and backups taken before a purge still contain purged records until they expire — set the offsite store's retention to match policy.
* **Devices** are told what was deleted (tombstones); revoked devices can be wiped remotely at their next contact (`server/devices.js`).
* **Decommissioning** an installation: stop the service, destroy the data volume and every backup set, then destroy the keys (without `SUDS_ENCRYPTION_KEY`, any copy that survives is ciphertext — crypto-shredding). Record it in the county's disposal log (§164.310(d)(2)).

## Export and portability

Administrators and supervisors can export data (de-identified by default; identified exports require a recipient and purpose and write an accounting-of-disclosures row per client — `server/exports.js`, `server/disclosure.js`). The database is a standard SQLite file; with the keys, the county can read every record with its own tools. There is no lock-in to a vendor service.
