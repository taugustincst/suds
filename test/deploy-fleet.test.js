'use strict';
// The fleet tooling (deploy/fleet: Option A, one Lightsail VM per tenant), run against stub executables only:
// aws, curl, ssh, scp, gpg and ssh-keygen are shell stubs on PATH that record their arguments and answer with canned
// output (a small state directory stands in for Lightsail). Nothing here contacts AWS, Porkbun, dns.google or a VM.
// FLEET_HOME is a private temporary directory outside the repository, as the scripts require.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const FLEET = path.join(REPO, 'deploy', 'fleet');
const SCRIPTS = ['lib.sh', 'provision-tenant.sh', 'decommission-tenant.sh', 'escrow.sh', 'prepare-host.sh'];
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const FPR = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
const SECRET = 'sk1_topsecretvalue';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-fleet-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const UFW_V4 = '22/tcp                     ALLOW       203.0.113.10/32            # SUDS Server: SSH from the administration network';
const UFW_V6 = '22/tcp                     ALLOW       2001:db8:10::/48           # SUDS Server: SSH from the IPv6 administration network';
const UFW = (lines) => ['Status: active', '', 'To                         Action      From', '--                         ------      ----',
  ...lines, '443/tcp                    ALLOW       Anywhere', '80/tcp                     ALLOW       Anywhere', '443/tcp (v6)               ALLOW       Anywhere (v6)', '80/tcp (v6)                ALLOW       Anywhere (v6)'].join('\n');

const STUBS = {
  aws: String.raw`
printf 'aws %s\n' "$*" >> "$FAKE_LOG"
S=$FAKE_STATE; name=''; q=''; prev=''; op=''; own=''
for a in "$@"; do case "$prev" in --disk-name|--static-ip-name) name=$a; own=1 ;; --instance-name|--instance-names) [ -n "$own" ] || name=$a ;; --query) q=$a ;; esac; prev=$a; done
for a in "$@"; do case "$a" in create-*|delete-*|get-*|allocate-*|attach-*|release-*|put-*) op=$a; break ;; esac; done
case "$op" in
  create-instances|allocate-static-ip|create-disk) touch "$S/$name"; exit 0 ;;
  attach-static-ip|attach-disk) touch "$S/$name.att"; exit 0 ;;
  delete-instance) rm -f "$S/$name" "$S"/*-data.att "$S"/*-offsite.att "$S"/*-anchors.att; exit 0 ;;
  delete-disk|release-static-ip) rm -f "$S/$name" "$S/$name.att"; exit 0 ;;
  put-instance-public-ports|delete-instance-snapshot|delete-disk-snapshot) exit 0 ;;
  get-instance-port-states) case "$q" in sort*) printf '22\t80\t443\n' ;; *) printf '203.0.113.10/32\t2001:db8:10::/48\n' ;; esac; exit 0 ;;
  get-instance-snapshots) [ -n "$FAKE_SNAPS" ] && printf '%s\n' "$FAKE_SNAPS"; exit 0 ;;
  get-disk-snapshots) exit 0 ;;
esac
[ -e "$S/$name" ] || { echo "An error occurred (NotFoundException) when calling the operation: $name does not exist" >&2; exit 254; }
att=False; [ -e "$S/$name.att" ] && att=True
case "$q" in
  instance.name|staticIp.name|disk.name) echo "$name" ;;
  instance.state.name) echo running ;;
  staticIp.attachedTo|disk.attachedTo) if [ $att = True ]; then echo suds-drill; else echo None; fi ;;
  *isAttached*) if [ $att = True ]; then printf 'True\tsuds-drill\n'; else printf 'False\tNone\n'; fi ;;
  staticIp.ipAddress) echo 203.0.113.50 ;;
  disk.state) if [ $att = True ]; then echo in-use; else echo available; fi ;;
esac`,
  curl: String.raw`
for a in "$@"; do url=$a; done
printf 'curl %s\n' "$*" >> "$FAKE_LOG"
case "$url" in
  https://api.porkbun.com/*)
    body=$(cat); printf '%s %s\n' "\${url##*/dns/}" "$body" >> "$FAKE_PB"
    sub=\${url##*/}; case "$url" in */create/*) sub=$(printf '%s' "$body" | sed 's/.*"name":"\([^"]*\)".*/\1/') ;; esac
    case "$url" in
      *retrieveByNameType*) if [ -e "$FAKE_STATE/dns-$sub" ]; then echo '{"status":"SUCCESS","records":[{"id":"1"}]}'; else echo '{"status":"SUCCESS","records":[]}'; fi ;;
      *create*|*editByNameType*) touch "$FAKE_STATE/dns-$sub"; echo '{"status":"SUCCESS","id":1}' ;;
      *deleteByNameType*) rm -f "$FAKE_STATE/dns-$sub"; echo '{"status":"SUCCESS"}' ;;
    esac ;;
  https://dns.google/*) echo '{"Status":0,"Answer":[{"name":"x.","type":1,"TTL":600,"data":"203.0.113.50"}]}' ;;
  */version.json) printf '{"version":"%s"}' "$FAKE_VERSION" ;;
  https://www.*) printf '301 https://%s' "\${url#https://www.}" ;;
  https://*) printf 200 ;;
esac`,
  ssh: String.raw`
for a in "$@"; do cmd=$a; done
printf 'ssh %s\n' "$cmd" >> "$FAKE_LOG"
S=$FAKE_STATE
case "$cmd" in
  *suds-fleet-ssh-ok*) if [ -e "$S/installed" ] && [ -n "$FAKE_FRESH_SSH_FAIL" ]; then echo 'ssh: connect to host 203.0.113.50 port 22: Connection timed out' >&2; exit 255; fi; echo suds-fleet-ssh-ok ;;
  *deploy/linux/install.sh*) touch "$S/installed"; echo 'SUDS Server installer' ;;
  *'ufw status'*) printf '%s\n' "$FAKE_UFW" ;;
  *is-active*) printf 'active\n%s\n' "\${FAKE_CADDY:-active}" ;;
  *www-redirect.caddy*) echo yes ;;
  *findmnt*) printf '%b\n' "$FAKE_LSBLK" ;;
  *'find /etc/suds/credentials'*) echo 4 ;;
  *'tar -C / -cf -'*) tar -C "$FAKE_BOX" -cf - \${cmd#*-cf - } ;;
esac`,
  scp: String.raw`printf 'scp %s\n' "$*" >> "$FAKE_LOG"`,
  'ssh-keygen': String.raw`printf 'ssh-keygen %s\n' "$*" >> "$FAKE_LOG"`,
  gpg: String.raw`
printf 'gpg %s\n' "$*" >> "$FAKE_LOG"
out=''; prev=''; mode=''; for a in "$@"; do [ "$prev" = --output ] && out=$a; case $a in --encrypt) mode=enc ;; --decrypt) mode=dec ;; --list-keys) mode=list ;; esac; prev=$a; last=$a; done
case $mode in
  list) [ -n "$FAKE_NO_ESCROW_KEY" ] && exit 2; exit 0 ;;
  enc) { printf 'FAKEGPG1\n'; cat; } > "$out" ;;
  dec) [ "$(head -c 9 "$last")" = 'FAKEGPG1' ] || exit 2; tail -c +10 "$last" > "$out" ;;
esac`,
};

/** A private FLEET_HOME with one tenant ("drill"), its files, a fake VM's key files, and the stub bin directory. */
function fixture({ www = 'yes', data = 64, homeMode = 0o700 } = {}) {
  const dir = fs.mkdtempSync(path.join(work, 'fx-'));
  const home = path.join(dir, 'home'); const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const box = path.join(dir, 'box');
  for (const d of [home, bin, state, path.join(box, 'etc/suds/credentials'), path.join(box, 'etc/suds-luks')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const d of ['tenants', 'keys', 'credentials', 'releases']) fs.mkdirSync(path.join(home, d), { mode: 0o700 });
  const zip = Buffer.from('a stand-in for suds-v1.25.4.zip\n');
  fs.writeFileSync(path.join(home, 'releases/suds-v1.25.4.zip'), zip);
  fs.writeFileSync(path.join(home, 'keys/suds-fleet.pem'), 'not a real key\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'credentials/porkbun.env'), `PORKBUN_API_KEY=pk1_testkey\nPORKBUN_SECRET_API_KEY=${SECRET}\n`, { mode: 0o600 });
  for (const k of ['suds_encryption_key', 'suds_index_key', 'suds_backup_key', 'suds_signing_key']) fs.writeFileSync(path.join(box, 'etc/suds/credentials', k), `${k}-value\n`);
  fs.writeFileSync(path.join(box, 'etc/suds-luks/suds-data.key'), 'luks-key\n');
  const envFile = path.join(home, 'tenants/drill.env');
  fs.writeFileSync(envFile, [
    'TENANT_SLUG=drill', `WWW_REDIRECT=${www}`, 'ADMIN_CIDR=203.0.113.10/32', 'ADMIN_CIDR6=2001:db8:10::/48', 'REGION=us-west-2',
    'AVAILABILITY_ZONE=us-west-2a', 'LIGHTSAIL_BUNDLE=medium_3_0', 'LIGHTSAIL_KEY_PAIR=suds-fleet', 'SUDS_VERSION=1.25.4',
    `RELEASE_SHA256=${sha256(zip)}`, 'RELEASE_ZIP=releases/suds-v1.25.4.zip', `DATA_DISK_GB=${data}  # the LUKS volume`,
    'SSH_KEY_FILE=keys/suds-fleet.pem', 'PORKBUN_CREDENTIALS=credentials/porkbun.env', `ESCROW_GPG_RECIPIENT=${FPR.toLowerCase()}`, ''].join('\n'));
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body.replaceAll('\\${', '${')}\n`, { mode: 0o755 });
  fs.chmodSync(home, homeMode);
  const log = path.join(dir, 'calls.log'); const pb = path.join(dir, 'porkbun-bodies.log');
  fs.writeFileSync(log, ''); fs.writeFileSync(pb, '');
  return { dir, home, envFile, log, pb, state, box, calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), rec: () => fs.readFileSync(path.join(home, 'register/drill.env'), 'utf8') };
}
function run(fx, script, args, env = {}, input = '') {
  const e = {
    ...process.env, PATH: `${path.join(fx.dir, 'bin')}:${process.env.PATH}`, FLEET_HOME: fx.home, FLEET_POLL_SECONDS: '0', FLEET_POLL_TRIES: '3', FLEET_OPERATOR: 'tester',
    FAKE_LOG: fx.log, FAKE_PB: fx.pb, FAKE_STATE: fx.state, FAKE_BOX: fx.box, FAKE_VERSION: '1.25.4', FAKE_UFW: UFW([UFW_V4, UFW_V6]), FAKE_LSBLK: 'suds-data crypt\\nnvme1n1 disk', ...env,
  };
  const r = spawnSync('bash', [path.join(FLEET, script), ...args], { env: e, encoding: 'utf8', input, timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const provision = (fx, args = ['--apply'], env) => run(fx, 'provision-tenant.sh', [fx.envFile, ...args], env);
const receipt = (fx) => fs.appendFileSync(path.join(fx.home, 'register/drill.env'), `EXPORT_FILE=exports/drill-2026-10-09.zip\nEXPORT_SHA256=${'ab'.repeat(32)}\nEXPORT_CONFIRMED_ON=2026-10-09\n`);
const order = (calls, ...needles) => {
  let at = -1;
  for (const n of needles) { const i = calls.findIndex((c, j) => j > at && c.includes(n)); assert.ok(i > at, `"${n}" is called, after the previous step (calls: ${calls.length})`); at = i; }
};

test('the fleet scripts parse, and are shellcheck-clean', (t) => {
  for (const f of SCRIPTS) { const r = spawnSync('bash', ['-n', path.join(FLEET, f)], { encoding: 'utf8' }); assert.equal(r.status, 0, `${f}: ${r.stderr}`); }
  if (!has('shellcheck')) { t.skip('shellcheck is not installed'); return; }
  const r = spawnSync('shellcheck', ['-x', '-P', REPO, ...SCRIPTS.map((f) => path.join(FLEET, f))], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the scripts stay compact (the patch line limit), and the public files name no tenant and hold no secret', () => {
  const lines = SCRIPTS.reduce((n, f) => n + fs.readFileSync(path.join(FLEET, f), 'utf8').split('\n').length - 1, 0);
  assert.ok(lines < 700, `deploy/fleet scripts: ${lines} lines`);
  for (const f of fs.readdirSync(FLEET)) {
    const s = fs.readFileSync(path.join(FLEET, f), 'utf8');
    assert.ok(!/sk1_[A-Za-z0-9]|pk1_[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE KEY|aws_secret_access_key/i.test(s), `${f} holds no credential`);
    assert.ok(!/^(RELEASE_SHA256|ESCROW_GPG_RECIPIENT)=\S/m.test(s), `${f}: no pinned value in the public example`);
    assert.ok(!/\b(BAA|QSOA)_STATUS=\S/.test(s), `${f}: no agreement status`);
  }
  const ex = fs.readFileSync(path.join(FLEET, 'tenant.env.example'), 'utf8');
  for (const k of ['TENANT_SLUG', 'TENANT_DOMAIN', 'ADMIN_CIDR', 'LIGHTSAIL_BUNDLE', 'REGION', 'AVAILABILITY_ZONE', 'SUDS_VERSION', 'RELEASE_SHA256', 'OFFSITE_DISK_GB=32', 'ANCHORS_DISK_GB=8', 'WWW_REDIRECT', 'SSH_KEY_FILE', 'PORKBUN_CREDENTIALS']) assert.ok(ex.includes(k), `the example has ${k}`);
  // The second guard: what belongs in FLEET_HOME is ignored here.
  if (has('git') && spawnSync('git', ['-C', REPO, 'rev-parse'], { encoding: 'utf8' }).status === 0) {
    for (const p of ['deploy/fleet/drill.env', 'deploy/fleet/tenants/drill.env', 'fleet-home/register/drill.env', 'register/drill.env', 'escrow/drill/keys.tar.gpg', 'drill.tenant.env', 'credentials/porkbun.env']) {
      assert.equal(spawnSync('git', ['-C', REPO, 'check-ignore', '-q', p]).status, 0, `${p} is git-ignored`);
    }
    assert.notEqual(spawnSync('git', ['-C', REPO, 'check-ignore', '-q', 'deploy/fleet/tenant.env.example']).status, 0, 'the example is not ignored');
  }
});

test('the dry run prints the plan and every command, and calls nothing', () => {
  const fx = fixture();
  const r = provision(fx, []);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(fx.calls(), [], 'no stub was called: no aws, curl, ssh, scp or gpg');
  assert.ok(!fs.existsSync(path.join(fx.home, 'register')) && !fs.existsSync(path.join(fx.home, 'escrow')), 'nothing written');
  for (const s of ['DRY RUN', '+ aws --region us-west-2 lightsail create-instances --instance-names suds-drill --availability-zone us-west-2a --blueprint-id ubuntu_24_04 --bundle-id medium_3_0 --key-pair-name suds-fleet --ip-address-type dualstack',
    'allocate-static-ip --static-ip-name suds-drill-ip', 'attach-static-ip --static-ip-name suds-drill-ip --instance-name suds-drill',
    'create-disk --disk-name suds-drill-data --availability-zone us-west-2a --size-in-gb 64', 'create-disk --disk-name suds-drill-offsite --availability-zone us-west-2a --size-in-gb 32',
    'create-disk --disk-name suds-drill-anchors --availability-zone us-west-2a --size-in-gb 8', 'attach-disk --disk-name suds-drill-anchors --instance-name suds-drill --disk-path /dev/xvdh',
    'put-instance-public-ports --instance-name suds-drill --port-infos fromPort=22\\,toPort=22\\,protocol=tcp\\,cidrs=203.0.113.10/32\\,ipv6Cidrs=2001:db8:10::/48',
    'https://api.porkbun.com/api/json/v3/dns/create/suds.systems', '"name":"drill"', '"name":"www.drill"', 'https://dns.google/resolve?name=drill.suds.systems&type=A',
    'prepare-host.sh 64 32 8', 'install.sh --domain=drill.suds.systems --admin-cidr=203.0.113.10/32 --admin-cidr6=2001:db8:10::/48 --offsite=/mnt/suds-offsite --anchors=/mnt/suds-anchors --tls=caddy --version=1.25.4',
    `--release-sha256=${sha256(Buffer.from('a stand-in for suds-v1.25.4.zip\n'))} --www-redirect`,
    '+ assert: a NEW SSH connection succeeds after the install session closed', '+ assert: ufw allows SSH (22) on IPv4 and on IPv6', '+ assert: /var/lib/suds is on an encrypted (LUKS/dm-crypt) volume',
    `--recipient ${FPR}`, 'sign in as "guest"', '/var/lib/suds/first-admin-password.txt']) assert.ok(r.out.includes(s), `the plan shows: ${s}`);
  assert.ok(!r.all.includes(SECRET), 'the Porkbun secret is never printed');
  assert.ok(!r.out.includes('ufw allow proto'), 'no SSH rule added beside install.sh: it takes --admin-cidr6 itself (1.25.4, G10)');
  const steps = [...r.out.matchAll(/^== (\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(steps, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('--apply runs the steps in order, passes every assert, escrows the keys and writes the record', () => {
  const fx = fixture();
  const r = provision(fx);
  assert.equal(r.code, 0, r.all);
  const calls = fx.calls();
  order(calls, 'gpg --batch --list-keys', 'lightsail create-instances', 'instance.state.name', 'allocate-static-ip', 'attach-static-ip', 'staticIp.ipAddress',
    'create-disk --disk-name suds-drill-data', 'attach-disk --disk-name suds-drill-data', 'create-disk --disk-name suds-drill-anchors', 'attach-disk --disk-name suds-drill-anchors',
    'put-instance-public-ports', 'get-instance-port-states', 'retrieveByNameType/suds.systems/A/drill', 'dns/create/suds.systems', 'dns.google/resolve?name=drill.suds.systems',
    'dns.google/resolve?name=www.drill.suds.systems', 'ssh echo suds-fleet-ssh-ok', 'scp', 'sha256sum -c', 'prepare-host.sh 64 32 8', 'deploy/linux/install.sh --domain=drill.suds.systems --admin-cidr=203.0.113.10/32 --admin-cidr6=2001:db8:10::/48',
    'ssh echo suds-fleet-ssh-ok', 'ufw status', 'systemctl is-active suds caddy', 'curl -sS -o /dev/null', 'version.json', 'findmnt', 'www-redirect.caddy', 'https://www.drill.suds.systems/',
    'find /etc/suds/credentials');
  // The copy streams from ssh into gpg (a pipe: the two start together), after the key count.
  order(calls, 'find /etc/suds/credentials', 'tar -C / -cf - etc/suds/credentials etc/suds-luks');
  order(calls, 'find /etc/suds/credentials', `gpg --batch --yes --trust-model always --encrypt --recipient ${FPR} --output`);
  assert.ok(calls.every((c) => !c.includes(SECRET)), 'the Porkbun secret is in no command line');
  assert.ok(fs.readFileSync(fx.pb, 'utf8').includes(`"secretapikey":"${SECRET}"`), 'it is sent in the JSON body, on stdin');
  // Escrow: the encrypted copy, its hash in the record and the log; never the keys in the clear on this machine.
  const rec = fx.rec();
  const file = /^ESCROW_FILE=(escrow\/drill\/keys-\d{8}T\d{6}Z\.tar\.gpg)$/m.exec(rec)[1];
  const enc = fs.readFileSync(path.join(fx.home, file));
  assert.ok(enc.subarray(0, 9).toString() === 'FAKEGPG1\n', 'encrypted (by the gpg stub) for the owner');
  assert.match(rec, new RegExp(`^ESCROW_SHA256=${sha256(enc)}$`, 'm'));
  for (const l of ['STATUS=active', 'STATIC_IP=203.0.113.50', 'INSTANCE_NAME=suds-drill', 'TENANT_DOMAIN=drill.suds.systems', 'SUDS_VERSION=1.25.4', 'LUKS=yes', 'DEMO_ONLY=no', 'BAA_STATUS=', 'QSOA_STATUS=']) assert.match(rec, new RegExp(`^${l}`, 'm'));
  const access = fs.readFileSync(path.join(fx.home, 'escrow/access.log'), 'utf8');
  assert.match(access, new RegExp(`^\\S+Z by=tester@\\S+ put slug=drill file=${file} sha256=${sha256(enc)} keys=4 prev=0{64}$`, 'm'));
  assert.equal(fs.statSync(path.join(fx.home, file)).mode & 0o777, 0o400);
  assert.equal(fs.statSync(path.join(fx.home, 'register/drill.env')).mode & 0o077, 0, 'the record is private');
  assert.ok(!r.all.includes('suds_encryption_key-value'), 'no key printed');
  assert.match(r.out, /sign in as "guest"/); assert.match(r.out, /\/var\/lib\/suds\/first-admin-password\.txt/);
  assert.match(r.err, /BAA_STATUS and QSOA_STATUS are blank/);
  // A second run keeps what exists: nothing is created twice.
  const again = provision(fx);
  assert.equal(again.code, 0, again.all);
  assert.equal(fx.calls().filter((c) => c.includes('create-instances')).length, 1, 'the instance is created once');
  assert.equal(fx.calls().filter((c) => c.includes('dns/create/')).length, 2, 'the records are edited, not created again');
  assert.equal(run(fx, 'escrow.sh', ['verify']).code, 0);
  // Another version in the settings file is an upgrade: refused, it goes through upgrade.sh.
  fs.writeFileSync(fx.envFile, fs.readFileSync(fx.envFile, 'utf8').replace('SUDS_VERSION=1.25.4', 'SUDS_VERSION=1.25.5'));
  const up = provision(fx);
  assert.equal(up.code, 1); assert.match(up.err, /drill runs 1\.25\.4 \(its record\) and SUDS_VERSION is 1\.25\.5: upgrade with deploy\/linux\/upgrade\.sh/);
});

for (const [name, env, args, msg] of [
  ['no IPv6 SSH rule in ufw', { FAKE_UFW: UFW([UFW_V4]) }, [], /ufw allows SSH \(22\) on IPv4 and on IPv6: IPv6/],
  ['no IPv4 SSH rule in ufw', { FAKE_UFW: UFW([UFW_V6]) }, [], /ufw allows SSH \(22\) on IPv4 and on IPv6: IPv4/],
  ['a new SSH connection fails after the install session closed', { FAKE_FRESH_SSH_FAIL: '1' }, [], /a NEW SSH connection succeeds after the install session closed/],
  ['the data directory is not on an encrypted volume', { FAKE_LSBLK: 'nvme0n1p1 part\\nnvme0n1 disk' }, [], /\/var\/lib\/suds is on an encrypted/],
  ['the site serves another version', { FAKE_VERSION: '1.25.2' }, [], /version\.json is 1\.25\.4/],
  ['caddy is not active', { FAKE_CADDY: 'failed' }, [], /systemctl is-active suds caddy/],
]) {
  test(`a post-install assert fails the run: ${name}`, () => {
    const fx = fixture();
    const r = provision(fx, ['--apply', ...args], env);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /FAILED: post-install assert\(s\) failed/);
    assert.match(r.all, msg);
    assert.match(fx.rec(), /^STATUS=failed-asserts$/m);
    assert.ok(!fx.calls().some((c) => c.includes('--encrypt')), 'not escrowed, not live');
    assert.ok(!r.out.includes('sign in as "guest"'), 'no go-live instructions');
  });
}

test('--allow-unencrypted-demo downgrades the LUKS assert to a loud warning, recorded in the tenant record', () => {
  const fx = fixture({ data: 0 });
  const r = provision(fx, ['--apply', '--allow-unencrypted-demo'], { FAKE_LSBLK: 'nvme0n1p1 part\\nnvme0n1 disk' });
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /DEMONSTRATION DATA ONLY/);
  assert.match(fx.rec(), /^LUKS=no$/m); assert.match(fx.rec(), /^DEMO_ONLY=yes$/m);
  assert.ok(fx.calls().some((c) => c.includes("'--accept-unencrypted-disk=demo-only tenant, no real data")), 'install.sh is told, so its compliance report records the risk');
  assert.ok(!fx.calls().some((c) => c.includes('suds-drill-data')), 'no data disk with DATA_DISK_GB=0');
  assert.ok(fx.calls().some((c) => c.includes('tar -C / -cf - etc/suds/credentials') && !c.includes('suds-luks')));
});

test('refusals: FLEET_HOME inside the repository, world-readable, a settings file outside it, no escrow key, a wrong zip', () => {
  const fx = fixture();
  let r = run(fx, 'provision-tenant.sh', [fx.envFile], { FLEET_HOME: FLEET });
  assert.equal(r.code, 1); assert.match(r.err, /REFUSED: FLEET_HOME=.* is inside this repository's working tree/);
  r = run(fx, 'provision-tenant.sh', [fx.envFile], { FLEET_HOME: '' });
  assert.equal(r.code, 1); assert.match(r.err, /FLEET_HOME is not set/);
  const outside = path.join(fx.dir, 'drill.env'); fs.copyFileSync(fx.envFile, outside);
  r = run(fx, 'provision-tenant.sh', [outside]);
  assert.equal(r.code, 1); assert.match(r.err, /outside FLEET_HOME/);
  r = run(fx, 'decommission-tenant.sh', [fx.envFile], { FLEET_HOME: FLEET });
  assert.equal(r.code, 1); assert.match(r.err, /inside this repository's working tree/);
  r = run(fx, 'escrow.sh', ['verify'], { FLEET_HOME: FLEET });
  assert.equal(r.code, 1); assert.match(r.err, /inside this repository's working tree/);
  r = provision(fx, ['--apply'], { FAKE_NO_ESCROW_KEY: '1' });
  assert.equal(r.code, 1); assert.match(r.err, /no escrow, no go-live/);
  fs.appendFileSync(path.join(fx.home, 'releases/suds-v1.25.4.zip'), 'tampered');
  r = provision(fx);
  assert.equal(r.code, 1); assert.match(r.err, /SHA-256 is not RELEASE_SHA256/);
  assert.ok(!fx.calls().some((c) => c.startsWith('aws') || c.startsWith('curl')), 'refused before any infrastructure call');
  const open = fixture({ homeMode: 0o755 });
  r = provision(open, []);
  assert.equal(r.code, 1); assert.match(r.err, /readable by other users/);
  fs.writeFileSync(fx.envFile, fs.readFileSync(fx.envFile, 'utf8').replace('ADMIN_CIDR6=2001:db8:10::/48\n', ''));
  r = provision(fx, []);
  assert.equal(r.code, 1); assert.match(r.err, /ADMIN_CIDR6 must be an IPv6 network/);
  // A release before 1.25.4 has no install.sh --admin-cidr6: refused before anything runs.
  const old = fixture();
  fs.writeFileSync(old.envFile, fs.readFileSync(old.envFile, 'utf8').replace('SUDS_VERSION=1.25.4', 'SUDS_VERSION=1.25.3'));
  r = provision(old, []);
  assert.equal(r.code, 1); assert.match(r.err, /SUDS_VERSION must be 1\.25\.4 or later/);
  assert.deepEqual(old.calls(), []);
});

test('escrow.sh open logs who, when and why before decrypting, and every failure', () => {
  const fx = fixture();
  assert.equal(provision(fx).code, 0);
  let r = run(fx, 'escrow.sh', ['open', 'drill']);
  assert.equal(r.code, 1); assert.match(r.err, /--reason/);
  r = run(fx, 'escrow.sh', ['open', 'drill', '--reason', 'DR drill, ticket OPS-42'], { TMPDIR: fx.dir });
  assert.equal(r.code, 0, r.all);
  const dir = /^Opened into (\S+) /m.exec(r.out)[1];
  assert.equal(fs.readFileSync(path.join(dir, 'etc/suds/credentials/suds_encryption_key'), 'utf8'), 'suds_encryption_key-value\n');
  assert.ok(fs.existsSync(path.join(dir, 'etc/suds-luks/suds-data.key')), 'the LUKS key is escrowed with the SUDS keys');
  assert.ok(!fs.existsSync(path.join(dir, 'keys.tar')), 'the decrypted tar is shredded once unpacked');
  assert.equal(fs.statSync(dir).mode & 0o077, 0);
  let log = fs.readFileSync(path.join(fx.home, 'escrow/access.log'), 'utf8');
  assert.match(log, /by=tester@\S+ open-requested slug=drill file=escrow\/drill\/\S+ reason="DR drill, ticket OPS-42" prev=[0-9a-f]{64}\n.* opened slug=drill into=/);
  // A replaced escrow file is refused, and the attempt is logged.
  const file = /^ESCROW_FILE=(.*)$/m.exec(fx.rec())[1];
  fs.chmodSync(path.join(fx.home, file), 0o600); fs.appendFileSync(path.join(fx.home, file), 'x');
  r = run(fx, 'escrow.sh', ['open', 'drill', '--reason', 'second look, OPS-43']);
  assert.equal(r.code, 1); assert.match(r.err, /does not match ESCROW_SHA256/);
  log = fs.readFileSync(path.join(fx.home, 'escrow/access.log'), 'utf8');
  assert.match(log, /open-FAILED slug=drill hash-mismatch/);
  assert.equal(run(fx, 'escrow.sh', ['verify']).code, 0, 'the chain is intact');
  fs.writeFileSync(path.join(fx.home, 'escrow/access.log'), log.replace('OPS-42', 'OPS-99'));
  r = run(fx, 'escrow.sh', ['verify']);
  assert.equal(r.code, 1); assert.match(r.out, /BROKEN: .*access\.log line 3/);
});

test('decommission refuses without the export receipt, or without both typed confirmations', () => {
  const fx = fixture();
  assert.equal(provision(fx).code, 0);
  const before = fx.calls().length;
  let r = run(fx, 'decommission-tenant.sh', [fx.envFile, '--apply'], {}, 'drill\nDESTROY\n');
  assert.equal(r.code, 1); assert.match(r.err, /no export receipt/); assert.match(r.err, /Nothing was deleted/);
  receipt(fx);
  r = run(fx, 'decommission-tenant.sh', [fx.envFile, '--apply'], {}, 'drll\nDESTROY\n');
  assert.equal(r.code, 1); assert.match(r.err, /not the tenant slug: nothing was deleted/);
  r = run(fx, 'decommission-tenant.sh', [fx.envFile, '--apply'], {}, 'drill\ndestroy\n');
  assert.equal(r.code, 1); assert.match(r.err, /DESTROY was not typed/);
  r = run(fx, 'decommission-tenant.sh', [fx.envFile, '--apply'], {}, 'DESTROY\ndrill\n');
  assert.equal(r.code, 1);
  r = run(fx, 'decommission-tenant.sh', [fx.envFile]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /THIS IS IRREVERSIBLE/); assert.match(r.out, /delete-instance --instance-name suds-drill --force-delete-add-ons/); assert.match(r.out, /deleteByNameType\/suds.systems\/A\/www.drill/);
  assert.equal(fx.calls().length, before, 'no refusal and no dry run called anything');
  assert.ok(fs.readdirSync(path.join(fx.home, 'escrow/drill')).length === 1, 'escrow untouched');
});

test('decommission --apply with the receipt and both confirmations deletes DNS first, then the instance, disks and IP, and shreds escrow', () => {
  const fx = fixture();
  assert.equal(provision(fx).code, 0);
  receipt(fx);
  const before = fx.calls().length;
  const r = run(fx, 'decommission-tenant.sh', [fx.envFile, '--apply'], { FAKE_SNAPS: 'suds-drill-before-upgrade' }, 'drill\nDESTROY\n');
  assert.equal(r.code, 0, r.all);
  const calls = fx.calls().slice(before);
  order(calls, 'deleteByNameType/suds.systems/A/drill', 'deleteByNameType/suds.systems/A/www.drill', 'delete-instance-snapshot --instance-snapshot-name suds-drill-before-upgrade',
    'delete-instance --instance-name suds-drill --force-delete-add-ons', 'delete-disk --disk-name suds-drill-data', 'delete-disk --disk-name suds-drill-offsite',
    'delete-disk --disk-name suds-drill-anchors', 'release-static-ip --static-ip-name suds-drill-ip');
  assert.ok(!fs.existsSync(path.join(fx.home, 'escrow/drill')), 'the escrow copy is shredded');
  assert.deepEqual(fs.readdirSync(fx.state).filter((f) => f.startsWith('suds-') || f.startsWith('dns-')), [], 'nothing left at the (fake) provider');
  const rec = fx.rec();
  assert.match(rec, /^STATUS=decommissioned$/m); assert.match(rec, /^ESCROW_SHREDDED_AT=\S+Z$/m); assert.match(rec, /^ESCROW_FILE=$/m);
  assert.match(rec, /^EXPORT_CONFIRMED_ON=2026-10-09$/m, 'the receipt stays');
  const hist = fs.readFileSync(path.join(fx.home, 'register/drill.log'), 'utf8');
  assert.match(hist, /decommission confirmed export_sha256=(ab){32}/);
  assert.match(hist, /decommissioned slug=drill .* files_shredded=1 export_sha256=(ab){32} record_sha256=[0-9a-f]{64} prev=/);
  const access = fs.readFileSync(path.join(fx.home, 'escrow/access.log'), 'utf8');
  assert.match(access, /decommission-start slug=drill/); assert.match(access, /decommissioned slug=drill .*files_shredded=1/);
  assert.equal(run(fx, 'escrow.sh', ['verify']).code, 0);
});
