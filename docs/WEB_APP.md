# The browser-only web app

There is a build of SUDS that needs nothing at all installed or set up: no office server, no Node
process, no database anywhere but the visitor's own browser. It is the same "local mode" the phone apps
run — `local/` (the browser kernel: SQLite in WebAssembly, encryption in pure JavaScript) and
`public/` (the same interface the office server serves) — packaged as a plain static site and put on
the open web.

## Using it

Open the deployed address on any phone, tablet or computer. There is nothing to type in — no
`?local=1`, no address to remember beyond the one link:

1. **First visit**: create a local account (any name; there is no office to match it against yet).
2. **Add it to the home screen** for something that opens like an app: on iPhone, Safari's Share sheet →
   *Add to Home Screen*; on Android and desktop Chrome/Edge, the address bar offers *Install*.
3. Everything — clients, visits, calls, notes, reminders, referrals — is recorded and stays only in that
   browser, encrypted the same way the phone apps encrypt it (`docs/HIPAA.md`), with the same warning:
   a plain browser has no Android Keystore or iOS Keychain, so its keys live alongside the data in that
   browser profile. Fine for trying SUDS out; not where a real caseload belongs unless the device itself
   is the county's and is treated accordingly.
4. **Sync**: the Sync screen can still exchange changes with a real office SUDS server if the county runs
   one, the same as the phone apps — but only if that server allows it. This build is served by a host
   the county does not run, so it carries a permanent banner (*Demo/evaluation build — do not enter real
   client information*) and, before sending any credentials, asks the office server's `/api/app/info`
   whether `allow_static_sync` is on. It is off unless the server was started with
   `ALLOW_STATIC_SYNC=1`; otherwise the sync is refused with a message saying so and nothing is sent.
   Without an office server, the browser copy simply stands alone.

## Where it lives

`.github/workflows/web-app.yml` builds it (`node scripts/build-static-site.js`) and publishes it to the
repository's `gh-pages` branch on every push to `main` that touches the app, plus on demand from the
Actions tab. GitHub Pages then serves it at:

```
https://<github-username>.github.io/<repository-name>/
```

The first time, someone with repository admin needs to turn GitHub Pages on once — the workflow tries to
do this itself (`gh api ... /pages`) and only asks if that call is not permitted: **Settings → Pages →
Source: Deploy from a branch → `gh-pages` → `/` (root)**.

## Building it yourself

```bash
node scripts/build-static-site.js [out-dir]     # default out-dir: _site
```

Point any static file host at the output — Pages, Netlify, S3, a county web server, or `node
scripts/serve-static.js _site` on a laptop for a quick local check. The build is `public/` verbatim plus
one small script that switches the app straight into local mode before anything else loads
(`window.SUDS_FORCE_LOCAL`); nothing about the office server, the Android app or the iOS app changes —
they each still decide their own mode.

`scripts/ui/static-site.mjs` is the automated check for this build (first run with no query string,
signs in, records a client fully offline, survives a reload, and confirms the page is installable); it
runs as part of `scripts/ui/run-all.sh`.
