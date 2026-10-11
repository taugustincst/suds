# Release hand-off: v1.25.5 released, then the record

> 1.25.5 is released (2026-10-11 UTC): tag `v1.25.5` at `e0f97ebc`, pushed by the owner; its GitHub Release is published
> and marked **Latest**; its zip equals the checksum recorded before the tag; GitHub Pages serves 1.25.5. The releases
> below are the superseded record. No tag is owed.
>
> **Still the owner's:** add `evening` to `main`'s required status checks (Settings → Rules → Rulesets → `main`), as
> the release gate requires it from 1.25.5; until then the weekly settings check reports the difference.

## v1.25.5: released

| Tag | Commit | CHANGELOG date | `suds-vX.Y.Z.zip` SHA-256 |
| --- | --- | --- | --- |
| `v1.25.5` | `e0f97ebc` ("SBOM of the 1.25.5 stamp") | 2026-10-10 | `319d1c1b9de96c52ce67503d0a460092149d96a6591aad2a1b448ac941956736` (recorded before the tag; the release asset matches) |

```bash
git fetch origin tag v1.25.5
git archive --format=zip --prefix=suds-v1.25.5/ -o suds-v1.25.5.zip v1.25.5 && sha256sum suds-v1.25.5.zip
# 319d1c1b9de96c52ce67503d0a460092149d96a6591aad2a1b448ac941956736  suds-v1.25.5.zip
```

## Completed: v1.25.5 (2026-10-11 UTC)

- `v1.25.5` — commit `e0f97ebce4ce3cbbfd97e27684dac0facacead50` ("SBOM of the 1.25.5 stamp", after the stamp `96905ba`;
  CHANGELOG 2026-10-10), zip SHA-256 `319d1c1b9de96c52ce67503d0a460092149d96a6591aad2a1b448ac941956736`; exact-commit CI 38087235998 (every required
  job green, `evening` and `service-sandbox` included; the advisory WebKit job's timeout is in the flake register,
  docs/RELEASE.md). The full suite, the evening run and the browser suite ran on the stamped tree before it was pushed.
- The owner pushed the tag. Release run 38097790523 succeeded; the GitHub Release was published at 00:22 UTC on
  2026-10-11 with five assets: the source zip and its `.sha256`, the Windows zip (unsigned: the code-signing secrets are
  not set) and its `.sha256`, and `sbom-1.25.5.cdx.json`, the first Release to carry its SBOM. Marked **Latest**. The
  published `.sha256` equals the value recorded before the tag, and a download of each zip hashes to its `.sha256`; the
  SBOM asset is byte for byte the tagged commit's file.
- Windows zip: `suds-1.25.5-windows-x64.zip`, SHA-256 `69d25c33e4e350373b11fbd368424dc1863631118c31d69150864c1deb4fe9a1` (from its `.sha256` asset and a download).
- Pages: `v1.25.5`'s `Web app` run 38098224930 succeeded; `gh-pages`' `version.json` reads **1.25.5**.

## v1.25.4: released

| Tag | Commit | CHANGELOG date | `suds-vX.Y.Z.zip` SHA-256 |
| --- | --- | --- | --- |
| `v1.25.4` | `1962de6f` ("SBOM of the 1.25.4 stamp") | 2026-10-10 | `b0a04a6a98e1361cc1c85386afb1c2763904370db3b796f454031093b1d3736f` (recorded before the tag; the release asset matches) |

```bash
git fetch origin tag v1.25.4
git archive --format=zip --prefix=suds-v1.25.4/ -o suds-v1.25.4.zip v1.25.4 && sha256sum suds-v1.25.4.zip
# b0a04a6a98e1361cc1c85386afb1c2763904370db3b796f454031093b1d3736f  suds-v1.25.4.zip
```

## Completed: v1.25.4 (2026-10-10)

- `v1.25.4` — commit `1962de6ff411379c6ffc07ad8f3a08e4cc74c913` ("SBOM of the 1.25.4 stamp", after the stamp `4bd6352`;
  CHANGELOG 2026-10-10), zip SHA-256 `b0a04a6a98e1361cc1c85386afb1c2763904370db3b796f454031093b1d3736f`; exact-commit CI 38019332980 (every required
  job green; the advisory WebKit job's timeout is in the flake register, docs/RELEASE.md). The full suite, the evening
  run and the browser suite ran on the stamped tree before it was pushed (*Stamp checklist*).
- The owner pushed the tag on 2026-10-10. Release run 38061810135 succeeded; the GitHub Release was published at
  15:07 UTC with its source and Windows zips (the Windows zip unsigned: the code-signing secrets are not set), marked
  **Latest**. The published `.sha256` equals the value recorded before the tag, and a download of the zip hashes to it.
- Windows zip: `suds-1.25.4-windows-x64.zip`, SHA-256 `ad6cc1f8f0fa1947a179c256efa0950d5a80873c569be9dac84ada6c82f11597` (read from its `.sha256` asset and from a download).
- Pages: `v1.25.4`'s `Web app` run 38062338161 succeeded; `gh-pages`' `version.json` reads **1.25.4**.
- SBOM: `sbom-1.25.4`, generated from its stamp.

## v1.25.3 and v1.25.2: released

| Tag | Commit | CHANGELOG date | `suds-vX.Y.Z.zip` SHA-256 |
| --- | --- | --- | --- |
| `v1.25.3` | `fdd248d0` (the second "SBOM of the 1.25.3 stamp") | 2026-10-09 | `d70101e1d0332beff63beef329cea7089bbe1afd4f58e34beb845a1e556239cc` (recorded before the tag; the release asset matches) |
| `v1.25.2` | `cfafd6a3` ("SBOM of the 1.25.2 stamp") | 2026-10-08 | `acc777aad2908d8b111bb7d02cb9f96c9a0f60f3b6c664ba7a4daa21a7870d61` (recorded before the tag; the release asset matches) |

```bash
git fetch origin tag v1.25.3
git archive --format=zip --prefix=suds-v1.25.3/ -o suds-v1.25.3.zip v1.25.3 && sha256sum suds-v1.25.3.zip
# d70101e1d0332beff63beef329cea7089bbe1afd4f58e34beb845a1e556239cc  suds-v1.25.3.zip
```

## Completed: v1.25.2 and v1.25.3 (2026-10-09)

- `v1.25.2` — commit `cfafd6a3f68ff29482937d28bfe5577e68f2b869` ("SBOM of the 1.25.2 stamp", after the stamp `72a0daa`;
  CHANGELOG 2026-10-08), zip SHA-256 `acc777aad2908d8b111bb7d02cb9f96c9a0f60f3b6c664ba7a4daa21a7870d61`; exact-commit CI 37850128724.
- `v1.25.3` — commit `fdd248d00e996c534d34619968dc5161e55edf75` (the second "SBOM of the 1.25.3 stamp", after the stamp
  `224b74a`; CHANGELOG 2026-10-09), zip SHA-256 `d70101e1d0332beff63beef329cea7089bbe1afd4f58e34beb845a1e556239cc`; exact-commit CI 37868178692 (every required job green). The
  first pair, `d12ab47`/`5b83686`, was never tagged (docs/RELEASE.md, *Record: 1.25.3*).
- The owner pushed both tags in one push on 2026-10-09. Release runs for `v1.25.2` and `v1.25.3` succeeded; both GitHub
  Releases were published at 16:15 UTC with their source and Windows zips (the Windows zips unsigned: the code-signing
  secrets are not set), `v1.25.3` marked **Latest**. Each published `.sha256` equals the value recorded before the tag,
  and a download of each zip hashes to it.
- Pages: `v1.25.3`'s `Web app` run succeeded; `gh-pages`' `version.json` reads **1.25.3**.
- SBOMs: `sbom-1.25.2` and `sbom-1.25.3`, each generated from its stamp (the first patches with SBOMs of their own).

## v1.25.1: released

| Tag | Commit | CHANGELOG date | `suds-vX.Y.Z.zip` SHA-256 |
| --- | --- | --- | --- |
| `v1.25.1` | `03bdca9a` ("Release 1.25.1") | 2026-10-08 | `f81b65ceaf390bc2430ca8205a787781873411b12681c842c5cb19a727a28e1b` (recorded before the tag; the release asset matches) |

```bash
git fetch origin tag v1.25.1
git archive --format=zip --prefix=suds-v1.25.1/ -o suds-v1.25.1.zip v1.25.1 && sha256sum suds-v1.25.1.zip
# f81b65ceaf390bc2430ca8205a787781873411b12681c842c5cb19a727a28e1b  suds-v1.25.1.zip
```

## Completed: v1.25.1 (2026-10-08)

- `v1.25.1` — commit `03bdca9a7e77d3fa899b1a051536a6e9082ec71f` ("Release 1.25.1"; CHANGELOG 2026-10-08), zip SHA-256
  `f81b65ceaf390bc2430ca8205a787781873411b12681c842c5cb19a727a28e1b`, rebuilt twice from the commit before the tag and equal to the release asset's `.sha256`.
- Exact-commit CI 37809832942 (all 12 jobs green) before the tag; the owner pushed the tag on 2026-10-08 (a session's
  push was refused, HTTP 403, by the `v*` tag ruleset, as intended). Release run 37820056470 (success; the gate passed
  it as a patch with no `policy_exception`); published 2026-10-08T18:00:38Z, marked **Latest**.
- Assets: `suds-v1.25.1.zip` + `.sha256`, `suds-1.25.1-windows-x64.zip` (SHA-256 `b280651cc0d7de80ada82c751cade00538826621a3665a174ba601c9763d7d16`, unsigned: the code-signing
  secrets are not set) + `.sha256`.
- Pages: the `Web app` run succeeded; `gh-pages`' `version.json` reads **1.25.1**.
- SBOM: a patch keeps its minor's, `sbom-1.25.0` (describes `v1.25.0`, not 1.25.1's code; evaluation of 1.25.1, F6).
- The v1.25.0 Release notes carry the corrections block (`docs/evidence/release-notes-v1.25.0.md`), applied by the owner.

## v1.25.0: released

| Tag | Commit | CHANGELOG date | `suds-vX.Y.Z.zip` SHA-256 |
| --- | --- | --- | --- |
| `v1.25.0` | `82f92a00` ("Rebuild public assets for the 1.25.0 stamp"; stamp `1474829e` "Release 1.25.0", SBOM `b8f0808c`) | 2026-10-05 | `3a5002ad5ba7c242abb2cf6a51a21e1b628cbcfe06dbb25e7811b5d3dc3cc379` (verified against the release asset; rebuild with the command below) |

**How the checksum is made, and why it can be trusted before the release exists.** The release job builds
the zip with `git archive --format=zip --prefix="suds-vX.Y.Z/" -o suds-vX.Y.Z.zip <commit>` and hashes it with
`sha256sum` (`.github/workflows/release.yml`, *Package*; `scripts/package.js` does the same for `HEAD`). The
release job itself refuses to publish a Release whose zip is not byte for byte its own build
(`scripts/release-existing.js`).

**Still, compare before you record it anywhere.** After the release job has run, the `.sha256` beside its zip
must equal the value above. If it differs, the build is not what was reproduced here: do not record it, and find
out why (a git change on the runner that altered the zip bytes; compare `unzip -l` of both, file by file) before
anyone installs from it. Anyone can recheck the value from a clone at any time. Archive the **tag**, not the
"Release 1.25.0" commit: the stamp was split over three commits, and `1474829e` ("Release 1.25.0") still carries
1.24.4's kernel, so it archives to a different zip (`093c5d96…`). The tag `v1.25.0` is `82f92a00`, the commit
the release job built:

```bash
git fetch origin tag v1.25.0
git archive --format=zip --prefix=suds-v1.25.0/ -o suds-v1.25.0.zip v1.25.0 && sha256sum suds-v1.25.0.zip
# 3a5002ad5ba7c242abb2cf6a51a21e1b628cbcfe06dbb25e7811b5d3dc3cc379  suds-v1.25.0.zip
```

## Completed: v1.25.0 (2026-10-06)

- `v1.25.0` — commit `82f92a00686a17e9ff086409db8a6184f0a2d9b1` (stamp `1474829e` "Release 1.25.0", SBOM `b8f0808c`, asset rebuild `82f92a00`; CHANGELOG 2026-10-05), zip SHA-256 `3a5002ad5ba7c242abb2cf6a51a21e1b628cbcfe06dbb25e7811b5d3dc3cc379` (rebuilt from the tag with `git archive` on 2026-10-08 and equal to the release asset's `.sha256` and to GitHub's asset digest).

- Release run 37416362595 (success; exact-commit CI 37411130362, all jobs green except the expected `release-policy` 28-day gate, covered by the owner's `policy_exception`); published 2026-10-06T05:38:43Z, marked **Latest**. The `policy_exception` records the owner's explicit instruction ("Fix everything now, freeze lifts to 1.25.0", 2026-10-05) — not a security fix.

- Assets: `suds-v1.25.0.zip` (SHA-256 `3a5002ad5ba7c242abb2cf6a51a21e1b628cbcfe06dbb25e7811b5d3dc3cc379`) + `.sha256`, `suds-1.25.0-windows-x64.zip` (SHA-256
  `489ee896fb5bceaa875706b62198f346c973e0be423d9e7c90273a080d0f0754`, 47,299,927 bytes; unsigned) + `.sha256`. Both values were read
  from the release's `.sha256` assets on 2026-10-08 and equal GitHub's own asset digests; the source zip's was also
  rebuilt from the tag. They are the second channel for `upgrade.sh --release-sha256` (the Windows zip's had been
  recorded nowhere on `main` until then).

- SBOM: 1.25.0's SBOM (`sbom-1.25.0`, in the evidence index) was first generated from `1474829e`, whose kernel is 1.24.4's
  (`6fe02fce…`). It is regenerated from the tag (`node scripts/sbom.js --ref v1.25.0`, 2026-10-08) and now records commit `82f92a00` and the shipped kernel,
  SHA-256 `91a14310e7faa177abad1f1b52681796dc1e02d518fc2f4506c521dabda5bf58` (the same bytes gh-pages serves).

- Pages: the `Web app` run 37419567221 succeeded (the `tag/` path fix from 1.24.4 held). Live `version.json` reads **1.25.0**.

- Contains: dictionary-verified CalOMS code sets (all 17 from DHCS Oct 2024 v3.0) + migration 71, better resource pictures (every provider whose site allows an automated download; 40 of 81 on the published site, because many provider sites refuse automated downloads from the build server), UI intuitiveness pass (plainer call-form labels, accessible resource view toggle).

## Completed: v1.24.4 (2026-10-05)

- `v1.24.4` — commit `e71c3105d4926d4e22207f415916bce6e07d6676` (CHANGELOG 2026-10-05), zip SHA-256 `f3787da4bbf95b3f3cab14a8ab0542c73edf06e649a3bcab083dfbdb07d262b6` (verified against the downloaded release asset)

- Release run 37385754401 (success; exact-commit CI 37381511508, all 11 jobs green); published 2026-10-05T23:05:43Z, marked **Latest**.

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
