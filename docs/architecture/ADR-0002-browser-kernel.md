# ADR-0002: The same server code, compiled into the browser kernel

- **Status:** accepted
- **Date recorded:** 2026-09-25 (local mode since 1.1.0; the GitHub Pages build since 1.8.0; written down retrospectively)

## Context

Outreach happens where there is no signal, and some programmes have no server at all. Two separate
implementations (a server and an offline app) would drift: a permission, a consent check or an encryption rule
fixed in one would stay broken in the other.

## Decision

- `local/kernel.js` imports the **server's own modules** (`server/db.js`, `server/auth.js`, `server/audit.js`,
  the route modules listed in `LOCAL_ROUTE_MODULES` in `server/app.js`) and runs them in the browser against
  an in-browser SQLite (sql.js WebAssembly) kept in IndexedDB as an image sealed under a key that only a
  device account's password opens ([ADR-0008](ADR-0008-device-encryption.md)).
- `scripts/build-local.js` bundles it with esbuild, swapping Node built-ins for shims in `local/shims/`
  (`sqlite.js`, `crypto.js`, `fs.js`, …) and regenerating `server/schema-text.js` from `server/schema.sql`.
  The output, `public/local/kernel.js`, is **committed**; CI fails if it differs from a fresh build.
- Routes that make no sense on a device (setup, sync server side, FHIR, SCIM, security status, OIDC, intake)
  are excluded by the list in `server/app.js`, not by a second copy of anything.
- Two uses: **local mode** (an office server hands out an offline copy that syncs back — off by default) and
  **SUDS on this device** (the GitHub Pages build, `scripts/build-static-site.js`, records only in that browser;
  `window.SUDS_STATIC_HOST` marks behaviour differences only).
- One page writes the device database at a time: a Web Lock plus a heartbeat, and an **epoch fence** in
  IndexedDB (`local/shims/sqlite.js`) so a page that lost the lock cannot overwrite a newer save.

## Consequences

- One implementation of permissions, consent gates, audit and encryption on both sides.
- Any change under `server/` needs `npm run build:local` and a committed kernel (CLAUDE.md). Forgetting is
  caught by CI, not by review.
- Server code must stay browser-portable: no new Node built-in without a shim; no synchronous file I/O in
  route code paths the kernel loads.
- The kernel vendors a few pinned libraries (`@noble/*`, `fflate`, `buffer`, sql.js) — the only third-party
  code SUDS ships ([docs/WEB_APP.md](../WEB_APP.md)).
- Records on a device exist only there until synced (local mode) or backed up (on-device build): see
  [docs/PLATFORM.md](../PLATFORM.md) and `local/backup.js`.

## Read

`local/kernel.js`, `local/shims/sqlite.js` (lock, heartbeat, fence), `scripts/build-local.js`,
`scripts/build-static-site.js`, `server/app.js` (`LOCAL_ROUTE_MODULES`), [docs/WEB_APP.md](../WEB_APP.md).

## Tests that pin it

CI job `test`, step *Local kernel and generated schema match their sources*; `test/local-lifecycle.test.js`;
`test/local-mode-default.test.js` (off by default on an office server); browser scripts
`scripts/ui/local-mode.mjs`, `scripts/ui/multitab.mjs` (fencing, takeover), `scripts/ui/static-site.mjs`.
