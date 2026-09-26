'use strict';
// Security review of 1.12.4, item 9: between two anchors, someone who can write the database and holds the
// index key can delete the newest audit entries and re-seal the head without any anchor contradicting them.
// The window is AUDIT_ANCHOR_HOURS; it was 6 by default. Measured cost of hourly anchors (a year = 8,760 files,
// ~4 MB): writing one with a year of anchors in the directory ~0.1 s, a full verify ~0.2 s. So the default is
// now 1 hour, and the hourly housekeeping tick must not skip every other hour when it fires a little early.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const config = require('../server/config');

let dir, saved;
before(async () => {
  await H.start();
  saved = config.auditAnchorDir;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-anchor-int-'));
  config.auditAnchorDir = dir;
});
after(async () => { config.auditAnchorDir = saved; fs.rmSync(dir, { recursive: true, force: true }); await H.stop(); });

test('audit anchors are written hourly by default', () => {
  assert.equal(config.auditAnchorHours, 1);
});

test('the hourly tick anchors even when it fires a little under an hour after the last anchor', () => {
  const A = require('../server/audit-anchor');
  require('../server/audit').log({ user: { username: 'test' }, action: 'test.anchor' });
  const first = A.runIfDue();
  assert.ok(first, 'the first anchor');
  const last = Date.parse(H.db.getSetting('audit_anchor_last_at'));
  require('../server/audit').log({ user: { username: 'test' }, action: 'test.anchor.2' });
  assert.equal(A.runIfDue(last + 30 * 60_000), null, 'not after half an hour');
  assert.ok(A.runIfDue(last + 59 * 60_000 + 50_000), 'a tick 70 s early still anchors');
});
