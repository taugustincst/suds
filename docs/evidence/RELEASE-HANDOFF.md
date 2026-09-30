# Release hand-off: tags v1.16.3 to v1.20.0

Seven versions are on `main` and released (1.20.0 is what GitHub Pages serves) but **none is tagged**: 1.16.3 and
1.16.4 went out with 1.17.0, and 1.16.4 to 1.20.0 were published to GitHub Pages by a direct push to `gh-pages` at
the owner's request, with no tag, no GitHub Release and no approval in the `release` environment
([../RELEASE.md](../RELEASE.md), the *Record* entries and the exceptions table). Until the tags exist, everything
that measures from "the previous release" measures from `v1.16.2`: the release policy, `scripts/migration-order.js`,
*Backports* step B, and SUDS Server upgrades, which download `suds-vX.Y.Z.zip` from a GitHub Release that does not
exist yet (`deploy/linux/lib.sh` `stage_release`).

This page is the hand-off: the checks, the tag commands, **one push**, what each tag's workflow runs will do and what
to approve, and the SHA-256 of each release zip, which the owner publishes in two places so an operator can check a
download against a channel other than the download (`upgrade.sh --release-sha256`; [../SELF-HOSTING.md](../SELF-HOSTING.md),
*Upgrading*). The assistant cannot push tags (*Handing a release to the owner*); only the owner runs these, from any
clone of their own.

Prepared on branch `docs/1191-stamp-pass` from `3dc20dc`, 30 September 2026, and carried into 1.20.0. The 1.20.0
row is filled in by the commit after its stamp: a commit cannot hold its own hash, nor the checksum of a zip built from it.

## The seven releases

| Tag | Commit (stamp, "Release X.Y.Z") | CHANGELOG date | `suds-vX.Y.Z.zip` SHA-256 (rebuilt from the commit, as `release.yml` builds it) |
| --- | --- | --- | --- |
| `v1.16.3` | `fc5e9d7fc42af0da8ce2032462ef3c7860e2f576` | 2026-09-29 | `366908af8f79b871c64aa72cf4499c6c458606ebc4140e243a5c705a9862d882` |
| `v1.16.4` | `6491308ff4c0eb89451e2717e89fc11ca5a9c4a1` | 2026-09-29 | `a38cef2fba281af0fc3578899a730357e84ac870694d5c2590931a268421e1b4` |
| `v1.17.0` | `485548c7b076954cdbf1ec4445335d7459662048` | 2026-09-29 | `da2504187c9f0073efd05cf99e02ef460bbde271c658a0c87a7456057d6d0ca1` |
| `v1.17.1` | `ab90c2f708b453f28c5f900feca5f67a3f89125a` | 2026-09-29 | `541fe5006b1f78ba1f580bf97655d139c66d35a68936d8d00d4eb9fcf336e0dd` |
| `v1.18.0` | `39e397eee2957574a8fc420df4556c4d1b171ffe` | 2026-09-30 | `23cc69abda81257e69b09700a637cd3dee0d88e59878a0f4c31456af1099a4cc` |
| `v1.19.0` | `3dc20dcfa27cefce0d7e715ac1229892d887f4fe` | 2026-09-30 | `c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed` |
| `v1.20.0` | `8f365b4276feca70297debec423dde40e1056aea` ("SBOM of the 1.20.0 stamp", after the stamp `66a616b`) | 2026-09-30 | `048e928499fa3569dfcfc59af86633ad4f8176d3bba1c0dd2fe61b62c35fb9ff` |

**How the checksums were made, and why they can be trusted before the release exists.** The release job builds
the zip with `git archive --format=zip --prefix="suds-vX.Y.Z/" -o suds-vX.Y.Z.zip <commit>` and hashes it with
`sha256sum` (`.github/workflows/release.yml`, *Package*; `scripts/package.js` does the same for `HEAD`). The zip
records only the tracked files and the commit's own time (no `.gitattributes` in the tree changes it), so it is a
function of the commit. Each zip above was built that way (git 2.43.0 on the development container) twice, with the
same bytes; and the same command reproduces the checksums the release workflow published on GitHub's runners for
two earlier releases, `v1.15.4` (`72006d33…15a7ec`) and `v1.16.2` (`690bafa6…a8853e`). The release job itself
refuses to publish a Release whose zip is not byte for byte its own build (`scripts/release-existing.js`).

**Still, compare before you record them anywhere.** After each release job has run, the `.sha256` beside its zip
must equal the value above. If one differs, the build is not what was reproduced here: do not record it, and find
out why (a git change on the runner that altered the zip bytes; compare `unzip -l` of both, file by file) before
anyone installs from it. Anyone can recheck a value from a clone at any time:

```bash
git archive --format=zip --prefix=suds-v1.20.0/ -o suds-v1.20.0.zip 8f365b4276feca70297debec423dde40e1056aea && sha256sum suds-v1.20.0.zip
```

## 1. Check (the owner, from any clone)

```bash
git fetch origin
R120=$(git log -1 --format=%H --grep='^SBOM of the 1.20.0 stamp' origin/main)
for c in fc5e9d7 6491308 485548c ab90c2f 39e397e 3dc20dc $R120; do
  git merge-base --is-ancestor $c origin/main && echo "$c on main" || echo "$c is NOT on main"
done
git show -s --format='%h %s' fc5e9d7 6491308 485548c ab90c2f 39e397e 3dc20dc $R120   # six "Release X.Y.Z", then "SBOM of the 1.20.0 stamp"
git show origin/main:package.json | grep '"version"'                            # 1.20.0: see "Before 1.20.1", below
for c in fc5e9d7 6491308 485548c ab90c2f 39e397e 3dc20dc $R120; do gh run list --workflow ci.yml --commit $c --event push --limit 1; done   # each: completed, success
git ls-remote --tags origin | grep -E 'refs/tags/v1\.1[6-9]\.'                  # only v1.16.0 to v1.16.2 so far
```

## 2. Tag, and push all seven at once

```bash
git tag -a v1.16.3 fc5e9d7fc42af0da8ce2032462ef3c7860e2f576 -m "SUDS 1.16.3"
git tag -a v1.16.4 6491308ff4c0eb89451e2717e89fc11ca5a9c4a1 -m "SUDS 1.16.4"
git tag -a v1.17.0 485548c7b076954cdbf1ec4445335d7459662048 -m "SUDS 1.17.0"
git tag -a v1.17.1 ab90c2f708b453f28c5f900feca5f67a3f89125a -m "SUDS 1.17.1"
git tag -a v1.18.0 39e397eee2957574a8fc420df4556c4d1b171ffe -m "SUDS 1.18.0"
git tag -a v1.19.0 3dc20dcfa27cefce0d7e715ac1229892d887f4fe -m "SUDS 1.19.0"
git tag -a v1.20.0 "$R120" -m "SUDS 1.20.0"
git push origin v1.16.3 v1.16.4 v1.17.0 v1.17.1 v1.18.0 v1.19.0 v1.20.0
```

**One push, never an older tag alone.** A `v1.16.x` tag pushed on its own would be the newest tag there is: its own
`release.yml` would make it the Latest release and start its own `web-app.yml`, which has no newest-release check and
would put the 1.16 site over 1.20.0; the 1.16 kernel refuses the databases 1.17.0 and later migrated, and everyone
using SUDS on this device would be locked out. With all seven in one push, `v1.20.0` is the newest tag from the start.

**Before 1.20.1.** Push the tags while `main`'s `package.json` still says 1.20.0. If 1.20.1 or 1.21.0 is stamped
first, add its tag to the same push: `v1.20.0` is then no longer the newest release, and the newer one's run is the
one that is Latest and republishes the site.

## 3. What each tag's runs do, and what to approve

Each tag runs **its own** copy of `release.yml` (the copy at the tag), whose gate runs `main`'s copy of the gate
scripts. Every run that reaches the release job waits for the owner's approval in the `release` environment (if
step 1 of *Owner: repository settings* is done), and a published release starts a `Web app` run that waits for a
second approval.

| Tag | Its gate (main's scripts) | Latest? Web app? | What the owner does |
| --- | --- | --- | --- |
| `v1.16.3`, `v1.16.4` | **Refused**: older than `main`'s version, from a `release.yml` that predates `--latest-out` (`olderReleaseProblem`, since 1.17.1). The tags alone do their job: the policy, migration order and *Backports* measure from them | Their workflow would mark them Latest and start a `Web app` run for 1.16.x | Nothing. A GitHub Release for either is optional: *Run workflow* on the tag with `policy_exception`, approve its release job, **reject its `Web app` run**, then `gh release edit v1.20.0 --latest` |
| `v1.17.0` | **Refused on the feature interval**: 28 days from `v1.16.0` (until 2026-10-27 03:16 UTC), the recorded exception | Not Latest (`main` says 1.20.0); no `Web app` run | *Run workflow* on `v1.17.0` with `policy_exception` = the recorded reason (*Record: 1.17.0*); approve the release job |
| `v1.17.1` | **Refused on the patch size** (more than 1,500 counted lines), the recorded exception | Not Latest; no `Web app` run | *Run workflow* on `v1.17.1` with `policy_exception` (*Record: 1.17.1*); approve |
| `v1.18.0` | **Refused on the feature interval**: the previous feature tag `v1.17.0` is minutes old (an annotated tag's own date counts) | Not Latest; no `Web app` run | *Run workflow* on `v1.18.0` with `policy_exception` (*Record: 1.18.0*); approve |
| `v1.19.0` | **Refused on the feature interval** (`v1.18.0` is minutes old) | Not Latest; no `Web app` run | *Run workflow* on `v1.19.0` with `policy_exception` (*Record: 1.19.0*); approve |
| `v1.20.0` | **Refused on the feature interval** (`v1.19.0` is minutes old) | **Latest**, and it starts a `Web app` run: the newest tag, and not older than the `version.json` `gh-pages` serves (1.20.0: a republish) | *Run workflow* on `v1.20.0` with `policy_exception` (*Record: 1.20.0*); approve the release job; **approve its `Web app` run**, which republishes the 1.20.0 build already live |

**Reject every other `Web app` run** waiting in the `release` environment: any run on a tag other than `v1.20.0` is
a republish of an older build (a rollback of the public site). Since 1.17.1 `web-app.yml` refuses a tag that is not
the newest and a version older than what `gh-pages` serves, but the 1.16.x copies have no such check.

Suggested `policy_exception` reasons, one line each, summarising the exceptions table in *Release cadence* (the
owner's own words do as well; the reason is printed at the top of the GitHub Release notes):

* `v1.17.0`: "Feature release inside 1.16.0's 28 days, approved by the owner (ship 1.17 with an exception when green); published to Pages 2026-09-29 before its tag."
* `v1.17.1`: "Patch over the size limit with new behaviour (Bedrock/Vertex AI, copilot cost and spending limit), approved by the owner; no migration, permission or route."
* `v1.18.0`: "Feature release inside 1.17.0's 28 days (county view, county connection, SUDS Server), approved by the owner; published to Pages before its tag."
* `v1.19.0`: "Feature release inside 1.18.0's 28 days (fingerprint sign-in and signing), approved by the owner (Release 19); published to Pages before its tag."
* `v1.20.0`: "Feature release inside 1.19.0's 28 days (county-entered figures, installer fixes, county kit), approved by the owner (no freeze; complete all build through 1.20); published to Pages before its tag."

Afterwards: `gh release list` shows seven new releases with `v1.20.0` Latest; the public URL's `version.json` reads
1.20.0; `gh release view v1.20.0 --json author --jq .author.login` prints `github-actions[bot]`.

## 4. Publish each checksum in the second channel

For each release, once its job has published `suds-vX.Y.Z.zip.sha256`:

```bash
gh release download vX.Y.Z --pattern 'suds-vX.Y.Z.zip.sha256' --dir sums && cat sums/suds-vX.Y.Z.zip.sha256   # must equal the table above
gh release view vX.Y.Z --json body --jq .body > notes.md
printf '\nSHA-256 of suds-vX.Y.Z.zip: %s\n' <hex> >> notes.md && gh release edit vX.Y.Z --notes-file notes.md
```

and add the same line, `SHA-256 of suds-vX.Y.Z.zip: <hex>`, to the top of that version's section in `CHANGELOG.md` on
`main` (one commit for all seven, through a pull request once `main` is protected). An operator then passes the value
to `upgrade.sh --release-sha256=<hex>` after checking the two agree; a zip replaced on the release page cannot also
change `main`'s history. (Until immutable releases are on, step 5 of *Owner: repository settings*, a release's files
can still be replaced; the CHANGELOG line is what exposes it.)

## 5. After the tags

* Remove the *Release waiting* entry in HANDOFF.md.
* Make `maint/1.18` from `v1.18.0` for 1.18.x security backports during 1.18's 30 days (*Backports*, step B; the
  same for `maint/1.16`, which only matters if a 1.16.x fix is still wanted).
* Regenerate the SBOM from the tag if you like (`node scripts/sbom.js --ref v1.20.0 --out docs/evidence/sbom-1.20.0.cdx.json`):
  it records the same commit and must come out byte-identical.
