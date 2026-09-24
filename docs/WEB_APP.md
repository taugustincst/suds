# The browser-only web app

**This build is a demonstration only.** The web application served by the office SUDS server is the
system of record (`PLATFORM.md`); the GitHub Pages build exists so someone can try SUDS with sample data
and nothing installed. Do not put real client information in it.

It needs nothing at all installed or set up: no office server, no Node process, no database anywhere but
the visitor's own browser. It is the office server's own "local mode" — `local/` (the browser kernel:
SQLite in WebAssembly, encryption in pure JavaScript) and `public/` (the same interface the office server
serves) — packaged as a plain static site and put on the open web.

## Using it

Open the deployed address on any phone, tablet or computer. There is nothing to type in — no
`?local=1`, no address to remember beyond the one link:

1. **First visit**: create a local account (any name; there is no office to match it against yet).
2. **Add it to the home screen** for something that opens like an app: on iPhone, Safari's Share sheet →
   *Add to Home Screen*; on Android and desktop Chrome/Edge, the address bar offers *Install*. The
   step-by-step page is `get-app.html` next to the site (the office server's `/app` is a rewrite a static
   host does not have, so every link in the app uses the file name).
3. Everything — clients, visits, calls, notes, reminders, referrals — is recorded and stays only in that
   browser, encrypted the same way the office server encrypts it (`docs/HIPAA.md`), with the same warning
   as local mode: a plain browser has no protected key store, so its keys live alongside the data in that
   browser profile. Fine for trying SUDS out; not where a real caseload belongs.
4. **No sync.** The demo build never exchanges data with an office server. Its Sync screen says so
   (*Sync is not available from the demo site; use the office address*) and offers no form: a page served
   from one origin cannot call another origin's API (the office server sends no CORS headers and its
   `connect-src` forbids it), so a sync attempted from here could only fail, and nothing — not even a
   password — is sent. Someone who wants their offline copy to sync uses local mode at the office address
   (`docs/PLATFORM.md`). The server flag `ALLOW_STATIC_SYNC` still exists and is reported by
   `/api/app/info` as `allow_static_sync`, but nothing reads it any more: it is a no-op kept only so
   existing deployments do not fail on an unknown setting.
5. **Offline**: the build registers the same service worker as the office app, with the kernel in its
   shell, so a copy added to the home screen opens with no connection at all.

## Where it lives

`.github/workflows/web-app.yml` builds it (`node scripts/build-static-site.js`), checks that it boots with
no backend, and publishes it to the repository's `gh-pages` branch. GitHub Pages then serves it at:

```
https://<github-username>.github.io/<repository-name>/
```

### When it is published

**Only on a release.** The demo is a public URL, so it shows released code and nothing else — a push to
`main` no longer republishes it. The workflow runs when:

- a `v*` tag is pushed;
- a GitHub Release is published by a person (`release: published`);
- `release.yml` finishes a release: it runs `gh workflow run web-app.yml --ref v<version>` as its last
  step, because a release or tag that a workflow creates with `GITHUB_TOKEN` does not start other
  workflows (hence `actions: write` in `release.yml`);
- someone starts it by hand (Actions → *Web app* → *Run workflow*, choosing the release tag as the ref) —
  for example the product owner republishing the current release for QA.

The runs share a concurrency group, so a tag push and the release workflow's dispatch for the same version
publish one after the other, never racing. Each run prints the version it publishes (and fails if a `v*`
tag disagrees with `package.json`) and puts it in the run summary. **When QA'ing a release on the demo,
check that the version shown on screen matches the release** before signing off; a browser still showing
the previous version needs a reload (the service worker picks up the new build on the next load).

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
(`window.SUDS_FORCE_LOCAL`); nothing about the office server changes — it still decides its own mode.

`scripts/ui/static-site.mjs` is the automated check for this build (first run with no query string,
signs in, records a client fully offline, survives a reload, and confirms the page is installable); it
runs as part of `scripts/ui/run-all.sh`.

## What the browser kernel is built from

The office server runs on Node's built-ins alone. The browser kernel cannot: a browser has no `node:sqlite`,
no `node:crypto` and no `node:zlib`. So `npm run build:local` compiles `server/` together with a small,
pinned set of vendored libraries into `public/local/kernel.js`, which both local mode on the office server
and this demo build use:

| Library | Stands in for | Used for |
| --- | --- | --- |
| `sql.js` (+ `sql-wasm.wasm`) | `node:sqlite` | the database, in WebAssembly, persisted to IndexedDB |
| `@noble/ciphers`, `@noble/hashes` | `node:crypto` | AES-256-GCM, HMAC, SHA-256, scrypt |
| `fflate` | `node:zlib` | ZIP for Excel import/export |
| `buffer` (+ `base64-js`, `ieee754`) | `node:buffer` | `Buffer` in the browser |

esbuild (the bundler) and sql.js are ignored by Dependabot (`.github/dependabot.yml`) and updated by hand
(docs/RELEASE.md, "Updating the kernel's build tools"), because a change to either changes the committed
kernel and CI's drift check fails any PR that does not rebuild it. The other libraries arrive as one
grouped monthly Dependabot PR, which also needs `npm run build:local` committed on its branch.

They are development dependencies of this repository (`package.json`), not of the office server: installing
and running SUDS on the office computer still pulls nothing at runtime. But they *are* code that runs in a
navigator's browser in local mode, so treat them as part of the review surface — they are pinned, vendored
into a committed bundle, and CI fails if the committed kernel drifts from the source it was built from.
