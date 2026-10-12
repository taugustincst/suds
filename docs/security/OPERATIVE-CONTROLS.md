# Operative controls

The release and repository controls that buyers are told about, and that work only if someone does something at each
release or keeps a setting on. For each one, this page gives its **state today** and **how it is checked**. It is short
on purpose. The evaluation of 1.25.5 (J11) found two of these controls off, unnoticed, under 25,000-word process
documents: the release checksum's second channel (J1) and private vulnerability reporting (J2).

**State as of 2026-10-12, newest release tag `v1.25.6`.** `scripts/release-state.js` reads the rows whose first cell
starts with an id it knows (`checksum-main`, `checksum-release`, `signed-tag`). It fails when a row's state (the bold
words that start its State cell) is not the true one for the newest tag, in either direction. CI runs it on every push
(the advisory `release-state` job). Change a row when the state changes. The other rows are checked where their last
column says.

| Control | State | How it is checked |
| --- | --- | --- |
| `checksum-main` The newest release's zip SHA-256 is on `main`: its CHANGELOG section has the line `SHA-256 of suds-vX.Y.Z.zip: <hex>`, equal to the value [RELEASE-HANDOFF.md](../evidence/RELEASE-HANDOFF.md) recorded before the tag. This is one of the two channels `upgrade.sh --release-sha256` is taken from ([../SELF-HOSTING.md](../SELF-HOSTING.md), *Upgrading*). | **in force** for v1.25.6, and filled in for the earlier releases whose value is recorded ([../RELEASE.md](../RELEASE.md), *The zip's SHA-256 in two places*) | `release-state`, offline and online |
| `checksum-release` The same line is in the GitHub Release's notes, the other channel. | **in force** for v1.25.6: `release.yml` wrote both zips' lines into its Release notes and read them back (the first release to have them). v1.25.5's notes still lack the line until the owner adds it (*Edit release*; the value is in RELEASE.md's table); `release-state` checks the newest tag only. | `release-state` online (unauthenticated GitHub API; "not checked" when the API cannot be read) |
| `signed-tag` The newest release tag is signed with a key only the owner holds, so a tag shows who vouched for the release. | **not signed**: no release tag has ever been signed. Owner action: [../RELEASE.md](../RELEASE.md), *Signing a release tag*. | `release-state`: whether the tag object carries a signature block. Whose key it is: `git tag -v` against the published key |
| `private-reporting` Private vulnerability reporting is on, as [../../SECURITY.md](../../SECURITY.md) tells reporters. | **off**: the API answered `{"enabled":false}` on 2026-10-11. Owner action: Settings → Code security → *Private vulnerability reporting* → Enable. | `scripts/repo-settings-check.js` (step 8), in the weekly *Repository settings* run |
| `tag-pusher` Who pushed the newest tag, and who approved its release. | **recorded**: the owner's business assistant pushed `v1.25.6`, `v1.25.5` and `v1.25.4` with the owner's GitHub access, on the owner's instruction, and approved the `release` environment. That identity also writes code, so a tag does not show the owner's own approval until tags are signed (`signed-tag`). | By hand: each tag's *Completed* entry in [RELEASE-HANDOFF.md](../evidence/RELEASE-HANDOFF.md). An unsigned tag's tagger proves nothing. |
| `evening-required` `evening` is one of `main`'s required status checks. The release gate has required it since 1.25.5. | **off**: not yet in `main`'s ruleset. Owner action: Settings → Rules → Rulesets → `main` → add `evening`. | `scripts/repo-settings-check.js` (step 2, the required-checks row), weekly |
| `flake-register` Every red required job on `main` has a row in the flake register, with its cause. | **by hand**: no script reads CI history for this. | Whoever prepares a stamp, before handing it over ([../RELEASE.md](../RELEASE.md), *Stamp checklist* and *Flake register*) |
