'use strict';
// Host checks for scripts/compliance-check.js: what the operating system, the network and the service
// manager say about the machine SUDS Server runs on. Each check returns { id, result, evidence } with result
// pass / fail / warn / not-checked; "not-checked" (the tool is missing, or this user may not ask) is never
// turned into a pass. Evidence names what was observed: modes, owners, device types, ports, dates — never a
// key, a token or anything from the database.
//
// Everything the checks read goes through `ctx`, so the tests can give them a fake root filesystem
// (ctx.root, e.g. a fixture /proc and /etc) and a fake command runner (ctx.run) with canned lsblk,
// cryptsetup, ufw, firewall-cmd, timedatectl and systemctl output.
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const DAY = 86400_000;

/** The real command runner: { code, stdout, stderr, missing }. Never throws; a command not found is missing. */
function realRun(cmd, args = [], { timeoutMs = 15000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  if (r.error && r.error.code === 'ENOENT') return { code: 127, stdout: '', stderr: '', missing: true };
  if (r.error) return { code: 1, stdout: r.stdout || '', stderr: String(r.error.message), missing: false };
  return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', missing: false };
}

const at = (ctx, p) => path.join(ctx.root || '/', p);
function readText(ctx, p) { try { return fs.readFileSync(at(ctx, p), 'utf8'); } catch { return null; } }
function statOf(ctx, p) { try { return { st: fs.statSync(at(ctx, p)) }; } catch (e) { return { err: e.code || String(e.message) }; } }
function lstatOf(ctx, p) { try { return { st: fs.lstatSync(at(ctx, p)) }; } catch (e) { return { err: e.code || String(e.message) }; } }
function listDir(ctx, p) { try { return fs.readdirSync(at(ctx, p)); } catch { return null; } }
const octal = (m) => '0' + (m & 0o777).toString(8).padStart(3, '0');
const ok = (id, evidence) => ({ id, result: 'pass', evidence });
const fail = (id, evidence) => ({ id, result: 'fail', evidence });
const warn = (id, evidence) => ({ id, result: 'warn', evidence });
const nc = (id, evidence) => ({ id, result: 'not-checked', evidence });

/** /etc/passwd under the root: name → uid, uid → name. */
function users(ctx) {
  const byName = new Map(); const byUid = new Map();
  for (const line of (readText(ctx, '/etc/passwd') || '').split('\n')) {
    const f = line.split(':'); if (f.length < 3) continue;
    byName.set(f[0], Number(f[2])); byUid.set(Number(f[2]), f[0]);
  }
  return { byName, byUid };
}
const who = (ctx, uid) => { const n = users(ctx).byUid.get(uid); return n ? `${n}(${uid})` : `uid ${uid}`; };

/** key=value lines (os-release, node-pin, suds-server.conf), quotes removed, comments skipped. */
function parseKv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
}

/** 'debian' (Ubuntu), 'rhel' (RHEL/Rocky/Alma) or null, with the name and whether the release is supported. */
function osInfo(ctx) {
  const o = parseKv(readText(ctx, '/etc/os-release'));
  const id = (o.ID || '').toLowerCase(); const ver = o.VERSION_ID || '';
  const like = `${id} ${(o.ID_LIKE || '').toLowerCase()}`;
  const family = /ubuntu|debian/.test(like) ? 'debian' : /rhel|fedora|centos/.test(like) ? 'rhel' : null;
  const supported = (id === 'ubuntu' && ver === '24.04') || (['rhel', 'rocky', 'almalinux'].includes(id) && /^9(\.|$)/.test(ver));
  return { id, version: ver, pretty: o.PRETTY_NAME || (id ? `${id} ${ver}` : 'unknown'), family, supported, known: !!id };
}

function checkOs(ctx) {
  const o = osInfo(ctx);
  if (!o.known) return nc('host.os', 'no /etc/os-release');
  return o.supported ? ok('host.os', o.pretty) : warn('host.os', `${o.pretty}: not a release the installer supports (Ubuntu 24.04, RHEL/Rocky/Alma 9)`);
}

function checkDataDir(ctx) {
  const c = ctx.conf; const id = 'host.data_dir';
  const d = statOf(ctx, c.dataDir);
  if (d.err === 'ENOENT') return fail(id, `${c.dataDir} does not exist`);
  if (d.err) return nc(id, `${c.dataDir}: ${d.err}`);
  const problems = []; const seen = [];
  const svcUid = users(ctx).byName.get(c.serviceUser);
  const mode = d.st.mode & 0o777;
  seen.push(`${c.dataDir} ${octal(mode)} ${who(ctx, d.st.uid)}`);
  if (mode & 0o077) problems.push(`${c.dataDir} is ${octal(mode)} (want 0700)`);
  if (svcUid !== undefined && d.st.uid !== svcUid) problems.push(`${c.dataDir} is owned by ${who(ctx, d.st.uid)}, not ${c.serviceUser}`);
  if (svcUid === undefined) problems.push(`no ${c.serviceUser} user in /etc/passwd`);
  let dbSeen = false;
  for (const f of ['suds.db', 'suds.db-wal', 'suds.db-shm', 'keys.json', 'server.json']) {
    const s = lstatOf(ctx, path.join(c.dataDir, f));
    if (s.err === 'ENOENT') continue;
    if (s.err) { problems.push(`${f}: ${s.err}`); continue; }
    if (!s.st.isFile()) { problems.push(`${f} is not a regular file (${s.st.isSymbolicLink() ? 'a symbolic link' : 'type ' + (s.st.mode & 0o170000).toString(8)})`); continue; }
    if (f === 'suds.db') dbSeen = true;
    const m = s.st.mode & 0o777;
    seen.push(`${f} ${octal(m)}`);
    if (m & 0o077) problems.push(`${f} is ${octal(m)} (want 0600)`);
    if (svcUid !== undefined && s.st.uid !== svcUid) problems.push(`${f} is owned by ${who(ctx, s.st.uid)}, not ${c.serviceUser}`);
  }
  if (!dbSeen) problems.push('no suds.db yet (has SUDS started?)');
  return problems.length ? fail(id, `${problems.join('; ')} [observed: ${seen.join(', ')}]`) : ok(id, seen.join(', '));
}

function checkDiskEncryption(ctx) {
  const c = ctx.conf; const id = 'host.disk_encryption';
  const fm = ctx.run('findmnt', ['-n', '-o', 'SOURCE,FSTYPE', '--target', c.dataDir]);
  if (fm.missing) return nc(id, 'findmnt is not installed');
  if (fm.code !== 0 || !fm.stdout.trim()) return nc(id, `findmnt could not resolve ${c.dataDir}: ${fm.stderr.trim() || `exit ${fm.code}`}`);
  const [rawSource, fstype = ''] = fm.stdout.trim().split(/\s+/);
  const source = rawSource.replace(/\[.*\]$/, '');
  const accepted = (evidence) => (c.acceptUnencryptedDisk ? { ...warn(id, `${evidence}. RISK ACCEPTED by the operator at install (--accept-unencrypted-disk${c.acceptUnencryptedDisk !== '1' && c.acceptUnencryptedDisk !== 'yes' ? `: ${c.acceptUnencryptedDisk}` : ''})`), risk_accepted: true } : fail(id, evidence));
  if (!source.startsWith('/dev/')) return nc(id, `${c.dataDir} is on ${fstype || 'a'} filesystem from ${source}: encryption at rest belongs to that storage and cannot be seen from this host`);
  const ls = ctx.run('lsblk', ['-s', '-n', '-r', '-o', 'NAME,TYPE', source]);
  if (ls.missing) return nc(id, 'lsblk is not installed');
  if (ls.code !== 0) return nc(id, `lsblk ${source}: ${ls.stderr.trim() || `exit ${ls.code}`}`);
  const chain = ls.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)).filter((x) => x.length >= 2).map(([name, type]) => ({ name, type }));
  const crypt = chain.find((x) => x.type === 'crypt');
  const path_ = chain.map((x) => `${x.name}(${x.type})`).join(' <- ');
  if (!crypt) return accepted(`${c.dataDir} is on ${source} (${fstype}); device chain ${path_ || '?'} has no dm-crypt/LUKS layer`);
  const cs = ctx.run('cryptsetup', ['status', crypt.name]);
  let detail = '';
  if (!cs.missing && cs.code === 0) {
    const kv = Object.fromEntries(cs.stdout.split('\n').map((l) => /^\s*([a-z ]+):\s*(.+)$/.exec(l)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim()]));
    detail = `; cryptsetup: type ${kv.type || '?'}, cipher ${kv.cipher || '?'}, key ${kv.keysize || '?'}`;
    // cipher_null is dm-crypt with no encryption at all (LUKS allows it): a crypt layer that protects nothing.
    if (/(^|[^a-z])(cipher_null|null)([^a-z]|$)/i.test(kv.cipher || '')) return accepted(`${c.dataDir} is on dm-crypt ${crypt.name} with cipher ${kv.cipher}: no encryption at all${detail}`);
    if (kv.type && !/^LUKS/.test(kv.type)) return warn(id, `${c.dataDir} is on dm-crypt ${crypt.name} of type ${kv.type} (not LUKS: no key slots or header to manage)${detail}`);
  } else detail = cs.missing ? '; cryptsetup not installed' : '; cryptsetup status needs root (device type from lsblk)';
  return ok(id, `${c.dataDir} on ${source} (${fstype}); chain ${path_}${detail}`);
}

const SECRET_VARS = ['SUDS_ENCRYPTION_KEY', 'SUDS_INDEX_KEY', 'SUDS_BACKUP_KEY', 'SUDS_SIGNING_KEY', 'METRICS_TOKEN', 'OIDC_CLIENT_SECRET', 'MS_CLIENT_SECRET', 'ANTHROPIC_API_KEY'];
// NAME=value with a value (quoted or not); NAME= and NAME="" are not secrets. NAME_FILE=... never matches.
const SECRET_ASSIGN = new RegExp(`(?:^|[\\s"'])(${SECRET_VARS.join('|')})=(?:"[^"\\s]|'[^'\\s]|[^\\s"'])`);
/** The unit file and its drop-ins, as text, from the root. */
function unitTexts(ctx, unit) {
  const out = [];
  for (const dir of ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system']) {
    const t = readText(ctx, `${dir}/${unit}`);
    if (t !== null) { out.push({ file: `${dir}/${unit}`, text: t }); break; }
  }
  for (const f of (listDir(ctx, `/etc/systemd/system/${unit}.d`) || []).filter((x) => x.endsWith('.conf')).sort()) out.push({ file: `/etc/systemd/system/${unit}.d/${f}`, text: readText(ctx, `/etc/systemd/system/${unit}.d/${f}`) || '' });
  return out;
}

function checkKeys(ctx) {
  const c = ctx.conf; const id = 'host.keys';
  const problems = []; const seen = []; let unknown = null;
  const rootUid = ctx.rootUid ?? 0; // root; the tests run as an ordinary user
  const dir = statOf(ctx, c.credentialsDir);
  if (dir.err === 'EACCES') unknown = `${c.credentialsDir} is not readable by this user (run the check as root)`;
  else if (dir.err) problems.push(`${c.credentialsDir}: ${dir.err === 'ENOENT' ? 'does not exist' : dir.err}`);
  else {
    const m = dir.st.mode & 0o777;
    seen.push(`${c.credentialsDir} ${octal(m)} ${who(ctx, dir.st.uid)}`);
    if (m & 0o077) problems.push(`${c.credentialsDir} is ${octal(m)} (want 0700)`);
    if (dir.st.uid !== rootUid) problems.push(`${c.credentialsDir} is owned by ${who(ctx, dir.st.uid)}, not root`);
    for (const name of c.credentials) {
      const s = statOf(ctx, path.join(c.credentialsDir, name));
      if (s.err === 'EACCES') { unknown = `${name} is not readable by this user`; continue; }
      if (s.err) { problems.push(`${name}: ${s.err === 'ENOENT' ? 'missing' : s.err}`); continue; }
      const fm = s.st.mode & 0o777;
      seen.push(`${name} ${octal(fm)}`);
      if (fm & 0o077) problems.push(`${name} is ${octal(fm)} (want 0600 or 0400)`);
      if (s.st.uid !== rootUid) problems.push(`${name} is owned by ${who(ctx, s.st.uid)}, not root`);
      const v = readText(ctx, path.join(c.credentialsDir, name));
      if (v !== null && /_key$/.test(name) && !/^[0-9a-fA-F]{64}$/.test(v.trim())) problems.push(`${name} is not 64 hex characters`);
    }
  }
  // Keys in the service's environment: the unit's Environment= lines and every EnvironmentFile= it names.
  const units = unitTexts(ctx, c.unit);
  if (!units.length) problems.push(`no ${c.unit} unit file`);
  let loadCred = 0;
  for (const u of units) {
    for (const line of u.text.split('\n')) {
      const l = line.trim();
      if (/^LoadCredential(Encrypted)?=/.test(l)) loadCred++;
      if (/^Environment=/.test(l) && SECRET_ASSIGN.test(l.slice(12))) problems.push(`${u.file}: a secret is set with Environment= (${SECRET_ASSIGN.exec(l.slice(12))[1]})`);
      const ef = /^EnvironmentFile=-?(.+)$/.exec(l);
      if (ef) {
        const f = ef[1].trim(); const t = readText(ctx, f);
        if (t === null) { if (statOf(ctx, f).err === 'EACCES') unknown = unknown || `${f} is not readable by this user`; continue; }
        const hit = t.split('\n').map((x) => SECRET_ASSIGN.exec(' ' + x.trim().replace(/^export\s+/, ''))).find(Boolean);
        if (hit) problems.push(`${f} (EnvironmentFile of ${c.unit}) holds ${hit[1]}: it reaches the process environment`);
      }
    }
  }
  if (units.length && !loadCred) problems.push(`${c.unit} has no LoadCredential= lines (keys are not loaded as credentials)`);
  // The running process's environment, when this user may read it.
  const pid = ctx.run('systemctl', ['show', '-p', 'MainPID', '--value', c.unit]);
  if (!pid.missing && pid.code === 0 && /^\d+$/.test(pid.stdout.trim()) && pid.stdout.trim() !== '0') {
    const env = (() => { try { return fs.readFileSync(at(ctx, `/proc/${pid.stdout.trim()}/environ`), 'utf8'); } catch { return null; } })();
    if (env !== null) {
      const hit = env.split('\0').map((x) => SECRET_ASSIGN.exec(' ' + x)).find(Boolean);
      if (hit) problems.push(`the running SUDS process has ${hit[1]} in its environment`);
      else seen.push('no secret in the running process environment');
    }
  }
  // keys.json beside the data it protects (a wizard install), when the credential store is in use.
  const kj = statOf(ctx, path.join(c.dataDir, 'keys.json'));
  const kjNote = !kj.err ? `${path.join(c.dataDir, 'keys.json')} also holds keys, on the same disk as the database` : '';
  if (problems.length) return fail(id, `${problems.join('; ')}${kjNote ? `; ${kjNote}` : ''}${seen.length ? ` [observed: ${seen.join(', ')}]` : ''}`);
  if (unknown) return nc(id, `${unknown}${seen.length ? ` [observed: ${seen.join(', ')}]` : ''}`);
  if (kjNote) return warn(id, `${kjNote}; ${seen.join(', ')}`);
  return ok(id, `${seen.join(', ')}; ${loadCred} LoadCredential= line${loadCred === 1 ? '' : 's'}; no secret in Environment= or environment files`);
}

// The effective sandboxing of the running unit (drop-ins included), as systemd reports it.
const SERVICE_EXPECT = {
  User: (v, c) => v === c.serviceUser, NoNewPrivileges: 'yes', ProtectSystem: 'strict', ProtectHome: 'yes', PrivateTmp: 'yes', PrivateDevices: 'yes',
  ProtectKernelTunables: 'yes', ProtectKernelModules: 'yes', ProtectControlGroups: 'yes', RestrictSUIDSGID: 'yes', LockPersonality: 'yes', RestrictRealtime: 'yes',
  UMask: '0077', CapabilityBoundingSet: (v) => v === '' || v === '0', AmbientCapabilities: (v) => v === '' || v === '0',
};
function checkService(ctx) {
  const c = ctx.conf; const id = 'host.service';
  const r = ctx.run('systemctl', ['show', c.unit, ...Object.keys(SERVICE_EXPECT).map((k) => `-p${k}`), '-pActiveState', '-pUnitFileState', '-pLoadState']);
  if (r.missing) return nc(id, 'systemctl is not available');
  if (r.code !== 0) return nc(id, `systemctl show ${c.unit}: ${r.stderr.trim() || `exit ${r.code}`}`);
  const p = parseKv(r.stdout);
  if (p.LoadState === 'not-found') return fail(id, `${c.unit} is not installed`);
  const bad = [];
  for (const [k, want] of Object.entries(SERVICE_EXPECT)) {
    const v = p[k] === undefined ? '' : p[k];
    const good = typeof want === 'function' ? want(v, c) : v === want;
    if (!good) bad.push(`${k}=${v || '(empty)'}`);
  }
  if (p.ActiveState !== 'active') bad.push(`not running (${p.ActiveState || '?'})`);
  if (p.UnitFileState && p.UnitFileState !== 'enabled') bad.push(`not enabled at boot (${p.UnitFileState})`);
  return bad.length ? fail(id, `${c.unit}: ${bad.join(', ')}`) : ok(id, `${c.unit} active, enabled; ${Object.keys(SERVICE_EXPECT).length} sandboxing settings as shipped`);
}

// ---- network ----
/** LISTEN sockets from /proc/net/tcp and tcp6 under the root: [{ address, port }]. */
function listeners(ctx) {
  const out = []; let read = false;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const t = readText(ctx, f); if (t === null) continue; read = true;
    for (const line of t.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/); if (cols.length < 4 || cols[3] !== '0A') continue;
      const [hexAddr, hexPort] = cols[1].split(':');
      out.push({ address: hexToIp(hexAddr), port: parseInt(hexPort, 16) });
    }
  }
  return read ? out : null;
}
function hexToIp(h) {
  if (h.length === 8) return [3, 2, 1, 0].map((i) => parseInt(h.substr(i * 2, 2), 16)).join('.');
  // IPv6: four 32-bit words, each little-endian.
  const words = []; for (let w = 0; w < 4; w++) { const s = h.substr(w * 8, 8); words.push(s.substr(6, 2) + s.substr(4, 2) + s.substr(2, 2) + s.substr(0, 2)); }
  const groups = words.join('').match(/.{4}/g).map((g) => parseInt(g, 16).toString(16));
  const full = groups.join(':');
  if (full === '0:0:0:0:0:0:0:1') return '::1';
  if (full === '0:0:0:0:0:0:0:0') return '::';
  if (/^0:0:0:0:0:ffff:/.test(full)) { const v = words[3]; return `::ffff:${[0, 1, 2, 3].map((i) => parseInt(v.substr(i * 2, 2), 16)).join('.')}`; }
  return full;
}
const isLoopback = (a) => a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a);

function checkBind(ctx) {
  const c = ctx.conf; const id = 'host.bind';
  const l = listeners(ctx);
  if (!l) return nc(id, '/proc/net/tcp is not readable');
  const app = l.filter((x) => x.port === c.appPort);
  if (!app.length) return nc(id, `nothing is listening on port ${c.appPort} (is SUDS running?)`);
  const pub = app.filter((x) => !isLoopback(x.address));
  const ev = `port ${c.appPort} on ${[...new Set(app.map((x) => x.address))].join(', ')}`;
  return pub.length ? fail(id, `${ev}: reachable beyond this machine (HOST should be 127.0.0.1)`) : ok(id, ev);
}

function parseUfw(text) {
  const status = (/^Status:\s*(\w+)/m.exec(text) || [])[1] || null;
  const def = (/^Default:\s*(.+)$/m.exec(text) || [])[1] || '';
  const rules = [];
  let inRules = false;
  for (const line of text.split('\n')) {
    if (/^--/.test(line)) { inRules = true; continue; }
    if (!inRules || !line.trim()) continue;
    const m = /^(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?: (IN|OUT|FWD))?\s{2,}(.+?)\s*$/.exec(line);
    if (!m) continue;
    const to = m[1].replace(/\s*\(v6\)$/, '').trim(); const from = m[4].replace(/\s+#.*$/, '').replace(/\s*\(v6\)$/, '').trim();
    rules.push({ to, action: m[2], dir: m[3] || 'IN', from, v6: /\(v6\)/.test(m[1]) });
  }
  return { status, defaultIncoming: (/(\w+) \(incoming\)/.exec(def) || [])[1] || null, rules };
}
function parseFirewalld(text) {
  const kv = {}; const rich = [];
  let inRich = false;
  for (const line of text.split('\n')) {
    const m = /^\s+([a-z -]+):\s*(.*)$/.exec(line);
    if (m) { inRich = m[1] === 'rich rules'; kv[m[1]] = m[2].trim(); continue; }
    if (inRich && line.trim()) rich.push(line.trim());
  }
  return { zone: (/^(\S+)/.exec(text) || [])[1] || null, target: kv.target || 'default', services: (kv.services || '').split(/\s+/).filter(Boolean), ports: (kv.ports || '').split(/\s+/).filter(Boolean), sources: (kv.sources || '').split(/\s+/).filter(Boolean), rich };
}
const portOf = (to) => { const m = /^(\d+)(?:\/(tcp|udp))?$/.exec(to); if (m) return Number(m[1]); return { OpenSSH: 22, ssh: 22, https: 443, http: 80, 'Caddy': 443 }[to] ?? to; };

function checkFirewall(ctx) {
  const c = ctx.conf; const id = 'host.firewall';
  const family = osInfo(ctx).family;
  const expected = new Set([443, ...(c.tlsMode === 'caddy' ? [80] : [])]);
  const tryUfw = () => {
    const r = ctx.run('ufw', ['status', 'verbose']);
    if (r.missing) return null;
    if (r.code !== 0 || !/^Status:/m.test(r.stdout)) return nc(id, `ufw status: ${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`} (run the check as root)`);
    const u = parseUfw(r.stdout);
    if (u.status !== 'active') return fail(id, `ufw is ${u.status || 'not active'}`);
    const bad = [];
    if (!/^(deny|reject)$/.test(u.defaultIncoming || '')) bad.push(`default incoming policy is ${u.defaultIncoming || 'unknown'}, not deny`);
    const allowed = [];
    for (const rl of u.rules.filter((x) => x.dir === 'IN' && /ALLOW|LIMIT/.test(x.action))) {
      const port = portOf(rl.to.split(' ')[0]);
      allowed.push(`${rl.to} from ${rl.from}`);
      const anywhere = /^Anywhere/.test(rl.from);
      if (port === 22) { if (anywhere) bad.push(`SSH (${rl.to}) is open to anywhere`); else if (c.adminCidr && rl.from !== c.adminCidr) bad.push(`SSH allowed from ${rl.from}, not the administration network ${c.adminCidr}`); continue; }
      if (!expected.has(port)) bad.push(`unexpected port ${rl.to} allowed from ${rl.from}`);
    }
    for (const p of expected) if (!u.rules.some((x) => portOf(x.to.split(' ')[0]) === p && /ALLOW/.test(x.action))) bad.push(`port ${p} is not allowed (SUDS unreachable)`);
    return bad.length ? fail(id, `ufw: ${bad.join('; ')}`) : ok(id, `ufw active, default deny incoming; allowed: ${[...new Set(allowed)].join(', ') || 'nothing'}`);
  };
  const tryFirewalld = () => {
    const st = ctx.run('firewall-cmd', ['--state']);
    if (st.missing) return null;
    if (st.code !== 0 || st.stdout.trim() !== 'running') return /not running/.test(st.stdout + st.stderr) || st.code === 252 ? fail(id, 'firewalld is not running') : nc(id, `firewall-cmd --state: ${(st.stderr || st.stdout).trim() || `exit ${st.code}`}`);
    const la = ctx.run('firewall-cmd', ['--list-all']);
    if (la.code !== 0) return nc(id, `firewall-cmd --list-all: ${la.stderr.trim() || `exit ${la.code}`} (run the check as root)`);
    const z = parseFirewalld(la.stdout);
    const bad = [];
    if (/^ACCEPT$/i.test(z.target)) bad.push(`zone ${z.zone} accepts everything (target ACCEPT)`);
    const svcPort = { https: 443, http: 80, ssh: 22 };
    for (const s of z.services) {
      if (s === 'dhcpv6-client') continue;
      if (s === 'ssh') { bad.push('ssh is open to anywhere (use a rich rule limited to the administration network)'); continue; }
      if (!expected.has(svcPort[s])) bad.push(`unexpected service ${s}`);
    }
    for (const p of z.ports) if (!expected.has(portOf(p))) bad.push(`unexpected port ${p}`);
    for (const rr of z.rich) {
      if (!/\baccept\b/.test(rr)) continue;
      const src = (/source address="([^"]+)"/.exec(rr) || [])[1];
      const svc = (/service name="([^"]+)"/.exec(rr) || [])[1]; const port = (/port port="(\d+)"/.exec(rr) || [])[1];
      const p = svc ? svcPort[svc] : Number(port);
      if (p === 22) { if (!src) bad.push('an SSH rich rule has no source restriction'); else if (c.adminCidr && src !== c.adminCidr) bad.push(`SSH allowed from ${src}, not the administration network ${c.adminCidr}`); continue; }
      if (!expected.has(p)) bad.push(`rich rule allows ${svc || port || 'something'} from ${src || 'anywhere'}`);
    }
    for (const p of expected) if (!z.services.some((s) => svcPort[s] === p) && !z.ports.some((x) => portOf(x) === p)) bad.push(`port ${p} is not allowed (SUDS unreachable)`);
    return bad.length ? fail(id, `firewalld zone ${z.zone}: ${bad.join('; ')}`) : ok(id, `firewalld running, zone ${z.zone}: services ${z.services.join(' ') || '-'}, ports ${z.ports.join(' ') || '-'}, ${z.rich.length} rich rule${z.rich.length === 1 ? '' : 's'}`);
  };
  const order = family === 'rhel' ? [tryFirewalld, tryUfw] : [tryUfw, tryFirewalld];
  for (const f of order) { const r = f(); if (r) return r; }
  return nc(id, 'neither ufw nor firewalld is installed; if another firewall (nftables, a cloud security group) protects this host, record it as evidence by hand');
}

// ---- TLS ----
function tlsConnect({ host, port, servername, ca, minVersion, maxVersion, ciphers, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let sock;
    try {
      sock = tls.connect({ host, port, servername: servername && !/^[\d.:]+$/.test(servername) ? servername : undefined, rejectUnauthorized: false, ca, minVersion, maxVersion, ciphers, ALPNProtocols: ['http/1.1'] }, () => finish({ ok: true, socket: sock }));
    } catch (e) { finish({ ok: false, code: e.code || 'ERR', message: e.message }); return; }
    sock.setTimeout(timeoutMs, () => { sock.destroy(); finish({ ok: false, code: 'ETIMEDOUT', message: 'timed out' }); });
    sock.on('error', (e) => finish({ ok: false, code: e.code || 'ERR', message: e.message }));
  });
}
function headRequest(sock, hostHeader, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let buf = ''; let done = false; const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) finish(buf.split('\r\n\r\n')[0]); });
    sock.on('end', () => finish(buf.includes('\r\n') ? buf.split('\r\n\r\n')[0] : null));
    sock.on('error', () => finish(null));
    sock.write(`GET / HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: suds-compliance-check\r\nConnection: close\r\n\r\n`);
  });
}
function headerOf(head, name) { const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head || ''); return m ? m[1].trim() : null; }

async function checkTls(ctx) {
  const c = ctx.conf; const id = 'host.tls';
  if (!c.domain) return nc(id, 'no domain configured (--domain, or SUDS_DOMAIN in /etc/suds/suds-server.conf)');
  const host = c.connectHost || c.domain; const port = c.tlsPort;
  const ca = c.caFile ? (() => { try { return [fs.readFileSync(c.caFile), ...tls.rootCertificates]; } catch { return undefined; } })() : undefined;
  const target = `${c.domain}:${port}${host !== c.domain ? ` (via ${host})` : ''}`;
  const modern = await tlsConnect({ host, port, servername: c.domain, ca, minVersion: 'TLSv1.2' });
  if (!modern.ok) return fail(id, `${target}: no TLS 1.2+ handshake (${modern.code}: ${modern.message})`);
  const sock = modern.socket;
  const protocol = sock.getProtocol();
  const x = sock.getPeerX509Certificate ? sock.getPeerX509Certificate() : null;
  const authorized = sock.authorized; const authErr = sock.authorizationError;
  let idErr = null;
  try { idErr = !x ? null : /^[\d.]+$/.test(c.domain) ? (x.checkIP(c.domain) ? null : 'ip') : (x.checkHost(c.domain) ? null : 'name'); } catch (e) { idErr = e; }
  const head = await headRequest(sock, c.domain);
  const problems = []; const warnings = []; const seen = [`${target} negotiated ${protocol}`];
  if (x) {
    const to = Date.parse(x.validTo); const from = Date.parse(x.validFrom);
    const daysLeft = Math.floor((to - ctx.now) / DAY);
    seen.push(`certificate valid ${new Date(from).toISOString().slice(0, 10)} to ${new Date(to).toISOString().slice(0, 10)} (${daysLeft} days left), issuer ${String(x.issuer).split('\n').filter((l) => /^(CN|O)=/.test(l)).join(', ')}`);
    if (to <= ctx.now) problems.push('the certificate has expired');
    else if (daysLeft < 14) problems.push(`the certificate expires in ${daysLeft} days (less than 14)`);
    if (from > ctx.now) problems.push('the certificate is not valid yet');
  } else problems.push('no certificate presented');
  if (idErr) problems.push(`the certificate does not name ${c.domain}`);
  if (!authorized) warnings.push(`the certificate is not trusted by this host's CA store (${authErr}); pass --ca <county CA file> if it is issued by a private CA`);
  if (!['TLSv1.2', 'TLSv1.3'].includes(protocol)) problems.push(`negotiated ${protocol}`);
  const hsts = headerOf(head, 'strict-transport-security');
  if (head === null) warnings.push('no HTTP response over TLS, so HSTS could not be read');
  else if (!hsts) problems.push('no Strict-Transport-Security header');
  else {
    const age = Number((/max-age=(\d+)/i.exec(hsts) || [])[1] || 0);
    seen.push(`HSTS max-age=${age}${/includesubdomains/i.test(hsts) ? '; includeSubDomains' : ''}`);
    if (age < 31536000) warnings.push(`HSTS max-age ${age} is under a year`);
  }
  // An old protocol must be refused by the server. The client has to be allowed to offer it first (OpenSSL 3
  // refuses TLS 1.0/1.1 at its default security level), or a refusal would prove nothing.
  const old = await tlsConnect({ host, port, servername: c.domain, minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' });
  if (old.ok) { problems.push(`accepts ${old.socket.getProtocol()}`); old.socket.destroy(); }
  else if (/NO_PROTOCOLS_AVAILABLE|NO_CIPHERS_AVAILABLE|UNSUPPORTED_PROTOCOL.*client/i.test(`${old.code} ${old.message}`) && !/alert|wrong version|reset|ECONNRESET/i.test(old.message)) warnings.push(`this host's OpenSSL cannot offer TLS 1.1, so its refusal was not tested (${old.code})`);
  else seen.push(`TLS 1.0/1.1 refused (${old.code})`);
  if (problems.length) return fail(id, `${problems.join('; ')} [${seen.join('; ')}]`);
  if (warnings.length) return warn(id, `${warnings.join('; ')} [${seen.join('; ')}]`);
  return ok(id, seen.join('; '));
}

function checkHttpRedirect(ctx) {
  const c = ctx.conf; const id = 'host.http_redirect';
  if (!c.domain) return Promise.resolve(nc(id, 'no domain configured'));
  return new Promise((resolve) => {
    const req = http.request({ host: c.connectHost || c.domain, port: c.httpPort, path: '/', method: 'GET', headers: { Host: c.domain, 'User-Agent': 'suds-compliance-check' }, timeout: 8000 }, (res) => {
      const loc = res.headers.location || ''; res.resume();
      if ([301, 302, 307, 308].includes(res.statusCode) && /^https:\/\//i.test(loc)) resolve(ok(id, `http://${c.domain}:${c.httpPort}/ answers ${res.statusCode} to ${loc}`));
      else resolve(fail(id, `http://${c.domain}:${c.httpPort}/ answers ${res.statusCode}${loc ? ` to ${loc}` : ''}, not a redirect to https`));
    });
    req.on('timeout', () => { req.destroy(); resolve(nc(id, `http://${c.domain}:${c.httpPort}/ did not answer within 8 s`)); });
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? ok(id, `port ${c.httpPort} is closed: nothing is served over plain HTTP`) : nc(id, `http://${c.domain}:${c.httpPort}/: ${e.code || e.message}`)));
    req.end();
  });
}

// ---- time, updates, logs ----
function parseOffsetSeconds(s) {
  const m = /([+-]?\d+(?:\.\d+)?)\s*(us|µs|ms|s|min)\b/.exec(s || ''); if (!m) return null;
  return Number(m[1]) * ({ us: 1e-6, 'µs': 1e-6, ms: 1e-3, s: 1, min: 60 }[m[2]]);
}
function checkTimeSync(ctx) {
  const id = 'host.time_sync';
  const t = ctx.run('timedatectl', ['show']);
  if (t.missing) return nc(id, 'timedatectl is not available');
  if (t.code !== 0) return nc(id, `timedatectl show: ${t.stderr.trim() || `exit ${t.code}`}`);
  const p = parseKv(t.stdout);
  const seen = [`NTP=${p.NTP || '?'}`, `NTPSynchronized=${p.NTPSynchronized || '?'}`];
  let offset = null;
  const ch = ctx.run('chronyc', ['tracking']);
  if (!ch.missing && ch.code === 0) {
    const m = /System time\s*:\s*([\d.]+) seconds (fast|slow)/.exec(ch.stdout);
    if (m) { offset = Number(m[1]) * (m[2] === 'slow' ? -1 : 1); seen.push(`chrony offset ${offset.toFixed(6)} s`); }
  }
  if (offset === null) {
    const ts = ctx.run('timedatectl', ['timesync-status']);
    if (!ts.missing && ts.code === 0) { const m = /Offset:\s*(.+)$/m.exec(ts.stdout); if (m) { offset = parseOffsetSeconds(m[1]); if (offset !== null) seen.push(`timesyncd offset ${m[1].trim()}`); } }
  }
  if (p.NTPSynchronized !== 'yes') return fail(id, `the clock is not synchronised (${seen.join(', ')}); audit timestamps depend on it`);
  if (offset !== null && Math.abs(offset) >= 1) return fail(id, `clock offset ${offset.toFixed(3)} s (limit 1 s) [${seen.join(', ')}]`);
  if (offset === null) return warn(id, `synchronised, but the offset could not be read (no chronyc tracking or timedatectl timesync-status) [${seen.join(', ')}]`);
  return ok(id, seen.join(', '));
}

function checkSecurityUpdates(ctx) {
  const id = 'host.security_updates';
  const o = osInfo(ctx);
  const enabled = (unit) => { const r = ctx.run('systemctl', ['is-enabled', unit]); return r.missing ? null : r.stdout.trim() === 'enabled'; };
  if (o.family === 'debian') {
    const periodic = readText(ctx, '/etc/apt/apt.conf.d/20auto-upgrades') || '';
    const uu = readText(ctx, '/etc/apt/apt.conf.d/50unattended-upgrades') || '';
    const on = /APT::Periodic::Unattended-Upgrade\s+"1"/.test(periodic);
    const live = uu.split('\n').filter((l) => !/^\s*\/\//.test(l));
    const security = live.some((l) => /-security/.test(l));
    const other = live.some((l) => /\$\{distro_codename\}-(updates|proposed|backports)"/.test(l));
    const timer = enabled('apt-daily-upgrade.timer');
    const bad = [];
    if (!on) bad.push('APT::Periodic::Unattended-Upgrade is not "1" (20auto-upgrades)');
    if (!security) bad.push('the -security origin is not allowed in 50unattended-upgrades');
    if (timer === false) bad.push('apt-daily-upgrade.timer is not enabled');
    if (bad.length) return fail(id, `unattended-upgrades: ${bad.join('; ')}`);
    if (timer === null) return nc(id, 'unattended-upgrades configured, but systemctl is not available to confirm the timer');
    return other ? warn(id, 'unattended-upgrades on with the -security origin, but also non-security origins (a feature update can arrive unannounced)') : ok(id, 'unattended-upgrades on, -security origin only, apt-daily-upgrade.timer enabled');
  }
  if (o.family === 'rhel') {
    const conf = parseIni(readText(ctx, '/etc/dnf/automatic.conf') || '');
    const cmds = conf.commands || {};
    const t = enabled('dnf-automatic.timer'); const ti = enabled('dnf-automatic-install.timer');
    const bad = [];
    if (cmds.upgrade_type !== 'security') bad.push(`upgrade_type is ${cmds.upgrade_type || 'unset'}, not security`);
    if (!/^(yes|true|1)$/i.test(cmds.apply_updates || '') && ti !== true) bad.push('updates are downloaded but not applied (apply_updates = no)');
    if (t === false && ti === false) bad.push('neither dnf-automatic.timer nor dnf-automatic-install.timer is enabled');
    if (bad.length) return fail(id, `dnf-automatic: ${bad.join('; ')}`);
    if (t === null && ti === null) return nc(id, 'dnf-automatic configured, but systemctl is not available to confirm the timer');
    return ok(id, `dnf-automatic: upgrade_type = security, applied, ${ti ? 'dnf-automatic-install' : 'dnf-automatic'}.timer enabled`);
  }
  return nc(id, `unknown distribution (${o.pretty}): check automatic security updates by hand`);
}
function parseIni(text) {
  const out = {}; let sec = '';
  for (const line of text.split('\n')) {
    const s = /^\s*\[([^\]]+)\]/.exec(line); if (s) { sec = s[1].trim(); out[sec] = out[sec] || {}; continue; }
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !/^\s*[#;]/.test(line)) { out[sec] = out[sec] || {}; out[sec][m[1]] = m[2]; }
  }
  return out;
}
/** A systemd time span ("400d", "1y", "13month", "2w 3d", "infinity", plain seconds) in days, or null. */
function timespanDays(v) {
  if (v === undefined || v === null || v === '') return null;
  if (/^infinity$/i.test(v)) return Infinity;
  if (/^\d+$/.test(v)) return Number(v) / 86400;
  const unit = { us: 1e-6 / 86400, ms: 1e-3 / 86400, s: 1 / 86400, sec: 1 / 86400, m: 1 / 1440, min: 1 / 1440, h: 1 / 24, hr: 1 / 24, d: 1, day: 1, days: 1, w: 7, week: 7, weeks: 7, M: 30.44, month: 30.44, months: 30.44, y: 365.25, year: 365.25, years: 365.25 };
  let total = 0; let any = false;
  for (const m of String(v).matchAll(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g)) { const u = unit[m[2]] ?? unit[m[2].toLowerCase()]; if (u === undefined) return null; total += Number(m[1]) * u; any = true; }
  return any ? total : null;
}
function checkJournald(ctx) {
  const c = ctx.conf; const id = 'host.journald';
  const files = ['/etc/systemd/journald.conf', ...(listDir(ctx, '/etc/systemd/journald.conf.d') || []).filter((f) => f.endsWith('.conf')).sort().map((f) => `/etc/systemd/journald.conf.d/${f}`)];
  const eff = {}; let any = false;
  for (const f of files) { const t = readText(ctx, f); if (t === null) continue; any = true; Object.assign(eff, parseIni(t).Journal || {}); }
  if (!any) return nc(id, 'no journald configuration readable');
  const storage = eff.Storage || 'auto';
  const persistent = storage === 'persistent' || (storage === 'auto' && statOf(ctx, '/var/log/journal').st);
  const ret = timespanDays(eff.MaxRetentionSec);
  // The oldest entry actually in the journal: the evidence of how far back the logs really go (a size cap,
  // SystemMaxUse, can delete entries long before MaxRetentionSec would). Only its timestamp is read.
  const first = ctx.run('sh', ['-c', 'journalctl -q --no-pager -o short-unix 2>/dev/null | head -n 1']);
  const m = !first.missing && first.code === 0 ? /^\s*(\d{9,})(?:\.\d+)?\s/.exec(first.stdout || '') : null;
  const oldest = m ? Number(m[1]) * 1000 : null;
  const oldestDays = oldest !== null ? (ctx.now - oldest) / DAY : null;
  const installed = Date.parse(c.installedAt || '');
  const installedDays = Number.isFinite(installed) ? (ctx.now - installed) / DAY : null;
  const ev = `Storage=${storage}; MaxRetentionSec=${eff.MaxRetentionSec || '(unset)'}; SystemMaxUse=${eff.SystemMaxUse || '(default)'}; ${oldest !== null ? `oldest entry ${new Date(oldest).toISOString().slice(0, 10)} (${Math.floor(oldestDays)} days ago)` : 'oldest entry could not be read'}`;
  if (!persistent) return fail(id, `the journal is not persistent (${ev}): logs are lost at reboot`);
  if (ret === null) return warn(id, `persistent, but no time-based retention: the size cap decides how long logs stay (${ev}); policy ${c.logRetentionDays} days`);
  if (ret < c.logRetentionDays) return fail(id, `logs kept ${Math.floor(ret)} days, under the ${c.logRetentionDays}-day policy (${ev})`);
  if (oldestDays !== null && installedDays !== null && installedDays > c.logRetentionDays && oldestDays < c.logRetentionDays - 1) {
    return warn(id, `the journal reaches back only ${Math.floor(oldestDays)} days although this server was installed ${Math.floor(installedDays)} days ago: entries are being removed before the ${c.logRetentionDays}-day target (raise SystemMaxUse, install.sh --journal-max-use, or forward the journal to the SIEM) (${ev})`);
  }
  return ok(id, `${ev}; policy ${c.logRetentionDays} days`);
}
function checkAuditd(ctx) {
  const id = 'host.auditd';
  const r = ctx.run('systemctl', ['is-active', 'auditd']);
  if (r.missing) return nc(id, 'systemctl is not available');
  return r.stdout.trim() === 'active' ? ok(id, 'auditd active') : warn(id, `auditd is ${r.stdout.trim() || 'not installed'} (recommended, not required)`);
}

// ---- software versions ----
function nodePin(codeDir) { return parseKv((() => { try { return fs.readFileSync(path.join(codeDir, 'deploy', 'linux', 'pins'), 'utf8'); } catch { return ''; } })()); }
function checkNode(ctx) {
  const c = ctx.conf; const id = 'host.node';
  const pin = nodePin(c.codeDir);
  if (!pin.NODE_VERSION) return nc(id, 'deploy/linux/pins is missing from the installed code');
  const r = ctx.run(c.nodeBin, ['--version']);
  if (r.missing) return fail(id, `${c.nodeBin} is not installed (pinned ${pin.NODE_VERSION})`);
  const v = r.stdout.trim();
  return v === pin.NODE_VERSION ? ok(id, `${c.nodeBin} is ${v}, the pinned release`) : fail(id, `${c.nodeBin} is ${v || '?'}, not the pinned ${pin.NODE_VERSION}`);
}
function cmpVer(a, b) { const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; }
/** docs/RELEASE.md "Supported versions": the latest minor gets every fix; the previous one security fixes for 30 days; older nothing. */
function supportOf(installed, latest) {
  const [ia, ib] = installed.split('.').map(Number); const [la, lb] = latest.split('.').map(Number);
  if (cmpVer(installed, latest) >= 0) return 'current';
  if (ia === la && ib === lb) return 'patch-behind';
  if (ia === la && ib === lb - 1) return 'previous-minor';
  return 'unsupported';
}
function checkSudsVersion(ctx) {
  const c = ctx.conf; const id = 'host.suds_version';
  const installed = c.sudsVersion;
  const released = (() => { try { const m = new RegExp(`^## ${installed.replace(/\./g, '\\.')} — (\\d{4}-\\d{2}-\\d{2})`, 'm').exec(fs.readFileSync(path.join(c.codeDir, 'CHANGELOG.md'), 'utf8')); return m ? m[1] : null; } catch { return null; } })();
  const rel = released ? `, released ${released}` : '';
  if (!c.latestVersion) return nc(id, `SUDS ${installed}${rel}; no release feed to compare with (set UPDATE_FEED_URL, or pass --latest-version)${c.latestError ? `: ${c.latestError}` : ''}`);
  const s = supportOf(installed, c.latestVersion);
  const ev = `SUDS ${installed}${rel}; latest ${c.latestVersion}`;
  if (s === 'current') return ok(id, `${ev}: current`);
  if (s === 'patch-behind') return warn(id, `${ev}: a patch release is waiting (fixes on the supported line)`);
  if (s === 'previous-minor') return warn(id, `${ev}: the previous minor gets security fixes only, for 30 days after the next minor's release`);
  return fail(id, `${ev}: no longer supported (docs/RELEASE.md, "Supported versions")`);
}

/** How the installed release's zip was checked (install.sh / upgrade.sh record it in suds-server.conf). */
function checkReleaseIntegrity(ctx) {
  const c = ctx.conf; const id = 'host.release_integrity';
  const src = c.releaseChecksumSource;
  if (!src) return nc(id, 'no SUDS_RELEASE_CHECKSUM_SOURCE in suds-server.conf (not installed or upgraded by deploy/linux/install.sh or upgrade.sh of this version)');
  if (src === 'operator') return ok(id, 'the release zip was checked against a SHA-256 the operator supplied (--release-sha256), from a channel independent of the download');
  if (src === 'local-tree') return ok(id, 'installed from the unpacked release the installer ran from; the operator checked its zip before unpacking it (docs/SELF-HOSTING.md, Install)');
  if (src === 'same-release') return warn(id, 'the release zip was checked only against the .sha256 file published beside it in the same GitHub release (--trust-release-checksum): whoever can replace the zip can replace that file too');
  return warn(id, `unrecognised SUDS_RELEASE_CHECKSUM_SOURCE=${String(src).slice(0, 40)}`);
}

/** Every host check, in catalogue order. */
async function run(ctx) {
  const out = [];
  const steps = [['host.os', checkOs], ['host.data_dir', checkDataDir], ['host.disk_encryption', checkDiskEncryption], ['host.keys', checkKeys], ['host.service', checkService],
    ['host.tls', checkTls], ['host.http_redirect', checkHttpRedirect], ['host.bind', checkBind], ['host.firewall', checkFirewall], ['host.time_sync', checkTimeSync],
    ['host.security_updates', checkSecurityUpdates], ['host.journald', checkJournald], ['host.auditd', checkAuditd], ['host.node', checkNode], ['host.suds_version', checkSudsVersion], ['host.release_integrity', checkReleaseIntegrity]];
  for (const [id, f] of steps) {
    try { out.push(await f(ctx)); }
    catch (e) { out.push(nc(id, `the check itself failed: ${e.message}`)); }
  }
  return out;
}

module.exports = { run, realRun, osInfo, parseKv, parseUfw, parseFirewalld, parseIni, timespanDays, listeners, hexToIp, supportOf, nodePin,
  checkOs, checkDataDir, checkDiskEncryption, checkKeys, checkService, checkTls, checkHttpRedirect, checkBind, checkFirewall, checkTimeSync, checkSecurityUpdates, checkJournald, checkAuditd, checkNode, checkSudsVersion, checkReleaseIntegrity };
