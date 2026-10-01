'use strict';
// The thorough test run (CI's `thorough` and `thorough-sdc` jobs; `npm run test:thorough`), with SUDS_THOROUGH=1:
//   * every test in test/thorough/ — pure performance checks, kept out of `npm test` (which runs test/*.test.js
//     only) so a busy machine running the whole suite in parallel cannot flake them;
//   * every test/*.test.js that has a thorough mode (it reads SUDS_THOROUGH): the full-size publication-release
//     disclosure sweeps, the client list's timing budget, and whatever is added next.
// Found by convention, not listed by hand, so a new thorough test cannot be forgotten by CI.
//
// The statistical-disclosure-control (SDC) attacker sweeps (SDC_SWEEPS) take most of the run's time: at 1.15.3
// the whole set took about 25 minutes on a CI runner against a 30-minute limit. Since 1.16.0 CI runs them in a job
// of their own (`thorough-sdc`, `--part sdc`) beside everything else (`thorough`, `--part rest`); both are
// required by the release gate. With no --part, everything runs, as before.
//
//   node scripts/test-thorough.js [--part sdc|rest]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
/**
 * The SDC sweeps: the full-size disclosure property tests (test/publication-release*.test.js), since 1.16.3 the
 * fiscal-year refusals (test/thorough/refusal-band.test.js: 114 audits, about 6 minutes until 1.16.4, about 1 since
 * 1.17.0 left the events by month out of publication releases), and since 1.16.4 the quarters of seeded years
 * (test/thorough/refusal-quarters.test.js: 90 audits, about 4 minutes, 3 since 1.17.0). 1.17.0 adds the attacker's
 * month families (test/publication-release-months.test.js, a file of its own so that it runs beside the others), and the cap of
 * one skipped value per count in the check's step (test/sdc-skip-one.test.js). 1.21.0 adds
 * the county publication release's differencing attacker (test/county-publication-sdc.test.js).
 */
const SDC_SWEEPS = ['test/publication-release.test.js', 'test/publication-release-funds.test.js', 'test/publication-release-months.test.js', 'test/thorough/refusal-band.test.js', 'test/thorough/refusal-quarters.test.js', 'test/sdc-skip-one.test.js', 'test/county-publication-sdc.test.js'];
function thoroughFiles(part) {
  const t = path.join(root, 'test');
  const withMode = fs.readdirSync(t).filter((f) => f.endsWith('.test.js') && fs.readFileSync(path.join(t, f), 'utf8').includes('SUDS_THOROUGH')).map((f) => `test/${f}`);
  const dir = path.join(t, 'thorough');
  const folder = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => `test/thorough/${f}`) : [];
  const all = [...withMode.sort(), ...folder.sort()];
  if (part === 'sdc') return all.filter((f) => SDC_SWEEPS.includes(f));
  if (part === 'rest') return all.filter((f) => !SDC_SWEEPS.includes(f));
  if (part) throw new Error(`--part is sdc or rest, not ${part}`);
  return all;
}

if (require.main === module) {
  const i = process.argv.indexOf('--part');
  const files = thoroughFiles(i > 0 ? process.argv[i + 1] : undefined);
  console.log(`[thorough] ${files.join(' ')}`);
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--test', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, SUDS_THOROUGH: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}
module.exports = { thoroughFiles, SDC_SWEEPS };
