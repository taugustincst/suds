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
function out(cmd, args) { return execFileSync(cmd, args, { cwd: ROOT }).toString('utf8').trim(); }

/** What would change: the branch, how many commits behind, and their one-line summaries. Fetches, but never writes. */
function checkGit() {
  run('git', ['fetch', '--quiet']);
  const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
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

  const info = checkGit();
  if (info.behind === 0) { console.log('Already up to date.'); return; }
  console.log(`${info.behind} commit(s) behind origin/${info.branch}:`);
  for (const c of info.commits) console.log(`  ${c}`);
  if (opts.check) { console.log('\nRun again with --apply to update.'); return; }

  const beforePull = out('git', ['rev-parse', 'HEAD']);
  console.log('\nTaking a backup first...');
  run('node', ['scripts/backup.js']);

  console.log('\nPulling...');
  run('git', ['pull', '--ff-only']);
  console.log('\nInstalling dependencies...');
  run('npm', ['ci']);
  console.log('\nRebuilding the local kernel...');
  run('npm', ['run', 'build:local']);

  if (!opts.skipTests) {
    console.log('\nRunning the test suite...');
    try { run('npm', ['test']); }
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

module.exports = { checkGit, parseArgs, isGitCheckout, main };
if (require.main === module) main();
