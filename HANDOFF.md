# Handoff — Muse → Claude

A living note between the assistants working on SUDS. Tj's rule: keep it current, keep it honest.
Replies go under "Claude → Muse" below, newest first.

### Release waiting

- **The one owner action that unblocks the most: push the release tags (docs/evidence/RELEASE-HANDOFF.md, steps 1
  and 2).** Until they exist, SUDS Server cannot be installed or upgraded from a release (the installer and
  `upgrade.sh` download `suds-vX.Y.Z.zip` from the GitHub Release; `deploy/linux/lib.sh` `stage_release`), the
  release gate has never run for anything after 1.16.2, everything that measures from "the previous release"
  measures from `v1.16.2`, and the maintaining assistant has no path to publish but a direct `gh-pages` push. Once
  the tags are pushed, the assistant does not push `gh-pages` directly again (docs/RELEASE.md, *Stabilisation (from
  1.23.1)*). 1.23.1, 1.23.2, 1.23.3, 1.23.4, 1.23.5 and 1.23.6 were stamped before the push, so their tags are in
  it.
- **1.16.3, 1.16.4, 1.17.0, 1.17.1, 1.18.0, 1.19.0, 1.20.0, 1.21.0, 1.22.0, 1.23.0, 1.23.1, 1.23.2, 1.23.3, 1.23.4,
  1.23.5 and 1.23.6 are on `main`, and 1.23.6 is live, but none is tagged: the owner tags all sixteen, in one push.**
  Everything is in **docs/evidence/RELEASE-HANDOFF.md**: the checks, the sixteen `git tag -a` commands and
  `git push origin v1.16.3 v1.16.4 v1.17.0 v1.17.1 v1.18.0 v1.19.0 v1.20.0 v1.21.0 v1.22.0 v1.23.0 v1.23.1 v1.23.2 v1.23.3 v1.23.4 v1.23.5 v1.23.6`,
  what each tag's runs do (the 1.16.x gates refuse and their `Web app` runs are never approved; `v1.17.0`, `v1.17.1`,
  `v1.18.0`, `v1.19.0`, `v1.20.0`, `v1.21.0`, `v1.22.0` and `v1.23.0` each need *Run workflow* with a `policy_exception`;
  the gates of `v1.23.1` to `v1.23.6` pass with none, and only `v1.23.6`'s `Web app` run is approved: it publishes
  1.23.6; 1.23.6 carries an owner-approved exception the gate does not see, which the owner adds to its release notes
  by hand), and the SHA-256 of each release zip, rebuilt from its commit (reproducible: the same method matches the
  published `v1.15.4` and `v1.16.2` checksums; 1.23.6's is recorded by a commit after its stamp). After the releases,
  the owner records each checksum in its release notes and in the CHANGELOG on `main`, the second channel SUDS
  Server's `upgrade.sh --release-sha256` needs. Push the tags while `main` says 1.23.6, or add a newer stamped
  version's tag to the same push. `v1.20.0`, `v1.21.0`, `v1.22.0` and `v1.23.0` each go on the commit after their
  `Release X.Y.Z` that adds its SBOM; `v1.23.1` to `v1.23.6`, patches with no SBOM of their own, go on
  `Release 1.23.1`, `Release 1.23.2`, `Release 1.23.3`, `Release 1.23.4`, `Release 1.23.5` and `Release 1.23.6`
  themselves. The assistant cannot push tags (its environment's proxy refuses them; docs/RELEASE.md, *Handing a
  release to the owner*). Never push tags from an assistant's clone, and never an older tag alone.
- The CHANGELOG date of a version is its stamp date; it is released on the date of its tag. Remove an entry here
  once its tag is pushed.

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

### 2026-10-02 — Claude: incoming referrals (built for 1.24.0, branch `feature/1.24-incoming-referrals`, not released)

An intake queue for referrals TO the program (ER/hospital, jail/re-entry, detox, probation/court, other providers,
self, family): `#/incoming`, Home's "N new referrals", a Supervision card with time to first contact, `intake:read` /
`intake:write`, migration 70 (`incoming_referrals`, `incoming_referral_attempts`; office-only, never synchronised).
No send-back to the referrer (that would be a disclosure). The browser suite is **60 scripts** now
(`incoming-referrals.mjs` added). CHANGELOG *Unreleased* has the details.

### 2026-10-02 — Claude: 1.23.6 (administrators can change their own permissions, role and account; an owner-approved exception)

- **What shipped.** A patch of 1.23.5 **with an owner-approved policy exception** (docs/RELEASE.md, *Record: 1.23.6*,
  and a row in the exceptions table). It is not a security fix: the owner asked that an administrator be able to
  change all permissions, their own included, and, told that *Stabilisation* allows no new or widened permission in a
  patch and no exception but a security fix, chose to ship it now rather than in 1.24.0. No migration, no permission
  name and no route (`node scripts/release-policy.js --version 1.23.6 --previous v1.23.5 --previous-ref 382278a`
  passes: 224 lines added outside docs, tests and generated files), so no check sees the exception: it is recorded by
  hand, with no `Security exception:` line (that is for a security fix). An administrator may now change their own
  individual permissions, role and account (deactivating it included) and include themselves in *Apply to existing
  navigators and clinicians*; on SUDS on this device the person who manages it may change their own role. Users &
  permissions confirms each change to your own access first, naming what you lose or gain, and applies it at once. The
  security review of it fixed two things before the stamp: the lockout check and the write now run without a pause
  (two administrators demoting each other at once could both pass), and deactivating yourself moves your caseload
  first. Released as one commit, "Release 1.23.6"; a patch keeps `sbom-1.23.0`. `v1.23.6` goes on that commit, in the
  one push of sixteen tags (*Release waiting*, above); its gate passes, so the owner adds the exception to the top of
  its release notes by hand (docs/evidence/RELEASE-HANDOFF.md, step 3).
- **Upgrade notes.** Nothing to run: no migration. The **lockout guard** refuses any change, to yourself or to anyone
  (a role change, a deny, removing an override, a deactivation), that would leave no active account able to manage
  users and permissions: "This would leave no active administrator who can manage users. Give another account that
  access first." A change to your own account is audited as any other, with `self: true` (`user.permission.grant`,
  `.deny`, `.revoke`, `user.update`, which now records a role change as `role: { from, to }`; `local.account.role` on
  a device); a refusal is `user.permission.denied` (now recorded as unsuccessful) or the new `user.update.denied`. A
  per-user deny on an administrator is now advisory (the administrator may lift it, audited): restrict an
  administrator by changing their role. SCIM and single sign-on deprovisioning are not held back by the guard. An
  office administrator who steps down cannot promote themselves back (1.15.4 M2); the device's administrator keeps
  managing the device whatever role they choose and may take the administrator role back.
- **Open items (not fixed; for the owner):** carried from 1.23.5 unchanged: a supervisor's open reminder is recognised
  by its maker's permission as it is now (CHANGELOG, *Known*); the installer hand-over between two real releases has
  still not been seen; device-id reuse of an administrator-whole device (THREAT-MODEL residual risk 20); 1.21.0
  publication releases cannot be corrected; the installer on real VMs and on RHEL 9; **screen-reader testing** of the
  screens 1.21.0 to 1.23.6 added or changed is still pending (docs/accessibility/ACR-WCAG21.md). *Stabilisation*
  should be read with *Record: 1.23.6*: its words were not changed, and it was broken once, by the owner's decision.
- **Owner-only:** push the sixteen tags in one push and approve only `v1.23.6`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md), then add the exception to its release notes; 1.23.6's commit and zip SHA-256 are
  filled into the hand-off by a commit after its stamp; record each zip's SHA-256 on `main` once its release job has
  run; make `maint/1.22` from `v1.22.0` once the tags exist; the repository settings (docs/RELEASE.md, *Owner:
  repository settings*). No feature release before 2026-10-29.

### 2026-10-02 — Claude: 1.23.5 (Delete call on a phone, fixed reminder fields, toggle state, reminder audit and transfer counts)

- **What shipped.** A patch of 1.23.4 with **no policy exception** (docs/RELEASE.md, *Record: 1.23.5*): no migration,
  no new or widened permission, no new route, 91 lines added outside docs, tests and generated files (`node
  scripts/release-policy.js --version 1.23.5 --previous v1.23.4 --previous-ref 598d08b` passes), under the
  *Stabilisation* commitments (feature freeze until 2026-10-29). Fixes from the market evaluation of 1.23.4: a call or
  text can be deleted on a phone (**Delete call** / **Delete text** in its edit form, with the same confirmation); a
  *Finish and sign* reminder shows **Assigned to** and **Client** fixed, with the reason, to its recipient (anyone but
  its maker or someone who countersigns notes), and the refusal names both who may; the To-dos list's **Assigned to
  me** and **Overdue**, the Calls & texts filters and the one-of-several choices on Spending, Overdose response and
  Reports' monthly trend are toggle buttons (`aria-pressed`) with a check mark, not shown by colour alone (WCAG 1.4.1,
  4.1.2); a reminder closed by signing the last draft has its own audit entry; **Move a caseload** (and **Move and
  deactivate**) says how many sign reminders it cancelled; Supervision offers no **Remind author** for an inactive
  author (*Author no longer active*); ticking a sign reminder done with drafts left asks first; and `#/localsetup` while
  signed in on SUDS on this device goes to Home. The browser suite is still **59 scripts** (five extended). Released as
  one commit, "Release 1.23.5"; a patch keeps `sbom-1.23.0`. `v1.23.5` goes on that commit, in the one push of fifteen
  tags (*Release waiting*, above).
- **Upgrade notes.** Nothing to run: no migration, no new audit action. Signing a worker's last draft on a client's
  record now writes one more audit entry per supervisor's reminder it closes (`task.update`, status `done`, cause
  `signed`, the note's id; `via: sync` from a device). `caseload.transfer` records how many sign reminders it
  cancelled, and `POST /api/caseload/transfer` returns it in a new response field, `reminders_cancelled`; the
  supervision queue's unsigned drafts carry `author_active`. An inactive author's drafts are not reassigned (that is
  for 1.24).
- **Open items (not fixed; for the owner):** carried from 1.23.4 unchanged: a supervisor's open reminder is recognised
  by its maker's permission as it is now (CHANGELOG, *Known*); the installer hand-over between two real releases has
  still not been seen; device-id reuse of an administrator-whole device (THREAT-MODEL residual risk 20); 1.21.0
  publication releases cannot be corrected; the installer on real VMs and on RHEL 9; **screen-reader testing** of the
  screens 1.21.0 to 1.23.5 added or changed is still pending (docs/accessibility/ACR-WCAG21.md).
- **Owner-only:** push the fifteen tags in one push and approve only `v1.23.5`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md); 1.23.5's commit and zip SHA-256 are filled into the hand-off by a commit after
  its stamp; record each zip's SHA-256 on `main` once its release job has run; make `maint/1.22` from `v1.22.0` once
  the tags exist; the repository settings (docs/RELEASE.md, *Owner: repository settings*). No feature release before
  2026-10-29.

### 2026-10-01 — Claude: 1.23.4 (sign reminders stay with their author, Home keeps focus, clearer delete wording)

- **What shipped.** A patch of 1.23.3 with **no policy exception** (docs/RELEASE.md, *Record: 1.23.4*): no migration,
  no new or widened permission, no new route, 111 lines added outside docs, tests and generated files (`node
  scripts/release-policy.js --version 1.23.4 --previous v1.23.3 --previous-ref c02a261` passes), under the
  *Stabilisation* commitments (feature freeze until 2026-10-29). Fixes from the market evaluation of 1.23.3 and the
  integration review: a *Finish and sign* reminder can be given to someone else or moved to another client only by
  whoever made it or someone who countersigns notes (web app 403; a device's change is not taken), so its recipient can
  no longer make a colleague's draft look reminded; Home keeps the keyboard focus on its heading when it is laid out
  again at 640 px; **View in Done** lists the to-do just done first, marked *Just done*; a new sign reminder names its
  client once; the Notes tab says *No draft notes left to sign on this record.* once a worker's drafts are gone; the
  delete confirmations of a draft, call, visit and referral say what happens to their to-dos (cancelled when as SUDS
  made them, left open only when changed); and the To-dos list offers no tick box on a to-do the office would refuse to
  let you mark done. The browser suite is still **59 scripts** (four extended). Released as one commit, "Release
  1.23.4"; a patch keeps `sbom-1.23.0`. `v1.23.4` goes on that commit, in the one push of fourteen tags (*Release
  waiting*, above).
- **Upgrade notes.** Nothing to run: no migration, no new audit action. At the office, deleting a worker's last draft
  on a client's record now writes one more audit entry per supervisor's reminder it cancels (`task.update`, status
  `cancelled`, cause `deleted`), as a device's sync already did. Reminders already sent keep their words.
- **Open items (not fixed; for the owner):** carried from 1.23.3 unchanged: a supervisor's open reminder is recognised
  by its maker's permission as it is now (CHANGELOG, *Known*); the installer hand-over between two real releases has
  still not been seen; device-id reuse of an administrator-whole device (THREAT-MODEL residual risk 20); 1.21.0
  publication releases cannot be corrected; the installer on real VMs and on RHEL 9; **screen-reader testing** of the
  screens 1.21.0 to 1.23.4 added or changed is still pending (docs/accessibility/ACR-WCAG21.md).
- **Owner-only:** push the fourteen tags in one push and approve only `v1.23.4`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md); 1.23.4's commit and zip SHA-256 are filled into the hand-off by a commit after
  its stamp; record each zip's SHA-256 on `main` once its release job has run; make `maint/1.22` from `v1.22.0` once
  the tags exist; the repository settings (docs/RELEASE.md, *Owner: repository settings*). No feature release before
  2026-10-29.

### 2026-10-01 — Claude: 1.23.3 (View in Done, Home follows the screen's width, sign reminders only from a supervisor)

- **What shipped.** A patch of 1.23.2 with **no policy exception** (docs/RELEASE.md, *Record: 1.23.3*): no migration,
  no new or widened permission, no new route, 187 lines added outside docs, tests and generated files (`node
  scripts/release-policy.js --version 1.23.3 --previous v1.23.2 --previous-ref a45c716` passes), under the
  *Stabilisation* commitments (feature freeze until 2026-10-29). Fixes from the external retest of 1.23.2 and the
  integration review: the "Done" message after a to-do is marked done (Home, the To-dos list, its phone rows) has
  **View in Done** beside **Undo**, and **Undo** now works from the To-dos list too; Home is laid out again when the
  screen's width crosses 640 px (a phone's first sign-in kept the computer's layout on some loads, *To-dos for today*
  about 800 px down), waiting while someone is working in it; only someone with *Countersign notes* can write a *Finish
  and sign* reminder's line into a to-do (web app or sync push, either wording of the line), and only such a
  reminder is recognised by Supervision and closed by signing; the reminder offers **Open <client>'s notes** (on the
  author's own drafts there) and is titled for the client's drafts, not one note; Home's to-do checkbox is 24 px
  again on a phone; a reminder whose last draft is deleted is cancelled, not done; and the *Delete* question says when
  an open follow-up to-do (or a referral's reminder) goes with the record. The browser suite is still **59 scripts**
  (four extended). Released as one commit, "Release 1.23.3"; a patch keeps `sbom-1.23.0`. `v1.23.3` goes on that
  commit, in the one push of thirteen tags (*Release waiting*, above).
- **Upgrade notes.** Nothing to run: no migration, no new audit action. A to-do ending with the sign reminder's line
  that was made by someone who does not countersign notes (before 1.23.3 included) is now an ordinary to-do:
  Supervision offers **Remind author** again for that draft. Reminders with 1.23.2's wording still work.
- **Open items (not fixed; for the owner):** a supervisor's open reminder is recognised by its maker's permission as
  it is now, so if the supervisor stops countersigning notes it stays open until the worker ticks it off (CHANGELOG,
  *Known*). Carried from 1.23.2 unchanged: the installer hand-over between two real releases has still not been seen;
  device-id reuse of an administrator-whole device (THREAT-MODEL residual risk 20); 1.21.0 publication releases cannot
  be corrected; the installer on real VMs and on RHEL 9; **screen-reader testing** of the screens 1.21.0 to 1.23.3
  added or changed is still pending (docs/accessibility/ACR-WCAG21.md).
- **Owner-only:** push the thirteen tags in one push and approve only `v1.23.3`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md); 1.23.3's commit and zip SHA-256 are filled into the hand-off by a commit after
  its stamp; record each zip's SHA-256 on `main` once its release job has run; make `maint/1.22` from `v1.22.0` once
  the tags exist; the repository settings (docs/RELEASE.md, *Owner: repository settings*). No feature release before
  2026-10-29.

### 2026-10-01 — Claude: 1.23.2 (fixes from the evaluation of 1.23.1: Home's to-dos, follow-up titles, sign reminders)

- **What shipped.** A patch of 1.23.1 with **no policy exception** (docs/RELEASE.md, *Record: 1.23.2*): no migration,
  no new or widened permission, no new route, 188 lines added outside docs, tests and generated files (`node
  scripts/release-policy.js --version 1.23.2 --previous v1.23.1 --previous-ref 3bff36f` passes), under the
  *Stabilisation* commitments (feature freeze until 2026-10-29). Fixes from the evaluation of 1.23.1 and its
  integration review: on Home's *To-dos for today* tapping a title opens the to-do (or its call, visit or referral)
  instead of marking it done, and **Undo** on "Done" reopens it as it was; the phone To-dos list has **Open the call**
  (or visit, or referral) on the row; a call or text with no purpose gives a "Call back" / "Text back" to-do, and a
  worker's own "Call back" to-do is no longer taken for a follow-up; a sync push that moved and deleted a call, visit
  or referral in one batch cancels its follow-up to-do; deleting a referral cancels its supervisor's reminder; a
  supervisor's *Finish and sign* reminder covers an author's drafts on one client's record (one per author and client),
  says what closes it, closes when the last draft is deleted, and only the to-do's maker can make a to-do one by its
  last line; a clinician's new note starts as Clinical, Progress; *Set up this phone for the field* no longer
  contradicts itself when offline copies are off; and nothing reached from the keyboard stops under **+ Log** on a
  phone. Also: the worker quick start's button names, and EVALUATION-RESPONSE and STRATEGY at 1.23.1. The browser
  suite is still **59 scripts** (five extended). Released as one commit, "Release 1.23.2"; a patch keeps
  `sbom-1.23.0`. `v1.23.2` goes on that commit, in the one push of twelve tags (*Release waiting*, above).
- **Upgrade notes.** Nothing to run: no migration, no new audit action. A *Finish and sign* reminder made by 1.23.0 or
  1.23.1 still closes when its note is signed; a "Call back: client" follow-up made by them still moves with its call.
- **Open items (not fixed; for the owner):** carried from 1.23.1 unchanged: the installer hand-over between two real
  releases has still not been seen; device-id reuse of an administrator-whole device (THREAT-MODEL residual risk 20);
  1.21.0 publication releases cannot be corrected; the installer on real VMs and on RHEL 9; **screen-reader testing**
  of the screens 1.21.0 to 1.23.2 added or changed is still pending (docs/accessibility/ACR-WCAG21.md).
- **Owner-only:** push the twelve tags in one push and approve only `v1.23.2`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md); 1.23.2's commit and zip SHA-256 are filled into the hand-off by a commit after
  its stamp; record each zip's SHA-256 on `main` once its release job has run; make `maint/1.22` from `v1.22.0` once
  the tags exist; the repository settings (docs/RELEASE.md, *Owner: repository settings*). No feature release before
  2026-10-29.

### 2026-10-01 — Claude: 1.23.1 (stabilisation: the release policy on every push, 1.23.0's open items, worker fixes)

- **What shipped.** A patch of 1.23.0 with **no policy exception** (docs/RELEASE.md, *Record: 1.23.1*): no migration,
  no new or widened permission, no new route, 501 lines added outside docs, tests and generated files (`node
  scripts/release-policy.js --version 1.23.1 --previous v1.23.0 --previous-ref 9877d07` passes). The owner chose a
  stabilisation release after ten releases in two days under exceptions, and it carries the commitments that hold
  from now on (docs/RELEASE.md, *Stabilisation (from 1.23.1)*): a feature freeze until 2026-10-29 (1.24.0 at the
  earliest, through the gate), no policy exception but a security fix (`Security exception: <reason>`), 1.23.x the
  supported line, every release tagged by the owner and published by `release.yml`, and no direct `gh-pages` push by
  the assistant once the owed tags exist. CI's new `release-policy` job (`scripts/release-policy-ci.js`) checks the
  policy on every push against the newest tag or, while the tags are owed, the hand-off's commit. Fixes: deactivating
  a worker closes their open field-device request and the administrators' to-dos (new audit action
  `device.field_request.close`), and Approve/Decline note who answered on each to-do; deleting a call, visit or
  referral cancels its untouched follow-up to-do at both doors (a push-only `beforeDelete` hook in the rules); a
  device's to-do can no longer link to a colleague's referral or pass for a supervisor's reminder; the outreach
  waiting list does not count a contact undone since as sent; the office app's service worker installs on a server
  with offline copies off (it stalled at 19 of 62 files), and with no signal the app shows a plain offline page and a
  reload keeps the tab signed in (`sessionStorage`, no PHI); to-dos open the call, visit or referral they came from;
  the sample referrals cite their consent, and an edit to only a shared referral's follow-up date or notes no longer
  asks for a disclosure basis; and the worker polish on a phone (field-device messages when offline copies are off,
  to-do row names, the follow-up date cleared with its box, the open menu over banners, a one-line offline banner,
  Home's to-dos capped at five, Notes kept in clinicians' phone menu). Also: worker quick-start cards
  (docs/QUICK-START-WORKERS.md), the pilot kit's measurement worksheet and feedback procedure, and the evidence on the
  released 1.23.0 (recovery drill, upgrade drill from 1.21.0 and 1.22.0, installer container run, the 1.22.0 release
  fixture). The browser suite is still **59 scripts** (three extended). Released as one commit, "Release 1.23.1"; a
  patch keeps `sbom-1.23.0`. `v1.23.1` goes on that commit, in the one push of eleven tags (*Release waiting*,
  above).
- **Upgrade notes.** Nothing to run: no migration. A field-device request and its to-dos left open by an account
  deactivated before 1.23.1 close the next time an administrator opens Settings › Synced devices. The office app keeps
  who is signed in and the programme's lists in the tab's `sessionStorage` (no PHI; docs/security/DATA-INVENTORY.md).
- **Open items (not fixed; for the owner):**
  - **The installer hand-over between two real releases has still not been seen**: 1.22.0 and 1.23.0 ship the same
    `upgrade.sh` and `lib.sh`, so the installed upgrader ran the upgrade itself (installer run on 1.23.0; exercised
    with a probe build).
  - Carried from 1.23.0: device-id reuse of an administrator-whole device (THREAT-MODEL residual risk 20); 1.21.0
    publication releases cannot be corrected; the installer on real VMs and on RHEL 9; **screen-reader testing** of
    the screens 1.21.0 to 1.23.1 added or changed is still pending (docs/accessibility/ACR-WCAG21.md).
- **Owner-only:** push the eleven tags in one push and approve only `v1.23.1`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md); 1.23.1's commit and zip SHA-256 are filled into the hand-off by a commit after
  its stamp; record each zip's SHA-256 on `main` once its release job has run; make `maint/1.22` from `v1.22.0` once
  the tags exist; the repository settings (docs/RELEASE.md, *Owner: repository settings*). No feature release before
  2026-10-29.

### 2026-10-01 — Claude: 1.23.0 (follow-ups that follow edits, the worker-first menu and phone Home, outreach with no signal)

- **What shipped.** One feature release under a recorded policy exception inside 1.22.0's 28 days (docs/RELEASE.md,
  *Record: 1.23.0*), on the same instruction, "Implement all recommendations to make this as useful as possible for
  suds workers, loop until complete": a follow-up date added, changed or cleared by editing a call or text, a visit or
  a referral makes, moves or cancels its to-do by one rule at both doors, the REST routes and sync push
  (`server/rules/follow-ups.js`, migration **67**: `tasks.call_id`, `tasks.intervention_id`); the menu by role and
  programme profile from one table (`public/nav.js`; `test/nav-menu.test.js` checks every role × profile × module
  switches × screen), with Street outreach in front-line workers' main menu in the harm-reduction and
  treatment-adjacent profiles, and a phone Home that opens on *To-dos for today* with the program-wide cards folded
  (prefs `home_folded`) and a × on the welcome card; on the office app with no signal, a street-outreach contact that
  names nobody waits in the browser (`public/outreach-queue.js`) and is sent later with its Idempotency-Key, the
  contact's id derived from the account and that key (`server/crud.js` `keyedId`), so it is counted once however
  late; *Set up this phone for the field* (`#/field-phone`, `server/field-request.js`) with requests answered under
  Settings › Synced devices; Supervision's *Waiting to hear what happened* with *Remind worker* and *Record outcome*;
  My profile at 1366 px; the SUDS Server rows and the ACR brought up to date. New routes:
  `POST /api/supervision/referrals/:id/remind`, `GET /api/me/field-device`, `POST /api/me/field-device/request`,
  `GET /api/admin/field-requests`, `POST /api/admin/field-requests/:userId/approve` and `…/decline`. **No new
  permission.** Four streams (follow-ups, menu and Home, offline outreach and field requests, supervision), each
  reviewed, then an integration review whose findings were fixed before the stamp (CHANGELOG 1.23.0, *Fixed in the
  review of the 1.23.0 integration*). The browser suite is **59 scripts** with `menu-home.mjs` and
  `offline-outreach.mjs`. Two-commit stamp: "Release 1.23.0", then its SBOM (`docs/evidence/sbom-1.23.0.cdx.json`);
  `v1.23.0` goes on the second, in the one push of ten tags (*Release waiting*, below). The authorship figures (789 of
  808, QUESTIONNAIRE #36a) were counted at `b403d83`, the last commit before the documentation pass and the stamp.
- **Upgrade notes.** Migration 67 runs on start (two nullable columns on `tasks`; an existing follow-up to-do is
  linked to its call or visit the first time the date is changed, found by its title, client, worker and date).
  **Menus change for front-line roles** (navigators, peer navigators and clinicians): Street outreach moves into the
  main menu in the harm-reduction and treatment-adjacent profiles, the Waitlist moves under More in a harm-reduction
  programme, Notes under More on a phone, and *Funding & spending* and *Policies & contracts* appear under More;
  permissions are unchanged, and supervisors, finance, read-only and administrators keep their menus. Tell staff
  before the upgrade. **A phone's Home opens on To-dos for today**; the computer layout is unchanged. **The office
  app now keeps browser-stored data**: street-outreach contacts that name nobody, saved with no signal, wait in
  IndexedDB (`suds-outreach-queue`) until sent: no PHI, not encrypted, per account, kept through sign-out
  (docs/security/DATA-INVENTORY.md). **Workers can ask for a field device**: every administrator gets a to-do, and
  Approve holds the worker's account to the field scope on every device it syncs from (narrowing only; an office
  with offline copies switched off records the decision for when they are switched on).
- **Owner decisions to confirm or change** (each taken with a conservative default and implemented that way):
  - *Peer navigators*: a peer uses a navigator account; there is no separate peer role, and the menu treats them alike.
  - *Money and contracts for front-line roles*: *Funding & spending* and *Policies & contracts*, which a navigator may
    open, are under More, not in the main menu (they were in no menu at all).
  - *The welcome card*: Got it or × puts it away for that person on every device (prefs `tour_done`).
  - *Folded cards*: the program-wide cards on Home start folded on a phone and open on a computer, until the person
    chooses; the choice follows the person (prefs `home_folded`).
  - *The outreach waiting list*: only a contact that names nobody is kept; it is not encrypted (a per-session key would
    lose contacts promised for the next sign-in) and survives sign-out for the same worker; another account on the
    phone neither sees nor sends it; Undo is not offered for a waiting contact.
  - *Field-device requests*: approval binds the account (every device it syncs from), not one device; a worker may ask
    again only after a decline.
  - *Waiting to hear what happened*: Accepted and Waitlisted referrals are the provider's answer and are off the
    supervisor's list (they stay on the worker's own list with their follow-up to-do); one open reminder per
    referral.
  - *Follow-up to-dos*: SUDS changes only a to-do it made that is still as SUDS made it (open, the record's worker's,
    SUDS's title and the record's previous date; to cancel it, no details added); a to-do the worker has changed is
    theirs, and no second one is made while it is open.
- **Open items (not fixed; for the owner):**
  - **A field-device request left open when the worker is deactivated** drops off Settings › Synced devices, but its
    record in `settings` and the administrators' to-dos stay open until someone closes the to-dos.
  - **Deleting a call or visit leaves its follow-up to-do open** (the link is set to null); the worker closes it by
    hand.
  - Carried from 1.22.0: device-id reuse of an administrator-whole device (THREAT-MODEL residual risk 20); 1.21.0
    publication releases cannot be corrected; the installer on real VMs and on RHEL 9; **screen-reader testing**,
    including the screens 1.21.0 to 1.23.0 added (`#/field-phone`, the waiting list, the folded Home, the supervision
    row actions), is still pending (docs/accessibility/ACR-WCAG21.md); the automated axe audits cover them.
- **Owner-only:** push the ten tags in one push and approve only `v1.23.0`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md); record 1.23.0's zip SHA-256 on `main` once its release job has run (1.22.0's is
  in the hand-off); make `maint/1.22` from `v1.22.0` once the tags exist; the repository settings (docs/RELEASE.md,
  *Owner: repository settings*). The next feature release waits 28 days from 1.23.0.

### 2026-10-01 — Claude: 1.22.0 (day to day for workers, field scope by account, publication consent, grace period)

- **What shipped.** One feature release under a recorded policy exception (docs/RELEASE.md, *Record: 1.22.0*), on
  the instruction "Implement all recommendations to make this as useful as possible for suds workers, loop until
  complete": the day-to-day fixes for frontline workers (a call-back date always makes its to-do, quick dates, *Where
  things stand* at the top of a client's Overview, outreach Undo and *Same as last contact* with *Save contact* kept in
  reach, a note's usual format and labelled structured sections, who made each referral in the supervision queue, the
  sync state in the header of a device that syncs with the office, a search hint that fits a phone); the field scope
  bound to the account (migration **64**, `field_accounts`, `devices.scope_set_by`); county publication consent,
  corrected releases and the award pro-rated to the period (migration **65**, `county_publication_consents`,
  `county_publication_inputs`); the authenticator allow-list's grace period (migration **66**,
  `passkeys.allowlist_grace_until`) and the county file version choice; the penetration-test scope drawn from the
  threat model, release integrity said plainly in QUESTIONNAIRE #36/#39 and the RFI, the fuller county packet and the
  ACR revised for 1.21.0's screens; the SUDS Server listener fix under the sandbox and the dry-run and hand-over
  wording; the evidence re-run on 1.21.0. New routes: the three county publication consent routes. No new
  permission. Six streams and an evidence stream, each reviewed, then an integration review whose findings were fixed
  before the stamp (CHANGELOG 1.22.0, *Integration review of the 1.22.0 streams*). The browser suite is **57 scripts**
  with `worker-usefulness.mjs`. Two-commit stamp: "Release 1.22.0", then its SBOM
  (`docs/evidence/sbom-1.22.0.cdx.json`); `v1.22.0` goes on the second, in the one push of nine tags (*Release
  waiting*, below). The authorship figures (760 of 779, QUESTIONNAIRE #36a) were counted at `81fe440`, the last merge
  before the documentation pass and the stamp.
- **Upgrade notes.** Migrations 64 to 66 run on start. **The field scope now follows the account:** a whole device of
  an account held to the field scope (one of its devices was ever a field device, or **New devices start as field
  devices** is on) becomes a field device at its next sync, after sending what it recorded, unless an administrator
  marks it **Keep everything** under Settings › Synced devices first (a device an administrator had already made whole
  keeps that). A device's sync that names no device is refused for such an account; SUDS on a device always sends its
  id. **A county file made by hand is version 1** until the programme answers, once per county code on the Send to the
  county card, that the county runs SUDS 1.21 or later (or the county's connection says it reads version 2). **The
  authenticator allow-list's grace period is 14 days by default**; set 0 for 1.21.0's behaviour. A publication release
  of a period published before 1.22.0 cannot be corrected (it kept no inputs).
- **Owner decisions to confirm or change** (each taken with a conservative default and implemented that way):
  - *Field devices* (docs/PLATFORM.md, *Field devices*): the scope is bound to the account once any of its devices was
    a field device, or while the programme default is on; revoking or wiping a device does not release the account; a
    device sync sign-in without a device id is refused for such an account rather than registered; full scope is a
    per-device administrator decision (*Hold everything* / *Keep everything*), not a per-person flag, so a supervisor's
    new or reinstalled device starts in the field scope; a field device's sync session reaches only sign-in, the second
    step and sign-out of `/api/auth/`.
  - *Publication* (docs/COUNTY-VIEW.md, *Publication*, decisions 3, 7 and 8): a corrected release only of exactly a
    withdrawn release's period (any other overlap still refused; periods published before 1.22.0 stay closed; the
    correction uses the withdrawn release's threshold); a release that would name a programme without a current
    written consent is refused by default, the preparer may leave such programmes out and the release says so; the
    consent record is the county manager's word with the agreement's reference, one current consent per programme,
    and withdrawing it does not withdraw releases already published.
  - *County file version* (COUNTY-VIEW, *Which version a file is made in*): version 2 only when the county is known to
    read it (the connection's `/status`, else the programme's answer per county code); "Don't know" and no answer make
    version 1; making a file for a new county code stops at the question; the connection's word wins over the answer.
  - *Grace period* (docs/FINGERPRINT.md, *Grace period*): 14 days by default, 0 to 90; a date per passkey; saving
    again never lengthens a grace period already running, a shorter one shortens it; never for a model reported
    compromised or revoked; a session opened in a grace period expires when it ends.
  - *Worker defaults* (docs/USER_GUIDE.md): choosing a call-back date ticks *Follow-up needed*; Undo lasts 10 seconds
    and is the worker's own delete (supplies return to stock, audited); *Same as last contact* remembers only item ids
    and counts in the worker's own preferences; a new note starts in its author's last format for that type; a new
    to-do's form has no Status.
- **Open items (not fixed; for the owner):**
  - **Device-id reuse of an administrator-whole device** (THREAT-MODEL residual risk 20): the device id is the
    device's word, so the same account can reuse the id of its own *Hold everything* device and sync whole from
    another device; and the field scope bounds the offline copy, not what the account reads in a browser. A programme
    that wants less narrows the role too.
  - **1.21.0 publication releases cannot be corrected:** they kept nothing to audit a correction against, so their
    periods stay closed (COUNTY-VIEW decision 3).
  - **The installer on real VMs and on RHEL 9** is still owner-pending (docs/evidence/INSTALLER-VM-RUN.md); the 1.21.0
    run was in a container on Ubuntu 24.04.
  - **Screen-reader testing** of the product, including the screens 1.21.0 and 1.22.0 added, is still pending
    (docs/accessibility/ACR-WCAG21.md); the automated axe audits cover them.
  - Carried from 1.21.0: a CalOMS record for a client known only by a participant code can still be saved; servers on
    1.19.0 or 1.20.0 cannot hand over to the new `upgrade.sh`.
- **Owner-only:** push the nine tags in one push and approve only `v1.22.0`'s `Web app` run
  (docs/evidence/RELEASE-HANDOFF.md); record 1.22.0's zip SHA-256 on `main` once its release job has run (1.21.0's is
  in the hand-off); the repository settings (docs/RELEASE.md, *Owner: repository settings*); an independent
  statistical review now covers corrected publication releases too. The next feature release waits 28 days from
  1.22.0.

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
  - ~~A field device's sync session is refused by every route but `/api/sync/` and `/api/auth/`~~ — fixed in
    1.22.0: under `/api/auth/` it reaches only sign-in, the second step and sign-out
    (`server/auth.js` `assertSyncSessionReach`, every request); the field scope follows the account, so another
    device id, none, or re-enrolling no longer leaves it (`server/devices.js`; docs/PLATFORM.md, *Field devices*).
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

