# Releasing SUDS

## Production readiness checklist (per release)
- [ ] CI is green for the exact commit being released: `npm test`, the browser suite (`scripts/ui/run-all.sh`, 30 scripts including the first-run wizard, local mode, sync, device encryption, the static build, accessibility and the QA-regression script `a11y-round4`), Node 24 and the recovery drill. The release workflow enforces this (see *Release gate* below); the box is here so nobody tags a commit they have not seen pass
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
* a route (every `METHOD path` the route modules register, including generated CRUD routes).

A minor or major bump is not checked. When a patch release genuinely needs one of these (a security fix that
needs a route, say), run the release from the Actions tab (*Run workflow*) with **`allow_patch_changes`** set
to the reason. The gate then passes with a warning, and the release job puts the reason and the list of
exceptions at the top of the GitHub Release notes, where a county reviewing the release reads it. A tag push
cannot carry the override; an empty input is no override. Dry run before tagging:
`node scripts/release-policy.js` (compares the working tree with the latest tag). The detection logic is
tested in `test/release-policy.test.js`.

**Record: 1.12.0–1.12.4 broke this policy.** 1.12.0 came fourteen hours after the 1.11.0 feature release
(not a month), and 1.12.1–1.12.4 followed within twelve hours; 1.12.1 carried migration 41 and the route
`POST /api/auth/oidc/reauth`, 1.12.2 the permission `reports:internal` (found afterwards with
`node scripts/release-policy.js --previous-ref <commit> --next-ref <commit>`). They were security and privacy
fixes from an independent review, shipped as soon as each was ready rather than batched. The check above
exists so the next exception is an explicit, recorded decision rather than an oversight.

## Cutting a release
```bash
git checkout main && git pull
npm version 1.0.1 --no-git-tag-version   # bump, then add the CHANGELOG entry
git commit -am "Release 1.0.1" && git push
git tag v1.0.1 && git push origin v1.0.1
```
Pushing the tag runs `.github/workflows/release.yml` (or start it from the Actions tab with *Run workflow* → type `release`; it then creates the tag itself), which first passes the release gate (below), then re-runs the tests, packages `suds-v1.0.1.zip` (`git archive`, so no local data can leak) and publishes a GitHub Release with the zip attached. As its last step it starts the web-app (GitHub Pages) workflow for the new tag (`gh workflow run web-app.yml --ref v1.0.1`): a release created with `GITHUB_TOKEN` does not trigger other workflows by itself. The on-device web app is published on releases only — never on a push to `main` — so what is on the public URL is always a released version ([WEB_APP.md](WEB_APP.md#when-it-is-published)). No workflow uses marketplace actions, so they run under restrictive Actions policies.

### Release gate
QA catches bugs; the gate stops them shipping. The `gate` job in `release.yml` runs `scripts/release-gate.js` for the commit being released (`GITHUB_SHA`) before anything is built. It asks the GitHub API (with the workflow's own token — no marketplace action) for the runs of `ci.yml` on that exact commit, counts only `push` runs (a `pull_request` run tests a merge commit, not this one), and passes only when one of them **concluded success with the `test`, `thorough`, `browser`, `node24` and `dr-drill` jobs all successful** (`thorough` runs, with `SUDS_THOROUGH=1`, the publication-release disclosure sweeps at full size — `npm test` runs a sample — and the performance checks in `test/thorough/`, which `npm test` leaves out so a busy runner cannot flake it: `npm run test:thorough`):

| CI job | What it proves |
| --- | --- |
| `test` | `npm test`, the committed kernel and generated schema match their sources, the package builds, browser modules parse |
| `browser` | the whole browser suite, `scripts/ui/run-all.sh` — 30 scripts, including `accessibility` (fails on any WCAG 2.1 AA finding) and the QA-regression script `a11y-round4` |
| `node24` | `npm test` on the next Node LTS line |
| `dr-drill` | backup and restore actually work: `scripts/dr-exercise.js` (seed, encrypted backup through the scheduled path, `npm run dr-drill` with an escrowed key file, host restore into a fresh data directory, row counts, audit chain, signed report verified with the public key); the signed report is printed in the job log |

`webkit` stays advisory (`continue-on-error`) and is not checked. If CI on the commit is still running (a tag pushed together with its commit) the gate waits, up to an hour (`RELEASE_GATE_WAIT_MINUTES`). A failed or missing required job fails the release with the reason; fix it (or re-run a flaky job — the latest attempt counts) and run the release again. The `release` job then checks out exactly the gated commit, so a branch that moved in the meantime cannot slip an untested commit in. The decision logic is tested in `test/release-gate.test.js`, which also fails if a required job is renamed out of `ci.yml`.

1.11.0 itself was published while its `browser` job had failed — the case this gate now refuses.

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

## Bumping the pinned Node 24
The `node24` CI job installs an exact Node 24 release checked against a SHA-256 written in `ci.yml`
(`NODE24_VERSION`, `NODE24_SHA256`), not whatever `latest-v24.x` is that day against a checksum file from the
same server. Dependabot cannot see a version in a workflow's `env`, so bump it by hand — monthly with the
grouped Dependabot PR, and at once for a Node security release (nodejs.org/en/blog/vulnerability):

```bash
v=v24.x.y                                                     # the newest v24 on https://nodejs.org/dist/
curl -fsSLO https://nodejs.org/dist/$v/SHASUMS256.txt{,.asc}
gpg --verify SHASUMS256.txt.asc SHASUMS256.txt                # release keys: github.com/nodejs/release-keys
grep ' node-'$v'-linux-x64.tar.xz$' SHASUMS256.txt            # the hash for NODE24_SHA256
```

Change both lines in `.github/workflows/ci.yml` in one commit ("CI: Node 24 → $v"); `test/release-gate.test.js`
checks their shape. The Node 22 used by the other jobs is the runner's own, checked against `.nvmrc`'s major.

## Upgrading an existing install
1. Download an encrypted backup (Settings → System & backups).
2. Replace the SUDS folder with the new version (or `git pull`) but keep `data/`.
3. Start SUDS; migrations run automatically.
