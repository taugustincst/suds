'use strict';
// Disaster-recovery drill from the command line (the same drill as Settings → System & backups → "Run a
// recovery drill now"; server/dr-drill.js). Safe while the server is running: the backup is restored into a
// temporary directory and checked by a separate process that never sees the live database's path. The live
// database is only read (to find the configuration and compare counts) and gets one settings row and one
// audit entry recording the result.
//
//   npm run dr-drill                         restore the newest backup in <data>/backups
//   npm run dr-drill -- --backup <file>      restore this one (e.g. a copy fetched back from the offsite share)
//   npm run dr-drill -- --fresh              take a backup first and restore that
//   npm run dr-drill -- --json               print the full signed report
// Exit status 0 when every check passed, 1 otherwise.
const path = require('node:path');

async function main(argv) {
  const opts = { backupFile: null, fresh: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backup') opts.backupFile = path.resolve(argv[++i]);
    else if (argv[i] === '--fresh') opts.fresh = true;
    else if (argv[i] === '--json') opts.json = true;
    else { console.error(`Unknown option ${argv[i]}. Usage: npm run dr-drill [-- --backup <file>] [--fresh] [--json]`); return 2; }
  }
  const db = require('../server/db');
  db.open();
  try { db.checkKeyFingerprint(); } catch (e) { console.error(e.message); return 1; }
  const drill = require('../server/dr-drill');
  const out = await drill.run({ backupFile: opts.backupFile, fresh: opts.fresh, by: { username: 'cli' }, trigger: 'cli' });
  if (opts.json) console.log(JSON.stringify({ report: out.report, integrity: out.integrity }, null, 2));
  else {
    process.stdout.write(drill.textReport(out));
    if (out.files.json) console.log(`Report: ${path.join(require('../server/config').dataDir, 'backups', out.files.json)}`);
  }
  db.close();
  return out.report.ok ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e && e.message || e); process.exit(1); });
module.exports = { main };
