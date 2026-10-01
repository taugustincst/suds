# Secure development lifecycle

## Change control

* Source in a Git repository; every change is a commit with an author. Contributor and AI-assistant rules are in `CLAUDE.md` (PHI only in `_enc` columns, every PHI access audited, disclosures through `server/disclosure.js`, schema changes with migrations, tests for every new route and permission).
* **How the code is written.** SUDS is developed with an AI coding assistant: of the 808 commits in the history of 1.23.0 up to its documentation pass (`b403d83`, the last commit before the documentation pass and the stamp), 789 were written with the assistant: 776 are authored by it and 13 (squash-merged pull requests authored by the owner) name it as co-author; the other 19 are the owner's (merge commits, the initial commit and five squash-merged pull requests with no trailer). The method and the breakdown are in [QUESTIONNAIRE.md](QUESTIONNAIRE.md) #36a. The owner sets direction and the rules in `CLAUDE.md`, and reviews and merges the work; automated gates (the test suites and CI jobs below, and the drift checks) are required to pass. There is **no second human reviewer** today, and no independent code review has been done. The reasoning behind the hardest parts is written down in `../architecture/` (decision records with the files to read and the tests that pin each one).
* **Review.** `../ADOPTION.md` requires a named code owner and review of every change by someone other than its author, with the release branch protected (pull requests only, one approval, CI green). `.github/CODEOWNERS` names the owner for the release machinery and the modules that decide access and disclosure. Branch protection, the `v*` tag ruleset and the `release` environment's reviewer are repository settings only the owner can turn on ([../RELEASE.md](../RELEASE.md), *Owner: repository settings*); **none is in force yet** (owner item), and files in the repository cannot enforce them.
* The county deploys **tagged releases**, never a branch.

## Testing (every push and pull request — `.github/workflows/ci.yml`)

| Job | What it runs |
| --- | --- |
| `test` | Node version check against `.nvmrc`; `npm ci`; `npm test` (node:test API and unit suites — several hundred tests, including RBAC, caseload scoping, audit chain and anchors, backups, restore, recovery drill, key rotation, migrations from a real 1.6.1 database, sync consistency); the local kernel and generated schema must match their sources; packaging; syntax check of every browser module |
| `browser` | The Playwright browser regression suite against a seeded server (`scripts/ui/run-all.sh`), including the setup wizard, local mode, sync, the static build and the admin Security status page and recovery drill |
| `node24` | `npm test` on the next Node LTS |
| `thorough` | The performance checks and timing budgets at full size |
| `thorough-sdc` | The statistical-disclosure-control attacker sweeps at full size (publication releases) |
| `dr-drill` | Backup and restore end to end: seed, encrypted backup, recovery drill with an escrowed key file, host restore, audit chain, signed report verified |
| `webkit` (advisory) | A WebKit smoke subset |

The release gate requires `test`, `thorough`, `thorough-sdc`, `browser`, `node24` and `dr-drill` to have passed on the exact commit released (`scripts/release-gate.js` `REQUIRED_JOBS`). CI runs with a read-only token and installs every Node release against a SHA-256 pinned in the workflow.

Security-relevant properties have dedicated tests, for example: `test/security-evidence.test.js` (anchors, audit export, recovery drill, SSO-required, MFA-for-all, Security status), `test/rotate-index-key.test.js`, `test/backup.test.js`, `test/migrations.test.js`, `test/sync.test.js` (every `_enc` column declared for sync), `test/security-1154.test.js` to `test/security-1164.test.js` (each security review's findings), `test/data-inventory.test.js` (the data inventory matches the schema) and `test/sbom.test.js` (the committed SBOM matches the script). The threat model lists them by attack class ([THREAT-MODEL.md](THREAT-MODEL.md)).

## Release

`.github/workflows/release.yml` runs when the owner pushes a `v*` tag at the version-stamp commit on `main`. The `gate` job checks CI on that exact commit and the release policy, and refuses a GitHub Release someone else made for the tag. The `verify` job re-runs the tests with a read-only token. After the owner approves the `release` environment, the `release` job, the only one with a write token, which runs no npm, builds the zip with `git archive` (so nothing untracked, no data and no keys, can enter it), writes `suds-v<version>.zip.sha256` and publishes both. Installers compare the checksum before unpacking (`../DEPLOYMENT.md`). The per-release checklist is `../RELEASE.md`; rollout is staged (pilot group first; `../ADOPTION.md`). The approval step and the tag rules take effect only once the owner turns on the repository settings (above).

**Software bill of materials.** `node scripts/sbom.js --ref v<version> --out docs/evidence/sbom-<version>.cdx.json` writes a CycloneDX SBOM of the tagged tree (no npm package needed); the one for the newest stamped minor is committed (`test/doc-currency.test.js` fails when it falls behind), with the earlier ones kept as history ([../evidence/README.md](../evidence/README.md)).

**Integrity of releases.** The SHA-256 checksum is published beside the zip on the same GitHub release, so on its own it protects against corruption and mirrors, not against a compromised repository account; the owner also records it in the release notes and in the CHANGELOG on `main`, a second channel SUDS Server's installer requires (`--release-sha256`; ../SELF-HOSTING.md, *Upgrading*). Releases are not currently signed (no GPG/Sigstore signature, no SLSA provenance). What exists instead: `git archive` builds are reproducible, so anyone can rebuild a release zip from its tag and compare the bytes (a zip built on the development container matched the SHA-256 published for v1.15.4 and v1.16.2 by the release workflow; the expected checksums of the untagged releases are in [../evidence/RELEASE-HANDOFF.md](../evidence/RELEASE-HANDOFF.md)), and since 1.16.4 the release job refuses a Release whose files are not byte for byte the tag's build (`scripts/release-existing.js`). Once the owner turns on immutable releases, a published zip cannot be replaced. A county that needs more can pin to a reviewed commit hash, build from source itself, or ask the maintainer to add Sigstore signing and GitHub artifact attestations to the release workflow (the recommended next step; owner item).

## Environments

Development data is fictional (`npm run seed`; "never seed production"). Production keys are never in the repository (`.gitignore` covers `data/`, `.env`, databases and backups; the release zip is built from tracked files only).
