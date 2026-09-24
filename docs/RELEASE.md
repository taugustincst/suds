# Releasing SUDS

## Production readiness checklist (per release)
- [ ] `npm test` passes and the browser suite (`scripts/ui/run-all.sh`, eighteen scripts including the first-run wizard, local mode, sync and the static build) exits 0
- [ ] `CHANGELOG.md` has a section for the version, `package.json` version matches
- [ ] Docs updated (`README.md`, `docs/INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/HIPAA.md`)
- [ ] No secrets, databases or `data/` contents in the tree (`git status`, `.gitignore`)
- [ ] Upgrade path: schema migrations in `server/db.js` run on start; take a backup before upgrading
- [ ] Nothing native: no APK, launcher or mobile step is part of the release (removed in 1.9.3; docs/PLATFORM.md)
- [ ] CI's advisory jobs looked at: `node24` (npm test on Node 24) and `webkit` (WebKit smoke subset). A red advisory job is not a blocker but gets an issue
- [ ] Real-device checklist done on the release candidate (2 iPhones, 2 Androids — [ADOPTION.md](ADOPTION.md#4-real-device-release-checklist))
- [ ] **On-screen version checked**: after deploying to the pilot server, and on the demo site once it is republished, the version SUDS shows (footer / `version.json`) is the version being released

## Cutting a release
```bash
git checkout main && git pull
npm version 1.0.1 --no-git-tag-version   # bump, then add the CHANGELOG entry
git commit -am "Release 1.0.1" && git push
git tag v1.0.1 && git push origin v1.0.1
```
Pushing the tag runs `.github/workflows/release.yml` (or start it from the Actions tab with *Run workflow* → type `release`; it then creates the tag itself), which re-runs the tests, packages `suds-v1.0.1.zip` (`git archive`, so no local data can leak) and publishes a GitHub Release with the zip attached. As its last step it starts the demo-site workflow for the new tag (`gh workflow run web-app.yml --ref v1.0.1`): a release created with `GITHUB_TOKEN` does not trigger other workflows by itself. The demo is published on releases only — never on a push to `main` — so what is on the public URL is always a released version ([WEB_APP.md](WEB_APP.md#when-it-is-published)). No workflow uses marketplace actions, so they run under restrictive Actions policies.

### Release QA: check the version on screen
Every QA pass starts by confirming what is being tested. On the pilot server after deploy, and on the demo site after the web-app workflow finishes (its run summary names the version it published), check that the version SUDS shows on screen is the one being released. A stale service worker or an unfinished deploy otherwise gets signed off as the new release.

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

## Upgrading an existing install
1. Download an encrypted backup (Settings → System & backups).
2. Replace the SUDS folder with the new version (or `git pull`) but keep `data/`.
3. Start SUDS; migrations run automatically.
