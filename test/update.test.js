'use strict';
// Update checking (server/update.js) and the CLI's own argument parsing (scripts/update.js) — not the CLI's
// actual git/npm invocations, which touch this real checkout and a real network and have no place running
// unattended in the suite.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '66'.repeat(32);
process.env.SUDS_INDEX_KEY = '77'.repeat(32);
process.env.SUDS_DB_PATH = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { compareVersions, checkForUpdate } = require('../server/update');
const { parseArgs, isGitCheckout } = require('../scripts/update');

test('compareVersions orders dotted version strings numerically, not lexically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0') > 0, true, '1.10 is newer than 1.9, unlike a string sort');
  assert.equal(compareVersions('1.8.0', '1.8.0'), 0);
  assert.equal(compareVersions('1.8.0', '1.9.0') < 0, true);
  assert.equal(compareVersions('2.0', '1.9.9') > 0, true, 'a shorter version string is padded with zeros');
});

test('checkForUpdate is a no-op when no feed URL is configured', async () => {
  const r = await checkForUpdate({ feedUrl: '', currentVersion: '1.8.0' });
  assert.deepEqual(r, { configured: false });
});

test('scripts/update.js --check|--apply|--skip-tests|--restart-cmd parse as expected', () => {
  assert.deepEqual(parseArgs([]), { check: false, apply: false, skipTests: false, restartCmd: null });
  assert.deepEqual(parseArgs(['--check']), { check: true, apply: false, skipTests: false, restartCmd: null });
  assert.deepEqual(parseArgs(['--apply', '--skip-tests']), { check: false, apply: true, skipTests: true, restartCmd: null });
  assert.deepEqual(parseArgs(['--apply', '--restart-cmd', 'systemctl restart suds']), { check: false, apply: true, skipTests: false, restartCmd: 'systemctl restart suds' });
});

test('this repo checkout is recognised as a git checkout', () => {
  // Confirms the detection this script relies on to refuse running against a packaged (non-git) install,
  // against the one git checkout guaranteed to be present: the one running the test.
  assert.equal(isGitCheckout(), true);
});

// --- a fake release feed, for the parts that talk to it ---
let feed, feedBase;
let releasePayload = { tag_name: 'v1.9.0', html_url: 'https://example.test/releases/1.9.0', published_at: '2026-01-01T00:00:00Z' };
before(async () => {
  feed = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(releasePayload)); });
  await new Promise((res) => feed.listen(0, '127.0.0.1', res));
  feedBase = `http://127.0.0.1:${feed.address().port}`;
});
after(async () => { await new Promise((res) => feed.close(res)); });

test('checkForUpdate reports an available update when the feed is ahead', async () => {
  const r = await checkForUpdate({ feedUrl: feedBase, currentVersion: '1.8.0' });
  assert.deepEqual(r, { configured: true, current: '1.8.0', latest: '1.9.0', available: true, url: 'https://example.test/releases/1.9.0', published_at: '2026-01-01T00:00:00Z' });
});

test('checkForUpdate reports up to date when the feed is not ahead', async () => {
  const r = await checkForUpdate({ feedUrl: feedBase, currentVersion: '1.9.0' });
  assert.equal(r.available, false);
});

test('checkForUpdate raises a clear error on a bad response', async () => {
  releasePayload = {};
  await assert.rejects(() => checkForUpdate({ feedUrl: feedBase, currentVersion: '1.8.0' }), /did not report a version/);
  releasePayload = { tag_name: 'v1.9.0', html_url: null, published_at: null };
});
