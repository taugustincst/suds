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

test('start() tees console output to a real file, in whichever format is configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-log-'));
  const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
  after(() => { console.log = originalLog; console.warn = originalWarn; console.error = originalError; fs.rmSync(dir, { recursive: true, force: true }); });

  config.logFormat = 'json';
  try {
    log.start(dir);
    console.log('hello from the test');
    console.warn('a warning', { detail: 1 });
  } finally { config.logFormat = 'text'; }

  // fs.createWriteStream opens its file descriptor asynchronously; nothing here guarantees it has actually
  // landed on disk yet, even though the writes above happened synchronously from this test's point of view.
  await new Promise((res) => setTimeout(res, 100));

  const file = path.join(dir, 'logs', `suds-${new Date().toISOString().slice(0, 10)}.log`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  // The first line is log.start()'s own "[suds] logging to ..." announcement.
  const parsed = lines.map((l) => JSON.parse(l));
  assert.ok(parsed.some((p) => p.msg.includes('hello from the test') && p.level === 'INFO'));
  assert.ok(parsed.some((p) => p.msg.includes('a warning') && p.level === 'WARN'));
});
