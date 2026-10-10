'use strict';
// scripts/service-sandbox-check.js, the parts that need no systemd (CI's `service-sandbox` job runs the rest on a runner
// whose PID 1 is systemd): the unit it installs is the release's, the layout it builds is the one the unit names, the
// drop-in is install.sh's, and the checks of what systemd applies and of the journal catch the 1.18.0 to 1.25.3
// defect (evaluation of 1.25.4, H4: SUDS killed with SIGSYS by its own unit's filter at every offsite copy).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('../scripts/service-sandbox-check');
const Y = require('../scripts/workflow-yaml');
const { REQUIRED_JOBS } = require('../scripts/release-gate');

const REPO = path.join(__dirname, '..');
const unitText = fs.readFileSync(path.join(REPO, 'deploy/linux/suds.service'), 'utf8');
const unit = S.parseUnit(unitText);

test('the unit names the layout the check builds: user, code, Node, data, environment file, keys', () => {
  assert.equal(S.last(unit, 'User'), 'suds'); assert.equal(S.last(unit, 'Group'), 'suds');
  assert.equal(S.last(unit, 'WorkingDirectory'), `${S.LAYOUT.code}/current`);
  assert.match(S.last(unit, 'ExecStart'), new RegExp(`^${S.LAYOUT.code}/node/bin/node .*server/index\\.js$`));
  assert.equal(S.last(unit, 'EnvironmentFile'), `${S.LAYOUT.etc}/suds.env`);
  assert.deepEqual(S.values(unit, 'Service', 'ReadWritePaths'), [S.LAYOUT.data]);
  assert.deepEqual(S.values(unit, 'Unit', 'RequiresMountsFor'), [S.LAYOUT.data]);
  assert.match(S.values(unit, 'Service', 'Environment').join(' '), new RegExp(`SUDS_DATA_DIR=${S.LAYOUT.data} HOST=127\\.0\\.0\\.1 PORT=8080`));
  const creds = S.credentials(unit);
  assert.deepEqual(creds.map((c) => c.name), ['suds_encryption_key', 'suds_index_key', 'suds_backup_key', 'suds_signing_key']);
  for (const c of creds) assert.equal(c.path, `${S.LAYOUT.creds}/${c.name}`);
  // The filter that killed the offsite copy is still the unit's (the owner decides any change: docs/RELEASE.md).
  assert.deepEqual(S.values(unit, 'Service', 'SystemCallFilter'), ['@system-service', '~@privileged @resources @mount @debug']);
  // The shares are outside every path the unit or the check makes, as install.sh requires of them.
  for (const share of [S.LAYOUT.offsite, S.LAYOUT.anchors]) for (const p of [S.LAYOUT.data, S.LAYOUT.code, S.LAYOUT.etc]) assert.ok(!share.startsWith(`${p}/`), `${share} is not inside ${p}`);
});

test('the drop-in is the one deploy/linux/install.sh writes for the shares', () => {
  const sh = fs.readFileSync(path.join(REPO, 'deploy/linux/install.sh'), 'utf8');
  const start = sh.indexOf('put_file "$(P /etc/systemd/system/suds.service.d/10-site.conf)" 0644 root:root <<EOF\n');
  assert.ok(start > 0, 'install.sh still writes 10-site.conf');
  const body = sh.slice(sh.indexOf('\n', start) + 1, sh.indexOf('\nEOF\n', start) + 1);
  const theirs = body.replace(/\$ANCHORS/g, '/a').replace(/\$OFFSITE/g, '/o').split('\n').filter((l) => l && l !== '$metrics_lines');
  const ours = S.siteDropIn({ anchors: '/a', offsite: '/o' }).split('\n').filter(Boolean);
  assert.deepEqual(ours.filter((l) => !l.startsWith('#')), theirs.filter((l) => !l.startsWith('#')));
  // And suds.env carries install.sh's settings (minus the compliance and passkey lines, which need what is not here).
  for (const k of ['TRUST_PROXY=1', 'LOCAL_MODE_ENABLED=false', 'MFA_REQUIRED_ROLES=admin,supervisor,clinician,navigator,finance,readonly', 'SUDS_SKIP_SETUP=1']) {
    assert.ok(sh.includes(`\n${k}\n`), `install.sh writes ${k}`); assert.ok(S.envFile(S.LAYOUT).includes(`\n${k}\n`), `the check writes ${k}`);
  }
  const prov = JSON.parse(S.provisionJson(S.LAYOUT)).settings;
  assert.equal(prov.backup_offsite_dir, S.LAYOUT.offsite); assert.equal(prov.backup_schedule_hours, '4');
  const provision = require('../server/provision');
  for (const [k, v] of Object.entries(prov)) { assert.ok(provision.KEYS[k], `${k} is a setting provision.json may give`); if (k !== 'backup_offsite_dir') assert.ok(provision.KEYS[k](v), `${k}=${v} is accepted`); }
});

test('what systemd applies is compared with what the unit sets; a weakened setting or a missing one is named', () => {
  const want = S.expectedProperties(unit);
  assert.deepEqual(want, {
    User: 'suds', Group: 'suds', UMask: '0077', NoNewPrivileges: 'yes', ProtectSystem: 'strict', ProtectHome: 'yes', PrivateTmp: 'yes',
    PrivateDevices: 'yes', ProtectKernelTunables: 'yes', ProtectKernelModules: 'yes', ProtectKernelLogs: 'yes', ProtectControlGroups: 'yes',
    ProtectClock: 'yes', ProtectHostname: 'yes', ProtectProc: 'invisible', RestrictRealtime: 'yes', RestrictSUIDSGID: 'yes', LockPersonality: 'yes', RemoveIPC: 'yes',
  });
  const good = Object.entries(want).map(([k, v]) => `${k}=${v}`).join('\n') + '\nMainPID=1234\n';
  assert.deepEqual(S.propertyProblems(want, S.parseShow(good)), []);
  const weak = S.parseShow(good.replace('NoNewPrivileges=yes', 'NoNewPrivileges=no').replace('ProtectSystem=strict', 'ProtectSystem=no').replace('User=suds\n', ''));
  assert.deepEqual(S.propertyProblems(want, weak), ['User: systemd shows nothing, the unit sets suds', 'NoNewPrivileges: systemd applies no, the unit sets yes', 'ProtectSystem: systemd applies no, the unit sets strict']);
});

test('the system-call filter in force must refuse fchown, the call that killed every offsite copy', () => {
  assert.equal(S.syscallFilterProblem('accept accept4 access close fstat openat read write'), null, 'an allow-list without fchown');
  assert.match(S.syscallFilterProblem('accept fchown openat read'), /allows fchown/);
  assert.match(S.syscallFilterProblem(''), /no system-call filter/);
  assert.equal(S.syscallFilterProblem('~chown fchown fchownat mount'), null, 'a deny-list with it');
  assert.match(S.syscallFilterProblem('~mount ptrace'), /allows fchown/);
});

test('the journal check finds the 1.25.3 kill, in the unit\'s journal and in the kernel\'s seccomp line, and nothing in a clean one', () => {
  const killed = [
    'Oct 09 14:00:01 suds systemd[1]: suds.service: Main process exited, code=killed, status=31/SYS',
    'Oct 09 14:00:01 suds systemd[1]: suds.service: Failed with result \'signal\'.',
    'Oct 09 14:00:06 suds systemd[1]: suds.service: Scheduled restart job, restart counter is at 1.',
  ].join('\n');
  assert.deepEqual(S.journalProblems(killed), ['Oct 09 14:00:01 suds systemd[1]: suds.service: Main process exited, code=killed, status=31/SYS']);
  const kernel = 'Oct 09 14:00:01 suds kernel: audit: type=1326 audit(1760018401.123:42): auid=4294967295 uid=998 gid=998 ses=4294967295 subj=unconfined pid=4242 comm="node" exe="/opt/suds/node-v22.23.3/bin/node" sig=31 arch=c000003e syscall=93 compat=0 ip=0x7f code=0x80000000';
  assert.match(S.journalProblems(kernel)[0], /type=1326 .*\[syscall 93 = fchown\]$/);
  const clean = [
    'Oct 10 18:00:00 runner systemd[1]: Started suds.service - SUDS SUD Navigator Services Tracker.',
    'Oct 10 18:00:01 runner suds[4242]: [suds] scheduled backup suds-2026-10-10T18-00-01-000Z.db.enc: 1482780 bytes, verified; offsite copied and checked (size and SHA-256)',
    'Oct 10 18:05:00 runner systemd[1]: Stopping suds.service - SUDS SUD Navigator Services Tracker...',
    'Oct 10 18:05:00 runner systemd[1]: suds.service: Deactivated successfully.',
  ].join('\n');
  assert.deepEqual(S.journalProblems(clean), []);
});

test('the check refuses to run without --disposable-host, as anyone, and changes nothing', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/service-sandbox-check.js')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--disposable-host/); assert.match(r.stderr, /never a server/);
  const r2 = spawnSync(process.execPath, [path.join(REPO, 'scripts/service-sandbox-check.js'), '--disposable-host', '--release-zip', path.join(os.tmpdir(), 'no-such.zip')], { encoding: 'utf8' });
  assert.equal(r2.status, 2); assert.match(r2.stderr, /--release-zip <zip> and --node-dir <dir with bin\/node> are required/);
});

test('ci.yml: the service-sandbox job runs the check as root on the pinned Node, prints the journal, is not advisory and not yet required', () => {
  const ci = Y.parse(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  const job = ci.jobs['service-sandbox'];
  assert.ok(job, 'ci.yml has a service-sandbox job');
  assert.equal(job['runs-on'], 'ubuntu-24.04', 'a GitHub-hosted Ubuntu runner: systemd is PID 1, sudo needs no password');
  assert.ok(!job['continue-on-error'], 'a red run fails CI');
  assert.equal(job.permissions, undefined, 'the top-level read-only token');
  assert.ok(!REQUIRED_JOBS.includes('service-sandbox'), 'not in the release gate\'s list until it has been green on main (the owner adds it)');
  const runs = job.steps.map((s) => s.run || '').join('\n');
  assert.match(runs, /echo "\$\{NODE22_SHA256\}  \$\{file\}" \| sha256sum -c -/, 'the pinned Node 22, checked');
  assert.match(runs, /node scripts\/package\.js "\$RUNNER_TEMP\/suds\.zip"/, 'the release zip, as git archive builds it');
  assert.match(runs, /sudo "\$\(command -v node\)" scripts\/service-sandbox-check\.js --disposable-host --release-zip "\$RUNNER_TEMP\/suds\.zip" --node-dir "\$RUNNER_TEMP\/node22"/);
  assert.ok(!/npm (ci|install|i) /.test(runs), 'no npm install: Node built-ins only');
  const journal = job.steps.find((s) => /journalctl -u suds\.service/.test(s.run || ''));
  assert.ok(journal && journal.if === 'always()', 'the unit\'s journal is printed whatever happened');
});
