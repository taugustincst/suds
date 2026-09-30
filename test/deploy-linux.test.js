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
  // Anything that would change the host must never be reached in a dry run.
  for (const c of ['apt-get', 'dnf', 'useradd', 'ufw', 'firewall-cmd', 'systemctl', 'systemd-run', 'curl', 'runuser', 'timedatectl']) stub(c, `echo "STUB $0 WAS RUN" >&2; exit 99`);
  return { dir, root, bin };
}
function run(script, args, fx, env = {}) {
  const e = { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, SUDS_INSTALL_ROOT: fx.root, ...env };
  delete e.SSH_CONNECTION;
  if (env.SSH_CONNECTION) e.SSH_CONNECTION = env.SSH_CONNECTION;
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
  assert.ok(r.out.includes(`+ copy ${REPO} into ${R}/opt/suds/${VERSION}`));
  assert.ok(r.out.includes(`+ chmod -R a-w ${R}/opt/suds/${VERSION}`));
  assert.ok(r.out.includes(`+ ln -sfn /opt/suds/${VERSION} ${R}/opt/suds/current.new`));
  assert.ok(r.out.includes(`+ install -d -m 0700 -o suds -g suds ${R}/var/lib/suds`));
  assert.ok(r.out.includes('+ useradd --system --user-group --home-dir /var/lib/suds --no-create-home --shell /usr/sbin/nologin suds'));
  // Keys: a 0700 root directory, each key 0600 root, loaded by systemd.
  assert.ok(r.out.includes(`+ install -d -m 0700 -o root -g root ${R}/etc/suds/credentials`));
  for (const k of ['suds_encryption_key', 'suds_index_key', 'suds_backup_key', 'suds_signing_key']) assert.ok(r.out.includes(`+ generate 32 random bytes as hex into ${R}/etc/suds/credentials/${k} (mode 0600, owner root:root)`), k);
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
  assert.ok(r.out.includes('+ dnf install -y -q ca-certificates curl xz unzip tar firewalld chrony dnf-automatic'));
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
  const order = ['+ systemctl stop suds.service', '+ systemd-run', 'scripts/backup.js', `+ ln -sfn /opt/suds/${VERSION}`, '+ systemctl start suds.service', '+ wait up to'];
  let at = -1;
  for (const s of order) { const i = r.out.indexOf(s, at + 1); assert.ok(i > at, `${s} comes next:\n${r.out}`); at = i; }
  assert.ok(r.out.includes('-p LoadCredential=suds_encryption_key:/etc/suds/credentials/suds_encryption_key'), 'the backup runs with the keys as credentials');
  const down = run('upgrade.sh', ['--dry-run', '1.2.0'], fx);
  assert.match(down.err, /REFUSED: 1\.2\.0 is older than the running 1\.16\.0/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});
