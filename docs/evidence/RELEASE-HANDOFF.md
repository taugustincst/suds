# Release hand-off: tags v1.16.3 to v1.23.3

> **The one owner action: run step 1, then step 2's tag commands and its one `git push`.** It is what unblocks:
>
> * **Self-hosting.** SUDS Server's installer and `upgrade.sh` download `suds-vX.Y.Z.zip` from a GitHub Release
>   (`deploy/linux/lib.sh` `stage_release`). No release after 1.16.2 has one until its tag is pushed and its
>   `release.yml` run is approved, so a county server can only be installed from a copied tree or zip today.
> * **The release gate.** No release after 1.16.2 has been through it. A tag starts `release.yml` (gate, verify,
>   approval), and from then on every release does (docs/RELEASE.md, *Stabilisation (from 1.23.1)*); once the tags
>   exist, the maintaining assistant does not push `gh-pages` directly again.
> * **Everything that measures from "the previous release"** (the release policy, `scripts/migration-order.js`,
>   *Backports*), which measures from `v1.16.2` until then. CI's `release-policy` job measures from the commits in
>   the table below meanwhile, and from the tags once they exist.
>
> **1.23.1, 1.23.2 and 1.23.3 were stamped before the push**, so their tags go in the same push, as the eleventh,
> the twelfth and the thirteenth: `v1.23.3` is the newest tag, its run is the one that is Latest and publishes the
> site, and 1.23.1, 1.23.2 and 1.23.3 ship without a policy exception, so their gates pass with no `policy_exception`
> (*Run workflow* is not needed for them).

Thirteen versions are on `main` and released (1.23.2 is what GitHub Pages serves until `v1.23.3`'s `Web app` run is
approved) but **none is tagged**: 1.16.3 and 1.16.4 went out with 1.17.0; 1.16.4 to 1.23.2 were published to GitHub
Pages by a direct push to `gh-pages` at the owner's request, with no tag, no GitHub Release and no approval in the
`release` environment ([../RELEASE.md](../RELEASE.md), the *Record* entries and the exceptions table). 1.23.1, the
first release under *Stabilisation*, passed the patch rules with no exception; only its publication went round the
gate, because the tags were still owed (*Record: 1.23.1*). 1.23.2 passed the patch rules with no exception too, and
went out the same way for the same reason (*Record: 1.23.2*). 1.23.3 passes the patch rules with no exception too
and waits for its tag to be published by `release.yml` (*Record: 1.23.3*). Once the tags are pushed, no release goes
to `gh-pages` directly again.
Until the tags exist, everything that measures from "the previous release" measures from `v1.16.2`: the release policy, `scripts/migration-order.js`,
*Backports* step B, and SUDS Server upgrades, which download `suds-vX.Y.Z.zip` from a GitHub Release that does not
exist yet (`deploy/linux/lib.sh` `stage_release`).

This page is the hand-off: the checks, the tag commands, **one push**, what each tag's workflow runs will do and what
to approve, and the SHA-256 of each release zip, which the owner publishes in two places so an operator can check a
download against a channel other than the download (`upgrade.sh --release-sha256`; [../SELF-HOSTING.md](../SELF-HOSTING.md),
*Upgrading*). The assistant cannot push tags (*Handing a release to the owner*); only the owner runs these, from any
clone of their own.

Prepared on branch `docs/1191-stamp-pass` from `3dc20dc`, 30 September 2026, and carried into 1.20.0, 1.21.0, 1.22.0,
1.23.0, 1.23.1, 1.23.2 and 1.23.3. The 1.23.1 row was filled in by a commit after its stamp (`3c36e67`), as 1.23.0's
was after its SBOM commit (`fd042a9`): a commit cannot hold its own hash, nor the checksum of a zip built from it.
1.23.1, 1.23.2 and 1.23.3 are patches, so they have no SBOM commit (they keep `sbom-1.23.0`) and each tag goes on its
stamp, "Release 1.23.1" (`3bff36f`), "Release 1.23.2" (`a45c716`, its row filled by `9924b6a`) and "Release 1.23.3",
itself. The 1.23.3 row is filled in the same way, by a commit after its stamp; until then it holds placeholders, and
step 1 finds the commit by its subject.

## The thirteen releases

| Tag | Commit (stamp, "Release X.Y.Z") | CHANGELOG date | `suds-vX.Y.Z.zip` SHA-256 (rebuilt from the commit, as `release.yml` builds it) |
| --- | --- | --- | --- |
| `v1.16.3` | `fc5e9d7fc42af0da8ce2032462ef3c7860e2f576` | 2026-09-29 | `366908af8f79b871c64aa72cf4499c6c458606ebc4140e243a5c705a9862d882` |
| `v1.16.4` | `6491308ff4c0eb89451e2717e89fc11ca5a9c4a1` | 2026-09-29 | `a38cef2fba281af0fc3578899a730357e84ac870694d5c2590931a268421e1b4` |
| `v1.17.0` | `485548c7b076954cdbf1ec4445335d7459662048` | 2026-09-29 | `da2504187c9f0073efd05cf99e02ef460bbde271c658a0c87a7456057d6d0ca1` |
| `v1.17.1` | `ab90c2f708b453f28c5f900feca5f67a3f89125a` | 2026-09-29 | `541fe5006b1f78ba1f580bf97655d139c66d35a68936d8d00d4eb9fcf336e0dd` |
| `v1.18.0` | `39e397eee2957574a8fc420df4556c4d1b171ffe` | 2026-09-30 | `23cc69abda81257e69b09700a637cd3dee0d88e59878a0f4c31456af1099a4cc` |
| `v1.19.0` | `3dc20dcfa27cefce0d7e715ac1229892d887f4fe` | 2026-09-30 | `c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed` |
| `v1.20.0` | `8f365b4276feca70297debec423dde40e1056aea` ("SBOM of the 1.20.0 stamp", after the stamp `66a616b`) | 2026-09-30 | `048e928499fa3569dfcfc59af86633ad4f8176d3bba1c0dd2fe61b62c35fb9ff` |
| `v1.21.0` | `8dc7aa1848c35e057d3f953dd0f987764d92b572` ("SBOM of the 1.21.0 stamp", after the stamp `f58128c`) | 2026-09-30 | `d1ff00523b89d5bf15a28ed4b2be2f4fc80b5978a214152a28aaf3fde9e5c7de` |
| `v1.22.0` | `8b136dfc7f9b8628bb64e5491fdaae76895b7148` ("SBOM of the 1.22.0 stamp", after the stamp `74852e5`) | 2026-10-01 | `0798dc42106c95139ff4ed7f72fb3d6b95f32b8ce9cb197e6f01a1970168f1c3` |
| `v1.23.0` | `9877d07791880c9ea9a4ddd27b4a4707c7a0ca81` ("SBOM of the 1.23.0 stamp", after the stamp `48cc586`) | 2026-10-01 | `aa785678b0fe28967732fdf4826c5a89a25337c7fcae03512ca7105e45795a81` |
| `v1.23.1` | `3bff36f83a0bc39499fba82a96c874b0ef968396` ("Release 1.23.1": `git log -1 --format=%H --grep='^Release 1.23.1$' origin/main`) | 2026-10-01 | `38b1895c168d786b461b298181358b1b362eef24a66bb64f656e3a31b024124e` |
| `v1.23.2` | `a45c716091a067ac635c384d03014be1be25b868` ("Release 1.23.2": `git log -1 --format=%H --grep='^Release 1.23.2$' origin/main`) | 2026-10-01 | `571d25dd8dae3adbc16ae916a091e8f553e7303713ec1b43e102d2d6bc31c41c` |
| `v1.23.3` | `<1.23.3 release commit>` ("Release 1.23.3": `git log -1 --format=%H --grep='^Release 1.23.3$' origin/main`) | 2026-10-01 | `<filled after the release>`; rebuild it with the command below |

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
git archive --format=zip --prefix=suds-v1.21.0/ -o suds-v1.21.0.zip 8dc7aa1848c35e057d3f953dd0f987764d92b572 && sha256sum suds-v1.21.0.zip
git archive --format=zip --prefix=suds-v1.22.0/ -o suds-v1.22.0.zip 8b136dfc7f9b8628bb64e5491fdaae76895b7148 && sha256sum suds-v1.22.0.zip
git archive --format=zip --prefix=suds-v1.23.0/ -o suds-v1.23.0.zip 9877d07791880c9ea9a4ddd27b4a4707c7a0ca81 && sha256sum suds-v1.23.0.zip
git archive --format=zip --prefix=suds-v1.23.1/ -o suds-v1.23.1.zip 3bff36f83a0bc39499fba82a96c874b0ef968396 && sha256sum suds-v1.23.1.zip
git archive --format=zip --prefix=suds-v1.23.2/ -o suds-v1.23.2.zip a45c716091a067ac635c384d03014be1be25b868 && sha256sum suds-v1.23.2.zip
R1233=$(git log -1 --format=%H --grep='^Release 1.23.3$' origin/main)
git archive --format=zip --prefix=suds-v1.23.3/ -o suds-v1.23.3.zip "$R1233" && sha256sum suds-v1.23.3.zip
```

## 1. Check (the owner, from any clone)

```bash
git fetch origin
R120=$(git log -1 --format=%H --grep='^SBOM of the 1.20.0 stamp' origin/main)
R121=$(git log -1 --format=%H --grep='^SBOM of the 1.21.0 stamp' origin/main)
R122=$(git log -1 --format=%H --grep='^SBOM of the 1.22.0 stamp' origin/main)
R123=$(git log -1 --format=%H --grep='^SBOM of the 1.23.0 stamp' origin/main)
R1231=$(git log -1 --format=%H --grep='^Release 1.23.1$' origin/main)
R1232=$(git log -1 --format=%H --grep='^Release 1.23.2$' origin/main)
R1233=$(git log -1 --format=%H --grep='^Release 1.23.3$' origin/main)
for c in fc5e9d7 6491308 485548c ab90c2f 39e397e 3dc20dc $R120 $R121 $R122 $R123 $R1231 $R1232 $R1233; do
  git merge-base --is-ancestor $c origin/main && echo "$c on main" || echo "$c is NOT on main"
done
git show -s --format='%h %s' fc5e9d7 6491308 485548c ab90c2f 39e397e 3dc20dc $R120 $R121 $R122 $R123 $R1231 $R1232 $R1233   # six "Release X.Y.Z", the SBOM commits of 1.20.0, 1.21.0, 1.22.0 and 1.23.0, then "Release 1.23.1", "Release 1.23.2" and "Release 1.23.3"
git show origin/main:package.json | grep '"version"'                            # 1.23.3: see "Before 1.23.4 or 1.24.0", below
for c in fc5e9d7 6491308 485548c ab90c2f 39e397e 3dc20dc $R120 $R121 $R122 $R123 $R1231 $R1232 $R1233; do gh run list --workflow ci.yml --commit $c --event push --limit 1; done   # each: completed, success
git ls-remote --tags origin | grep -E 'refs/tags/v1\.1[6-9]\.'                  # only v1.16.0 to v1.16.2 so far
```

## 2. Tag, and push all thirteen at once

```bash
git tag -a v1.16.3 fc5e9d7fc42af0da8ce2032462ef3c7860e2f576 -m "SUDS 1.16.3"
git tag -a v1.16.4 6491308ff4c0eb89451e2717e89fc11ca5a9c4a1 -m "SUDS 1.16.4"
git tag -a v1.17.0 485548c7b076954cdbf1ec4445335d7459662048 -m "SUDS 1.17.0"
git tag -a v1.17.1 ab90c2f708b453f28c5f900feca5f67a3f89125a -m "SUDS 1.17.1"
git tag -a v1.18.0 39e397eee2957574a8fc420df4556c4d1b171ffe -m "SUDS 1.18.0"
git tag -a v1.19.0 3dc20dcfa27cefce0d7e715ac1229892d887f4fe -m "SUDS 1.19.0"
git tag -a v1.20.0 "$R120" -m "SUDS 1.20.0"
git tag -a v1.21.0 "$R121" -m "SUDS 1.21.0"
git tag -a v1.22.0 "$R122" -m "SUDS 1.22.0"
git tag -a v1.23.0 "$R123" -m "SUDS 1.23.0"
git tag -a v1.23.1 "$R1231" -m "SUDS 1.23.1"
git tag -a v1.23.2 "$R1232" -m "SUDS 1.23.2"
git tag -a v1.23.3 "$R1233" -m "SUDS 1.23.3"
git push origin v1.16.3 v1.16.4 v1.17.0 v1.17.1 v1.18.0 v1.19.0 v1.20.0 v1.21.0 v1.22.0 v1.23.0 v1.23.1 v1.23.2 v1.23.3
```

**One push, never an older tag alone.** A `v1.16.x` tag pushed on its own would be the newest tag there is: its own
`release.yml` would make it the Latest release and start its own `web-app.yml`, which has no newest-release check and
would put the 1.16 site over 1.23.2; the 1.16 kernel refuses the databases 1.17.0 and later migrated, and everyone
using SUDS on this device would be locked out. With all thirteen in one push, `v1.23.3` is the newest tag from the
start.

**Before 1.23.4 or 1.24.0.** Push the tags while `main`'s `package.json` still says 1.23.3. 1.23.1, 1.23.2 and
1.23.3 were stamped before the push, so their tags are in it, `v1.23.3` is the newest release, and its run is the one
that is Latest and publishes the site; the runs of `v1.23.0`, `v1.23.1` and `v1.23.2` are not Latest and start no
`Web app` run. If a 1.23.4 is stamped first, its tag joins the same push in the same places as `v1.23.3`'s (the table
row on its stamp, an `R1234` line and `$R1234` in both check loops, its `git tag -a` line, the end of the push, a
step-3 row that is Latest, with `v1.23.3`'s changed to "Not Latest; no `Web app` run"). 1.24.0 cannot be stamped
first: the feature freeze holds it until 2026-10-29
(docs/RELEASE.md, *Stabilisation (from 1.23.1)*). The stabilisation commitment holds meanwhile: once the owner has
pushed these tags, the maintaining assistant does not push `gh-pages` directly again; until then, any direct push of a
stamped, CI-green build (1.23.3's included, if it has to go live first, as 1.23.1's and 1.23.2's did) is recorded in
that version's *Record* and in the exceptions table.

## 3. What each tag's runs do, and what to approve

Each tag runs **its own** copy of `release.yml` (the copy at the tag), whose gate runs `main`'s copy of the gate
scripts. Every run that reaches the release job waits for the owner's approval in the `release` environment (if
step 1 of *Owner: repository settings* is done), and a published release starts a `Web app` run that waits for a
second approval.

| Tag | Its gate (main's scripts) | Latest? Web app? | What the owner does |
| --- | --- | --- | --- |
| `v1.16.3`, `v1.16.4` | **Refused**: older than `main`'s version, from a `release.yml` that predates `--latest-out` (`olderReleaseProblem`, since 1.17.1). The tags alone do their job: the policy, migration order and *Backports* measure from them | Their workflow would mark them Latest and start a `Web app` run for 1.16.x | Nothing. A GitHub Release for either is optional: *Run workflow* on the tag with `policy_exception`, approve its release job, **reject its `Web app` run**, then `gh release edit v1.23.3 --latest` |
| `v1.17.0` | **Refused on the feature interval**: 28 days from `v1.16.0` (until 2026-10-27 03:16 UTC), the recorded exception | Not Latest (`main` says 1.23.3); no `Web app` run | *Run workflow* on `v1.17.0` with `policy_exception` = the recorded reason (*Record: 1.17.0*); approve the release job |
| `v1.17.1` | **Refused on the patch size** (more than 1,500 counted lines), the recorded exception | Not Latest; no `Web app` run | *Run workflow* on `v1.17.1` with `policy_exception` (*Record: 1.17.1*); approve |
| `v1.18.0` | **Refused on the feature interval**: the previous feature tag `v1.17.0` is minutes old (an annotated tag's own date counts) | Not Latest; no `Web app` run | *Run workflow* on `v1.18.0` with `policy_exception` (*Record: 1.18.0*); approve |
| `v1.19.0` | **Refused on the feature interval** (`v1.18.0` is minutes old) | Not Latest; no `Web app` run | *Run workflow* on `v1.19.0` with `policy_exception` (*Record: 1.19.0*); approve |
| `v1.20.0` | **Refused on the feature interval** (`v1.19.0` is minutes old) | Not Latest; no `Web app` run | *Run workflow* on `v1.20.0` with `policy_exception` (*Record: 1.20.0*); approve |
| `v1.21.0` | **Refused on the feature interval** (`v1.20.0` is minutes old) | Not Latest; no `Web app` run | *Run workflow* on `v1.21.0` with `policy_exception` (*Record: 1.21.0*); approve |
| `v1.22.0` | **Refused on the feature interval** (`v1.21.0` is minutes old) | Not Latest; no `Web app` run | *Run workflow* on `v1.22.0` with `policy_exception` (*Record: 1.22.0*); approve |
| `v1.23.0` | **Refused on the feature interval** (`v1.22.0` is minutes old) | Not Latest; no `Web app` run | *Run workflow* on `v1.23.0` with `policy_exception` (*Record: 1.23.0*); approve |
| `v1.23.1` | **Passes**: a patch of `v1.23.0` with no migration, permission or route, within the size limit (*Record: 1.23.1*) | Not Latest; no `Web app` run | Nothing to dispatch: the tag push runs it. Approve the release job |
| `v1.23.2` | **Passes**: a patch of `v1.23.1` with no migration, permission or route, within the size limit (*Record: 1.23.2*) | Not Latest; no `Web app` run | Nothing to dispatch: the tag push runs it. Approve the release job |
| `v1.23.3` | **Passes**: a patch of `v1.23.2` with no migration, permission or route, within the size limit (*Record: 1.23.3*) | **Latest**, and it starts a `Web app` run: the newest tag, and newer than the `version.json` `gh-pages` serves (1.23.2) | Nothing to dispatch: the tag push runs it. Approve the release job; **approve its `Web app` run**, which publishes 1.23.3 to GitHub Pages |

**Reject every other `Web app` run** waiting in the `release` environment: any run on a tag other than `v1.23.3` is
a republish of an older build (a rollback of the public site). Since 1.17.1 `web-app.yml` refuses a tag that is not
the newest and a version older than what `gh-pages` serves, but the 1.16.x copies have no such check.

Suggested `policy_exception` reasons, one line each, summarising the exceptions table in *Release cadence* (the
owner's own words do as well; the reason is printed at the top of the GitHub Release notes):

* `v1.17.0`: "Feature release inside 1.16.0's 28 days, approved by the owner (ship 1.17 with an exception when green); published to Pages 2026-09-29 before its tag."
* `v1.17.1`: "Patch over the size limit with new behaviour (Bedrock/Vertex AI, copilot cost and spending limit), approved by the owner; no migration, permission or route."
* `v1.18.0`: "Feature release inside 1.17.0's 28 days (county view, county connection, SUDS Server), approved by the owner; published to Pages before its tag."
* `v1.19.0`: "Feature release inside 1.18.0's 28 days (fingerprint sign-in and signing), approved by the owner (Release 19); published to Pages before its tag."
* `v1.20.0`: "Feature release inside 1.19.0's 28 days (county-entered figures, installer fixes, county kit), approved by the owner (no freeze; complete all build through 1.20); published to Pages before its tag."
* `v1.21.0`: "Feature release inside 1.20.0's 28 days (county publication releases, field devices, authenticator allow-list, county award amounts and reminders), approved by the owner (implement all five, resolve all known issues); published to Pages before its tag."
* `v1.22.0`: "Feature release inside 1.21.0's 28 days (day-to-day fixes for frontline workers, field scope bound to the account, county publication consent and corrected releases, allow-list grace period), approved by the owner (implement all recommendations for SUDS workers); published to Pages before its tag."
* `v1.23.0`: "Feature release inside 1.22.0's 28 days (follow-up to-dos that follow edits, the worker-first menu and phone Home, street outreach with no signal and field-device requests, the supervisor's referral reminders), approved by the owner (implement all recommendations for SUDS workers); published to Pages before its tag."

Afterwards: `gh release list` shows thirteen new releases with `v1.23.3` Latest; the public URL's `version.json`
reads 1.23.3; `gh release view v1.23.3 --json author --jq .author.login` prints `github-actions[bot]`.

## 4. Publish each checksum in the second channel

For each release, once its job has published `suds-vX.Y.Z.zip.sha256`:

```bash
gh release download vX.Y.Z --pattern 'suds-vX.Y.Z.zip.sha256' --dir sums && cat sums/suds-vX.Y.Z.zip.sha256   # must equal the table above
gh release view vX.Y.Z --json body --jq .body > notes.md
printf '\nSHA-256 of suds-vX.Y.Z.zip: %s\n' <hex> >> notes.md && gh release edit vX.Y.Z --notes-file notes.md
```

and add the same line, `SHA-256 of suds-vX.Y.Z.zip: <hex>`, to the top of that version's section in `CHANGELOG.md` on
`main` (one commit for all thirteen, through a pull request once `main` is protected). An operator then passes the value
to `upgrade.sh --release-sha256=<hex>` after checking the two agree; a zip replaced on the release page cannot also
change `main`'s history. (Until immutable releases are on, step 5 of *Owner: repository settings*, a release's files
can still be replaced; the CHANGELOG line is what exposes it.)

## 5. After the tags

* Remove the *Release waiting* entry in HANDOFF.md.
* Make `maint/1.22` from `v1.22.0` for 1.22.x security backports during 1.22's 30 days (*Backports*, step B; the
  same for an older line, which only matters if a fix for it is still wanted).
* Regenerate the SBOM from the tag if you like (`node scripts/sbom.js --ref v1.23.0 --out docs/evidence/sbom-1.23.0.cdx.json`):
  it records the same commit and must come out byte-identical.
