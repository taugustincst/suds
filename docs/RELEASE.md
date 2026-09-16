# Releasing SUDS

## Production readiness checklist (per release)
- [ ] `npm test` passes and the browser smoke tests (`scripts/ui-smoke.mjs`, `scripts/setup-smoke.mjs`) run clean
- [ ] `CHANGELOG.md` has a section for the version, `package.json` version matches
- [ ] Docs updated (`README.md`, `docs/INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/HIPAA.md`)
- [ ] No secrets, databases or `data/` contents in the tree (`git status`, `.gitignore`)
- [ ] Upgrade path: schema migrations in `server/db.js` run on start; take a backup before upgrading

## Cutting a release
```bash
git checkout main && git pull
npm version 1.0.1 --no-git-tag-version   # bump, then add the CHANGELOG entry
git commit -am "Release 1.0.1" && git push
git tag v1.0.1 && git push origin v1.0.1
```
Pushing the tag runs `.github/workflows/release.yml` (it can also be started from the Actions tab with *Run workflow* → type `release`; it then creates the tag itself), which re-runs the tests, packages `suds-v1.0.1.zip` (`git archive`, so no local data can leak) and publishes a GitHub Release with the zip attached.

## Release branches (works without GitHub Actions)
Every release also has a branch `release/v<version>` pointing at the released commit. GitHub serves a zip of any branch at
`https://github.com/taugustincst/suds/archive/refs/heads/release/v<version>.zip`, and `git clone --branch release/v<version> …` checks it out.
Create it with `git branch release/v1.0.1 main && git push origin release/v1.0.1`.

> Note: as of 1.0.0 every GitHub Actions run in this repository fails within seconds before any step executes, which indicates Actions is not enabled or has no minutes for the account (Settings → Actions, and Billing). Until that is resolved the tag/Release publishing step must be done by hand: `git tag v1.0.0 && git push origin v1.0.0`, then create the Release on GitHub and attach the zip from `npm run package`.

## How users get it
- **Download:** the zip from the Releases page — unzip, then double-click a file in `launchers/` (see `docs/INSTALL.md`).
- **Git:** `git clone https://github.com/taugustincst/suds.git` then `git checkout v1.0.1`. Upgrade with `git pull` (keep the `data/` folder).
- **Docker:** `docker compose up -d`.

## Upgrading an existing install
1. Download an encrypted backup (Settings → System & backups).
2. Replace the SUDS folder with the new version (or `git pull`) but keep `data/`.
3. Start SUDS; migrations run automatically.
