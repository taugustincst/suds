'use strict';
// Updates a git-checkout install: takes a backup, pulls, reinstalls, rebuilds the local kernel, and runs
// the test suite before you restart the service — so a bad upgrade is caught before it goes live, not
// after. A packaged (non-git) install has no code here to pull; download the next release zip and follow
// docs/DEPLOYMENT.md -> Upgrades instead.
//
// Usage:
//   node scripts/update.js --check                                    # report what would change, touch nothing
//   node scripts/update.js --apply                                    # back up, then update
//   node scripts/update.js --apply --restart-cmd "systemctl restart suds"   # and restart when it succeeds
//   node scripts/update.js --apply --skip-tests                       # skip the post-update test run
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

function isGitCheckout() { return fs.existsSync(path.join(ROOT, '.git')); }
function run(cmd, args) { execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' }); }
// npm is a batch file on Windows (npm.cmd), which execFile cannot start without a shell (Node refuses .cmd files
// without one since 20.12). Under `npm run update` npm says where its own script is (npm_execpath): run that with
// this node, the same on every system. Otherwise npm through the shell on Windows, and npm itself elsewhere.
function npm(args, env = process.env) {
  const cli = env.npm_execpath;
  if (cli && /\.c?js$/i.test(cli)) return run(process.execPath, [cli, ...args]);
  if (process.platform === 'win32') { execFileSync('npm.cmd', args, { cwd: ROOT, stdio: 'inherit', shell: true }); return; }
  return run('npm', args);
}
function out(cmd, args) { return execFileSync(cmd, args, { cwd: ROOT }).toString('utf8').trim(); }

/** The newest release tag (v<major>.<minor>.<patch>) of a list of tag names, or null. */
function newestRelease(tags) {
  const { compareVersions } = require('../server/update');
  return tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort((a, b) => compareVersions(a.slice(1), b.slice(1))).pop() || null;
}

/** What would change: the branch, how many commits behind, and their one-line summaries. Fetches, but never writes.
 *  A checkout of a release tag (`git clone --branch v<version>`, docs/RELEASE.md) has no branch: it is compared with
 *  the newest release tag instead, never with the tip of main ({ detached, tag, newest }). Up to 1.25.1 it asked git
 *  for HEAD..origin/HEAD and crashed (1.25.2, BO14). */
function checkGit() {
  const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') {
    run('git', ['fetch', '--quiet', '--tags']);
    let tag = null; try { tag = out('git', ['describe', '--tags', '--exact-match', 'HEAD']); } catch { /* not on a tag */ }
    return { detached: true, tag, newest: newestRelease(out('git', ['tag', '--list', 'v*']).split('\n')) };
  }
  run('git', ['fetch', '--quiet']);
  const behind = Number(out('git', ['rev-list', '--count', `HEAD..origin/${branch}`]));
  const commits = behind === 0 ? [] : out('git', ['log', '--oneline', `HEAD..origin/${branch}`]).split('\n').filter(Boolean);
  return { branch, behind, commits };
}

function parseArgs(argv) {
  const restartIdx = argv.indexOf('--restart-cmd');
  return {
    check: argv.includes('--check'),
    apply: argv.includes('--apply'),
    skipTests: argv.includes('--skip-tests'),
    restartCmd: restartIdx >= 0 ? argv[restartIdx + 1] : null,
  };
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.check && !opts.apply) { console.log('Usage: node scripts/update.js --check | --apply [--skip-tests] [--restart-cmd "..."]'); return; }

  if (!isGitCheckout()) {
    console.error('This does not look like a git checkout (no .git directory). Download the latest release from GitHub and follow docs/DEPLOYMENT.md -> Upgrades for a packaged install.');
    process.exitCode = 1; return;
  }
  const status = out('git', ['status', '--porcelain']);
  if (status) {
    console.error('There are uncommitted changes in this checkout. Commit, stash, or discard them before updating:\n' + status);
    process.exitCode = 1; return;
  }

  let info;
  try { info = checkGit(); }
  catch (e) { console.error(`Could not ask git what has changed: ${String((e && e.stderr && e.stderr.toString().trim()) || (e && e.message) || e).split('\n')[0]}`); process.exitCode = 1; return; }
  if (info.detached) {
    const here = info.tag ? `release tag ${info.tag}` : 'a commit that is not on a branch (detached HEAD)';
    if (info.tag && info.newest === info.tag) { console.log(`You are on ${here}, the newest release.`); return; }
    console.log(`You are on ${here}.${info.newest ? ` The newest release is ${info.newest}.` : ''}`);
    if (info.newest) console.log(`To upgrade, take a backup (npm run backup), then: git checkout ${info.newest} && npm ci && npm run build:local, run the tests, and restart (docs/DEPLOYMENT.md -> Upgrades).`);
    if (opts.apply) { console.error('--apply follows a branch; a release-tag checkout is upgraded to the next tag as above.'); process.exitCode = 1; }
    return;
  }
  if (info.behind === 0) { console.log('Already up to date.'); return; }
  console.log(`${info.behind} commit(s) behind origin/${info.branch}:`);
  for (const c of info.commits) console.log(`  ${c}`);
  if (opts.check) { console.log('\nRun again with --apply to update.'); return; }

  const beforePull = out('git', ['rev-parse', 'HEAD']);
  console.log('\nTaking a backup first...');
  run(process.execPath, ['--no-warnings=ExperimentalWarning', 'scripts/backup.js']);

  console.log('\nPulling...');
  run('git', ['pull', '--ff-only']);
  console.log('\nInstalling dependencies...');
  npm(['ci']);
  console.log('\nRebuilding the local kernel...');
  npm(['run', 'build:local']);

  if (!opts.skipTests) {
    console.log('\nRunning the test suite...');
    try { npm(['test']); }
    catch {
      console.error(`\nTests failed after updating. The code has been pulled but the service has NOT been restarted -- it is still running the previous version.`);
      console.error(`To roll back the code:  git reset --hard ${beforePull}`);
      console.error(`If anything already wrote to the database under the new code, restore the backup just taken instead (Administration -> System & backups, or scripts/backup.js --restore).`);
      process.exitCode = 1; return;
    }
  }

  console.log('\nUpdate complete.');
  if (opts.restartCmd) {
    console.log(`Restarting: ${opts.restartCmd}`);
    const [cmd, ...cmdArgs] = opts.restartCmd.split(' ');
    run(cmd, cmdArgs);
  } else {
    console.log('Restart the service to run the new version (e.g. systemctl restart suds, or restart the container).');
  }
}

module.exports = { checkGit, newestRelease, parseArgs, isGitCheckout, main };
if (require.main === module) main();
