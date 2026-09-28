'use strict';
// SUDS performance benchmark (docs/PERFORMANCE.md). Seeds a programme of realistic size (scripts/bench/seed.js),
// then measures what staff wait for: the Home dashboard, the client list and search, a client's record and
// timeline, the visits list, the Supplies page, saving a visit that hands out supplies, a device's first sync,
// server start-up and memory, and 50 navigators working at once.
//
//   node scripts/bench/run.js [--root <checkout>] [--out results.json] [--small] [--no-load] [--data <dir>]
//   node scripts/bench/run.js --compare before.json after.json      (a Markdown table of the two runs)
//   node scripts/bench/run.js --seed-only --data <dir>                (keep a seeded database to explore; --keep after a run)
//   node scripts/bench/run.js --load-only --data <dir> [--node-args "--cpu-prof"]   (start-up and load only, on a kept database)
//
// --root measures another checkout of SUDS with this same harness (how the before/after numbers in
// docs/PERFORMANCE.md were taken). --small seeds a tenth of the size, for trying the harness out.
// Every in-process measurement reports its wall time and the longest the event loop was held (max_stall_ms,
// sampled every 5 ms), which is how long any other person's request would have waited behind it.
// The seeded database carries no planner statistics (--analyze keeps them), as a database in service has only
// what SUDS gathers itself. Nothing here is part of the product or its tests; it writes only under its data directory.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

if (flag('--compare')) { compare(argv[argv.indexOf('--compare') + 1], argv[argv.indexOf('--compare') + 2]); process.exit(0); }

const ROOT = path.resolve(opt('--root', path.join(__dirname, '..', '..')));
const DATA = path.resolve(opt('--data', path.join(os.tmpdir(), `suds-bench-${process.pid}`)));
const SMALL = flag('--small');
const LOAD_ONLY = flag('--load-only');
if (!LOAD_ONLY) { fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true }); }
const DB_PATH = path.join(DATA, 'suds.db');
const ENV = { SUDS_ENV: 'test', SUDS_DATA_DIR: DATA, SUDS_DB_PATH: DB_PATH, SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x', SUDS_ADMIN_USERNAME: 'admin', MFA_REQUIRED_ROLES: '', LOCAL_MODE_ENABLED: 'true', TRUST_PROXY: '1',
  // Fixed keys, so the server process started later reads what this one wrote.
  SUDS_ENCRYPTION_KEY: '11'.repeat(32), SUDS_INDEX_KEY: '22'.repeat(32) };
Object.assign(process.env, ENV);
const { monitorEventLoopDelay } = require('node:perf_hooks');
const db = require(path.join(ROOT, 'server/db'));
const { createHandler } = require(path.join(ROOT, 'server/app'));
const { ensureBootstrap } = require(path.join(ROOT, 'server/bootstrap'));
const { seed } = require('./seed');

const results = { root: ROOT, commit: opt('--name', null) || gitHead(ROOT), node: process.version, cpus: os.cpus().length, at: new Date().toISOString(), loadavg_start: os.loadavg().map(x => +x.toFixed(2)), rows: [] };
const out = (row) => { results.rows.push(row); console.log(JSON.stringify(row)); };
let base;

// ---- HTTP: node:http, so the bytes on the wire (compressed or not) are what is counted ----
function request(method, p, { body, cookie, ip, encoding = 'gzip, deflate, br' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'X-Requested-With': 'suds', 'Accept-Encoding': encoding, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) };
    const req = http.request(base + p, { method, headers, agent }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const wire = Buffer.concat(chunks); const enc = res.headers['content-encoding'];
        const raw = enc === 'br' ? zlib.brotliDecompressSync(wire) : enc === 'gzip' ? zlib.gunzipSync(wire) : enc === 'deflate' ? zlib.inflateSync(wire) : wire;
        const ct = res.headers['content-type'] || '';
        let json = null; if (ct.includes('json')) { try { json = JSON.parse(raw.toString('utf8')); } catch { json = null; } }
        resolve({ status: res.statusCode, headers: res.headers, json, wireBytes: wire.length, rawBytes: raw.length });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
function session(username, password, ip) {
  let cookie = '';
  const call = async (method, p, body) => { const r = await request(method, p, { body, cookie, ip }); const sc = r.headers['set-cookie']; if (sc) cookie = String(sc[0]).split(';')[0]; return r; };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b),
    async login() { const r = await call('POST', '/api/auth/login', { username, password }); if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.json)}`); } };
}

// ---- one measurement: wall time, and how long the event loop was held while it ran ----
async function measure(label, fn, extra = {}) {
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  let last = process.hrtime.bigint(); let worst = 0;
  const iv = setInterval(() => { const now = process.hrtime.bigint(); worst = Math.max(worst, Number(now - last) / 1e6 - 5); last = now; }, 5);
  const t0 = process.hrtime.bigint(); let note = ''; let res;
  try { res = await fn(); note = (res && res.note) || ''; } catch (e) { note = 'ERROR ' + e.message; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  await new Promise(r => setTimeout(r, 12));
  clearInterval(iv); h.disable();
  out({ label, wall_ms: Math.round(ms), max_stall_ms: Math.max(0, Math.round(worst)), ...extra, ...(res && res.metrics ? res.metrics : {}), note });
  return res;
}
const expectOk = (r, what) => { if (r.status >= 400) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); return r; };
const kb = (n) => Math.round(n / 1024);

(async () => {
  if (LOAD_ONLY) { await serverProcessRuns(JSON.parse(fs.readFileSync(path.join(DATA, 'fixture.json'), 'utf8'))); const f = opt('--out', null); if (f) fs.writeFileSync(f, JSON.stringify(results, null, 2)); process.exit(0); }
  let t = Date.now();
  db.open(DB_PATH);
  ensureBootstrap();
  db.run(`UPDATE users SET must_change_password=0`);
  db.setSetting('programme_profile', 'treatment');
  const size = SMALL ? { clients: 2000, visits: 10000, notes: 20000, calls: 2000, ledger: 5000, suprt: 200, audit: 30000, navigators: 5 } : {};
  console.log(`# seeding ${SMALL ? '(small) ' : ''}under ${DATA}`);
  const fx = seed(db, { root: ROOT, ...size, analyze: flag('--analyze'), log: (m) => console.log('#' + m) });
  // Reopened, so the planner sees the database as a server starting on it would.
  db.close(); db.open(DB_PATH);
  const dbBytes = fs.statSync(DB_PATH).size;
  console.log(`# seeded in ${Date.now() - t} ms; database ${(dbBytes / 1e6).toFixed(0)} MB`);
  results.seed = { ms: Date.now() - t, db_mb: Math.round(dbBytes / 1e6), ...size };
  if (flag('--seed-only')) { db.close(); fs.writeFileSync(path.join(DATA, 'fixture.json'), JSON.stringify(fx)); console.log(`# kept ${DB_PATH}`); process.exit(0); }

  const server = http.createServer(createHandler());
  server.keepAliveTimeout = 60_000;
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  // 1.16.0: a navigator holds clients:all and notes:clinical:read by default. The measurements below were taken of a
  // navigator with a 2,000-client caseload, so 'nav' is held to it with per-user denies, as a programme does
  // (Settings -> Users & permissions -> Permissions); the whole-programme first sync of a navigator with the
  // role's defaults is measured on its own below.
  const HELD = ['clients:all', 'notes:clinical:read'];
  const holdNav = (on) => { for (const p of HELD) { if (on) db.run(`INSERT OR REPLACE INTO user_permission_overrides(user_id,permission,mode,reason) VALUES(?,?,'deny','bench: held to the 2,000-client caseload')`, fx.nav.id, p); else db.run(`DELETE FROM user_permission_overrides WHERE user_id=? AND permission=?`, fx.nav.id, p); } };
  holdNav(true);
  const admin = session('admin', 'AdminPassw0rd!x', '10.1.0.1'); await admin.login();
  const nav = session('nav', fx.nav.password, '10.1.0.2'); await nav.login();
  const FY = 'from=2025-07-01&to=2026-06-30';
  const typical = fx.nav.clients[17];
  const bytes = (r) => ({ metrics: { json_kb: kb(r.rawBytes), wire_kb: kb(r.wireBytes) } });
  const get = (s, p) => async () => bytes(expectOk(await s.get(p), p));

  // 2. Home
  for (let k = 1; k <= 2; k++) await measure(`dashboard FY admin #${k}`, get(admin, `/api/reports/dashboard?${FY}`));
  await measure('dashboard FY navigator (2,000 caseload)', get(nav, `/api/reports/dashboard?${FY}`));
  await measure('dashboard default 90 days admin', get(admin, '/api/reports/dashboard'));
  // 4. Supplies (Home fetches /api/supplies for anyone who records visits)
  for (let k = 1; k <= 2; k++) await measure(`supplies page (GET /api/supplies) #${k}`, get(admin, '/api/supplies'));
  await measure('supplies alerts', get(admin, '/api/supplies/alerts'));
  await measure('supplies catalog (visit form)', get(nav, '/api/supplies/catalog'));
  await measure('supplies ledger page 1', get(admin, '/api/supplies/ledger?limit=100'));
  // 3. Client list and search
  await measure('client list admin (page 1)', get(admin, '/api/clients?limit=50'));
  await measure('client list admin sort=last_contact', get(admin, '/api/clients?limit=50&sort=last_contact'));
  await measure('client list admin sort=risk', get(admin, '/api/clients?limit=50&sort=risk'));
  await measure('client list admin stale=1', get(admin, '/api/clients?limit=50&stale=1'));
  await measure('client list admin page 100', get(admin, '/api/clients?limit=50&offset=5000'));
  await measure('client list navigator (page 1)', get(nav, '/api/clients?limit=50'));
  await measure('client list navigator sort=last_contact', get(nav, '/api/clients?limit=50&sort=last_contact'));
  await measure('client search admin "Nguyen"', get(admin, '/api/clients?limit=50&q=Nguyen'));
  await measure('client search admin "ngu" (partial)', get(admin, '/api/clients?limit=50&q=ngu'));
  await measure('client search navigator "Garcia"', get(nav, '/api/clients?limit=50&q=Garcia'));
  // 3. The client record
  await measure('client record (typical)', get(nav, `/api/clients/${typical}`));
  await measure('client timeline (typical)', get(nav, `/api/clients/${typical}/timeline`));
  await measure('client record (5,000 events)', get(nav, `/api/clients/${fx.heavyClientId}`));
  await measure('client timeline (5,000 events)', get(nav, `/api/clients/${fx.heavyClientId}/timeline`));
  await measure('client timeline (5,000 events) page 5', get(nav, `/api/clients/${fx.heavyClientId}/timeline?offset=400`));
  await measure('client visits tab (5,000 events)', get(nav, `/api/interventions?client_id=${fx.heavyClientId}&limit=100`));
  await measure('client notes tab (5,000 events)', get(nav, `/api/notes?client_id=${fx.heavyClientId}&limit=100`));
  // 3. The visits list
  await measure('visits list admin (page 1)', get(admin, '/api/interventions?limit=100'));
  await measure('visits list admin offset 50,000', get(admin, '/api/interventions?limit=100&offset=50000'));
  await measure('visits list admin FY range', get(admin, '/api/interventions?limit=100&from=2025-07-01&to=2026-06-30'));
  await measure('visits list navigator (page 1)', get(nav, '/api/interventions?limit=100'));
  await measure('notes list navigator (page 1)', get(nav, '/api/notes?limit=100'));
  await measure('calls list navigator (page 1)', get(nav, '/api/calls?limit=100'));
  // 4. Saving a visit that hands out supplies (first-expiry-first-out draw-down)
  const naloxone = fx.items[0].id; const strips = fx.items[2].id; const syringes = fx.items[4].id;
  const lat = [];
  await measure('save visit with 3 supply items x40 (avg)', async () => {
    for (let k = 0; k < 40; k++) {
      const t1 = process.hrtime.bigint();
      expectOk(await nav.post('/api/interventions', { client_id: fx.nav.clients[k], type: 'harm_reduction', occurred_at: new Date().toISOString(), duration_minutes: 15, location: 'field',
        supplies: [{ item_id: naloxone, quantity: 2 }, { item_id: strips, quantity: 5 }, { item_id: syringes, quantity: 20 }] }), 'save visit');
      lat.push(Number(process.hrtime.bigint() - t1) / 1e6);
    }
    lat.sort((a, b) => a - b);
    return { metrics: { avg_ms: +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1), p95_ms: +lat[Math.floor(lat.length * 0.95)].toFixed(1) } };
  });

  // 1. A device's first sync: every page, as local/sync.js asks for them.
  const pull = async (s, pagesMax) => {
    let pages = 0; let rows = 0; let jsonBytes = 0; let wireBytes = 0; let worst = 0; let since = '1970-01-01T00:00:00.000Z';
    for (;;) {
      const t1 = Date.now();
      const r = expectOk(await s.get(`/api/sync/pull?since=${encodeURIComponent(since)}`), 'pull');
      worst = Math.max(worst, Date.now() - t1);
      pages++; jsonBytes += r.rawBytes; wireBytes += r.wireBytes;
      for (const v of Object.values(r.json.tables)) rows += v.length;
      since = r.json.cursor;
      if (r.json.complete || pages >= pagesMax) break;
    }
    return { metrics: { pages, rows, json_mb: +(jsonBytes / 1e6).toFixed(1), wire_mb: +(wireBytes / 1e6).toFixed(1), worst_page_ms: worst } };
  };
  await measure('sync first pull, navigator 2,000 caseload (all pages)', () => pull(nav, 500));
  holdNav(false);
  await measure('sync first pull, navigator with the 1.16.0 defaults: whole programme (all pages)', () => pull(nav, 1000));
  // Then the programme holds them to their caseload: the device's next pull names what it must remove.
  const wideScope = expectOk(await nav.get(`/api/sync/pull?since=${encodeURIComponent(new Date().toISOString())}`), 'pull').json.scope;
  holdNav(true);
  await measure('sync pull after clients:all and notes:clinical:read are denied (what to remove)', async () => {
    const r = expectOk(await nav.get(`/api/sync/pull?since=${encodeURIComponent(new Date().toISOString())}&scope=${encodeURIComponent(wideScope)}`), 'pull');
    return { metrics: { dropped_clients: r.json.dropped_clients.length, dropped_rows: r.json.dropped_rows.length, json_kb: kb(r.rawBytes), wire_kb: kb(r.wireBytes) } };
  });
  await measure('sync first pull, admin (first 5 pages)', () => pull(admin, 5));
  await measure('sync pull, nothing new (navigator)', async () => { const r = expectOk(await nav.get(`/api/sync/pull?since=${encodeURIComponent(new Date().toISOString())}`), 'pull'); return bytes(r); });

  // 6. The audit log's cost per entry (every PHI read and write writes one, hash-chained to the one before).
  const audit = require(path.join(ROOT, 'server/audit'));
  await measure('audit.log x2,000 (per entry)', async () => {
    const who = db.one(`SELECT id, username FROM users WHERE username='nav'`);
    const t1 = process.hrtime.bigint();
    for (let k = 0; k < 2000; k++) audit.log({ user: who, action: 'client.view', entity: 'client', entityId: fx.nav.clients[k % 100], clientId: fx.nav.clients[k % 100], ip: '10.1.0.2' });
    return { metrics: { per_entry_us: Math.round(Number(process.hrtime.bigint() - t1) / 2000 / 1000) } };
  });

  await new Promise(res => server.close(res)); agent.destroy(); db.close();

  // 6. Start-up, memory, and 50 navigators at once, against the real server process.
  if (!flag('--no-load')) await serverProcessRuns(fx);
  results.finished = new Date().toISOString(); results.loadavg_end = os.loadavg().map(x => +x.toFixed(2));
  const file = opt('--out', null);
  if (file) { fs.writeFileSync(file, JSON.stringify(results, null, 2)); console.log(`# wrote ${file}`); }
  if (!flag('--keep')) fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

async function serverProcessRuns(fx) {
  const port = 20000 + (process.pid % 20000);
  const start = async (label) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--no-warnings', ...(opt('--node-args', '') ? opt('--node-args', '').split(' ') : []), path.join(ROOT, 'server/index.js')], { env: { ...process.env, ...ENV, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'inherit'] });
    base = `http://127.0.0.1:${port}`;
    for (;;) {
      try { const r = await request('GET', '/api/health/live'); if (r.status === 200) break; } catch {}
      if (Date.now() - t0 > 60000) throw new Error('server did not start');
      await new Promise(r => setTimeout(r, 10));
    }
    const ms = Date.now() - t0;
    out({ label, wall_ms: ms, rss_mb: rssMb(child.pid), note: '' });
    return child;
  };
  const stop = (child) => new Promise(res => { child.once('exit', res); child.kill('SIGTERM'); });
  let child = await start('server start-up (to /api/health/live), first start');
  await stop(child);
  child = await start('server start-up (to /api/health/live)');

  const workers = fx.navigators.map((n, i) => ({ ...n, s: session(n.username, n.password, `10.2.${i >> 8}.${i & 255}`) }));
  await Promise.all(workers.map(w => w.s.login()));
  const lat = { list: [], view: [], timeline: [], save: [] };
  const seconds = SMALL ? 5 : 20;
  const until = Date.now() + seconds * 1000;
  let errors = 0; let ops = 0;
  const timed = async (kind, fn) => { const t1 = process.hrtime.bigint(); const r = await fn(); lat[kind].push(Number(process.hrtime.bigint() - t1) / 1e6); ops++; if (r.status >= 400) { errors++; if (errors <= 3) console.log(`# ${kind}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`); } return r; };
  await Promise.all(workers.map(async (w, i) => {
    let k = i;
    while (Date.now() < until) {
      const cid = w.clients[k++ % w.clients.length];
      await timed('list', () => w.s.get('/api/clients?limit=50'));
      await timed('view', () => w.s.get(`/api/clients/${cid}`));
      await timed('timeline', () => w.s.get(`/api/clients/${cid}/timeline`));
      await timed('save', () => w.s.post('/api/interventions', { client_id: cid, type: 'outreach', occurred_at: new Date().toISOString(), duration_minutes: 10, location: 'field', summary: 'Checked in; offered supplies.', supplies: [{ item_id: fx.items[0].id, quantity: 1 }] }));
    }
  }));
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };
  const metrics = { ops, ops_per_s: +(ops / seconds).toFixed(1), errors, rss_mb_after: rssMb(child.pid) };
  for (const [k, a] of Object.entries(lat)) Object.assign(metrics, { [`${k}_p50`]: pct(a, 0.5), [`${k}_p95`]: pct(a, 0.95) });
  out({ label: `50 navigators for ${seconds} s (list, view, timeline, save visit)`, wall_ms: seconds * 1000, ...metrics, note: '' });
  await stop(child);
  agent.destroy();
}
function rssMb(pid) { try { const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/); return m ? Math.round(Number(m[1]) / 1024) : null; } catch { return null; } }
function gitHead(root) { try { return require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { return null; } }

function compare(a, b) {
  const A = JSON.parse(fs.readFileSync(a, 'utf8')); const B = JSON.parse(fs.readFileSync(b, 'utf8'));
  const keys = ['wall_ms', 'max_stall_ms', 'per_entry_us', 'json_kb', 'wire_kb', 'wire_mb', 'json_mb', 'worst_page_ms', 'avg_ms', 'rss_mb', 'rss_mb_after', 'ops_per_s', 'errors', 'list_p50', 'list_p95', 'view_p50', 'view_p95', 'timeline_p50', 'timeline_p95', 'save_p50', 'save_p95', 'pages', 'rows'];
  console.log(`| Measurement | Before (${A.commit}) | After (${B.commit}) |\n|---|---|---|`);
  for (const r of A.rows) {
    const s = B.rows.find(x => x.label === r.label) || {};
    const fmt = (x) => keys.filter(k => x[k] !== undefined).map(k => `${k.replace(/_/g, ' ')} ${x[k]}`).join(', ');
    console.log(`| ${r.label} | ${fmt(r)} | ${fmt(s)} |`);
  }
}
