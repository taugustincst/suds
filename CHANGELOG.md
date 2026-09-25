# Changelog

All notable changes to SUDS are documented here. The project follows semantic versioning.

## Unreleased

- **Pictures without the file window.** A resource's Pictures card has **Add from a web address** (an https
  address of a picture, or of a web page whose preview picture is used), and picture files can be dragged onto
  the card or pasted on the page. The office server downloads the address with the same checks as provider
  pictures and records only the site name in the audit log; on SUDS on this device the browser fetches it and
  explains when a site does not allow that. New route `POST /api/resources/:id/photos/from-url`
  (resources:write). **+ Add pictures** is unchanged.
- **Downloads refuse names that point inside the county network.** Provider pictures and "Add from a web
  address" now resolve each address (every redirect hop) before connecting and refuse loopback, private,
  link-local and similar addresses; before, only the name was checked, so a public-looking name that resolved
  to an internal server was fetched.
- **QA round 4 (what an automated tester reading the accessibility tree reported on 1.10.1).**
  - Home's numbers and bars link only to pages the viewer may open; a read-only account no longer lands on
    "Not available for your role".
  - The client header's badges are a list, and the status reads "Status: Inactive" to a screen reader instead
    of running into the risk badge.
  - A dialog no longer copies its title into the page's live region (a second "Add resource" / "New task" in
    the accessibility tree).
  - The Home empty-state sentence is under 100 characters (a tool that cuts text at 100 read "…or compute").
  - Sample data has a read-only account (`rreader`); new browser script `a11y-round4`.

## 1.10.1 — 2026-09-25

- **Signing out no longer draws the sign-in page twice.** The second draw blanked the screen for a moment (or,
  on a slow device, showed two sign-in forms); it is also what made the local-mode browser check fail
  intermittently in CI, where the click landed on the screen-reader status region during the blank. Full-screen
  pages (sign-in, set-up, MFA) are now built first and swapped in whole, and only the latest render wins.
  The same screen already showing is kept rather than replaced, so a re-render never throws away what was
  being typed into the sign-in form.
- **QA retest fixes (reproduced on the published build, as the tester uses it).**
  - SUDS on this device: supply items can be added and counted again — it has no office, so it no longer
    refuses supply changes with "kept at the office". On a device that syncs with an office, the Supplies
    buttons are disabled with the reason shown, and save errors also appear as a toast.
  - `#/getapp`, `#/phone`, `#/app` and `#/install` open "Use SUDS on your phone or tablet"; `#/devices` opens
    This device (on the office server, Settings › Synced devices for administrators).
  - Home and the welcome tour greet people by their whole display name, not its first word.
  - Date fields accept years 1900–2100, so Chrome's year box takes four digits, and a garbled date such as
    0006-09-05 is refused with a message instead of saved. Each date field has its own calendar button.
    Toasts no longer take taps or clicks meant for the page or dialog under them (a "saved" toast could sit
    over a dialog's date field).
  - "+ Add pictures" says a file window has opened (and when none was chosen). The import drop zones can be
    used from the keyboard and by screen readers.
  - Settings: new **Organisation time zone**, which overrides `ORG_TIMEZONE` for visit dates, report periods
    and "today", is sent to synced devices, and defaults to the browser's zone on SUDS on this device. Device
    copies no longer show the server backup schedule (it read "every 0 hours / keep 0") and link to This
    device (backup and restore) and the phone/tablet page instead. The office backup schedule says whether it
    is on and links to System & backups.

## 1.10.0 — 2026-09-24

- **The GitHub Pages build is now SUDS on this device, a production web app — not a demo.** The
  "Demo/evaluation build" banner and its `--demo-banner-h` layout machinery are gone, and no screen calls it a
  demo or an evaluation copy. It keeps its records encrypted in the browser that holds them, never syncs, and
  says so honestly (`docs/WEB_APP.md`, *Where your records live*). "Try it with sample data" remains, folded
  away below the Sign up form, and sample data is now only offered to an empty device (as on an office
  server), never mixed in with real records.
- **Log in / Sign up on the sign-in page**, on both builds: a two-option tab list (arrow keys, 44px targets on
  a phone), deep-linkable as `#/login?mode=login|signup`, with the programme contact in the footer.
  - *Office server:* Sign up requests an account (name, username, optional email, password, a line about the
    role). `POST /api/auth/signup` is unauthenticated, needs the CSRF header, is rate limited per address
    (`SIGNUP_RATE_LIMIT`, default 5/hour), answers the same whether or not the username exists, and is audited
    as `user.signup.requested`. The account cannot sign in until an administrator approves it under
    **Settings → Users & roles → Access requests (N)** (`POST /api/users/:id/approve` with the role and an
    optional supervisor, or `/decline`); the correct password on a pending account is told it is waiting,
    anything else gets the ordinary failure. The MFA grace period runs from approval. Home and the Users tab
    show administrators how many requests wait. New setting `self_signup` (on by default); off, Sign up says to
    ask an administrator and the route answers 403.
  - *On this device:* the first Sign up is the first-run set-up and makes that account the device's manager;
    later sign-ups create navigator accounts at once, and from the second account on everyone sees only their
    own caseload. The manager can turn sign-ups off (`/api/local/signup`, `/api/local/device`).
- **Safeguards for records that live only on a device.** First-run Sign up states once where records are kept
  and that clearing site data or losing the device loses them, and requires a checkbox. **This device** (the
  page formerly called Sync on this build) shows whether the browser has granted persistent storage
  (requested at account creation) and the last backup. **Download a backup** makes a passphrase-encrypted
  file (WebCrypto PBKDF2-SHA256, 600,000 iterations → AES-256-GCM; `local/backup.js`) holding the database and
  the keys that read it; **Restore from a backup** (also on an empty device's sign-in page) checks the
  passphrase and the file, shows what it holds, requires typing RESTORE, and writes the database under a newly
  claimed epoch (`local/shims/sqlite.js` `replaceWith`). Home reminds the device's manager after 7 days
  without a backup (dismissible for the day).
- **Settings:** `mfa_grace_days` is now on the form; `program_contact` is shown on the sign-in page; the unused
  `default_funding_source_id` is no longer accepted.
- Migration 25 adds `users.access_status`, `users.access_note` and `users.requested_at`. `access_note` is not
  sent to devices by sync.
- The browser suite gains `scripts/ui/signup.mjs`; `run-all.sh` takes `SUDS_UI_TMP` and `SETUP_BOOT_PORT` so two
  suites can run side by side. Docs: `WEB_APP.md` and `PLATFORM.md` rewritten for the two ways to run SUDS;
  README, INSTALL, HIPAA (risk register), DEPLOYMENT updated.
- **Completeness fixes.**
  - Local mode and SUDS on this device: "Everything as one Excel workbook" now works (no `setImmediate`; the
    zip falls back to synchronous compression).
  - A fatal overdose discharges the client as deceased after confirmation; changing the outcome or deleting
    the event restores the client, episode, care team and to-dos. Overdose events can be deleted.
  - Signed notes have **Verify signature** ("Signature intact" / "Changed after signing") and show the full
    hash on demand.
  - Finance no longer sees client links that lead to a 403; the client page says "Not available for your role".
  - Patient-rights requests can be edited and deleted from the client's Requests tab.
  - Reports: an Episodes of care card (admissions, discharges by reason) and single-table exports for
    episodes, overdose events, client forms and disclosures. `GET /api/episodes` returns period counts.
  - Discharge reasons, overdose options and request kinds come from the server's meta lists.
  - Supervision hides the note sections from roles that cannot countersign.
  - Imports: a staged item can only be discarded by the person who imported it, or a manager.
  - Docs: `API.md` regenerated; user guide updated.
- **Load-review fixes (2,000 clients, 64,000 records).**
  - Retention: the purge clock now runs from the last activity on a record (visits, calls, notes, referrals,
    to-dos, consents, disclosures, forms, overdose events, patient requests, time, expenditures, episodes,
    intake/discharge), not from the discharge date alone — a client discharged in 2018 but visited in 2024 is
    no longer purged in 2025. Records left inactive are now purged on the same clock (an unclosed episode does
    not exempt them); active and waitlisted records never are.
  - Search and duplicate detection work for names in any script and ignore accents: Arabic and Cyrillic names
    are searchable and flagged as duplicates, "Oster" finds "Øster", "Lecki" finds "Łecki". Migration 26
    rebuilds existing clients' name indexes.
  - Funder report: "people served" is one set per filter (visit or call in the period, deleted clients
    excluded, and only visits charged to the fund when a funding source is chosen), and every demographic
    breakdown and per-person count uses it.
  - Reports, the dashboard and exports treat from/to as calendar days in `ORG_TIMEZONE`: an evening visit on
    the last day of a fiscal year is in that year. A malformed date is refused.
  - With local mode off, device sync (pull, push, attachments) is refused with 403.
  - The daily audit-chain check is incremental and runs in batches that no longer freeze the server; the whole
    chain is still checked weekly and by the Verify button.
  - Outreach and community naloxone distribution can be recorded without a client; other types still require
    one, and the server enforces the same rule. Logging time on a visit with no client no longer fails.
  - Deactivating a user says how many clients and open to-dos are still assigned to them, and anyone who can
    manage assignments can move them to an active worker in the same step (audited as `caseload.transfer`).
    Move a caseload lists deactivated staff who still hold clients, marked "(inactive)", and Home warns
    supervisors when clients are assigned to inactive staff. New `GET /api/users/:id/caseload` and
    `GET /api/users/caseloads` (counts only). Moving a whole caseload also moves to-dos that name no client.
  - Creating a user, resetting a password and the setup wizard no longer hash passwords on the event loop.
  - Client list: the risk, no-contact-in-30-days, substance, MAT, consent-expiring and open-patient-request
    filters run on the server (`server/client-filters.js`, shared with the Home tiles), so a tile and the list
    it opens count the same people and every match is reachable. Client, visit, note, referral, call and
    waitlist lists have "Load more"; the waitlist is no longer capped at 500. The consent alert on Home counts
    clients, like the list it opens.
  - Saving a record someone else changed since you opened it is refused with "This record was changed by
    someone else since you opened it. Reload to see their changes." (409, `if_updated_at`) instead of silently
    overwriting their changes. The client form sends only the fields you changed.
  - A save retried after a dropped connection no longer creates duplicates (`Idempotency-Key`, remembered for
    24 hours, answers stored encrypted and never synchronised): one referral, one disclosure record, one
    follow-up, one visit and time entry.
  - Returning clients: when intake finds a discharged record outside your caseload (surname and date of birth,
    or phone), you can re-admit it yourself with a reason. It is assigned to you, opens a new episode, is
    audited, and goes to supervisors for review alongside emergency accesses.
  - Migration 27 adds `idempotency_keys` and `breakglass_events.kind`.
- **Settings → Lists: change the choices on documentation forms without a code change.** Administrators can
  reword, reorder, hide and add to the choices for visit type, location, modality and outcome, call and text
  outcomes and who was called, referral status ("What happened") and barrier, overdose "What happened" and
  "Given by", time category, note format, primary substance and discharge reason, or restore the defaults.
  Stored codes never change, so history and reports stay consistent; the wording is used on forms, lists,
  reports and Excel/CSV exports, and imports accept either. Choices SUDS acts on (a fatal overdose, a reached
  call, the visit types that need no client…) can be reworded but not hidden. A hidden choice is no longer
  offered on new records; editing a record that already has it keeps it. Referral statuses and overdose
  outcomes take no additions (each drives a rule or a count); reporting code sets (race, ethnicity, ASAM,
  consent types, patient-rights requests) are not editable and the page says why. Every change is audited.
- **Funding sources** can be added, renamed and deactivated from Settings → Lists; a **Manage** link sits
  beside every Funding source field for budget managers, and **Edit this list** beside list-driven fields for
  administrators. Editing a record charged to a deactivated funding source now keeps that source instead of
  clearing it.
- Migration 28 adds `option_overrides`, which devices receive from the office and cannot change.
- **"Download provider pictures" works, and the pictures show.**
  - On SUDS on this device, a browser cannot download pictures from providers' websites (no CORS), so every
    one failed. The site is now published with each starter-directory provider's picture, fetched at build
    time (`scripts/fetch-region-pictures.js`, `SUDS_REGION_PICTURES`); a program the build has no picture
    for says so.
  - A downloaded picture now shows on the directory card: the browser makes a real thumbnail instead of the
    card keeping the generated placeholder. Pressing the button again repairs pictures downloaded earlier.
  - The result (how many, and why the rest are missing) stays on screen and is shown as a toast. On a device
    that syncs with an office server the button is replaced by a note that pictures arrive with sync.
  - An office server that cannot reach the internet says so and names `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`
    (or `NODE_EXTRA_CA_CERTS`), instead of "fetch failed" for every program (`DEPLOYMENT.md`, *Outbound
    internet*).
  - API: `POST /api/regions/:id/pictures` results include `photo_id`/`resource_id`; `GET` returns `thumbs`;
    `PUT /api/resources/:id/photos/:pid` accepts `thumb_url`.

## 1.9.4 — 2026-09-24

- **The paused screen tells the truth in every event order.** A displaced tab says its work was "saved first"
  exactly when nothing is left unsaved (a save refused by the fence leaves it unsaved), on every path that
  pauses it; before, a frozen tab that had saved on its `freeze` event said "may need to be re-entered" or
  "saved first" depending on which of its queued callbacks ran first on waking (seen once in three CI runs).
  `scripts/ui/multitab.mjs` now expects the truthful answer for both variants and fails on the old code.
- **Safari: a record saved and the page reloaded straight away was lost.** The new WebKit CI job caught it:
  Safari's engine drops the last write made while a page unloads, and 1.9.3 batches saves every 250 ms. An
  explicit save from the interface now waits for the on-device write before the page says it is saved;
  background writes (note autosave, preferences, polls) stay batched. On a very large on-device caseload an
  explicit save takes a few tens of milliseconds longer.
- Safari's engine could leave the offline shell empty after an update and miss a cached page offline: the
  worker now falls back to a plain fetch-and-store when its reload-mode precache is refused, never skips its
  handler if building a request throws, and ignores `Vary` when looking up the shell offline.
- WebKit smoke checks report what the shell cache holds instead of crashing, and wait for the worker to finish
  filling it.

## 1.9.3 — 2026-09-24

Fixes from the critical review of 1.9.2, re-checked by an independent verifier with its own multi-tab, frozen-tab, old-tab-upgrade and phone scripts before release (no data loss in any scenario). **Upgrade note:** local mode is now off by default on the office server; a county that relies on it sets `LOCAL_MODE_ENABLED=true` (or answers Yes in the setup wizard). Schema 24 (`tasks.description` encrypted).

- The update banner appears only when the release running in the page differs from the published one (no banner right after an update); the build stamp is shown under the page title on phones; Home's overdue badge and due date wrap at 200% text instead of running off the screen.


- **The demo build loads sample data beside clients you already entered.** On the static (GitHub Pages)
  build, "Load sample data" no longer refuses once a client exists; the sample rows are tagged and "Remove
  sample data" takes away only them. An office server, and a browser copy it hands out, still offer it
  only to an empty program (`server/demo.js` `loadRefusal`/`offer`, `local/kernel.js`). The "local mode is
  off" page now names the setup wizard's answer and `server.json` `localModeEnabled`, not only the
  variable. Leftover native-app branches (`SudsNative`, `__sudsSecrets`, the `suds:` and Android WebView
  hosts) are gone from the web app.
- **Browser suite: order-independent, condition waits, summary table.** `scripts/ui/run-all.sh` reseeds
  and restarts the office server before every script that uses it, prints a per-script table (checks,
  result, seconds) and exits non-zero on any failure; its readiness probe no longer waits out 20 s on a
  401. Fixed sleeps are replaced by `settle()` / `saved()` (`scripts/ui/assert.mjs`), which wait on
  `window.__sudsActivity` (requests in flight, the pending prefs save and Home tour, the last rendered
  address) and on the kernel's unsaved state; the few sleeps left wait for time to pass on purpose.
- **Local mode is off by default on the office server.** `/?local=1` serves a short explanation unless the
  setup wizard's new question — *Allow staff to keep an offline copy on their devices? Recommended: No* —
  is answered Yes (stored in `data/server.json` as `localModeEnabled`) or `LOCAL_MODE_ENABLED=true` is set;
  the variable overrides the wizard either way. **Upgrading counties that rely on local mode must set
  `LOCAL_MODE_ENABLED=true`** (or add `"localModeEnabled": true` to `server.json`). The GitHub Pages demo
  is unaffected. `server/config.js`, `server/routes/setup.js`, `public/views/setup.js`;
  `test/local-mode-default.test.js`, `scripts/ui/setup.mjs`.
- **To-do details are encrypted.** `tasks.description` moves into `description_enc` (migration 24; the
  migration-19 rebuild now encrypts it first so a 1.6.x upgrade keeps it). The API field is still
  `description`; de-identified exports never include it, identified exports decrypt it; sync declares it.
  A 1.9.2 device that pushes a to-do's plaintext `description` has it carried into `description_enc` by
  the office (a `legacy` column map in `server/sync-tables.js`); an old kernel's empty value never erases
  the office copy. `test/task-description.test.js`, `test/sync.test.js`.
- **The native apps and launchers are removed** (`mobile/`, `launchers/`, `mobile-android.yml`,
  `mobile-ios.yml`, `probe.yml`, `scripts/android-keystore.sh`, `scripts/print-url.js`) and the native
  key-store lookups in `local/shims/config.js`; the code stays in git history. PLATFORM.md's roadmap had
  said they were deleted in 1.9.0; it now records 1.9.3.
- **The public demo is published on releases only** (`v*` tags, published releases, and `release.yml`'s
  explicit `gh workflow run web-app.yml --ref <tag>`), never on a push to `main`. Each run names the version
  it publishes; release QA checks the on-screen version (RELEASE.md, WEB_APP.md).
- **CI:** advisory `node24` job (`npm test` on Node 24 from the official tarball) and advisory `webkit` job
  (static-site and qa-retest in Playwright WebKit via the new `SUDS_BROWSER` variable). Dependabot ignores
  esbuild and sql.js (updated by hand with `npm run build:local`) and groups the other devDependencies monthly.
- **Docs:** new `docs/ADOPTION.md` (code owner, pilot, staged releases, real-device checklist, drills,
  independent review, staffing); HIPAA.md *Risk register notes* (blind-index leakage, index key also keying
  the audit chain, single instance, local-mode keys beside the data); Node 24 migration plan in DEPLOYMENT.md.
- **Phone review of the demo build (UX polish).** Dialogs start below the demo banner (`--demo-banner-h`),
  so titles and ✕ stay visible at any text size; Back closes the open dialog instead of leaving the page;
  a referral started from a provider page loads the chosen client's consents (and says what to do once);
  Home's "Load sample data" loads it in place; the demo no longer promises a sync it never does (setup,
  tour, Sync page) and offers "Try it with sample data"; the first screen says what SUDS is; 44px touch
  targets for to-do boxes and chart rows; text sizes in rem and no sideways overflow at 200% text; Title
  Case note formats and "Part 2 disclosure"; "<Field> is required"; 4.5:1 green badges; the last tour
  step says Done; greetings use the given name ("Dr. Patel" kept whole); `get-app.html` installs the app.
  Covered by `scripts/ui/ux-polish.mjs`.
- **Two windows can no longer erase each other's work on a device (fencing).** 1.9.2's takeover lost
  confirmed records four ways: taking a window back kept its stale in-memory copy and saved it over the
  other window's work; a tab still on 1.9.0/1.9.1 kept saving after being displaced; a frozen background
  tab was taken over without asking and saved over the new holder when it woke; a duplicated tab took over
  silently. Now every holder claims an `epoch` in IndexedDB, saves only under `db2:<its epoch>`, and an
  ordinary save checks the epoch in the same transaction as its put (a displaced page pauses instead);
  the unload save writes a key nobody reads once the page is displaced. The first start moves the database
  from the old `db` key, which older releases keep writing to unread — so work typed into a tab still on an
  old release after another took over is not carried across. Nothing is taken over without asking except
  a reload of the same tab, which waits for its previous page to let go. "Use SUDS here instead" reloads the
  page. The paused screen closes open dialogs, survives hash changes and the dashboard refresh, and says
  "saved first" only when it was. `local/shims/sqlite.js`, `local/kernel.js`, `server/db.js` (`openWith`
  always opens what it is given), `public/app.js`; `scripts/ui/multitab.mjs` (new), `scripts/ui/local-mode.mjs`.
- **Writes on a device answer in about 1–3 ms again** (1.9.1 exported the whole database on every write:
  ~37 ms at 1,500 clients). Saves are coalesced (250 ms) and the page saves on pagehide, when hidden and on
  `freeze`; the next page of the same tab waits for the lock before reading, so an edit made just before
  navigating away still survives (`scripts/ui/device-audit.mjs`, under the service worker). A failed save
  still raises the "stopped saving" banner.
- **A new release no longer reloads the page under someone.** When a new service worker takes over, or
  `version.json` (new; written by `npm run build:local`, never cached) names another version, the page
  shows *A new version of SUDS is ready — Reload*, and reloads on its own only when hidden or at the next
  page change — never with a dialog open, a form half-filled or a sync running, and once per release.
- **Build stamp**: "SUDS <version>" on the sign-in/start screens and in the sidebar.
- **Error beacon**: uncaught errors, unhandled rejections and 5xx answers are reported without PHI (message
  cut to 300 characters with long digit runs masked, file:line frames, route without query, version,
  browser family). The office app posts them to `POST /api/client-errors` (signed-in session, 10 a minute
  per person, application log at WARN, not the audit log); a device keeps the last 50 and lists them on its
  Sync page under *Errors on this device*. `server/routes/client-errors.js`, `test/client-errors.test.js`.
- **Service worker**: the office server's `no-store` is passed through instead of being weakened to
  `no-cache`, and a re-headed response no longer carries the original `Content-Encoding`/`Content-Length`.

## 1.9.2 — 2026-09-23

- **No more "SUDS is already open in another window" dead end on a phone.** The single-writer lock stays
  (two tabs writing the same on-device database would overwrite each other), but the screen now offers
  *Use SUDS in this window*: the other tab is asked to write out and step aside, is shown a "paused" screen
  with a way to take it back, and refuses every request from then on. A reload of the tab that holds the
  lock, or a holder whose heartbeat has stopped, takes over on its own with no screen at all; the case the
  release-time reload made common. `local/shims/sqlite.js`, `local/kernel.js`, `public/app.js`; covered by
  `scripts/ui/local-mode.mjs`.

## 1.9.1 — 2026-09-23

Second external retest of the published (static, always-local) build, in a browser profile that had been
set up on a build from before the first round of fixes. Replayed by `scripts/ui/qa-retest.mjs`
("upgraded profile": the static site of the old commit, then this build at the same origin) and
`scripts/ui/static-site.mjs`.

- **Stale app files after a release on a static host.** A host that sends `max-age` (GitHub Pages: ten
  minutes) let a plain reload keep running the previous build's `app.js` and views from the browser's own
  caches, with the service worker never asked — every fix of the first retest looked "still broken" for
  as long as that lasted. The worker now fills its shell with `cache: 'reload'`, fetches app files with
  `cache: 'no-cache'`, and hands the page every app file marked `no-cache` so the next reload comes back
  to it; a new worker taking control reloads the page once. Offline, `index.html` stands in only for a
  navigation; a missing script or image is a real failure. `get-app.html` is in the shell.
- **A write on the device is on disk before it answers.** With the worker answering navigations from its cache, the next page could arrive before the previous page's unload write was committed; every write request now persists before responding, so an edit made in the instant before leaving survives.
- **"+ Add pictures" is now a label over the file input itself** (`.file-btn`): a tap on the button is a tap
  on the input, so the picker opens as a direct gesture everywhere and an automated click aimed at the
  input is no longer "obscured" by the button that used to forward to it.
- **The greeting uses a one- or two-word display name whole** ("QA Tester", "QATEST"); only a longer formal
  name is shortened to the first name (`greetingName`). Never re-cased; username fallback.
- **The demo banner no longer intercepts taps** on a dialog scrolled up under it (`pointer-events: none`).
- **"Use SUDS on your phone or tablet" on the static build**: linked as `get-app.html` from the login tip,
  the Home card and the Settings card (a static host has no `/app` rewrite); the page hides the
  certificate download and office-address wording there and shows the offline-copy section.
  `scripts/serve-static.js` now behaves like a plain static host (no rewrites, real 404s).

## 1.9.0 — 2026-09-23

A hardening and audit release. Schema 23 (migrations 19–23); databases upgrade in place on first start — take a backup first. This is the first release under the web-first platform policy (`docs/PLATFORM.md`): the office server's web app is the only supported client; the native apps and launchers no longer build or ship.

Compliance review fixes (HIPAA / 42 CFR Part 2) and county IT hardening.

- **Web-first: native apps and launchers deprecated.** The web application served by the office SUDS
  server is the only supported client and the system of record; everything is managed and documented
  against it (`docs/PLATFORM.md`). The Android and iOS apps and the desktop launchers are deprecated and
  will be removed in a later release: their workflows run only by hand and attach nothing, the release
  carries the server zip alone, the office server no longer hosts an APK (`GET /api/app/android.apk`,
  `POST/DELETE /api/admin/app/android` and the `android` field of `/api/app/info` are gone), and Settings no
  longer offers an upload. `scripts/gen-schema-text.js` no longer stamps `build.gradle.kts` or
  `Info.plist`. `/app` is now "Use SUDS on your phone or tablet" (browser, home screen, certificate) and
  mentions the offline copy only when the server reports `local_mode`. Browser local mode stays, under the
  rules in PLATFORM.md; existing phone-app installs should sync once more and be uninstalled.

- **Sync cannot rewrite the legal record.** Consents, disclosures and note addenda are insert-only through
  `POST /api/sync/push`; the only change a device may make to an existing consent is to revoke it, and the
  revocation is attributed to the syncing user. Anything else is rejected as `immutable`.
- **Referral outcomes are consent-gated.** `POST /api/referrals/:id/outcome` applies the same lawful-basis
  check and disclosure record as creating or updating a referral.
- **Safe Harbor de-identification.** De-identified exports reduce every date to year-month, ZIP codes to
  three digits, omit city, band ages (DOB is never exported) and are labelled as such (CSV comment line,
  Excel *About* sheet). The funder report suppresses breakdown rows under 11 (`<11`). Exports now require
  `export:read` (supervisor, finance, admin); an identified export must name `recipient` and `purpose` and
  writes one accounting-of-disclosures row (basis `export`) per client it contains.
- **Disclosures without consent must be justified.** A medical-emergency basis needs a written justification
  (20+ characters, stored encrypted); "other" additionally needs the new `disclosures:override` permission
  (supervisor, admin).
- **Part 2 consents carry every §2.31 element.** A `part2_disclosure` consent requires recipient, purpose,
  scope, an expiry date or event, evidence of signature (document reference, witness or signed on paper) and
  confirmation that the redisclosure notice was given.
- **Break-glass review.** The reason must be at least 15 characters; every use is queued in
  `breakglass_events` and shown under Supervision → Break-glass access, with a count on the supervisor's
  home page, until acknowledged (`GET /api/supervision/breakglass`, `POST …/:id/ack`; nobody can acknowledge
  their own).
- **Audit head checkpoint.** After each scheduled verification and each purge the newest entry's id, hash
  and the row count are HMAC-sealed into settings and written to the log; verification reports `truncated`
  when the newest entries have been deleted.
- **Retention, legal hold and patient rights.** `clients.legal_hold` with `POST /api/clients/:id/legal-hold`
  (admin only); a `patient_requests` table and `/api/patient-requests` CRUD with a 30-day due date and a
  *Requests* tab on the client page; `GET /api/clients/:id/disclosures/accounting` and a *Print accounting*
  button; a daily retention job (`server/retention.js`, `client_retention_years`, default 7, minimum 6) that
  hard-deletes discharged records across every table unless held.
- **More columns encrypted.** `calls.purpose`, `referrals.outcome/barrier/notes`, `tasks.title` and
  `overdose_events.substances` move to `_enc` columns (API field names unchanged).
- **Roles and defaults.** `readonly` sees the de-identified client list and reports only (no `clients:all`,
  no exports); MFA is required of every role by default; `LOCAL_MODE_ENABLED=false` makes the server serve an
  explanation instead of the in-browser kernel; `CLIENT_RETENTION_YEARS` configures retention.

Schema 20. Navigator-facing fixes from a hands-on field review.

- **Tap to call, text or navigate.** Every phone number on the client page, the contact lists, the
  calls list and the resource directory is a `tel:` link with a `sms:` "Text" beside it; addresses open
  in maps. Call / Text buttons on the client page dial and then open the log, prefilled.
- **Offline is said out loud.** A save with no signal keeps the dialog open and says so in plain words; a
  persistent banner points at the phone app, including on a sign-in screen served from the cached shell.
- **Names, not codes**, on the to-do list, Calls & texts and My time (`client_name` on those list routes,
  never for a de-identified role). Compact two-line rows for Clients, To-do and Calls on a phone; the
  client page's tabs fold into a keyboard-accessible "More" menu instead of scrolling off the edge.
- **Intake opens the first episode of care** (`no_episode: true` opts out); the New client form no longer
  asks for a discharge; a closed episode can be reopened (`POST /api/episodes/:id/reopen`, re-admission).
- **Ask for a co-sign.** An author can request supervisor review on a draft or signed note
  (`notes.cosign_requested`, `POST /api/notes/:id/request-cosign`); it joins the countersignature queue.
- **Reminders that reach you**: a bell in the header with the count due within the hour or overdue
  (`GET /api/tasks/due`), an opt-in browser notification (Profile), and Home labels overdue items first.
- Accessibility: the closed phone drawer is `inert`; 44px tap targets on touch screens; warning text
  meets 4.5:1 in both themes. The + Log button clears the last card, hides behind the drawer, and toasts
  sit above it.
- Preferred name / alias search (`clients.preferred_name_idx`); caseload sort (last contact, overdue
  follow-ups, risk); shift hand-off notes with a Home card; a structured safety plan note shown as a chip on
  the client page; and a supply cupboard (`supply_stock`, `/api/supplies`) that visits draw down.

- Fixes from the outside retest of the published web app (local mode): "Add resource" saved nothing
  because a DOM error was thrown before the request (every form error now reaches the dialog's banner);
  Settings crashed on the device over a config key the local kernel's config shim did not define; a due
  date entered without a time was silently dropped (date & time fields are now a date plus an optional
  time, and a date-only value is kept as the calendar day); a client with a blank status showed no status
  (rendered as Active; migration 21 backfills such rows); the client search list no longer floats over
  the field below it, which blocked the date picker on phones; the greeting uses the display name as
  typed (username if blank); dialog titles no longer linger in the accessibility tree via the live
  region. Covered by `scripts/ui/qa-retest.mjs` on both the static build and `/?local=1`.

Sync and data integrity (from the weakness review).

- **Offline work reaches every device.** Rows a device pushes are stored with the office's clock, so other devices' incremental pulls receive them; the pull cursor is per office user, so a second person on a shared device gets their whole caseload.
- **Purged and merged records stay that way.** A push for a client the retention job purged (or any of its records) is refused as `purged` and the tombstone kept; the device deletes its copy. Records of a merged-away duplicate are re-pointed to the keeper and a pushed row can never move a record between clients.
- **Rejections say whether they are final.** Every rejection carries `permanent`; the device settles a permanent one (office wins), shows it once on the Sync page and never resends it. Transient failures still retry.
- **Supply stock is server-owned**: devices cannot push counts; a pushed visit draws stock down on the office by the delta, and deleting a visit restores it.
- Device-supplied owners are honoured only when the syncing user may act for them; creation timestamps no longer drift with the device clock; device pull applies row by row with savepoints, foreign keys are on for every open, and office tombstones are never echoed back.
- A restore from backup stamps a database generation; devices notice it on the next pull, reset their exchange state and re-offer their records, so nothing created on a phone is lost to a restore.
- Client codes are generated from a numeric counter (a collision rename no longer poisons the sequence; codes past 9999 work).

Security, exports, backups and finance (from the weakness review).

- Index-key rotation re-seals the audit head under the new key (it failed after the first scheduled verification). A pending device wipe is no longer consumed by anyone who knows the device id: the office answers the wipe instruction without changing state until valid credentials arrive on that device or the device acknowledges with a one-time token; the device now erases itself completely (the in-memory copy no longer writes itself back) and a revoke that carried a wipe wipes too.
- Navigators and clinicians can export de-identified data again; every Export button is permission-gated; the identified workbook asks for recipient and purpose and writes one accounting-of-disclosures row per client. CSV exports have no comment line and neutralise formula-triggering cells; de-identified datasets use explicit per-dataset column lists. The duplicate check on client create no longer reveals people outside the caller's caseload.
- A refused restore leaves the original database in place; a backup that fails to write is recorded, audited and surfaced by `/api/health`; the offsite copy is reported as failed when the share is not mounted rather than silently written to the local disk; a backup from a newer SUDS is refused with a plain message.
- Service dates use the organisation's time zone (`ORG_TIMEZONE`) for fiscal-period checks; expenditure approval follows a strict state machine (pending → approved | rejected, approved → reimbursed) with a supervisor-only overspend override and no self-approval for any role; money is rounded to cents on write and in every sum; budget structure is checked (period order, sub-allocations within their parent, lines within the fund); a pending expenditure cannot be moved outside the period.
- Re-importing a spreadsheet skips rows already imported; the due-reminder poll no longer floods the audit log; failed sign-ins for unknown usernames are audited hashed.

Functional audit before this release (every workflow walked by role, in the browser).

- **Settings no longer blank the policy on a fresh install**: saving any field used to store empty values and disable MFA for every role. Unset settings render their defaults; an empty MFA-roles value means "default", never "nobody"; the save is all-or-nothing.
- Returning a time entry requires a reason, shown to the worker; the time-approval queue shows all submitted time to finance and admins; `mfa_grace_days = 0` means immediately.
- Legal hold blocks merge in both directions; a discharge needs a reason; opening an episode makes the client active and a client with an open episode cannot be closed through Edit; a referral outcome closes only its own follow-up; editing or deleting a visit keeps the auto-created time entry in step; merged-away links redirect to the keeper; open patient-rights requests and overdue ones are counted on Home and in Supervision; contact-field validation (DOB, email, phone); expired consents are not offered for referrals; a crisis-escalated call is counted as a crisis.
- Forms no longer re-save a draft after a successful submit (the New client dialog reopened pre-filled with the person just created). Dialogs sit above banners on phones; the break-glass dialog enforces the reason length; unhandled errors surface as a toast; unknown routes show "Page not found".
- Local mode: idle sign-out fires even while the reminders poll runs; office-side sync errors show their real message; an office account with MFA is asked for its code inline instead of being sent to the device's own MFA screen; the service worker is registered in local mode and precaches the kernel so a home-screen install opens offline; writes in the last moments before leaving the page are flushed; field-created clients no longer trip an "assignments" rejection; a merged-away client is re-pointed on the device; a device-side edit of a server-owned supply count is overwritten by the office. The kernel and WebAssembly ship precompressed with immutable caching (Slow 3G cold start 57 s → 31 s). Sync from the demo site is refused up front with an honest message.
- Operations: a full disk answers 507 with a plain message; a double leading slash in a URL no longer hangs a request; `.webmanifest` has the right type; device revoke and user deactivation ask for confirmation; the restore-complete dialog has one action, "Sign in again"; the wizard hides the port when `PORT` is set by the environment.

## 1.8.0 — 2026-09-18

- **A fully standalone, browser-only web app.** No office server, no Node process, no database anywhere
  but the visitor's own browser — the same "local mode" the phone apps run, packaged as a static site and
  published to a public URL (GitHub Pages, or any static host). Open it on any phone or computer, add it
  to the home screen, and it works, including offline; sync with a real office SUDS later if the county
  has one. `docs/WEB_APP.md`; built by `scripts/build-static-site.js`; deployed by
  `.github/workflows/web-app.yml`; covered end to end by `scripts/ui/static-site.mjs`.

## 1.7.1 — 2026-09-18

Production-readiness fixes found by running the first-run wizard the way a county does, and by inspecting
what 1.7.0 added.

- **Username validation was silently off** on the setup wizard and the add-staff form. The HTML pattern
  reached the browser with an unescaped `-`, which modern Chrome rejects, logs, and ignores — so any
  string was accepted as a username. Fixed in both forms.
- **The database's write-ahead log and shared-memory files were world-readable** on a production server:
  SQLite creates them itself, and only the database file was being made private. In production the
  process now creates every file private by default, and existing `-wal`/`-shm` files are fixed on open.
- **Releasing from the Actions tab never built the Android app.** The tag the release workflow creates
  raises no push event, so the Android workflow's tag trigger never fired and the APK was quietly
  missing from every release started that way. The release workflow now starts the Android build itself.
  (The APK is attached only when the signing secrets are set — see docs/MOBILE_APPS.md.)
- **The first-run wizard is part of the browser suite** (`scripts/ui/setup.mjs`, run against an
  unconfigured production server): wizard, HTTPS restart, first sign-in, key-backup prompt, first
  backup, and that setup cannot be run twice. The desktop crawl also covers the screens 1.7.0 added
  (Supervision, Waitlist, Overdose, Funder report, Forms, the Texts filter). The suite refuses to start
  on a port a stale server is holding, instead of reporting an app defect that is not one.
- `scripts/android-keystore.sh` creates the county's Android signing key once, with the checks and the
  warnings that key deserves; keystores are ignored by git.

## 1.7.0 — 2026-09-17

This release came out of a detailed review of the platform. It fixes things that could break a county's
data, closes gaps between what the app recorded and what it actually enforced, and adds the workflows the
data model had no process around.

### Things that could have lost or leaked data

- **Sync could wedge itself permanently.** One unusable row aborted an entire push, and the device retried
  the same payload forever. Each row is now applied on its own: a bad one is rejected with a plain reason
  and everything else still lands. Three reproduced ways this happened are now covered by tests — a county
  form completed offline, the third device to create a client without a signal, and a record whose
  encryption could not be read.
- **Key rotation destroyed form PHI.** Re-keying the database skipped completed county forms and their
  attachments, so following the documented procedure made them permanently unreadable. The columns to
  re-encrypt are now read from the database itself, so a new one cannot be missed.
- **Sync let a device do what its user could not.** A navigator could write resources, funding sources and
  form templates through sync, and caseload limits were not applied at all to calls, to-dos, time entries
  or spending. Both are enforced now.
- **Finance could export identified client data.** The role kept its de-identified access but no longer
  holds the permission that turns names on.
- **A phone with two tabs open lost work.** Each kept its own copy of the database and saved by overwriting
  the whole thing. One window now holds it and the others say so. A committed change is written out
  immediately rather than on a timer, a failed save is reported instead of disappearing into the console,
  and a device whose security key has been cleared says so instead of silently making everything on it
  unreadable.
- **Restoring a backup no longer needs a terminal.** Administration can check what a backup contains and
  then restore it, keeping the replaced database aside. Backup, restore and key rotation had no tests at
  all; they do now.

### Consent, supervision and discharge

- **Consent is enforced where information actually leaves.** A referral that names a client to an outside
  agency is refused without a valid consent or another lawful basis, and writes the disclosure record that
  HIPAA §164.528 requires. Revoking a consent flags the open referrals that relied on it.
- **Countersignatures.** Only the author signs a note; a supervisor countersigns. Both names stay on the
  record — signing on a trainee's behalf used to erase who actually provided the service.
- **Supervision** (new menu item): notes waiting for a countersignature, drafts the team has not finished,
  staff time to approve, and referrals with no outcome recorded.
- **Staff time is submitted and approved**, in bulk or per entry, with the same rule expenditures have:
  nobody approves their own.
- **Episodes of care and discharge.** Closing an episode ends the assignments, closes the open to-dos that
  would otherwise sit overdue forever, and records why and where the client went. Reopening service brings
  a returning client back. There is a **waitlist** ordered by how long people have actually waited, and a
  **caseload transfer** that moves every client and open to-do at once when a worker leaves.
- **Referral outcomes.** Every referral gets a follow-up date whether or not one was set, and recording the
  outcome closes the loop, so "how many warm handoffs resulted in an admission" is answerable.

### Reporting

- **Funder report** (new menu item): unduplicated counts — people, not services — by fiscal period and
  funding source, with admissions, discharges, median length of stay, demographics and overdose figures.
- **Overdose & reversals** (new menu item): an event log including community reversals with nobody
  identified, which previously could not be recorded at all. Community naloxone distribution can be
  recorded as a service with no client attached.
- Race and ethnicity are recorded as codes a funder can count, alongside the free-text field.

### Contacts, referrals and the phone

- **Text messages are logged like calls.** + Log offers **Text message**, and a client's page has a
  **+ Text** button. A text has its own outcomes — replied, sent, no reply, undeliverable, wrong number,
  opted out — so "voicemail" and "busy" no longer stand in for them, and the two sets cannot be mixed up.
  A reply counts as having reached the client (an unanswered text does not), so texting somebody no longer
  leaves them on the *no contact in 30 days* list. What was said is encrypted like any other PHI, and the
  form says plainly that texting a client about treatment is itself a disclosure if someone else can read
  their phone.
- **A referral is no longer blocked by an empty directory.** On a phone that has not synced yet, the
  provider list was empty, offered only "—", and had nothing to type into. It now offers adding a provider
  without leaving the referral, and says why the list is empty.
- **The floating "+ Log" button no longer covers the last control on a phone screen**, and a long value can
  no longer push a page wider than the phone — which put buttons out of reach entirely.

### Working with client records

- **Entering the same person twice is caught.** A matching surname and date of birth, phone number or full
  name is flagged while you type — compared through blind indexes, so no name is ever in the clear.
  Duplicates that do get in can be **merged**.
- **Search tolerates typos and partial surnames**: "Ngu" and "Nguyan" both find Nguyen.
- **Starter forms**, including a 42 CFR Part 2 consent with the elements the rule requires. A new
  installation used to have no consent form at all.
- Unsaved work in a form is kept if the dialog is closed or an idle sign-out happens.

### Accessibility

- Clickable rows and the client picker were mouse-only. Rows are keyboard-reachable, the picker is a real
  combobox with arrow keys and Enter, dialogs keep Tab inside them and return focus where it came from, and
  validation errors are announced and focused rather than shown only as a red outline.

### Under the hood

- **The audit chain is keyed.** It is an HMAC over the previous entry rather than a plain hash, so somebody
  who can write to the database cannot recompute a chain that covers their changes. Entries written by
  earlier versions still verify, and the whole chain is checked daily.
- **The database is snapshotted before a migration runs** (`data/pre-migration/`, last five kept). A
  migration is the one operation a county cannot retry, and if the snapshot cannot be written the upgrade
  stops rather than proceeding unprotected.
- **Ending an assignment now takes effect at once.** Access was decided by date alone, so a worker a
  supervisor had just taken off a case kept the client until midnight.
- **Local mode in a plain browser says what it is.** Without a Keystore or Keychain it keeps its encryption
  keys in that browser profile beside the data, so the Sync screen and the documentation now say so: it is
  for trying SUDS out, not for real client information.
- Downloading pictures for a whole region is bounded by one time budget, so a slow provider website cannot
  outlive the request.
- Signing in no longer blocks every other request while the password is hashed.
- Pictures are served as cacheable images instead of base64 inside list responses, sync is paged and
  chunked, attachments travel separately, and the tables sync reads are indexed — a first sync used to be a
  single 40MB response the phone could not parse.
- Mandatory two-step verification is actually enforced, after a grace period so a new administrator is not
  locked out before they can enrol.
- There is a real health check, logs are written to dated files and rotated, and an unhandled error no
  longer takes down an unsupervised county workstation.
- Release builds fail if the committed phone kernel is stale, if tests fail (a shell precedence bug let a
  release publish with failing tests), or if an Android release is about to be signed with a throwaway key
  that would stop staff installing the update.

## 1.6.1 — 2026-09-17

### One record, one date, everywhere
- A reminder due on a calendar day (for example a follow-up from a call) showed as that day at noon on the client timeline but as the evening before on the To-do list and Home. Every screen now reads dates through one rule: a bare day is a day in your time zone, a timestamp is an instant, and something is "overdue" only after the day has ended. The server applies the same rule to overdue counts and to what Home lists as due today, and no longer turns a chosen day into midnight UTC when saving.
- The timeline shows task and note titles exactly as typed instead of re-capitalising them.
- Choosing **All** in the To-do list status filter returned nothing; it now lists everything (the same fix covers the expenditure and referral filters).
- On phones, list tables (to-do, referrals, calls, visits, time, spending) become stacked cards with a label on each value instead of seven columns squeezed into the screen width.
- The offline app shell now includes the Forms, Import and Sync screens.

## 1.6.0 — 2026-09-17

### Sacramento region starter directory
- **Add 81 programs in one click.** The Resource directory now offers a starter directory for the extended Sacramento metro: Sacramento, Yolo, Placer, El Dorado, Sutter, Yuba, Nevada and Colusa counties. It covers opioid treatment programs, office-based buprenorphine, residential treatment and detox, intensive outpatient and outpatient, sober living, shelters and day centres, harm reduction and naloxone, county access and crisis lines, community health centres, peer and recovery communities, food, legal aid, benefits offices and transport. Each entry carries a plain-language summary written for a navigator, service tags, populations served, how to refer, cost notes and contact details. Granite Wellness Centers appears as six separate programs (withdrawal management, Hope House, Serenity House, outpatient and MAT, adolescent, Truckee).
- **Loaded unverified, on purpose.** These programs were compiled from public web sources and were not confirmed with the providers. Every entry loads with no verification date, is flagged "needs verification" in the directory, and carries a staff note recording where it came from plus anything that needs checking, for example a conflicting address or a phone number that may belong to a commercial directory rather than the provider. Staff confirm each one and press "Verified today".
- **Never overwrites your work.** Loading fills in blanks on programs you already typed and adopts matching entries instead of duplicating them. Re-running checks for updates. Removing takes out only the programs nobody has used or verified; anything with a referral or a verification date is kept and simply deactivated.
- **Pictures.** Every program gets a category-coloured cover card generated on the spot, so the directory looks complete offline. **Download provider pictures** then visits each program's own website, finds the picture that site advertises for itself, and saves it as the main picture where it works. Programs whose site publishes nothing keep the generated card.

## 1.5.0 — 2026-09-17

### County form library
- **Forms** (new menu item): administrators and supervisors upload the county forms the program uses (PDF, Word or a picture of the paper form) and describe the fields to fill out. Fillable PDFs have their fields detected automatically; a "usual client header fields" button adds name, date of birth, phone, address, date and navigator in one click. Fields can be short or long answers, dates, numbers, checkboxes, choice lists, typed signatures, section headings and instruction text, marked required, and set to **pre-fill from the client record** (name, DOB, phone, address, insurance, Medicaid ID, client code, primary substance, worker name, program name, today's date).
- **Fill out from a client record** (new Forms tab, or "Fill out for a client" in the library): the form opens pre-filled from the chart, saves as you type, checks required fields when you mark it completed, and becomes read-only (supervisors can reopen). Every filled form is stored encrypted with the client record, prints to a clean **PDF**, and can hold the **signed or scanned copy** (photo or PDF, also encrypted). The original county form can always be downloaded to print blank; a blank PDF is generated for forms uploaded without a file.
- Forms sync to phones like everything else and work in the phone-only app. Client forms appear in exports (de-identified) and in the client's counts. Sample data includes three county forms and filled examples.

### Interactive cards
- Summary cards on Home, Reports, the client overview, Funding and System are now links: click "High-risk clients", "Open referrals", "Naloxone kits given", a fund's "Pending" and so on to jump to the matching filtered list. Chart bars (visits by type, clients by status or substance, MAT status, calls by outcome) are clickable too. The client list shows the active filter with a one-click clear.

## 1.4.0 — 2026-09-17

### Treatment center profiles
- Every resource in the directory now has a **profile page** (`#/resource/<id>`): a plain-language summary at the top, **services offered** as tick-box tags (detox, residential, IOP, MAT by medication, peer support, housing, telehealth, walk-in, 24/7 crisis and more), levels of care, populations served, how to refer, cost and capacity notes, contact details, referral outcomes and the recent referrals you may see.
- **Pictures**: staff with resource-edit rights add photos of the building, entrance and rooms from a phone or computer. Pictures are shrunk in the browser before saving (max 1600 px, plus a small thumbnail), checked on the server by their real bytes (JPEG/PNG/WebP only, 2 MB cap, 12 per resource), can be captioned, reordered (make main picture) and removed, and sync between phones and the office like any other record.
- The directory shows **cards with cover pictures** (or a list, your choice is remembered) and can be filtered by service. Referrals can be started from a profile.
- Excel/CSV import and export include the new profile columns. Sample data resources now come with summaries, tags and drawn placeholder pictures.
- Android app: the system photo picker opens for picture uploads.

## 1.3.0 — 2026-09-16

### Sample data
- **Load sample data** (Settings → Settings on the office SUDS; the Sync screen on a phone-only copy) adds 12 fictional clients with visits, calls, time, notes in several formats, referrals, reminders, consents, disclosures, resources, two funding sources and spending, so a new program can explore every screen. It is only offered while there are no clients yet, every record is tagged (`DEMO-` client codes) and **Remove sample data** deletes all of it in one click. A phone removes its sample data automatically before its first sync so it never reaches the office.
- The empty dashboard points new users at it. `npm run seed` uses the same generator (plus demo staff accounts) for development.

### Sync
- Device clock differences no longer decide conflicts: the office normalises timestamps using each device's reported time, and phones track exactly which rows were sent so nothing is re-sent or lost.
- Local database saves are flushed when the app goes to the background.

### Fixes
- Pages a role cannot use (for example Settings for a navigator) now show a clear message instead of failing requests.
- Collapsed sections in the new-client form are opened by the browser tests; the tour no longer opens on top of another screen.

### Build & test
- Browser regression suite (`scripts/ui/run-all.sh`, seven Playwright scripts covering desktop, the navigator workflow, UX features, phone-only mode, two-way sync, spreadsheets and sample data) runs in CI on every push.
- iOS simulator build workflow (`mobile-ios.yml`) compiles the SwiftUI wrapper on every release.

## 1.2.1 — 2026-09-16

### Security review fixes
- Sync: a device can no longer overwrite clients outside its user's caseload, delete rows it may not access, attribute work to other staff, self-approve spending, alter signed notes, or hard-delete clients, notes, consents or disclosures. Clinical notes are only synced to roles allowed to read them; MFA secrets never leave the server.
- Phone apps: database keys now live in the Android Keystore-backed encrypted store / iOS Keychain instead of web storage.
- iOS: the bundled app is served through a custom URL scheme so modules, fetch and WebAssembly work (file:// could not run the kernel).
- Local mode hides server-only settings (network, API keys, backups) and phone-connection cards.

## 1.2.0 — 2026-09-16

### Excel and CSV import / export
- **Export**: every table (clients, visits & services, calls, time, referrals, to-dos, resources, consents, funding, budget lines, expenditures) to Excel (.xlsx) or CSV, plus "Everything as one Excel workbook". De-identified by client code; an audited identified workbook for users with export rights. Buttons on Reports, Clients, Resources, Budget and the record lists.
- **Import**: Excel or CSV for clients, resources, visits & services, calls, time, to-dos and expenditures. Download a template with the exact columns, or upload your own file: columns are matched by name (with aliases such as "Surname", "DOB", "Drug of choice"), every row is validated with plain-language problems, clients are matched by code or name, duplicates are flagged, and nothing is saved until you confirm. Works in the phone app too.
- Spreadsheet engine implemented with built-ins only (CSV parser/writer, .xlsx reader incl. shared strings and Excel dates, .xlsx writer with frozen header and filters).

## 1.1.0 — 2026-09-16

### Phone app works on its own; sync on command
- The complete SUDS app now runs inside the phone app (local kernel: the server logic bundled with SQLite-in-WebAssembly and pure-JS encryption). Install from the APK, create a local account, and start working — no office computer needed at install time or while working.
- **Sync** screen: exchanges clients, visits, calls, time, notes, referrals, reminders, consents, funding and resources with the office SUDS in both directions when the user chooses. Newest change wins; deletions travel as tombstones; encrypted fields are re-encrypted with each side's own key; device audit entries are appended to the office audit log.
- First sync merges the device account into the office account with the same username; offline-created clients get `M` codes so they never collide with office `C` codes.
- Server: `/api/sync/pull` and `/api/sync/push` (caseload-scoped, role-checked), bearer-token login for sync clients, `updated_at` on all synced tables, tombstones table.
- Android: web app bundled as assets and launched directly in local mode; native bridge for office-server discovery, QR scan and file saving. iOS project updated the same way.
- Local mode can be tried in any browser at `/?local=1` on a SUDS server (data stays in that browser).

## 1.0.0 — 2026-09-16

First production release.

### Core
- Client records with encrypted identifiers, substance use profile, ASAM level, MAT status, overdose and naloxone history, risk level and safety flags
- Visits & services (25 navigation intervention types), calls, staff time, referrals with status pipeline, resource directory, to-do list and per-client timeline
- Funding sources, budget lines and expenditures with approval workflow and separation of duties
- Clinical and administrative notes (SOAP / DAP / BIRP / GIRP), electronic signature with tamper-evident hash, addenda, audited break-glass access
- 42 CFR Part 2 consents, releases of information and accounting of disclosures
- Import of notes from Pocket AI (JSON / Markdown / text), OneNote (MHT / HTML / DOCX / text), Microsoft Graph OneNote sync, pasted text and an API-key intake endpoint, all staged for review
- Dashboard, program summary, monthly trends and de-identified CSV exports

### Security and compliance
- AES-256-GCM field encryption with blind-index search, scrypt passwords, TOTP MFA with QR enrollment, lockout and rate limiting, 15-minute idle sign-out, role-based access with caseload scoping, CSRF and CSP protection
- Hash-chained audit log with integrity verification and retention purge
- Encrypted backups, key rotation, self-signed HTTPS generated in-app

### Zero-configuration deployment
- Browser setup wizard, double-click launchers for Windows, macOS and Linux
- Built-in mDNS responder (`https://suds.local`), standard HTTPS port with fallback
- Progressive web app with home-screen install on phones; per-user workspace and note drafts synchronized across devices
