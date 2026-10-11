# Releasing SUDS

## Production readiness checklist (per release)
- [ ] CI is green for the exact commit being released: `npm test`, the browser suite (`scripts/ui/run-all.sh`, 60 scripts including the first-run wizard, local mode, sync, device encryption and recovery, the static build, accessibility and the QA-regression script `a11y-round4`), Node 24 and the recovery drill. The release workflow enforces this (see *Release gate* below); the box is here so nobody tags a commit they have not seen pass
- [ ] `CHANGELOG.md` has a section for the version, `package.json` version matches
- [ ] Docs updated (`README.md`, `docs/INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/HIPAA.md`), and the documents that name a release moved to this one: the questionnaire's *Checked against*, the evidence index's *Version.*, a new SBOM for every release, patches included, from 1.25.2 (*Stamp checklist: the documents that name a release*, below; `test/doc-currency.test.js`)
- [ ] No secrets, databases or `data/` contents in the tree (`git status`, `.gitignore`)
- [ ] Upgrade path: schema migrations in `server/db.js` run on start; take a backup before upgrading
- [ ] Nothing native: no APK, launcher or mobile step is part of the release (removed in 1.9.3; docs/PLATFORM.md)
- [ ] CI's advisory jobs looked at: `webkit` (WebKit smoke subset) and `release-state` (the release documents against origin's tags, `main` and GitHub Pages; *Stamp checklist: the release state*, below). A red advisory job is not a blocker but gets an issue. (`node24` is a required job since the release after 1.11.0; it passed on the 1.11.0 release commit.)
- [ ] Real-device checklist done on the release candidate (2 iPhones, 2 Androids — [ADOPTION.md](ADOPTION.md#4-real-device-release-checklist))
- [ ] **On-screen version checked**: after deploying to the pilot server, and on the GitHub Pages site (SUDS on this device) once it is republished, the version SUDS shows (footer / `version.json`) is the version being released

## Release cadence (policy)

SUDS shipped 21 releases in its first ten days. That speed fixed defects quickly, but a county cannot
review, test and roll out a release a day, and the same kind of defect shipped more than once. From 1.11.0:

| Kind | Version bump | How often | What it may contain |
| --- | --- | --- | --- |
| **Feature release** | minor (`1.12.0`) | **At most once a month** | New features, schema migrations, changed permissions or reports |
| **Fix release** | patch (`1.11.1`) | As needed | Defect and security fixes only. **No schema migration**, no new permission, no new route unless the fix needs it (say why in the notes) |
| **Security release** | patch | As soon as a fix is ready | The fix, and an advisory naming affected versions; counties are told directly |

Rules for every release:

1. **Only from a green gate.** The released commit must have passed CI in full — `npm test`, the drift
   checks and the browser suite (`scripts/ui/run-all.sh`, including its accessibility script) — on that exact
   commit, not on a nearby one. A red or skipped required job means no release.
2. **Release notes reviewed by a human.** The CHANGELOG section is read and approved by the owner (or the
   named code owner) before tagging, whoever drafted it — including an AI assistant. The reviewer checks that
   it says what changed for a user, what an administrator must do, and whether there is a migration.
3. **Migrations are called out** at the top of the notes with the schema version they move to.
4. **Batch, don't drip.** Fixes found during a feature release's pilot week go into one fix release, not one
   release each.
5. The staged rollout ([ADOPTION.md](ADOPTION.md#3-staged-release-cadence)) still applies: pilot group first.

### Stabilisation (from 1.23.1)

Ten releases, 1.16.3 to 1.23.0, shipped in about two days; every feature release among them went out under a policy
exception, and none was tagged or went through the release gate (the *Record* entries and the exceptions table,
below). A county IT reviewer reads that as a release process that is written down but not followed. The owner chose
a stabilisation release, 1.23.1, and these commitments, which hold until this section is changed by the owner:

1. **Feature freeze.** The next feature release, 1.24.0, comes **no earlier than 2026-10-29**, 28 days after 1.23.0
   (released 2026-10-01), and only through the release gate: a `v1.24.0` tag the owner pushes, `release.yml`'s gate,
   verify and approved release job. Until then only patch releases (1.23.x): defect and security fixes, no schema
   migration, no new or widened permission, no new route, at most 1,500 counted lines. **The owner lifted the freeze
   for 1.24.0** ("Lift the freeze and release", 2026-10-02) to release the fixes of an owner-authorised white-box
   penetration test of 1.23.6, under point 2's one exception, a security fix: 1.24.0 is stamped 2026-10-03, two days
   after 1.23.0, with its `Security exception:` line (*Record: 1.24.0*). The next feature release, 1.25.0, comes no
   earlier than 2026-10-31, 28 days after 1.24.0, and only through the release gate.
2. **No further policy exceptions, except a security fix.** A release that breaks the cadence or the patch rules is
   made only to ship a security fix that cannot wait, and its CHANGELOG section or its *Record* says so on a line of
   its own, `Security exception: <reason>`, which the CI check below reads. An owner's wish for a feature sooner is
   not an exception any more: it waits for the next feature release.
3. **1.24.x was the supported line until 1.25.0.** It got every defect and security fix as a patch until 1.25.0 was
   released; from then, security fixes only, for **30 days after 1.25.0's release date** (the date of its tag; plan
   as if they run from its stamp, 2026-10-05), from `maint/1.24` (*Supported versions* and *Backports*, below).
   1.25.x is the supported line now; 1.23.x and older get nothing more.
4. **Every release is tagged by the owner and published by `release.yml`.** The owner pushes the `vX.Y.Z` tag; the
   GitHub Release, its zip and checksum come from `release.yml`, and GitHub Pages is updated by the `Web app` run that
   release starts, approved in the `release` environment. **Once the owner has pushed the owed tags
   ([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), the maintaining assistant does not push `gh-pages`
   directly again**, for any reason. Until those tags exist, a direct push of a stamped, CI-green build to `gh-pages`
   is the only path the assistant has to publish, and each such push is recorded in that version's *Record* and in
   the exceptions table (as 1.16.4 to 1.23.0 were).
5. **The policy is checked on every push, not only at a tag.** CI's `release-policy` job
   (`scripts/release-policy-ci.js`) compares each pushed commit with the newest release: its tag, or, while the tags
   are owed, the commit the hand-off records for it (`scripts/release-policy.js --previous-ref`). Work after a
   released version is checked as its next patch while the feature interval runs; a stamped patch that adds a
   migration, a permission or a route, or goes over the size limit, fails; a minor stamped within 28 days of the
   previous feature release fails unless a security exception is recorded. A red `release-policy` job fails the CI
   run, and the release gate refuses a commit whose CI run failed.

**Record: 1.23.1 ships without a policy exception.** 1.23.1 is a patch of 1.23.0 under the patch rules, the first
release under *Stabilisation*: no migration, no new or widened permission, no new route, and 501 lines added outside
docs, tests and generated files, within the 1,500-line limit (`node scripts/release-policy.js --version 1.23.1
--previous v1.23.0 --previous-ref 9877d07` passes). It carries fixes (the open
items 1.23.0 left, a device's to-do linked to a colleague's referral, the outreach waiting list, the office app's
service worker and offline page, the worker-facing fixes on a phone), the release-policy check on every push, these
commitments, tests, documentation and the evidence on the released 1.23.0; the exceptions table has no row for it. It
is released as one commit, "Release 1.23.1" (a patch keeps its minor's SBOM, `sbom-1.23.0`), and that commit is the
one CI passes and the owner tags: `v1.23.1` goes in the same push as the ten tags owed before it (step 2 of
[evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), it is the newest tag, and its `release.yml` run, whose
gate passes with no `policy_exception`, is the Latest release and starts the `Web app` run that publishes it. If
1.23.1 has to go live before the owner has pushed the tags, the direct `gh-pages` push is said here and in the
exceptions table, as point 4 requires; it is not a policy exception (the patch rules pass), but it is not the gate
either. It did: the tags were still owed when CI passed on `3bff36f` (all nine jobs, 2026-10-01), so `3bff36f` was
pushed to `main` and its static build to `gh-pages` directly ("Deploy 3bff36f (SUDS 1.23.1)"; `release-site-check`
found the 73 built files the commit's, byte for byte), and the exceptions table has a row for that push.

**Record: 1.23.2 ships without a policy exception.** 1.23.2 is a patch of 1.23.1 under the patch rules and
*Stabilisation*: no migration, no new or widened permission, no new route, and 188 lines added outside docs, tests and
generated files, within the 1,500-line limit (`node scripts/release-policy.js --version 1.23.2 --previous v1.23.1
--previous-ref 3bff36f` passes). It carries fixes from the evaluation of 1.23.1 and its integration review (Home's
to-dos on a phone, follow-up to-do titles and links, a supervisor's sign reminder per author and client record, a
deleted referral's reminder, a clinician's new note type, controls under the **+ Log** button), tests and
documentation; the exceptions table has no row for it. It is released as one commit, "Release 1.23.2" (a patch keeps
its minor's SBOM, `sbom-1.23.0`), and that commit is the one CI passes and the owner tags: `v1.23.2` goes in the same
push as the eleven tags owed before it (step 2 of [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), it is
the newest tag, and its `release.yml` run, whose gate passes with no `policy_exception`, is the Latest release and
starts the `Web app` run that publishes it. If 1.23.2 has to go live before the owner has pushed the tags, the direct
`gh-pages` push is said here and in the exceptions table, as point 4 requires; it is not a policy exception (the patch
rules pass), but it is not the gate either. It did: the tags were still owed when CI passed on `a45c716` (2026-10-01),
so `a45c716` was pushed to `main` and its static build to `gh-pages` directly ("Deploy a45c716 (SUDS 1.23.2)";
`release-site-check` found the 73 built files the commit's, byte for byte), and the exceptions table has a row for it.

**Record: 1.23.3 ships without a policy exception.** 1.23.3 is a patch of 1.23.2 under the patch rules and
*Stabilisation*: no migration, no new or widened permission, no new route, and 187 lines added outside docs, tests and
generated files, within the 1,500-line limit (`node scripts/release-policy.js --version 1.23.3 --previous v1.23.2
--previous-ref a45c716` passes). It carries fixes from the external retest of 1.23.2 and the integration review
(**View in Done** after a to-do is marked done, Home laid out again when the screen's width changes, a *Finish and
sign* reminder only from someone who countersigns notes, and **Open <client>'s notes** from one), tests and
documentation; the exceptions table has no row for it. It is released as one commit, "Release 1.23.3" (a patch keeps
its minor's SBOM, `sbom-1.23.0`), and that commit is the one CI passes and the owner tags: `v1.23.3` goes in the same
push as the twelve tags owed before it (step 2 of [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), it is
the newest tag, and its `release.yml` run, whose gate passes with no `policy_exception`, is the Latest release and
starts the `Web app` run that publishes it. If 1.23.3 has to go live before the owner has pushed the tags, the direct
`gh-pages` push is said here and in the exceptions table, as point 4 requires; it is not a policy exception (the patch
rules pass), but it is not the gate either. It did: the tags were still owed when CI passed on `c02a261` (2026-10-01;
the `thorough` and `webkit` jobs re-run once after failures the same app code had passed on the stamp it replaced,
`a263174`), so `c02a261` was pushed to `main` and its static build to `gh-pages` directly ("Deploy c02a261 (SUDS
1.23.3)"; `release-site-check` found the 73 built files the commit's, byte for byte), and the exceptions table has a
row for it.

**Record: 1.23.4 ships without a policy exception.** 1.23.4 is a patch of 1.23.3 under the patch rules and
*Stabilisation*: no migration, no new or widened permission, no new route, and 111 lines added outside docs, tests and
generated files, within the 1,500-line limit (`node scripts/release-policy.js --version 1.23.4 --previous v1.23.3
--previous-ref c02a261` passes). It carries fixes from the market evaluation of 1.23.3 and the integration review (a
*Finish and sign* reminder that only its maker or someone who countersigns notes can give to someone else or move to
another client, Home's keyboard focus kept through a re-layout, the to-do just done listed first by **View in Done**,
clearer reminder and delete wording, and no tick box on a to-do you may not mark done), tests and documentation; the
exceptions table has no row for it. It is released as one commit, "Release 1.23.4" (a patch keeps its minor's SBOM,
`sbom-1.23.0`), and that commit is the one CI passes and the owner tags: `v1.23.4` goes in the same push as the
thirteen tags owed before it (step 2 of [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), it is the newest
tag, and its `release.yml` run, whose gate passes with no `policy_exception`, is the Latest release and starts the
`Web app` run that publishes it. If 1.23.4 has to go live before the owner has pushed the tags, the direct `gh-pages`
push is said here and in the exceptions table, as point 4 requires; it is not a policy exception (the patch rules
pass), but it is not the gate either. It did: the tags were still owed when CI passed on `598d08b` (2026-10-01, every
job green at the first attempt), so `598d08b` was pushed to `main` and its static build to `gh-pages` directly
("Deploy 598d08b (SUDS 1.23.4)"; `release-site-check` found the 73 built files the commit's, byte for byte), and the
exceptions table has a row for it.

**Record: 1.23.5 ships without a policy exception.** 1.23.5 is a patch of 1.23.4 under the patch rules and
*Stabilisation*: no migration, no new or widened permission, no new route, and 91 lines added outside docs, tests and
generated files, within the 1,500-line limit (`node scripts/release-policy.js --version 1.23.5 --previous v1.23.4
--previous-ref 598d08b` passes). It carries fixes from the market evaluation of 1.23.4 (**Delete call** on a phone,
a *Finish and sign* reminder's fixed fields for whoever may not change them, toggles whose state is not shown by
colour alone, an audit entry of its own for a reminder closed by signing, the cancelled reminders in a caseload
transfer's result, no **Remind author** for an inactive author, and a question before a sign reminder is ticked done
with drafts left), tests and documentation; the exceptions table has no row for it. It is released as one commit,
"Release 1.23.5" (a patch keeps its minor's SBOM, `sbom-1.23.0`), and that commit is the one CI passes and the owner
tags: `v1.23.5` goes in the same push as the fourteen tags owed before it (step 2 of
[evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), it is the newest tag, and its `release.yml` run, whose
gate passes with no `policy_exception`, is the Latest release and starts the `Web app` run that publishes it. If
1.23.5 has to go live before the owner has pushed the tags, the direct `gh-pages` push is said here and in the
exceptions table, as point 4 requires; it is not a policy exception (the patch rules pass), but it is not the gate
either. It did: the tags were still owed when CI passed on `382278a` (2026-10-02, every job green at the first
attempt), so `382278a` was pushed to `main` and its static build to `gh-pages` directly ("Deploy 382278a (SUDS
1.23.5)"; `release-site-check` found the 73 built files the commit's, byte for byte), and the exceptions table has a
row for it.

**Record: 1.23.6 ships with an owner-approved exception.** 1.23.6 is a patch of 1.23.5 that widens what an
administrator may do: whoever holds *Manage users & permissions* (`users:manage`, which only an administrator can
hold) may now change their own individual permissions, their own role and their own account (deactivating it
included), and include themselves in *Apply to existing navigators and clinicians*; on SUDS on this device the
person who manages it may change their own role. Until 1.23.5 each of those was refused. The owner asked for it
("Admin needs to be able to change all permissions including their own") and, told that *Stabilisation* point 1 allows
no new or widened permission in a patch and point 2 no exception but a security fix, chose to ship it now, as 1.23.6,
with the exception recorded, rather than hold it for 1.24.0. **It is not a security fix**, and this record does not
call it one: it is the owner's decision to widen an administrator's own access during the feature freeze, and it
breaks points 1 and 2 as written. No `Security exception:` line is recorded for it, because that line is for a
security fix only (and `scripts/release-policy-ci.js` reads it only for a minor or major bump). The release-policy
check passes mechanically: no migration, no permission name, no grant of a permission to another role and no route
is added (the widening is in who may act on whom, `server/routes/users.js`, `server/auth.js` and the device's
`PUT /api/local/accounts/:id`, not in `PERMS`), and 224 lines are added outside docs, tests and generated files,
within the 1,500-line limit (`node scripts/release-policy.js --version 1.23.6 --previous v1.23.5 --previous-ref
382278a` passes). So no check sees the exception; it is recorded here by hand, in the CHANGELOG section and in the
exceptions table. The safeguards it ships with: a **lockout guard** (`server/auth.js` `lockoutProblem`) that refuses
any change, to oneself or to anyone (a role change, a deny, removing an override, a deactivation), that would leave
the programme, or the device, with no active account able to manage users and permissions ("This would leave no
active administrator who can manage users. Give another account that access first."), with the check and the write
run without a pause between them (its security review); a **confirmation** in Users & permissions before every change
to one's own access, naming what is lost or gained; **audit** of each such change as of one to anyone else, with
`self: true` in its details, and of each refusal (`user.permission.denied`, or the new `user.update.denied`;
`local.account.role.denied` on a device). It follows that a per-user deny placed on an administrator is now
**advisory**, since the administrator may remove it (audited): to restrict an administrator, change their role
(docs/security/IDENTITY.md). An office administrator who steps down still cannot promote themselves back (1.15.4
M2); separation of duties (approving one's own time or spending, acknowledging one's own break-glass access) is
unchanged; SCIM provisioning and single sign-on deprovisioning are not held back by the guard. *Stabilisation*
otherwise stands unchanged: the feature freeze until 2026-10-29, and no further exception but a security fix. It
is released as one commit, "Release 1.23.6" (a patch keeps its minor's SBOM, `sbom-1.23.0`), and that commit is the
one CI passes and the owner tags: `v1.23.6` goes in the same push as the fifteen tags owed before it (step 2 of
[evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), it is the newest tag, and its `release.yml` run is the
Latest release and starts the `Web app` run that publishes it. Its gate passes with no `policy_exception`, so the
gate writes no exception paragraph into its GitHub Release notes; the owner adds this exception to the top of those
notes by hand (`gh release edit v1.23.6 --notes-file`), as every exception is stated there. If 1.23.6 has to go live
before the owner has pushed the tags, the direct `gh-pages` push is said here and in the exceptions table, as point 4
requires. It did: the tags were still owed when CI passed on `57bf2df` (2026-10-02, every job green at the first
attempt), so `57bf2df` was pushed to `main` and its static build to `gh-pages` directly ("Deploy 57bf2df (SUDS
1.23.6)"; `release-site-check` found the 73 built files the commit's, byte for byte).

**Record: 1.24.0 ships under a security exception.** 1.24.0 is a feature release stamped 2026-10-03, two days after
1.23.0 (2026-10-01), inside its 28 days and inside the feature freeze of *Stabilisation* point 1, which held 1.24.0
until 2026-10-29. It is released under the one exception point 2 allows, a security fix: the owner authorised a
white-box penetration test of 1.23.6, whose findings were two Medium (M1, a consent's purpose not checked at a
disclosure, against 42 CFR 2.31(a)(4); M2, a device's sync push bringing back a row the office had deleted) and seven
Low (L1 password strength, L2 sign-in limits keyed on the address alone, L3 a push editing a signed note counted as
applied, L4 paging answering 500, L5 the audit head not sealed until the first housekeeping, L6 a sync session
reaching account management, L7 `client_id` filters ignored), and, told that the freeze held 1.24.0 until
2026-10-29, instructed on 2026-10-02 "Lift the freeze and release". The exception, on the line
`scripts/release-policy-ci.js` reads:

Security exception: fixes for the owner-authorised white-box pen test of 1.23.6 (M1 consent purpose limitation under 42 CFR 2.31(a)(4), M2 a sync push undoing an office deletion, and seven Low findings), released inside 1.23.0's 28 days on the owner's instruction of 2026-10-02 to lift the freeze

The exception is for the timing of a minor. The fixes were made and reviewed on the combined 1.24.0 tree (M1's purpose
rule was widened after its review there, so that everyday referrals still pass), so 1.24.0 also carries the feature
work done for it during the freeze, each stream reviewed on its branch and the combined tree reviewed again before the
stamp: incoming referrals (migration 70; the new permissions `intake:read` and `intake:write`), possible duplicate
time (migration 68), a sign reminder that opens its draft (migration 69), scheduled backups on SUDS on this device, the
Security & procurement page and the hardening checklist, the clinical guards and the draft fix from the persona test of
1.23.6 (with a departed author's drafts handed on, `note.reassign`), `npm run try` and Windows compatibility, and
`suds.exe`, the office server for Windows with its Windows service and management commands, by the owner's decision of
2026-10-03, which reverses 1.9.3's rule against launchers for a Windows server executable only (docs/PLATFORM.md); its
CI job, `windows-exe`, is not in the release gate's required jobs. 22 routes are added (the CHANGELOG section lists
them). With the line recorded, CI's `release-policy` job passes on the stamp (a minor two days after 1.23.0, allowed by
the security exception); without it the job fails. Like 1.23.0, 1.24.0 is released as two commits, the stamp and its
SBOM (*Stamp checklist*); the second is the one CI passes, that goes to `main`, and that the owner tags: `v1.24.0`
goes in the same push as the sixteen tags owed before it (step 2 of
[evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), it is the newest tag, and its `release.yml` run is the
Latest release, attaches the Windows server zip (unsigned until the owner adds the code-signing secrets,
`WINDOWS_CERT_PFX_BASE64` and `WINDOWS_CERT_PASSWORD`) and starts the `Web app` run. Its gate is refused on the
feature interval (`v1.23.0` is minutes old), so the owner runs the workflow again on `v1.24.0` with `policy_exception`
set to this exception, which the release job prints at the top of its notes. If 1.24.0 has to go live before the owner
has pushed the tags, the direct `gh-pages` push is said here and in the exceptions table, as point 4 requires. The
independent penetration test (docs/security/PEN-TEST-SCOPE.md) is still owed: this white-box test, authorised by
the owner, was not an independent one and does not replace it.

**Record: 1.24.1 ships without a policy exception.** 1.24.1 is a patch of 1.24.0 under the patch rules and
*Stabilisation*: no migration, no new or widened permission, no new route, and 311 lines added outside docs, tests and
generated files, within the 1,500-line limit (`node scripts/release-policy.js --version 1.24.1 --previous v1.24.0
--previous-ref d2fd172` passes; CI's `release-policy` job, `scripts/release-policy-ci.js`, gives the same figure).
The feature freeze holds back feature releases, not patches, so **no exception is needed**: it is not a security
fix and records no `Security exception:` line, and the exceptions table's row for it records only how it is
published. It carries the owner's decision of 2026-10-03 to make SUDS proprietary (`LICENSE`, the SUDS Proprietary
Licence, "Copyright (c) 2026 AugustInnovations LLC"; the 90-day evaluation grant covers fictional data only;
section 2A keeps SUDS on this device at its official GitHub Pages address free for real use; everything else needs a
signed agreement; 1.24.0 and earlier stay MIT for the copies already received; `NOTICE` lists the third-party
components, and the Pages build carries `LICENSE.txt` and `NOTICE.txt`). A change of licence is the owner's decision
as copyright holder, not a change of behaviour the release policy measures, and it adds no migration, permission or
route. With it, fixes from the market evaluation of 1.24.0 (D1 HTTPS seen at once after the setup wizard, D2 no
two-step lockout on the `npm run try` sample accounts, D3 a common password with extra letters refused, D4 the
referral form's wording for a consent that names the provider for another purpose, D5 a switched-off module's forms
gone after a refused save, D6 a sign reminder its assignee cannot mark done while their drafts are unsigned, a 409
over REST and sync push, D7 the device backup due today rather than overdue and the procurement settings' wording),
the Windows smoke test completing the setup wizard under the service, tests and documentation. It is released as one
commit, "Release 1.24.1" (a patch keeps its minor's SBOM, `sbom-1.24.0`), and that commit is the one CI passes and
the owner tags: `v1.24.1` goes in the same push as the seventeen tags owed before it (step 2 of
[evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), it is the newest tag, and its `release.yml` run, whose
gate passes with no `policy_exception`, is the Latest release and starts the `Web app` run that publishes it. If
1.24.1 has to go live before the owner has pushed the tags, the direct `gh-pages` push is said here and in the
exceptions table, as point 4 requires; it is not a policy exception (the patch rules pass), but it is not the gate
either. It did: the tags were still owed, so on 2026-10-03, at the owner's request to build and
release 1.24.1, it was published to GitHub Pages by a direct push to `gh-pages` (`d109d32`, the commit CI passes).

**Record: 1.25.0 ships on the owner's explicit instruction to lift the freeze.** 1.25.0 is a feature release
stamped 2026-10-05, two days after 1.24.0 (2026-10-03), inside its 28 days and inside the feature freeze of
*Stabilisation* point 1. The owner lifted the freeze for it explicitly on 2026-10-05: "Fix everything now, freeze
lifts to 1.25.0". This is not a security fix, so no `Security exception:` line is recorded; the owner runs the
tag's release with `policy_exception` set to this instruction, which the release job prints at the top of its
notes. It carries the CalOMS Tx dictionary verification (all 17 code sets rewritten from the DHCS Data Dictionary
v3.0, File Version 3.0, October 2024; yes/no as numeric 1/0; LEG-1 criminal justice status, MED-7 medication
prescribed, CID-19 consent for future contact and CID-20 sexual orientation added; sex at birth removed; new edit
checks; migration 71 remapping stored answers), better resource-directory pictures (a picture for every
provider whose site allows an automated download; the 1.25.0 build bundled 40 of the 81, because many
provider sites refuse automated downloads from the build server; each build's count is the `summary` in its
`region-pictures/<region>/manifest.json`), and the UI intuitiveness pass (plainer call/text form labels, an accessible resource-directory view toggle). The
SBOM, `sbom-1.25.0` (in the evidence index), was first committed with the stamp preparation from `1474829e`
("Release 1.25.0"), whose kernel was still 1.24.4's; it is regenerated from the tag (`node scripts/sbom.js --ref
v1.25.0`, 2026-10-08) and describes the shipped commit. The stamp was split over three commits, so the tag
`v1.25.0` is on `82f92a00` ("Rebuild public assets for the 1.25.0 stamp"), not on "Release 1.25.0"
([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)). The tag was pushed
and released on 2026-10-06: its `release.yml` run is the Latest release, attaches the Windows server zip (unsigned
until the owner adds the code-signing secrets, `WINDOWS_CERT_PFX_BASE64` and `WINDOWS_CERT_PASSWORD`) and started
the `Web app` run, and GitHub Pages serves 1.25.0. No tag is owed.

**Record: 1.25.1 is a patch with the fixes from the evaluation of 1.25.0.** 1.25.1, stamped 2026-10-08, is a
patch of 1.25.0 inside 1.25.0's 28 days, which a patch may be (*Stabilisation*, point 1). It fixes E1 to E11 of the
evaluation of 1.25.0 (HANDOFF.md, 2026-10-08): one programme-local "today" on the server and in the browser, with a
CI `evening` job that runs the tests at 9pm in Los Angeles (E1); the release-state test that turned main red after
every release record (E2); an honest user agent and picture count for the provider pictures (E3); 1.25.0's SBOM,
recheck command and checksums (E4); the tags without a GitHub Release (E5); one pricing source of truth (E6);
repeated race and disability codes read and saved once, with migration 71's list mapping deduplicated as a reviewed
edit of a released migration (`scripts/migration-order.js`, `RELEASED_EDITS`; E7); two-digit years and an hour alone
in typed dates and times, and two-digit years in a spreadsheet import (E8); the provider activity file's `Y`/`N`
documented (E9); the hand-off's personal and third-party details (E10); and the cosmetic items (E11). No new
migration, no new or widened permission and no new route, 412 lines added outside docs, tests and generated
files (`node scripts/release-policy.js --version 1.25.1 --previous v1.25.0`), so it passes the release policy with
no exception. It is released as one commit, "Release 1.25.1" (a patch keeps its minor's SBOM, `sbom-1.25.0`), the
commit CI passes and the owner tags: `git tag -a v1.25.1 <that commit> -m "SUDS 1.25.1"`, then `git push origin
v1.25.1` starts its `release.yml` run, whose release is the Latest and starts the `Web app` run that publishes it
([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)). The v1.25.0 GitHub Release's notes said "10 hours
after the previous one" (the gate measured from when v1.24.0's tag was pushed, 2026-10-05, not from its release on
2026-10-03) and repeated the picture and Y/N claims; their corrected text is
[evidence/release-notes-v1.25.0.md](evidence/release-notes-v1.25.0.md), which the owner applied. The owner pushed
`v1.25.1` on 2026-10-08 (a session's push was refused by the `v*` tag ruleset, as intended): its release run passed the
gate with no `policy_exception`, published the Release as Latest with a zip equal to the checksum recorded before the
tag, and its `Web app` run published 1.25.1 to GitHub Pages. No tag is owed.

**Record: 1.25.2 is a patch with the fixes from testing every position on 1.25.1.** 1.25.2, stamped 2026-10-08, is
a patch of 1.25.1 inside 1.25.0's 28 days, which a patch may be (*Stabilisation*, point 1). On the owner's request
("Test all positions", then "fix all the findings and release 1.25.2"), every position was tested in a browser on the
released 1.25.1, and the release was evaluated (HANDOFF.md, 2026-10-08). 1.25.2 fixes what a patch may carry: the
restored-database locking (BO1), the CalOMS special answers in the episode dialogs (CS1), the setup wizard's dropped
answers (BO2), an administrator's self-granted clinical-note access (BO3), spreadsheet-import and API dates (BO4,
BO5), finance's ledger export (BO6), and the other findings FL1–FL16, CS2–CS18, BO7–BO25 and F1–F8. A sound-alike
index for first names (FL5) needs a migration, and renaming export column headings (BO22) could break a county's
import, so both wait for 1.26. No migration, no new or widened permission and no new route, 754 lines added
outside docs, tests and generated files (`node scripts/release-policy.js --version 1.25.2 --previous v1.25.1`), so it
passes the release policy with no exception. It is the first patch with an SBOM of its own (F6): the release is two
commits, "Release 1.25.2" (the stamp) and "SBOM of the 1.25.2 stamp", and the tag goes on the second, the commit CI
passes. The owner pushes `v1.25.2` ([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)); its `release.yml`
run, whose gate passes with no `policy_exception`, is the Latest release and starts the `Web app` run that publishes it.

**Record: 1.25.3 is a patch with the fixes from the launch of suds.systems.** 1.25.3, stamped 2026-10-09, is a patch of
1.25.2 inside 1.25.0's 28 days, which a patch may be (*Stabilisation*, point 1). It fixes the two installer findings of
the launch of the production install at suds.systems on 2026-10-08 (the SSH rule the firewall clean-up deleted with
`--admin-cidr=0.0.0.0/0`; `www.<domain>` with no certificate, and upgrades that replaced a locally edited Caddyfile
without a word) and the first administrator's username missing from the installer's output, and the findings of the
owner-authorised black-box and code-review test of that live install (MINOR-1, lockout telling which usernames exist;
MINOR-2, anonymous health warnings; INFO-2 and INFO-3). No migration, no new or widened permission and no new route,
210 lines added outside docs, tests and generated files (`node scripts/release-policy.js --version 1.25.3
--previous v1.25.2`), so it passes the release policy with no exception. Like 1.25.2 it is two commits, "Release 1.25.3"
and "SBOM of the 1.25.3 stamp", the tag on the second. `v1.25.2` had not been pushed when 1.25.3 was stamped, so the
owner pushes both tags in one push ([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)); `v1.25.3`, the newest, is
the Latest release and its `Web app` run publishes 1.25.3. **Upgrade suds.systems to 1.25.3, not 1.25.2**: before
1.25.3 an upgrade replaces the hand-edited Caddyfile and drops the www redirect (deploy/linux/README.md, *Before
upgrading suds.systems from 1.25.1*). The first "Release 1.25.3" (`d12ab47`, with its SBOM commit `5b83686`) was never
tagged: its own record used a phrase `test/release-wording.test.js` refuses, and its exact-commit CI was red. A second
"Release 1.25.3" corrects that sentence and nothing else, and its SBOM commit is the one tagged (the release job's
"not the version stamp" note is expected: `d12ab47` set the version).

**Record: 1.25.4 is a patch with the fixes from the market-readiness evaluation of 1.25.3.** 1.25.4, stamped
2026-10-10, is a patch of 1.25.3 inside 1.25.0's 28 days, which a patch may be (*Stabilisation*, point 1). It fixes the
evaluation's findings G1–G11 (flaky CI checks fixed at the cause and CI naming its failures; a device database that
will not open refused, kept and offered as a file; offline preference changes kept; the installer's
`--admin-cidr6`; finance's year-only rows explained; buyer documents, the stored pen test of suds.systems, tag-signing
steps, draft agreements for counsel, and install, upgrade and recovery-drill evidence regenerated on 1.25.3), a real
consent bug found while fixing a flake (a consent picked while the provider's consents were reloading was cleared,
and the referral saved relying on none), and the offsite-backup defect reported from suds.systems on 2026-10-09: under
the unit's `SystemCallFilter=~@privileged`, Node's `copyFile` called `fchown` and the kernel stopped SUDS before any
byte was copied, so every scheduled offsite copy was a 0-byte file and nothing was logged. It also carries the Option A
fleet tooling (`deploy/fleet/`). No migration, no new or widened permission and no new route, 935 lines added
outside docs, tests and generated files (`node scripts/release-policy.js --version 1.25.4 --previous v1.25.3`), so it
passes the release policy with no exception. It is two commits, "Release 1.25.4" and "SBOM of the 1.25.4 stamp", the
tag on the second, and the full suite ran on the stamped tree before the push (G6). After upgrading, an operator checks
the offsite copies (deploy/linux/README.md, *Check your offsite backups*). The owner pushed `v1.25.4` on 2026-10-10; its
release run passed the gate, the GitHub Release is published and marked Latest, its zip equals the checksum recorded
before the tag, and its `Web app` run published 1.25.4 to GitHub Pages ([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)).

**Record: 1.25.5 is a patch with the fixes from the market-readiness evaluation of 1.25.4.** 1.25.5, stamped
2026-10-10, is a patch of 1.25.4 inside 1.25.0's 28 days, which a patch may be (*Stabilisation*, point 1). It fixes the
evaluation's findings H1–H9: on SUDS on this device, a sign-in asks a fresh engine once more before it calls the
records damaged, says the first time that it may be the browser, puts the ways back in order and lets *Restore from a
backup* take the saved damaged copy (H1), and a stored copy whose seal fails is handled as that damage instead of a
generic error (H2); an offsite backup folder inside the data directory is refused and one on the same disk reported
(H3); a new CI job, `service-sandbox`, runs SUDS Server inside its own systemd unit and drives a backup, drill and
restore (H4); buyer documents give suds.systems' later compliance run (H5); every runner image is pinned (H6); a
re-run of the installer keeps a hand-added IPv6 SSH rule (H7); the release gate requires `evening`, the Release
carries its SBOM, and the questionnaire's version paragraph is cut (H8); offsite copies are compared by SHA-256 and
stale `.part` files pruned (H9). It also adds the business work plan and its templates (docs/market/). No migration,
no new or widened permission and no new route, 738 lines added outside docs, tests and generated files (`node
scripts/release-policy.js --version 1.25.5 --previous v1.25.4`), so it passes the release policy with no exception. It
is two commits, "Release 1.25.5" and "SBOM of the 1.25.5 stamp", the tag on the second, and the full suite, the
evening run and the browser suite ran on the stamped tree before the push (*Stamp checklist*). Not done here and
recorded as owed: a real-iPhone record (docs/ADOPTION.md §4) and a measured WebKit failure rate. In CI's WebKit every new
check passes; the reload after Start over, a restore and a sign-out crashes the page there, the records surviving it
(flake register), and the iPhone checklist tests that reload. The owner pushed `v1.25.5`; its release run passed the
gate on 2026-10-11 (UTC), the GitHub Release is published and marked Latest with its SBOM attached, its zip equals the
checksum recorded before the tag, and its `Web app` run published 1.25.5 to GitHub Pages
([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)).


### Supported versions

| Line | Gets | For how long |
| --- | --- | --- |
| **The latest minor** (today 1.25.x) | Every fix: defects and security, as patch releases on that line | Until the next minor is released |
| **The previous minor** (today 1.24.x, until 30 days after 1.25.0's release date: the date of its tag, 2026-10-06) | **Security fixes only**, as a patch on that line, where the fix applies to it, released from its `maint/X.Y` branch (since 1.17.0: *Backports*, below; `maint/1.24` is made from `v1.24.4`'s line) | **30 days** after the next minor's release date, then none |
| Anything older (today 1.23.x and before: once 1.25.0 was released, 1.23.x stopped being the previous minor, whatever was left of its 30 days after 1.24.0; 1.22.x stopped when 1.24.0 was released) | Nothing: upgrade to the latest minor ([Upgrading an existing install](#upgrading-an-existing-install)) | — |

Security fixes are announced as a GitHub Security Advisory and an *Advisory* note at the top of the release's
CHANGELOG section, naming the affected versions (as 1.15.4 did); programmes with a support agreement are told
directly. The project has one maintainer: this is a best-effort commitment, not a contractual SLA, and response
times are those of [templates/SUPPORT-SLA.md](market/templates/SUPPORT-SLA.md) where a programme has signed one.
**A security release waits for the owner.** Since 1.16.3 a release is a `v*` tag the owner pushes, and the
maintaining assistant cannot push tags at all (*Handing a release to the owner*, below), so "as soon as a fix is
ready" means as soon as the owner can tag it. No backup releaser is named today; one would be a second
administrator, added to the `v*` tag ruleset's bypass list and as a reviewer of the `release` environment
(*Owner: repository settings*, steps 1 and 3), and named here.
A change of default behaviour (such as 1.16.0's wider role defaults) is only made in a minor release and is
named at the top of its CHANGELOG section.

### The policy is checked, not only written down

The release workflow's `gate` job runs `scripts/release-policy.js` after the CI check. It compares the
version being released with the previous release tag and, **for a patch bump**, fails if the tree adds
anything the table above keeps for feature releases:

* a schema migration (`server/db.js`, the length of the `migrations` array),
* a permission (`server/auth.js` `PERMS`: a permission name not in the previous release, or an existing one
  granted to another role),
* a route (every `METHOD path` the route modules register, including generated CRUD routes, and — since
  1.16.0 — every route the browser kernel registers itself: the `/api/local/*` device routes in
  `local/kernel.js` and `local/sync.js`, read from their source because the kernel only runs in a browser),
* more than **1,500 added lines** outside docs, tests and generated files (below, *Patch releases stay small*).

A minor or major bump may add all of these; it is held to the cadence instead (below). When a release
genuinely has to break the policy (a security fix that needs a route, say), push the tag as usual (its gate
fails on the policy), then run the workflow again on **that tag** from the Actions tab (*Run workflow*, *Use
workflow from* → the tag) with **`policy_exception`** set to the reason. The gate then passes with a warning, and the
release job puts the reason and the list of exceptions at the top of the GitHub Release notes, where a county
reviewing the release reads it. A tag push cannot carry an exception; an empty input is none. Until 1.14.0 the
input was called `allow_patch_changes` and covered patch releases only; that name still works, with the same
effect. Dry run before tagging: `node scripts/release-policy.js` (compares the working tree with the latest
tag; `--now <date>` to ask as of another day). The logic is tested in `test/release-policy.test.js`.

### Patch releases stay small

A fix release can carry a feature without adding a route, a permission or a migration — a new screen, a new
report built from existing endpoints. So, **for a patch bump**, the same gate step also measures the release:
the lines it **adds** against the previous tag (`git diff --numstat -M <previous tag>`), counting every file
except

* documentation: `docs/`, any `*.md` (the CHANGELOG among them),
* tests: `test/`, the browser suite `scripts/ui/`, the benchmarks `scripts/bench/`,
* generated files: `public/local/` (the kernel `npm run build:local` builds), `server/schema-text.js`,
  `public/sw.js`, `package-lock.json`.

More than **1,500** such lines fails the patch release (`PATCH_MAX_ADDED_LINES` in
`scripts/release-policy.js`; for one run, `PATCH_MAX_ADDED_LINES=<n>` in the environment of a dry run). The
refusal names the three largest files. The override is the same as for every other rule: a
**`policy_exception`** with the reason, printed at the top of the release notes. Lines removed do not count, so
a fix that deletes code is never held back by it. Tested with an injected diff in `test/release-policy.test.js`.

What the recent patch releases would have scored (`node scripts/release-policy.js --version <v> --previous <tag> --next-ref v<v>`):

| Release | Counted lines added | Size rule | Whole check |
| --- | --- | --- | --- |
| 1.14.1 | 24 | pass | pass |
| 1.15.1 | 488 | pass | **fail** today: three new device routes (`POST /api/local/recover`, `/api/local/recovery`, `/api/local/recovery/saved`). The check of the time did not read device routes (they count since 1.16.0), so it would have passed; the routes were known, and HANDOFF.md records that 1.15.1 was dispatched with a `policy_exception` naming them. The notes of its GitHub Release are the record of what the run carried |
| 1.15.2 | 176 | pass | pass |
| 1.15.3 | 649 | pass | pass |

For scale: the largest patch release so far was 1.12.1 (944 lines), and the feature releases 1.13.0 and
1.14.0 added 2,092 and 7,632. The size rule is a backstop for a large feature, not a measure of what counts as
a fix: 1.15.3's usability changes were small enough to pass it, and deciding whether a release is a fix release
stays the job of the human review of its notes (rule 2 above).

### Feature releases are checked too

The table above allows one feature release a month, and until 1.14.0 nothing checked it: 1.13.0 was tagged
about 21 hours after 1.12.0. Now, **for a minor or major bump**, the same `gate` step finds the previous
feature release — the newest `vX.Y.0` tag below the version — and fails if its tag is less than **28 days**
old (`FEATURE_INTERVAL_DAYS` in `scripts/release-policy.js`; the tag's own date for an annotated tag, its
commit's date for a lightweight one, read after the gate fetches the tags). The refusal says the date from
which the release may go out. A patch release is not held to the interval, only to its own rule, so fixes
still ship as soon as they are ready. An early feature release needs a `policy_exception` like any other
exception, and its reason is printed at the top of the release notes. If the previous tag's date cannot be
read, the check fails (since 1.16.1; until then it warned and skipped the interval, so a failed tag fetch in the
gate switched the rule off): fetch the tags and run it again, or give a `policy_exception`. The refusal names the
exact moment the interval ends (after 1.16.0: `2026-10-27T03:16Z`, the 28 days counted from the tag's commit).

**Record: 1.12.0–1.12.4 broke this policy.** 1.12.0 came fourteen hours after the 1.11.0 feature release
(not a month), and 1.12.1–1.12.4 followed within twelve hours; 1.12.1 carried migration 41 and the route
`POST /api/auth/oidc/reauth`, 1.12.2 the permission `reports:internal` (found afterwards with
`node scripts/release-policy.js --previous-ref <commit> --next-ref <commit>`). They were security and privacy
fixes from an independent review, shipped as soon as each was ready rather than batched. The check above
exists so the next exception is an explicit, recorded decision rather than an oversight. The same check run
against 1.13.0 as of its tag (`node scripts/release-policy.js --version 1.13.0 --previous v1.12.4 --next-ref v1.13.0 --now 2026-09-26T20:52:21Z`)
refuses it as a feature release 21 hours after 1.12.0.

**Record: 1.13.0 broke the monthly limit too.** It was a feature release (migrations 42 and 43, the
`graph:import` permission) about a day after 1.12.0, made a minor release so that the patch check above did
not have to be overridden. The limit itself was not checked by anything; see *Feature releases are checked
too* above.

**Record: 1.14.0 ships under a policy exception.** It is a feature release (migrations 44, 45 and 46, the
`reports:funder` permission, the supplies and SUPRT-A routes) one day after 1.13.0, which the check above
refuses on its own (`node scripts/release-policy.js --version 1.14.0`: "feature release 1.14.0 … after the
previous one (v1.13.0)"). The owner approved it as a recorded exception, for the round-3 review fixes
(security, frontline and engineering) and the market gaps (finance submissions, SUPRT-A, the DHCS and county
settlement layouts, supplies by item, site and lot with syringe services): it is dispatched with
`policy_exception` set to that reason, which the release notes print at the top.

**Record: 1.15.0 shipped under a policy exception.** It is a feature release (migration 48, the per-user
permission overrides and their five routes) about 34 hours after 1.14.0, which the check above refuses on its
own. The owner approved the exception because the overrides were finished, reviewed and regression-tested and a
patch release cannot carry a migration or new routes; the reason is at the top of its GitHub Release notes and of
its CHANGELOG section. Until 1.16.1 this page did not record it.

**Record: 1.16.0 ships under a policy exception.** It is a feature release (the `records:manage-others`
permission, and navigators and clinicians gaining `clients:all`, `notes:clinical:read` and `budget:read` by
default) the day after 1.15.0, which the check above refuses on its own (`node scripts/release-policy.js
--version 1.16.0`: "feature release 1.16.0 … after the previous one (v1.15.0)"). The owner approved it as a
recorded exception and asked for the pending work to ship as one release rather than several: the role-permission
expansion, the engineering review fixes (release gate, CI, tooling), and the frontline-UX, market and retest
fixes from the reviews of 1.15.3. The 1.15.4 security fixes shipped first, as a patch, on their own. It is
dispatched with `policy_exception` set to that reason. A feature freeze follows: the next feature release waits
for the 28 days the check asks for, until 2026-10-27 03:16 UTC.

The exceptions in one place (each also at the top of its GitHub Release notes, where a county reads it):

| Release | Rule broken | Reason, in short | Approved by |
| --- | --- | --- | --- |
| 1.12.0–1.12.4 | cadence; migration, route and permission in patches | security and privacy fixes shipped as each was ready (no check existed) | not recorded at the time |
| 1.13.0 | monthly limit (made a minor release to avoid the patch check) | no check of the limit existed | not recorded at the time |
| 1.14.0 | monthly limit | round-3 review fixes and market gaps | owner (`policy_exception`) |
| 1.15.0 | monthly limit | per-user permission overrides (migration 48, five routes) | owner (`policy_exception`) |
| 1.15.1 | new device routes in a patch (not checked then) | owner recovery code for SUDS on this device | owner (`policy_exception`, per HANDOFF.md) |
| 1.16.0 | monthly limit | role-permission expansion and the pending review fixes as one release | owner (`policy_exception`) |
| 1.16.4 | released without a tag, a GitHub Release or the `release` environment's approval: published to GitHub Pages by a direct push to `gh-pages` | the owner asked for it to be live at once; the commit (`6491308`) had passed CI in full | owner (a request, no workflow record; *Record: 1.16.4 published without a tag*, below) |
| 1.17.0 | monthly limit (a feature release inside 1.16.0's 28 days); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner approved shipping 1.17.0 with an exception once green, and asked for it to be deployed to Pages; the stamp commit passed `npm test`, the full browser suite in both orders and CI | owner (a request, no workflow record; *Record: 1.17.0*, below) |
| 1.17.1 | new behaviour in a patch (AI providers Bedrock and Vertex AI, and the copilot's estimated cost and spending limit) and more than the patch line limit; released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner asked for Bedrock/Vertex and the dollar cost to ship in 1.17.1 with the review-of-1.17.0 fixes, and for it to be deployed to Pages when green; no migration, permission or route | owner (a request, no workflow record; *Record: 1.17.1*, below) |
| 1.18.0 | monthly limit (a feature release inside 1.17.0's 28 days: migrations 56 and 57, the `county:view` and `county:manage` permissions, the county view, county connection and compliance-report routes); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner asked for the cross-CBO funder view, the county connection API and a self-hosted compliant server, and to cut the release once they were complete and working; each was reviewed (security, UX, engineering, market) and its findings fixed before the stamp | owner (a request, no workflow record; *Record: 1.18.0*, below) |
| 1.19.0 | monthly limit (a feature release inside 1.18.0's 28 days: migrations 58 and 59 and the passkey routes); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner asked for fingerprint sign-in, authorization and signing and then said to release it ("Release 19"); it had security, UX and engineering reviews, a second-pass review and a regression sweep against 1.18.0, all fixed before the stamp | owner (a request, no workflow record; *Record: 1.19.0*, below) |
| 1.20.0 | monthly limit (a feature release inside 1.19.0's 28 days: migration 60 and the county-entered figures routes); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner said there is no freeze and to complete all build through 1.20; it carries the documentation, evidence and installer fixes from the review of 1.19.0 and county-entered figures, which had security, UX and engineering reviews, all fixed before the stamp | owner (a request, no workflow record; *Record: 1.20.0*, below) |
| 1.21.0 | monthly limit (a feature release inside 1.20.0's 28 days: migrations 61, 62 and 63; the county publication, field-device, authenticator allow-list and county reminder routes; no new permission); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner said to implement all five planned features, resolve all known issues and build out stump code ("loop until complete"); eight parallel streams, each reviewed, and an integration review whose findings were fixed before the stamp | owner (a request, no workflow record; *Record: 1.21.0*, below) |
| 1.22.0 | monthly limit (a feature release inside 1.21.0's 28 days: migrations 64, 65 and 66; the county publication consent routes; no new permission); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner said to implement all recommendations to make SUDS as useful as possible for SUDS workers ("loop until complete"); six streams, the evidence re-run on 1.21.0, and an integration review whose findings were fixed before the stamp | owner (a request, no workflow record; *Record: 1.22.0*, below) |
| 1.23.0 | monthly limit (a feature release inside 1.22.0's 28 days: migration 67; the supervisor's referral reminder and the field-device request routes; no new permission); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner said to implement all recommendations to make SUDS as useful as possible for SUDS workers ("loop until complete"); four streams and an integration review whose findings were fixed before the stamp | owner (a request, no workflow record; *Record: 1.23.0*, below) |
| 1.23.1 | none of the policy (a patch within the patch rules: no migration, permission or route, 501 lines); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner said to deploy to Pages when green; the tags owed since 1.16.3 were not yet pushed, so the gate could not publish it (*Stabilisation*, point 4) | owner (a request, no workflow record; *Record: 1.23.1*, above) |
| 1.23.2 | none of the policy (a patch within the patch rules: no migration, permission or route, 188 lines); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner said to implement the 1.23.1 evaluation's recommendations; the tags owed since 1.16.3 were not yet pushed, so the gate could not publish it (*Stabilisation*, point 4) | owner (a request, no workflow record; *Record: 1.23.2*, above) |
| 1.23.3 | none of the policy (a patch within the patch rules: no migration, permission or route, 187 lines); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner's UX backlog ("View in Done", phone Home order) and the 1.23.2 evaluation's defects; the tags owed since 1.16.3 were not yet pushed, so the gate could not publish it (*Stabilisation*, point 4) | owner (a request, no workflow record; *Record: 1.23.3*, above) |
| 1.23.4 | none of the policy (a patch within the patch rules: no migration, permission or route, 111 lines); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner asked for the 1.23.3 evaluation's defects to be resolved and the release published with a full marketability evaluation; the tags owed since 1.16.3 were not yet pushed, so the gate could not publish it (*Stabilisation*, point 4) | owner (a request, no workflow record; *Record: 1.23.4*, above) |
| 1.23.5 | none of the policy (a patch within the patch rules: no migration, permission or route, 91 lines); released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages` | the owner asked for every identified bug to be fixed and the release pushed; the tags owed since 1.16.3 were not yet pushed, so the gate could not publish it (*Stabilisation*, point 4) | owner (a request, no workflow record; *Record: 1.23.5*, above) |
| 1.23.6 | a widened permission in a patch during the feature freeze, and an exception that is not a security fix (*Stabilisation*, points 1 and 2): an administrator may change their own permissions, role and account. The release-policy check passes (no migration, permission name or route; 224 lines), so the exception is recorded by hand | the owner asked that an administrator be able to change all permissions, their own included, and chose to ship it in 1.23.6 rather than wait for 1.24.0; safeguards: the lockout guard, a confirmation before each change to one's own access, `self: true` in the audit, and a deny on an administrator now advisory. Released without a tag, a GitHub Release or the `release` environment's approval, published to GitHub Pages by a direct push to `gh-pages`, because the tags owed since 1.16.3 were not yet pushed (*Stabilisation*, point 4) | owner (a request, no workflow record; *Record: 1.23.6*, above) |
| 1.24.0 | monthly limit and the feature freeze (*Stabilisation*, point 1: a feature release two days after 1.23.0, migrations 68, 69 and 70, the permissions `intake:read` and `intake:write`, 22 routes), under the security exception point 2 allows; the gate refuses it on the feature interval, so its tag needs *Run workflow* with `policy_exception` | the fixes of the owner-authorised white-box pen test of 1.23.6 (M1, M2 and seven Low findings), released at once on the owner's instruction to lift the freeze, with the feature work done for 1.24.0 and `suds.exe` (owner decision of 2026-10-03); `Security exception:` recorded, so CI's `release-policy` job passes | owner (a request, no workflow record; *Record: 1.24.0*, above) |
| 1.24.1 | none of the policy (a patch within the patch rules: no migration, permission or route, 311 lines; a patch is allowed inside the feature freeze, so no exception is needed). Its `release.yml` run publishes it once the owner has pushed the tags; it went live first, on 2026-10-03, by a direct push to `gh-pages` at the owner's request (*Record: 1.24.1*) | the licence change the owner decided on 2026-10-03 (proprietary, AugustInnovations LLC, SUDS on this device free for real use under section 2A) and the fixes from the market evaluation of 1.24.0 (D1 to D7); the tags owed since 1.16.3 are not yet pushed (*Stabilisation*, point 4) | no exception to approve; the direct push was at the owner's request (*Record: 1.24.1*, above) |
| 1.25.0 | monthly limit and the feature freeze (*Stabilisation*, point 1: a feature release two days after 1.24.0, migration 71; no new permission or route); not a security fix, so no `Security exception:` line — the owner's explicit instruction to lift the freeze, recorded in *Record: 1.25.0* and passed as `policy_exception` when the tag's release runs | the CalOMS Tx dictionary verification (all 17 code sets rewritten from the DHCS Data Dictionary v3.0; migration 71 remapping stored answers), better resource-directory pictures (40 of the 81 providers on the published site; many provider sites refuse automated downloads), and the UI intuitiveness pass, on the owner's instruction of 2026-10-05 ("Fix everything now, freeze lifts to 1.25.0") | owner (`policy_exception`, *Record: 1.25.0*, above) |
| 1.25.1 | none of the policy (a patch within the patch rules: no new migration, permission or route, 412 lines; a patch is allowed inside the feature freeze, so no exception is needed). Tagged by the owner and released through the gate on 2026-10-08 (*Record: 1.25.1*) | the fixes from the evaluation of 1.25.0 (E1 to E11): one programme-local "today", typed dates and times, repeated CalOMS codes, honest provider-picture and release records, one pricing source of truth (*Record: 1.25.1*, above) | no exception to approve |
| 1.25.2 | none of the policy (a patch within the patch rules: no migration, permission or route, 754 lines; a patch is allowed inside the feature freeze, so no exception is needed). Tagged by the owner and released through the gate on 2026-10-09, with `v1.25.3` (*Record: 1.25.2*) | the fixes from testing every position on 1.25.1 and from the evaluation of 1.25.1 (FL1–FL16, CS1–CS18, BO1–BO25, F1–F8, less FL5's index and BO22's headings), with its own SBOM (*Record: 1.25.2*, above) | no exception to approve |
| 1.25.3 | none of the policy (a patch within the patch rules: no migration, permission or route, 210 lines; a patch is allowed inside the feature freeze, so no exception is needed). Tagged by the owner and released through the gate on 2026-10-09 (*Record: 1.25.3*) | the fixes from the launch of suds.systems and the pen test of the live install (installer SSH rule, site-local Caddy configuration and the www redirect, the first administrator's username, MINOR-1, MINOR-2, INFO-2, INFO-3; *Record: 1.25.3*, above) | no exception to approve |
| 1.25.4 | none of the policy (a patch within the patch rules: no migration, permission or route, 935 lines; a patch is allowed inside the feature freeze, so no exception is needed). Tagged by the owner and released through the gate on 2026-10-10 (*Record: 1.25.4*) | the fixes from the market-readiness evaluation of 1.25.3 (G1–G11), the empty offsite backup copies found on suds.systems, and the Option A fleet tooling (*Record: 1.25.4*, above) | no exception to approve |
| 1.25.5 | none of the policy (a patch within the patch rules: no migration, permission or route, 738 lines; a patch is allowed inside the feature freeze, so no exception is needed). Tagged by the owner and released through the gate on 2026-10-11 (UTC), the Latest release (*Record: 1.25.5*) | the fixes from the market-readiness evaluation of 1.25.4 (H1–H9) and the business work plan (*Record: 1.25.5*, above) | no exception to approve |

**Record: 1.23.0 ships under a policy exception, published without a tag.** 1.23.0 is a feature release inside
1.22.0's 28 days, on the same instruction of the owner ("Implement all recommendations to make this as useful as
possible for suds workers, loop until complete"). It carries follow-up to-dos that follow edits to a call, visit or
referral at both doors (migration 67), the worker-first menu and phone Home, street outreach with no signal on the
office app (contacts that name nobody kept in the browser, with keyed ids so each is counted once) and *Set up this
phone for the field* requests, the supervisor's *Waiting to hear what happened* with *Remind worker* and *Record
outcome*, My profile at a laptop's width, and the documents brought up to the latest container run. No new
permission; the new routes are `POST /api/supervision/referrals/:id/remind` and the field-device request routes
(`/api/me/field-device`, `/api/admin/field-requests`). The work was done in four streams, each reviewed on its branch,
then merged and given an integration review whose findings (an outcome recorded by editing a referral closing its
to-dos, *Send now* with an ended session, a waiting contact the office already has found before the write rules, a
device's to-do linked to a colleague's call or visit) were fixed before the stamp; the items it left open are listed
for the owner in HANDOFF.md. Like 1.22.0, 1.23.0 is released as two commits, the stamp and its SBOM (*Stamp
checklist*); the second is the one CI passes, that goes to `main` and `gh-pages` by a direct push, and that the owner
tags. The next feature release waits 28 days from 1.23.0. Its tag goes in the same push as the others.

**Record: 1.22.0 ships under a policy exception, published without a tag.** 1.22.0 is a feature release inside
1.21.0's 28 days, on the owner's instruction ("Implement all recommendations to make this as useful as possible for
suds workers, loop until complete"). It carries the day-to-day fixes for frontline workers (the call-back date that
made no to-do, quick dates, where a client stands, outreach Undo and *Same as last contact*, the note format, the
sync state in the header), the field scope bound to the account (migration 64), county publication consent, corrected
releases and award pro-rating (migration 65), the authenticator allow-list's grace period (migration 66) and the county
file version choice, the penetration-test scope from the threat model, honest release-integrity answers, the fuller
county packet and the revised accessibility conformance report, the SUDS Server listener fix, and the evidence re-run
on 1.21.0. No new permission; the new routes are the county publication consent routes. The work was done in six
streams and an evidence stream, each reviewed on its branch, then merged and given an integration review whose
findings (a brand-new device held from its first push, sessions of a revoked or wiped device ending, the consent
checked again where a release is written, the county card's periods by the server's date, two browser scripts'
quarter across midnight) were fixed before the stamp; the findings it left open are listed for the owner in
HANDOFF.md. 1.21.0 was itself restamped once before it went out, for two browser-script timing fixes. Like 1.21.0,
1.22.0 is released as two commits, the stamp and its SBOM (*Stamp checklist*); the second is the one CI passes, that
goes to `main` and `gh-pages` by a direct push, and that the owner tags. The next feature release waits 28 days from
1.22.0. Its tag goes in the same push as the others.

**Record: 1.21.0 ships under a policy exception, published without a tag.** 1.21.0 is a feature release inside
1.20.0's 28 days, on the owner's instruction ("Implement all five, resolve all known issues and build out stump code.
loop until complete."). It builds the five things the documents called planned: county publication releases
(migration 61), field devices with participant codes first (migration 62), the authenticator allow-list for passkeys
(migration 63), award amounts in the county file (schema version 2) and reminders when a county file is due; with
them, a threat model and fuzz tests for the county surface and SUDS Server, the release-state check and the county
evidence packet, the evidence re-run on 1.20.0, and the documents' content-currency test. No new permission. The work
was done in eight parallel streams, each with its own review whose findings were fixed on its branch, then merged and
given an integration review whose findings (the upgrade hand-over, the AI de-identification of participant codes,
merges, sessions a refused passkey opened, participant codes in FHIR, referrals, CalOMS and the export) were fixed
before the stamp; the findings it left open are listed for the owner in HANDOFF.md. Like 1.20.0 it is released as
two commits, the stamp and its SBOM (*Stamp checklist*); the second is the one CI passes, that goes to `main` and
`gh-pages` by a direct push, and that the owner tags. The next feature release waits 28 days from 1.21.0. Its tag
goes in the same push as the others.

**Record: 1.20.0 ships under a policy exception, published without a tag.** 1.20.0 is a feature release inside
1.19.0's 28 days, on the owner's instruction ("We are building the app, there is no freeze at this time. Complete all
build through 1.20"). It carries the market-readiness review of 1.19.0's repository work: the documents brought up to
1.19.0 and their version lines to 1.20.0 (the market review of 1.20.0 found much of their content still at 1.19.0;
corrected after the release, `test/doc-content-currency.test.js`), LICENSE and SECURITY.md, a recovery drill, an upgrade drill and a real installer run with their
evidence, the installer and day-one fixes that run found, the county-contract kit, and county-entered figures for
grantees not on SUDS (migration 60 and its routes; no new permission). The county-entered figures had security, UX and
engineering reviews whose findings were fixed before the stamp, with the owner-default decisions D1–D5 recorded in
docs/COUNTY-VIEW.md (*Owner-default decisions*). It is the first new minor released as two commits, the stamp and its SBOM (*Stamp checklist*); the
second is the one CI passes, that goes to `main` and `gh-pages` by a direct push, and that the owner tags. The next
feature release waits 28 days from 1.20.0. Its tag goes in the same push as the others.

**Record: 1.19.0 ships under a policy exception, published without a tag.** 1.19.0 is a feature release inside
1.18.0's 28 days: fingerprint sign-in, authorization and signing with WebAuthn passkeys (docs/FINGERPRINT.md). It adds
migrations 58 and 59 and the passkey routes, and no new permission. It had security, UX and engineering reviews and a
second-pass review, whose findings were fixed before the stamp, and a regression sweep showing people without passkeys
get what 1.18.0 gave them. It is published only once `npm test`, the browser suite and CI pass on its stamp commit: to
`main`, then to `gh-pages` by a direct push, as 1.17.x and 1.18.0 were. The next feature release waits 28 days from
1.19.0. Production needs `WEBAUTHN_RP_ID` set before anyone enrols a passkey. Its tag goes in the same push as the others.

**Record: 1.18.0 ships under a policy exception, published without a tag.** 1.18.0 is a feature release inside
1.17.0's 28 days: the county view (Tier 1 of docs/market/DATA-NETWORK.md), the optional county connection API and
read API, and SUDS Server (the Linux installer and the signed compliance check). It adds migrations 56 and 57 and
the `county:view` and `county:manage` permissions. Each part had security, UX, engineering and (for the county
work) market reviews, and their findings were fixed before the stamp. It is published only once `npm test`, the
browser suite and CI pass on its stamp commit: to `main`, then to `gh-pages` by a direct push, as 1.17.x was. The
next feature release waits 28 days from 1.18.0. The installer has been exercised in a fake root with stub system
commands, not on a real VM: a run on a real Ubuntu 24.04 and RHEL 9 VM is owed before any production install
(docs/SELF-HOSTING.md, operator checklist). Its tag goes in the same push as the others, after 1.18.0 is on `main`.

**Record: 1.17.1 ships under a policy exception, published without a tag.** 1.17.1 is the review of 1.17.0's
fixes (security, UX, engineering, market) together with two things the owner asked to ship in it: the AI copilot
on Amazon Bedrock and Google Vertex AI, and its estimated cost in dollars with an optional spending limit. Those
are new behaviour, and the release is over the patch line limit; it adds no migration, permission or route. It is
published only once `npm test`, the browser suite and CI pass on its stamp commit: to `main`, then to `gh-pages` by
a direct push, as 1.17.0 was. Its tag goes in the same push as the others (below), after 1.17.1 is on `main`: from
1.17.1 the release gate refuses a version older than `main`'s, which is what stops the 1.16.x runs.

**Record: 1.17.0 ships under a policy exception, published without a tag.** 1.17.0 is a feature release (migrations
49–55, one new permission, `ai:draft`, and new routes: the AI documentation copilot, client revision history, the least-privilege default,
SSP participant codes and prevention events, the Part 2 layer, CalOMS automation, secure referral links, settlement
outcomes and street outreach, the publication change) inside the 28 days after 1.16.0, which the policy refuses on its
own. The owner approved it as a recorded exception ("ship 1.17 with an exception when it's green"; "merge and deploy to
pages when green"). Like 1.16.4 it was published to GitHub Pages by pushing the stamp commit's verified build to
`gh-pages`; `v1.17.0`, its GitHub Release and zip wait for the owner's tag, pushed together with `v1.16.3` and
`v1.16.4` (below: a 1.16.x tag pushed alone would publish 1.16.x over 1.17.0). The next
feature release waits 28 days from 1.17.0.

**Record: 1.16.4 published without a tag.** The released 1.16.4 is `6491308` ("Release 1.16.4", on `main`, CI green
in full: run 36591664382). At the owner's request it was published to GitHub Pages by pushing its build straight to
`gh-pages` ("Deploy 6491308"), not by `release.yml` and `web-app.yml`: there is no `v1.16.4` tag, no GitHub Release
and zip, and no approval in the `release` environment, and the push shows that no ruleset guarded `gh-pages` then
(step 6). An earlier stamp, `d95b69a`, is not the release (not on `main`, its CI failed; the evidence named it until
the engineering review of the 1.17.0 candidate, H2). 1.16.3 (`fc5e9d7`, on `main`, an ancestor of `6491308`) was
stamped and never published on its own. **Neither is tagged, and until both are, everything that measures from "the
previous release" measures from `v1.16.2`:** the release policy for 1.17.0 (the feature interval, which does not
change: 1.16.0 is the previous feature release) and for any 1.16.x patch (whose size and surface would be counted from
`v1.16.2`: 1.16.3 and 1.16.4 alone count 1,137 of the 1,500 lines), `scripts/migration-order.js`'s baseline, and
*Backports* step B, whose `git rev-parse 'v1.16.4^{commit}'` fails without the tag.

**Twenty tags, pushed 2026-10-05: [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)** (1.24.1). 1.17.1,
1.18.0, 1.19.0, 1.20.0, 1.21.0, 1.22.0, 1.23.0, 1.23.1, 1.23.2, 1.23.3, 1.23.4, 1.23.5, 1.23.6 and 1.24.0 were
published the same way, and 1.24.1 was stamped before the owner pushed them; the tags owed were `v1.16.3`,
`v1.16.4`, `v1.17.0`, `v1.17.1`, `v1.18.0`, `v1.19.0`, `v1.20.0`, `v1.21.0`, `v1.22.0`, `v1.23.0`, `v1.23.1`,
`v1.23.2`, `v1.23.3`, `v1.23.4`, `v1.23.5`, `v1.23.6`, `v1.24.0` and `v1.24.1` — all pushed now, plus `v1.24.2`
and `v1.24.3` the same evening. No tags are owed. The hand-off has the checks, the tag commands, the one push, what each tag's runs do (the 1.16.x gates refuse,
the eight from `v1.17.0` to `v1.23.0` and `v1.24.0` need a *Run workflow* with `policy_exception`, the gates of
`v1.23.1` to `v1.23.6` and `v1.24.1` pass, and only `v1.24.1`'s `Web app` run is approved: it publishes 1.24.1;
1.23.6's gate passes although it carries the owner-approved exception of *Record: 1.23.6*, which the owner adds to its
release notes by hand), and the SHA-256 each release zip will have, rebuilt from each commit (1.24.1's is recorded by
a later commit on `main`). The paragraphs
below are the reasoning of 1.17.0's time, for three tags; the rule they set, never an older tag alone, is unchanged.

**Tag 1.16.3, 1.16.4 and 1.17.0 in one push, never 1.16.x alone** (engineering review of 1.17.0, H1). 1.17.0 is on
`gh-pages` with no tag, so a `v1.16.4` pushed on its own is the newest release tag there is. Its own `release.yml`
(the copy at the tag is what runs) makes its GitHub Release, which GitHub marks Latest, and dispatches its own
`web-app.yml`, which has no newest-release check at all: once approved, it force-pushes the 1.16.4 site over 1.17.0.
A device whose database 1.17.0 migrated (schema 55) is then refused by the 1.16.4 kernel (`server/db.js`: "created by
a newer version of SUDS"), and everyone using SUDS on this device is locked out until 1.17.0 is published again.
The owner's commands, from any clone (never an assistant's), once 1.17.1's fixes are on `main` (the third line
checks it):
```bash
git fetch origin
for c in fc5e9d7 6491308 485548c; do git merge-base --is-ancestor $c origin/main || echo "$c is NOT on main"; done
git show origin/main:scripts/release-policy.js | grep -q olderReleaseProblem && echo "main refuses an older release's old workflow"
git tag -a v1.16.3 fc5e9d7 -m "SUDS 1.16.3"
git tag -a v1.16.4 6491308 -m "SUDS 1.16.4"
git tag -a v1.17.0 485548c -m "SUDS 1.17.0"
git push origin v1.16.3 v1.16.4 v1.17.0
```
If 1.17.1 is stamped by then, tag it too (`git tag -a v1.17.1 <stamp sha> -m "SUDS 1.17.1"`) and add `v1.17.1` to
the same push; tagged later, it goes out like any release. What each tag then does:

* **`v1.16.3` and `v1.16.4`: their release runs stop at the gate, as they should.** Their `release.yml` copies
  predate `--latest-out`, and `main`'s copy of `scripts/release-policy.js`, which their gate runs, refuses a version
  older than `main`'s `package.json` from such a workflow (`olderReleaseProblem`, since 1.17.1). The tags alone do
  what they are for: the release policy, `scripts/migration-order.js` and *Backports* measure from them. A GitHub
  Release for either is optional: *Run workflow* on the tag with `policy_exception` set to the reason, approve its
  release job, then **reject the `Web app` run it starts for that tag** in the `release` environment (that
  `web-app.yml` would publish 1.16.x), and put Latest back with `gh release edit v1.17.0 --latest`. If the tags are
  pushed before 1.17.1's gate is on `main`, nothing in their workflows stops them: reject their release approvals
  and any `Web app` run for `v1.16.3` or `v1.16.4`.
* **`v1.17.0`: its gate fails the feature interval** (inside 1.16.0's 28 days: the recorded exception above), so
  *Run workflow* on `v1.17.0` with `policy_exception` set to that reason. While `main`'s `package.json` still says
  1.17.0, its release is Latest and its `Web app` run republishes 1.17.0, the build `gh-pages` already serves:
  approve it (once 1.17.1 is stamped, 1.17.0 is neither Latest nor published, and 1.17.1's release is both). Since 1.17.1 `web-app.yml` also refuses
  any version older than the `version.json` on `gh-pages` (`scripts/pages-version-check.js`), before the build and
  again after the approval; the tags before 1.17.1 carry copies without that check, hence the rule above.

Afterwards, check that the public URL's `version.json` reads the newest version and that the Latest release is it.

**Owner decisions inside a patch (not policy exceptions).** The policy checks a patch's surface (migrations,
permissions, routes, size), not what its code does, so a patch can change behaviour without breaking a rule. That
is allowed when the owner decides it; it is recorded here so that "patch" keeps an explicit meaning:

| Release | Behaviour changed | Why a patch | Decided by |
| --- | --- | --- | --- |
| 1.16.1 | Someone off a client's care team who updates the client's record now gives the primary worker a to-do naming who changed which fields (never the values) | mitigates 1.16.0's wider default of `clients:all` | owner |
| 1.16.1 | SUD counseling notes (42 CFR §2.11) are read only by their author, their co-signer and staff with `notes:clinical:write`: not by a navigator with `notes:clinical:read`, not by break-glass, device sync included | narrows 1.16.0's wider default of `notes:clinical:read` | owner |
| 1.16.2 | A publication release that 1.16.1 published by withholding the overdose events by month is refused whole again (1.16.1's rule leaked; ADR-0009) | a disclosure-control defect: refusal is safe | the owner, approving these notes |

## Cutting a release
**A release is always a `v*` tag, pushed by the owner** (1.16.3). Every fix is merged to `main` and green first;
then the version stamp goes to `main` (through a pull request once branch protection is on, *Owner: repository
settings*, step 2), and once CI has passed on that stamp commit the owner tags **that commit, by its SHA** (not
whatever a local `main` happens to be: a clone's `main` can differ from `origin/main`):
```bash
git checkout main && git pull
npm version 1.0.1 --no-git-tag-version   # bump, then add the CHANGELOG entry
git commit -am "Release 1.0.1" && git push   # (or a pull request); wait for CI on this commit to pass
# the owner (the v* tag ruleset lets only the owner make release tags), with <sha> the stamp commit on origin/main:
git fetch origin && git tag -a v1.0.1 <sha> -m "SUDS 1.0.1" && git push origin v1.0.1
```
**Several streams merged: the whole browser suite, green, on the final merge commit, before the stamp.** Each stream's
own scripts passing is not enough: in the 1.17.0 candidate two streams broke older scripts (`spreadsheets`, `ux13`)
that nobody re-ran after the merges, and the commit went up with its `browser` job still running and a red one behind
it (engineering review of the 1.17.0 candidate, H1). Run `scripts/ui/run-all.sh` in full on the commit the merges end
at, or wait for its CI `browser` job, and stamp only once it is green.

**The CHANGELOG date is the stamp's date; the release date is the tag's.** A section is dated when its version is
stamped, and the version is released only when the owner pushes its tag (the GitHub Release and the tag carry that
date); until then the section describes a prepared release, not a published one.

**Stamp checklist: the "not yet released" lines.** Until a feature release is stamped, the buyer documents say
what it adds with one phrase, **"built for X.Y.Z, not yet released"** (docs/market/STRATEGY.md, POSITIONING.md,
README.md, PILOT-KIT.md, the buyer guides). When stamping X.Y.Z, rewrite each of them to say what is now true
(released in X.Y.Z; for a line that also gates a pilot or a demo, say what still gates it, such as counsel's
review). `test/release-wording.test.js` finds them: it fails once `package.json`'s version has a dated CHANGELOG
heading while any document still says that version is not yet released, or still says a feature is "built for"
it (say "released in X.Y.Z" or "available from X.Y.Z"), and it refuses other spellings of the same thing, so there
is one phrase to search for. Since the market review of 1.20.0 it also fails on any "X.Y.Z, not yet released" (or
"not available until X.Y.Z is released") for a stamped X.Y.Z, however the line introduces the version: that review
found the county kit still calling a 1.20.0 feature unreleased, three times, after the stamp.

**Stamp checklist: the documents that name a release.** When stamping X.Y.Z, the documents that say which release they
describe move to it: `docs/security/QUESTIONNAIRE.md`'s **Checked against** line and `docs/evidence/README.md`'s
**Version.** line, and an SBOM of the stamp commit (`node scripts/sbom.js --ref <stamp sha> --out
docs/evidence/sbom-X.Y.Z.cdx.json`, with every link to the old one outside the evidence index moved to it; older SBOMs
stay as history). **From 1.25.2 every release has its own SBOM, patches included** (evaluation of 1.25.1, F6: a county
supply-chain reviewer expects one per shipped artifact, and 1.25.1 shipped with 1.25.0's); up to 1.25.1 only a new
minor had one. A commit cannot hold an SBOM of itself, so every release is two commits: `Release X.Y.Z` (the stamp,
with the links already naming the new SBOM), then `SBOM of the X.Y.Z stamp`, which adds the file and nothing else; the
second is the release commit that CI must pass, that goes to `main` and that is tagged (since 1.20.0 for a minor, and
from 1.25.2 for a patch too, whose hand-off row then reads "the commit after `Release X.Y.Z`" like a minor's). The
rule `test/doc-currency.test.js` enforces: once `package.json`'s version X.Y.Z has a dated CHANGELOG heading, each of
the three names a version on the X.Y line, no later than X.Y.Z (a patch may keep its minor's questionnaire and
evidence line; a new minor may not), from 1.25.2 the newest SBOM is X.Y.Z's own, and every SBOM link outside the
evidence index names the newest SBOM. While a version is being prepared (no date yet), the rule applies to the last stamped version. Re-read the
answers those documents give for what the release changed, not only the version line (the review of 1.19.0 found
them two releases behind: the county connection and passkeys missing from the questionnaire, "planned" for a
released county view; the review of 1.20.0 found the version lines moved and the content not).
`test/doc-content-currency.test.js` checks the content mechanically: every audit action the server writes is in
`docs/security/LOGGING-AND-AUDIT.md`'s *Audit action catalogue*; the newest migration, and every one the stamped
section names, is in `docs/security/DATA-INVENTORY.md`'s *Schema versions*; every line that says which release it
is current for ("describes X.Y.Z", "Current status (X.Y.Z)", "State on … (X.Y.Z)", "the history of X.Y.Z",
"X.Y.Z, the latest release", the threat model's *Version.*, README's *What's new*) names the stamped minor; and each
buyer document names a version on that minor at least once. For a new minor, recount the authorship figures
(QUESTIONNAIRE.md #36a's method) at the stamp commit.

**Stamp checklist: the release state** (released in 1.21.0). `node scripts/release-state.js` compares what the release
documents say with what is true: the questionnaire's *Checked against* and the evidence index's *Version.*; the
*Supported versions* rows, the *Record* references and the exceptions ledger above, against the dated CHANGELOG
sections; [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)'s table (each commit exists, is on `main`, and is
"Release X.Y.Z" or the "SBOM of the X.Y.Z stamp" commit after it; its dates, `git tag -a` lines, check loop and push
agree; whether each tag is pushed; a new minor's row, whose commit is the SBOM commit its stamp cannot name, reads
"the commit after `Release X.Y.Z`" and is checked for everything but that commit) and HANDOFF.md's *Release waiting* entry; every "live on GitHub Pages" against the
`version.json` `gh-pages` serves; a stamped version newer than the newest pushed tag that the hand-off does not list;
while any released version is untagged (the hand-off's owed tags, or a stamped version newer than origin's newest
tag), that the questionnaire's #36 and #39 and the RFI template's *Release integrity* answer say the releases were
"published without a tag" and name the first and last of them (released in 1.22.0); and, inside each dated CHANGELOG section `## X.Y.Z — date`, a line calling another minor "the latest minor" or "the
previous", or saying "checked against", "describe(s)", "not yet released" or "fix release" of another version (the few
legitimate historical lines are in `CHANGELOG_ALLOW` in the script, each with its reason). Each finding is printed as
`file:line` with a fix, and the exit status is 1 while there is one. Run it **before handing a stamp to the owner**,
and **after the owner pushes tags or the site is republished** (then update the hand-off, *Release waiting* and the
pending wording it names). `--fetch` fetches `main` and `gh-pages` first; by default it also asks `git ls-remote
--tags origin`; `--offline` uses only this clone and lists what it could not check; `--docs-only` reads the documents
alone. CI runs it on every push as the advisory `release-state` job, not in the release gate: its answer changes when
a tag is pushed or the site republished, without a commit, and at a tag's own release run the hand-off still lists
that tag. Tested in `test/release-state.test.js`.

**Stamp checklist: the tests run on the stamped tree, and main's run is the green one** (1.25.4; evaluation of 1.25.3,
G6 and G1). The 1.25.3 stamp was pushed without the suite that would have refused it, and went red on `main`. So:
1. After the documents pass (the three checklists above) and **before the push**, run the full `npm test` on the exact
   tree being stamped: the `Release X.Y.Z` commit, and again on the SBOM commit after it (`git status` clean, nothing
   edited between the run and the commit). When the release changed anything under `public/`, `local/` or
   `scripts/ui/`, also run `scripts/ui/run-all.sh` in full on that tree. A red run is fixed and the stamp made again;
   it is never pushed to see what CI says.
2. The commit recorded for tagging (the hand-off's row, HANDOFF.md's *Release waiting*) is one whose **`ci.yml` run on
   `main`** (a `push` run on the `main` branch) concluded success. A green run of the same commit on a mirror or work
   branch does not count, and neither does a red `main` run re-run until it passes without a reason: a job that failed
   on `main` gets its failure read first (each failing test or browser check is an `::error` annotation on the run and
   a line in the job summary, `scripts/ci-annotate.js` and `run-all.sh`, readable through the API when the log is not),
   and is fixed or recorded in the flake register below before the commit is handed over.

**Flake register.** A test or script that failed on `main` and passed on a re-run of the same commit is recorded here
with its cause and its fix; "known flaky" without a cause is not an entry. Every red of the advisory `webkit` job on
`main` is recorded too, re-run or not (evaluation of 1.25.4, H1): four of the seven `main` runs after 1.25.3, up to
`ec874a4`, failed it at a device sign-in or first load, and where the cause is not yet known the row says what is known
and what would settle it.

| Seen | Where | Cause | Fixed |
| --- | --- | --- | --- |
| `2e4ecac` node24 | `test/fingerprint-review.test.js` "401 == 200" (and the same pattern in eight files) | an authenticator code of the previous 30-second step, refused when a step boundary fell inside the request | 1.25.4: the current step then the next; `H.totpPreviousStep` for the tests that need three steps |
| `147fddd` browser | `accessibility.mjs` "the referral is saved, relying on the consent — got [null]" | a product race: the provider's consents answering after the worker chose a consent cleared the choice | 1.25.4: `public/views/referrals.js` keeps a choice made during the reload; checked in `frontline-review.mjs` |
| `cfafd6a` test, `c3a54bd` evening | one failing test each, not named in what the API returns | unknown: the CI log was not readable from where it was investigated | 1.25.4 annotates every failure, so the next one is named |
| `f3bfd55` webkit (advisory; run `38005180862`) | `qa-retest.mjs` "round 3 phone: inactive status": a timeout after a reload and sign-in, with `CONSOLE [suds-local] POST /api/auth/login RuntimeError: Out of bounds memory access` in the SQLite WASM; the app code (`public/`, `local/`) was identical to v1.25.3 | an engine-level error (an out-of-bounds memory access in the SQLite WASM) in Playwright's WebKit on Linux at device sign-in; not yet established whether it occurs on iOS Safari (WebKit is not installable where it was investigated) | 1.25.5: the engine is retried on a fresh instance before a database is declared damaged, and the damaged copy can be restored; a real-iPhone record ([ADOPTION.md](ADOPTION.md) §4, [evidence/REAL-DEVICE-CHECK-TEMPLATE.md](evidence/REAL-DEVICE-CHECK-TEMPLATE.md)) is owed |
| `a18ce49` webkit (advisory; run `38013516221`) | `static-site.mjs` "a reload locks the device": `signInAgain` never reaches `.layout` in 20 s | a device sign-in or first load that never completed in Playwright's WebKit on Linux, taken to be the same engine-level class as `f3bfd55` (the log tail shows only the timeout); not yet established whether it occurs on iOS Safari | 1.25.5: the engine is retried on a fresh instance before a database is declared damaged, and the damaged copy can be restored; a real-iPhone record ([ADOPTION.md](ADOPTION.md) §4, [evidence/REAL-DEVICE-CHECK-TEMPLATE.md](evidence/REAL-DEVICE-CHECK-TEMPLATE.md)) is owed |
| `9e1acd3` webkit (advisory; run `38016339549`) | `qa-retest.mjs` "upgraded profile": a wait that never resolved; the script was killed at 900 s | a device sign-in or first load that never completed in Playwright's WebKit on Linux, taken to be the same engine-level class as `f3bfd55` (the log tail shows only the timeout); not yet established whether it occurs on iOS Safari | 1.25.5: the engine is retried on a fresh instance before a database is declared damaged, and the damaged copy can be restored; a real-iPhone record ([ADOPTION.md](ADOPTION.md) §4, [evidence/REAL-DEVICE-CHECK-TEMPLATE.md](evidence/REAL-DEVICE-CHECK-TEMPLATE.md)) is owed |
| `1962de6` webkit (advisory; run `38019332980`, the tagged 1.25.4 commit) | `device-recovery.mjs:220`: the G2 section's first `page.goto('/')` never shows the sign-up form (a Playwright `TimeoutError`, named by the new annotations); the same script passed in WebKit on the branch run `38011340911` and on `main`'s next run (`2e3498b`, run `38021404382`) | a device sign-in or first load that never completed in Playwright's WebKit on Linux, taken to be the same engine-level class as `f3bfd55` (the log tail shows only the timeout); not yet established whether it occurs on iOS Safari | 1.25.5: the engine is retried on a fresh instance before a database is declared damaged, and the damaged copy can be restored; a real-iPhone record ([ADOPTION.md](ADOPTION.md) §4, [evidence/REAL-DEVICE-CHECK-TEMPLATE.md](evidence/REAL-DEVICE-CHECK-TEMPLATE.md)) is owed |
| 1.25.5's runs, webkit (advisory; runs `38079353516`, `38081170616`, `38083311944`, `38083768353`) | `device-recovery.mjs`: the reload after Start over, a restore and a sign-out crashes the page (`page.reload: Page crashed`) every time; 1.25.4's script never reloaded at that point | not established. Not the second SQLite engine (a diagnostic build without it crashed the same way, run `38083311944`). Every new 1.25.5 check passes in WebKit (108 of 109), and after the crash a new page signs in and finds the client: the records survive | open, and not skipped: the check stays and fails in WebKit by name; step 9 of [evidence/REAL-DEVICE-CHECK-TEMPLATE.md](evidence/REAL-DEVICE-CHECK-TEMPLATE.md) checks the same reload on a real iPhone |
| `e0f97eb` webkit (advisory; run `38087235998`, the 1.25.5 commit to tag) | `device-recovery.mjs:154`: a fresh context's first `page.goto('/')` never shows the sign-up form (a `TimeoutError`), in section 5, unchanged since 1.25.4; this run never reached section 6's reload | the same first-load class as `1962de6` | open, with `1962de6`'s row |
| `2e3498b` thorough | `test/county-fuzz.test.js` round-trip, seed 1298200799 iteration 75: "Check the figures: 1 field needs attention" | a test-generator fault, not a product one: a 300-character fund name cut at 200 characters lost its index suffix, so two funds without a grant number had the same name and the entry was rightly refused as a duplicate (the `thorough` job draws a fresh seed each run; this one replays it) | after 1.25.4, on `main`: the picked text is cut to 190 characters before the index is added; the product is unchanged |

#### Handing a release to the owner
Whoever prepares a release (a maintainer, or the maintaining assistant) stamps it on `main` and then hands it over;
the owner tags it. **The maintaining assistant cannot push tags at all** (its environment's proxy refuses a tag
push), and once `main` is protected (step 2) it cannot push `main` either and opens a pull request, so every
release, security releases included, waits for the owner unless a backup releaser is named (*Supported
versions*). The hand-over is an issue or pull request titled "Release vX.Y.Z", and a line in HANDOFF.md's
*Release waiting*, giving the stamp commit's full SHA, a link to that commit's green CI run, and these commands:
```bash
git fetch origin
git merge-base --is-ancestor <sha> origin/main && echo "on main"      # the stamp is on main
gh run list --workflow ci.yml --commit <sha> --event push             # its CI run: completed, success
git show -s --format='%H %s' <sha>                                    # "Release X.Y.Z"
git tag -a vX.Y.Z <sha> -m "SUDS X.Y.Z" && git push origin vX.Y.Z
```
The gate checks the same things again (CI on that exact commit, on `main`, the tag matching `package.json`), so a
mistake stops the release rather than shipping it. A tag made in any other clone (an assistant's, say) is never
pushed: delete it there (`git tag -d vX.Y.Z`), since the tag's date starts the 28-day clock for a feature release.

**After the tag: the records commit, and the hour `release-state` is red.** Every tag is followed on `main` by a
records commit, "Release records: X.Y.Z completed" (`ec874a4` for 1.25.4), made once the release run has passed and
the web app is published: the hand-off ([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)) and HANDOFF.md's
*Release waiting* no longer list the tag as owed, and the questionnaire, the RFI answer, the evidence index and the
ledger above say it was released (and the zip's SHA-256 goes into the CHANGELOG, *The zip's SHA-256 in two places*,
below). Between the tag push and that commit (about an hour for 1.25.4: the gate, the approval, the web app's
publish) the advisory `release-state` job on `main` is **expected red**: the documents still say the tag is owed
while origin has it. That is not a failure to chase; a `release-state` that is still red once the records commit is
on `main` is (evaluation of 1.25.4, H8). Nothing automates the records commit: it states what the owner and the
release run did, so it is written after they did it.

**Signing the tag (owner; planned, not yet in use).** Release tags are annotated but **not signed** today (every
tag up to `v1.25.4`), so a tag alone does not show who vouched for a release; *Signing a release tag*, below, is the
procedure for when the owner has a signing key whose public half is published. Then the last line above becomes
`git tag -s vX.Y.Z <sha> -m "SUDS X.Y.Z" && git tag -v vX.Y.Z && git push origin vX.Y.Z` (sign, check the signature
before the push, push).

#### Signing a release tag
A signed tag adds what the gate, the checksums and the SBOM cannot: an accountable signature, by the owner, on the
statement "this commit is release X.Y.Z". It replaces none of them. Only the owner signs, with a key that is the
owner's own (never the shared automation identity, never in the repository or in a CI secret), on the owner's machine.

1. **Make the key once.** An SSH key (Git 2.34 or later), `ssh-keygen -t ed25519 -f ~/.ssh/suds-release-signing -C
   "SUDS release signing"`, then in the clone the owner tags from: `git config gpg.format ssh` and `git config
   user.signingkey ~/.ssh/suds-release-signing.pub`. (An OpenPGP key works the same way: `gpg --full-generate-key`,
   then `git config user.signingkey <fingerprint>`.) Keep a protected backup of the private key; losing it means a new
   key, announced the same way.
2. **Publish the public half in two places**, so a county can check one against the other: the owner's GitHub account
   (Settings → SSH and GPG keys → *New SSH key*, key type *Signing Key*; GitHub then marks the tags *Verified*), and the
   repository, as an allowed-signers line in `docs/security/release-signing-keys` (`<principal> namespaces="git"
   ssh-ed25519 AAAA…`, with a role address or the owner's GitHub no-reply address as the principal, never a personal
   one), committed on `main` with its fingerprint (`ssh-keygen -lf ~/.ssh/suds-release-signing.pub`) in
   docs/security/QUESTIONNAIRE.md #39 and on the procurement page.
3. **Sign each release tag** at the stamp commit the hand-off names: `git tag -s vX.Y.Z <sha> -m "SUDS X.Y.Z"`, then
   `git tag -v vX.Y.Z` (it must print a good signature with that fingerprint) before `git push origin vX.Y.Z`. The
   hand-off's commands ([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)) and `scripts/release-state.js`,
   which reads their `git tag -a` lines, change to `-s` in the same commit that publishes the key.
4. **A county verifies one** from any clone:
   ```bash
   git fetch origin tag vX.Y.Z
   git config gpg.ssh.allowedSignersFile docs/security/release-signing-keys   # the published key (OpenPGP: gpg --import it)
   git tag -v vX.Y.Z            # Good "git" signature for <principal> with ED25519 key SHA256:<fingerprint>
   git rev-parse 'vX.Y.Z^{commit}'                                             # the commit the hand-off and the Release name
   ```
   and compares the fingerprint with the one on GitHub (`https://api.github.com/users/<owner>/ssh_signing_keys` lists
   the owner's signing keys) and on the procurement page. A tag that does not verify, or verifies with another key, is not a release.

Pushing the tag starts `release.yml`. *Run workflow* (Actions → *Release*) is only for running it again **on an
existing `v*` tag** (*Use workflow from* → the tag; a retry after a flaky job, or with `policy_exception`); on a
branch it is refused by the gate's first step. Until 1.16.2 releases were dispatched on a `release/v*` branch and
the workflow created the tag itself with the workflow token; the owner's settings (the `release` environment
limited to `v*` tags, and the tag ruleset whose only bypass is the owner) refuse both, after the approval, so the
workflow now never creates a tag (`gh release create --verify-tag`) and no `release/v*` branch is made
(*Release tags*, below).

**The released commit is the version-stamp commit** (1.16.2). The commit tagged and released is the one that
sets `package.json`'s version (the "Release x.y.z" commit above), and nothing comes after it: every fix, test fix
included, is merged and green on `main` **before** the stamp, and the stamp commit's own CI (the whole gate,
`thorough-sdc` and `browser` included) is what releases it. 1.14.x to 1.16.1 each released a commit after their
stamp (1.16.1: `3c57362`, a test fix after `a877a9a`), so the CHANGELOG section and the stamp had not seen what
shipped. A fix needed after the stamp and before the tag means stamping again: put the fix on `main`, then a new
stamp commit on top (the next patch version, if the version line is to change; the gate recognises the stamp by
the commit that last changed the `"version":` line). The gate checks it: `release-policy.js --sha` **warns**
(`::warning::… is not the commit that set package.json's version …`) when the released commit is not the stamp,
and **refuses** a tag that is not `v<package.json version>` (until 1.16.2 only the release job, after the
owner's approval, checked the tag). The warning is also written to the run's summary (1.16.3), on the page where
the owner approves the `release` environment, since an annotation in the log is easily missed. A warning, not a
refusal, so that a reviewed exception stays possible: the owner decides, and says so in the notes.
**The zip's SHA-256 in two places.** SUDS Server's `install.sh` and `upgrade.sh` need `--release-sha256` from a channel other than the download (docs/SELF-HOSTING.md, *Upgrading*), so once the release job has published `suds-vX.Y.Z.zip.sha256`, the owner copies that SHA-256 into the GitHub release notes **and** into the version's CHANGELOG entry on `main` (a line `SHA-256 of suds-vX.Y.Z.zip: <hex>`, committed and pushed as its own commit). An operator compares the two; a zip swapped on the release page cannot also change the repository's history. The CHANGELOG line is on `main`, never at the tag: a zip's checksum cannot be inside the commit it is built from. Because `git archive` is reproducible, the value can be known before the release: `git archive --format=zip --prefix=suds-vX.Y.Z/ <stamp sha> | sha256sum` gives what the job will publish (checked against the published `v1.15.4` and `v1.16.2`), and the hand-off for the untagged releases (1.16.3 onwards) lists each ([evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)); compare it with the published file before recording it.

Pushing the tag runs `.github/workflows/release.yml`, which first passes the release gate (below), then re-runs the tests in the `verify` job (read-only token, no environment), and, after the owner's approval, the `release` job packages `suds-v1.0.1.zip` (`git archive`, so no local data can leak) and publishes a GitHub Release for the tag with the zip attached. Since 1.16.4 (engineering review of 1.16.3, M5) the `release` job is the only one with a write token and runs no npm and none of the released commit's code: `npm ci` and `npm test` ran in `verify`, where a dependency could once reach the packaging step through `$GITHUB_ENV`, `$GITHUB_PATH` or a replaced `git`, `sha256sum` or `gh`. As its last step it starts the web-app (GitHub Pages) workflow for the tag (`gh workflow run web-app.yml --ref v1.0.1`): a release created with `GITHUB_TOKEN` does not trigger other workflows by itself. That dispatch is the web-app workflow's only trigger (since 1.16.1 a tag push or a `release` event no longer starts it): it runs only on a `v*` tag whose GitHub Release exists at that commit, and its `publish` job waits in the `release` environment, so the owner approves it too. The on-device web app is published on releases only — never on a push to `main` — so what is on the public URL is always a released version ([WEB_APP.md](WEB_APP.md#when-it-is-published)). No workflow uses a marketplace action; the only actions used are GitHub's own `actions/upload-artifact` and `actions/download-artifact`, pinned to a commit, in `web-app.yml` (they run under the Actions policy *Allow actions created by GitHub*).

### Release gate
QA catches bugs; the gate stops them shipping. The `gate` job in `release.yml` runs `scripts/release-gate.js` for the commit being released (`GITHUB_SHA`) before anything is built. It asks the GitHub API (with the workflow's own token — no marketplace action) for the runs of `ci.yml` on that exact commit, counts only `push` runs (a `pull_request` run tests a merge commit, not this one), and passes only when one of them **concluded success with the `test`, `thorough`, `thorough-sdc`, `browser`, `node24`, `dr-drill` and `evening` jobs all successful** (with `SUDS_THOROUGH=1`, `thorough-sdc` runs the publication-release disclosure sweeps at full size — `npm test` runs a sample — and `thorough` the performance checks in `test/thorough/` and the other timing budgets, which `npm test` leaves out so a busy runner cannot flake it; `npm run test:thorough` runs both, `node scripts/test-thorough.js --part sdc|rest` either. Until 1.16.0 they were one job that took about 25 of its 30 minutes; the sweeps now have their own, with a 60-minute limit — measured alone on the development container they take about 27 minutes, everything else 17 seconds):

| CI job | What it proves |
| --- | --- |
| `test` | `npm test`, the committed kernel and generated schema match their sources, the package builds, browser modules parse |
| `browser` | the whole browser suite, `scripts/ui/run-all.sh` — 60 scripts, including `accessibility` (fails on any WCAG 2.1 AA finding) and the QA-regression script `a11y-round4` |
| `node24` | `npm test` on the next Node LTS line |
| `thorough` | the performance checks (`test/thorough/`) and timing budgets, at full size |
| `thorough-sdc` | the statistical-disclosure-control attacker sweeps at full size (`scripts/test-thorough.js` `SDC_SWEEPS`) |
| `dr-drill` | backup and restore actually work: `scripts/dr-exercise.js` (seed, encrypted backup through the scheduled path, `npm run dr-drill` with an escrowed key file, host restore into a fresh data directory, row counts, audit chain, signed report verified with the public key); the signed report is printed in the job log |
| `evening` | `npm test` with `TZ=America/Los_Angeles` and the clock at 9pm local, when the UTC date is already tomorrow's (`scripts/test-evening.sh`, libfaketime): the date-bug class of the evaluation of 1.25.0, E1. Required from 1.25.5 (evaluation of 1.25.4, H8); before, it was only not advisory |

`service-sandbox` (below, *The service-sandbox job*) and `release-policy` are not in the list, but they are not advisory either: a red one fails the CI run, and the gate passes only a run that concluded success. `webkit` and `release-state` stay advisory (`continue-on-error`) and are not checked. If CI on the commit is still running (a tag pushed together with its commit) the gate waits, up to an hour (`RELEASE_GATE_WAIT_MINUTES`). A failed or missing required job fails the release with the reason; fix it (or re-run a flaky job — the latest attempt counts) and run the release again. The `verify` and `release` jobs then check out exactly the gated commit, so a branch that moved in the meantime cannot slip an untested commit in. The decision logic is tested in `test/release-gate.test.js`, which also fails if a required job is renamed out of `ci.yml`.

1.11.0 itself was published while its `browser` job had failed — the case this gate now refuses.

#### The service-sandbox job
`service-sandbox` (1.25.5; evaluation of 1.25.4, H4) runs SUDS Server the way it runs on a county's VM: under the
release's own `deploy/linux/suds.service`, unchanged, as the non-root `suds` user, with every sandbox setting the unit
sets in force (it checks them with `systemctl show`, including a system-call filter that refuses `fchown`).
`scripts/service-sandbox-check.js` lays the runner out as `deploy/linux/install.sh` does (the release zip at
`/opt/suds/<version>`, the pinned Node at `/opt/suds/node`, root-only keys loaded with `LoadCredential=`, install.sh's
drop-in for the offsite and anchor shares, two tmpfs mounts as those shares), then signs in as the first administrator
over HTTP and presses what an office presses: *Back up now* with the offsite share configured (the offsite and local
copies compared, size and SHA-256), an online snapshot written to the share by the server's own timer, an audit anchor
and the chain verified against the anchors, a recovery drill from the offsite copy, a restore of that copy through
Settings, and *Back up now* again. It fails if the journal or the kernel's log shows `status=31/SYS`, `SIGSYS` or a
seccomp kill, if the service restarted (`NRestarts`), or if it does not stop cleanly. **Why:** from 1.18.0 to 1.25.3
every scheduled offsite copy on a real server was an empty file, because `fs.copyFile` calls `fchown`, the unit's
`SystemCallFilter=~@privileged` refuses it, and the kernel killed SUDS before a byte was copied; `Restart=always`
brought it back each time, and no test, `dr-drill` run or installer run ever took a backup inside the unit. 1.25.4
fixed the copy and added only a source check (`test/offsite-backup-copy.test.js`), which cannot see a refused call made
by Node itself or a dependency. The job is not advisory; it joins the gate's `REQUIRED_JOBS` once it has been green on
`main`. It runs only on a disposable host (it refuses where `/etc/suds`, `/opt/suds` or `/var/lib/suds` exists); to
run it by hand on a throwaway Ubuntu 24.04 VM: `node scripts/package.js /tmp/suds.zip && sudo node
scripts/service-sandbox-check.js --disposable-host --release-zip /tmp/suds.zip --node-dir <the pinned Node>`.

**The gate runs main's copy of its scripts** (1.16.1). It checks out the commit being released, but runs
`scripts/release-gate.js` and `scripts/release-policy.js` from **`main`'s copy** (`git archive <main commit> …`
into a temporary directory; `release-policy.js --root src` then reads the released tree), so that a commit that
trimmed `REQUIRED_JOBS` or lifted a policy limit, together with the tests that pin them, cannot release itself by
those two scripts. Since 1.16.2 the gate records the main commit it used (`main_sha`, a job output) and the release
job's notes step runs the policy script from that same commit, not from `origin/main` at publish time (main can move
while the release waits for approval). Whatever the `policy_exception`, the gate also refuses:

* a commit that is not on `main` (`git merge-base --is-ancestor <commit> origin/main`; a tag on a feature-branch
  commit with green CI used to release) or, since 1.17.0 and only for a patch of an older minor than `main`'s, on
  that minor's `maint/X.Y` branch (*Backports*, below),
* a version already tagged at another commit (`v<version>` exists and is not this commit): dispatching *Run
  workflow* on `main` after a release, with `package.json` not yet bumped, used to rebuild the zip and checksum
  from the new commit and upload them over the published ones (`--clobber`), and
* since 1.16.2, a tag that is not `v<package.json version>`, and since 1.16.3 any run that is not on a `v*` tag
  (a *Run workflow* on a branch); and it warns, in the log and the run summary, when the released commit is not
  the version-stamp commit (*Cutting a release*, above).

**What running main's copy guarantees, and what it does not** (engineering review of 1.16.1, M2). It guarantees
exactly this: the two gate scripts that decide are `main`'s at the moment the gate ran (`main_sha`), never the
released commit's own edit of them, and the commit released is on that `main`. It does **not** guarantee more:

* **The workflow file at the released ref decides.** GitHub runs `release.yml` (and `web-app.yml`) from the ref
  that was pushed or dispatched. A commit that edits `release.yml` itself (to skip the gate job, or to run its own
  copy of the scripts) is not held by main's scripts at all. What holds it: that commit must still be merged to
  `main` through review (branch protection with code-owner review, *Owner: repository settings*, step 2), and the
  `release` job waits for the owner's approval (step 1). The same holds for every **older ref**: an old tag or
  branch carries the workflow files of its day (the 18 tags v1.10.0 to v1.16.0 and the `release/v*` branches carry
  a `web-app.yml` that publishes with no approval), which only repository settings can stop (steps 5 and 6).
* **The policy reads the released tree by running it.** `release-policy.js` learns the released commit's
  migrations, permissions and routes by `require`-ing its `server/db.js`, `server/auth.js`, `server/app.js` and
  route modules (`PROBE`), so a commit can understate its own surface (a route registered only when the probe is
  not looking). The size count (`git diff --numstat`) and the device routes (read from `local/` source) do not run
  the released code. Proposed, not done: read the surface statically from `git show <sha>:server/…`, or run
  main's probe against main's tree and compare the two.
* **A loosening governs its own release.** The released commit must be on `main`, so `main` is that commit or
  later: a pull request that raises `PATCH_MAX_ADDED_LINES` or trims `REQUIRED_JOBS` is in `main`'s copy by the time
  the release that contains it runs, and governs that release. "A change to the gate takes effect for the releases
  after it is merged" includes the release it is merged in. The control is the review of the pull request that
  changes the gate (CODEOWNERS names the owner for `scripts/release-*.js` and `.github/`), which counts only once
  branch protection is on (step 2); the repository cannot show that it is.
* **Changes to the gate fail closed, not open.** If `main`'s `release-policy.js` ever `require`s a helper file,
  the two-file `git archive` leaves it out and every release fails until `release.yml` lists the helper; re-running
  an old tag's release after `main` changed the scripts' flags fails too. Neither releases anything unchecked.
* **The settings are checked, not assumed** (1.17.0): a weekly workflow reads them and fails when one is off, or
  cannot be read once its read-only token exists (*Owner: repository settings*, step 9).

The release job never replaces a published file: when the GitHub Release already exists (a re-run of the same
commit's release) it uploads the zip and checksum only if neither is there, and stops with an error if only one
is. Tested in `test/release-policy.test.js` (`commitProblems`, and the workflow's shape).

#### A GitHub Release made by someone else
Write access includes creating and editing GitHub Releases, and no setting restricts it: a ruleset guards refs,
not Releases. So a collaborator could publish Release `vX.Y.Z` for the owner's tag, with a zip of their own, in the
hour the gate waits for CI or while the release waits for approval; until 1.16.4 the release job then found "the
zip and checksum" already there, replaced nothing and went green (engineering review of 1.16.3, H1), and with
immutable releases on (step 5) the forgery would have stayed for good. Since 1.16.4 `scripts/release-existing.js`
(main's copy, as for the gate's other scripts) checks any Release that exists for the tag, **in the gate, before
the owner is asked to approve**, again in the release job after the approval, and once more after publishing:
* its author must be `github-actions[bot]`, the account this workflow publishes as. That alone proves little (any
  workflow run with a write token, on any branch, acts as that account), so also:
* it may carry only `suds-vX.Y.Z.zip` and `suds-vX.Y.Z.zip.sha256`, both or neither (and the Windows server pair,
  likewise, and from 1.25.5 the SBOM, `sbom-X.Y.Z.cdx.json`: the gate and the release job copy it from the tag's
  `docs/evidence/` with `git show`, attach it with the zips, and refuse a tag that has none); and
* each one it carries must be **byte for byte** the file built from the tag, as the job builds it (`git archive
  --format=zip --prefix=suds-vX.Y.Z/` of the tag, and `sha256sum` of that). `git archive` is reproducible: the
  1.16.2 review rebuilt the published `suds-v1.16.2.zip` to the same bytes.
A draft the workflow itself left behind (a `gh release create` interrupted between its upload and its publish) is
published once its files pass; any other draft is refused. The gate's read-only token does not see drafts, so a
forged draft is refused by the release job, after the approval but before anything is uploaded. A refusal names
what is wrong and how to recover: **delete that Release, keeping the tag** (`gh release delete vX.Y.Z --yes`,
without `--cleanup-tag`), and run the release again (*Run workflow* on the tag); if it cannot be deleted or its
files replaced (an immutable release), **release the next patch version** instead. What it does not check: the
text of the notes of a Release made by the bot account (a branch's workflow could write them); the release page's
"Released by" line, at the foot, names who pushed the tag.

### Backports: a patch of the previous minor from `maint/X.Y`

Until 1.17.0 there was no maintenance line (engineering review of 1.16.1, M3): a release had to be on `main`, so once
1.17.0 was on `main` a 1.16.x security fix could only ship as a 1.17.x, and *Supported versions*' 30 days of fixes for
the previous minor was a promise the machinery could not keep. Since 1.17.0:

* **A maintenance branch per minor**, `maint/1.16` (not `release/v*`, which named one release each), made by the
  owner from the minor's last tag when the next minor is released, and protected like `main` (*Owner: repository
  settings*, step 2).
* **The gate accepts it only for an older line.** `release-policy.js --sha … --main origin/main --maint
  origin/maint` accepts a commit on `origin/maint/X.Y` in place of `main` **only** when the version is a patch
  `X.Y.z` (`z` above 0) and `X.Y` is older than the minor of `package.json` on `main` (`maintBranch`). A `1.17.1`, a
  `1.16.0`, or a commit on any other branch is refused as before ("is not on origin/main or origin/maint/1.16"). The
  gate fetches `refs/heads/maint/*` beside `main` and still runs `main`'s copy of the scripts.
* **The policy compares it with its own line.** The previous tag is the highest one below the version, so 1.16.5 is
  measured against `v1.16.4`, not `v1.17.0`: no migration, permission or route, and at most 1,500 counted lines,
  exactly as for any patch.
* **It is not the newest release.** The gate says so (`--latest-out`, `isLatest`: a `vX.Y.Z` tag above it exists, or, since 1.17.1, `main`'s `package.json` names a newer version),
  and the release job then publishes the GitHub Release with `--latest=false` (GitHub would otherwise mark the newest
  *made* release Latest, and "latest" downloads would go back to 1.16) and does **not** start the web-app publish:
  SUDS on this device stays on the newest minor. `web-app.yml` refuses on its own any tag that is not the newest
  release tag, before it builds and again after the approval, so a *Run workflow* on an older tag cannot roll the
  public URL back either, and since 1.17.1 it also refuses a version older than the `version.json` `gh-pages` serves (`scripts/pages-version-check.js`: 1.17.0 was published before it had a tag).
* **The workflow at the tag decides** (*What running main's copy guarantees*, above): a tag on `maint/1.16` runs
  `maint/1.16`'s `release.yml`. A branch made from `v1.16.4` carries 1.16.4's, which does not pass `--maint` and is
  refused as "not on main"; so the first pull request into a new maintenance branch brings the release workflows up
  to `main`'s (step B below). Tested in `test/release-policy.test.js` (`maintBranch`, `commitProblems`, `isLatest`,
  the workflows' shape, and the script end to end in a scratch repository: a backport on `maint/1.16` releases, the
  same version on a stray branch, or a 1.17.1 on a `maint/1.17`, does not).

**The owner's procedure.** Steps A and B once per minor, C for each backport:

A. *Settings, once* (step 2 of *Owner: repository settings* covers them): `maint/*` is a target of the `main`
   ruleset, and a second ruleset lets only an administrator create a `maint/*` branch. The scheduled settings check
   (below) reports both.

B. *When a new minor is released* (1.17.0's tag pushed and its release published), make the previous minor's branch
   from its last tag, then bring its release workflows up to `main`'s. **This needs the `v1.16.4` tag**, which does
   not exist yet (*Record: 1.16.4 published without a tag*, above: pushed in one push with `v1.17.0`, never
   alone); until it does, the first line
   below fails, and a 1.16.5 would be measured against `v1.16.2`:
   ```bash
   git fetch origin --tags
   git push origin "$(git rev-parse 'v1.16.4^{commit}'):refs/heads/maint/1.16"
   git switch -c maint-1.16-workflows origin/maint/1.16
   git cherry-pick -x <the commit "Release gate: backports from maint/X.Y" on main>   # CHANGELOG conflict: keep maint's
   git push origin HEAD        # a pull request into maint/1.16; merged once its CI is green
   ```
   If GitHub refuses the branch push (`GH013`) because of the `main` ruleset's pull-request or status-check rules,
   take `maint/*` out of that ruleset's targets, push, and put it back. Later changes to the release machinery on
   `main` reach `maint/1.16` the same way, as a cherry-pick, if a backport release needs them.

C. *Each backport.* The fix is merged to `main` first. Then (a maintainer or the assistant, up to the pull request):
   ```bash
   git fetch origin
   git switch -c backport/1.16-<topic> origin/maint/1.16
   git cherry-pick -x <the fix's commit on main>                   # -x records the main commit in the message
   git push origin HEAD        # a pull request into maint/1.16 that names the main commit; merged once CI is green
   ```
   then a stamp on `maint/1.16` (a pull request: `npm version 1.16.5 --no-git-tag-version` and a `## 1.16.5`
   section in its CHANGELOG, with the *Advisory* note of a security release), and, once CI on the stamp commit is
   green, the owner tags it exactly as on `main`, checking the branch instead:
   ```bash
   git fetch origin
   git merge-base --is-ancestor <sha> origin/maint/1.16 && echo "on maint/1.16"
   gh run list --workflow ci.yml --commit <sha> --event push            # completed, success
   git show -s --format='%H %s' <sha>                                   # "Release 1.16.5"
   git tag -a v1.16.5 <sha> -m "SUDS 1.16.5" && git push origin v1.16.5
   ```
   The release waits for the owner's approval in the `release` environment as usual; its summary says it is a
   maintenance release (not Latest, no web app). Finally, copy the `## 1.16.5` section into `main`'s CHANGELOG (a
   pull request), so `main`'s history names every release. Nothing checks the 30-day support window: after it, simply
   stop releasing from the branch (the ruleset keeps it from being deleted).

### Owner control over releases
The gate proves CI passed; it does not prove the owner agreed. Anyone with write access can dispatch the release
workflow (the run then waits for the owner's approval) and create or edit GitHub Releases (*A GitHub Release made
by someone else*, above); until the owner turns on the `v*` tag ruleset (step 3) they can also push a `v*` tag.
Keep write collaborators to the minimum. Three things, prepared in the repository since 1.16.0, put the owner in
the path; **the first two only take effect once the owner turns on the GitHub settings below** (an assistant or
a workflow cannot change repository settings).

* **`environment: release`** on the `release` job in `release.yml`. The job then waits for a reviewer's
  approval, after the gate and the tests (the `verify` job, which holds nothing to protect) and before anything is
  packaged or published, however it was started (a tag push or *Run workflow* on the tag). Since 1.16.1 the web app's publish runs in the same environment (since
  1.16.3 the `publish` job of `web-app.yml`, which builds nothing), so publishing SUDS on this device waits for the
  same approval (a second one, after the release).
* **`.github/CODEOWNERS`** names `@taugustincst` for the release machinery (`.github/`, `scripts/release-gate.js`,
  `scripts/release-policy.js`, `scripts/release-existing.js`, `scripts/release-site-check.js`, `scripts/build-static-site.js`,
  `scripts/test-thorough.js`, `scripts/package.js`, and since 1.17.0 `scripts/repo-settings-check.js`,
  `scripts/workflow-yaml.js` and `scripts/migration-order.js`, their tests, this file) and for
  the modules that decide who may do what and what may leave the programme: `server/auth.js`,
  `server/permissions.js`, `server/disclosure.js`, `server/crypto.js`, `local/vault.js`.
  `test/release-gate.test.js` fails if a listed path is renamed away from its owner.
* **Who released it** is written at the foot of the GitHub Release notes: `Released by @<github.actor>
  (<event>, run <id>)`, and `re-run by @<github.triggering_actor>` when someone else re-ran it.
* **Who vouched for it**, once the owner signs release tags (*Signing a release tag*, above): until then a tag is
  unsigned, and the checks a county can repeat are exact-commit CI, the reproducible zip, its SHA-256 recorded on
  `main` before the tag, the web app checked against the tag, and the release's SBOM (docs/security/QUESTIONNAIRE.md
  #39).

### Owner: repository settings

Everything in this section is a setting only the repository owner can change (GitHub → the repository →
**Settings**); a workflow or an assistant cannot. Until each is done, the protection it names is **not in force**,
whatever the workflow files say. Do them **in this order** (the rulesets of steps 2 and 3 before the deploy key
of step 6, which can write any ref no ruleset guards); each ends with how to check it. They fit the release flow
of *Cutting a release* (1.16.3): the owner pushes a `v*` tag at a green stamp commit on `main`, and *Run
workflow* only re-runs an existing tag. (1.16.2's version of these steps did not: it opened the environment to
`main` and restricted tag creation while releases were dispatched on `release/v*` branches and the workflow made
the tag, so applying it would have stopped the next release after its approval.)

**1. The `release` environment: the owner approves every release and every web-app publish.**
Settings → **Environments** → **New environment** → name `release` (or open it, once a release has created it):
* tick **Required reviewers**, add `taugustincst` (up to six people or teams; one approval releases), **Save
  protection rules**;
* **Prevent self-review: leave it off while the owner is the only reviewer** (engineering review of 1.16.3, L2).
  It stops the person who started a run from approving it, and GitHub counts whoever pushed the tag as the one
  who started the release: with the owner as the only tagger (step 3) and the only reviewer, ticking it makes every
  release impossible to approve. The trade-off: with it off, the approval is the owner confirming their own tag,
  a second look at what the gate found (its summary, a stamp warning), not a second person. Tick it only once a
  second reviewer is listed here, and then a release the owner tags is approved by that person. (The web-app
  publish is started by `github-actions[bot]`, so it could be approved either way.)
* **Deployment branches and tags** → *Selected branches and tags* → **Add deployment branch or tag rule**: `v*`
  (Ref type: **Tag**), and nothing else. No branch can then run a job in the environment: not `main`, not a
  `release/v*` or feature branch (the gate also refuses a run that is not on a `v*` tag).
* Check: release normally (push the tag); the run stops at *Waiting for review: release needs approval* until
  approved, and the gate job's summary on that page shows any stamp warning.

**2. Branch protection on `main`: every change, the gate's own included, is reviewed.**
Settings → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset** (or Settings → Branches → *Add
classic branch protection rule*): name `main`, Enforcement status **Active**, **Target branches** → *Add target* →
*Include default branch*; then tick:
* **Restrict deletions** and **Block force pushes**;
* **Require a pull request before merging**: Required approvals **1**, **Require review from Code Owners**,
  **Dismiss stale pull request approvals when new commits are pushed**;
* **Require status checks to pass**, **Require branches to be up to date before merging**, and add `test`,
  `thorough`, `thorough-sdc`, `browser`, `node24`, `dr-drill` and `evening` (the release gate's `REQUIRED_JOBS`; they are
  offered once they have run on a pull request);
* **Bypass list**: leave it empty (classic: tick *Do not allow bypassing the above settings*), or the owner's own
  pushes skip review; add *Repository admin* only if the owner accepts that. Never add *Deploy keys* here.
* Check: `git push origin HEAD:main` from a local commit is refused (`GH013`). The version stamp then reaches
  `main` through a pull request like any other change.
* **The maintenance branches too** (1.17.0; *Backports*): in the same ruleset, **Target branches** → *Add target* →
  *Include by pattern* `maint/*`, so every `maint/X.Y` has `main`'s rules. Then a second branch ruleset: name
  `maint branches: owner creates`, **Active**, *Include by pattern* `maint/*`, tick **Restrict creations** and
  **Restrict deletions**, **Bypass list** → *Repository admin* (Always allow), so only the owner makes a maintenance
  branch. (A classic protection rule cannot restrict who creates a branch; use rulesets for `maint/*`.)
  Check: a collaborator's `git push origin HEAD:refs/heads/maint/9.9` is refused.

**3. A tag ruleset for `v*`: only the owner makes release tags.**
Rulesets → **New ruleset** → **New tag ruleset**: name `release tags`, **Active**, *Add target* → *Include by
pattern* `v*`; tick **Restrict creations**, **Restrict updates**, **Restrict deletions**; **Bypass list** →
*Add bypass* → *Repository admin* (Always allow). Nothing else: not *Deploy keys*, not the GitHub Actions app (no
workflow creates a tag since 1.16.3). A maintainer who is not an admin can then prepare the stamp but not tag it;
add that account to the bypass list only if the owner wants it to release (the maintaining assistant cannot push
a tag whatever this list says: *Handing a release to the owner*). Check: a collaborator's
`git push origin v9.9.9` is refused; the owner's tag push starts the release.

**4. The default Actions token is read-only, and only GitHub's own actions may run.**
Settings → **Actions** → **General**:
* *Actions permissions*: **Allow taugustincst, and select non-taugustincst, actions and reusable workflows** →
  tick **Allow actions created by GitHub** and nothing else (`web-app.yml` uses `actions/upload-artifact` and
  `actions/download-artifact`, pinned to a commit; no other action is used); tick **Require actions to be pinned to
  a full-length commit SHA** where it is offered.
* *Workflow permissions*: **Read repository contents and packages permissions**, and untick **Allow GitHub
  Actions to create and approve pull requests** → Save. `release.yml` and `web-app.yml` ask for the write scopes
  they need themselves; every other workflow runs read-only.
* Check: the next CI run is green (it uses no action), and the next web-app publish passes its artifact steps.

**5. Immutable releases: a published zip and checksum can never be replaced (engineering review of 1.16.2, M3).**
Settings → **General** → **Releases** → tick **Enable release immutability** (GitHub's *immutable releases*).
From then on a published release's assets cannot be added, changed or deleted, and its tag cannot be moved or
deleted, by anyone: the release page marks it *Immutable*, and a county's recorded checksum stays true. This is
what stops the older refs: every tag from v1.1.0 to v1.15.4 (and its `release/v*` branch) carries a `release.yml`
with *Run workflow*, no environment and `gh release upload --clobber`, which rebuilds that version's zip and
checksum and uploads them over the published ones with no approval (the same source, new bytes, a new checksum);
and any collaborator with write access can edit a release's files in the web page or the API, which no ruleset
covers. Immutability refuses both. `release.yml` needs nothing more: it never replaces a published file, and makes
the release in one step.
* GitHub applies it to releases published **after** it is turned on. Check an older release's page (v1.16.2, say):
  if it is not marked *Immutable*, its files can still be replaced as above. Record their checksums now, so a
  replacement is noticed: `for t in $(gh release list --limit 100 --json tagName --jq '.[].tagName'); do gh release
  download "$t" --pattern '*.sha256' --dir checksums --clobber; done`, and keep the folder.
* Immutability also locks in whatever was published first, a forged Release included: that is why the release
  workflow refuses a Release it did not make, in the gate, before it asks for approval (*A GitHub Release made by
  someone else*). If one is ever published, it cannot be replaced; release the next patch version.
* Check: after the next release, its page shows *Immutable*, `gh release view v<version> --json author --jq
  .author.login` prints `github-actions[bot]`, and `gh release upload v<version> some-file` is refused.

**6. Only an approved, released tag can publish the web app (engineering review of 1.16.1, H2; of 1.16.2, M2).**
**Do steps 2 and 3 first.** A deploy key with write access can push *every* branch and tag that no ruleset
guards against it, `main` included; steps 2 and 3 are what keep it to `gh-pages`.
Every ref made before 1.16.1 (the tags v1.10.0 to v1.16.0, the `release/v*` branches, older feature and
Dependabot branches) carries a `web-app.yml` that force-pushes its own build to `gh-pages` on *Run workflow*,
with no approval and no version check: anyone with write access could put an old, unfixed build, or unreleased
code, on the public URL. A workflow file cannot fix old refs; this setting does. Since 1.16.2 `web-app.yml` pushes
with a deploy key held as a secret of the `release` environment, so only a job that waited for the owner's
approval in that environment (step 1: only on a `v*` tag) can read it, and a ruleset lets only a deploy key
update `gh-pages`. Since 1.16.3 the key is read only by the `publish` job, which runs no third-party code: it takes
the site the `build` job built (npm, Playwright and apt run there, with no environment and no secret), unpacks it
as plain files, and pushes; its run summary says which credential pushed. Since 1.16.4 (engineering review of
1.16.3, M2) the `build` job packs and uploads the site straight after building it, before Playwright or apt
runs, and fails if the kernel it rebuilt differs from the committed one; and the `publish` job checks the site
itself against the tag (`scripts/release-site-check.js`, the tag's own code with no npm package): every file
copied from `public/` or generated from it (the `.html` pages with their policy and frame guard, `sw.js`,
`local-boot.js`, `frame-guard.js`) must be byte for byte what the tag's `public/` builds to, and the only other
files allowed are the provider pictures under `region-pictures/`, which only a download can make: JPEG, PNG or
WebP files that start as one, and a `manifest.json` that parses.

**The secret is `PAGES_PUBLISH_KEY`** (1.16.4; engineering review of 1.16.3, M1). Until 1.16.3 this guide named it
`PAGES_DEPLOY_KEY`, and the `v1.16.2` copy of `web-app.yml` reads that name in a job in the `release` environment
that also runs `npm ci`, Playwright and apt: approving a *Run workflow* on `v1.16.2` would have handed the key to
all of them. No older copy reads the new name, so an old tag's run gets no key and is refused by the ruleset.
If a `PAGES_DEPLOY_KEY` secret was ever created, delete it. The `v1.16.3` copy reads the old name too (in its
`publish` job): released before this step, its web app publishes with the workflow token; after it, it cannot
publish, and 1.16.4 is the first release to publish with the key. **Approve a *Web app* run only on the release you
have just made**: a run waiting for approval on any other tag is a republish of an old build (a rollback on the
public URL), and should be rejected unless you started it. Since 1.16.4 each tag's runs queue on their own
(`concurrency` per tag), so a run on another tag can no longer displace the real one.
1. Rulesets → **New ruleset** → **New branch ruleset**: name `gh-pages: release only`, **Active**, *Add target* →
   *Include by pattern* `gh-pages`; tick **Restrict updates**, **Restrict deletions**, **Block force pushes**
   (and **Restrict creations**); **Bypass list** → *Add bypass* → **Deploy keys** → *Always allow* (and
   *Repository admin* if the owner wants to repair the branch by hand). Do **not** add the GitHub Actions app.
   The *Deploy keys* bypass admits **every** deploy key with write access, not one key: keep the key below the
   only one (Settings → **Deploy keys** lists them; delete any other, or untick its write access).
2. On your own machine: `ssh-keygen -t ed25519 -N '' -C 'suds gh-pages (release environment)' -f suds-pages`.
3. Settings → **Deploy keys** → **Add deploy key**: title `gh-pages publish (release environment)`, key: the
   contents of `suds-pages.pub`, tick **Allow write access** → Add key. Note the fingerprint GitHub shows.
4. Settings → **Environments** → `release` → **Environment secrets** → **Add environment secret**: name
   `PAGES_PUBLISH_KEY` (not `PAGES_DEPLOY_KEY`, the name older copies of the workflow read), value: the whole
   contents of `suds-pages` (the private key, with its BEGIN and END lines) → Add secret. Then delete both files
   from your machine. Never add it as a repository secret, and delete any `PAGES_DEPLOY_KEY` secret, in the
   environment or the repository.
5. Check it: Actions → *Web app* → **Run workflow** on `v1.16.0` and on `v1.16.2`, one after the other: `v1.16.0`'s
   publish step must fail (`GH013`, the ruleset); `v1.16.2`'s waits for approval (its job is in the environment),
   and once approved for this check must also fail with `GH013`, because it finds no `PAGES_DEPLOY_KEY`; `gh-pages`
   must not change. Then release normally (or *Run workflow* on the current release tag): after the approval, the
   publish succeeds, its summary reads "Pushed … with the deploy key PAGES_PUBLISH_KEY (SHA256:…)" with the
   fingerprint from 3, and the site shows the released version. (Between sub-steps 1 and 4 a publish stops with
   "PAGES_PUBLISH_KEY is not a secret of the release environment, and gh-pages is guarded by a ruleset", which is
   expected.)

The other way, which the review also offered: Settings → **Pages** → *Source*: **GitHub Actions**, with the
`github-pages` environment given required reviewers and a `v*`-only deployment rule. Then pushes to `gh-pages`
publish nothing, but `web-app.yml` must first be changed to deploy through the Pages artifact API
(`actions/upload-pages-artifact`, `actions/deploy-pages`); that is not done, so switching the source today would
stop publishing. Use the deploy key above until then.

**7. Delete stale branches.** List them: `git ls-remote --heads origin`. Delete every feature, `claude/…` and
Dependabot branch that is merged or abandoned — at the time of the 1.16.2 review `feature/admin-managed-permissions`,
`claude/perms-expansion-1.16.0-wip` and `dependabot/docker/node-26.10-alpine` (close its pull request; Dependabot
opens a fresh one) — and the `release/v*` branches, which are no longer made (1.16.3; a tag serves the same zip,
*Release tags* below) and each carry the workflow files of their day, with `git push origin --delete <branch>`;
and tick Settings → General → **Automatically delete head branches**. Steps 1, 5 and 6 already stop what those
branches' workflows could publish; deleting them removes the rest.

**8. Code scanning and private vulnerability reporting.** Settings → **Code security** → *Code scanning* → **Set up** → **Default** →
languages *JavaScript/TypeScript* and *GitHub Actions* → **Enable CodeQL** (optional); on the same page turn on **Secret
scanning** and **Push protection**. None of these changes what SUDS ships; they report. **Not optional:** on the same
page turn on **Private vulnerability reporting**. `SECURITY.md` (1.20.0) tells reporters to use it (**Security** →
**Report a vulnerability**), and until it is on that button does not exist. Check: the repository's Security tab shows
*Report a vulnerability* to a signed-in account that is not a collaborator. Then confirm the response targets
`SECURITY.md` marks `[owner to confirm]`.

**9. The weekly settings check, and the token that lets it read everything (1.17.0).**
`.github/workflows/settings-check.yml` runs every Monday (and on *Run workflow*) and runs
`scripts/repo-settings-check.js`, which reads steps 1 to 7 and this step's environment through the REST API, only with
GET requests, and fails the run when a setting it read is **off**; the run summary has one row per setting (step,
setting, state, detail). A setting it **cannot verify** fails the run once `SETTINGS_READ_TOKEN` exists; until then
(the run has only the workflow's own token), a setting that token is refused is a **warning**, "cannot verify (add
SETTINGS_READ_TOKEN)", so the Monday run is red only for something really off, not every week until the token is
added (engineering review of the 1.17.0 candidate, M6). What it reads:

| Step | Setting | Read from | The workflow's own token |
| --- | --- | --- | --- |
| 1 | `release` environment: exists, the owner a required reviewer, *Prevent self-review* off with one reviewer, deployment refs `v*` (Tag) only | `environments/release`, `…/deployment-branch-policies` | reads it |
| 2 | `main` and `maint/*`: deletion, force pushes, pull request with code-owner review and stale approvals dismissed, the six required checks with *up to date*; only an admin creates `maint/*` | `rules/branches/main`, `rulesets`, `rulesets/<id>` (a classic rule: `branches/main/protection`) | reads it (a classic rule's details: cannot verify) |
| 3 | `v*` tag ruleset: creation, update and deletion restricted | `rulesets/<id>` | reads it |
| 4 | default token read-only, Actions cannot approve pull requests, only GitHub's actions, SHA pinning where offered | `actions/permissions`, `…/selected-actions`, `…/workflow` | **cannot verify** |
| 5 | immutable releases | `immutable-releases`; else the newest release's `immutable` | cannot verify, unless the newest release is marked immutable |
| 6 | `gh-pages` ruleset; one deploy key with write access; `PAGES_PUBLISH_KEY` in `release`, no `PAGES_DEPLOY_KEY`, neither as a repository secret | `rules/branches/gh-pages`, `keys`, `environments/release/secrets`, `actions/secrets` | the ruleset; the rest **cannot verify** |
| 7 | no `release/v*` branch left; *Automatically delete head branches* | `git/matching-refs/heads/release/v`, the repository | the branches; the setting **cannot verify** |
| 9 | the `settings-check` environment: deployments from `main` only (branch rule `main`, nothing else) | `environments/settings-check`, `…/deployment-branch-policies` | reads it; open to other branches is a warning without the token, **off** with it |

**Cannot verify is not a pass**: with only the workflow's token the rows marked above are warnings, which say what
the check could not see; they are not settings shown to be on. To let it read them, make a token that can read and
nothing more, and put it where only `main`'s copy of the workflow can read it, **in this order**:
1. **Create the environment**: Settings → **Environments** → **New environment** → `settings-check`. (The
   workflow's `environment: settings-check` makes it on its first run, **open to every branch**; if it is already
   listed, open it.) No reviewers: it runs on a schedule.
2. **Limit it to `main`, before any secret is in it**: **Deployment branches and tags** → *Selected branches and
   tags* → add `main` (Ref type: Branch), and nothing else → Save. Only the default branch's copy of the workflow
   then receives the token, never a branch's edited copy. The check reads this rule (the step 9 row).
3. **Make the token**: GitHub → your profile → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**: name `suds settings check`, an expiry (at most a year; the check
   reports an expired token as "refused (401)"), **Repository access** → *Only select repositories* →
   `taugustincst/suds`; **Repository permissions**, each **Read-only**: *Administration*, *Secrets*, *Environments*,
   *Actions* (*Metadata* is added by itself). Nothing with write. **Generate token** and copy it.
4. **Then add the secret**: the `settings-check` environment → **Environment secrets** → **Add environment secret**:
   `SETTINGS_READ_TOKEN`, the token → Add. Never as a repository secret.
5. Check: Actions → *Repository settings* → **Run workflow** on `main`; the summary says "with the
   SETTINGS_READ_TOKEN token", no row says "warning", and only settings that are really off are red. From now on a
   setting it cannot verify fails the run, and so does the environment if it is ever opened to another branch.

What no read-only token can see: a ruleset's **bypass list**, which GitHub shows only to a token that may edit the
ruleset. Those rows read "check by hand" and do not fail the run; look at them in Settings → Rules → Rulesets (step
2: empty; step 3 and `maint/*` creation: *Repository admin* only; step 6: *Deploy keys*). The check does not look at
code scanning (step 8), the collaborators with write access, or who can edit Releases (*A GitHub Release made by
someone else*). Tested with saved API responses in `test/repo-settings-check.test.js`.

### Migration numbering across branches
A migration's position in `server/db.js`'s `migrations` array is the schema version a database records, so
two branches that each append "migration 49" and are merged in the wrong order would leave a county that ran
one branch's build skipping the other's migration forever. Since 1.16.0:

* **Convention** (comment above the array): every entry is headed `// N: what it does`, N its position from 1;
  a new one goes at the end with the next number; when a branch meets another's migration of the same number it
  renumbers its own (migrations are written self-contained and idempotent so they can be).
* **Check**: `scripts/migration-order.js`, run by `test/migration-order.test.js` in `npm test`, compares the
  array with the previous release tag's: every released migration must still be at its position with the same
  code (comments and whitespace aside), none removed, and every header must carry its position. A moved,
  edited or removed released migration, or two `// 49:` headers, fails CI. The `test` job fetches the release
  tags for it and sets `SUDS_REQUIRE_RELEASE_TAGS`, so it cannot skip there; a checkout without tags skips it.
  By hand: `node scripts/migration-order.js [--previous v1.15.3]`. Every tag from 1.6.1 to 1.15.3 passes.
  ([ADR-0007](architecture/ADR-0007-migrations.md))
* **What a released migration runs and reads** (1.17.0; engineering review of 1.16.0, M6). A released
  migration's text can stay the same while what it does changes: it runs helpers (`addColumn`, `encryptColumn`,
  `rebuildTable`, `migrateSupplies`, `createIndexesFromSchema`, and functions it requires, such as `crypto.decrypt`)
  and reads **today's** `schema.sql` (`rebuildTable` and the table-creating migrations take a table's definition
  from the file). The same check fingerprints, for every migration of the previous release tag, each helper it runs
  (by name, through the helpers they call, in `server/db.js` and in the modules it requires by relative path) and,
  when it reads `schema.sql`, each table it names there (outside its own SQL) with the indexes and triggers on them.
  One that changed fails CI, naming it, the migrations that depend on it and its new fingerprint; if the change is
  safe (the upgrade fixtures of `test/migrations.test.js` pass; the table change is additive; the helper is still
  idempotent), acknowledge it in `DEPENDENCY_CHANGES` in `scripts/migration-order.js`, a code-owned file, with that
  fingerprint and the reason. Heuristic by design: it finds dependencies by name and does not follow a dynamic
  require or a helper passed as a value. Run over history it finds 1.13.0's change to `namePhoneticIndex` (migrations 6 and 26) and to five tables that migrations 5,
  7, 31 and 34 build from `schema.sql`, and 1.14.0's change to `encryptColumn` (migrations 5 to 43) and removal of
  `supply_stock`, which migration 20 still reads; 1.14.1 to 1.16.2 change nothing it watches.

### Release QA: check the version on screen
Every QA pass starts by confirming what is being tested. On the pilot server after deploy, and on the GitHub Pages site after the web-app workflow finishes (its run summary names the version it published), check that the version SUDS shows on screen is the one being released. A stale service worker or an unfinished deploy otherwise gets signed off as the new release.

### Staged rollout
Pilot group first; everyone else a week later, if the pilot reports nothing blocking. The cadence, and what "blocking" means, are in [ADOPTION.md](ADOPTION.md#3-staged-release-cadence).

## Release tags (works without GitHub Actions)
Every release is a tag `v<version>` at the released commit. GitHub serves a zip of any tag at
`https://github.com/taugustincst/suds/archive/refs/tags/v<version>.zip`, and `git clone --branch v<version> …` checks it out.
Until 1.16.2 each release also had a branch `release/v<version>`; none is made since 1.16.3 (a branch can be moved,
a protected tag cannot, and each old branch carries the workflow files of its day). Those that exist can be deleted
(*Owner: repository settings*, step 7).

### Tags without a GitHub Release

Every release tag up to `v1.25.0` is on origin, but these 13 have **no GitHub Release** (checked 2026-10-08
against the Releases and tags lists): `v1.17.0`, `v1.17.1`, `v1.18.0`, `v1.19.0`, `v1.20.0`, `v1.21.0`, `v1.22.0`,
`v1.23.0`, `v1.23.1`, `v1.23.3`, `v1.23.4`, `v1.23.5` and `v1.24.0`.

- **Why.** The tags were pushed on 2026-10-05 and each one's `release.yml` was started by hand
  (`workflow_dispatch`) that evening. None of those runs reached the `release` job. `v1.24.0`'s gate refused it:
  CI on its exact commit (`d2fd1725`, run 37095105535) was red, and the gate step "CI passed for this exact commit"
  failed (run 37366113296). The other twelve runs were cancelled before anything was built: eight gates were
  cancelled while still queued, and for `v1.20.0`, `v1.23.0`, `v1.23.1` and `v1.23.3` the gate passed and the
  `verify` job was cancelled.
  They are not re-run with overrides: each version was superseded by a later release that has one (1.23.2, 1.23.6,
  1.24.1, 1.24.4 and 1.25.0), and a Release created now would carry today's date for a version nobody should install.
- **Their zips can still be rebuilt from the tag**, byte for byte what the release job would have published
  (`git archive` is reproducible; *Cutting a release*, "The zip's SHA-256 in two places"):

  ```bash
  git fetch origin tag vX.Y.Z
  git archive --format=zip --prefix=suds-vX.Y.Z/ -o suds-vX.Y.Z.zip vX.Y.Z && sha256sum suds-vX.Y.Z.zip
  ```

  Each result equals the SHA-256 recorded for that tag in [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)
  (all 13 rechecked on 2026-10-08).
- **`v1.24.2` is mis-stamped and superseded.** Its tag holds `package.json` 1.24.2, but `SUDS_VERSION`,
  `public/version.json` and the service-worker stamp at 1.24.1 and a stale kernel. It stays as it is (a pushed tag is
  never moved); it has no Release and never will. 1.24.3 superseded it, and 1.24.4 superseded 1.24.3 (whose tag has
  no Release either, on purpose).

## How users get it
- **Download:** the zip from the Releases page — unzip, then start the server (see `docs/INSTALL.md`; as a service per `docs/DEPLOYMENT.md`).
- **Git:** `git clone https://github.com/taugustincst/suds.git` then `git checkout v1.0.1`. Upgrade with `git pull` (keep the `data/` folder).
- **Docker:** `docker compose up -d`.

## Updating the kernel's build tools (esbuild, sql.js)
Dependabot ignores `esbuild` and `sql.js`: both change the committed browser kernel (`public/local/`), and CI fails any change that does not also rebuild and commit it. Update them by hand, on a branch:

```bash
npm install --save-dev esbuild@<version>     # or sql.js@<version>
npm run build:local                          # regenerates public/local/kernel.js, sql-wasm.wasm and the .gz/.br copies
npm test && scripts/ui/run-all.sh            # local mode, sync and the static build run the new kernel
git add package.json package-lock.json public/local && git commit -m "Update esbuild to <version>"
```

The remaining kernel libraries (`@noble/*`, `fflate`, `buffer`) come as one grouped monthly Dependabot PR; check it out, run `npm run build:local`, and push the rebuilt kernel to that PR's branch so CI's drift check passes.

## The Windows server zip

By owner decision of 2026-10-03 (PLATFORM.md), each release also carries `suds-<version>-windows-x64.zip` and its
`.sha256` ([WINDOWS-SERVER.md](WINDOWS-SERVER.md)). It is built only in CI, by `scripts/build-windows.js`:

* **On every push**, `ci.yml`'s `windows-exe` job (windows-2025) builds it unsigned, unzips it and runs
  `scripts/windows/smoke-test.ps1`: `suds version`, `suds try` with a sample sign-in, `suds status --json`, the
  Windows service (install, start, health, a clean stop checked in the log and the instance lock, restart,
  uninstall) and `suds logs`. The zip is the run's artifact **`suds-windows-x64`** (kept 30 days): open the run
  in Actions and download it under *Artifacts*. The job is not advisory, and it is **not** in the release gate's
  `REQUIRED_JOBS` (the release builds its own zip).
* **On a release**, `release.yml`'s `windows-exe` job builds and stages it from the gated commit (read-only token,
  no secret). Then `windows-sign` signs `suds.exe` and `suds-service.exe` if the certificate secrets exist, zips the
  folder (`--pack`) and hands it on. The `release` job checks the two files against their checksum and attaches
  them with the source zip in one `gh release create`. `scripts/release-existing.js` accepts the Windows pair on an
  existing release only in a pair, and only byte for byte the one this run built. An unsigned build is
  reproducible; a signed one is not, so a re-run after the signed Windows files were attached is refused with the
  usual recovery.

**The pinned inputs** are in `ci.yml`'s `windows-exe` env, and the same values are in `release.yml`'s
`windows-exe` (`test/workflow-yaml.test.js` checks they agree). `scripts/build-windows.js` reads them from `ci.yml`
and stops on any mismatch:

| Pin | What | How to bump |
| --- | --- | --- |
| `NODE22_WIN_SHA256` (both Windows jobs, and `windows-sign`) | `node-<NODE22_VERSION>-win-x64.zip` | With Node 22: the `win-x64.zip` line of the signed `SHASUMS256.txt.asc` (below) |
| `WINSW_VERSION`, `WINSW_SHA256` | `WinSW-x64.exe` of that WinSW release (v2.12.0) | Read the release notes. Then `curl -fsSLO https://github.com/winsw/winsw/releases/download/<v>/WinSW-x64.exe && sha256sum WinSW-x64.exe` |
| `POSTJECT_VERSION`, `POSTJECT_INTEGRITY` | postject's npm tarball (1.0.0-alpha.6), a build tool only | `npm view postject@<v> dist.integrity` (the registry's SHA-512). Check that `package/dist/api.js` still needs only Node built-ins |

Change a pin in `ci.yml` and `release.yml` in one commit. The windows-exe job's run is the test. The SBOM
(`scripts/sbom.js`) picks the pins up from `ci.yml`.

### Signing the Windows server

Without a certificate the zip is published unsigned, with a notice in the run, and SmartScreen warns county IT. To
sign it, the owner adds two **repository secrets** (Settings → Secrets and variables → Actions → New repository
secret):

* `WINDOWS_CERT_PFX_BASE64`: the code-signing certificate and its private key as a `.pfx`, base64-encoded
  (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('suds-signing.pfx')) | Set-Clipboard`).
* `WINDOWS_CERT_PASSWORD`: the `.pfx` password.

Use an OV or EV code-signing certificate issued to the publisher. An EV certificate on a hardware token or a cloud
HSM cannot be exported to a `.pfx`: then signing needs that provider's signing tool in `windows-sign` instead. Only
the signing step of `windows-sign` receives the secrets. It runs `signtool sign /fd SHA256 /tr
http://timestamp.digicert.com /td SHA256` and `signtool verify /pa`, and deletes the `.pfx` afterwards. CI builds
on push are never signed.

## Runner images
Every job names its runner image: `runs-on: ubuntu-24.04` for the Linux jobs and `windows-2025` for the Windows ones
(1.25.5; evaluation of 1.25.4, H6), never `ubuntu-latest` or `windows-latest`, which GitHub moves to a new release on
its own schedule (`ubuntu-latest` becomes Ubuntu 26.04 from 2026-10-19). **Owner decision of 2026-10-10: SUDS stays on
Ubuntu 24.04**, the release SUDS Server's installer supports and the `evening` job's libfaketime and the browser
suite's dependencies are tested on. A move to 26.04 is its own planned change, tested first: a job on `ubuntu-26.04`
beside the 24.04 ones, the installer and docs/SELF-HOSTING.md updated, then the labels changed in one commit.
`test/workflow-yaml.test.js` refuses a `-latest` label in any workflow.

## Bumping the pinned Node versions
Every CI job installs an exact Node release checked against a SHA-256 written in the workflow, not whatever
`latest-v24.x` is that day, nor whatever Node 22 the runner image carries: the `node24` job
(`NODE24_VERSION`, `NODE24_SHA256` in `ci.yml`), and since 1.14.0 every Node 22 job — `test`, `thorough`,
`browser`, `dr-drill`, and the release workflow's `verify` job that tests a release (`NODE22_VERSION`,
`NODE22_SHA256` at the top of `ci.yml` and of `release.yml`, the same in both). Until 1.14.0 the Node 22 jobs
checked only the major against `.nvmrc`, so the Node a push was tested on could change without a commit.
Dependabot cannot see a version in a workflow's `env`, so bump them by hand — monthly with the grouped
Dependabot PR, and at once for a Node security release (nodejs.org/en/blog/vulnerability):

```bash
v=v24.x.y                                                     # or v22.x.y: the newest of that line on https://nodejs.org/dist/
curl -fsSLO https://nodejs.org/dist/$v/SHASUMS256.txt.asc     # clearsigned: the checksums and their signature
gpg --verify SHASUMS256.txt.asc                               # release keys: github.com/nodejs/release-keys
grep ' node-'$v'-linux-x64.tar.xz$' SHASUMS256.txt.asc        # the hash for NODE24_SHA256 / NODE22_SHA256
grep ' node-'$v'-win-x64.zip$' SHASUMS256.txt.asc             # Node 22 only: NODE22_WIN_SHA256 (ci.yml, windows job)
```

From 1.24.0 the `windows` job in `ci.yml` installs the same Node 22 release for Windows, checked against
`NODE22_WIN_SHA256` in that job: bump it in the same commit as `NODE22_VERSION`, or that job fails on the hash. The
same value is in `ci.yml`'s `windows-exe` job and `release.yml`'s `windows-exe` and `windows-sign` jobs (the Windows
server zip's `suds.exe` is that `node.exe`); change all of them together.

Change the two lines in one commit ("CI: Node 24 → $v"; for Node 22 in `ci.yml`, `release.yml` and `deploy/linux/pins` together — SUDS Server installs that exact release, and `test/deploy-linux.test.js` fails if the three differ);
`test/release-gate.test.js` checks their shape, that the two workflows agree, and that Node 22's major is
`.nvmrc`'s. 1.14.0 pinned v22.23.3 (released 2026-09-23; its `SHASUMS256.txt.asc` verified against the
releaser's key from github.com/nodejs/release-keys).

## Upgrading an existing install
1. Download an encrypted backup (Settings → System & backups).
2. Replace the SUDS folder with the new version (or `git pull`) but keep `data/`.
3. Start SUDS; migrations run automatically.
