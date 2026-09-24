'use strict';
// File logging. The server only ever wrote to stdout, and nothing that starts it (a terminal window, a
// service manager) is guaranteed to keep that, so closing the window destroyed the entire operational
// history — including the one line that said what went wrong. Everything still goes to the console; it is
// additionally appended to a dated file under <dataDir>/logs, kept 0600 because an error message can
// name a file path or a table.
//
// Log lines must never carry PHI. Route errors log the path and the message, never the body.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const MAX_BYTES = 8 * 1024 * 1024;   // per file, before it is rolled aside
const KEEP_DAYS = 30;

let stream = null; let currentDay = null; let dir = null;

function fileFor(day) { return path.join(dir, `suds-${day}.log`); }
const today = () => new Date().toISOString().slice(0, 10);

/** One log line, in whichever format LOG_FORMAT selected — the same format for the console and the file. */
function formatLine(level, args) {
  const msg = args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : safe(a))).join(' ');
  if (config.logFormat === 'json') return JSON.stringify({ time: new Date().toISOString(), level, msg });
  return `${new Date().toISOString()} ${level} ${msg}`;
}

function openFor(day) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = fileFor(day);
    // Roll a file that has grown past the cap, so one runaway loop cannot fill the disk with a single file.
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.${Date.now()}.old`); } catch {}
    const s = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
    s.on('error', () => { stream = null; }); // a failure to log must never take the server down
    return s;
  } catch { return null; }
}

// Lines that must never reach the file, whatever printed them. The first-run administrator password is
// written to stdout directly (server/bootstrap.js), but a guard here costs nothing and outlives that.
const REDACT = [/Temporary password/i];
function redacted(line) { return REDACT.some(re => re.test(line)); }

function write(level, args) {
  const line = formatLine(level, args);
  if (redacted(line)) return;
  const day = today();
  if (day !== currentDay) { try { stream && stream.end(); } catch {} stream = openFor(day); currentDay = day; }
  if (!stream) return;
  try { stream.write(line + '\n'); } catch {}
}
function safe(v) { try { return JSON.stringify(v); } catch { return String(v); } }

/** Delete logs older than the retention window. Called from the hourly housekeeping pass. */
function purge(days = KEEP_DAYS) {
  if (!dir) return 0;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^suds-\d{4}-\d{2}-\d{2}\.log(\.\d+\.old)?$/.test(name)) continue;
      const p = path.join(dir, name);
      try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; } } catch {}
    }
  } catch {}
  return removed;
}

/** Tee console output to a dated file. Safe to call more than once. */
function start(dataDir) {
  if (stream || !dataDir) return;
  dir = path.join(dataDir, 'logs');
  currentDay = today();
  stream = openFor(currentDay);
  if (!stream) return;
  for (const [level, method] of [['INFO', 'log'], ['WARN', 'warn'], ['ERROR', 'error']]) {
    const original = console[method].bind(console);
    // In JSON mode the console itself becomes structured too, not just the file — a container's log
    // collector reads stdout, not a file inside a volume it may not even see.
    console[method] = (...args) => { if (config.logFormat === 'json') original(formatLine(level, args)); else original(...args); write(level, args); };
  }
  console.log(`[suds] logging to ${fileFor(currentDay)}${config.logFormat === 'json' ? ' (JSON)' : ''}`);
}

module.exports = { start, purge, formatLine, redacted, MAX_BYTES, KEEP_DAYS };
