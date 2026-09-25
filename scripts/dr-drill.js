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
//   npm run dr-drill -- --keys-file <file>   decrypt and start the copy with the escrowed key backup (keys.json
//                                            from "Download key backup", or KEY=VALUE lines), not the keys
//                                            this process loaded -- proves the offline copy of the keys works
//   npm run dr-drill -- --local | --offsite  which copy to restore; by default the offsite copy when an offsite
//                                            directory is configured, else the local one
// Exit status 0 when every check passed, 1 otherwise.
const path = require('node:path');

async function main(argv) {
  const opts = { backupFile: null, fresh: false, json: false, keysFile: null, copy: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backup') opts.backupFile = path.resolve(argv[++i]);
    else if (argv[i] === '--fresh') opts.fresh = true;
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--keys-file') opts.keysFile = path.resolve(argv[++i] || '');
    else if (argv[i] === '--local') opts.copy = 'local';
    else if (argv[i] === '--offsite') opts.copy = 'offsite';
    else { console.error(`Unknown option ${argv[i]}. Usage: npm run dr-drill [-- --backup <file>] [--fresh] [--keys-file <keys.json>] [--local|--offsite] [--json]`); return 2; }
  }
  if (opts.keysFile && !require('node:fs').existsSync(opts.keysFile)) { console.error(`No key file at ${opts.keysFile}`); return 2; }
  const db = require('../server/db');
  db.open();
  try { db.checkKeyFingerprint(); } catch (e) { console.error(e.message); return 1; }
  const drill = require('../server/dr-drill');
  const out = await drill.run({ backupFile: opts.backupFile, fresh: opts.fresh, keysFile: opts.keysFile, copy: opts.copy, by: { username: 'cli' }, trigger: 'cli' });
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
