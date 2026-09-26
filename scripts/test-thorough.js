'use strict';
// The thorough test run (CI's `thorough` job; `npm run test:thorough`), with SUDS_THOROUGH=1:
//   * every test in test/thorough/ — pure performance checks, kept out of `npm test` (which runs test/*.test.js
//     only) so a busy machine running the whole suite in parallel cannot flake them;
//   * every test/*.test.js that has a thorough mode (it reads SUDS_THOROUGH): the full-size publication-release
//     disclosure sweeps, the client list's timing budget, and whatever is added next.
// Found by convention, not listed by hand, so a new thorough test cannot be forgotten by CI.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
function thoroughFiles() {
  const t = path.join(root, 'test');
  const withMode = fs.readdirSync(t).filter((f) => f.endsWith('.test.js') && fs.readFileSync(path.join(t, f), 'utf8').includes('SUDS_THOROUGH')).map((f) => `test/${f}`);
  const dir = path.join(t, 'thorough');
  const folder = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => `test/thorough/${f}`) : [];
  return [...withMode.sort(), ...folder.sort()];
}

if (require.main === module) {
  const files = thoroughFiles();
  console.log(`[thorough] ${files.join(' ')}`);
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--test', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, SUDS_THOROUGH: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}
module.exports = { thoroughFiles };
