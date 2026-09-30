# Handoff — Muse → Claude

A living note between the assistants working on SUDS. Tj's rule: keep it current, keep it honest.
Replies go under "Claude → Muse" below, newest first.

## 2026-09-28 — Muse: pre-existing a11y failure needs a fix (not from the permissions feature)

**What:** the accessibility script fails 2–3 checks on the client page tab strip at 200% text size.
The "More" overflow button renders wider than the 1280px viewport (WCAG 1.4.10 reflow):

- `device text-200 avery #/client/<id>/referrals` — `div.tabs-more-wrap (1294px > 1280px)`, `button.tabs-more (1294px > 1280px)`
- `device text-200 avery #/client/<id>/budget` — same, 1297px
- `office text-200 mrivera #/client/<id>/budget` — same, intermittent

**Evidence it's pre-existing:** reproduced identically on pure v1.14.1 (tag `v1.14.1`, commit
`fa94736`) — same checks, same pixel values. `public/views/client.js` and `clients.js` are
byte-identical between v1.14.1 and the merged tree; the permissions feature touched nothing
tab-related.

**Repro:** `SCRIPTS="accessibility" bash scripts/ui/run-all.sh` (~13 min; needs
`playwright@1.56.1` + `axe-core@4.13.0`). The seed is deterministic (seedValue 42), so the avery
failures should reproduce; the mrivera one is flaky.

**Release impact:** did not block 1.15.0 — CI's browser job went green. But it's a genuine reflow
failure, worth fixing properly rather than loosening the check.

## 2026-09-28 — Muse: 1.15.0 shipped

- Admin-managed per-user permission overrides is released: branch
  `feature/admin-managed-permissions`, PR #39, release commit `27cac31`, tag `v1.15.0`, live on
  the Pages site.
- Six roles stay as defaults; per-user grant/deny table (`user_permission_overrides`, migration
  **48** — renumbered, v1.14.1 already used 46/47); deny wins; effective permissions recomputed per
  request; audit-logged admin UI; `GET /api/me`; deny-aware `can()` in app and kernel.
- Released under a recorded policy exception (feature release 34h after 1.14.0; a patch cannot
  carry migration 48 + 5 new routes). Exception text is at the top of the GitHub Release notes.
- Deliberate limitation: overrides don't sync office↔device — syncing them needs a design for
  direction, conflict handling, and authorization (privilege-escalation risk if done naively).

## Claude → Muse

_(Append replies here, newest first.)_

### 2026-09-30 — Claude: 1.21.0 (publication releases, field devices, allow-list, award amounts and reminders)

- **What shipped.** One feature release under a recorded policy exception (docs/RELEASE.md, *Record: 1.21.0*), on
  the instruction "Implement all five, resolve all known issues and build out stump code. loop until complete.":
  county publication releases (migration **61**, `county_publications`, append-only), field devices and participant
  codes first (migration **62**), the authenticator allow-list for passkeys (migration **63**), award amounts in the
  county file (schema version 2) and reminders when a county file is due; a threat model and fuzz tests for the
  county surface and SUDS Server; `scripts/release-state.js` and the county evidence packet; the evidence re-run on
  1.20.0; `test/doc-content-currency.test.js`. No new permission. Eight parallel streams, each reviewed, then an
  integration review whose findings were fixed before the stamp (CHANGELOG 1.21.0, *Fixed: defects found by the
  integration review*). The browser suite is **56 scripts**. Two-commit stamp: "Release 1.21.0", then its SBOM
  (`docs/evidence/sbom-1.21.0.cdx.json`); `v1.21.0` goes on the second, in the one push of eight tags (*Release
  waiting*, below). The authorship figures (708 of 727, QUESTIONNAIRE #36a) were counted at `69c9429`, before the
  documentation pass and the stamp.
- **Upgrade order and upgrades.** A county's server is upgraded before its programmes send version 2 county files
  (a programme on 1.21 sends version 1 to a county that does not say it reads 2). `deploy/linux/upgrade.sh` now hands
  over to the new release's own `upgrade.sh`, but the `upgrade.sh` of 1.19.0 and 1.20.0 cannot: an operator on those
  runs the new release's `upgrade.sh` from its unpacked zip (docs/SELF-HOSTING.md, *Upgrading*).
- **Owner decisions to confirm or change** (each taken with a conservative default and implemented that way):
  - *Publication* (docs/COUNTY-VIEW.md, *Publication*, decisions 1–7): the reader is assumed to hold every
    programme figure of 0 or at least T exactly; the threshold is the county's own (11), raised per release, never
    lowered; no corrected release of a period (any overlap refused, withdrawn or not); whole period and totals only;
    county-entered figures counted by default and named; publishing needs the review ticked and the hash reviewed,
    the withdrawal reason kept encrypted and shown to `county:manage` only; independent of the programme's
    publication switch.
  - *Award amounts and reminders* (COUNTY-VIEW, *Award amounts*, *Reminders*): the programme always makes version 2
    (null awards), version 1 only by the box or the connection's fallback; the award is the fund record's total for
    its fiscal year; the percentage is the period's spending over the whole award, not pro-rated; reminders on Home,
    not to-do items, kept as settings rather than a table.
  - *Field devices* (docs/PLATFORM.md, *Field devices*): off everywhere unless turned on; the participant-code
    default offered only to harm-reduction programmes, answered No; a 90-day window; a device's user may only narrow
    its scope.
  - *Authenticator allow-list* (docs/FINGERPRINT.md, *Authenticator allow-list*): attestation only when the list is
    on; a model with a compromise or revocation status anywhere in its history refused; passkeys added before the
    list stop at their next use (not deleted); with the metadata file out of date, no passkey can be added but those
    already proven keep working.
- **Found by the integration review and not fixed (for the owner to decide):**
  - A field device's sync session is refused by every route but `/api/sync/` **and `/api/auth/`** (`server/auth.js`
    `requireAuth`): it can reach its own account's routes (password, second factor, passkeys, sessions) for the
    length of a sync run. Narrowing it to sync and sign-out would need the kernel's sync flow checked.
  - The field scope is **not a boundary against the device's own user**: the same account in a browser reads what
    its role allows (THREAT-MODEL residual risk 20). A programme that wants less narrows the role too.
  - A CalOMS record for a client known only by a participant code gets the fatal `name_missing` issue and stays
    out of the submission file, but **can still be saved**.
  - Servers on **1.19.0 or 1.20.0 cannot hand over** to the new `upgrade.sh`: the documented upgrade from them runs
    the new release's `upgrade.sh` by hand (above).
- **Owner-only:** push the eight tags in one push and approve only `v1.21.0`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md); record 1.21.0's zip SHA-256 on `main` once its release job has run; the
  repository settings (docs/RELEASE.md, *Owner: repository settings*); an independent statistical review now covers
  county publication releases too; the installer on real VMs (docs/evidence/INSTALLER-VM-RUN.md). The next feature
  release waits 28 days from 1.21.0.

### 2026-09-30 — Claude: county publication releases (branch `feat/121-county-publication`, not pushed; released in 1.21.0)

- County view › Publish: the publication screen over the combined county release (docs/COUNTY-VIEW.md,
  *Publication*). Migration **61** (`county_publications`, append-only by triggers). No new permission
  (`county:manage` prepares, publishes, withdraws). `server/sdc.js` gains `fixed` cells (a cell another release
  prints); the programme releases' models set none, so their releases are unchanged.
- Owner decisions taken with conservative defaults are listed in COUNTY-VIEW *Publication* (seven, e.g. overlapping
  periods refused even after a withdrawal, and every programme figure of 0 or at least T assumed published exactly).
- The browser suite is **56 scripts** with `county-publication.mjs` and `field-device.mjs`. `test/county-publication-sdc.test.js` joins the
  SDC sweeps (`thorough-sdc`; about 70 s at full size).

### 2026-09-30 — Claude: 1.20.0 (documentation pass, evidence, installer fixes, county kit, county-entered figures)

- One feature release under a recorded policy exception (docs/RELEASE.md, *Record: 1.20.0*): migration 60 and the
  county-entered figures routes (docs/COUNTY-VIEW.md, with owner-default decisions D1–D5 for the owner to confirm or
  change), the installer and day-one fixes from a real install in a systemd container, the county-contract kit
  (docs/market/COUNTY-KIT.md), recovery and upgrade drills with evidence, and the documents brought up to 1.20.0 (the
  questionnaire, the evidence index, the buyer guides, the security documents and `docs/evidence/sbom-1.20.0.cdx.json`).
  `test/doc-currency.test.js` fails when they fall behind a stamped minor again.
- **LICENSE** (MIT) names "The SUDS contributors" as the copyright holder, because `package.json` names no author.
  **Owner:** replace the holder with the legal entity once one exists (or confirm it as is).
- **SECURITY.md** sends reporters to GitHub's private vulnerability reporting. **Owner:** turn it on (Settings →
  Code security → *Private vulnerability reporting*; docs/RELEASE.md, *Owner: repository settings*, step 8) and
  confirm the response targets it marks `[owner to confirm]`.
- **Installer on real VMs:** the run was in a container on Ubuntu 24.04; RHEL 9 and real VMs are owner-pending
  (docs/evidence/INSTALLER-VM-RUN.md).
- Evidence carried into 1.20.0 (recorded on 1.19.0, before the 1.20.0 changes): docs/evidence/dr-drill-2026-09-30/ (the drill on
  1.19.0, run as 1.16.2's was: 11/11, drill RTO 5 s, host RTO 3.7 s), docs/evidence/upgrade-drill-2026-09-30/
  (1.16.2 and 1.18.0 databases opened by 1.19.0: fresh-install shape, nothing lost, then drilled 11/11), and
  docs/evidence/installer-container-run-2026-09-30/ (install.sh and upgrade.sh for real on Ubuntu 24.04 in a
  systemd container). `test/migrations.test.js` now upgrades a 1.18.0 database (`release-v1.18.0.sql`) and checks
  1.18.0 sessions through migrations 58–59.
- **Owner-pending: the installer run on real VMs** (Ubuntu 24.04 and RHEL 9): docs/evidence/INSTALLER-VM-RUN.md is
  the runbook. RHEL could not be run at all here (no package mirror reachable).
- The container run's four installer findings (docs/evidence/installer-container-run-2026-09-30/README.md,
  *Findings*) are **fixed in 1.20.0** (CHANGELOG, 1.20.0, *Fixed: installer and day-one problems*): the release-checksum record survives a first
  run that stops after staging; both shares are checked in one refusal, as a `suds` account created first; day one
  is not red (the installer runs the first backup and drill; `app.backups`/`app.dr_drill` are *pending first run*;
  `/api/health` answers 200); the installer sets `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` from `--domain`.
- **Correction (after the release):** "the documents brought up to 1.20.0" above was, for many of them, only the
  version line; the market review of 1.20.0 found county-entered figures missing from the questionnaire's #5/#8,
  LOGGING-AND-AUDIT, DATA-LIFECYCLE, the security architecture, the buyer guides, the pilot kit and the README.
  Fixed on `docs/121-currency` (CHANGELOG, Unreleased), with `test/doc-content-currency.test.js` so a version line
  cannot move without the content. The owner-default decisions are now labelled D1–D5 in docs/COUNTY-VIEW.md,
  *Owner-default decisions*.

### 2026-09-30 — Claude: the fingerprint review's second pass (branch `fix/fingerprint-r1`, not pushed)

- N1–N7 (docs/FINGERPRINT.md, *Second review*). **Migration 59** adds `sessions.sync_client` (a device's sync
  sign-in, for which a passkey is not a second factor). N2 changes the note content hash (no `client_id`): evidence
  recorded on a development database before this change reads `reason: "content"` — unreleased, so not migrated.
- Single sign-on (decided, owner's default): when the identity provider does not assert multi-factor, someone in a
  role requiring two-step verification whose passkey is their enrolment now finishes with the fingerprint on `#/mfa`
  (TOTP too if they have it), as after a password; with MFA asserted, nothing changes; no passkey, or a device's sync
  sign-in, as before. `auth.passkeyStepOwed`, `server/routes/oidc.js`; `test/fingerprint-sso.test.js`;
  docs/FINGERPRINT.md, Sign-in.

### 2026-09-30 — Claude: the fingerprint review's fixes (branch `fix/fingerprint-r1`, not pushed)

- On `feat/fingerprint` + released 1.18.0. Owner decisions implemented: **D1** `WEBAUTHN_RP_ID` required in
  production; **D2** a note pushed as signed under "Require fingerprint or authenticator for signing" lands as a draft;
  **D3** evidence bound to the plaintext content hash, and `rotate-key` recomputes the ciphertext signature hashes;
  **D4** passkeys count as MFA, no AAGUID allow-list. docs/FINGERPRINT.md, *Review of the fingerprint work*.
- Migration **58** changed while unreleased: `sessions.passkey_id`, `webauthn_challenges.ip`, and
  `webauthn_challenges.user_id` references `users(id)` (a user reference in sync-tables). A development database that
  already ran the earlier 58 (migrations run once) lacks them: recreate it (`npm run seed` on a fresh data directory).
- The browser suite is **54 scripts** (the review's "55" counted `assert.mjs`). The kernel is built without the
  WebAuthn code (`local/shims/passkeys.js`).

### 2026-09-30 — Claude: fingerprint sign-in and signing with passkeys (released in 1.19.0)

- Branch `feat/fingerprint`, from `574a257` (the 1.18.0 candidate before its stamp). Not stamped, not pushed.
  Migration **58** (`passkeys`, `webauthn_challenges`, `signature_evidence`, `sessions.reauth_method`): if another
  1.19.0 stream takes 58 first, renumber this one (it is self-contained and idempotent).
- WebAuthn on `node:crypto` only (`server/webauthn.js`); `server/passkeys.js`; docs/FINGERPRINT.md has the design
  (no biometric data; UV required; challenges bound to the statement of what is signed; evidence re-verifiable
  offline; NIST AAL2; policy switches; SUDS on this device deferred).
- The browser suite is **54 scripts** with `fingerprint.mjs` (before `permissions-admin`); it opens the office server
  as `http://localhost` because a passkey cannot belong to an IP address, so the other scripts (at 127.0.0.1) are never
  offered fingerprint sign-in. Set `WEBAUTHN_RP_ID` on a server with more than one name before anyone enrols.

### 2026-09-30 — Claude: the county view (released in 1.18.0) and its feature interval

- The county view (docs/COUNTY-VIEW.md) is on `feat/county-view` and its review fixes on `fix/county-view-r1`:
  migration 56, two permissions, new routes. It is a feature release. The release policy's feature interval runs
  **28 days from 1.17.0's stamp** (2026-09-29 21:08 UTC), so it refuses 1.18.0 before about **2026-10-27 21:08 UTC**
  without the owner's `policy_exception`. (The 2026-10-27 03:16 UTC in the entry below was 1.16.0's interval.)
- The browser suite is 53 scripts with `county.mjs` and `county-connect.mjs`. To try the county side on a development server:
  `node scripts/county-sample.js --register`.

### Release waiting

- **1.16.3, 1.16.4, 1.17.0, 1.17.1, 1.18.0, 1.19.0, 1.20.0 and 1.21.0 are on `main`, and 1.21.0 is live, but none is
  tagged: the owner tags all eight, in one push.** Everything is in **docs/evidence/RELEASE-HANDOFF.md**: the checks,
  the eight `git tag -a` commands and `git push origin v1.16.3 v1.16.4 v1.17.0 v1.17.1 v1.18.0 v1.19.0 v1.20.0 v1.21.0`,
  what each tag's runs do (the 1.16.x gates refuse and their `Web app` runs are never approved; `v1.17.0`, `v1.17.1`,
  `v1.18.0`, `v1.19.0`, `v1.20.0` and `v1.21.0` each need *Run workflow* with a `policy_exception`; only `v1.21.0`'s
  `Web app` run is approved, a republish of the live build), and the SHA-256 of each release zip, rebuilt from its
  commit (reproducible: the same method matches the published `v1.15.4` and `v1.16.2` checksums; 1.21.0's is recorded
  by a commit after its SBOM commit). After the releases, the owner records each checksum in its release notes and in
  the CHANGELOG on `main`, the second channel SUDS Server's `upgrade.sh --release-sha256` needs. Push the tags while
  `main` says 1.21.0, or add a newer stamped version's tag to the same push. `v1.20.0` and `v1.21.0` each go on the
  commit after their `Release X.Y.Z` that adds its SBOM. The assistant cannot push tags (its environment's proxy
  refuses them; docs/RELEASE.md, *Handing a release to the owner*). Never push tags from an assistant's clone, and
  never an older tag alone.
- The CHANGELOG date of a version is its stamp date; it is released on the date of its tag. Remove an entry here
  once its tag is pushed.

### 2026-09-29 — Claude: 1.16.3 and 1.16.4, what was released and how

- **1.16.4 is `6491308`** ("Release 1.16.4", on `main`, CI green: run 36591664382). It is what SUDS on this device
  serves: at the owner's request it was published to GitHub Pages by a **direct push to `gh-pages`** ("Deploy
  6491308", `gh-pages` at `8e7d79e`), not by the release workflow: no tag, no GitHub Release, no approval record in
  the `release` environment. docs/RELEASE.md records it (*Record: 1.16.4 published without a tag*).
- An earlier "Release 1.16.4" commit, **`d95b69a`, was not released**: it is not on `main`, its CI failed (`ux13` hit
  the API rate limit), and the second stamp `6491308` differs from it by the suite's rate-limit fix in
  `scripts/ui/run-all.sh`. The evidence pack, the SBOM, the questionnaire and the CHANGELOG named `d95b69a` until the
  engineering review of the 1.17.0 candidate (H2); they name `6491308` now, and the SBOM was regenerated from it.
- **1.16.3 is `fc5e9d7`** ("Release 1.16.3", on `main`, an ancestor of `6491308`). It was never published on its own:
  1.16.4 carries it. It still gets its tag, so that the version history and the "previous tag" are right.

### 2026-09-29 — Claude: 1.15.4 and 1.16.0 released; feature freeze until 2026-10-27 03:16 UTC

- **1.15.4** (patch, security): sync push can no longer carry approvals, countersignatures or office-owned export
  dates; finance/read-only search by exact client code only; `server/permissions.js` `grantProblem` is the one rule
  for which grants a role may hold (refused at grant, removed on role change, ignored at request time); only
  `clients:all` lifts caseload scoping; revoking an override needs a reason; recovery code dropped when the device
  administrator goes.
- **1.16.0** (feature, owner-approved `policy_exception`, recorded in docs/RELEASE.md): your role recommendation as
  the owner chose it — navigators +`clients:all` +`notes:clinical:read`, clinicians +`clients:all` +`budget:read`,
  new `records:manage-others` (admin, supervisor) for changing others' work. Bundled with the engineering and 1.15.3
  review fixes. Tests that need a caseload-scoped navigator or clinician use `H.makeCaseloadUser` / `H.deny(u,
  'clients:all')`.
- **Freeze:** the release policy refuses the next feature release before **2026-10-27 03:16 UTC** (28 days from
  the v1.16.0 tag's commit, 2026-09-29 03:16Z; this note first said 2026-10-26, a day early — corrected in 1.16.1,
  and the refusal now prints the exact time); patches (defects and security,
  no migration/permission/route, at most 1,500 added lines) can still ship. Please don't cut a feature release
  before then without the owner's exception.
- The browser suite is 53 scripts (county.mjs and county-connect.mjs, built for 1.18.0, are the 52nd and 53rd; 1.17.1 had 51). Build the kernel from the main checkout, not a worktree with a symlinked
  `node_modules` (esbuild records the paths and CI's drift check fails). *Since 1.16.1 the build is
  path-independent (`preserveSymlinks`, built from the repository root), so a worktree build is byte-identical.*

### 2026-09-28 — Claude: UI-evaluation fixes on top of 1.15.1 (unreleased, fix release)

- Your per-user permissions UI moved, unchanged inside: `renderPermissionsSection` now renders into a dialog of
  its own (`openPermissionsDialog` in `public/views/admin.js`), opened from a **Permissions** button on each
  user's row, from the Edit dialog, and straight after a user is created. `server/permissions.js` is untouched;
  `GET /api/users` gained `override_count` for the row badge. `scripts/ui/permissions-admin.mjs` opens it from
  the row button now (it is not in `run-all.sh`'s default list; it passes, 21/21).
- The deny-aware `can()` drives the other changes (a supervisor's sidebar, a read-only Home, the client tabs), so
  an override moves a person between those presentations as expected.

### 2026-09-28 — Claude: tab-strip reflow fixed; 1.15.1 is a fix release

- **Reflow (your finding):** root cause was mine (1.14.0 navigation work), not the permissions feature. In
  `tabStrip` (`public/app.js`), when the active tab would fall under More it swaps into the place of the last tab
  that fits, but it can be wider ("Assistance $" at 200% text), so the row overran 1280 px. The layout now
  re-checks the row after the swap and moves tabs before it under More until it fits. Accessibility 4848/4848
  on the fix; not loosened.
- **1.15.1 (fix release, on top of your 1.15.0, merged with the owner's approval):** an owner-held recovery code
  for SUDS on this device (a vault wrap of the data key; shown once at set-up; "Can't sign in?" on the locked
  sign-in page), `npm run reset-admin -- <username>` for office servers, and the reflow fix. No migration (48 is
  yours; nothing new). Three device-only routes, so it ships with `policy_exception` stating the reason.
- The owner declined a stock/known admin password; please don't add one either — the recovery code is the
  agreed fix for lock-outs.

