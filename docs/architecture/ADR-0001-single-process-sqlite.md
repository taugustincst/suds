# ADR-0001: One process, one SQLite database per programme

- **Status:** accepted
- **Date recorded:** 2026-09-25 (in force since 1.0.0, 2026-09-16; written down retrospectively)
- **Owners:** the code owner named under [docs/ADOPTION.md](../ADOPTION.md) §1

## Context

SUDS serves one harm-reduction, outreach or prevention programme: dozens of staff, not hundreds. The people
who run it are a programme's IT partner or a small county IT team, not a platform team. Every extra moving
part (a database server, a cache, a queue, a package tree) is something they must patch and back up, and
something a security reviewer must assess. Node 22 ships SQLite (`node:sqlite`), crypto and HTTP.

## Decision

- The server is **one Node.js process** using only Node built-ins, with **one SQLite file** as the system of
  record for its programme. No runtime npm packages (`package.json` has devDependencies only, for the browser
  kernel build).
- Sessions, rate limits and the scheduler live in that process's memory (`server/app.js`, `server/auth.js`).
- A **second process against the same data directory is refused**: `server/instance-lock.js` takes a lock
  file with `O_EXCL` recording pid, hostname, boot id and process start time, and the holder refreshes its
  mtime every 10 s (heartbeat). A lock written under this hostname is judged by local process facts (own
  pid, previous boot, dead pid, reused pid → stale at once), so a crash cannot brick start-up; a lock from
  another hostname — another container or another host on shared storage, where pid and boot id prove
  nothing — only by its heartbeat (stale after 45 s; start-up waits up to 50 s, then refuses). A holder
  that finds its lock taken over stops. (Up to 1.12.0 own-pid and foreign-boot locks were taken over from
  anywhere, which let a second Docker replica or a second NFS host in.)
- Availability comes from backups, restore and a documented warm standby — not clustering
  ([docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md)).
- Multiple programmes = multiple instances (one data directory and key set each), never multi-tenancy inside
  one database.

## Consequences

- Small attack surface and a short install; easy to reason about transactions (one writer).
- **Single point of failure** by design; stated in the risk register ([docs/HIPAA.md](../HIPAA.md)) and in
  [docs/market/HOSTING.md](../market/HOSTING.md). Recovery is measured in hours (restore), not seconds.
- Horizontal scaling is not possible without a redesign; the ceiling is a programme, not a county department.
- Anything that must be shared across instances (e.g. a vendor-hosted tier) is one VM/container per programme.
- `node:sqlite` is still marked experimental by Node; that residual risk is in the risk register.

## Read

`server/index.js` (start-up order), `server/app.js` (request pipeline, the one route list), `server/db.js`
(open, transactions, savepoints), `server/instance-lock.js`, `server/scheduled-backup.js`.

## Tests that pin it

`test/instance-lock.test.js` (second process refused; stale lock taken over; another host's live heartbeat refused and stale one taken over; old lock formats; double-release ordering),
`test/perf.test.js` and `test/load-review.test.js` (the sizing assumption), `test/backup.test.js` and
`test/snapshot.test.js` (online backup without stopping the process).
