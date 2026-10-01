'use strict';
// scripts/release-policy-ci.js: the release policy on every push, from the newest release a tag or the tag hand-off
// records (docs/RELEASE.md, "Stabilisation (from 1.23.1)"). The plan is pure; these are synthetic inputs, plus one
// check of the real documents.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../scripts/release-policy-ci');
const { stampedVersions, parseHandoff } = require('../scripts/release-state');

const SHA = (c) => c.repeat(40);
const stamped = [
  { version: '1.23.0', date: '2026-10-01' }, { version: '1.22.0', date: '2026-10-01' }, { version: '1.16.2', date: '2026-09-20' }, { version: '1.16.0', date: '2026-09-15' },
];
const handoffRows = [{ version: '1.22.0', commit: SHA('b') }, { version: '1.23.0', commit: SHA('c') }];
const tags = ['v1.16.0', 'v1.16.2'];
const at = (d) => Date.parse(`${d}T12:00:00Z`);

test('work after a released version, inside the 28 days: checked as the next patch against the hand-off commit', () => {
  const p = C.plan({ version: '1.23.0', stamped, tags, handoffRows, now: at('2026-10-05') });
  assert.equal(p.action, 'patch');
  assert.deepEqual([p.version, p.previous, p.previousRef], ['1.23.1', '1.23.0', SHA('c')]);
  assert.match(p.reason, /until 2026-10-29/);
});

test('the 28 days end on 2026-10-29 for 1.23.0 (released 2026-10-01): after that the gate checks the next release', () => {
  assert.equal(C.plan({ version: '1.23.0', stamped, tags, handoffRows, now: at('2026-10-28') }).action, 'patch');
  assert.equal(C.plan({ version: '1.23.0', stamped, tags, handoffRows, now: Date.parse('2026-10-29T00:00:00Z') }).action, 'skip');
});

test('a stamped patch with no hand-off row yet is checked against the newest release below it', () => {
  const p = C.plan({ version: '1.23.1', stamped: [{ version: '1.23.1', date: '2026-10-03' }, ...stamped], tags, handoffRows, now: at('2026-10-03') });
  assert.deepEqual([p.action, p.version, p.previous, p.previousRef], ['patch', '1.23.1', '1.23.0', SHA('c')]);
});

test('a pushed tag wins over the hand-off row for the same version, and is passed as a tag', () => {
  const p = C.plan({ version: '1.23.1', stamped, tags: [...tags, 'v1.23.0'], handoffRows, now: at('2026-10-03') });
  assert.equal(p.previousRef, 'v1.23.0');
  assert.equal(C.releases(['v1.23.0'], handoffRows).get('1.23.0').from, 'tag');
});

test('a minor within 28 days of the previous feature release fails; after, it passes; a security exception lets it through', () => {
  const s = [{ version: '1.24.0', date: '2026-10-20' }, ...stamped];
  const early = C.plan({ version: '1.24.0', stamped: s, tags, handoffRows, now: at('2026-10-20') });
  assert.equal(early.action, 'fail');
  assert.match(early.reason, /19 days after the feature release 1\.23\.0.*no earlier than 2026-10-29/);
  assert.match(early.reason, /Security exception: <reason>/);
  const ok = C.plan({ version: '1.24.0', stamped: [{ version: '1.24.0', date: '2026-10-29' }, ...stamped], tags, handoffRows, now: at('2026-11-02') });
  assert.equal(ok.action, 'pass');
  const sec = C.plan({ version: '1.24.0', stamped: s, tags, handoffRows, now: at('2026-10-20'), exception: 'CVE fix in the session code' });
  assert.equal(sec.action, 'pass');
  assert.match(sec.reason, /security exception.*CVE fix/);
});

test('an unstamped minor is dated today', () => {
  assert.equal(C.plan({ version: '1.24.0', stamped, tags, handoffRows, now: at('2026-10-10') }).action, 'fail');
  assert.equal(C.plan({ version: '1.24.0', stamped, tags, handoffRows, now: at('2026-10-30') }).action, 'pass');
});

test('the stamped date counts, not the day the tag is pushed', () => {
  // v1.23.0 tagged weeks later: its CHANGELOG date still starts the window.
  const p = C.plan({ version: '1.24.0', stamped: [{ version: '1.24.0', date: '2026-10-29' }, ...stamped], tags: [...tags, 'v1.23.0'], handoffRows: [], tagDates: { 'v1.23.0': '2026-11-15T00:00:00Z' }, now: at('2026-10-29') });
  assert.equal(p.action, 'pass');
});

test('a feature release whose date cannot be read fails closed; nothing to compare with is a skip', () => {
  const p = C.plan({ version: '1.24.0', stamped: [], tags: ['v1.23.0'], handoffRows: [], now: at('2026-10-10') });
  assert.equal(p.action, 'fail');
  assert.match(p.reason, /could not be read/);
  assert.equal(C.plan({ version: '1.0.0', stamped: [], tags: [], handoffRows: [], now: at('2026-10-10') }).action, 'skip');
  assert.equal(C.plan({ version: 'next', now: at('2026-10-10') }).action, 'fail');
});

test('the security exception is read from the version\'s CHANGELOG section or its Record, and nowhere else', () => {
  const changelog = '## Unreleased\n\nSecurity exception: not this one\n\n## 1.24.0 — 2026-10-20\n\n* Security exception: CVE-2026-1 in sign-in\n\n## 1.23.0 — 2026-10-01\n';
  assert.equal(C.securityException('1.24.0', { changelog }), 'CVE-2026-1 in sign-in');
  assert.equal(C.securityException('1.23.0', { changelog }), null);
  const release = '**Record: 1.24.0** shipped early.\n\n**Security exception:** a token leak\n\n**Record: 1.23.0** none.\n';
  assert.equal(C.securityException('1.24.0', { release }), 'a token leak');
  assert.equal(C.securityException('1.23.0', { release }), null);
  assert.equal(C.securityException('1.24.0', { changelog: '## 1.24.0 — 2026-10-20\n\nA policy exception approved by the owner.\n' }), null, 'a plain policy exception is not a security one');
});

test('the repository itself: this tree is planned as a patch of the newest released version, or after its window', () => {
  const root = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const version = JSON.parse(read('package.json')).version;
  const changelog = read('CHANGELOG.md');
  const p = C.plan({ version, stamped: stampedVersions(changelog), handoffRows: parseHandoff(read('docs/evidence/RELEASE-HANDOFF.md')).rows, tags: [], now: Date.parse('2026-10-02T00:00:00Z'), exception: C.securityException(version, { changelog, release: read('docs/RELEASE.md') }) });
  assert.notEqual(p.action, 'fail', p.reason);
});
