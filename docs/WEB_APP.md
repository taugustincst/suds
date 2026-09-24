# SUDS on this device (the web app on GitHub Pages)

SUDS runs two ways, and both are production:

| | **SUDS on this device** (this page) | **The office server** (`INSTALL.md`, `PLATFORM.md`) |
| --- | --- | --- |
| What it is | The web app published on GitHub Pages, running entirely in the browser | A SUDS server on an office computer; staff use it in a browser |
| Where records live | In that one browser on that one device, encrypted | In the office server's database, encrypted |
| Accounts | Created on the device with **Sign up**; the first one manages the device | Requested with **Sign up** and approved by an administrator, or created by one |
| Protecting the records | **Device backups** the person downloads (below) | The server's scheduled backups |
| Sync | None | Every device sees the same records |

It needs nothing installed or set up: no office server, no Node process, no database anywhere but the
visitor's own browser. It is the office server's own "local mode" — `local/` (the browser kernel: SQLite in
WebAssembly, encryption in pure JavaScript) and `public/` (the same interface the office server serves) —
packaged as a plain static site.

## Using it

Open the published address on any phone, tablet or computer. There is nothing to type in beyond the one link.

1. **Sign up.** On a device with no account yet the sign-in page opens on **Sign up**, which creates the first
   account. It says once, plainly, where the records will be kept (below) and asks the person to tick that
   they understand before the account is created. That first account **manages the device**: it can
   download and restore backups and decide whether anyone else may sign up here. It is asked for its SUDS role
   (navigator, clinician, supervisor, administrator), which decides what it can open.
2. **Other people on the same device** (a shared office tablet) choose **Sign up** too. Each gets a navigator
   account at once and, from then on, every navigator and clinician on the device sees only the clients they
   recorded or are assigned — not each other's. The device's manager turns further sign-ups off under
   **This device → Accounts on this device** once everyone has an account; Sign up then says so.
3. **Log in** is the other option on the same page. `#/login?mode=signup` and `#/login?mode=login` link
   straight to either one.
4. **Add it to the home screen** for something that opens like an app: on iPhone, Safari's Share sheet →
   *Add to Home Screen*; on Android and desktop Chrome/Edge, the address bar offers *Install*. The step-by-step
   page is `get-app.html` next to the site (the office server's `/app` is a rewrite a static host does not
   have, so every link in the app uses the file name).
5. **Try it with sample data** is still there, folded away below the Sign up form: it creates an account whose
   password is printed on screen and loads a set of fictional clients. It is for looking around; it is only
   offered on an empty device, and sample data is never mixed in with real records.
6. **Offline**: the build registers the same service worker as the office app, with the kernel in its shell,
   so a copy added to the home screen opens with no connection at all.
7. **Provider pictures** for the starter resource directory come with the site. A browser cannot download a
   picture from a provider's own website (those sites do not allow it: no CORS headers), so the site is
   published with a copy of each provider's picture, fetched when it was built. **Resource directory → Download
   provider pictures** copies them into the device's directory, makes a small card picture from each, and says
   how many it got; a program the build has no picture for keeps its generated card and is listed under "Why
   some had no picture" ("not available on this device build").

## Where your records live

Read this before using the on-device app for real client information, and record it in the county's risk
register (`HIPAA.md`, *Risk register notes*).

- **In this browser, on this device, and nowhere else.** Everything recorded is kept in the browser's own
  storage (IndexedDB), encrypted with AES-256-GCM exactly as the office server encrypts it. Nothing is sent to
  GitHub, to an office server or anywhere else; the app makes no network requests with record data at all.
- **The encryption keys are in the same browser.** A browser has no protected key store, so the keys that
  unlock the records are kept in that browser profile's `localStorage`, beside the data. Encryption protects a
  copy of the storage taken off the device; it does not protect against someone who can use the browser
  profile itself. Use a device with a passcode, disk encryption and (for county devices) MDM, and sign out.
- **Clearing the browser's site data, or losing the device, loses the records.** So does a browser that evicts
  the site's storage when the device runs short of space. The app asks the browser to keep its storage
  ("persistent storage") when the first account is created; **This device** shows the answer —
  *Storage: Protected* or *May be cleared by the browser* — with a button to ask again. Installing the app to
  the home screen makes a browser more likely to agree.
- **Back up regularly.** The only way back from a cleared browser or a lost phone is a device backup (next
  section). Home reminds the device's manager when there has been no backup for 7 days and the device holds at
  least one client (dismissible for the day).
- **GitHub.** GitHub Pages hosts the app's code, not its records: the records never leave the device. There is
  no HIPAA Business Associate Agreement with GitHub, and none is needed for hosting static code that never
  receives PHI — but the county should record in its risk register that the code its staff run is served from
  GitHub, and that a compromise of the repository or the Pages site could serve altered code. Counties that
  want the code served from their own infrastructure can host the same build themselves (*Building it
  yourself*, below).
- **No sync.** The on-device app never exchanges data with an office server. Its **This device** page says so
  and offers no form: a page served from one origin cannot call another origin's API (the office server sends
  no CORS headers and its `connect-src` forbids it), so a sync attempted from here could only fail, and
  nothing — not even a password — is sent. A programme that needs records shared between staff runs the office
  server instead. The server flag `ALLOW_STATIC_SYNC` is a no-op kept only so existing deployments do not fail
  on an unknown setting.

## Device backup and restore

**This device → Keep your records safe → Download a backup** (the device's manager only, since a backup holds
every account's records). The person types a passphrase twice (at least 12 characters); the browser saves a
`suds-device-backup-<date>.sudsbackup` file. Keep it somewhere other than the device, and keep the passphrase
separately: without it nobody, including the county, can open the file.

The file (`local/backup.js`, WebCrypto only):

- one line of JSON — `{ format: "suds-device-backup", version, kdf: "PBKDF2-SHA256", iterations: 600000, salt,
  iv, check, created_at, app_version }` — then a newline, then the ciphertext;
- the key is PBKDF2-SHA256 over the passphrase (600,000 iterations; files claiming fewer than 310,000 are
  refused) giving 512 bits: the first half is the AES-256-GCM key, a hash of the second half is `check`, so a
  wrong passphrase is reported as such rather than as a damaged file;
- the header line is the GCM additional data, so nothing in it can be edited unseen;
- the plaintext is the raw SQLite database plus the device's two keys (encryption and blind index), which are
  needed to read it.

**Restore from a backup** is on **This device**, and on the sign-in page of a device with no account (a new
phone, or one that was erased). It asks for the file and the passphrase, checks both, shows what the backup
holds (client and account count, when it was made) and changes nothing until the person types `RESTORE`. It
then replaces the device's database and keys and reloads; everyone logs in with an account from the backup.
The restore respects the single-writer fencing in `local/shims/sqlite.js`: it claims a new epoch and writes
under it in one IndexedDB transaction, refuses if another window holds the database, and the page that
restored saves nothing more before it reloads. A wrong passphrase, a file that is not a SUDS device backup, a
tampered or damaged file, and a backup from a newer SUDS are all refused before anything changes. Backups and
restores are audited (`device.backup.created`, `device.restore`).

## Where it lives

`.github/workflows/web-app.yml` builds it (`node scripts/build-static-site.js`), checks that it boots with
no backend, and publishes it to the repository's `gh-pages` branch. GitHub Pages then serves it at:

```
https://<github-username>.github.io/<repository-name>/
```

### When it is published

**Only on a release.** The site is a public URL that people keep records in, so it serves released code and
nothing else — a push to `main` never republishes it. The workflow runs when:

- a `v*` tag is pushed;
- a GitHub Release is published by a person (`release: published`);
- `release.yml` finishes a release: it runs `gh workflow run web-app.yml --ref v<version>` as its last
  step, because a release or tag that a workflow creates with `GITHUB_TOKEN` does not start other
  workflows (hence `actions: write` in `release.yml`);
- someone starts it by hand (Actions → *Web app* → *Run workflow*, choosing the release tag as the ref) —
  for example the product owner republishing the current release for QA.

The runs share a concurrency group, so a tag push and the release workflow's dispatch for the same version
publish one after the other, never racing. Each run prints the version it publishes (and fails if a `v*`
tag disagrees with `package.json`) and puts it in the run summary. **When QA'ing a release on the site,
check that the version shown on screen matches the release** before signing off; a browser still showing
the previous version needs a reload (the service worker picks up the new build on the next load).
Republishing never touches anyone's records: they live in each visitor's browser, not on the site, and a
new release upgrades the on-device database in place the first time it opens (the same migrations as the
office server).

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
(`window.SUDS_FORCE_LOCAL`) and sets `window.SUDS_STATIC_HOST`, an internal marker for the few behaviours
that differ on this build (no office sync, sign-ups on the device, the first-run storage confirmation, the
backup reminder). Nothing is drawn on screen because of it, and nothing about the office server changes — it
still decides its own mode.

**Provider pictures.** The build also downloads each starter-directory provider's picture (its website's
social preview image or touch icon: the same choice, address checks and file-type check as the office
server's own download, `server/region-pictures.js`) into `region-pictures/<region>/` with a `manifest.json`
(key → file, content type, source address, when it was fetched). This is best effort: a site that fails is
left out and listed in the manifest's `failures`, and a build with no network still succeeds, just without
pictures. `SUDS_REGION_PICTURES=off` leaves them out (CI's browser suite does, so it does not hit 80 websites
on every push); `SUDS_REGION_PICTURES=<folder>` copies a folder written earlier by `npm run
fetch-region-pictures [folder]` (default `_region-pictures/`). The published Pages build fetches them afresh
on the release runner and puts the count in the workflow's summary. They are not committed to the repository:
they are other organisations' logos and photos, they change, and a copy in git history would only grow.
Behind a proxy, run the build with `NODE_USE_ENV_PROXY=1` as well as `HTTPS_PROXY` (below, and
DEPLOYMENT.md, "Outbound internet").

`scripts/ui/static-site.mjs` (first run with no query string, the storage confirmation, a client recorded
fully offline, a reload, installability) and `scripts/ui/signup.mjs` (Sign up and Log in on both builds, a
second account's caseload, sign-ups off, backup → erase → restore, wrong passphrase, tampered file, the backup
reminder) are the automated checks for this build; both run in `scripts/ui/run-all.sh`.

## What the browser kernel is built from

The office server runs on Node's built-ins alone. The browser kernel cannot: a browser has no `node:sqlite`,
no `node:crypto` and no `node:zlib`. So `npm run build:local` compiles `server/` together with a small,
pinned set of vendored libraries into `public/local/kernel.js`, which both local mode on the office server
and the on-device app use:

| Library | Stands in for | Used for |
| --- | --- | --- |
| `sql.js` (+ `sql-wasm.wasm`) | `node:sqlite` | the database, in WebAssembly, persisted to IndexedDB |
| `@noble/ciphers`, `@noble/hashes` | `node:crypto` | AES-256-GCM, HMAC, SHA-256, scrypt |
| `fflate` | `node:zlib` | ZIP for Excel import/export |
| `buffer` (+ `base64-js`, `ieee754`) | `node:buffer` | `Buffer` in the browser |

Device backups use the browser's own WebCrypto (PBKDF2, AES-GCM), not a vendored library.

esbuild (the bundler) and sql.js are ignored by Dependabot (`.github/dependabot.yml`) and updated by hand
(docs/RELEASE.md, "Updating the kernel's build tools"), because a change to either changes the committed
kernel and CI's drift check fails any PR that does not rebuild it. The other libraries arrive as one
grouped monthly Dependabot PR, which also needs `npm run build:local` committed on its branch.

They are development dependencies of this repository (`package.json`), not of the office server: installing
and running SUDS on the office computer still pulls nothing at runtime. But they *are* code that runs in a
person's browser, so treat them as part of the review surface — they are pinned, vendored into a committed
bundle, and CI fails if the committed kernel drifts from the source it was built from.
