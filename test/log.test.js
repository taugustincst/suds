'use strict';
// server/log.js: plain-text (default) vs structured JSON output, both as a pure formatting function and as
// the real file it tees console output to.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = 'aa'.repeat(32);
process.env.SUDS_INDEX_KEY = 'bb'.repeat(32);
process.env.SUDS_DB_PATH = ':memory:';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../server/config');
const log = require('../server/log');

test('the default text format is a timestamped, human-readable line', () => {
  config.logFormat = 'text';
  const line = log.formatLine('INFO', ['starting up', { port: 8080 }]);
  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO starting up \{"port":8080\}$/);
});

test('JSON format is one parseable object per line, with the message and level intact', () => {
  config.logFormat = 'json';
  try {
    const line = log.formatLine('ERROR', ['sync.pull failed', new Error('boom')]);
    const parsed = JSON.parse(line);
    assert.equal(parsed.level, 'ERROR');
    assert.match(parsed.time, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(parsed.msg, /sync\.pull failed/);
    assert.match(parsed.msg, /boom/);
  } finally { config.logFormat = 'text'; }
});

test('start() tees console output to a real file, in whichever format is configured, and never a temporary password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-log-'));
  const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
  after(() => { console.log = originalLog; console.warn = originalWarn; console.error = originalError; fs.rmSync(dir, { recursive: true, force: true }); });

  config.logFormat = 'json';
  try {
    log.start(dir);
    console.log('hello from the test');
    console.warn('a warning', { detail: 1 });
    // The first-run password is printed to stdout on purpose (server/bootstrap.js bypasses the tee); if
    // anything ever sends such a line through console.log, the file must still not get it.
    console.log('[suds] Temporary password: Hunter2-Not-For-The-Log!');
    console.log('an ordinary line after it');
  } finally { config.logFormat = 'text'; }

  // fs.createWriteStream opens its file descriptor and writes asynchronously: wait until everything written
  // so far has reached the file (not a fixed sleep, which a loaded CI machine outruns), and take the file
  // name from the logger itself (not today's date here, which is a different file across UTC midnight).
  await log.flush();
  const file = log.currentFile();
  assert.equal(path.dirname(file), path.join(dir, 'logs'));
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.trim().split('\n');
  // The first line is log.start()'s own "[suds] logging to ..." announcement.
  const parsed = lines.map((l) => JSON.parse(l));
  assert.ok(parsed.some((p) => p.msg.includes('hello from the test') && p.level === 'INFO'));
  assert.ok(parsed.some((p) => p.msg.includes('a warning') && p.level === 'WARN'));
  assert.ok(parsed.some((p) => p.msg.includes('an ordinary line after it')), 'ordinary lines still land in the file');
  assert.ok(!raw.includes('Hunter2-Not-For-The-Log') && !raw.includes('Temporary password'), 'the password line does not');
});

test('the redaction guard recognises the password line and nothing else from the banner', () => {
  assert.ok(log.redacted('[suds] Temporary password: x'));
  assert.ok(log.redacted('2026-01-01T00:00:00.000Z INFO [suds] temporary password: x'), 'case does not matter');
  assert.ok(!log.redacted('[suds] Created initial admin user "admin"'));
  assert.ok(!log.redacted('[suds] You will be required to change it at first login.'));
});
