# Logging and audit

SUDS keeps two separate records: the **audit log** (who did what to which record — in the database, hash-chained, retained 7 years) and the **operational log** (what the process did — files, no PHI, 30 days, for a log collector).

## What is audited

Every PHI read (client view, lists, timeline, note view, exports, accounting of disclosures), every write, every sign-in success and failure (with reason), MFA events, permission denials, break-glass access, configuration changes, backups and restores, key rotations, device revocations and wipes, API-key use, recovery drills and audit exports. Each entry records time, user, action, entity, client id, source IP (the proxy-appended address when `TRUST_PROXY` is set), success and structured details. Details never contain PHI (CLAUDE.md, enforced in review; failed sign-ins for unknown usernames are truncated and hashed). Code: `server/audit.js` `log`, called from every route; the rule "every PHI read/write must call `audit.log`" is in CLAUDE.md.

Administrators and supervisors (`audit:read`) search it under Settings → Audit log, with shortcuts for break-glass events, access denials and exports.

## Tamper evidence, in layers

| Layer | What it catches | Who could still defeat it | Code |
| --- | --- | --- | --- |
| **Append-only in the database.** SQLite triggers (`audit_log_no_update`, `audit_log_no_delete`, in `schema.sql` and migrated into existing databases) refuse any `UPDATE` or `DELETE` of `audit_log` unless the sanctioned maintenance flag is raised: `server/audit.js` `maintenance()` inserts a row into `audit_maintenance` and deletes it again inside the same transaction, so it is never committed and no other connection ever sees it. Only the retention purge and index-key re-signing call it | Any code path, script or person with a SQL prompt (the `sqlite3` shell, a restore script, a stray `UPDATE` in a route) changing or removing an entry: the statement fails with *audit_log is append-only* | Someone who can also drop the triggers — i.e. who can write the database file directly; the layers below catch them | `server/schema.sql`; `server/audit.js` `maintenance`; `test/audit-immutable.test.js` |
| **Hash chain.** Each entry's hash = `v2:` HMAC-SHA256(index key, its fields ‖ previous hash) | An edited, inserted or deleted entry inside the chain — for anyone without the index key | Someone holding the database *and* the index key, by recomputing every hash after the change | `server/audit.js` `log`, `walk` |
| **Sealed head.** Id, hash and row count of the newest entry, HMAC'd with the index key, stored in settings and written to the log file after each verification and purge | Deleting the newest entries (a shorter chain still verifies) | As above | `server/audit.js` `checkpoint`, `checkHead` |
| **Scheduled verification.** Daily (incremental from a sealed marker), weekly and on demand (full), in batches; a failure is audited, logged at error level and turns `/api/health` to 503 | Makes the above actually looked at | — | `server/audit.js` `scheduledVerify`; `server/index.js` |
| **Anchors outside the database** (new in this release). Every `AUDIT_ANCHOR_HOURS` (default 6), at every scheduled backup, after a restore and after an index-key rotation: the head (id, hash, oldest id, count), the installation and database generation, sealed with the index key and naming the previous anchor's MAC, written as a **new file created exclusively and made read-only** in `AUDIT_ANCHOR_DIR`, and optionally sent to syslog (`AUDIT_SYSLOG`, RFC 5424 over UDP) | **A wholesale rewrite by someone with the database and the key**: the entries the older anchors name no longer carry the recorded hashes. Also truncation, a removed or altered anchor file (the sequence breaks, the MAC fails) | Someone who can also rewrite the anchor store *and* the syslog collector. Put `AUDIT_ANCHOR_DIR` on storage the SUDS host administrator cannot modify (below). **In production (`SUDS_ENV=production`) an unset `AUDIT_ANCHOR_DIR`, or one that resolves (through symlinks, either way round) inside the data directory, is a failure**: red on Security status, a warning that turns `/api/health` to 503, and a warning in the startup log | `server/audit-anchor.js` `placementProblem`; `server/startup-checks.js`; `test/security-evidence.test.js`, `test/security-hardening.test.js` |
| **Log collector.** Checkpoint and anchor lines go to the log file at info level; ship `<data>/logs` (or stdout with `LOG_FORMAT=json`) to the county SIEM | Independent copy of the heads | Whoever administers the SIEM | `server/log.js` |

Anchor verification runs after the daily chain verification, on the Audit log tab's Verify, and inside every recovery drill (against the restored copy). Anchors from before a legitimate restore are expected not to match the restored database; they are accepted only because the restore itself writes an anchor (reason `restore`) for the new database generation. Anchors sealed under a previous index key are counted, not checked (after a rotation a fresh anchor restarts the evidence). Anchors belonging to another installation sharing the directory are ignored. Results appear on Settings → Security status; a mismatch is audited (`audit.anchor.verify.failed`), logged and turns `/api/health` to 503.

### Pointing `AUDIT_ANCHOR_DIR` at write-once storage

SUDS writes each anchor once (`O_EXCL`), then makes it read-only; it never rewrites or deletes one. What makes the store *write-once* is the storage, configured by county IT:

* **NetApp SnapLock / Dell PowerScale SmartLock / Synology WriteOnce** (compliance or enterprise mode): export an SMB or NFS share with a retention period of at least `AUDIT_RETENTION_DAYS`, mount it on the SUDS host (e.g. `/mnt/suds-anchors`) and set `AUDIT_ANCHOR_DIR=/mnt/suds-anchors`. Files committed there (SUDS makes each read-only, which is the SnapLock commit trigger) cannot be changed or deleted until the retention date, by anyone.
* **Azure Files** with a time-based immutability (WORM) policy on the share, or **Azure Blob / Amazon S3 with Object Lock** (compliance mode) mounted through blobfuse2 or mountpoint-s3: the same, with the bucket's default retention set to the audit retention.
* **Windows Server**: a share on another server where the SUDS service account has *Create files / write data* but not *Delete* or *Write attributes* (a deny ACE), plus Volume Shadow Copies — weaker (a domain administrator can change the ACL), so pair it with `AUDIT_SYSLOG` to the county SIEM.

In every case the share lives on a different system from the SUDS data directory, and the account that administers the SUDS host does not administer the storage. Security status says whether the directory is configured, writable and outside the data directory; `docker-compose.yml` mounts a separate volume for it.

Honest limit: until the first anchor exists, and for entries written after the newest anchor, detection rests on the in-database chain and the log collector. Keep `AUDIT_ANCHOR_HOURS` short and backups frequent.

## Auditor's export

`GET /api/admin/audit/export` (permission `audit:read`; itself audited as `audit.export`), also *Download audit export* on Settings → Security status. Optional range: `from_id`/`to_id` or `from`/`to` dates. Output is NDJSON:

1. a header line (format, version, server version, organisation, range, the hashing scheme);
2. one line per entry with every field exactly as stored (so each hash can be recomputed);
3. a manifest line: entry count, first `prev_hash` and last hash, the SHA-256 of all preceding lines, the index-key identifier, **the anchors that fall inside the range**, the sealed head, an HMAC of the manifest under the index key, and an **Ed25519 signature** of the manifest (with the signing key's id and public key).

**Signed, not only MACed.** The HMACs (chain, head, anchors, manifest) are keyed with the index key, which whoever runs the database necessarily holds, so they prove nothing to an auditor about *who* produced a file. The manifest is therefore also signed with an Ed25519 key (`server/signing.js`) that lives with the other keys — `SUDS_SIGNING_KEY`, or `keys.json`, where it is generated on first start if absent — and never in the database. Its public key is published at `GET /api/admin/security/signing-key` (JSON, or `?format=pem`; also *Download signing public key* on Security status). The auditor records that key (or its key id) once, from the server, and verifies every export against it with no secret at all. A manifest edited and re-MACed by someone holding the index key fails the signature. The same key signs recovery-drill reports (BACKUP-AND-DR.md).

Verify it anywhere with only Node installed:

```bash
npm run verify-audit-export -- export.ndjson --public-key suds-signing-key.pem          # signature, digest, linkage, anchors: no secret needed
npm run verify-audit-export -- export.ndjson --public-key suds-signing-key.pem --key-file keys.json --anchors /mnt/worm/suds-anchors   # everything
```

With `--public-key` it checks the manifest's Ed25519 signature against the key the auditor obtained from the server (without it, against the key embedded in the file, which proves integrity but not origin, and it says so). Without the index key it checks the digest, the chain's linkage, the unkeyed (legacy) entries and that the embedded anchors match; with the index key (held by the county's key custodian, entered in the auditor's presence) it also checks every entry's HMAC, the manifest MAC and each anchor's MAC. `--anchors` checks the export against anchor files the auditor copied from the write-once store independently — evidence the export did not bring with it. Exit status 0 = verified (`scripts/verify-audit-export.js`, `server/audit-export.js`).

## Retention

Audit entries are kept `AUDIT_RETENTION_DAYS` (default 2,555 days, seven years; never fewer than 2,190 days, the six years 45 CFR §164.316(b)(2) requires documentation to be kept — a lower value does not stop the server starting, but it is raised to 2,190 days, the startup log warns, and Security status shows *Audit retention* as a problem until the setting is fixed), then purged oldest-first by the hourly housekeeping; each purge writes an `audit.purge` entry recording the last purged id and hash so the chain stays verifiable, and anchors older than the purge are accounted for. The audit table is otherwise never updated or deleted from — enforced by the database triggers above, not only by convention — except by the index-key rotation's re-signing (`server/audit.js` `resignChain`), which verifies first, runs inside the same maintenance window, and is itself audited.

## Operational logs and monitoring

* `<data>/logs/suds-<date>.log`, mode 0600, rolled at 8 MB, 30 days; `LOG_FORMAT=json` for collectors (`server/log.js`).
* `GET /api/health` — liveness/readiness; 503 on database error, low disk, audit-chain or anchor failure, stale/failed backups, expiring certificate.
* `GET /api/metrics` — Prometheus text, bearer-token gated, aggregate only (`server/metrics.js`).
* Client-side errors are reported to the server without PHI (`server/routes/client-errors.js`).
