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

/** A consistent set of documents: 1.3.0 and 1.2.0 stamped, both untagged, 1.3.0 live. */
function world(o = {}) {
  const docs = {
    pkg: JSON.stringify({ version: o.pkg || '1.3.0' }),
    changelog: o.changelog || [
      '# Changelog', '', '## Unreleased', '',
      '## 1.3.0 — 2026-10-01', '', '- **Supported versions**: 1.3.x is the latest minor, 1.2.x the previous.', '- The questionnaire is checked against 1.3.0.', '',
      '## 1.2.0 — 2026-09-01', '', '- Documents describe 1.2.0.', '',
      '## 1.1.0 — 2026-08-01', '', '- First.', '',
    ].join('\n'),
    questionnaire: o.questionnaire || '# Q\n\n**Checked against:** 1.3.0 (live on GitHub Pages; its tag is pending the owner).\n',
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

test('a consistent world has no problems, offline and online', () => {
  const docs = world();
  const off = RS.evaluate({ docs });
  assert.deepEqual(off.problems, []);
  assert.ok(off.notChecked.some((n) => /GitHub Pages/.test(n)) && off.notChecked.some((n) => /tags are pushed/.test(n)) && off.notChecked.some((n) => /commits/.test(n)), 'and says what it could not check');
  const on = RS.evaluate({ docs, git: goodGit(), remote: { tags: { 'v1.1.0': SHA('1') } }, pages: { version: '1.3.0', source: 'test' }, mainPkg: { version: '1.3.0', stamped: [] } });
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
  assert.ok(h.rows.length > 0 && h.rows.every((r) => /^v\d+\.\d+\.\d+$/.test(r.tag) && r.commit.length === 40), 'the hand-off table is read');
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
  const r = RS.run(path.join(__dirname, '..'), { mode: 'docs-only' });
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
