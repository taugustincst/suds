'use strict';
// SUDS Server's compliance check (scripts/compliance-check.js): each host check against fixtures — a fake root
// filesystem (/proc/net/tcp, /etc/passwd, unit files, journald and update configuration) and a fake command
// runner with canned findmnt, lsblk, cryptsetup, ufw, firewall-cmd, timedatectl, chronyc and systemctl output —
// the TLS check against local TLS servers (good, expired, TLS 1.1 only, no HSTS), the signed report and its
// offline verifier (round trip and tamper detection), and the rule that "could not check" is never a pass.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hc = require('../scripts/compliance/host-checks');
const rules = require('../server/compliance-rules');
const cr = require('../server/compliance-report');
const signing = require('../server/signing');
const { generate } = require('../server/selfsigned');

const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-compliance-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const uid = process.getuid();
let n = 0;

/** A fake root with /etc/passwd naming the test user "suds", plus files given as { path: content | { mode, content } }. */
function root(files = {}) {
  const r = path.join(tmp, `root${++n}`);
  const put = (p, v) => { const f = path.join(r, p); fs.mkdirSync(path.dirname(f), { recursive: true }); const c = typeof v === 'object' ? v : { content: v }; fs.writeFileSync(f, c.content); if (c.mode) fs.chmodSync(f, c.mode); };
  put('/etc/passwd', `root:x:0:0::/root:/bin/sh\nsuds:x:${uid}:${uid}::/var/lib/suds:/usr/sbin/nologin\n`);
  put('/etc/os-release', 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n');
  for (const [p, v] of Object.entries(files)) put(p, v);
  return r;
}
/** A runner answering from a table: 'cmd arg arg' → { stdout, code } | string; anything else is "not installed". */
function runner(table) {
  return (cmd, args = []) => {
    const key = [cmd, ...args].join(' ');
    const hit = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : Object.entries(table).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (hit === undefined) return { code: 127, stdout: '', stderr: '', missing: true };
    return typeof hit === 'string' ? { code: 0, stdout: hit, stderr: '', missing: false } : { code: 0, stdout: '', stderr: '', missing: false, ...hit };
  };
}
const conf = (over = {}) => ({ dataDir: '/var/lib/suds', credentialsDir: '/etc/suds/credentials', credentials: ['suds_encryption_key', 'suds_index_key', 'suds_backup_key', 'suds_signing_key'],
  unit: 'suds.service', serviceUser: 'suds', appPort: 8080, tlsPort: 443, httpPort: 80, tlsMode: 'caddy', adminCidr: '10.20.0.0/16', logRetentionDays: 400,
  codeDir: REPO, nodeBin: '/opt/suds/node/bin/node', sudsVersion: '1.17.1', latestVersion: '', acceptUnencryptedDisk: '', domain: '', ...over });
const ctx = (r, table = {}, over = {}) => ({ root: r, run: runner(table), now: Date.now(), conf: conf(over), rootUid: uid });

// ---- the catalogue ----
test('every check maps to rules that exist; every host check the script runs is in the catalogue', async () => {
  for (const c of [...rules.HOST_CHECKS, ...rules.APP_CHECKS]) {
    assert.ok(c.rules.length, `${c.id} maps to at least one rule`);
    for (const k of c.rules) assert.ok(rules.RULES[k], `${c.id}: rule ${k} is defined`);
    assert.ok(c.remediation, `${c.id} says how to fix it`);
  }
  const ids = new Set(rules.HOST_CHECKS.map((c) => c.id));
  const out = await hc.run(ctx(root(), {}, { domain: '' }));
  for (const r of out) assert.ok(ids.has(r.id), `${r.id} is in the catalogue`);
  for (const r of out) assert.ok(rules.RESULTS.includes(r.result), `${r.id}: ${r.result}`);
  assert.ok(Object.values(rules.RULES).some((r) => /§164\.308/.test(r.cite)) && Object.values(rules.RULES).some((r) => /§164\.310/.test(r.cite)) && Object.values(rules.RULES).some((r) => /§164\.312/.test(r.cite)));
  assert.ok(Object.values(rules.RULES).some((r) => /42 CFR §2\.16/.test(r.cite)) && Object.values(rules.RULES).some((r) => /56\.101/.test(r.cite)));
});

test('"could not check" is never a pass: in the verdict, the counts or the exit code', () => {
  const k = (result) => ({ id: 'x', result });
  assert.equal(cr.overall([k('pass'), k('pass')]), 'pass');
  assert.equal(cr.overall([k('pass'), k('not-checked')]), 'incomplete');
  assert.equal(cr.overall([k('pass'), k('warn')]), 'pass-with-warnings');
  assert.equal(cr.overall([k('pass'), k('not-checked'), k('fail')]), 'fail');
  assert.deepEqual(cr.counts([k('pass'), k('not-checked')]), { pass: 1, fail: 0, warn: 0, 'not-checked': 1 });
  assert.equal(rules.resultOfLevel('info', { info: undefined }), 'warn', 'an unmapped info line is not a pass');
  assert.equal(rules.resultOfLevel('mystery', {}), 'not-checked');
  assert.equal(rules.levelOfResult('not-checked'), 'warn', 'shown in Security status as needing attention, not OK');
});

// ---- host checks ----
test('host.os: supported releases pass, others warn, no os-release cannot be checked', () => {
  assert.equal(hc.checkOs(ctx(root())).result, 'pass');
  assert.equal(hc.checkOs(ctx(root({ '/etc/os-release': 'ID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n' }))).result, 'pass');
  assert.equal(hc.checkOs(ctx(root({ '/etc/os-release': 'ID=debian\nVERSION_ID="12"\n' }))).result, 'warn');
  const r = root(); fs.unlinkSync(path.join(r, 'etc/os-release'));
  assert.equal(hc.checkOs(ctx(r)).result, 'not-checked');
});

test('host.data_dir: 0700 owned by the service user with the database 0600 passes; anything looser fails', () => {
  const r = root({ '/var/lib/suds/suds.db': { content: 'x', mode: 0o600 }, '/var/lib/suds/suds.db-wal': { content: '', mode: 0o600 } });
  fs.chmodSync(path.join(r, 'var/lib/suds'), 0o700);
  let c = hc.checkDataDir(ctx(r));
  assert.equal(c.result, 'pass', c.evidence);
  assert.match(c.evidence, /suds\.db 0600/);
  fs.chmodSync(path.join(r, 'var/lib/suds/suds.db'), 0o644);
  c = hc.checkDataDir(ctx(r));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /suds\.db is 0644 \(want 0600\)/);
  fs.chmodSync(path.join(r, 'var/lib/suds/suds.db'), 0o600); fs.chmodSync(path.join(r, 'var/lib/suds'), 0o755);
  c = hc.checkDataDir(ctx(r));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /is 0755 \(want 0700\)/);
  assert.equal(hc.checkDataDir(ctx(root())).result, 'fail', 'a missing data directory fails');
});

test('host.disk_encryption: LUKS under the data directory passes; none fails (or warns with the risk accepted); remote storage cannot be checked', () => {
  const r = root();
  const luks = { 'findmnt -n -o SOURCE,FSTYPE --target /var/lib/suds': '/dev/mapper/suds-data ext4\n', 'lsblk -s -n -r -o NAME,TYPE /dev/mapper/suds-data': 'suds-data crypt\nsdb1 part\nsdb disk\n',
    'cryptsetup status suds-data': '/dev/mapper/suds-data is active and is in use.\n  type:    LUKS2\n  cipher:  aes-xts-plain64\n  keysize: 512 bits\n  device:  /dev/sdb1\n' };
  let c = hc.checkDiskEncryption(ctx(r, luks));
  assert.equal(c.result, 'pass', c.evidence);
  assert.match(c.evidence, /type LUKS2, cipher aes-xts-plain64, key 512 bits/);
  // LVM on LUKS: the crypt layer is further down the chain.
  c = hc.checkDiskEncryption(ctx(r, { ...luks, 'findmnt -n -o SOURCE,FSTYPE --target /var/lib/suds': '/dev/mapper/vg-data xfs\n', 'lsblk -s -n -r -o NAME,TYPE /dev/mapper/vg-data': 'vg-data lvm\nluks-1 crypt\nsda3 part\nsda disk\n', 'cryptsetup status luks-1': '  type:    LUKS2\n' }));
  assert.equal(c.result, 'pass', c.evidence);
  const plain = { 'findmnt -n -o SOURCE,FSTYPE --target /var/lib/suds': '/dev/sda2 ext4\n', 'lsblk -s -n -r -o NAME,TYPE /dev/sda2': 'sda2 part\nsda disk\n' };
  c = hc.checkDiskEncryption(ctx(r, plain));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /has no dm-crypt\/LUKS layer/);
  c = hc.checkDiskEncryption(ctx(r, plain, { acceptUnencryptedDisk: 'pilot with synthetic data' }));
  assert.equal(c.result, 'warn'); assert.equal(c.risk_accepted, true); assert.match(c.evidence, /RISK ACCEPTED by the operator at install \(--accept-unencrypted-disk: pilot with synthetic data\)/);
  c = hc.checkDiskEncryption(ctx(r, { 'findmnt -n -o SOURCE,FSTYPE --target /var/lib/suds': 'nas.county.gov:/suds nfs4\n' }));
  assert.equal(c.result, 'not-checked'); assert.match(c.evidence, /cannot be seen from this host/);
  assert.equal(hc.checkDiskEncryption(ctx(r, {})).result, 'not-checked', 'no findmnt');
});

function keyRoot(extra = {}) {
  const hex = () => crypto.randomBytes(32).toString('hex');
  const files = { '/etc/systemd/system/suds.service': fs.readFileSync(path.join(REPO, 'deploy/linux/suds.service'), 'utf8'), '/etc/suds/suds.env': 'TRUST_PROXY=1\nLOCAL_MODE_ENABLED=false\n', ...extra };
  for (const k of ['suds_encryption_key', 'suds_index_key', 'suds_backup_key', 'suds_signing_key']) files[`/etc/suds/credentials/${k}`] = { content: hex(), mode: 0o600 };
  const r = root(files);
  fs.chmodSync(path.join(r, 'etc/suds/credentials'), 0o700);
  return r;
}
test('host.keys: root-only credentials loaded by LoadCredential= pass; a readable key, a key in Environment= or an environment file fails', () => {
  let r = keyRoot();
  let c = hc.checkKeys(ctx(r));
  assert.equal(c.result, 'pass', c.evidence);
  assert.match(c.evidence, /4 LoadCredential= lines/);
  assert.ok(!/[0-9a-f]{64}/.test(c.evidence), 'no key value in the evidence');
  fs.chmodSync(path.join(r, 'etc/suds/credentials/suds_index_key'), 0o644);
  c = hc.checkKeys(ctx(r));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /suds_index_key is 0644/);
  fs.chmodSync(path.join(r, 'etc/suds/credentials'), 0o755); fs.chmodSync(path.join(r, 'etc/suds/credentials/suds_index_key'), 0o600);
  assert.match(hc.checkKeys(ctx(r)).evidence, /credentials is 0755 \(want 0700\)/);
  r = keyRoot({ '/etc/systemd/system/suds.service.d/override.conf': `[Service]\nEnvironment=SUDS_ENCRYPTION_KEY=${'a'.repeat(64)}\n` });
  c = hc.checkKeys(ctx(r));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /override\.conf: a secret is set with Environment= \(SUDS_ENCRYPTION_KEY\)/);
  assert.ok(!c.evidence.includes('a'.repeat(64)), 'the value is never echoed');
  r = keyRoot({ '/etc/suds/suds.env': `TRUST_PROXY=1\nexport SUDS_INDEX_KEY="${'b'.repeat(64)}"\n` });
  c = hc.checkKeys(ctx(r));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /\/etc\/suds\/suds\.env \(EnvironmentFile of suds\.service\) holds SUDS_INDEX_KEY/);
  r = keyRoot({ '/etc/systemd/system/suds.service': '[Service]\nEnvironmentFile=/etc/suds/suds.env\nExecStart=/opt/suds/node/bin/node server/index.js\n' });
  assert.match(hc.checkKeys(ctx(r)).evidence, /no LoadCredential= lines/);
  // The running process's environment, when readable.
  r = keyRoot({ '/proc/4242/environ': `PATH=/usr/bin\0SUDS_SIGNING_KEY=${'c'.repeat(64)}\0` });
  c = hc.checkKeys(ctx(r, { 'systemctl show -p MainPID --value suds.service': '4242\n' }));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /the running SUDS process has SUDS_SIGNING_KEY in its environment/);
  r = keyRoot({ '/var/lib/suds/keys.json': { content: '{}', mode: 0o600 } });
  assert.equal(hc.checkKeys(ctx(r)).result, 'warn', 'keys.json beside the data');
});

test('host.service: the shipped sandbox as systemd reports it passes; a weakened drop-in fails', () => {
  const good = 'User=suds\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nLockPersonality=yes\nRestrictRealtime=yes\nUMask=0077\nCapabilityBoundingSet=\nAmbientCapabilities=\nActiveState=active\nUnitFileState=enabled\nLoadState=loaded\n';
  const t = (out) => ({ 'systemctl show suds.service*': out });
  assert.equal(hc.checkService(ctx(root(), t(good))).result, 'pass');
  const c = hc.checkService(ctx(root(), t(good.replace('NoNewPrivileges=yes', 'NoNewPrivileges=no').replace('ProtectSystem=strict', 'ProtectSystem=no'))));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /NoNewPrivileges=no, ProtectSystem=no/);
  assert.equal(hc.checkService(ctx(root(), t(good.replace('ActiveState=active', 'ActiveState=failed')))).result, 'fail');
  assert.equal(hc.checkService(ctx(root(), t('LoadState=not-found\n'))).result, 'fail');
  assert.equal(hc.checkService(ctx(root(), {})).result, 'not-checked', 'no systemctl');
});

const TCP_HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
test('host.bind: SUDS on 127.0.0.1 or ::1 passes, on any other address fails, not listening cannot be checked', () => {
  const lo = root({ '/proc/net/tcp': `${TCP_HEAD}   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000   998        0 1 1\n   1: 00000000:01BB 00000000:0000 0A 0 0 0 0 0\n`, '/proc/net/tcp6': `${TCP_HEAD}   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 0\n` });
  let c = hc.checkBind(ctx(lo));
  assert.equal(c.result, 'pass', c.evidence); assert.match(c.evidence, /127\.0\.0\.1, ::1/);
  c = hc.checkBind(ctx(root({ '/proc/net/tcp': `${TCP_HEAD}   0: 00000000:1F90 00000000:0000 0A 0\n` })));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /port 8080 on 0\.0\.0\.0/);
  assert.equal(hc.checkBind(ctx(root({ '/proc/net/tcp6': `${TCP_HEAD}   0: 00000000000000000000000000000000:1F90 0 0A 0\n` }))).result, 'fail', ':: is every address');
  assert.equal(hc.checkBind(ctx(root({ '/proc/net/tcp': TCP_HEAD }))).result, 'not-checked');
  assert.equal(hc.hexToIp('0100007F'), '127.0.0.1');
});

const UFW_GOOD = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), deny (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    10.20.0.0/16               # SUDS Server: SSH
443/tcp                    ALLOW IN    Anywhere                   # SUDS Server: HTTPS
80/tcp                     ALLOW IN    Anywhere
443/tcp (v6)               ALLOW IN    Anywhere (v6)
80/tcp (v6)                ALLOW IN    Anywhere (v6)
`;
test('host.firewall (ufw): active, deny by default, only 443/80 and SSH from the admin network passes', () => {
  const t = (out, extra = {}) => ({ 'ufw status verbose': out, ...extra });
  let c = hc.checkFirewall(ctx(root(), t(UFW_GOOD)));
  assert.equal(c.result, 'pass', c.evidence);
  c = hc.checkFirewall(ctx(root(), t(UFW_GOOD + '22/tcp                     ALLOW IN    Anywhere\n')));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /SSH \(22\/tcp\) is open to anywhere/);
  c = hc.checkFirewall(ctx(root(), t(UFW_GOOD + '8080/tcp                   ALLOW IN    Anywhere\n')));
  assert.match(c.evidence, /unexpected port 8080\/tcp allowed from Anywhere/);
  c = hc.checkFirewall(ctx(root(), t(UFW_GOOD), { tlsMode: 'county-cert' }));
  assert.match(c.evidence, /unexpected port 80\/tcp/, 'with a county certificate port 80 is not expected');
  assert.equal(hc.checkFirewall(ctx(root(), t('Status: inactive\n'))).result, 'fail');
  assert.equal(hc.checkFirewall(ctx(root(), t(UFW_GOOD.replace('deny (incoming)', 'allow (incoming)')))).result, 'fail');
  assert.equal(hc.checkFirewall(ctx(root(), t({ code: 1, stdout: '', stderr: 'ERROR: You need to be root to run this script' }))).result, 'not-checked');
  assert.equal(hc.checkFirewall(ctx(root(), {})).result, 'not-checked', 'no firewall tool at all');
});

const FWD_GOOD = `public (active)
  target: default
  icmp-block-inversion: no
  interfaces: eth0
  sources:
  services: dhcpv6-client http https
  ports:
  protocols:
  forward: yes
  masquerade: no
  forward-ports:
  source-ports:
  icmp-blocks:
  rich rules:
	rule family="ipv4" source address="10.20.0.0/16" service name="ssh" accept
`;
test('host.firewall (firewalld): https/http and SSH only by a rich rule from the admin network passes', () => {
  const rocky = root({ '/etc/os-release': 'ID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n' });
  const t = (out) => ({ 'firewall-cmd --state': 'running\n', 'firewall-cmd --list-all': out });
  let c = hc.checkFirewall(ctx(rocky, t(FWD_GOOD)));
  assert.equal(c.result, 'pass', c.evidence);
  c = hc.checkFirewall(ctx(rocky, t(FWD_GOOD.replace('services: dhcpv6-client http https', 'services: cockpit dhcpv6-client http https ssh'))));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /ssh is open to anywhere/); assert.match(c.evidence, /unexpected service cockpit/);
  c = hc.checkFirewall(ctx(rocky, t(FWD_GOOD.replace('source address="10.20.0.0/16"', 'source address="0.0.0.0/0"'))));
  assert.match(c.evidence, /SSH allowed from 0\.0\.0\.0\/0, not the administration network/);
  assert.equal(hc.checkFirewall(ctx(rocky, t(FWD_GOOD.replace(/\n  ports:[^\n]*/, '\n  ports: 8080/tcp')))).result, 'fail');
  assert.equal(hc.checkFirewall(ctx(rocky, { 'firewall-cmd --state': { code: 252, stdout: 'not running\n' } })).result, 'fail');
});

test('host.time_sync: synchronised with a small offset passes; unsynchronised or a second off fails', () => {
  const synced = 'NTP=yes\nNTPSynchronized=yes\nTimezone=UTC\n';
  let c = hc.checkTimeSync(ctx(root(), { 'timedatectl show': synced, 'chronyc tracking': 'Reference ID    : C0A80101 (ntp.county.gov)\nSystem time     : 0.000012345 seconds slow of NTP time\nLeap status     : Normal\n' }));
  assert.equal(c.result, 'pass', c.evidence);
  c = hc.checkTimeSync(ctx(root(), { 'timedatectl show': synced, 'timedatectl timesync-status': '       Server: 10.0.0.1\n       Offset: -2.345ms\n' }));
  assert.equal(c.result, 'pass', c.evidence); assert.match(c.evidence, /timesyncd offset -2\.345ms/);
  c = hc.checkTimeSync(ctx(root(), { 'timedatectl show': synced, 'chronyc tracking': 'System time     : 2.500000000 seconds fast of NTP time\n' }));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /offset 2\.500 s/);
  assert.equal(hc.checkTimeSync(ctx(root(), { 'timedatectl show': 'NTP=no\nNTPSynchronized=no\n' })).result, 'fail');
  assert.equal(hc.checkTimeSync(ctx(root(), { 'timedatectl show': synced })).result, 'warn', 'synchronised but no offset reading');
  assert.equal(hc.checkTimeSync(ctx(root(), {})).result, 'not-checked');
});

test('host.security_updates: unattended-upgrades (-security) and dnf-automatic (security, applied)', () => {
  const deb = root({ '/etc/apt/apt.conf.d/20auto-upgrades': 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
    '/etc/apt/apt.conf.d/50unattended-upgrades': 'Unattended-Upgrade::Allowed-Origins {\n\t"${distro_id}:${distro_codename}";\n\t"${distro_id}:${distro_codename}-security";\n//\t"${distro_id}:${distro_codename}-updates";\n};\n' });
  const timer = { 'systemctl is-enabled apt-daily-upgrade.timer': 'enabled\n' };
  assert.equal(hc.checkSecurityUpdates(ctx(deb, timer)).result, 'pass');
  assert.equal(hc.checkSecurityUpdates(ctx(deb, { 'systemctl is-enabled apt-daily-upgrade.timer': 'disabled\n' })).result, 'fail');
  fs.writeFileSync(path.join(deb, 'etc/apt/apt.conf.d/20auto-upgrades'), 'APT::Periodic::Unattended-Upgrade "0";\n');
  assert.equal(hc.checkSecurityUpdates(ctx(deb, timer)).result, 'fail');
  const rhel = (conf) => root({ '/etc/os-release': 'ID="almalinux"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n', '/etc/dnf/automatic.conf': conf });
  const t = { 'systemctl is-enabled dnf-automatic.timer': 'enabled\n', 'systemctl is-enabled dnf-automatic-install.timer': 'disabled\n' };
  assert.equal(hc.checkSecurityUpdates(ctx(rhel('[commands]\nupgrade_type = security\napply_updates = yes\n'), t)).result, 'pass');
  const c = hc.checkSecurityUpdates(ctx(rhel('[commands]\nupgrade_type = default\napply_updates = no\n'), t));
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /upgrade_type is default, not security/); assert.match(c.evidence, /not applied/);
});

test('host.journald: persistent and kept at least the policy passes; shorter or volatile fails; no time limit warns', () => {
  const j = (text, extra = {}) => root({ '/etc/systemd/journald.conf': '[Journal]\n#Storage=auto\n', '/etc/systemd/journald.conf.d/suds.conf': text, ...extra });
  assert.equal(hc.checkJournald(ctx(j('[Journal]\nStorage=persistent\nMaxRetentionSec=400d\n'))).result, 'pass');
  assert.equal(hc.checkJournald(ctx(j('[Journal]\nStorage=persistent\nMaxRetentionSec=2y\n'))).result, 'pass');
  assert.equal(hc.checkJournald(ctx(j('[Journal]\nStorage=persistent\nMaxRetentionSec=30d\n'))).result, 'fail');
  assert.equal(hc.checkJournald(ctx(j('[Journal]\nStorage=volatile\nMaxRetentionSec=400d\n'))).result, 'fail');
  assert.equal(hc.checkJournald(ctx(j('[Journal]\nStorage=persistent\n'))).result, 'warn');
  assert.equal(hc.timespanDays('13month'), 13 * 30.44);
  assert.equal(hc.timespanDays('1w 3d'), 10);
  assert.equal(hc.timespanDays('86400'), 1);
});

test('host.auditd, host.node and host.suds_version', () => {
  assert.equal(hc.checkAuditd(ctx(root(), { 'systemctl is-active auditd': 'active\n' })).result, 'pass');
  assert.equal(hc.checkAuditd(ctx(root(), { 'systemctl is-active auditd': { code: 3, stdout: 'inactive\n' } })).result, 'warn', 'recommended, not required');
  const pin = hc.nodePin(REPO).NODE_VERSION;
  assert.equal(hc.checkNode(ctx(root(), { '/opt/suds/node/bin/node --version': `${pin}\n` })).result, 'pass');
  assert.equal(hc.checkNode(ctx(root(), { '/opt/suds/node/bin/node --version': 'v22.1.0\n' })).result, 'fail');
  assert.equal(hc.checkNode(ctx(root(), {})).result, 'fail', 'no node where the unit runs it');
  assert.equal(hc.supportOf('1.17.1', '1.17.1'), 'current');
  assert.equal(hc.supportOf('1.17.0', '1.17.1'), 'patch-behind');
  assert.equal(hc.supportOf('1.16.4', '1.17.1'), 'previous-minor');
  assert.equal(hc.supportOf('1.15.9', '1.17.1'), 'unsupported');
  assert.equal(hc.checkSudsVersion(ctx(root(), {}, { latestVersion: '1.17.1' })).result, 'pass');
  assert.equal(hc.checkSudsVersion(ctx(root(), {}, { latestVersion: '1.19.0' })).result, 'fail');
  const nc = hc.checkSudsVersion(ctx(root(), {}));
  assert.equal(nc.result, 'not-checked'); assert.match(nc.evidence, /released 2026-09-29/);
});

// ---- TLS, against local servers ----
function tlsServer({ days = 100, hsts = true, tlsOptions = {} } = {}) {
  const c = generate({ hosts: ['localhost', '127.0.0.1'], days });
  const srv = https.createServer({ key: c.key, cert: c.cert, ...tlsOptions }, (req, res) => { res.writeHead(200, hsts ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}); res.end('ok'); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, ca: c.ca })));
}
async function tlsCheck(opts) {
  const s = await tlsServer(opts);
  const caFile = path.join(tmp, `ca${++n}.pem`); fs.writeFileSync(caFile, s.ca);
  try { return await hc.checkTls(ctx(root(), {}, { domain: 'localhost', connectHost: '127.0.0.1', tlsPort: s.port, caFile })); } finally { s.srv.close(); }
}
test('host.tls: TLS 1.2+, a valid certificate with more than 14 days, HSTS, and TLS 1.1 refused, passes', async () => {
  const c = await tlsCheck({});
  assert.equal(c.result, 'pass', c.evidence);
  assert.match(c.evidence, /negotiated TLSv1\.3/); assert.match(c.evidence, /HSTS max-age=31536000/); assert.match(c.evidence, /TLS 1\.0\/1\.1 refused/);
});
test('host.tls: an expired certificate, one expiring within 14 days, or no HSTS fails', async () => {
  let c = await tlsCheck({ days: -1 });
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /the certificate has expired/);
  c = await tlsCheck({ days: 7 });
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /expires in \d days \(less than 14\)/);
  c = await tlsCheck({ hsts: false });
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /no Strict-Transport-Security header/);
});
test('host.tls: a server offering only TLS 1.1 fails; one that also accepts TLS 1.1 fails', async () => {
  let c = await tlsCheck({ tlsOptions: { minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' } });
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /no TLS 1\.2\+ handshake/);
  c = await tlsCheck({ tlsOptions: { minVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' } });
  assert.equal(c.result, 'fail'); assert.match(c.evidence, /accepts TLSv1\.1/);
});
test('host.tls: a certificate this host does not trust (no --ca) is a warning; nothing listening fails; no domain cannot be checked', async () => {
  const s = await tlsServer({});
  const c = await hc.checkTls(ctx(root(), {}, { domain: 'localhost', connectHost: '127.0.0.1', tlsPort: s.port }));
  s.srv.close();
  assert.equal(c.result, 'warn', c.evidence); assert.match(c.evidence, /not trusted by this host's CA store/);
  const closed = await hc.checkTls(ctx(root(), {}, { domain: 'localhost', connectHost: '127.0.0.1', tlsPort: s.port }));
  assert.equal(closed.result, 'fail'); assert.match(closed.evidence, /ECONNREFUSED/);
  assert.equal((await hc.checkTls(ctx(root(), {}, { domain: '' }))).result, 'not-checked');
});
test('host.http_redirect: a redirect to https or a closed port passes; content over plain HTTP fails', async () => {
  const mk = (h) => new Promise((resolve) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => resolve(s)); });
  let s = await mk((req, res) => { res.writeHead(308, { Location: 'https://localhost/' }); res.end(); });
  let c = await hc.checkHttpRedirect(ctx(root(), {}, { domain: 'localhost', connectHost: '127.0.0.1', httpPort: s.address().port }));
  assert.equal(c.result, 'pass', c.evidence);
  s.close();
  s = await mk((req, res) => { res.writeHead(200); res.end('hello'); });
  c = await hc.checkHttpRedirect(ctx(root(), {}, { domain: 'localhost', connectHost: '127.0.0.1', httpPort: s.address().port }));
  assert.equal(c.result, 'fail');
  const port = s.address().port; s.close();
  await new Promise((r) => setTimeout(r, 50));
  c = await hc.checkHttpRedirect(ctx(root(), {}, { domain: 'localhost', connectHost: '127.0.0.1', httpPort: port }));
  assert.equal(c.result, 'pass'); assert.match(c.evidence, /closed/);
});

// ---- the signed report ----
const seed = crypto.randomBytes(32);
function sampleDoc() {
  const checks = [{ id: 'host.tls', title: 'HTTPS', result: 'pass', rules: rules.cite(['hipaa-312e1']), evidence: 'TLSv1.3 <b>&', remediation: 'x' }, { id: 'host.firewall', title: 'Firewall', result: 'not-checked', rules: [], evidence: 'no ufw', remediation: 'y' }];
  const report = { format: cr.FORMAT, version: 1, report_id: 'compliance-2026-09-30T00-00-00-000Z', generated_at: '2026-09-30T00:00:00.000Z', host: { hostname: 'suds1', os: 'Ubuntu 24.04', suds_version: '1.17.1', node_version: 'v22.23.3', run_as: 'root' }, config: {}, risk_accepted: [], checks, summary: { counts: cr.counts(checks), overall: cr.overall(checks) }, scope: 's' };
  return { report, integrity: cr.seal(report, seed) };
}
test('the report is signed with the evidence signing key and verifies with the public key alone; any edit is caught', () => {
  const pem = signing.publicInfo(seed).public_key_pem;
  const doc = sampleDoc();
  assert.equal(cr.verifyDoc(doc, { publicKeyPem: pem }).ok, true);
  const edited = JSON.parse(JSON.stringify(doc)); edited.report.checks[1].result = 'pass';
  const v = cr.verifyDoc(edited, { publicKeyPem: pem });
  assert.equal(v.ok, false); assert.ok(v.errors.some((e) => /was edited/.test(e)));
  const other = signing.publicInfo(crypto.randomBytes(32)).public_key_pem;
  assert.equal(cr.verifyDoc(doc, { publicKeyPem: other }).ok, false, 'another server\'s key');
  const unsigned = { report: doc.report, integrity: cr.seal(doc.report, null) };
  assert.equal(cr.verifyDoc(unsigned, { publicKeyPem: pem }).ok, false, 'an unsigned report does not verify');
  assert.equal(cr.verifyDoc({ report: { format: 'something-else' }, integrity: {} }).ok, false);
});
test('the HTML report is self-contained and verifies; an edit to what it shows is caught', () => {
  const pem = signing.publicInfo(seed).public_key_pem;
  const doc = sampleDoc();
  const html = cr.renderHtml(doc);
  assert.ok(!/<script(?![^>]*type="application\/json")/.test(html), 'no executable script');
  assert.ok(!/(src|href)="https?:/.test(html) && !/@import|url\(/.test(html), 'no external assets');
  assert.ok(html.includes('TLSv1.3 &lt;b&gt;&amp;'), 'evidence is escaped');
  assert.equal(cr.verifyHtml(html, { publicKeyPem: pem }).ok, true);
  const shown = html.replace('<span class="badge b-not-checked">Could not check</span>', '<span class="badge b-pass">Pass</span>');
  assert.notEqual(shown, html);
  const v = cr.verifyHtml(shown, { publicKeyPem: pem });
  assert.equal(v.ok, false); assert.ok(v.errors.some((e) => /what it shows was edited/.test(e)));
  // The verifier script, as an auditor runs it.
  const f = path.join(tmp, 'r.html'); fs.writeFileSync(f, html);
  const k = path.join(tmp, 'k.pem'); fs.writeFileSync(k, pem);
  const ok = spawnSync(process.execPath, [path.join(REPO, 'scripts/verify-compliance-report.js'), f, '--public-key', k], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /VERIFIED/);
  fs.writeFileSync(f, shown);
  const bad = spawnSync(process.execPath, [path.join(REPO, 'scripts/verify-compliance-report.js'), f, '--public-key', k], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stdout, /NOT VERIFIED/);
});

// ---- the command, end to end ----
test('npm run compliance-check: exit 1 on any failed check, 0 when none failed, 2 with --strict when anything was not a pass', () => {
  const env = { ...process.env, SUDS_SIGNING_KEY: seed.toString('hex') };
  delete env.SUDS_ENV;
  const run = (args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(REPO, 'scripts/compliance-check.js'), ...args], { encoding: 'utf8', env, timeout: 60000 });
  const out = path.join(tmp, 'out');
  let r = run(['--no-app', '--no-host', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Result: INCOMPLETE/);
  const files = fs.readdirSync(out);
  assert.ok(files.some((f) => cr.FILE_RE.test(f)) && files.some((f) => f.endsWith('.html')));
  const doc = JSON.parse(fs.readFileSync(path.join(out, files.find((f) => cr.FILE_RE.test(f))), 'utf8'));
  assert.equal(cr.verifyDoc(doc, { publicKeyPem: signing.publicInfo(seed).public_key_pem }).ok, true, 'signed with the signing key');
  assert.ok(doc.report.checks.every((c) => c.result === 'not-checked'), 'nothing run, nothing passed');
  assert.equal(doc.report.checks.length, rules.HOST_CHECKS.length + rules.APP_CHECKS.filter((c) => !c.inAppOnly).length, 'every catalogue check is listed');
  r = run(['--no-app', '--no-host', '--no-write', '--strict']);
  assert.equal(r.status, 2);
  // A fake root whose data directory is missing: host.data_dir fails, so the run fails.
  const fr = root();
  r = run(['--no-app', '--no-write', '--root', fr, '--data-dir', '/var/lib/suds', '--offline']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /\[FAIL\s+\] host\.data_dir/);
});

test('docs/SELF-HOSTING.md: every "Implements" row names a check in the catalogue; every check id the guide names exists', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs/SELF-HOSTING.md'), 'utf8');
  const ids = new Set([...rules.HOST_CHECKS, ...rules.APP_CHECKS].map((c) => c.id));
  const rows = doc.split('\n').filter((l) => /^\|[^|]*\| Implements \|/.test(l));
  assert.ok(rows.length >= 5, 'the boundary tables have Implements rows');
  for (const row of rows) {
    const named = [...row.matchAll(/`((?:host|app)\.[a-z_]+)`/g)].map((m) => m[1]);
    assert.ok(named.some((id) => ids.has(id)), `an Implements row without a check id: ${row}`);
  }
  for (const m of doc.matchAll(/`((?:host|app)\.[a-z_]+)`/g)) if (m[1] !== 'app.other') assert.ok(ids.has(m[1]) || m[1] === 'host.report', `${m[1]} is in server/compliance-rules.js`);
  assert.ok(!/check[^.]*\bproves\b/i.test(doc.split('\n').slice(0, 5).join('\n')), 'the report records; it does not prove');
  assert.match(doc, /## Operator checklist/);
});
