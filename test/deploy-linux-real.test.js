'use strict';
// SUDS Server's installer and upgrade, RUN FOR REAL (not --dry-run) into a fake root filesystem
// (SUDS_INSTALL_ROOT), with stub system commands on PATH: package managers, systemctl, ufw, firewall-cmd,
// useradd, chown (ownership is recorded, not applied: the tests are not root), install (runs the real install
// with -o/-g recorded and stripped), curl (serves fixture Node.js and Caddy tarballs whose checksums are in the
// test tree's pins, and answers the health check), systemd-run (runs the command as the service would, with the
// credentials and environment file mapped into the fake root). The dry-run tests only read the plan; these
// look at what is actually on disk afterwards: modes, contents, symlinks, the manifest, and — for upgrade.sh —
// a real rollback of a database a failed release had migrated.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const VERSION = require('../package.json').version;
const OLD = '1.16.0';
const pins = Object.fromEntries(fs.readFileSync(path.join(REPO, 'deploy/linux/pins'), 'utf8').split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => l.split('=')));
const NODE_V = pins.NODE_VERSION;
const CADDY_V = pins.CADDY_VERSION;
const CADDY_V2 = CADDY_V.replace(/\.(\d+)$/, (m, p) => `.${Number(p) + 1}`);
const which = (c) => execFileSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).trim();
const REAL_INSTALL = which('install');
const has = (c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;
const canRun = has('xz') && has('unzip') && has('sha256sum') && has('tar');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-deploy-real-'));
after(() => { spawnSync('chmod', ['-R', 'u+w', work]); fs.rmSync(work, { recursive: true, force: true }); });
let n = 0;

const sh = (file, body) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const js = (file, body) => fs.writeFileSync(file, `#!${process.execPath}\n'use strict';\n${body}\n`, { mode: 0o755 });

/** Fixture Node.js and Caddy tarballs, built once. */
const fixtures = (() => {
  const d = path.join(work, 'fixtures'); fs.mkdirSync(d);
  const nd = path.join(d, `node-${NODE_V}-linux-x64`);
  fs.mkdirSync(path.join(nd, 'bin'), { recursive: true }); fs.mkdirSync(path.join(nd, 'lib', 'node_modules'), { recursive: true });
  sh(path.join(nd, 'bin', 'node'), `if [ "$1" = "--version" ]; then echo ${NODE_V}; exit 0; fi\nexec "${process.execPath}" "$@"`);
  fs.writeFileSync(path.join(nd, 'lib', 'node_modules', 'README'), 'fixture\n', { mode: 0o644 });
  const nodeTar = path.join(d, `node-${NODE_V}-linux-x64.tar.xz`);
  if (canRun) execFileSync('tar', ['-cJf', nodeTar, '-C', d, `node-${NODE_V}-linux-x64`]);
  const caddy = (v) => {
    const cd = path.join(d, `caddy-${v}`); fs.mkdirSync(cd);
    sh(path.join(cd, 'caddy'), `if [ "$1" = "version" ]; then echo "v${v} h1:fixture"; fi`);
    const t = path.join(d, `caddy_${v}_linux_amd64.tar.gz`);
    if (canRun) execFileSync('tar', ['-czf', t, '-C', cd, 'caddy']);
    return t;
  };
  const c1 = caddy(CADDY_V); const c2 = caddy(CADDY_V2);
  const sum = (f, a) => (canRun ? crypto.createHash(a).update(fs.readFileSync(f)).digest('hex') : '');
  return { dir: d, nodeSha: sum(nodeTar, 'sha256'), caddy: { [CADDY_V]: sum(c1, 'sha512'), [CADDY_V2]: sum(c2, 'sha512') } };
})();

/** A SUDS release tree (what install.sh / upgrade.sh run from): the real deploy/, server/ and scripts, pins for the fixtures. */
function tree(version, { caddy = CADDY_V, caddyfileExtra = '', complianceCheck = null } = {}) {
  const t = path.join(work, `tree-${version}-${++n}`);
  fs.mkdirSync(path.join(t, 'deploy'), { recursive: true }); fs.mkdirSync(path.join(t, 'scripts'));
  fs.cpSync(path.join(REPO, 'deploy', 'linux'), path.join(t, 'deploy', 'linux'), { recursive: true });
  fs.cpSync(path.join(REPO, 'server'), path.join(t, 'server'), { recursive: true });
  for (const f of ['backup.js', 'compliance-check.js', 'dr-drill.js']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(t, 'scripts', f));
  // A stand-in for the compliance check (its host checks need a real host), e.g. one that records its environment.
  if (complianceCheck) fs.writeFileSync(path.join(t, 'scripts', 'compliance-check.js'), complianceCheck);
  fs.cpSync(path.join(REPO, 'scripts', 'compliance'), path.join(t, 'scripts', 'compliance'), { recursive: true });
  fs.writeFileSync(path.join(t, 'package.json'), fs.readFileSync(path.join(REPO, 'package.json'), 'utf8').replace(/^ {2}"version": ".*",$/m, `  "version": "${version}",`));
  fs.writeFileSync(path.join(t, 'Caddyfile'), fs.readFileSync(path.join(REPO, 'Caddyfile'), 'utf8') + caddyfileExtra);
  fs.writeFileSync(path.join(t, 'deploy/linux/pins'), fs.readFileSync(path.join(REPO, 'deploy/linux/pins'), 'utf8')
    .replace(/^NODE_SHA256_LINUX_X64=.*$/m, `NODE_SHA256_LINUX_X64=${fixtures.nodeSha}`)
    .replace(/^CADDY_VERSION=.*$/m, `CADDY_VERSION=${caddy}`).replace(/^CADDY_SHA512_LINUX_AMD64=.*$/m, `CADDY_SHA512_LINUX_AMD64=${fixtures.caddy[caddy]}`));
  return t;
}

/** A fake root and the stub commands. */
function host({ os: osName = 'ubuntu' } = {}) {
  const dir = path.join(work, `host-${++n}`);
  const root = path.join(dir, 'root'); const bin = path.join(dir, 'bin'); const tmp = path.join(dir, 'tmp'); const log = path.join(dir, 'commands.log');
  for (const d of ['etc', 'mnt/worm/suds-anchors', 'mnt/offsite', 'var/lib', 'etc/dnf']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(bin); fs.mkdirSync(tmp); fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(root, 'etc/os-release'), osName === 'ubuntu' ? 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n' : 'ID="rocky"\nVERSION_ID="9.4"\nPRETTY_NAME="Rocky Linux 9.4"\n');
  fs.writeFileSync(path.join(root, 'etc/dnf/automatic.conf'), '[commands]\nupgrade_type = default\napply_updates = no\n');
  const logIt = `echo "$(basename "$0") $*" >> "${log}"`;
  for (const c of ['apt-get', 'dnf', 'ufw', 'timedatectl', 'restorecon', 'chown']) sh(path.join(bin, c), `${logIt}\nexit 0`);
  sh(path.join(bin, 'firewall-cmd'), `${logIt}\n[ "$1" = "--get-default-zone" ] && echo public\nexit 0`);
  // useradd makes the account (a marker file) that id then answers for, with uid and gid 998.
  const users = path.join(dir, 'users'); fs.mkdirSync(users);
  sh(path.join(bin, 'useradd'), `${logIt}\nfor u in "$@"; do :; done\ntouch "${users}/$u"\nexit 0`);
  sh(path.join(bin, 'id'), `[ -e "${users}/$2" ] || exit 1\necho 998`);
  // runuser: "runuser -u suds -- test -w DIR ..." fails for the (unprefixed) directories in HARNESS_UNWRITABLE.
  js(path.join(bin, 'runuser'), `const a = process.argv.slice(2); require('fs').appendFileSync(${JSON.stringify(log)}, 'runuser ' + a.join(' ') + '\\n');
    const root = process.env.SUDS_INSTALL_ROOT; const bad = (process.env.HARNESS_UNWRITABLE || '').split(',').filter(Boolean);
    process.exit(a.some((x) => bad.some((b) => x === root + b)) ? 1 : 0);`);
  sh(path.join(bin, 'uname'), 'echo x86_64');
  sh(path.join(bin, 'findmnt'), 'echo "/dev/mapper/suds-data ext4"');
  sh(path.join(bin, 'lsblk'), "printf 'suds-data crypt\\nsda3 part\\nsda disk\\n'");
  sh(path.join(bin, 'mountpoint'), 'exit 0');
  sh(path.join(bin, 'who'), 'exit 0');
  sh(path.join(bin, 'ss'), 'exit 0');
  sh(path.join(bin, 'getenforce'), 'echo "${HARNESS_GETENFORCE:-Disabled}"');
  // install: the real one, with the ownership it was asked for recorded and left out (the tests are not root).
  js(path.join(bin, 'install'), `const a = process.argv.slice(2); const keep = []; const own = {};
    for (let i = 0; i < a.length; i++) { if (a[i] === '-o' || a[i] === '-g') { own[a[i]] = a[++i]; continue; } keep.push(a[i]); }
    require('fs').appendFileSync(${JSON.stringify(log)}, 'install ' + a.join(' ') + '\\n');
    const r = require('child_process').spawnSync(${JSON.stringify(REAL_INSTALL)}, keep, { stdio: 'inherit' }); process.exit(r.status === null ? 1 : r.status);`);
  // systemctl: recorded; "start suds.service" on the release named by HARNESS_MIGRATE_VERSION migrates the database
  // the way a new release would (a schema this older code does not know, a table, a write-ahead log left behind).
  js(path.join(bin, 'systemctl'), `const fs = require('fs'); const a = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, 'systemctl ' + a.join(' ') + '\\n');
    if (a[0] === 'is-active' || a[0] === 'is-enabled') process.exit(process.env.HARNESS_CHRONY_ACTIVE && a.includes('chrony') ? 0 : 3);
    const root = process.env.SUDS_INSTALL_ROOT;
    // HARNESS_SERVICE_DB: starting suds.service creates the database the way the first start does (bootstrap, and
    // the settings provision.json gives, with the offsite share inside the fake root).
    if (a[0] === 'enable' && a.includes('suds.service') && process.env.HARNESS_SERVICE_DB && !fs.existsSync(root + '/var/lib/suds/suds.db')) {
      const r = require('child_process').spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', \`const db = require('./server/db'); db.open(); require('./server/bootstrap').ensureBootstrap();
        db.setSetting('backup_schedule_hours', '4'); db.setSetting('backup_offsite_dir', \${JSON.stringify(root + '/mnt/offsite')}); db.setSetting('dr_drill_monthly', '1'); db.close();\`],
        { cwd: root + '/opt/suds/current', env: { PATH: process.env.PATH, SUDS_ENV: 'production', SUDS_DATA_DIR: root + '/var/lib/suds', AUDIT_ANCHOR_DIR: root + '/mnt/worm/suds-anchors', CREDENTIALS_DIRECTORY: root + '/etc/suds/credentials', SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x' }, encoding: 'utf8' });
      if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
    }
    if (a[0] === 'start' && a[1] === 'suds.service' && process.env.HARNESS_MIGRATE_VERSION && fs.readlinkSync(root + '/opt/suds/current') === process.env.HARNESS_MIGRATE_VERSION) {
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(root + '/var/lib/suds/suds.db');
      const v = Number(d.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value);
      d.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE migrated_by_the_new_release(x);");
      d.prepare("UPDATE settings SET value=? WHERE key='schema_version'").run(String(v + 3));
      d.prepare("UPDATE settings SET value='written by the new release' WHERE key='org_name'").run();
      fs.appendFileSync(${JSON.stringify(log)}, 'MIGRATED to schema ' + (v + 3) + '\\n');
      process.exit(0); // without closing: the -wal stays, as after a crash
    }
    process.exit(0);`);
  // curl: the fixture tarballs by name; the health check answers for the releases in HARNESS_HEALTHY.
  js(path.join(bin, 'curl'), `const fs = require('fs'); const path = require('path'); const a = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, 'curl ' + a.join(' ') + '\\n');
    const url = a.find((x) => /^https?:/.test(x)); const oi = a.indexOf('-o');
    if (/\\/api\\/health\\/ready$/.test(url)) { const cur = fs.readlinkSync(process.env.SUDS_INSTALL_ROOT + '/opt/suds/current'); process.exit((process.env.HARNESS_HEALTHY || '').split(',').includes(cur) ? 0 : 7); }
    const f = path.join(${JSON.stringify(fixtures.dir)}, path.basename(url));
    if (oi < 0 || !fs.existsSync(f)) process.exit(22);
    fs.copyFileSync(f, a[oi + 1]);`);
  // systemd-run: the command as the service runs it — credentials in a private directory, the environment file,
  // paths mapped into the fake root.
  js(path.join(bin, 'systemd-run'), `const fs = require('fs'); const path = require('path'); const os = require('os'); const a = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, 'systemd-run ' + a.join(' ') + '\\n');
    const root = process.env.SUDS_INSTALL_ROOT; const pre = (p) => (p.startsWith('/') && !p.startsWith(root) ? root + p : p);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', TMPDIR: process.env.TMPDIR || '/tmp' }; const creds = []; const files = []; let cwd = '/'; let i = 0;
    for (; i < a.length; i++) {
      if (a[i].startsWith('--working-directory=')) cwd = a[i].slice(20);
      else if (a[i] === '-p') { const v = a[++i]; if (v.startsWith('LoadCredential=')) creds.push(v.slice(15)); else if (v.startsWith('EnvironmentFile=')) files.push(v.slice(16)); }
      else if (a[i] === '-E') { const v = a[++i]; env[v.slice(0, v.indexOf('='))] = v.slice(v.indexOf('=') + 1); }
      else if (a[i].startsWith('-')) continue; else break;
    }
    for (const f of files) for (const line of fs.readFileSync(pre(f), 'utf8').split('\\n')) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line); if (m) env[m[1]] = pre(m[2]); }
    if (env.SUDS_DATA_DIR) env.SUDS_DATA_DIR = pre(env.SUDS_DATA_DIR);
    const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-')); for (const c of creds) { const [name, p] = c.split(':'); fs.copyFileSync(pre(p), path.join(cd, name)); }
    env.CREDENTIALS_DIRECTORY = cd;
    const r = require('child_process').spawnSync(process.execPath, a.slice(i + 1).map((x) => (x.startsWith('/') ? pre(x) : x)), { cwd: pre(cwd), env, stdio: 'inherit' });
    fs.rmSync(cd, { recursive: true, force: true }); process.exit(r.status === null ? 1 : r.status);`);
  return { dir, root, bin, tmp, log, commands: () => fs.readFileSync(log, 'utf8') };
}

function run(h, script, treeDir, args, env = {}) {
  const e = { PATH: `${h.bin}:${process.env.PATH}`, HOME: process.env.HOME || '/tmp', TMPDIR: h.tmp, SUDS_INSTALL_ROOT: h.root, LANG: 'C', ...env };
  const r = spawnSync('bash', [path.join(treeDir, 'deploy/linux', script), ...args], { env: e, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const INSTALL = ['--domain=suds.county.example.gov', '--admin-cidr=10.20.0.0/16', '--offsite=/mnt/offsite', '--anchors=/mnt/worm/suds-anchors', '--skip-compliance-check'];
const mode = (p) => fs.statSync(p).mode & 0o7777;
const oct = (m) => m.toString(8).padStart(4, '0');
function walk(dir, fn) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); fn(p, e); if (e.isDirectory()) walk(p, fn); } }

test('install.sh for real: code 0755/read-only for everyone, data 0700, credentials 0700 with 0600 keys, a separate compliance key', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION);
  const r = run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION });
  assert.equal(r.code, 0, r.all);
  const R = h.root;
  // Under umask 077, every directory the service or Caddy runs from is still readable and searchable by them.
  for (const top of [`opt/suds/${VERSION}`, `opt/suds/node-${NODE_V}`, `opt/caddy/${CADDY_V}`]) {
    const base = path.join(R, top);
    assert.equal(mode(base) & 0o555, 0o555, `${top} is ${oct(mode(base))}: readable and searchable by all`);
    walk(base, (p, e) => {
      const m = mode(p);
      if (e.isDirectory()) assert.equal(m & 0o055, 0o055, `${path.relative(R, p)} is ${oct(m)}`);
      else if (e.isFile()) assert.equal(m & 0o044, 0o044, `${path.relative(R, p)} is ${oct(m)}`);
    });
  }
  for (const top of [`opt/suds/${VERSION}`, `opt/suds/node-${NODE_V}`]) walk(path.join(R, top), (p) => assert.equal(mode(p) & 0o222, 0, `${path.relative(R, p)} is read-only`));
  for (const d of ['opt/suds', 'opt/caddy', 'etc/suds', 'etc/caddy']) assert.equal(mode(path.join(R, d)), 0o755, d);
  assert.equal(mode(path.join(R, `opt/suds/node-${NODE_V}/bin/node`)) & 0o111, 0o111, 'node is executable by the suds user');
  assert.equal(mode(path.join(R, `opt/caddy/${CADDY_V}/caddy`)), 0o755);
  // Relative symlinks, so they resolve the same in production and here.
  assert.equal(fs.readlinkSync(path.join(R, 'opt/suds/current')), VERSION);
  assert.equal(fs.readlinkSync(path.join(R, 'opt/suds/node')), `node-${NODE_V}`);
  assert.equal(fs.readlinkSync(path.join(R, 'opt/caddy/current')), CADDY_V);
  assert.equal(execFileSync(path.join(R, 'opt/suds/node/bin/node'), ['--version'], { encoding: 'utf8' }).trim(), NODE_V);
  // A completed stage: marker = SHA-256 of the manifest; every file matches.
  const staged = path.join(R, 'opt/suds', VERSION);
  assert.equal(fs.readFileSync(path.join(staged, '.suds-staged'), 'utf8').trim(), crypto.createHash('sha256').update(fs.readFileSync(path.join(staged, '.suds-manifest'))).digest('hex'));
  assert.equal(spawnSync('sha256sum', ['--quiet', '--strict', '-c', '.suds-manifest'], { cwd: staged }).status, 0);
  assert.ok(!fs.existsSync(path.join(R, `opt/suds/${VERSION}.partial`)));
  // Data, credentials, the compliance directory and key.
  assert.equal(mode(path.join(R, 'var/lib/suds')), 0o700);
  assert.equal(mode(path.join(R, 'etc/suds/credentials')), 0o700);
  for (const k of ['suds_encryption_key', 'suds_index_key', 'suds_backup_key', 'suds_signing_key']) {
    const f = path.join(R, 'etc/suds/credentials', k);
    assert.equal(mode(f), 0o600, k); assert.match(fs.readFileSync(f, 'utf8'), /^[0-9a-f]{64}$/, k);
  }
  assert.equal(mode(path.join(R, 'var/lib/suds-compliance')), 0o750);
  const ck = path.join(R, 'etc/suds/compliance-signing-key');
  assert.equal(mode(ck), 0o600); assert.match(fs.readFileSync(ck, 'utf8'), /^[0-9a-f]{64}$/);
  assert.ok(!fs.readdirSync(path.join(R, 'etc/suds/credentials')).some((f) => /compliance/.test(f)), 'not among the service\'s credentials');
  assert.ok(!fs.readFileSync(path.join(R, 'etc/systemd/system/suds.service'), 'utf8').includes('compliance-signing-key'), 'never LoadCredential\'d to suds.service');
  const pub = fs.readFileSync(path.join(R, 'etc/suds/compliance-signing-key.pub.pem'), 'utf8');
  assert.equal(mode(path.join(R, 'etc/suds/compliance-signing-key.pub.pem')), 0o644);
  assert.equal(pub.trim(), require('../server/signing').publicInfo(Buffer.from(fs.readFileSync(ck, 'utf8').trim(), 'hex')).public_key_pem.trim());
  assert.match(r.out, /compliance signing key id [0-9a-f]{16}/);
  // Ownership the installer asked for (recorded by the stubs).
  const cmds = h.commands();
  for (const l of [`install -d -m 0700 -o suds -g suds ${R}/var/lib/suds`, `install -d -m 0700 -o root -g root ${R}/etc/suds/credentials`, `install -d -m 0750 -o root -g suds ${R}/var/lib/suds-compliance`,
    `install -d -m 0755 -o root -g root ${R}/opt/suds ${R}/opt/suds/node-${NODE_V}`, `install -d -m 0755 -o root -g root ${R}/opt/caddy ${R}/opt/caddy/${CADDY_V}`, `chown -R root:root ${R}/opt/suds/${VERSION}.partial`]) assert.ok(cmds.includes(l), `${l}\n${cmds}`);
  for (const k of ['suds_encryption_key', 'compliance-signing-key']) assert.match(cmds, new RegExp(`chown root:root ${R}/etc/suds/(credentials/)?${k}\\.suds-new`), k);
  // Files: contents as intended.
  for (const u of ['suds.service', 'suds-compliance.service', 'suds-compliance.timer', 'caddy.service']) {
    assert.equal(fs.readFileSync(path.join(R, 'etc/systemd/system', u), 'utf8'), fs.readFileSync(path.join(t, 'deploy/linux', u), 'utf8'), u);
    assert.equal(mode(path.join(R, 'etc/systemd/system', u)), 0o644, u);
  }
  const env = fs.readFileSync(path.join(R, 'etc/suds/suds.env'), 'utf8');
  assert.match(env, /^SUDS_COMPLIANCE_DIR=\/var\/lib\/suds-compliance$/m); assert.match(env, /^SUDS_COMPLIANCE_PUBLIC_KEY_FILE=\/etc\/suds\/compliance-signing-key\.pub\.pem$/m);
  assert.ok(!/[0-9a-f]{64}/.test(env), 'no key in the environment file');
  // Passkeys need the relying party in production (app.passkeys): the installer knows it from --domain.
  assert.match(env, /^WEBAUTHN_RP_ID=suds\.county\.example\.gov$/m); assert.match(env, /^WEBAUTHN_ORIGINS=https:\/\/suds\.county\.example\.gov$/m);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(R, 'etc/suds/provision.json'), 'utf8')).settings, { backup_schedule_hours: '4', backup_offsite_dir: '/mnt/offsite', dr_drill_monthly: '1', mfa_require_all: '1' });
  const site = fs.readFileSync(path.join(R, 'etc/systemd/system/suds.service.d/10-site.conf'), 'utf8');
  assert.match(site, /^RequiresMountsFor=\/mnt\/worm\/suds-anchors$/m, 'only the anchors are required');
  assert.match(site, /^ReadWritePaths=\/mnt\/worm\/suds-anchors -\/mnt\/offsite$/m, 'the offsite share is optional: an outage does not stop SUDS');
  assert.match(fs.readFileSync(path.join(R, 'etc/systemd/journald.conf.d/suds.conf'), 'utf8'), /^SystemMaxUse=8G$/m);
  const conf = fs.readFileSync(path.join(R, 'etc/suds/suds-server.conf'), 'utf8');
  for (const l of ['SUDS_COMPLIANCE_DIR=/var/lib/suds-compliance', 'SUDS_COMPLIANCE_SIGNING_KEY_FILE=/etc/suds/compliance-signing-key', 'SUDS_RELEASE_CHECKSUM_SOURCE=local-tree', `SUDS_VERSION=${VERSION}`]) assert.ok(conf.includes(`${l}\n`), l);
  assert.match(conf, /^SUDS_INSTALLED_AT=\d{4}-\d\d-\d\dT[\d:]{8}Z$/m);
  assert.ok(cmds.includes('systemctl enable --now systemd-timesyncd'), 'timesyncd when chrony is not there');
  assert.ok(!/restorecon/.test(cmds), 'no SELinux relabel on Ubuntu');
  fs.writeFileSync(path.join(h.dir, 'first-run.json'), JSON.stringify({ conf }));
});

test('install.sh run again: idempotent — keys kept, first install date kept, operator lines kept, the old SSH rule removed; a broken stage is redone', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION);
  assert.equal(run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION }).code, 0);
  const R = h.root;
  const key = fs.readFileSync(path.join(R, 'etc/suds/credentials/suds_encryption_key'), 'utf8');
  const ckey = fs.readFileSync(path.join(R, 'etc/suds/compliance-signing-key'), 'utf8');
  const confFile = path.join(R, 'etc/suds/suds-server.conf');
  const first = /^SUDS_INSTALLED_AT=(.*)$/m.exec(fs.readFileSync(confFile, 'utf8'))[1];
  fs.appendFileSync(confFile, 'SUDS_LOCAL_NOTE=kept by the operator\n');
  // The operator's own relying party (another name staff open) is never replaced by the installer's default.
  const envFile = path.join(R, 'etc/suds/suds.env');
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^WEBAUTHN_RP_ID=.*$/m, 'WEBAUTHN_RP_ID=suds.county.gov').replace(/^WEBAUTHN_ORIGINS=.*\n/m, ''));
  // An interrupted stage elsewhere, and this release's marker gone: both are dealt with.
  fs.mkdirSync(path.join(R, `opt/suds/${VERSION}.partial/junk`), { recursive: true });
  spawnSync('chmod', ['u+w', path.join(R, 'opt/suds', VERSION)]); fs.unlinkSync(path.join(R, 'opt/suds', VERSION, '.suds-staged'));
  fs.writeFileSync(h.log, '');
  const r = run(h, 'install.sh', t, INSTALL.map((a) => (a.startsWith('--admin-cidr') ? '--admin-cidr=10.30.0.0/16' : a)), { HARNESS_HEALTHY: VERSION });
  assert.equal(r.code, 0, r.all);
  assert.equal(fs.readFileSync(path.join(R, 'etc/suds/credentials/suds_encryption_key'), 'utf8'), key, 'a key is never regenerated');
  assert.equal(fs.readFileSync(path.join(R, 'etc/suds/compliance-signing-key'), 'utf8'), ckey);
  const conf = fs.readFileSync(confFile, 'utf8');
  assert.equal(/^SUDS_INSTALLED_AT=(.*)$/m.exec(conf)[1], first, 'the first install date is kept');
  assert.match(conf, /^SUDS_LOCAL_NOTE=kept by the operator$/m, 'a line the installer does not manage is kept');
  assert.match(conf, /^SUDS_ADMIN_CIDR=10\.30\.0\.0\/16$/m);
  const env2 = fs.readFileSync(envFile, 'utf8');
  assert.match(env2, /^WEBAUTHN_RP_ID=suds\.county\.gov$/m, 'the operator\'s WEBAUTHN_RP_ID is kept');
  assert.ok(!/^WEBAUTHN_ORIGINS=/m.test(env2), 'and no WEBAUTHN_ORIGINS added beside it');
  const cmds = h.commands();
  assert.ok(cmds.includes('ufw allow proto tcp from 10.30.0.0/16 to any port 22'), cmds);
  assert.ok(cmds.includes('ufw delete allow proto tcp from 10.20.0.0/16 to any port 22'), 'the previous SSH rule is removed');
  assert.ok(!fs.existsSync(path.join(R, `opt/suds/${VERSION}.partial`)), 'the leftover .partial is removed');
  assert.match(r.err, /is not a complete staged release/);
  assert.ok(fs.existsSync(path.join(R, 'opt/suds', VERSION, '.suds-staged')), 'restaged with its marker');
  assert.equal(fs.readdirSync(path.join(R, 'opt/suds')).filter((f) => f.includes('.replaced.')).length, 0);
});

/**
 * A ufw that keeps its rules (in <host>/ufw-rules.json) and deletes the way the real one does: a rule is stored by
 * protocol, source and port, and a source of 0.0.0.0/0 or ::/0 is stored as Anywhere or Anywhere (v6), so
 * `ufw delete allow 22/tcp` removes `allow proto tcp from 0.0.0.0/0 to any port 22` (the 1.25.1 launch: HANDOFF
 * 2026-10-08, finding 1) and `... from ::/0 ...` too (1.25.4, G10). A rule with no source is one for each family, as
 * `ufw status` lists it. Commands are logged like the other stubs'.
 */
// A Lightsail Ubuntu image's own open SSH rules, and the web ports the installer opens, as `ufw status` lists them.
const IMAGE_RULES = ['22', 'OpenSSH'].flatMap((port) => [{ port, from: 'Anywhere' }, { port, from: 'Anywhere (v6)' }]);
const OPEN_443_80 = ['443/tcp', '80/tcp'].flatMap((port) => [{ port, from: 'Anywhere' }, { port, from: 'Anywhere (v6)' }]);
function statefulUfw(h, rules = []) {
  const file = path.join(h.dir, 'ufw-rules.json'); fs.writeFileSync(file, JSON.stringify(rules));
  js(path.join(h.bin, 'ufw'), `const fs = require('fs'); const a = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(h.log)}, 'ufw ' + a.join(' ') + '\\n');
    const file = ${JSON.stringify(file)}; let rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    const froms = (s) => (!s || s === 'any' ? ['Anywhere', 'Anywhere (v6)'] : [s === '0.0.0.0/0' ? 'Anywhere' : s === '::/0' ? 'Anywhere (v6)' : s]);
    const parse = (w) => { const c = w.indexOf('comment'); if (c >= 0) w = w.slice(0, c);
      if (w[0] === 'proto') { const g = (k) => w[w.indexOf(k) + 1]; return froms(g('from')).map((from) => ({ port: g('port') + '/' + g('proto'), from })); }
      if (w.length !== 1) process.exit(2);
      return froms().map((from) => ({ port: w[0], from })); };
    const same = (x, y) => x.port === y.port && x.from === y.from;
    if (a[0] === 'allow') { for (const r of parse(a.slice(1))) if (!rules.some((x) => same(x, r))) rules.push(r); }
    else if (a[0] === 'delete' && a[1] === 'allow') { const del = parse(a.slice(2)); const n = rules.length; rules = rules.filter((x) => !del.some((r) => same(x, r))); if (rules.length === n) { console.error('Could not delete non-existent rule'); process.exit(1); } }
    else if (a[0] === 'status') { console.log('Status: active\\n\\nTo                         Action      From\\n--                         ------      ----'); for (const r of rules) console.log((r.port + (r.from === 'Anywhere (v6)' ? ' (v6)' : '')).padEnd(27) + 'ALLOW       ' + r.from); process.exit(0); }
    fs.writeFileSync(file, JSON.stringify(rules));`);
  return () => JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('install.sh for real with --admin-cidr=0.0.0.0/0: the SSH rule it adds is still there at the end (1.25.1 deleted it), and the rules are shown', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION);
  // A cloud image's own open rules, as Lightsail's Ubuntu has them.
  const rules = statefulUfw(h, IMAGE_RULES);
  const r = run(h, 'install.sh', t, INSTALL.map((a) => (a.startsWith('--admin-cidr') ? '--admin-cidr=0.0.0.0/0' : a)), { HARNESS_HEALTHY: VERSION });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(rules(), [{ port: '22/tcp', from: 'Anywhere' }, ...OPEN_443_80], 'SSH stays allowed: the stale rules went first');
  const cmds = h.commands();
  assert.ok(cmds.lastIndexOf('ufw delete allow') < cmds.indexOf('ufw allow proto tcp from 0.0.0.0/0 to any port 22'), 'every delete comes before the admin rule');
  assert.match(r.out, /== Firewall rules in force ==\n(?:.*\n)*? {2}22\/tcp +ALLOW +Anywhere\n/, 'the final rules are printed');
  assert.ok(r.out.lastIndexOf('== Firewall rules in force ==') > r.out.indexOf('KEY ESCROW'), 'at the very end, where the operator reads');
  assert.doesNotMatch(r.err, /NO FIREWALL RULE ALLOWS SSH/);
  // And ::/0 the same way, run again over the first install (the previous 0.0.0.0/0 rule is replaced, not kept).
  const v6 = run(h, 'install.sh', t, INSTALL.map((a) => (a.startsWith('--admin-cidr') ? '--admin-cidr=::/0' : a)), { HARNESS_HEALTHY: VERSION });
  assert.ok(rules().some((x) => x.port === '22/tcp' && x.from === 'Anywhere (v6)'), `IPv6 anywhere keeps its SSH rule too:\n${v6.all}`);
});

test('install.sh for real with --admin-cidr6=::/0 (1.25.4, G10): SSH on IPv4 and IPv6 at the end, and still after every re-run', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION);
  const rules = statefulUfw(h, IMAGE_RULES);
  const args = (...extra) => [...INSTALL.map((a) => (a.startsWith('--admin-cidr') ? '--admin-cidr=203.0.113.10/32' : a)), ...extra];
  const v4 = { port: '22/tcp', from: '203.0.113.10/32' }; const v6 = { port: '22/tcp', from: 'Anywhere (v6)' };
  const ssh = () => rules().filter((x) => /^(22|OpenSSH)/.test(x.port));
  const conf = () => fs.readFileSync(path.join(h.root, 'etc/suds/suds-server.conf'), 'utf8');
  let r = run(h, 'install.sh', t, args('--admin-cidr6=::/0'), { HARNESS_HEALTHY: VERSION });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(ssh(), [v4, v6], 'the image\'s open rules are gone; SSH from the IPv4 network and from any IPv6 address');
  assert.deepEqual(rules().filter((x) => !/^(22|OpenSSH)/.test(x.port)), OPEN_443_80);
  assert.match(conf(), /^SUDS_ADMIN_CIDR6=::\/0$/m);
  assert.match(r.out, /== Firewall rules in force ==\n(?:.*\n)*? {2}22\/tcp \(v6\) +ALLOW +Anywhere \(v6\)\n/, 'the IPv6 rule is printed with the rules in force');
  assert.doesNotMatch(r.err, /NO FIREWALL RULE ALLOWS SSH/);
  // A re-run with the same option, and one without it (kept from the settings): the rule survives both.
  for (const extra of [['--admin-cidr6=::/0'], []]) {
    r = run(h, 'install.sh', t, args(...extra), { HARNESS_HEALTHY: VERSION });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(ssh(), [v4, v6], `re-run ${extra.join(' ') || 'without --admin-cidr6'}: SSH on IPv6 is still allowed`);
  }
  // Another IPv6 network replaces it; none removes it.
  r = run(h, 'install.sh', t, args('--admin-cidr6=2001:db8:10::/48'), { HARNESS_HEALTHY: VERSION });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(ssh(), [v4, { port: '22/tcp', from: '2001:db8:10::/48' }]);
  r = run(h, 'install.sh', t, args('--admin-cidr6=none'), { HARNESS_HEALTHY: VERSION });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(ssh(), [v4]); assert.match(conf(), /^SUDS_ADMIN_CIDR6=$/m);
});

test('install.sh for real: when no rule allows SSH at the end, it says so loudly, with the command that fixes it', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION);
  statefulUfw(h);
  // A ufw that loses the SSH rule (another tool's cleanup, a broken profile): the installer cannot stop it, but must not keep quiet.
  const ufw = path.join(h.bin, 'ufw'); fs.writeFileSync(ufw, fs.readFileSync(ufw, 'utf8').replace("if (a[0] === 'allow')", "if (a[0] === 'allow' && a.includes('22')) {} else if (a[0] === 'allow')"));
  const r = run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION });
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /NO FIREWALL RULE ALLOWS SSH \(port 22\)/);
  assert.match(r.err, /ufw allow proto tcp from 10\.20\.0\.0\/16 to any port 22/);
});

test('install.sh for real on Rocky 9: chrony with the county time source, SELinux relabel when enforcing, curl-minimal left alone', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host({ os: 'rocky' }); const t = tree(VERSION);
  fs.writeFileSync(path.join(h.root, 'etc/chrony.conf'), 'pool 2.rhel.pool.ntp.org iburst\n');
  const r = run(h, 'install.sh', t, [...INSTALL, '--ntp-server=ntp1.county.gov,10.0.0.5'], { HARNESS_HEALTHY: VERSION, HARNESS_GETENFORCE: 'Enforcing' });
  assert.equal(r.code, 0, r.all);
  const R = h.root; const cmds = h.commands();
  assert.match(cmds, /^dnf install -y -q ca-certificates xz unzip tar firewalld chrony dnf-automatic$/m, 'curl is present (curl-minimal): not installed over it');
  assert.equal(fs.readFileSync(path.join(R, 'etc/chrony.d/suds.conf'), 'utf8'), 'server ntp1.county.gov iburst prefer\nserver 10.0.0.5 iburst prefer\n');
  assert.match(fs.readFileSync(path.join(R, 'etc/chrony.conf'), 'utf8'), /^include \/etc\/chrony\.d\/\*\.conf$/m);
  assert.ok(cmds.includes('systemctl restart chronyd'));
  assert.match(cmds, new RegExp(`^restorecon -R ${R}/opt/suds `, 'm'), 'relabelled for SELinux');
  assert.match(fs.readFileSync(path.join(R, 'etc/dnf/automatic.conf'), 'utf8'), /upgrade_type = security\napply_updates = yes/);
  assert.match(fs.readFileSync(path.join(R, 'etc/suds/suds-server.conf'), 'utf8'), /^SUDS_NTP_SERVERS=ntp1\.county\.gov,10\.0\.0\.5$/m);
});

test('install.sh for real on Ubuntu with chrony already running: chrony is kept, systemd-timesyncd not installed', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION);
  const r = run(h, 'install.sh', t, [...INSTALL, '--ntp-server=ntp.county.gov'], { HARNESS_HEALTHY: VERSION, HARNESS_CHRONY_ACTIVE: '1' });
  assert.equal(r.code, 0, r.all);
  const cmds = h.commands();
  assert.ok(!/systemd-timesyncd/.test(cmds), 'timesyncd neither installed nor enabled');
  assert.ok(cmds.includes('systemctl enable --now chrony'));
  assert.equal(fs.readFileSync(path.join(h.root, 'etc/chrony/sources.d/suds.sources'), 'utf8'), 'server ntp.county.gov iburst prefer\n');
});

/** An installed OLD release with a real database, ready for upgrade.sh. */
function installedOld() {
  const h = host(); const old = tree(OLD);
  const r = run(h, 'install.sh', old, [...INSTALL, `--version=${OLD}`], { HARNESS_HEALTHY: OLD });
  assert.equal(r.code, 0, r.all);
  const R = h.root;
  const creds = path.join(h.dir, 'creds'); fs.cpSync(path.join(R, 'etc/suds/credentials'), creds, { recursive: true });
  const mk = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', `const db = require('./server/db'); db.open(); require('./server/bootstrap').ensureBootstrap(); db.setSetting('org_name', 'County SUD programme'); require('./server/audit').log({ user: { username: 'system' }, action: 'test.before_upgrade' }); db.close();`],
    { cwd: path.join(R, 'opt/suds/current'), env: { PATH: process.env.PATH, SUDS_ENV: 'production', SUDS_DATA_DIR: path.join(R, 'var/lib/suds'), AUDIT_ANCHOR_DIR: path.join(R, 'mnt/worm/suds-anchors'), CREDENTIALS_DIRECTORY: creds, SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x' }, encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr);
  const q = (sql) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(path.join(R, 'var/lib/suds/suds.db'), { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
  return { h, R, q, schema: Number(q(`SELECT value FROM settings WHERE key='schema_version'`)[0].value) };
}

test('upgrade.sh for real: the new release migrates the database and never becomes ready — rolled back to the old code on the backup, journals gone', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const { h, R, q, schema } = installedOld();
  const next = tree(VERSION, { caddy: CADDY_V2 });
  fs.writeFileSync(h.log, '');
  const r = run(h, 'upgrade.sh', next, [VERSION, '--ready-timeout=2', '--skip-compliance-check'], { HARNESS_HEALTHY: OLD, HARNESS_MIGRATE_VERSION: VERSION });
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, new RegExp(`REFUSED: the upgrade to ${VERSION.replace(/\./g, '\\.')} failed and was rolled back: SUDS ${OLD.replace(/\./g, '\\.')} is running on the database as it was before the upgrade`));
  const cmds = h.commands();
  assert.match(cmds, /MIGRATED to schema/, 'the new release did migrate the database before failing');
  assert.ok(cmds.indexOf('scripts/backup.js --restore-in-place') > cmds.indexOf('MIGRATED'), 'restored after the migration');
  // Checked before this test reads the file: the restored database is in WAL mode (1.25.2, BO1), and a read-only
  // reader of a WAL database leaves its own -wal/-shm beside it.
  assert.ok(!fs.existsSync(path.join(R, 'var/lib/suds/suds.db-wal')) && !fs.existsSync(path.join(R, 'var/lib/suds/suds.db-shm')), 'no journal of the migrated database beside the restored one');
  assert.equal(fs.readlinkSync(path.join(R, 'opt/suds/current')), OLD, 'the old code is live');
  assert.equal(fs.readlinkSync(path.join(R, 'opt/caddy/current')), CADDY_V, 'and the old Caddy');
  assert.equal(Number(q(`SELECT value FROM settings WHERE key='schema_version'`)[0].value), schema, 'the database is the pre-upgrade backup');
  assert.equal(q(`SELECT value FROM settings WHERE key='org_name'`)[0].value, 'County SUD programme');
  assert.equal(q(`SELECT name FROM sqlite_master WHERE name='migrated_by_the_new_release'`).length, 0);
  const aside = fs.readdirSync(path.join(R, 'var/lib/suds')).find((f) => f.startsWith('suds.db.replaced-'));
  assert.ok(aside && fs.readdirSync(path.join(R, 'var/lib/suds', aside)).includes('suds.db.enc'), 'the migrated database is kept aside, sealed');
  assert.match(fs.readFileSync(path.join(R, 'etc/suds/suds-server.conf'), 'utf8'), new RegExp(`^SUDS_VERSION=${OLD.replace(/\./g, '\\.')}$`, 'm'));
  assert.ok(q(`SELECT 1 FROM audit_log WHERE action='backup.restore'`).length, 'the restore is in the audit log');
  // The old code opens the restored database.
  const open = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', `const db = require('./server/db'); db.open(); db.close();`],
    { cwd: path.join(R, 'opt/suds/current'), env: { PATH: process.env.PATH, SUDS_ENV: 'production', SUDS_DATA_DIR: path.join(R, 'var/lib/suds'), CREDENTIALS_DIRECTORY: path.join(R, 'etc/suds/credentials') }, encoding: 'utf8' });
  assert.equal(open.status, 0, open.stderr);
});

test('upgrade.sh for real: a successful upgrade swaps the code, installs the newly pinned Caddy, checks its version and restarts it', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const { h, R } = installedOld();
  const next = tree(VERSION, { caddy: CADDY_V2, caddyfileExtra: '\n# changed\n' });
  fs.writeFileSync(h.log, '');
  // A server installed before the installer set WEBAUTHN_RP_ID (1.19.0 and earlier): the upgrade adds it.
  const envFile = path.join(R, 'etc/suds/suds.env');
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^WEBAUTHN_.*\n/mg, ''));
  const r = run(h, 'upgrade.sh', next, [VERSION, '--ready-timeout=2', '--skip-compliance-check'], { HARNESS_HEALTHY: `${OLD},${VERSION}` });
  assert.equal(r.code, 0, r.all);
  assert.equal(fs.readlinkSync(path.join(R, 'opt/suds/current')), VERSION);
  assert.equal(fs.readlinkSync(path.join(R, 'opt/caddy/current')), CADDY_V2);
  assert.match(r.out, new RegExp(`Caddy answers v${CADDY_V2.replace(/\./g, '\\.')}`));
  const cmds = h.commands();
  assert.ok(cmds.includes('systemctl restart caddy.service'), 'Caddy restarted for the new pin and Caddyfile');
  assert.ok(cmds.indexOf('systemctl restart caddy.service') > cmds.indexOf('systemctl start suds.service'), 'after SUDS is ready');
  assert.match(fs.readFileSync(path.join(R, 'etc/caddy/Caddyfile'), 'utf8'), /# changed/);
  assert.equal(mode(path.join(R, `opt/caddy/${CADDY_V2}`)), 0o755);
  assert.ok(fs.readdirSync(path.join(R, 'var/lib/suds/backups')).some((f) => f.startsWith('pre-upgrade-')), 'the pre-upgrade backup');
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /^WEBAUTHN_RP_ID=suds\.county\.example\.gov$/m, 'the upgrade sets the relying party from the installed domain');
  assert.match(env, /^WEBAUTHN_ORIGINS=https:\/\/suds\.county\.example\.gov$/m);
  assert.match(env, /^TRUST_PROXY=1$/m, 'and keeps the rest of the file');
});

test('upgrade.sh for real, run as installed (/opt/suds/current): once the new release is staged and checked, its own upgrade.sh takes over (the 1.19.0 one did not add WEBAUTHN_RP_ID)', { skip: !(canRun && has('zip')) && 'xz, unzip, zip or tar missing' }, () => {
  const { h, R } = installedOld();
  const next = tree(VERSION, { caddy: CADDY_V2 });
  // The new release's upgrade.sh differs from the installed one: it says so when it runs, and what it was given.
  const up = path.join(next, 'deploy/linux/upgrade.sh');
  fs.writeFileSync(up, fs.readFileSync(up, 'utf8').replace('say "SUDS Server upgrade: $CUR -> $VERSION"', 'say "SUDS Server upgrade: $CUR -> $VERSION"; say "NEW UPGRADER RUNNING (handover=${SUDS_UPGRADER_HANDOVER:-}) args: $*"'));
  const z = releaseZip(next, VERSION);
  const envFile = path.join(R, 'etc/suds/suds.env');
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^WEBAUTHN_.*\n/mg, ''));
  fs.writeFileSync(h.log, '');
  // The documented command: the upgrade.sh installed with the running release.
  const installed = path.join(R, 'opt/suds', OLD);
  const r = run(h, 'upgrade.sh', installed, [VERSION, `--source=${z.file}`, `--release-sha256=${z.sha}`, '--ready-timeout=2', '--skip-compliance-check'], { HARNESS_HEALTHY: `${OLD},${VERSION}` });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /handing over to it/, 'the installed upgrade.sh hands over');
  assert.match(r.out, new RegExp(`NEW UPGRADER RUNNING \\(handover=1\\) args: ${VERSION.replace(/\./g, '\\.')} --source=`), 'the staged release\'s upgrade.sh ran, with the same arguments');
  assert.equal((r.out.match(/NEW UPGRADER RUNNING/g) || []).length, 1, 'once: the new one does not hand over again');
  assert.equal((h.commands().match(/systemctl stop suds\.service/g) || []).length, 1, 'SUDS stopped once, by the new upgrader only');
  assert.equal(fs.readlinkSync(path.join(R, 'opt/suds/current')), VERSION);
  assert.match(fs.readFileSync(path.join(R, 'etc/suds/suds-server.conf'), 'utf8'), /^SUDS_RELEASE_CHECKSUM_SOURCE=operator$/m, 'the zip\'s checksum source is kept across the hand-over');
  assert.match(fs.readFileSync(envFile, 'utf8'), /^WEBAUTHN_RP_ID=suds\.county\.example\.gov$/m);
});

// ---- Site-local Caddy configuration (the 1.25.1 launch: a www block appended to /etc/caddy/Caddyfile by hand) ----

const WWW_BLOCK = '\nwww.suds.county.example.gov {\n\tredir https://suds.county.example.gov{uri} permanent\n}\n';

test('upgrade.sh for real: site blocks appended to /etc/caddy/Caddyfile are moved to Caddyfile.d, not discarded; the release\'s Caddyfile imports them', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const { h, R } = installedOld();
  const live = path.join(R, 'etc/caddy/Caddyfile');
  const operators = fs.readFileSync(live, 'utf8') + WWW_BLOCK;
  fs.writeFileSync(live, operators);
  const next = tree(VERSION, { caddyfileExtra: '\n# changed\n' });
  fs.writeFileSync(h.log, '');
  const r = run(h, 'upgrade.sh', next, [VERSION, '--ready-timeout=2', '--skip-compliance-check'], { HARNESS_HEALTHY: `${OLD},${VERSION}` });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /site blocks added after the release's own: they will be moved to \/etc\/caddy\/Caddyfile\.d\/local\.caddy/);
  assert.ok(r.out.indexOf('will be moved') < r.out.indexOf('== 2-3. Stop SUDS'), 'decided before SUDS is stopped');
  assert.equal(fs.readFileSync(live, 'utf8'), fs.readFileSync(path.join(next, 'Caddyfile'), 'utf8'), 'the release\'s Caddyfile is installed');
  assert.match(fs.readFileSync(live, 'utf8'), /^import \/etc\/caddy\/Caddyfile\.d\/\*\.caddy$/m, 'and it imports the site-local directory');
  const moved = fs.readFileSync(path.join(R, 'etc/caddy/Caddyfile.d/local.caddy'), 'utf8');
  assert.ok(moved.includes(WWW_BLOCK.trim()), moved);
  const saved = fs.readdirSync(path.join(R, 'etc/caddy')).filter((f) => f.startsWith('Caddyfile.local-'));
  assert.equal(saved.length, 1); assert.equal(fs.readFileSync(path.join(R, 'etc/caddy', saved[0]), 'utf8'), operators, 'the operator\'s whole file is kept');
  assert.ok(h.commands().includes('systemctl restart caddy.service'), 'Caddy restarted with the new Caddyfile');
  // The next upgrade finds the release's own Caddyfile and nothing to move.
  const third = tree('99.0.0', { caddyfileExtra: '\n# changed again\n' });
  const r2 = run(h, 'upgrade.sh', third, ['99.0.0', '--ready-timeout=2', '--skip-compliance-check'], { HARNESS_HEALTHY: `${VERSION},99.0.0` });
  assert.equal(r2.code, 0, r2.all);
  assert.doesNotMatch(r2.all, /will be moved|local changes/);
  assert.equal(fs.readFileSync(path.join(R, 'etc/caddy/Caddyfile.d/local.caddy'), 'utf8'), moved, 'and the site-local file is left as it is');
});

test('upgrade.sh for real: any other edit to /etc/caddy/Caddyfile stops it before anything is stopped or changed, saying what to do', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const { h, R } = installedOld();
  const live = path.join(R, 'etc/caddy/Caddyfile');
  const edited = fs.readFileSync(live, 'utf8').replace('encode gzip', 'encode gzip zstd');
  fs.writeFileSync(live, edited);
  const caddyBefore = fs.readlinkSync(path.join(R, 'opt/caddy/current'));
  const next = tree(VERSION, { caddy: CADDY_V2, caddyfileExtra: '\n# changed\n' });
  fs.writeFileSync(h.log, '');
  const r = run(h, 'upgrade.sh', next, [VERSION, '--ready-timeout=2', '--skip-compliance-check'], { HARNESS_HEALTHY: `${OLD},${VERSION}` });
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /REFUSED: \/etc\/caddy\/Caddyfile has local changes .* SUDS and Caddy have not been touched/);
  assert.match(r.err, new RegExp(`Move what you added into a file /etc/caddy/Caddyfile\\.d/<name>\\.caddy .*\\(cp /opt/suds/${OLD.replace(/\./g, '\\.')}/Caddyfile /etc/caddy/Caddyfile`));
  assert.ok(!/systemctl (stop|start|restart)/.test(h.commands()), 'SUDS and Caddy were not stopped or restarted');
  assert.equal(fs.readFileSync(live, 'utf8'), edited, 'the edited Caddyfile is untouched');
  assert.equal(fs.readlinkSync(path.join(R, 'opt/suds/current')), OLD);
  assert.equal(fs.readlinkSync(path.join(R, 'opt/caddy/current')), caddyBefore, 'not even the Caddy symlink');
  // A re-run of install.sh is held to the same rule.
  const again = run(h, 'install.sh', next, [...INSTALL, `--version=${OLD}`], { HARNESS_HEALTHY: OLD });
  assert.equal(again.code, 1, again.all);
  assert.match(again.err, /REFUSED: \/etc\/caddy\/Caddyfile has local changes/);
});

test('upgrade.sh for real: a rollback after moving the appended blocks puts the operator\'s Caddyfile back as it was', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const { h, R } = installedOld();
  const live = path.join(R, 'etc/caddy/Caddyfile');
  const operators = fs.readFileSync(live, 'utf8') + WWW_BLOCK;
  fs.writeFileSync(live, operators);
  const r = run(h, 'upgrade.sh', tree(VERSION, { caddyfileExtra: '\n# changed\n' }), [VERSION, '--ready-timeout=2', '--skip-compliance-check'], { HARNESS_HEALTHY: OLD });
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /failed and was rolled back/);
  assert.equal(fs.readFileSync(live, 'utf8'), operators, 'the old release does not import Caddyfile.d: its operator\'s file is restored');
});

test('install.sh for real --www-redirect: www.<domain> redirects permanently to the domain, in a site-local file', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION);
  const r = run(h, 'install.sh', t, [...INSTALL.map((a) => (a.startsWith('--domain') ? '--domain=SUDS.County.Example.gov' : a)), '--www-redirect'], { HARNESS_HEALTHY: VERSION });
  assert.equal(r.code, 0, r.all);
  const f = path.join(h.root, 'etc/caddy/Caddyfile.d/www-redirect.caddy');
  assert.equal(mode(f), 0o644);
  const block = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  assert.equal(block, 'www.suds.county.example.gov {\n\timport {$SUDS_CADDY_TLS:/dev/null}\n\theader -Server\n\tredir https://suds.county.example.gov{uri} permanent\n}\n');
  assert.equal(mode(path.join(h.root, 'etc/caddy/Caddyfile.d')), 0o755);
});

// ---- Found by the installer run in a systemd container (docs/evidence/installer-container-run-2026-09-30, 1.19.0) ----

/** A tree as a release zip, the way release.yml builds it: one top directory, suds-v<version>/. */
function releaseZip(t, version) {
  const d = path.join(work, `zip-${++n}`); fs.mkdirSync(d);
  fs.cpSync(t, path.join(d, `suds-v${version}`), { recursive: true });
  const file = path.join(work, `suds-v${version}-${n}.zip`);
  execFileSync('zip', ['-qr', file, `suds-v${version}`], { cwd: d });
  return { file, sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

test('install.sh for real: a first run that stops after staging keeps how the release zip was checked, and the next run records it (1.19.0 wrote it empty)', { skip: !(canRun && has('zip')) && 'xz, unzip, zip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION); const z = releaseZip(t, VERSION);
  const badCaddy = path.join(work, `caddy-not-${++n}.tar.gz`); fs.writeFileSync(badCaddy, 'not the pinned Caddy');
  const first = run(h, 'install.sh', t, [...INSTALL, `--source=${z.file}`, `--release-sha256=${z.sha}`, `--caddy-tarball=${badCaddy}`], { HARNESS_HEALTHY: VERSION });
  assert.equal(first.code, 1, first.all);
  assert.match(first.err, /REFUSED: checksum mismatch for caddy_/);
  const staged = path.join(h.root, 'opt/suds', VERSION);
  assert.ok(fs.existsSync(path.join(staged, '.suds-staged')), 'the release was staged before the run stopped');
  assert.ok(!fs.existsSync(path.join(h.root, 'etc/suds/suds-server.conf')), 'and the site settings were not written yet');
  assert.equal(fs.readFileSync(path.join(staged, '.suds-release-checksum'), 'utf8'), 'operator\n', 'how the zip was checked is recorded inside the staged release');
  assert.match(fs.readFileSync(path.join(staged, '.suds-manifest'), 'utf8'), / \.\/\.suds-release-checksum$/m, 'and covered by its manifest');
  // The operator fixes the cause and runs again (here from the unpacked tree, without the checksum): the staged
  // release is reused, and so is its record.
  const second = run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION });
  assert.equal(second.code, 0, second.all);
  assert.match(second.out, /its zip was checked when staged: operator/);
  const conf = path.join(h.root, 'etc/suds/suds-server.conf');
  assert.match(fs.readFileSync(conf, 'utf8'), /^SUDS_RELEASE_CHECKSUM_SOURCE=operator$/m);
  // And it stays so on every later run.
  assert.equal(run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION }).code, 0);
  assert.match(fs.readFileSync(conf, 'utf8'), /^SUDS_RELEASE_CHECKSUM_SOURCE=operator$/m);
});

test('install.sh for real: shares the suds user cannot write are refused together in one run, with the commands that fix them; the account is made first so they can be checked as it', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  const h = host(); const t = tree(VERSION);
  const r = run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION, HARNESS_UNWRITABLE: '/mnt/worm/suds-anchors,/mnt/offsite' });
  assert.equal(r.code, 1, r.all);
  assert.equal((r.err.match(/REFUSED/g) || []).length, 1, 'one refusal');
  assert.match(r.err, /REFUSED: 2 shares are not writable by the suds user \(uid 998, gid 998\)/);
  for (const d of ['/mnt/worm/suds-anchors', '/mnt/offsite']) {
    assert.ok(r.err.includes(`chown suds:suds ${d} && chmod 0700 ${d}`), `${d}: the chown/chmod\n${r.err}`);
    assert.ok(r.err.includes(`setfacl -m u:suds:rwx ${d}`), `${d}: the ACL alternative`);
  }
  const cmds = h.commands();
  assert.match(cmds, /^useradd --system --user-group --home-dir \/var\/lib\/suds --no-create-home --shell \/usr\/sbin\/nologin suds$/m);
  assert.ok(cmds.indexOf('useradd') < cmds.indexOf('runuser -u suds'), 'the account exists before the shares are checked as it');
  assert.ok(!fs.existsSync(path.join(h.root, 'opt/suds', VERSION)), 'refused before anything was staged');
  assert.ok(!/apt-get install/.test(cmds), 'or installed');
  // One share fixed: the other is still named, alone.
  const one = run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION, HARNESS_UNWRITABLE: '/mnt/offsite' });
  assert.equal(one.code, 1); assert.match(one.err, /REFUSED: \/mnt\/offsite \(the offsite share/); assert.ok(!one.err.includes('chown suds:suds /mnt/worm'));
  // Both fixed: the next run goes through, and the account is not made again.
  fs.writeFileSync(h.log, '');
  const again = run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION });
  assert.equal(again.code, 0, again.all);
  assert.ok(!/^useradd .* suds$/m.test(h.commands()), 'the suds account already exists');
});

test('install.sh for real, day one: the first backup and recovery drill run before the compliance check, which runs with the service\'s settings (TRUST_PROXY, WEBAUTHN_RP_ID) once HTTPS answers', { skip: !canRun && 'xz, unzip or tar missing' }, () => {
  // The check itself needs a real host: this stand-in records the environment it was started with.
  const recorder = `'use strict';
const keys = ['TRUST_PROXY', 'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGINS', 'SUDS_ENV', 'SUDS_DATA_DIR', 'AUDIT_ANCHOR_DIR', 'LOCAL_MODE_ENABLED'];
require('fs').writeFileSync(process.env.SUDS_INSTALL_ROOT + '/compliance-env.json', JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] === undefined ? null : process.env[k]]))));
`;
  const h = host(); const t = tree(VERSION, { complianceCheck: recorder });
  const r = run(h, 'install.sh', t, INSTALL.filter((a) => a !== '--skip-compliance-check'), { HARNESS_HEALTHY: VERSION, HARNESS_SERVICE_DB: '1' });
  assert.equal(r.code, 0, r.all);
  const R = h.root;
  // 1.19.0 ran the check without /etc/suds/suds.env: app.https failed (no TRUST_PROXY) on the installer's report
  // and passed on the weekly unit's, which has EnvironmentFile=/etc/suds/suds.env.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(R, 'compliance-env.json'), 'utf8')), {
    TRUST_PROXY: '1', WEBAUTHN_RP_ID: 'suds.county.example.gov', WEBAUTHN_ORIGINS: 'https://suds.county.example.gov', SUDS_ENV: 'production',
    SUDS_DATA_DIR: '/var/lib/suds', AUDIT_ANCHOR_DIR: '/mnt/worm/suds-anchors', LOCAL_MODE_ENABLED: 'false' });
  const cmds = h.commands();
  const started = cmds.indexOf('systemctl enable --now suds.service');
  const drill = cmds.search(/^systemd-run .*--uid=suds .*scripts\/dr-drill\.js --offsite$/m);
  const https = cmds.search(/^curl .*https:\/\/suds\.county\.example\.gov\/api\/health\/ready$/m);
  assert.ok(started > -1 && drill > started, 'the first drill runs once SUDS is up');
  assert.ok(https > drill, 'the check waits for HTTPS through Caddy');
  assert.match(r.out, /First backup and recovery drill/);
  // The drill took the first scheduled backup, copied it offsite and restored that copy: the database says so.
  const q = (sql) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(path.join(R, 'var/lib/suds/suds.db'), { readOnly: true }); try { return d.prepare(sql).get(); } finally { d.close(); } };
  assert.match(q(`SELECT value FROM settings WHERE key='last_scheduled_backup_status'`).value, /^ok/);
  const last = JSON.parse(q(`SELECT value FROM settings WHERE key='dr_last_drill'`).value);
  assert.equal(last.ok, true, JSON.stringify(last)); assert.equal(last.backup_copy, 'offsite');
  assert.ok(fs.readdirSync(path.join(R, 'mnt/offsite')).some((f) => /^suds-\d.*\.db\.enc$/.test(f)), 'the offsite share has the backup');
  // Security status (and so the app lines of the compliance report) on that database, with the service's settings.
  const envFile = Object.fromEntries(fs.readFileSync(path.join(R, 'etc/suds/suds.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const st = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', `const db = require('./server/db'); db.open(); const st = require('./server/security-status').status({ host: false }); db.close();
    process.stdout.write(JSON.stringify(Object.fromEntries(st.items.map((i) => [i.name, i.level]))));`],
  { cwd: path.join(R, 'opt/suds/current'), encoding: 'utf8', env: { PATH: process.env.PATH, ...envFile, SUDS_ENV: 'production', SUDS_DATA_DIR: path.join(R, 'var/lib/suds'), AUDIT_ANCHOR_DIR: path.join(R, 'mnt/worm/suds-anchors'),
    SUDS_COMPLIANCE_DIR: path.join(R, 'var/lib/suds-compliance'), SUDS_COMPLIANCE_PUBLIC_KEY_FILE: path.join(R, 'etc/suds/compliance-signing-key.pub.pem'), SUDS_PROVISION_FILE: '', CREDENTIALS_DIRECTORY: path.join(R, 'etc/suds/credentials') } });
  assert.equal(st.status, 0, st.stderr);
  const levels = JSON.parse(st.stdout);
  assert.equal(levels['Scheduled encrypted backups'], 'ok', 'app.backups');
  assert.equal(levels['Last recovery drill'], 'ok', 'app.dr_drill');
  assert.equal(levels.HTTPS, 'ok', 'app.https');
  assert.notEqual(levels['Fingerprint sign-in (passkeys)'], 'bad', 'app.passkeys');
  // Run again (a repair): there are backups now, so no second "first" drill.
  fs.writeFileSync(h.log, '');
  assert.equal(run(h, 'install.sh', t, INSTALL, { HARNESS_HEALTHY: VERSION, HARNESS_SERVICE_DB: '1' }).code, 0);
  assert.ok(!/dr-drill\.js/.test(h.commands()), 'the first drill is run once');
});
