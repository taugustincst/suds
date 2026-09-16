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

## How users get it
- **Download:** the zip from the Releases page — unzip, then double-click a file in `launchers/` (see `docs/INSTALL.md`).
- **Git:** `git clone https://github.com/taugustincst/suds.git` then `git checkout v1.0.1`. Upgrade with `git pull` (keep the `data/` folder).
- **Docker:** `docker compose up -d`.

## Upgrading an existing install
1. Download an encrypted backup (Settings → System & backups).
2. Replace the SUDS folder with the new version (or `git pull`) but keep `data/`.
3. Start SUDS; migrations run automatically.
