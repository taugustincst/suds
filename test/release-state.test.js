'use strict';
// scripts/release-state.js: what the documents say about the releases, against the CHANGELOG, git, origin's tags and
// gh-pages. The logic is tested with synthetic documents and git facts; the repository run is checked only in the
// parts that are deterministic for a tree (--docs-only), and a finding there must be one of the known ones below.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const RS = require('../scripts/release-state');

const SHA = (c) => c.repeat(40);
const ZIP = 'f'.repeat(64);
const ZIP110 = 'e'.repeat(64); // v1.1.0's, the newest pushed tag in the online world

/** A consistent set of documents: 1.3.0 and 1.2.0 stamped, both untagged, 1.3.0 live. */
function world(o = {}) {
  const docs = {
    pkg: JSON.stringify({ version: o.pkg || '1.3.0' }),
    changelog: o.changelog || [
      '# Changelog', '', '## Unreleased', '',
      '## 1.3.0 — 2026-10-01', '', `SHA-256 of suds-v1.3.0.zip: ${ZIP}`, '', '- **Supported versions**: 1.3.x is the latest minor, 1.2.x the previous.', '- The questionnaire is checked against 1.3.0.', '',
      '## 1.2.0 — 2026-09-01', '', `SHA-256 of suds-v1.2.0.zip: ${ZIP}`, '', '- Documents describe 1.2.0.', '',
      '## 1.1.0 — 2026-08-01', '', '- First.', '', `SHA-256 of suds-v1.1.0.zip: ${ZIP110}`, '',
    ].join('\n'),
    questionnaire: o.questionnaire || [
      '# Q', '', '**Checked against:** 1.3.0 (live on GitHub Pages; its tag is pending the owner).', '',
      '| # | Question | Answer |', '| --- | --- | --- |',
      '| 36 | CI? | Yes. The gate refuses a commit unless CI passed, but **1.2.0 and 1.3.0 were published without a tag** and without the gate. |',
      '| 39 | Release integrity? | See below. |', '',
      '**#39, release integrity, in detail.**', '', '**Releases 1.2.0 to 1.3.0 were published', 'without a tag.** Verify against the commit.', '',
      '**#45, offline, in detail:**', '', 'Text.', '',
    ].join('\n'),
    rfi: o.rfi !== undefined ? o.rfi : [
      '# RFI', '', '## Supply chain', '', '**Q. Dependencies?** None.', '',
      '**Q. Release integrity: how?** **Releases 1.2.0 to 1.3.0 were published without a tag**; verify the commit.', '',
      '**Q. Penetration testing?** None.', '',
    ].join('\n'),
    evidence: o.evidence || '# E\n\n**Version.** It describes 1.3.0; the owner has not tagged it yet.\n',
    release: o.release || [
      '# Releasing', '',
      '| Line | Gets | For how long |', '| --- | --- | --- |',
      '| **The latest minor** (today 1.3.x) | Every fix | Until the next minor |',
      '| **The previous minor** (today 1.2.x, until 30 days after 1.3.0\'s release date: `v1.3.0` is not pushed yet) | Security | 30 days |',
      '| Anything older (today 1.1.x and before) | Nothing | — |', '',
      'The exceptions in one place:', '', '| Release | Rule | Reason | By |', '| --- | --- | --- | --- |', '| 1.3.0 | monthly limit | asked | owner (*Record: 1.3.0*, below) |', '',
      '**Record: 1.3.0 ships under a policy exception.** Text.', '',
      '**Now two tags, in one push**: the tags owed are `v1.2.0` and `v1.3.0`.', '',
    ].join('\n'),
    handoff: o.handoff || [
      '# Release hand-off: tags v1.2.0 to v1.3.0', '',
      'Two versions are on `main` and released (1.3.0 is what GitHub Pages serves) but **none is tagged**.', '',
      '## The two releases', '',
      '| Tag | Commit | CHANGELOG date | SHA-256 |', '| --- | --- | --- | --- |',
      `| \`v1.2.0\` | \`${SHA('a')}\` | 2026-09-01 | \`${ZIP}\` |`,
      `| \`v1.3.0\` | \`${SHA('c')}\` ("SBOM of the 1.3.0 stamp", after the stamp \`bbbbbbb\`) | 2026-10-01 | \`${ZIP}\` |`, '',
      '```bash', 'for c in aaaaaaa $R13; do git merge-base --is-ancestor $c origin/main; done',
      `git tag -a v1.2.0 ${SHA('a')} -m "SUDS 1.2.0"`, 'git tag -a v1.3.0 "$R13" -m "SUDS 1.3.0"', 'git push origin v1.2.0 v1.3.0', '```', '',
      '## Completed: v1.1.0', '', `- \`v1.1.0\` — commit \`${SHA('1')}\` (CHANGELOG 2026-08-01), zip SHA-256`, `  \`${ZIP110}\`; the owner pushed the tag.`, '',
    ].join('\n'),
    notes: o.notes !== undefined ? o.notes : [
      '# Handoff', '', '### Release waiting', '',
      '- **1.2.0 and 1.3.0 are on `main`, and 1.3.0 is live, but none is tagged: the owner tags all two, in one push.**',
      '  `git push origin v1.2.0 v1.3.0`.', '', '### Next', '',
    ].join('\n'),
  };
  for (const k of Object.keys(docs)) if (o.patch && o.patch[k]) docs[k] = o.patch[k](docs[k]);
  return docs;
}
const goodGit = () => ({
  shallow: false, mainRef: 'origin/main',
  commits: {
    [SHA('a')]: { exists: true, subject: 'Release 1.2.0', parent: SHA('9'), parentSubject: 'x', onMain: true },
    [SHA('c')]: { exists: true, subject: 'SBOM of the 1.3.0 stamp', parent: SHA('b'), parentSubject: 'Release 1.3.0', onMain: true },
  },
});
const codes = (r) => r.problems.map((p) => p.code).sort();
/** The public API's answers in a world where the owner's protections are on (evaluation of 1.25.6, K1). */
const PROTECTED = { mainRules: { status: 'ok', rules: ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'] }, releaseRun: { tag: 'v1.1.0', status: 'ok', id: 7, runStatus: 'completed', conclusion: 'success', approvals: [{ state: 'approved' }] } };
/** As the API answered for this repository on 2026-10-12: no rule on main, and v1.25.6's run approved by no one. */
const UNPROTECTED = { mainRules: { status: 'ok', rules: [] }, releaseRun: { tag: 'v1.1.0', status: 'ok', id: 7, runStatus: 'completed', conclusion: 'success', approvals: [] } };

test('a consistent world has no problems, offline and online', () => {
  const docs = world();
  const off = RS.evaluate({ docs });
  assert.deepEqual(off.problems, []);
  assert.ok(off.notChecked.some((n) => /GitHub Pages/.test(n)) && off.notChecked.some((n) => /tags are pushed/.test(n)) && off.notChecked.some((n) => /commits/.test(n)), 'and says what it could not check');
  const on = RS.evaluate({ docs, git: goodGit(), remote: { tags: { 'v1.1.0': SHA('1') } }, pages: { version: '1.3.0', source: 'test' }, mainPkg: { version: '1.3.0', stamped: [] },
    newestTag: { tag: 'v1.1.0', signed: false }, releaseNotes: { tag: 'v1.1.0', status: 'ok', body: `Notes.\r\n\r\nSHA-256 of suds-v1.1.0.zip: ${ZIP110}\r\n` }, protections: PROTECTED });
  assert.deepEqual(on.problems, []);
  assert.deepEqual(on.notChecked, []);
});

test('the questionnaire and evidence index follow the stamped minor line', () => {
  const r = RS.evaluate({ docs: world({ patch: { questionnaire: (t) => t.replace('1.3.0', '1.2.0'), evidence: (t) => t.replace('1.3.0', '1.3.1') } }) });
  assert.deepEqual(codes(r), ['doc-version-behind', 'doc-version-behind', 'pages-disagree']);
  const q = r.problems.find((p) => p.file === RS.FILES.questionnaire && p.code === 'doc-version-behind');
  assert.equal(q.line, 3);
  assert.match(q.message, /names 1\.2\.0, not the 1\.3 line/);
});

test('supported versions: latest, previous (and its 30 days), older', () => {
  const r = RS.evaluate({ docs: world({ patch: { release: (t) => t.replace('today 1.3.x', 'today 1.2.x').replace('today 1.2.x, until 30 days after 1.3.0', 'today 1.1.x, until 30 days after 1.2.0').replace('today 1.1.x and before', 'today 1.0.x and before') } }) });
  assert.deepEqual(codes(r), ['supported-latest', 'supported-older', 'supported-previous', 'supported-previous-after']);
  assert.ok(r.problems.every((p) => p.file === 'docs/RELEASE.md' && p.line >= 5 && p.line <= 7), 'each at its row');
});

test('records, the ledger and the tags owed', () => {
  const r = RS.evaluate({ docs: world({ patch: { release: (t) => t.replace('| 1.3.0 | monthly', '| 1.4.0 | monthly').replace('(*Record: 1.3.0*', '(*Record: 1.2.0*').replace('the tags owed are `v1.2.0` and `v1.3.0`', 'the tags owed are `v1.2.0`').replace('Now two tags', 'Now three tags') } }) });
  assert.deepEqual(codes(r), ['ledger-unknown', 'owed-count', 'owed-mismatch', 'record-missing']);
});

test('the hand-off: dates, commands, loop, title and counts agree with its table', () => {
  const r = RS.evaluate({ docs: world({ patch: { handoff: (t) => t
    .replace('| 2026-09-01 |', '| 2026-09-02 |')
    .replace(`git tag -a v1.2.0 ${SHA('a')} -m "SUDS 1.2.0"`, `git tag -a v1.2.0 ${SHA('d')} -m "SUDS 1.2.1"`)
    .replace('git push origin v1.2.0 v1.3.0', 'git push origin v1.3.0')
    .replace('for c in aaaaaaa $R13', 'for c in eeeeeee $R13')
    .replace('tags v1.2.0 to v1.3.0', 'tags v1.1.0 to v1.3.0')
    .replace('## The two releases', '## The three releases') } }) });
  assert.deepEqual(codes(r), ['handoff-command', 'handoff-command', 'handoff-count', 'handoff-date', 'handoff-loop', 'handoff-push', 'handoff-title']);
});

test('the hand-off: a row the stamp cannot fill yet (the SBOM commit after it) is owed, and its commit is not checked', () => {
  const pending = (t) => t.replace(/^\| `v1\.3\.0` \|.*$/m, "| `v1.3.0` | the commit after `Release 1.3.0`, which adds its SBOM (`git log -1 --format=%H --grep='^SBOM of the 1.3.0 stamp' origin/main`) | 2026-10-01 | recorded in a later commit on `main` |");
  const docs = world({ patch: { handoff: pending } });
  const h = RS.parseHandoff(docs.handoff);
  assert.deepEqual([h.rows.map((r) => r.tag), h.pending.map((r) => r.tag)], [['v1.2.0'], ['v1.3.0']]);
  const r = RS.evaluate({ docs, git: goodGit() });
  assert.deepEqual(r.problems, [], 'its count, title, command, loop and push agree with the table');
  assert.ok(r.notChecked.some((n) => /v1\.3\.0's commit/.test(n)), 'and it says the commit was not checked');
  // Its date is still checked, and a pushed tag is still found.
  assert.deepEqual(codes(RS.evaluate({ docs: world({ patch: { handoff: (t) => pending(t).replace('| 2026-10-01 |', '| 2026-10-02 |') } }) })), ['handoff-date']);
  assert.ok(codes(RS.evaluate({ docs, remote: { tags: { 'v1.3.0': SHA('c') } } })).includes('handoff-tag-pushed'));
});

test('HANDOFF.md\'s Release waiting entry names the same tags, and exists while tags are owed', () => {
  let r = RS.evaluate({ docs: world({ patch: { notes: (t) => t.replace('1.2.0 and 1.3.0 are on', '1.3.0 is on').replace('git push origin v1.2.0 v1.3.0', 'git push origin v1.3.0').replace('all two', 'all three') } }) });
  assert.deepEqual(codes(r), ['notes-mismatch', 'notes-mismatch']);
  r = RS.evaluate({ docs: world({ notes: '# Handoff\n' }) });
  assert.deepEqual(codes(r), ['notes-missing']);
});

test('once the hand-off notes have moved to the private repository, HANDOFF.md is not cross-checked, and says so', () => {
  // HANDOFF.md absent, or a pointer marked as moved: no Release waiting entry is required while tags are owed, and
  // the result names what it did not check. A HANDOFF.md that is still the log keeps the check (the test above).
  for (const notes of [null, '# Handoff\n\n<!-- handoff: moved -->\nThe notes are in the private operations repository.\n']) {
    const r = RS.evaluate({ docs: world({ notes }) });
    assert.deepEqual(codes(r), [], String(notes));
    assert.ok(r.notChecked.some((n) => /HANDOFF\.md's \*Release waiting\* entry/.test(n)), 'it says the entry was not checked');
  }
});

test('live on GitHub Pages: against gh-pages, or against each other offline', () => {
  const docs = world({ patch: { evidence: (t) => `${t}\n1.2.0 (\`aaaaaaa\`, live on GitHub Pages) is released.\n` } });
  const off = RS.evaluate({ docs });
  assert.deepEqual(codes(off), ['pages-disagree']);
  assert.equal(off.problems[0].file, 'docs/evidence/README.md');
  assert.equal(off.problems[0].line, 5);
  const on = RS.evaluate({ docs, pages: { version: '1.3.0', source: 'test' } });
  assert.deepEqual(codes(on), ['pages-live']);
  const newer = RS.evaluate({ docs: world(), pages: { version: '1.4.0', source: 'test' } });
  assert.equal(newer.problems.filter((p) => p.code === 'pages-live').length, 3, 'every claim of 1.3.0 is stale once 1.4.0 is live');
  assert.deepEqual(RS.liveClaims('x 1.2.0 (`abc`, live on GitHub Pages) and 1.3.0 is what GitHub Pages serves; 1.3.0 is live.').map((c) => c.version), ['1.3.0', '1.3.0', '1.2.0']);
});

test('the hand-off\'s commits: present, on main, a stamp or the SBOM commit after it', () => {
  const docs = world();
  const git = goodGit();
  git.commits[SHA('a')].subject = 'Merge branch x';
  git.commits[SHA('c')].parent = SHA('e');
  git.commits[SHA('c')].onMain = false;
  assert.deepEqual(codes(RS.evaluate({ docs, git })), ['handoff-commit-message', 'handoff-commit-message', 'handoff-commit-not-on-main']);
  const gone = { shallow: false, mainRef: 'origin/main', commits: { [SHA('a')]: { exists: false } } };
  assert.deepEqual(codes(RS.evaluate({ docs, git: gone })), ['handoff-commit-missing', 'handoff-commit-missing']);
  const shallow = RS.evaluate({ docs, git: { ...gone, shallow: true } });
  assert.deepEqual(shallow.problems, [], 'a shallow clone cannot say, and says so');
  assert.ok(shallow.notChecked.some((n) => /shallow/.test(n)));
  const noMain = RS.evaluate({ docs, git: { ...goodGit(), mainRef: null, commits: Object.fromEntries(Object.entries(goodGit().commits).map(([k, v]) => [k, { ...v, onMain: null }])) } });
  assert.deepEqual(noMain.problems, []);
  assert.ok(noMain.notChecked.some((n) => /on main/.test(n)));
});

test('tags: a pushed tag the documents call pending, a tag at another commit, a stamped version nobody lists', () => {
  const docs = world();
  const pushed = RS.evaluate({ docs, remote: { tags: { 'v1.3.0': SHA('c') } } });
  // The hand-off row, the questionnaire, the evidence index, RELEASE.md and HANDOFF.md all still call it pending.
  assert.deepEqual(codes(pushed), ['handoff-tag-pushed', 'tag-claim-stale', 'tag-claim-stale', 'tag-claim-stale', 'tag-claim-stale']);
  const elsewhere = RS.evaluate({ docs, remote: { tags: { 'v1.2.0': SHA('9') } } });
  assert.ok(codes(elsewhere).includes('handoff-tag-elsewhere'));
  // 1.4.0 stamped on origin/main, newer than every pushed tag, in no hand-off.
  const unlisted = RS.evaluate({ docs, remote: { tags: { 'v1.1.0': SHA('1') } }, mainPkg: { version: '1.4.0', stamped: [{ version: '1.4.0', date: '2026-11-01', line: 5 }] } });
  assert.deepEqual(codes(unlisted), ['untagged-unlisted']);
  assert.match(unlisted.problems[0].message, /1\.4\.0 is stamped/);
});

test('untagged releases: QUESTIONNAIRE #36, #39 and the RFI answer say "published without a tag" and name the range', () => {
  assert.equal(RS.UNTAGGED_MARKER, 'published without a tag');
  // Each place without the marker is a problem, at its own line.
  const drop = (t) => t.replace(/published\s+without a tag/g, 'released');
  const r = RS.evaluate({ docs: world({ patch: { questionnaire: drop, rfi: drop } }) });
  assert.deepEqual(codes(r), ['untagged-undisclosed', 'untagged-undisclosed', 'untagged-undisclosed']);
  assert.deepEqual(r.problems.map((p) => `${p.file}:${p.line}`).sort(), ['docs/market/templates/COUNTY-RFI-ANSWERS.md:7', 'docs/security/QUESTIONNAIRE.md:10', 'docs/security/QUESTIONNAIRE.md:7']);
  assert.match(r.problems[0].message + r.problems[1].message, /1\.2\.0 to 1\.3\.0/);
  // #39's row alone, without its detail section, is enough when it says it; a missing #36 row or RFI answer is not.
  const q39row = (t) => t.replace('| 39 | Release integrity? | See below. |', '| 39 | Release integrity? | 1.2.0 to 1.3.0 were published without a tag. |').replace(/\*\*#39,[\s\S]*?(?=\*\*#45)/, '');
  assert.deepEqual(codes(RS.evaluate({ docs: world({ patch: { questionnaire: q39row } }) })), []);
  const no36 = RS.evaluate({ docs: world({ patch: { questionnaire: (t) => t.replace(/^\| 36 .*$/m, ''), rfi: (t) => t.replace(/\*\*Q\. Release integrity[^\n]*\n/, '') } }) });
  assert.deepEqual(codes(no36), ['untagged-undisclosed', 'untagged-undisclosed']);
  // The marker, but a range that stops short of the newest untagged release.
  const short = RS.evaluate({ docs: world({ patch: { rfi: (t) => t.replace('1.2.0 to 1.3.0', '1.2.0 and 1.2.1') } }) });
  assert.deepEqual(codes(short), ['untagged-range']);
  assert.match(short.problems[0].message, /does not name 1\.3\.0/);
  assert.deepEqual(codes(RS.evaluate({ docs: world({ patch: { rfi: (t) => t.replace('1.2.0 to 1.3.0', '1.2.0 to 1.3.01') } }) })), ['untagged-range'], 'a longer version is not a match');
  // Origin's tags: once every owed tag is pushed nothing is owed, and the disclosure is no longer required.
  const allPushed = { tags: { 'v1.2.0': SHA('a'), 'v1.3.0': SHA('c') } };
  const done = RS.evaluate({ docs: world({ patch: { questionnaire: drop, rfi: drop } }), remote: allPushed });
  assert.ok(!codes(done).some((c) => c.startsWith('untagged-')), 'nothing untagged, nothing to disclose');
  // ls-remote alone: a stamped version newer than the newest pushed tag counts, even with no hand-off row.
  const noHandoff = world({ handoff: '# Release hand-off\n', notes: '# Handoff\n', patch: { questionnaire: drop } });
  const viaRemote = RS.evaluate({ docs: noHandoff, remote: { tags: { 'v1.1.0': SHA('1') } } });
  // (1.2.0 and 1.3.0 are each also "untagged-unlisted": stamped, unpushed and in no hand-off; the RFI answer says it.)
  assert.deepEqual(codes(viaRemote).filter((c) => c.startsWith('untagged-')), ['untagged-undisclosed', 'untagged-undisclosed', 'untagged-unlisted', 'untagged-unlisted']);
  assert.match(viaRemote.problems.find((p) => p.code === 'untagged-undisclosed').message, /1\.2\.0 to 1\.3\.0/);
  // No RFI file: said, not a problem.
  const noRfi = RS.evaluate({ docs: world({ rfi: null }) });
  assert.deepEqual(noRfi.problems, []);
  assert.ok(noRfi.notChecked.some((n) => /RFI/.test(n)));
});

test('untagged releases: the repository\'s own answers carry the disclosure, and the check bites on them', () => {
  const root = path.join(__dirname, '..');
  const docs = RS.run(root, { mode: 'docs-only' });
  assert.ok(!docs.problems.some((p) => p.code.startsWith('untagged-')), 'QUESTIONNAIRE #36, #39 and the RFI answer disclose the untagged releases');
  const fs = require('node:fs');
  const real = {};
  for (const [k, f] of Object.entries(RS.FILES)) real[k] = fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : null;
  const h = RS.parseHandoff(real.handoff);
  if (h.rows.length + h.pending.length === 0) return; // every tag pushed: nothing to disclose
  const secs = RS.disclosureSections(real.questionnaire, real.rfi);
  assert.equal(secs.length, 3, '#36, #39 and the RFI answer are found');
  assert.ok(secs.every((s) => s.text && s.text.length > 40), 'each with its text');
  const stripped = { ...real, questionnaire: real.questionnaire.replace(/published\s+without\s+a\s+tag/gi, 'released'), rfi: real.rfi.replace(/published\s+without\s+a\s+tag/gi, 'released') };
  const r = RS.evaluate({ docs: stripped });
  assert.equal(r.problems.filter((p) => p.code === 'untagged-undisclosed').length, 3, 'without the marker, each of the three places is a finding');
});

test('the CHANGELOG lint: another version called current inside a dated section', () => {
  const log = [
    '## Unreleased', '', '- 1.1.x is the latest minor (not dated: not checked).', '',
    '## 1.3.0 — 2026-10-01', '',
    '- **Supported versions**: **1.2.x** is the latest minor, 1.1.x the previous.',
    '- The questionnaire is checked', '  against 1.2.0, and the documents describe 1.2.0.',
    '- Market lines: county-entered figures, built for 1.4.0, not yet released; 1.2.0 is not yet released.',
    '- Part of fix release 1.2.1.',
    '- The previous minor (today 1.2.x) keeps security fixes. Checked against 1.3.0 and describes 1.3.0.', '',
    '## 1.2.0 — 2026-09-01', '', '- The security questionnaire was checked against 1.1.0.', '',
    '## 1.1.0 — 2026-08-01', '',
  ].join('\n');
  const found = RS.lintChangelog(log, []);
  assert.deepEqual(found.map((f) => [f.line, f.found]), [
    [7, '1.2.x is the latest minor'],
    [7, '1.1.x the previous'],
    [8, 'checked against 1.2.0'],
    [9, 'describe 1.2.0'],
    [10, 'built for 1.4.0, not yet released'],
    [10, '1.2.0 is not yet released'],
    [11, 'fix release 1.2.1'],
    [16, 'checked against 1.1.0'],
  ]);
  // The allow-list takes a documented historical line out, in its own section only.
  const allowed = RS.lintChangelog(log, [{ section: '1.2.0', text: 'checked against 1.1.0', reason: 'history' }]);
  assert.equal(allowed.length, found.length - 1);
  assert.ok(RS.CHANGELOG_ALLOW.every((a) => a.section && a.text && a.reason.length > 20), 'every allowed line says why');
});

test('parsers read the real documents\' shapes', () => {
  const fs = require('node:fs');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const h = RS.parseHandoff(read(RS.FILES.handoff));
  // The table's contents change with every release (rows owed, filled, then removed once the tags are pushed), so
  // this asserts what holds for any state of it, never today's counts: pinning the counts made main's CI red each
  // time a release record moved (three flips in four hours on 2026-10-05/06).
  assert.ok(Array.isArray(h.rows) && Array.isArray(h.pending || []) && Array.isArray(h.tagCommands), 'the parser reads the table, whatever it holds');
  assert.ok(h.rows.every((r) => /^v\d+\.\d+\.\d+$/.test(r.tag) && r.commit.length === 40), 'every completed row names a tag and its commit');
  assert.ok((h.pending || []).every((r) => /^v\d+\.\d+\.\d+$/.test(r.tag)), 'every pending row names its tag');
  assert.equal(h.tagCommands.length, h.rows.length + h.pending.length, 'one tag command per row (a row the stamp cannot fill yet included)');
  const rel = RS.parseRelease(read(RS.FILES.release));
  assert.ok(rel.latest && rel.previous && rel.older, 'the supported-versions rows are read');
  assert.ok(rel.records.length > 0 && rel.ledger.length > 0, 'the records and the ledger are read');
  assert.ok(RS.parseQuestionnaire(read(RS.FILES.questionnaire)), 'the questionnaire line is read');
  assert.ok(RS.parseEvidence(read(RS.FILES.evidence)), 'the evidence line is read');
});

// Findings the repository had when this check was written (1.21.0 development) were fixed by the documentation stream
// of the same release and the 1.21 review (the last: a 1.20.0 CHANGELOG line recording the questionnaire's earlier
// check in words the check reads as stale). A finding in this list is tolerated; the list is empty, so none is.
const KNOWN = [];

test('the repository: the documents alone (deterministic) raise no finding but the known ones', () => {
  // HANDOFF.md is a log between assistants, not a buyer document: its "is live" claims are left out of this required
  // test (evaluation of 1.25.6, K5: a HANDOFF-only commit turned main's required `test` job red). The advisory
  // `release-state` job (the CLI) still checks them.
  const r = RS.run(path.join(__dirname, '..'), { mode: 'docs-only', notesLive: false });
  const unexpected = r.problems.filter((p) => !KNOWN.some(([f, m]) => p.file === f && p.message === m));
  assert.deepEqual(unexpected.map((p) => `${p.file}:${p.line}: ${p.message}`), []);
  assert.ok(r.notChecked.length >= 2, 'and it says what it did not check');
});

test('the CLI runs offline and reports what it could not check', () => {
  let out; let status = 0;
  try { out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release-state.js'), '--offline', '--json'], { encoding: 'utf8' }); } catch (e) { out = e.stdout; status = e.status; }
  assert.ok(status === 0 || status === 1, `exit 0 or 1, not ${status}`);
  const r = JSON.parse(out);
  assert.ok(r.notChecked.some((n) => /--offline/.test(n)), 'says it did not ask origin');
  assert.ok(Array.isArray(r.problems) && r.problems.every((p) => p.file && p.line > 0 && p.fix));
});

// ---- The release checksum in two channels, and the operative controls page (evaluation of 1.25.5, J1, J3, J11) ----
const CONTROLS = (o = {}) => [
  '# Operative controls', '', '| Control | State | How it is checked |', '| --- | --- | --- |',
  `| \`checksum-main\` On main. | **${o.main || 'in force'}** for v1.1.0 | release-state |`,
  `| \`checksum-release\` In the Release notes. | **${o.release || 'in force'}** | release-state online |`,
  `| \`signed-tag\` Signed. | **${o.signed || 'not signed'}**: owner action | release-state |`,
  '| `private-reporting` Private reporting. | **off** | repo-settings-check |',
  `| \`main-ruleset\` Main. | **${o.mainRuleset || 'in force'}** | release-state online |`,
  `| \`release-reviewer\` Reviewer. | **${o.reviewer || 'in force'}** | release-state online |`,
  `| \`immutable-releases\` Immutable. | **${o.immutable || 'in force'}** | release-state online |`, '',
].join('\n');
const NEWEST = { tag: 'v1.1.0', signed: false };
const notesWith = (hex, extra = '') => ({ tag: 'v1.1.0', status: 'ok', body: `Notes.\n\nSHA-256 of suds-v1.1.0.zip: ${hex}\n${extra}` });

test('the newest tag\'s zip SHA-256 is in its CHANGELOG section, equal to the hand-off\'s record', () => {
  const ok = RS.evaluate({ docs: world(), newestTag: NEWEST });
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.info.some((i) => /newest tag is v1\.1\.0/.test(i)) && ok.info.some((i) => /v1\.1\.0 is not signed/.test(i)));
  assert.ok(ok.notChecked.some((n) => /v1\.1\.0's GitHub Release notes \(not fetched/.test(n)), 'offline: the Release notes are not checked, and it says so');
  // Missing: the fix names the line with the recorded value.
  const missing = RS.evaluate({ docs: world({ patch: { changelog: (t) => t.replace(/^SHA-256 of suds-v1\.1\.0\.zip: .*\n/m, '') } }), newestTag: NEWEST });
  assert.deepEqual(codes(missing), ['checksum-changelog-missing']);
  assert.equal(missing.problems[0].file, 'CHANGELOG.md');
  assert.match(missing.problems[0].fix, new RegExp(`SHA-256 of suds-v1\\.1\\.0\\.zip: ${ZIP110}`));
  // Another value than the hand-off recorded before the tag.
  const differs = RS.evaluate({ docs: world({ patch: { changelog: (t) => t.replace(ZIP110, 'd'.repeat(64)) } }), newestTag: NEWEST });
  assert.deepEqual(codes(differs), ['checksum-changelog-differs']);
  // A list item and backticks are read too; another version's line, or a longer value, is not this one.
  assert.deepEqual(RS.checksumLines(`- SHA-256 of \`suds-v1.1.0.zip\`: \`${ZIP110}\``, 'suds-v1.1.0.zip').map((c) => c.hex), [ZIP110]);
  assert.deepEqual(RS.checksumLines(`SHA-256 of suds-v1.1.00.zip: ${ZIP110}\nSHA-256 of suds-v1.1.0.zip: ${ZIP110}0`, 'suds-v1.1.0.zip'), []);
  // The hand-off records none, or two different values.
  const unrecorded = RS.evaluate({ docs: world({ patch: { handoff: (t) => t.replace(/zip SHA-256\n {2}`e+`/, 'zip SHA-256 unknown') } }), newestTag: NEWEST });
  assert.deepEqual(codes(unrecorded), ['checksum-unrecorded']);
  const two = RS.evaluate({ docs: world({ patch: { handoff: (t) => `${t}\n\`\`\`\n# ${'c'.repeat(64)}  suds-v1.1.0.zip\n\`\`\`\n` } }), newestTag: NEWEST });
  assert.deepEqual(codes(two), ['checksum-handoff-disagrees']);
  // Older releases are not asked for the line (the Releases up to 1.25.5 were published without it).
  assert.deepEqual(RS.evaluate({ docs: world({ patch: { changelog: (t) => t.replace(/^SHA-256 of suds-v1\.1\.0\.zip: .*\n/m, '') } }), newestTag: { tag: 'v1.3.0', signed: false } }).problems.filter((p) => p.code.startsWith('checksum-') && /1\.1\.0/.test(p.message)), []);
  // A newest tag with no dated section.
  assert.deepEqual(codes(RS.evaluate({ docs: world(), newestTag: { tag: 'v1.0.0', signed: false } })), ['checksum-no-section', 'checksum-unrecorded']);
});

test('online, the GitHub Release notes carry the same line; unreachable or no Release is "not checked"', () => {
  const docs = world();
  assert.deepEqual(RS.evaluate({ docs, newestTag: NEWEST, releaseNotes: notesWith(ZIP110) }).problems, []);
  const missing = RS.evaluate({ docs, newestTag: NEWEST, releaseNotes: { tag: 'v1.1.0', status: 'ok', body: 'Notes.\n\n---\nReleased by @x.' } });
  assert.deepEqual(codes(missing), ['checksum-release-missing']);
  assert.equal(missing.problems[0].file, 'GitHub Release v1.1.0');
  assert.match(missing.problems[0].fix, /Edit release/);
  const differs = RS.evaluate({ docs, newestTag: NEWEST, releaseNotes: notesWith('d'.repeat(64)) });
  assert.deepEqual(codes(differs), ['checksum-release-differs']);
  // The Windows zip's line, when the notes and the record both give one, must agree too.
  const win = RS.evaluate({ docs: world({ patch: { handoff: (t) => `${t}\n- Windows zip: \`suds-1.1.0-windows-x64.zip\`, SHA-256 \`${'a'.repeat(64)}\`.\n` } }), newestTag: NEWEST, releaseNotes: notesWith(ZIP110, `\nSHA-256 of suds-1.1.0-windows-x64.zip: ${'b'.repeat(64)}\n`) });
  assert.deepEqual(codes(win), ['checksum-release-differs']);
  for (const [notes, re] of [[{ tag: 'v1.1.0', status: 'none' }, /no GitHub Release for v1\.1\.0 yet/], [{ tag: 'v1.1.0', status: 'unreachable', detail: 'api.github.com answered HTTP 403: rate limit' }, /HTTP 403: rate limit/]]) {
    const r = RS.evaluate({ docs, newestTag: NEWEST, releaseNotes: notes });
    assert.deepEqual(r.problems, []);
    assert.ok(r.notChecked.some((n) => re.test(n)), String(re));
  }
});

test('fetchReleaseNotes: GET /repos/<repo>/releases/tags/<tag>; 404 is no Release, anything else unreadable', async () => {
  const asked = [];
  const get = (status, body, error) => async (url) => { asked.push(url); return { status, body, error }; };
  assert.deepEqual(await RS.fetchReleaseNotes('o/r', 'v1.1.0', get(200, { body: 'x' })), { tag: 'v1.1.0', status: 'ok', body: 'x' });
  assert.match(asked[0], /\/repos\/o\/r\/releases\/tags\/v1\.1\.0$/);
  assert.equal((await RS.fetchReleaseNotes('o/r', 'v1.1.0', get(404, {}))).status, 'none');
  const limited = await RS.fetchReleaseNotes('o/r', 'v1.1.0', get(403, { message: 'API rate limit exceeded' }));
  assert.deepEqual([limited.status, /HTTP 403: API rate limit/.test(limited.detail)], ['unreachable', true]);
  assert.match((await RS.fetchReleaseNotes('o/r', 'v1.1.0', get(0, null, 'ENOTFOUND'))).detail, /could not be reached: ENOTFOUND/);
  assert.equal((await RS.fetchReleaseNotes(null, 'v1.1.0', get(200, {}))).status, 'unreachable', 'no repository known');
});

test('the operative controls page claims only what is true for the newest tag', () => {
  const ev = (o, extra = {}) => RS.evaluate({ docs: { ...world(), controls: CONTROLS(o) }, newestTag: NEWEST, ...extra });
  assert.deepEqual(ev({}, { releaseNotes: notesWith(ZIP110) }).problems, []);
  // "signed" while the tag is not.
  const signed = ev({ signed: 'signed' });
  assert.deepEqual(codes(signed), ['controls-claim']);
  assert.match(signed.problems[0].message, /`signed-tag` row says "signed"; for the newest tag it is "not signed"/);
  assert.equal(signed.problems[0].file, 'docs/security/OPERATIVE-CONTROLS.md');
  // "not signed" once it is signed is stale too.
  assert.deepEqual(codes(ev({}, { newestTag: { tag: 'v1.1.0', signed: true } })), ['controls-claim']);
  // The checksum in the Release notes: "in force" while the notes lack it; "missing" once they carry it.
  assert.deepEqual(codes(ev({}, { releaseNotes: { tag: 'v1.1.0', status: 'ok', body: '' } })), ['checksum-release-missing', 'controls-claim']);
  assert.deepEqual(codes(ev({ release: 'missing' }, { releaseNotes: notesWith(ZIP110) })), ['controls-claim']);
  // Not known (offline): no claim about it is judged.
  assert.deepEqual(ev({ release: 'missing' }).problems, []);
  assert.deepEqual(codes(RS.evaluate({ docs: { ...world({ patch: { changelog: (t) => t.replace(/^SHA-256 of suds-v1\.1\.0\.zip: .*\n/m, '') } }), controls: CONTROLS() }, newestTag: NEWEST })), ['checksum-changelog-missing', 'controls-claim']);
  // A state it does not know, a row or the page missing.
  assert.deepEqual(codes(ev({ signed: 'planned' })), ['controls-state-unknown']);
  assert.deepEqual(codes(RS.evaluate({ docs: { ...world(), controls: CONTROLS().replace(/^\| `signed-tag`.*\n/m, '') } })), ['controls-row-missing']);
  assert.deepEqual(codes(RS.evaluate({ docs: { ...world(), controls: null } })), ['controls-missing']);
});

test('readNewestTag: the newest v* tag, and whether its tag object carries a signature', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-tags-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env }).trim();
  try {
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'one');
    assert.equal(RS.readNewestTag(dir, null), null, 'no tag');
    git('tag', '-a', 'v1.9.0', '-m', 'SUDS 1.9.0'); git('tag', '-a', 'v1.10.0', '-m', 'SUDS 1.10.0'); git('tag', 'other');
    assert.deepEqual(RS.readNewestTag(dir, null), { tag: 'v1.10.0', signed: false, source: 'this clone\'s tags' }, 'by version, not by name');
    // A tag object with a signature block, as `git tag -s` writes one (mktag does not check the signature).
    const head = git('rev-parse', 'HEAD');
    const obj = `object ${head}\ntype commit\ntag v1.11.0\ntagger t <t@example.invalid> 1791677705 +0000\n\nSUDS 1.11.0\n-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n`;
    const sha = execFileSync('git', ['mktag'], { cwd: dir, input: obj, encoding: 'utf8', env }).trim();
    git('update-ref', 'refs/tags/v1.11.0', sha);
    assert.equal(RS.readNewestTag(dir, null).signed, true);
    // Online, origin's list decides which is newest; a tag not fetched here cannot be judged.
    assert.deepEqual(RS.readNewestTag(dir, { tags: { 'v1.9.0': head, 'v2.0.0': head } }), { tag: 'v2.0.0', signed: null, source: 'origin' });
    git('tag', 'v2.0.0');
    assert.equal(RS.readNewestTag(dir, { tags: { 'v2.0.0': head } }).signed, false, 'a lightweight tag has no signature');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the real documents: the hand-off records v1.25.5\'s zips, the CHANGELOG carries them, the controls page parses', () => {
  const fs = require('node:fs');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const rec = RS.recordedChecksums(read(RS.FILES.handoff), '1.25.5');
  assert.deepEqual([...new Set(rec.source.map((r) => r.hex))], ['319d1c1b9de96c52ce67503d0a460092149d96a6591aad2a1b448ac941956736']);
  assert.deepEqual([...new Set(rec.windows.map((r) => r.hex))], ['69d25c33e4e350373b11fbd368424dc1863631118c31d69150864c1deb4fe9a1']);
  const sec = RS.changelogSection(read(RS.FILES.changelog), '1.25.5');
  assert.deepEqual(RS.checksumLines(sec.text, 'suds-v1.25.5.zip').map((c) => c.hex), [rec.source[0].hex]);
  const rows = RS.parseControls(read(RS.FILES.controls));
  for (const [id, states] of Object.entries(RS.CONTROL_STATES)) assert.ok(rows[id] && rows[id].state in states, `${id}: ${rows[id] && rows[id].state}`);
  for (const id of ['private-reporting', 'tag-pusher', 'evening-required', 'flake-register']) assert.ok(rows[id], `${id} row`);
});

// ---- Evaluation of 1.25.6: K5 (HANDOFF.md out of the required cross-check), K7 (the checksum line before the tag),
// K1 (the repository protections against OPERATIVE-CONTROLS.md) ----

test('K5: HANDOFF.md\'s "is live" claims can be left out (the required test), and are checked otherwise', () => {
  // As on main at a85b6e0: HANDOFF.md says the next version is live before the records commit moved the others.
  const docs = world({ patch: { notes: (t) => t.replace('1.3.0 is live', '1.4.0 is live') } });
  const all = RS.evaluate({ docs });
  assert.deepEqual(codes(all), ['pages-disagree']);
  assert.equal(all.problems[0].file, 'HANDOFF.md');
  assert.deepEqual(RS.evaluate({ docs, notesLive: false }).problems, []);
  // Online, against gh-pages, the same option leaves it out too; the buyer documents are still checked.
  assert.deepEqual(codes(RS.evaluate({ docs, notesLive: false, pages: { version: '1.4.0', source: 'test' } })), ['pages-live', 'pages-live'], 'the questionnaire and the hand-off');
  assert.ok(RS.evaluate({ docs, notesLive: false, pages: { version: '1.4.0', source: 'test' } }).problems.every((p) => p.file !== 'HANDOFF.md'));
  assert.deepEqual(RS.REQUIRED_LIVE_DOCS, RS.LIVE_DOCS.filter((k) => k !== 'notes'));
});

test('K7: a version handed over for tagging carries its zip\'s SHA-256 in its CHANGELOG section, equal to the hand-off\'s', () => {
  // world(): v1.2.0 and v1.3.0 are owed, each row names its commit and zip, and each section has the line.
  assert.deepEqual(RS.evaluate({ docs: world() }).problems, []);
  const drop = (v) => (t) => t.replace(new RegExp(`^SHA-256 of suds-v${v.replace(/\./g, '\\.')}\\.zip: .*\\n`, 'm'), '');
  const missing = RS.evaluate({ docs: world({ patch: { changelog: drop('1.3.0') } }) });
  assert.deepEqual(codes(missing), ['checksum-changelog-missing']);
  assert.equal(missing.problems[0].file, 'CHANGELOG.md');
  assert.match(missing.problems[0].message, /v1\.3\.0 is handed over for tagging/);
  assert.match(missing.problems[0].fix, new RegExp(`SHA-256 of suds-v1\\.3\\.0\\.zip: ${ZIP}.*tag hand-off commit, before the tag`));
  const differs = RS.evaluate({ docs: world({ patch: { changelog: (t) => t.replace(`SHA-256 of suds-v1.2.0.zip: ${ZIP}`, `SHA-256 of suds-v1.2.0.zip: ${'d'.repeat(64)}`) } }) });
  assert.deepEqual(codes(differs), ['checksum-changelog-differs']);
  // A row the stamp cannot fill yet (no commit, no zip): the line is accepted, and not required.
  const pending = (t) => t.replace(/^\| `v1\.3\.0` \|.*$/m, "| `v1.3.0` | the commit after `Release 1.3.0` | 2026-10-01 | recorded in a later commit on `main` |");
  assert.deepEqual(RS.evaluate({ docs: world({ patch: { handoff: pending } }) }).problems, []);
  assert.deepEqual(RS.evaluate({ docs: world({ patch: { handoff: pending, changelog: drop('1.3.0') } }) }).problems, []);
  // Once the tag is the newest, section 9 checks it (one finding, not two).
  assert.deepEqual(codes(RS.evaluate({ docs: world({ patch: { changelog: drop('1.3.0') } }), newestTag: { tag: 'v1.3.0', signed: false } })), ['checksum-changelog-missing']);
});

test('K1: the operative controls page against the public API: main\'s rules, the release run\'s approvals, an immutable Release', () => {
  const ev = (o, extra = {}) => RS.evaluate({ docs: { ...world(), controls: CONTROLS(o) }, newestTag: NEWEST, releaseNotes: { ...notesWith(ZIP110), immutable: true }, ...extra });
  assert.deepEqual(ev({}, { protections: PROTECTED }).problems, []);
  // The repository as it is: the page says "in force"; the API says no rule on main and no approval.
  const today = ev({}, { protections: UNPROTECTED, releaseNotes: { ...notesWith(ZIP110), immutable: false } });
  assert.deepEqual(today.problems.map((p) => p.message), [
    'the `main-ruleset` row says "in force"; for the newest tag it is "off"',
    'the `release-reviewer` row says "in force"; for the newest tag it is "off"',
    'the `immutable-releases` row says "in force"; for the newest tag it is "off"',
  ]);
  assert.ok(today.info.some((i) => /main's rules \(rules\/branches\/main\): none/.test(i)));
  assert.ok(today.info.some((i) => /release run 7 succeeded with no approval recorded/.test(i)));
  // The page saying "off" is right today, and wrong once the owner has made the settings.
  assert.deepEqual(ev({ mainRuleset: 'off', reviewer: 'off', immutable: 'off' }, { protections: UNPROTECTED, releaseNotes: { ...notesWith(ZIP110), immutable: false } }).problems, []);
  assert.deepEqual(codes(ev({ mainRuleset: 'off', reviewer: 'off' }, { protections: PROTECTED })), ['controls-claim', 'controls-claim']);
  // A ruleset without all of step 2's rules is not "in force".
  assert.deepEqual(codes(ev({}, { protections: { ...PROTECTED, mainRules: { status: 'ok', rules: ['deletion', 'non_fast_forward'] } } })), ['controls-claim']);
  // A run waiting for its reviewer shows the reviewer is there; a run that failed before the release job says nothing.
  assert.deepEqual(ev({}, { protections: { ...PROTECTED, releaseRun: { ...UNPROTECTED.releaseRun, runStatus: 'waiting', conclusion: null } } }).problems, []);
  const failed = ev({ reviewer: 'off' }, { protections: { ...PROTECTED, releaseRun: { ...UNPROTECTED.releaseRun, conclusion: 'failure' } } });
  assert.deepEqual(failed.problems, []);
  assert.ok(failed.notChecked.some((n) => /run 7 is completed, failure, with no approval recorded/.test(n)));
  // Rate-limited, no run, or offline: "not checked", and no claim is judged.
  for (const p of [{ mainRules: { status: 'unreachable', detail: 'api.github.com answered HTTP 403: API rate limit exceeded' }, releaseRun: { tag: 'v1.1.0', status: 'unreachable', detail: 'api.github.com answered HTTP 403: API rate limit exceeded' } }, { mainRules: { status: 'unreachable', detail: 'x' }, releaseRun: { tag: 'v1.1.0', status: 'none' } }, null]) {
    const r = ev({ mainRuleset: 'off', reviewer: 'in force' }, { protections: p });
    assert.deepEqual(r.problems, [], JSON.stringify(p));
    assert.ok(r.notChecked.some((n) => /main's rules|repository protections/.test(n)));
  }
  // The real page names every row it can verify, in a state this script knows.
  const fs = require('node:fs');
  const rows = RS.parseControls(fs.readFileSync(path.join(__dirname, '..', RS.FILES.controls), 'utf8'));
  for (const id of ['main-ruleset', 'release-reviewer', 'immutable-releases', 'tag-ruleset', 'pages-ruleset', 'evening-required']) assert.ok(rows[id], `${id} row`);
});

test('fetchProtections: rules/branches/main, the tag commit\'s "Release" run and its approvals; anything else is "not checked"', async () => {
  const SHA_T = 'a'.repeat(40);
  const answers = {
    'https://api.github.com/repos/o/r/rules/branches/main': { status: 200, body: [] },
    [`https://api.github.com/repos/o/r/actions/runs?event=push&head_sha=${SHA_T}&per_page=100`]: { status: 200, body: { workflow_runs: [{ id: 5, name: 'CI', status: 'completed', conclusion: 'success' }, { id: 6, name: 'Release', status: 'completed', conclusion: 'success' }] } },
    'https://api.github.com/repos/o/r/actions/runs/6/approvals': { status: 200, body: [] },
  };
  const asked = [];
  const get = (over = {}) => async (url) => { asked.push(url); return over[url] || answers[url] || { status: 404, body: { message: 'Not Found' } }; };
  const p = await RS.fetchProtections('o/r', 'v1.1.0', SHA_T, get());
  assert.deepEqual(p, { mainRules: { status: 'ok', rules: [] }, releaseRun: { tag: 'v1.1.0', status: 'ok', id: 6, runStatus: 'completed', conclusion: 'success', approvals: [] } });
  assert.deepEqual(asked, Object.keys(answers), 'three unauthenticated GETs, in order');
  const limited = { status: 403, body: { message: 'API rate limit exceeded for 1.2.3.4.' } };
  const r = await RS.fetchProtections('o/r', 'v1.1.0', SHA_T, get(Object.fromEntries(Object.keys(answers).map((k) => [k, limited]))));
  assert.deepEqual([r.mainRules.status, r.releaseRun.status], ['unreachable', 'unreachable']);
  assert.match(r.mainRules.detail, /HTTP 403: API rate limit exceeded/);
  const noRun = await RS.fetchProtections('o/r', 'v1.1.0', SHA_T, get({ [Object.keys(answers)[1]]: { status: 200, body: { workflow_runs: [] } } }));
  assert.equal(noRun.releaseRun.status, 'none');
  assert.equal((await RS.fetchProtections('o/r', 'v1.1.0', null, get())).releaseRun.status, 'unreachable', 'no tag commit known');
  assert.equal((await RS.fetchProtections(null, 'v1.1.0', SHA_T, get())).mainRules.status, 'unreachable', 'no repository known');
  // The Release's own `immutable` flag is kept with its notes.
  assert.deepEqual(await RS.fetchReleaseNotes('o/r', 'v1.1.0', async () => ({ status: 200, body: { body: 'x', immutable: false } })), { tag: 'v1.1.0', status: 'ok', body: 'x', immutable: false });
});
