# Releasing SUDS

## Production readiness checklist (per release)
- [ ] CI is green for the exact commit being released: `npm test`, the browser suite (`scripts/ui/run-all.sh`, 40 scripts including the first-run wizard, local mode, sync, device encryption and recovery, the static build, accessibility and the QA-regression script `a11y-round4`), Node 24 and the recovery drill. The release workflow enforces this (see *Release gate* below); the box is here so nobody tags a commit they have not seen pass
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
genuinely has to break the policy (a security fix that needs a route, say), run it from the Actions tab
(*Run workflow*) with **`policy_exception`** set to the reason. The gate then passes with a warning, and the
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

## Cutting a release
```bash
git checkout main && git pull
npm version 1.0.1 --no-git-tag-version   # bump, then add the CHANGELOG entry
git commit -am "Release 1.0.1" && git push
git tag v1.0.1 && git push origin v1.0.1
```
Pushing the tag runs `.github/workflows/release.yml` (or start it from the Actions tab with *Run workflow* → type `release`; it then creates the tag itself), which first passes the release gate (below), then re-runs the tests, packages `suds-v1.0.1.zip` (`git archive`, so no local data can leak) and publishes a GitHub Release with the zip attached. As its last step it starts the web-app (GitHub Pages) workflow for the new tag (`gh workflow run web-app.yml --ref v1.0.1`): a release created with `GITHUB_TOKEN` does not trigger other workflows by itself. That dispatch is the web-app workflow's only trigger (since 1.16.1 a tag push or a `release` event no longer starts it): it runs only on a `v*` tag whose GitHub Release exists at that commit, and in the `release` environment, so the owner approves it too. The on-device web app is published on releases only — never on a push to `main` — so what is on the public URL is always a released version ([WEB_APP.md](WEB_APP.md#when-it-is-published)). No workflow uses marketplace actions, so they run under restrictive Actions policies.

### Release gate
QA catches bugs; the gate stops them shipping. The `gate` job in `release.yml` runs `scripts/release-gate.js` for the commit being released (`GITHUB_SHA`) before anything is built. It asks the GitHub API (with the workflow's own token — no marketplace action) for the runs of `ci.yml` on that exact commit, counts only `push` runs (a `pull_request` run tests a merge commit, not this one), and passes only when one of them **concluded success with the `test`, `thorough`, `thorough-sdc`, `browser`, `node24` and `dr-drill` jobs all successful** (with `SUDS_THOROUGH=1`, `thorough-sdc` runs the publication-release disclosure sweeps at full size — `npm test` runs a sample — and `thorough` the performance checks in `test/thorough/` and the other timing budgets, which `npm test` leaves out so a busy runner cannot flake it; `npm run test:thorough` runs both, `node scripts/test-thorough.js --part sdc|rest` either. Until 1.16.0 they were one job that took about 25 of its 30 minutes; the sweeps now have their own, with a 60-minute limit — measured alone on the development container they take about 27 minutes, everything else 17 seconds):

| CI job | What it proves |
| --- | --- |
| `test` | `npm test`, the committed kernel and generated schema match their sources, the package builds, browser modules parse |
| `browser` | the whole browser suite, `scripts/ui/run-all.sh` — 40 scripts, including `accessibility` (fails on any WCAG 2.1 AA finding) and the QA-regression script `a11y-round4` |
| `node24` | `npm test` on the next Node LTS line |
| `thorough` | the performance checks (`test/thorough/`) and timing budgets, at full size |
| `thorough-sdc` | the statistical-disclosure-control attacker sweeps at full size (`scripts/test-thorough.js` `SDC_SWEEPS`) |
| `dr-drill` | backup and restore actually work: `scripts/dr-exercise.js` (seed, encrypted backup through the scheduled path, `npm run dr-drill` with an escrowed key file, host restore into a fresh data directory, row counts, audit chain, signed report verified with the public key); the signed report is printed in the job log |

`webkit` stays advisory (`continue-on-error`) and is not checked. If CI on the commit is still running (a tag pushed together with its commit) the gate waits, up to an hour (`RELEASE_GATE_WAIT_MINUTES`). A failed or missing required job fails the release with the reason; fix it (or re-run a flaky job — the latest attempt counts) and run the release again. The `release` job then checks out exactly the gated commit, so a branch that moved in the meantime cannot slip an untested commit in. The decision logic is tested in `test/release-gate.test.js`, which also fails if a required job is renamed out of `ci.yml`.

1.11.0 itself was published while its `browser` job had failed — the case this gate now refuses.

**The gate does not trust the commit it judges** (1.16.1). It checks out the commit being released, but runs
`scripts/release-gate.js` and `scripts/release-policy.js` from **`main`'s copy** (`git archive origin/main …`
into a temporary directory; `release-policy.js --root src` then reads the released tree): a commit that trimmed
`REQUIRED_JOBS` or lifted a policy limit, together with the tests that pin them, could otherwise release itself.
The release notes' exception text comes from `main`'s copy too. A change to the gate therefore takes effect for
the releases after it is merged. Whatever the `policy_exception`, the gate also refuses:

* a commit that is not on `main` (`git merge-base --is-ancestor <commit> origin/main`; a tag on a feature-branch
  commit with green CI used to release), and
* a version already tagged at another commit (`v<version>` exists and is not this commit): dispatching *Run
  workflow* on `main` after a release, with `package.json` not yet bumped, used to rebuild the zip and checksum
  from the new commit and upload them over the published ones (`--clobber`).

The release job never replaces a published file: when the GitHub Release already exists (a re-run of the same
commit's release) it uploads the zip and checksum only if neither is there, and stops with an error if only one
is. Tested in `test/release-policy.test.js` (`commitProblems`, and the workflow's shape).

### Owner control over releases
The gate proves CI passed; it does not prove the owner agreed. Anyone with write access can push a `v*` tag or
dispatch the workflow, and the checks above run with whatever the pushed commit says. Three things, prepared in
the repository since 1.16.0, put the owner in the path; **the first two only take effect once the owner turns
on the GitHub settings below** (an assistant or a workflow cannot change repository settings).

* **`environment: release`** on the `release` job in `release.yml`. The job then waits for a reviewer's
  approval, after the gate and before anything is tested, packaged or published, however it was started (a
  tag push or *Run workflow*). Since 1.16.1 the web app's `deploy` job (`web-app.yml`) runs in the same
  environment, so publishing SUDS on this device waits for the same approval (a second one, after the release).
* **`.github/CODEOWNERS`** names `@taugustincst` for the release machinery (`.github/`, `scripts/release-gate.js`,
  `scripts/release-policy.js`, `scripts/test-thorough.js`, `scripts/package.js`, their tests, this file) and for
  the modules that decide who may do what and what may leave the programme: `server/auth.js`,
  `server/permissions.js`, `server/disclosure.js`, `server/crypto.js`, `local/vault.js`.
  `test/release-gate.test.js` fails if a listed path is renamed away from its owner.
* **Who released it** is written at the foot of the GitHub Release notes: `Released by @<github.actor>
  (<event>, run <id>)`, and `re-run by @<github.triggering_actor>` when someone else re-ran it.

**What the owner must turn on (GitHub → the repository → Settings):**

1. **Environments → New environment → `release`** (or open it, once the first release has created it):
   * tick **Required reviewers** and add `taugustincst` (up to six people or teams may be listed; one approval
     releases);
   * tick **Prevent self-review**, so the person who pushed the tag or dispatched the run cannot approve it
     themselves (leave it off only while the owner is the sole releaser);
   * under **Deployment branches and tags**, choose *Selected branches and tags* and add the rules `main`
     (branch, for *Run workflow*) and `v*` (tag), so the job cannot run from any other ref.
2. **Branches → Add branch ruleset** (or *Add classic branch protection rule*) for **`main`**:
   * **Require a pull request before merging**, with **Required approvals: 1** and **Require review from Code
     Owners**; tick **Dismiss stale pull request approvals when new commits are pushed**;
   * **Require status checks to pass**, with **Require branches to be up to date before merging**, and add the
     CI jobs `test`, `thorough`, `thorough-sdc`, `browser`, `node24` and `dr-drill` (the release gate's
     `REQUIRED_JOBS`; they appear in the list once they have run on a pull request);
   * **Block force pushes** and **Restrict deletions**;
   * **Do not allow bypassing the above settings** (classic: *Include administrators*), or the owner's own
     pushes skip review — leave it off only if the owner accepts that.
3. **Tags → Add rule** (Settings → Rules → Rulesets → *New tag ruleset*) for `v*`: **Restrict creations,
   updates and deletions** to the owner (bypass list: repository admin), so nobody else can push a release tag.
4. **Actions → General → Workflow permissions**: *Read repository contents and packages permissions* as the
   default (`release.yml` asks for `contents: write` and `actions: write` itself), and leave **Allow GitHub
   Actions to create and approve pull requests** off.

Check it: push a test tag from a branch other than `main` (it must not run), then release normally and see
the run stop at *Waiting for review: release needs approval* until the owner approves it.

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

## Release branches (works without GitHub Actions)
Every release also has a branch `release/v<version>` pointing at the released commit. GitHub serves a zip of any branch at
`https://github.com/taugustincst/suds/archive/refs/heads/release/v<version>.zip`, and `git clone --branch release/v<version> …` checks it out.
Create it with `git branch release/v1.0.1 main && git push origin release/v1.0.1`.

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
`browser`, `dr-drill`, and the release job that tests and packages a release (`NODE22_VERSION`,
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
