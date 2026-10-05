# Release record: v1.24.4 (published 2026-10-05)

> 1.24.4 is published and live. This file recorded the hand-off while the tag was still owed; the
> completed release is recorded here. The next release (1.25.0, CalOMS corrections + UI cleanup +
> resource pictures) gets its own hand-off when it is stamped.

## Completed: v1.24.4 (2026-10-05)

| Tag | Commit | Release run | Published |
| --- | --- | --- | --- |
| `v1.24.4` | `e71c3105d4926d4e22207f415916bce6e07d6676` ("Release 1.24.4") | 37385754401 (success; exact-commit CI 37381511508, all 11 jobs green) | 2026-10-05T23:05:43Z, **Latest** |

- Assets: `suds-v1.24.4.zip` (SHA-256 `f3787da4bbf95b3f3cab14a8ab0542c73edf06e649a3bcab083dfbdb07d262b6`,
  verified against the downloaded release asset with `sha256sum -c`: OK), `suds-v1.24.4.zip.sha256`,
  `suds-1.24.4-windows-x64.zip` + `.sha256`. Content of the release zip is byte-for-byte the tag's tree
  (only zip container timestamps differ from a local rebuild — git-archive stamps entry times from the
  commit, and the runner's git wrote them in UTC vs the local rebuild; the release pipeline's own
  byte-for-byte check passed).
- Pages: the `Web app` run's publish job failed on a latent workflow bug (1.23.3 rewrite): the
  "Still not older than the web app gh-pages serves" step ran `node tag/scripts/pages-version-check.js`
  from the checkout directory, but the previous step extracts `tag/` into `$RUNNER_TEMP`. The tag's own
  checks all passed (release-site-check: 80 built files byte-for-byte the tag's; pages-version-check:
  "gh-pages serves 1.24.1, older than 1.24.4"), so the build artifact was pushed to `gh-pages` by hand
  following the workflow's own steps. Live `version.json` reads **1.24.4**; the procurement page renders
  the published pricing (contact fields honestly read "Not yet published by the maintainer").
- The workflow bug is fixed on `main` (the step now `cd "$RUNNER_TEMP"` first); it ships with 1.25.0.
  No 1.23.x `Web app` run had exercised the rewritten workflow before 1.24.4.

## The one release (superseded — kept for the record)

The table below was the pending hand-off; the release above is what it became.

| Tag | Commit (stamp, "Release X.Y.Z") | CHANGELOG date | `suds-vX.Y.Z.zip` SHA-256 |
| --- | --- | --- | --- |
| `v1.24.4` | `<1.24.4 release commit>` ("Release 1.24.4": `git log -1 --format=%H --grep='^Release 1.24.4$' origin/main`) | 2026-10-05 | `<filled after the release>`; rebuild it with the command below |

**How the checksum is made, and why it can be trusted before the release exists.** The release job builds
the zip with `git archive --format=zip --prefix="suds-vX.Y.Z/" -o suds-vX.Y.Z.zip <commit>` and hashes it with
`sha256sum` (`.github/workflows/release.yml`, *Package*; `scripts/package.js` does the same for `HEAD`). The zip
records only the tracked files and the commit's own time (no `.gitattributes` in the tree changes it), so it is a
function of the commit. The same command reproduces the checksums the release workflow published on GitHub's
runners for earlier releases. The release job itself refuses to publish a Release whose zip is not byte for byte
its own build (`scripts/release-existing.js`).

**Still, compare before you record it anywhere.** After the release job has run, the `.sha256` beside its zip
must equal the value above. If it differs, the build is not what was reproduced here: do not record it, and find
out why (a git change on the runner that altered the zip bytes; compare `unzip -l` of both, file by file) before
anyone installs from it. Anyone can recheck the value from a clone at any time:

```bash
R1244=$(git log -1 --format=%H --grep='^Release 1.24.4$' origin/main)
git archive --format=zip --prefix=suds-v1.24.4/ -o suds-v1.24.4.zip "$R1244" && sha256sum suds-v1.24.4.zip
```

## 1. Check (the owner, from any clone)

```bash
git fetch origin
R1244=$(git log -1 --format=%H --grep='^Release 1.24.4$' origin/main)
for c in $R1244; do
  git merge-base --is-ancestor $c origin/main && echo "$c on main" || echo "$c is NOT on main"
done
git show -s --format='%h %s' $R1244   # "Release 1.24.4"
git show origin/main:package.json | grep '"version"'                            # 1.24.4
gh run list --workflow ci.yml --commit $R1244 --event push --limit 1   # completed, success
git ls-remote --tags origin | grep 'v1.24.4'   # not there yet: the tag is what this hand-off is for
```

## 2. Tag, and push

```bash
git tag -a v1.24.4 "$R1244" -m "SUDS 1.24.4"
git push origin v1.24.4
```

**Never push an older tag alone.** A lone `v1.16.x` tag would become the newest tag there is: its `release.yml`
would mark it Latest and start a `Web app` run for 1.16.x. `v1.24.4` is newer than every tag on origin, so its
push is safe on its own.

## 3. What the tag's run does, and what to approve

The tag runs **its own** copy of `release.yml` (the copy at the tag), whose gate runs `main`'s copy of the gate
scripts. The run waits for the owner's approval in the `release` environment, and the published release starts a
`Web app` run that waits for a second approval.

| Tag | Its gate (main's scripts) | Latest? Web app? | What the owner does |
| --- | --- | --- | --- |
| `v1.24.4` | **Passes**: a patch of `v1.24.3` with no migration, permission or route, within the size limit (*Record: 1.24.4*) | **Latest**, and it starts a `Web app` run: the newest tag. Its run also builds and attaches the Windows server zip, unsigned while the certificate secrets are not set | Nothing to dispatch: the tag push runs it. Approve the release job; **approve its `Web app` run**, which publishes 1.24.4 to GitHub Pages and corrects the Latest marker (currently `v1.16.4`, an artifact of the manual publishes) |

## Completed: the v1.16.3–v1.24.3 tag push (2026-10-05)

The 20 tags `v1.16.3` through `v1.24.3` were pushed to origin on 2026-10-05 in one push, while `main` was at the
1.24.3 stamp. That hand-off is done; what follows is its record. The SHA-256 values stay as the second channel
for `upgrade.sh --release-sha256` until each is also published in its release notes and CHANGELOG.

- `v1.16.3` — commit `fc5e9d7fc42af0da8ce2032462ef3c7860e2f576` (CHANGELOG 2026-09-29), zip SHA-256 `366908af8f79b871c64aa72cf4499c6c458606ebc4140e243a5c705a9862d882`
- `v1.16.4` — commit `6491308ff4c0eb89451e2717e89fc11ca5a9c4a1` (CHANGELOG 2026-09-29), zip SHA-256 `a38cef2fba281af0fc3578899a730357e84ac870694d5c2590931a268421e1b4`
- `v1.17.0` — commit `485548c7b076954cdbf1ec4445335d7459662048` (CHANGELOG 2026-09-29), zip SHA-256 `da2504187c9f0073efd05cf99e02ef460bbde271c658a0c87a7456057d6d0ca1`
- `v1.17.1` — commit `ab90c2f708b453f28c5f900feca5f67a3f89125a` (CHANGELOG 2026-09-29), zip SHA-256 `541fe5006b1f78ba1f580bf97655d139c66d35a68936d8d00d4eb9fcf336e0dd`
- `v1.18.0` — commit `39e397eee2957574a8fc420df4556c4d1b171ffe` (CHANGELOG 2026-09-30), zip SHA-256 `23cc69abda81257e69b09700a637cd3dee0d88e59878a0f4c31456af1099a4cc`
- `v1.19.0` — commit `3dc20dcfa27cefce0d7e715ac1229892d887f4fe` (CHANGELOG 2026-09-30), zip SHA-256 `c927808937892f9c474a01eee07a8f13c390d54db98ae6425eaa3f99a19bf2ed`
- `v1.20.0` — commit `8f365b4276feca70297debec423dde40e1056aea` (CHANGELOG 2026-09-30), zip SHA-256 `048e928499fa3569dfcfc59af86633ad4f8176d3bba1c0dd2fe61b62c35fb9ff`
- `v1.21.0` — commit `8dc7aa1848c35e057d3f953dd0f987764d92b572` (CHANGELOG 2026-09-30), zip SHA-256 `d1ff00523b89d5bf15a28ed4b2be2f4fc80b5978a214152a28aaf3fde9e5c7de`
- `v1.22.0` — commit `8b136dfc7f9b8628bb64e5491fdaae76895b7148` (CHANGELOG 2026-10-01), zip SHA-256 `0798dc42106c95139ff4ed7f72fb3d6b95f32b8ce9cb197e6f01a1970168f1c3`
- `v1.23.0` — commit `9877d07791880c9ea9a4ddd27b4a4707c7a0ca81` (CHANGELOG 2026-10-01), zip SHA-256 `aa785678b0fe28967732fdf4826c5a89a25337c7fcae03512ca7105e45795a81`
- `v1.23.1` — commit `3bff36f83a0bc39499fba82a96c874b0ef968396` (CHANGELOG 2026-10-01), zip SHA-256 `38b1895c168d786b461b298181358b1b362eef24a66bb64f656e3a31b024124e`
- `v1.23.2` — commit `a45c716091a067ac635c384d03014be1be25b868` (CHANGELOG 2026-10-01), zip SHA-256 `571d25dd8dae3adbc16ae916a091e8f553e7303713ec1b43e102d2d6bc31c41c`
- `v1.23.3` — commit `c02a261de66277d7b86ccab19dfa0755be9e7db6` (CHANGELOG 2026-10-01), zip SHA-256 `9ffa1c319a8562276416957e20aa6c51250ca9e06e2ad2440ca4a4f20be30e28`
- `v1.23.4` — commit `598d08bc250c996a6cb737f2febe12c41e931110` (CHANGELOG 2026-10-01), zip SHA-256 `48a312aa4b0c22654e90920c0f236ff0e6a39da0628bd0ade855f835c603387f`
- `v1.23.5` — commit `382278ab2feb27992e222f3330c8c02f5d0aa579` (CHANGELOG 2026-10-02), zip SHA-256 `100d8e8d144a5fcf370278d8fcb5a5606fd1b008bcc61da1c25dbb6c2f8b56be`
- `v1.23.6` — commit `57bf2df5668a51c2b8614996085feb356a414800` (CHANGELOG 2026-10-02), zip SHA-256 `3cdfe0ea70c96b833126e3da96a20a00b5f3358c098f5abf8544da9b9a98a74a`
- `v1.24.0` — commit `d2fd17255232e46a2ca19ab36f8f6c09e0a54828` (CHANGELOG 2026-10-03), zip SHA-256 `77b58c2066a706cded48e0deb0bfb5491c17adb8b25413559b53ff50e7aae078`
- `v1.24.1` — commit `d109d32cf20b6b882711ce6dd24a3886731f54f5` (CHANGELOG 2026-10-03), zip SHA-256 `9b9592e5d8bec75d8a48f7f469e7db83bc30eee7e4b5c54a3c7f87b06d829f06`
- `v1.24.2` — commit `544c204f0b90c583624434814ce49abea762bb49` (2026-10-05); its release failed (exact-commit CI never green) and it is superseded by 1.24.3 — do not publish it.
- `v1.24.3` — commit `82217278be9a622348189f86f52a26c6fea8e45a` (2026-10-05); its exact-commit CI failed on three real findings and it is superseded by 1.24.4 — do not publish it, and never deploy it to Pages.

**Execution log — 2026-10-05 evening (assistant-run, owner-authorized).** All 20 annotated tags are on origin
(verified with `git ls-remote --tags origin`). `v1.24.1` was published by its workflow (run 37366144240,
`github-actions[bot]`, 2026-10-05T20:11:11Z); live `version.json` reads 1.24.1. `v1.16.3` and `v1.16.4` were
published by hand (assets built locally, notes from CHANGELOG) — not via their historical workflows, so no old
build can roll back GitHub Pages. `v1.24.2`'s release failed legitimately (its exact commit's CI was never
green). `v1.24.3`'s exact-commit CI failed on three real findings (form-refusal banner, DOB format in
duplicate detection, release-state docs), so 1.24.4 supersedes it. GitHub currently marks `v1.16.4` Latest (an
artifact of the manual publishes); the `v1.24.4` release corrects that. The `v1.23.6` owner-approved exception
note is recorded in its release notes.
