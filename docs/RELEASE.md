# Releasing SUDS

## Production readiness checklist (per release)
- [ ] CI is green for the exact commit being released: `npm test`, the browser suite (`scripts/ui/run-all.sh`, 54 scripts including the first-run wizard, local mode, sync, device encryption and recovery, the static build, accessibility and the QA-regression script `a11y-round4`), Node 24 and the recovery drill. The release workflow enforces this (see *Release gate* below); the box is here so nobody tags a commit they have not seen pass
- [ ] `CHANGELOG.md` has a section for the version, `package.json` version matches
- [ ] Docs updated (`README.md`, `docs/INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/HIPAA.md`), and the documents that name a release moved to this one: the questionnaire's *Checked against*, the evidence index's *Version.*, a new SBOM for a new minor (*Stamp checklist: the documents that name a release*, below; `test/doc-currency.test.js`)
- [ ] No secrets, databases or `data/` contents in the tree (`git status`, `.gitignore`)
- [ ] Upgrade path: schema migrations in `server/db.js` run on start; take a backup before upgrading
- [ ] Nothing native: no APK, launcher or mobile step is part of the release (removed in 1.9.3; docs/PLATFORM.md)
- [ ] CI's advisory job looked at: `webkit` (WebKit smoke subset). A red advisory job is not a blocker but gets an issue. (`node24` is a required job since the release after 1.11.0; it passed on the 1.11.0 release commit.)
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

### Supported versions

| Line | Gets | For how long |
| --- | --- | --- |
| **The latest minor** (today 1.20.x) | Every fix: defects and security, as patch releases on that line | Until the next minor is released |
| **The previous minor** (today 1.19.x, until 30 days after 1.20.0's release date: the date of its tag. `v1.20.0` is not pushed yet (*Record: 1.20.0*; [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)), so its 30 days have not started; 1.20.0 was published to GitHub Pages on 2026-09-30, and a programme should plan as if they run from then, to 2026-10-30) | **Security fixes only**, as a patch on that line, where the fix applies to it, released from its `maint/X.Y` branch (since 1.17.0: *Backports*, below; `maint/1.19` is made from `v1.19.0`'s line once the tags exist) | **30 days** after the next minor's release date, then none |
| Anything older (today 1.18.x and before: once 1.20.0 was released, 1.18.x stopped being the previous minor, whatever was left of its 30 days after 1.19.0; 1.17.x stopped when 1.19.0 was released) | Nothing: upgrade to the latest minor ([Upgrading an existing install](#upgrading-an-existing-install)) | — |

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

**Now seven tags, in one push: [evidence/RELEASE-HANDOFF.md](evidence/RELEASE-HANDOFF.md)** (1.20.0). 1.17.1, 1.18.0,
1.19.0 and 1.20.0 were published the same way, so the tags owed are `v1.16.3`, `v1.16.4`, `v1.17.0`, `v1.17.1`,
`v1.18.0`, `v1.19.0` and `v1.20.0`, pushed together while `main` says 1.20.0. The hand-off has the checks, the tag commands, the one push,
what each tag's runs do (the 1.16.x gates refuse, the other five need a *Run workflow* with `policy_exception`, and
only `v1.20.0`'s `Web app` run is approved: it republishes the build already live), and the SHA-256 each release
zip will have, rebuilt from each commit. The paragraphs below are the reasoning of 1.17.0's time, for three tags;
the rule they set, never an older tag alone, is unchanged.

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
**Version.** line, and for a new minor an SBOM of the stamp commit (`node scripts/sbom.js --ref <stamp sha> --out
docs/evidence/sbom-X.Y.Z.cdx.json`, with every link to the old one outside the evidence index moved to it; older SBOMs
stay as history). A commit cannot hold an SBOM of itself, so a new minor is two commits: `Release X.Y.Z` (the stamp,
with the links already naming the new SBOM), then `SBOM of the X.Y.Z stamp`, which adds the file and nothing else; the
second is the release commit that CI must pass, that goes to `main` and that is tagged (since 1.20.0). The rule `test/doc-currency.test.js` enforces: once `package.json`'s version X.Y.Z has a dated
CHANGELOG heading, each of the three names a version on the X.Y line, no later than X.Y.Z (a patch may keep its
minor's documents and SBOM; a new minor may not), and every SBOM link outside the evidence index names the newest
SBOM. While a version is being prepared (no date yet), the rule applies to the last stamped version. Re-read the
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
QA catches bugs; the gate stops them shipping. The `gate` job in `release.yml` runs `scripts/release-gate.js` for the commit being released (`GITHUB_SHA`) before anything is built. It asks the GitHub API (with the workflow's own token — no marketplace action) for the runs of `ci.yml` on that exact commit, counts only `push` runs (a `pull_request` run tests a merge commit, not this one), and passes only when one of them **concluded success with the `test`, `thorough`, `thorough-sdc`, `browser`, `node24` and `dr-drill` jobs all successful** (with `SUDS_THOROUGH=1`, `thorough-sdc` runs the publication-release disclosure sweeps at full size — `npm test` runs a sample — and `thorough` the performance checks in `test/thorough/` and the other timing budgets, which `npm test` leaves out so a busy runner cannot flake it; `npm run test:thorough` runs both, `node scripts/test-thorough.js --part sdc|rest` either. Until 1.16.0 they were one job that took about 25 of its 30 minutes; the sweeps now have their own, with a 60-minute limit — measured alone on the development container they take about 27 minutes, everything else 17 seconds):

| CI job | What it proves |
| --- | --- |
| `test` | `npm test`, the committed kernel and generated schema match their sources, the package builds, browser modules parse |
| `browser` | the whole browser suite, `scripts/ui/run-all.sh` — 54 scripts, including `accessibility` (fails on any WCAG 2.1 AA finding) and the QA-regression script `a11y-round4` |
| `node24` | `npm test` on the next Node LTS line |
| `thorough` | the performance checks (`test/thorough/`) and timing budgets, at full size |
| `thorough-sdc` | the statistical-disclosure-control attacker sweeps at full size (`scripts/test-thorough.js` `SDC_SWEEPS`) |
| `dr-drill` | backup and restore actually work: `scripts/dr-exercise.js` (seed, encrypted backup through the scheduled path, `npm run dr-drill` with an escrowed key file, host restore into a fresh data directory, row counts, audit chain, signed report verified with the public key); the signed report is printed in the job log |

`webkit` stays advisory (`continue-on-error`) and is not checked. If CI on the commit is still running (a tag pushed together with its commit) the gate waits, up to an hour (`RELEASE_GATE_WAIT_MINUTES`). A failed or missing required job fails the release with the reason; fix it (or re-run a flaky job — the latest attempt counts) and run the release again. The `verify` and `release` jobs then check out exactly the gated commit, so a branch that moved in the meantime cannot slip an untested commit in. The decision logic is tested in `test/release-gate.test.js`, which also fails if a required job is renamed out of `ci.yml`.

1.11.0 itself was published while its `browser` job had failed — the case this gate now refuses.

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
* it may carry only `suds-vX.Y.Z.zip` and `suds-vX.Y.Z.zip.sha256`, both or neither; and
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
  `thorough`, `thorough-sdc`, `browser`, `node24` and `dr-drill` (the release gate's `REQUIRED_JOBS`; they are
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
```

Change the two lines in one commit ("CI: Node 24 → $v"; for Node 22 in `ci.yml`, `release.yml` and `deploy/linux/pins` together — SUDS Server installs that exact release, and `test/deploy-linux.test.js` fails if the three differ);
`test/release-gate.test.js` checks their shape, that the two workflows agree, and that Node 22's major is
`.nvmrc`'s. 1.14.0 pinned v22.23.3 (released 2026-09-23; its `SHASUMS256.txt.asc` verified against the
releaser's key from github.com/nodejs/release-keys).

## Upgrading an existing install
1. Download an encrypted backup (Settings → System & backups).
2. Replace the SUDS folder with the new version (or `git pull`) but keep `data/`.
3. Start SUDS; migrations run automatically.
