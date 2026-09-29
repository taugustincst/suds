# Releasing SUDS

## Production readiness checklist (per release)
- [ ] CI is green for the exact commit being released: `npm test`, the browser suite (`scripts/ui/run-all.sh`, 44 scripts including the first-run wizard, local mode, sync, device encryption and recovery, the static build, accessibility and the QA-regression script `a11y-round4`), Node 24 and the recovery drill. The release workflow enforces this (see *Release gate* below); the box is here so nobody tags a commit they have not seen pass
- [ ] `CHANGELOG.md` has a section for the version, `package.json` version matches
- [ ] Docs updated (`README.md`, `docs/INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/HIPAA.md`)
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
| **The latest minor** (today 1.16.x) | Every fix: defects and security, as patch releases on that line | Until the next minor is released |
| **The previous minor** (today 1.15.x) | **Security fixes only**, as a patch on that line, where the fix applies to it | **30 days** after the next minor's release date, then none |
| Anything older | Nothing: upgrade to the latest minor ([Upgrading an existing install](#upgrading-an-existing-install)) | — |

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
**The CHANGELOG date is the stamp's date; the release date is the tag's.** A section is dated when its version is
stamped, and the version is released only when the owner pushes its tag (the GitHub Release and the tag carry that
date); until then the section describes a prepared release, not a published one.

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
Pushing the tag runs `.github/workflows/release.yml`, which first passes the release gate (below), then re-runs the tests in the `verify` job (read-only token, no environment), and, after the owner's approval, the `release` job packages `suds-v1.0.1.zip` (`git archive`, so no local data can leak) and publishes a GitHub Release for the tag with the zip attached. Since 1.16.4 (engineering review of 1.16.3, M5) the `release` job is the only one with a write token and runs no npm and none of the released commit's code: `npm ci` and `npm test` ran in `verify`, where a dependency could once reach the packaging step through `$GITHUB_ENV`, `$GITHUB_PATH` or a replaced `git`, `sha256sum` or `gh`. As its last step it starts the web-app (GitHub Pages) workflow for the tag (`gh workflow run web-app.yml --ref v1.0.1`): a release created with `GITHUB_TOKEN` does not trigger other workflows by itself. That dispatch is the web-app workflow's only trigger (since 1.16.1 a tag push or a `release` event no longer starts it): it runs only on a `v*` tag whose GitHub Release exists at that commit, and its `publish` job waits in the `release` environment, so the owner approves it too. The on-device web app is published on releases only — never on a push to `main` — so what is on the public URL is always a released version ([WEB_APP.md](WEB_APP.md#when-it-is-published)). No workflow uses a marketplace action; the only actions used are GitHub's own `actions/upload-artifact` and `actions/download-artifact`, pinned to a commit, in `web-app.yml` (they run under the Actions policy *Allow actions created by GitHub*).

### Release gate
QA catches bugs; the gate stops them shipping. The `gate` job in `release.yml` runs `scripts/release-gate.js` for the commit being released (`GITHUB_SHA`) before anything is built. It asks the GitHub API (with the workflow's own token — no marketplace action) for the runs of `ci.yml` on that exact commit, counts only `push` runs (a `pull_request` run tests a merge commit, not this one), and passes only when one of them **concluded success with the `test`, `thorough`, `thorough-sdc`, `browser`, `node24` and `dr-drill` jobs all successful** (with `SUDS_THOROUGH=1`, `thorough-sdc` runs the publication-release disclosure sweeps at full size — `npm test` runs a sample — and `thorough` the performance checks in `test/thorough/` and the other timing budgets, which `npm test` leaves out so a busy runner cannot flake it; `npm run test:thorough` runs both, `node scripts/test-thorough.js --part sdc|rest` either. Until 1.16.0 they were one job that took about 25 of its 30 minutes; the sweeps now have their own, with a 60-minute limit — measured alone on the development container they take about 27 minutes, everything else 17 seconds):

| CI job | What it proves |
| --- | --- |
| `test` | `npm test`, the committed kernel and generated schema match their sources, the package builds, browser modules parse |
| `browser` | the whole browser suite, `scripts/ui/run-all.sh` — 44 scripts, including `accessibility` (fails on any WCAG 2.1 AA finding) and the QA-regression script `a11y-round4` |
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
  commit with green CI used to release),
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
* Proposed, not done: a scheduled job that fails when `gh api repos/:owner/:repo/environments/release` has no
  required reviewer or `…/branches/main/protection` is missing, so the settings above are checked, not assumed.

**Backports: there is no maintenance line today** (engineering review of 1.16.1, M3). A release must be on `main`,
and a patch release is measured against the tag below it: once 1.17.0 is on `main`, a 1.16.3 cut from `main` would
carry 1.17's features and be refused as a patch, and a commit on a branch off `v1.16.2` is refused as "not on
main". So *Supported versions* above cannot be met by a release on the previous minor's line: until the path below
exists, a security fix for 1.16.x ships as a patch of the latest minor, and the previous minor's 30 days of security
fixes are a promise the release machinery cannot yet keep. Proposed (not implemented; a change to the gate, so it
lands through code-owner review and takes effect as described above):

1. A maintenance branch per minor, `maint/1.16` (not `release/v*`, which names one release each), created from the
   minor's last tag when the next minor ships, protected like `main` (a ruleset: pull request, code-owner review,
   the same required CI jobs, no force push or deletion), and listed in the `release` environment's deployment
   branches.
2. `release-policy.js --sha` accepts a commit on `origin/maint/X.Y` in place of `main` **only** when the version
   being released is `X.Y.z` and `X.Y` is older than `main`'s minor; the patch rules and the size limit apply
   unchanged against the previous `vX.Y.*` tag (`previousTag` already picks it).
3. The gate job fetches `refs/heads/maint/*` beside `main`, and still runs `main`'s copy of the scripts.
4. Fixes are made on `main` first and cherry-picked to `maint/X.Y`, each cherry-pick's pull request naming the
   commit on `main`.

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
  `scripts/test-thorough.js`, `scripts/package.js`, their tests, this file) and for
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

**8. Code scanning (optional).** Settings → **Code security** → *Code scanning* → **Set up** → **Default** →
languages *JavaScript/TypeScript* and *GitHub Actions* → **Enable CodeQL**; on the same page turn on **Secret
scanning** and **Push protection**. None of these changes what SUDS ships; they report.

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

Change the two lines in one commit ("CI: Node 24 → $v"; for Node 22 in `ci.yml` and `release.yml` together);
`test/release-gate.test.js` checks their shape, that the two workflows agree, and that Node 22's major is
`.nvmrc`'s. 1.14.0 pinned v22.23.3 (released 2026-09-23; its `SHASUMS256.txt.asc` verified against the
releaser's key from github.com/nodejs/release-keys).

## Upgrading an existing install
1. Download an encrypted backup (Settings → System & backups).
2. Replace the SUDS folder with the new version (or `git pull`) but keep `data/`.
3. Start SUDS; migrations run automatically.
