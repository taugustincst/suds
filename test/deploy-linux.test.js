'use strict';
// SUDS Server's Linux installer (deploy/linux/install.sh, upgrade.sh): run with --dry-run against a fake root
// filesystem (SUDS_INSTALL_ROOT) with stub commands on PATH standing in for findmnt, lsblk, mountpoint, id and
// uname, for both distribution families. Asserts what it plans to do and, above all, what it refuses to do.
// Nothing here needs root or changes the machine running the tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const LINUX = path.join(REPO, 'deploy', 'linux');
const VERSION = require('../package.json').version;
const pins = Object.fromEntries(fs.readFileSync(path.join(LINUX, 'pins'), 'utf8').split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => l.split('=')));
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

const OS = {
  ubuntu: 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
  rocky: 'NAME="Rocky Linux"\nVERSION_ID="9.4"\nID="rocky"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"\n',
  debian: 'NAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
};

/** A fake root and stub bin directory. `lsblk` is the device chain under /var/lib/suds. */
function fixture({ os: osName = 'ubuntu', lsblk = 'suds-data crypt\nsda3 part\nsda disk', mountpoints = true, current = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-install-'));
  const root = path.join(dir, 'root'); const bin = path.join(dir, 'bin');
  for (const d of ['etc', 'mnt/worm/suds-anchors', 'mnt/offsite', 'var/lib', 'opt/suds']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/os-release'), OS[osName]);
  if (current) { fs.mkdirSync(path.join(root, 'opt/suds', current)); fs.symlinkSync(`/opt/suds/${current}`, path.join(root, 'opt/suds/current')); fs.mkdirSync(path.join(root, 'etc/suds'), { recursive: true }); fs.writeFileSync(path.join(root, 'etc/suds/suds-server.conf'), 'SUDS_TLS_MODE=caddy\n'); }
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('uname', 'echo x86_64');
  stub('findmnt', 'echo "/dev/mapper/suds-data ext4"');
  stub('lsblk', `printf '%s\\n' ${lsblk.split('\n').map((l) => `'${l}'`).join(' ')}`);
  stub('mountpoint', mountpoints ? 'exit 0' : 'exit 1');
  stub('id', 'exit 1');
  // Who is connected (lib.sh ssh_lockout_guard): who -m and ss answer from the environment the test sets.
  stub('who', '[ -n "$WHO_M" ] && echo "$WHO_M"; exit 0');
  stub('ss', '[ -n "$SS_FAIL" ] && exit 1; [ -n "$SS_OUT" ] && printf "%s\\n" "$SS_OUT"; exit 0');
  // systemctl may be asked (is-active: is chrony running?), never told.
  stub('systemctl', 'case "$1" in is-active|is-enabled) exit 3 ;; esac; echo "STUB $0 WAS RUN" >&2; exit 99');
  // Anything that would change the host must never be reached in a dry run.
  for (const c of ['apt-get', 'dnf', 'useradd', 'ufw', 'firewall-cmd', 'systemd-run', 'curl', 'runuser', 'timedatectl', 'restorecon']) stub(c, `echo "STUB $0 WAS RUN" >&2; exit 99`);
  return { dir, root, bin };
}
function run(script, args, fx, env = {}) {
  const e = { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, SUDS_INSTALL_ROOT: fx.root, ...env };
  for (const k of ['SSH_CONNECTION', 'WHO_M', 'SS_OUT', 'SS_FAIL']) { delete e[k]; if (env[k]) e[k] = env[k]; }
  const r = spawnSync('bash', [path.join(LINUX, script), ...args], { env: e, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const BASE = ['--dry-run', '--domain=suds.county.example.gov', '--admin-cidr=10.20.0.0/16', '--offsite=/mnt/offsite', '--anchors=/mnt/worm/suds-anchors'];

test('the pinned Node.js release is the one CI and the release workflow test on', () => {
  for (const wf of ['ci.yml', 'release.yml']) {
    const y = fs.readFileSync(path.join(REPO, '.github', 'workflows', wf), 'utf8');
    assert.equal(pins.NODE_VERSION, /\n {2}NODE22_VERSION: (v22\.\d+\.\d+)\n/.exec(y)[1], `${wf}: deploy/linux/pins NODE_VERSION`);
    assert.equal(pins.NODE_SHA256_LINUX_X64, /\n {2}NODE22_SHA256: ([0-9a-f]{64})\n/.exec(y)[1], `${wf}: deploy/linux/pins NODE_SHA256_LINUX_X64`);
  }
  assert.match(pins.CADDY_VERSION, /^2\.\d+\.\d+$/);
  assert.match(pins.CADDY_SHA512_LINUX_AMD64, /^[0-9a-f]{128}$/);
  const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8');
  assert.ok(compose.includes(`caddy:${pins.CADDY_VERSION.split('.').slice(0, 2).join('.')}-alpine`), 'the Linux Caddy pin is on the minor line docker-compose.yml uses');
});

test('the systemd unit has one source: deploy/linux/suds.service, which DEPLOYMENT.md refers to rather than repeats', () => {
  const unit = fs.readFileSync(path.join(LINUX, 'suds.service'), 'utf8');
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'DEPLOYMENT.md'), 'utf8');
  assert.ok(doc.includes('deploy/linux/suds.service'), 'DEPLOYMENT.md names the unit file');
  assert.ok(!/```ini\s*\n\[Unit\]/.test(doc), 'DEPLOYMENT.md carries no second copy of the unit');
  // Every sandboxing setting the documented unit had (up to 1.17.1) is still there.
  for (const d of ['User=suds', 'UMask=0077', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'PrivateDevices=true', 'NoNewPrivileges=true', 'CapabilityBoundingSet=\n', 'AmbientCapabilities=\n',
    'ProtectKernelTunables=true', 'ProtectKernelModules=true', 'ProtectKernelLogs=true', 'ProtectControlGroups=true', 'ProtectClock=true', 'ProtectHostname=true', 'ProtectProc=invisible',
    'RestrictNamespaces=true', 'RestrictRealtime=true', 'RestrictSUIDSGID=true', 'LockPersonality=true', 'RemoveIPC=true', 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    'SystemCallArchitectures=native', 'SystemCallFilter=@system-service', 'SystemCallFilter=~@privileged @resources @mount @debug', 'HOST=127.0.0.1']) assert.ok(unit.includes(d), `suds.service has ${d.trim()}`);
  // Keys arrive as credentials, never as environment values.
  for (const k of ['suds_encryption_key', 'suds_index_key', 'suds_backup_key', 'suds_signing_key']) {
    assert.ok(unit.includes(`LoadCredential=${k}:/etc/suds/credentials/${k}`), `${k} is a LoadCredential`);
    assert.ok(unit.includes(`${k.toUpperCase()}_FILE=%d/${k}`), `${k} is read through its _FILE variable`);
  }
  assert.ok(!/SUDS_(ENCRYPTION|INDEX|BACKUP|SIGNING)_KEY=[0-9a-f]/.test(unit), 'no key value in the unit');
});

test('the shell scripts parse, and are shellcheck-clean when shellcheck is installed', (t) => {
  for (const f of ['install.sh', 'upgrade.sh', 'uninstall.sh', 'lib.sh']) {
    const r = spawnSync('bash', ['-n', path.join(LINUX, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  if (!has('shellcheck')) { t.skip('shellcheck is not installed (not a dependency; CI images may have it)'); return; }
  const r = spawnSync('shellcheck', ['-x', '-P', LINUX, ...['install.sh', 'upgrade.sh', 'uninstall.sh', 'lib.sh'].map((f) => path.join(LINUX, f))], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('Ubuntu 24.04: the plan installs the unit, generates each key root-only 0600, and opens only 443, 80 and SSH from the admin network', () => {
  const fx = fixture();
  const r = run('install.sh', BASE, fx);
  assert.equal(r.code, 0, r.all);
  assert.ok(!/STUB .* WAS RUN/.test(r.all), 'no host-changing command ran in a dry run');
  const R = fx.root;
  assert.match(r.out, /Ubuntu 24\.04\.1 LTS \(debian family\)/);
  // Pinned Node, verified by checksum before it is unpacked; Caddy by SHA-512.
  assert.ok(r.out.includes(`https://nodejs.org/dist/${pins.NODE_VERSION}/node-${pins.NODE_VERSION}-linux-x64.tar.xz`), 'downloads the pinned Node release');
  assert.ok(r.out.includes(`sha256sum -c <<< "${pins.NODE_SHA256_LINUX_X64}  node-${pins.NODE_VERSION}-linux-x64.tar.xz"`), 'checks it against the pinned SHA-256');
  assert.ok(r.out.indexOf('sha256sum -c') < r.out.indexOf('+ tar -xJf'), 'the checksum is verified before the archive is unpacked');
  assert.ok(r.out.includes(`sha512sum -c <<< "${pins.CADDY_SHA512_LINUX_AMD64}  caddy_${pins.CADDY_VERSION}_linux_amd64.tar.gz"`), 'Caddy by its pinned SHA-512');
  assert.ok(!/curl[^\n]*\|\s*(ba)?sh/.test(r.out), 'never curl | sh');
  // Code root-owned and read-only; data 0700 for the service user.
  assert.ok(r.out.includes(`+ copy ${REPO} into ${R}/opt/suds/${VERSION}.partial`), 'staged beside, then renamed');
  assert.ok(r.out.includes(`+ chmod -R a-w ${R}/opt/suds/${VERSION}.partial`));
  assert.ok(r.out.includes(`+ mv -T ${R}/opt/suds/${VERSION}.partial ${R}/opt/suds/${VERSION}`));
  assert.ok(r.out.includes(`+ ln -sfn ${VERSION} ${R}/opt/suds/current.new`), 'a relative symlink');
  assert.ok(r.out.includes(`+ install -d -m 0755 -o root -g root ${R}/opt/suds ${R}/opt/suds/node-${pins.NODE_VERSION}`), 'the Node directory is made 0755, whatever the umask');
  assert.ok(r.out.includes(`+ install -d -m 0700 -o suds -g suds ${R}/var/lib/suds`));
  assert.ok(r.out.includes('+ useradd --system --user-group --home-dir /var/lib/suds --no-create-home --shell /usr/sbin/nologin suds'));
  assert.equal(r.out.split('+ useradd --system --user-group --home-dir /var/lib/suds').length, 2, 'the account is planned once');
  // Before anything is staged, the account is made and both shares are looked at together; a dry run cannot test
  // as a user that does not exist, so it reads the modes and warns, with the commands.
  assert.ok(r.out.indexOf('+ useradd') < r.out.indexOf('== Packages =='), 'the account comes first, so the shares can be checked as it');
  for (const d of ['/mnt/worm/suds-anchors', '/mnt/offsite']) assert.ok(r.err.includes(`WARNING: ${d} (`) && r.err.includes(`chown suds:suds ${d} && chmod 0700 ${d}`), `${d}\n${r.err}`);
  // The first backup and drill, as the service user, then the compliance check with the service's environment
  // once HTTPS answers through Caddy; the relying party for passkeys from --domain.
  assert.ok(r.out.includes(`+ systemd-run --quiet --wait --pipe --collect --uid=suds --gid=suds`) && /scripts\/dr-drill\.js --offsite\n/.test(r.out), 'the first drill');
  const waitAt = r.out.indexOf('+ wait up to 90s for https://suds.county.example.gov/api/health/ready (through Caddy)');
  assert.ok(waitAt > r.out.indexOf('scripts/dr-drill.js --offsite'), 'after the first drill');
  // (suds.env is not written in a dry run; test/deploy-linux-real.test.js checks the values the check receives.)
  assert.match(r.out.slice(waitAt), /every KEY=value line of \S+\/etc\/suds\/suds\.env in its environment, as suds-compliance\.service does\)\n\+ env SUDS_ENV=production SUDS_DATA_DIR=\/var\/lib\/suds \S+\/node --no-warnings=ExperimentalWarning \S+\/scripts\/compliance-check\.js\n/, 'the check gets suds.env, as the weekly unit does');
  // Keys: a 0700 root directory, each key 0600 root, loaded by systemd.
  assert.ok(r.out.includes(`+ install -d -m 0700 -o root -g root ${R}/etc/suds/credentials`));
  for (const k of ['suds_encryption_key', 'suds_index_key', 'suds_backup_key', 'suds_signing_key']) assert.ok(r.out.includes(`+ generate 32 random bytes as hex into ${R}/etc/suds/credentials/${k} (mode 0600, owner root:root)`), k);
  assert.ok(r.out.includes(`+ generate 32 random bytes as hex into ${R}/etc/suds/compliance-signing-key (mode 0600, owner root:root)`), 'the compliance check\'s own key, outside the service\'s credentials');
  assert.ok(r.out.includes(`+ install -d -m 0750 -o root -g suds ${R}/var/lib/suds-compliance`));
  assert.match(r.out, /KEY ESCROW — YOUR STEP, NOW/);
  assert.ok(!/[0-9a-f]{64}/.test(r.out.replace(pins.NODE_SHA256_LINUX_X64, '').replace(pins.CADDY_SHA512_LINUX_AMD64, '')), 'no key-like value is printed');
  // The unit and the weekly compliance timer, installed unchanged from the tree.
  assert.ok(r.out.includes(`+ install -m 0644 -o root -g root ${REPO}/deploy/linux/suds.service ${R}/etc/systemd/system/suds.service`), 'unit file installed');
  assert.ok(r.out.includes(`+ install -m 0644 -o root -g root ${REPO}/deploy/linux/suds-compliance.timer ${R}/etc/systemd/system/suds-compliance.timer`));
  assert.ok(r.out.includes(`+ install -m 0644 -o root -g root ${REPO}/Caddyfile ${R}/etc/caddy/Caddyfile`), 'the repository Caddyfile');
  assert.ok(r.out.includes('+ systemctl enable --now suds-compliance.timer'));
  for (const f of ['etc/suds/suds.env', 'etc/suds/provision.json', 'etc/suds/suds-server.conf', 'etc/systemd/system/suds.service.d/10-site.conf', 'etc/caddy/suds-tls.caddy', 'etc/systemd/journald.conf.d/suds.conf', 'etc/apt/apt.conf.d/20auto-upgrades']) assert.ok(r.out.includes(`+ write ${R}/${f} (mode 0644, owner root:root`), f);
  // Firewall: deny by default; 443 and 80 (ACME/redirect); SSH from the admin network only, the open rules removed.
  const fw = r.out.split('\n').filter((l) => l.startsWith('+ ufw'));
  assert.deepEqual(fw.filter((l) => !/delete/.test(l)), ['+ ufw default deny incoming', '+ ufw default allow outgoing',
    "+ ufw allow proto tcp from 10.20.0.0/16 to any port 22 comment SUDS\\ Server:\\ SSH\\ from\\ the\\ administration\\ network", "+ ufw allow 443/tcp comment SUDS\\ Server:\\ HTTPS",
    "+ ufw allow 80/tcp comment SUDS\\ Server:\\ redirect\\ and\\ ACME", '+ ufw --force enable']);
  assert.ok(r.out.indexOf('from 10.20.0.0/16 to any port 22') < r.out.indexOf('+ ufw --force enable'), 'the admin SSH rule exists before the firewall is enabled');
  for (const d of ['+ ufw delete allow OpenSSH', '+ ufw delete allow 22/tcp', '+ ufw delete allow 22']) assert.ok(r.out.includes(`${d}\n`), `the dry run shows ${d}`);
  assert.ok(r.out.includes('+ systemctl enable --now systemd-timesyncd') && r.out.includes('+ timedatectl set-ntp true'), 'time sync');
  assert.ok(r.out.includes('+ systemctl enable --now apt-daily.timer apt-daily-upgrade.timer'), 'unattended security updates');
  assert.ok(r.out.includes('compliance-check.js'), 'finishes with the compliance check');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('Rocky 9: firewalld with https/http, SSH only through a rich rule from the admin network, chrony, dnf-automatic', () => {
  const fx = fixture({ os: 'rocky' });
  const r = run('install.sh', [...BASE, '--admin-cidr=192.168.10.0/24'], fx);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Rocky Linux 9\.4 \(Blue Onyx\) \(rhel family\)/);
  assert.ok(r.out.includes('+ dnf install -y -q ca-certificates xz unzip tar firewalld chrony dnf-automatic'), 'curl is there (curl-minimal on RHEL): not installed over it');
  for (const l of ['+ firewall-cmd --permanent --zone=public --add-service=https', '+ firewall-cmd --permanent --zone=public --add-service=http',
    '+ firewall-cmd --permanent --zone=public --add-rich-rule=rule\\ family=\\"ipv4\\"\\ source\\ address=\\"192.168.10.0/24\\"\\ service\\ name=\\"ssh\\"\\ accept',
    '+ firewall-cmd --permanent --zone=public --remove-service=ssh', '+ firewall-cmd --permanent --zone=public --remove-service=cockpit', '+ firewall-cmd --reload',
    '+ systemctl enable --now chronyd', '+ systemctl enable --now dnf-automatic.timer']) assert.ok(r.out.includes(l), l);
  assert.ok(r.out.includes(`/etc/dnf/automatic.conf`) && r.out.includes('upgrade_type\\ =\\ security'), 'dnf-automatic set to security updates');
  assert.ok(!r.out.includes('+ ufw'), 'no ufw on RHEL');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('--tls=county-cert: the certificate goes to Caddy, port 80 stays closed', () => {
  const fx = fixture();
  const cert = path.join(fx.dir, 'cert.pem'); const key = path.join(fx.dir, 'key.pem');
  fs.writeFileSync(cert, 'x'); fs.writeFileSync(key, 'y');
  const r = run('install.sh', [...BASE, '--tls=county-cert', `--cert=${cert}`, `--key=${key}`], fx);
  assert.equal(r.code, 0, r.all);
  assert.ok(r.out.includes(`+ install -m 0640 -o root -g caddy ${key} ${fx.root}/etc/caddy/tls/key.pem`));
  assert.ok(!r.out.includes('+ ufw allow 80/tcp'), 'no port 80');
  assert.ok(r.out.includes('+ ufw delete allow 80/tcp'));
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('refuses a data directory that is not on an encrypted volume, unless the risk is accepted by name', () => {
  const fx = fixture({ lsblk: 'sda3 part\nsda disk' });
  const r = run('install.sh', BASE, fx);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /REFUSED: \/var\/lib\/suds is not on an encrypted \(LUKS\/dm-crypt\) volume/);
  assert.match(r.err, /cannot encrypt a disk in place/);
  assert.ok(!r.out.includes('+ '), 'refused before any action');
  const ok = run('install.sh', [...BASE, '--accept-unencrypted-disk=pilot with synthetic data only'], fx);
  assert.equal(ok.code, 0, ok.all);
  assert.match(ok.err, /IS NOT ON AN ENCRYPTED VOLUME/);
  assert.match(ok.err, /Accepted by the operator: pilot with synthetic data only/);
  assert.match(ok.err, /RISK ACCEPTED/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('refuses audit anchors inside the data directory, and an offsite directory there too', () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.root, 'var/lib/suds/anchors'), { recursive: true });
  let r = run('install.sh', [...BASE.filter((a) => !a.startsWith('--anchors')), '--anchors=/var/lib/suds/anchors'], fx);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /REFUSED: --anchors=\/var\/lib\/suds\/anchors is inside the data directory/);
  r = run('install.sh', [...BASE.filter((a) => !a.startsWith('--anchors')), '--anchors=/var/lib/suds/../suds/x'], fx);
  assert.match(r.err, /inside the data directory/, 'resolved before comparing');
  r = run('install.sh', [...BASE.filter((a) => !a.startsWith('--offsite')), '--offsite=/var/lib/suds/offsite'], fx);
  assert.match(r.err, /REFUSED: --offsite=\/var\/lib\/suds\/offsite is inside the data directory/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('refuses shares that are not mounted, an unsupported OS, and an SSH session the firewall would cut off', () => {
  let fx = fixture({ mountpoints: false });
  let r = run('install.sh', BASE, fx);
  assert.match(r.err, /REFUSED: \/mnt\/worm\/suds-anchors is not a mount point/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
  fx = fixture({ os: 'debian' });
  r = run('install.sh', BASE, fx);
  assert.match(r.err, /REFUSED: Debian GNU\/Linux 12 \(bookworm\) is not supported/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
  fx = fixture();
  r = run('install.sh', BASE, fx, { SSH_CONNECTION: '203.0.113.9 50000 10.20.1.5 22' });
  assert.match(r.err, /REFUSED: this SSH session comes from 203\.0\.113\.9, outside --admin-cidr=10\.20\.0\.0\/16/);
  r = run('install.sh', BASE, fx, { SSH_CONNECTION: '10.20.4.4 50000 10.20.1.5 22' });
  assert.equal(r.code, 0, r.all);
  r = run('install.sh', BASE.filter((a) => !a.startsWith('--domain')), fx);
  assert.match(r.err, /--domain=<the DNS name staff use> is required/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('a Node.js archive that does not match the pinned checksum is refused, before anything is unpacked', () => {
  const fx = fixture();
  const bad = path.join(fx.dir, `node-${pins.NODE_VERSION}-linux-x64.tar.xz`);
  fs.writeFileSync(bad, 'not the real node');
  const r = run('install.sh', [...BASE, `--node-tarball=${bad}`], fx);
  assert.notEqual(r.code, 0);
  assert.match(r.err, new RegExp(`REFUSED: checksum mismatch for node-${pins.NODE_VERSION.replace(/\./g, '\\.')}-linux-x64\\.tar\\.xz: expected sha256 ${pins.NODE_SHA256_LINUX_X64}`));
  assert.ok(!r.out.includes('+ tar -xJf'), 'never unpacked');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('upgrade.sh: stages and verifies, stops, backs up with the service keys, swaps, starts, checks; never downgrades', () => {
  const fx = fixture({ current: '1.16.0' });
  const r = run('upgrade.sh', ['--dry-run', VERSION], fx);
  assert.equal(r.code, 0, r.all);
  const order = ['+ systemctl stop suds.service', '+ systemd-run', 'scripts/backup.js', `+ ln -sfn ${VERSION} `, '+ systemctl start suds.service', '+ wait up to'];
  let at = -1;
  for (const s of order) { const i = r.out.indexOf(s, at + 1); assert.ok(i > at, `${s} comes next:\n${r.out}`); at = i; }
  assert.ok(r.out.includes('-p LoadCredential=suds_encryption_key:/etc/suds/credentials/suds_encryption_key'), 'the backup runs with the keys as credentials');
  const down = run('upgrade.sh', ['--dry-run', '1.2.0'], fx);
  assert.match(down.err, /REFUSED: 1\.2\.0 is older than the running 1\.16\.0/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});


test('SSH lock-out: under sudo (no SSH_CONNECTION) the session is found through who -m, a parent process or ss; unknown refuses without --console-access', () => {
  const fx = fixture();
  // who -m: the terminal's utmp entry.
  let r = run('install.sh', BASE, fx, { WHO_M: 'admin    pts/0        2026-09-30 10:00 (203.0.113.9)' });
  assert.match(r.err, /REFUSED: this SSH session comes from 203\.0\.113\.9, outside --admin-cidr=10\.20\.0\.0\/16/);
  r = run('install.sh', BASE, fx, { WHO_M: 'admin    pts/0        2026-09-30 10:00 (10.20.9.9)' });
  assert.equal(r.code, 0, r.all); assert.match(r.out, /this session comes from 10\.20\.9\.9, inside/);
  // A parent process's environment (sudo dropped SSH_CONNECTION; the login shell above it still has it).
  const penv = path.join(fx.root, 'proc', String(process.pid)); fs.mkdirSync(penv, { recursive: true });
  fs.writeFileSync(path.join(penv, 'environ'), 'USER=admin\0SSH_CONNECTION=198.51.100.4 50022 10.20.1.5 22\0');
  r = run('install.sh', BASE, fx);
  assert.match(r.err, /REFUSED: this SSH session comes from 198\.51\.100\.4/);
  fs.rmSync(path.join(fx.root, 'proc'), { recursive: true, force: true });
  // Any established SSH session outside the network, not only this one.
  r = run('install.sh', BASE, fx, { SS_OUT: '0      0      10.20.1.5:22      10.20.3.3:50000\n0      0      10.20.1.5:22      192.0.2.77:41000' });
  assert.match(r.err, /REFUSED: an established SSH session comes from 192\.0\.2\.77, outside --admin-cidr/);
  r = run('install.sh', BASE, fx, { SS_OUT: '0      0      10.20.1.5:22      10.20.3.3:50000\n0      0      [::ffff:10.20.4.4]:22      [::ffff:10.20.4.5]:41000' });
  assert.equal(r.code, 0, r.all);
  r = run('install.sh', BASE, fx, { SS_OUT: '0      0      [2001:db8::5]:22      [2001:db8::9]:41000' });
  assert.match(r.err, /cannot be compared with --admin-cidr/);
  // Nothing can say where the administrator is: refused, unless they are at the console.
  r = run('install.sh', BASE, fx, { SS_FAIL: '1' });
  assert.match(r.err, /REFUSED: could not tell where this session comes from/);
  r = run('install.sh', [...BASE, '--console-access'], fx, { SS_FAIL: '1' });
  assert.equal(r.code, 0, r.all); assert.match(r.out, /--console-access: the SSH lock-out check is skipped/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('a release zip needs a checksum from another channel: refused without --release-sha256, a warning with --trust-release-checksum, the --source file copied before it is hashed', () => {
  const fx = fixture();
  let r = run('install.sh', [...BASE, '--version=9.9.9'], fx);
  assert.notEqual(r.code, 0);
  // Where an operator finds the checksum: the release notes and the CHANGELOG on main. Never "at the tag": the zip
  // is built from the tagged commit, so that commit cannot carry its own checksum.
  assert.match(r.err, /REFUSED: no independent checksum for suds-v9\.9\.9\.zip\. Pass --release-sha256=<hex>, taken from a channel other than the download: the SHA-256 published in the GitHub Release notes for v9\.9\.9 AND recorded in that version's CHANGELOG section on the main branch \(not at the tag: the zip is built from the tagged commit, so its checksum is added after it\); they must agree/);
  assert.ok(!/CHANGELOG entry at tag/.test(r.err));
  r = run('install.sh', [...BASE, '--version=9.9.9', '--trust-release-checksum'], fx);
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /checked only against the \.sha256 published beside it \(--trust-release-checksum\)/);
  assert.ok(r.out.includes('https://github.com/taugustincst/suds/releases/download/v9.9.9/suds-v9.9.9.zip.sha256'));
  // --source: the operator's zip, with its checksum.
  const zip = path.join(fx.dir, 'suds-v9.9.9.zip'); fs.writeFileSync(zip, 'PK fake zip');
  const good = require('node:crypto').createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  r = run('install.sh', [...BASE, '--version=9.9.9', `--source=${zip}`, `--release-sha256=${'0'.repeat(64)}`], fx);
  assert.match(r.err, /REFUSED: checksum mismatch for suds-v9\.9\.9\.zip/);
  r = run('install.sh', [...BASE, '--version=9.9.9', `--source=${zip}`, `--release-sha256=${good.toUpperCase()}`], fx);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /suds-v9\.9\.9\.zip: sha256 matches/);
  assert.ok(!r.out.includes(`unzip -q ${zip}`), 'the copy is unpacked, never the operator\'s file in place');
  // upgrade.sh the same.
  const up = fixture({ current: '1.16.0' });
  r = run('upgrade.sh', ['--dry-run', '9.9.9'], up);
  assert.match(r.err, /REFUSED: no independent checksum/);
  // With the operator's checksum: the note names it (not "the pinned checksum"), and the dry run, which does not unpack
  // the zip, says the release's own upgrader may take over (installer run on 1.21.0, findings 2 and 3).
  r = run('upgrade.sh', ['--dry-run', '9.9.9', `--source=${zip}`, `--release-sha256=${good}`], up);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /suds-v9\.9\.9\.zip: sha256 matches the checksum given with --release-sha256/);
  assert.match(r.out, /\+ if SUDS 9\.9\.9's own upgrade\.sh or lib\.sh differs from this one, hand over to it/);
  fs.rmSync(fx.dir, { recursive: true, force: true }); fs.rmSync(up.dir, { recursive: true, force: true });
});

test('the release checksum is where it can be: the GitHub Release notes and the CHANGELOG on main, never "at the tag" — the refusal, the compliance remediation, the browser kernel and the docs agree', () => {
  // The zip is built from the tagged commit (git archive), so the CHANGELOG at the tag cannot hold its checksum.
  const atTag = /CHANGELOG (entry )?at (the release |its )?tag|CHANGELOG at the tag, which must agree|git show v[^:\s]*:CHANGELOG/;
  const rem = require('../server/compliance-rules').byId.get('host.release_integrity').remediation;
  assert.match(rem, /GitHub Release notes and recorded in that version's CHANGELOG section on the main branch/);
  assert.ok(!atTag.test(rem), rem);
  const kernel = fs.readFileSync(path.join(REPO, 'public/local/kernel.js'), 'utf8');
  assert.ok(kernel.includes('recorded in that version') && kernel.includes('CHANGELOG section on the main branch'), 'public/local/kernel.js is rebuilt (npm run build:local)');
  assert.ok(!kernel.includes('CHANGELOG entry at the release tag'));
  assert.ok(!atTag.test(fs.readFileSync(path.join(LINUX, 'lib.sh'), 'utf8')));
  for (const f of ['docs/SELF-HOSTING.md', 'deploy/linux/README.md']) {
    const doc = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(!atTag.test(doc), `${f}: ${(atTag.exec(doc) || [''])[0]}`);
    assert.match(doc, /CHANGELOG[^.]*on `main`/, f);
  }
});

test('installer input is whitelisted: paths, e-mail, host names, numbers; JSON is escaped by construction', () => {
  const fx = fixture();
  const bad = (flag, re) => { const r = run('install.sh', [...BASE.filter((a) => !a.startsWith(flag.split('=')[0] + '=')), flag], fx); assert.notEqual(r.code, 0, flag); assert.match(r.err, re, flag); assert.ok(!r.out.includes('+ '), `${flag}: refused before any action`); };
  bad('--offsite=/mnt/off site', /--offsite must be an absolute path of letters, digits/);
  bad('--anchors=/mnt/$(reboot)', /--anchors must be an absolute path/);
  bad('--offsite=relative/dir', /--offsite must be an absolute path/);
  bad('--acme-email=it@county.gov;rm -rf /', /--acme-email must be an e-mail address/);
  bad('--log-retention-days=400d', /--log-retention-days must be a number of days \(digits\)/);
  bad('--journal-max-use=8GB', /--journal-max-use must be a size such as 8G/);
  bad('--connect-host=10.0.0.1 evil', /--connect-host must be a host name or IP address/);
  bad('--ntp-server=ntp.county.gov;id', /--ntp-server must be host names or IP addresses/);
  bad('--release-sha256=xyz', /--release-sha256 must be 64 hex characters/);
  bad('--node-tarball=node.tar.xz', /--node-tarball must be an absolute path/);
  const up = fixture({ current: '1.16.0' });
  const r = run('upgrade.sh', ['--dry-run', VERSION, '--ready-timeout=5m'], up);
  assert.match(r.err, /--ready-timeout must be a number of seconds \(digits\)/);
  // json_str: quotes, backslashes and control characters come out as valid JSON for the same string.
  const tricky = 'a"b\\c\td\ne';
  const j = spawnSync('bash', ['-c', `. "${path.join(LINUX, 'lib.sh')}"; json_str "$1"`, 'x', tricky], { encoding: 'utf8' });
  assert.equal(JSON.parse(j.stdout), tricky);
  fs.rmSync(fx.dir, { recursive: true, force: true }); fs.rmSync(up.dir, { recursive: true, force: true });
});
