# Secure development lifecycle

## Change control

* Source in a Git repository; every change is a commit with an author. Contributor and AI-assistant rules are in `CLAUDE.md` (PHI only in `_enc` columns, every PHI access audited, disclosures through `server/disclosure.js`, schema changes with migrations, tests for every new route and permission).
* **Review.** `../ADOPTION.md` requires a named code owner and review of every change by someone other than its author, with the release branch protected (pull requests only, one approval, CI green). Branch protection is a repository setting the county (or the maintainer) configures; it is not enforced by files in the repository.
* The county deploys **tagged releases**, never a branch.

## Testing (every push and pull request — `.github/workflows/ci.yml`)

| Job | What it runs |
| --- | --- |
| `test` | Node version check against `.nvmrc`; `npm ci`; `npm test` (node:test API and unit suites — several hundred tests, including RBAC, caseload scoping, audit chain and anchors, backups, restore, recovery drill, key rotation, migrations from a real 1.6.1 database, sync consistency); the local kernel and generated schema must match their sources; packaging; syntax check of every browser module |
| `browser` | The Playwright browser regression suite against a seeded server (`scripts/ui/run-all.sh`), including the setup wizard, local mode, sync, the static build and the admin Security status page and recovery drill |
| `node24` (advisory) | `npm test` on the next Node LTS |
| `webkit` (advisory) | A WebKit smoke subset |

Security-relevant properties have dedicated tests, for example: `test/security-evidence.test.js` (anchors, audit export, recovery drill, SSO-required, MFA-for-all, Security status), `test/rotate-index-key.test.js`, `test/backup.test.js`, `test/migrations.test.js`, `test/sync.test.js` (every `_enc` column declared for sync).

## Release

`.github/workflows/release.yml`, on a version tag: re-runs the tests, fails if the committed kernel is stale, builds the release zip with `git archive` (so nothing untracked — no data, no keys — can enter it), writes `suds-v<version>.zip.sha256` and publishes both as a GitHub Release. Installers compare the checksum before unpacking (`../DEPLOYMENT.md`). The per-release checklist is `../RELEASE.md`; rollout is staged (pilot group first; `../ADOPTION.md`).

**Integrity of releases.** The SHA-256 checksum is published beside the zip on the same GitHub release, so it protects against corruption and mirrors, not against a compromised repository account. Releases are not currently signed (no GPG/Sigstore signature, no SLSA provenance). A county that needs that assurance can: pin to a reviewed commit hash, build from source itself, or ask the maintainer to add Sigstore signing (`cosign sign-blob`) and GitHub artifact attestations to the release workflow — both are small changes and are the recommended next step.

## Environments

Development data is fictional (`npm run seed`; "never seed production"). Production keys are never in the repository (`.gitignore` covers `data/`, `.env`, databases and backups; the release zip is built from tracked files only).
