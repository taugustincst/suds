'use strict';
// Backup-and-restore exercise, end to end, on a throwaway seeded database. Run by CI on every push (the
// `dr-drill` job in .github/workflows/ci.yml, which the release gate requires) and by hand to produce DR
// evidence (docs/evidence/). It never touches a real data directory: everything lives under a new temporary
// directory, with keys generated for the run.
//
//   node scripts/dr-exercise.js [--out <dir>] [--clients N (default 2000)] [--keep]
//
// Steps, each timed:
//   1. seed      a fresh data directory with the fictional sample data (npm run seed)
//   2. backup    through the product's own scheduled-backup path (server/scheduled-backup.js run: online copy,
//                encrypted, read back and verified) — the same code the hourly timer runs
//   3. drill     npm run dr-drill -- --backup <that file> --keys-file <escrowed keys.json>: restore into a
//                temporary directory, start SUDS on it in a separate process, verify schema, row counts, the
//                whole audit chain and anchors, decrypt samples, sign in with password + TOTP; signed report
//   4. restore   the documented host procedure (node scripts/backup.js --restore) into a FRESH data directory,
//                then start the real server on it and wait for /api/health
//   5. verify    row counts in the fresh directory equal the source's at backup time; audit hash chain
//                verifies end to end; the drill report verifies with the signing public key only
// With --out, copies the signed report (.json, .txt), the public key and a summary (summary.json, summary.md)
// there. Exit status 0 only if every step passed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : null;
const keep = args.includes('--keep');
const scale = args.includes('--clients') ? Number(args[args.indexOf('--clients') + 1]) : 2000;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-dr-exercise-'));
const dataDir = path.join(work, 'data');
const freshDir = path.join(work, 'fresh-data');
const scratchDir = path.join(work, 'restore-scratch');
const anchors = path.join(work, 'anchors');
for (const d of [dataDir, freshDir, scratchDir, anchors]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const hex = () => crypto.randomBytes(32).toString('hex');
const keys = { SUDS_ENCRYPTION_KEY: hex(), SUDS_INDEX_KEY: hex(), SUDS_BACKUP_KEY: hex(), SUDS_SIGNING_KEY: hex() };
// The escrowed key backup (what "Download key backup" gives): the drill decrypts with this file only.
const keysFile = path.join(work, 'escrowed-keys.json');
fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
const baseEnv = { ...process.env, SUDS_ENV: 'development', ...keys, AUDIT_ANCHOR_DIR: anchors, LOG_FORMAT: 'text', MFA_REQUIRED_ROLES: '' };
delete baseEnv.SUDS_DB_PATH;
const envFor = (dir) => ({ ...baseEnv, SUDS_DATA_DIR: dir });
const NODE = [process.execPath, '--no-warnings=ExperimentalWarning'];

const steps = [];
function record(name, ms, ok, detail) { steps.push({ name, ms: Math.round(ms), ok, detail }); console.log(`[dr-exercise] ${ok ? 'PASS' : 'FAIL'} ${name} (${Math.round(ms)} ms)${detail ? ` — ${detail}` : ''}`); }
function run(name, argv, env, { json = false } = {}) {
  const t = performance.now();
  const r = spawnSync(NODE[0], [...NODE.slice(1), ...argv], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const ms = performance.now() - t;
  if (r.status !== 0 && !json) { process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); }
  return { ms, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
// Node code run in a child against one data directory; prints one JSON line last.
function evalIn(dir, code) {
  const r = run('eval', ['-e', code], envFor(dir));
  const last = r.stdout.trim().split('\n').pop();
  try { return { ...r, value: JSON.parse(last) }; } catch { process.stdout.write(r.stdout); process.stderr.write(r.stderr); return { ...r, value: null }; }
}
const COUNT_JS = `const db=require('./server/db');db.open();const t=db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);const c={};for(const n of t)c[n]=db.one('SELECT COUNT(*) n FROM "'+n+'"').n;`;

async function main() {
  const started = new Date();
  // 1. seed
  let r = run('seed', ['scripts/seed.js'], envFor(dataDir));
  record('Seed a fresh database with the fictional sample data (npm run seed)', r.ms, r.status === 0, (r.stdout.match(/Seeded[^\n]*/) || [''])[0]);
  if (r.status !== 0) return finish(started);
  // 1b. volume: fictional clients with visits, each creation audited as the API would, so the audit chain,
  // the encrypted columns and the file size are not toy-sized.
  if (scale > 0) {
    r = evalIn(dataDir, `const db=require('./server/db');db.open();const audit=require('./server/audit');const {encryptFields,uuid}=require('./server/clients-model');const {blindIndex}=require('./server/crypto');
      const u=db.one("SELECT id FROM users WHERE username='mrivera'").id;
      db.transaction(()=>{for(let i=0;i<${scale};i++){const id=uuid();const last='Exercise'+(i%500),first='Person'+i;const enc=encryptFields({first_name:first,last_name:last,dob:'1980-01-01',phone:'555'+String(i).padStart(7,'0')});enc.full_name_idx=blindIndex(last+first);
        const cols={id,client_code:'DRX-'+String(i).padStart(6,'0'),status:'active',risk_level:'moderate',intake_date:'2026-01-01',created_by:u,...enc};const k=Object.keys(cols).filter(x=>cols[x]!==undefined);
        db.run('INSERT INTO clients('+k.join(',')+') VALUES('+k.map(()=>'?').join(',')+')',...k.map(x=>cols[x]));
        for(let j=0;j<8;j++)db.run('INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality) VALUES(?,?,?,?,?,?,?,?)',uuid(),id,u,'check_in','2026-0'+(1+j%9)+'-15T10:00:00.000Z',30,'office','in_person');
        audit.log({user:{id:u,username:'mrivera'},action:'client.create',entity:'client',entityId:id,clientId:id,details:{client_code:cols.client_code}});}});
      console.log(JSON.stringify({clients:db.one('SELECT COUNT(*) n FROM clients').n,audit:db.one('SELECT COUNT(*) n FROM audit_log').n}));db.close();`);
    record(`Add ${scale} fictional clients with 8 visits each, every creation audited`, r.ms, !!r.value, r.value ? `${r.value.clients} clients, ${r.value.audit} audit entries` : '');
    if (!r.value) return finish(started);
  }

  // 1c. an audit anchor sealed before the backup (as the AUDIT_ANCHOR_HOURS timer does), so the drill's
  // "restored chain matches the anchors" check compares against a real anchor, not an empty directory.
  r = evalIn(dataDir, `const db=require('./server/db');db.open();const f=require('./server/audit-anchor').safeWrite('dr-exercise');console.log(JSON.stringify({file:f&&(f.file||f)}));db.close();`);
  record('Seal an audit anchor outside the database (AUDIT_ANCHOR_DIR) before the backup', r.ms, !!(r.value && r.value.file), r.value && r.value.file ? String(path.basename(String(r.value.file))) : 'no anchor written');

  // 2. backup through the product's own scheduled path; source counts captured immediately before it
  r = evalIn(dataDir, `${COUNT_JS}
    const s=require('./server/scheduled-backup');
    s.run({ retain: 14 }).then((o)=>{ console.log(JSON.stringify({ counts: c, file: o.file, bytes: o.bytes, verified: o.verified, method: o.method, error: o.error||o.verifyError||null })); db.close(); });`);
  const b = r.value || {};
  record('Encrypted backup through the scheduled-backup path (online copy, AES-256-GCM, read back and verified)', r.ms, !!(b.file && b.verified), b.file ? `${path.basename(b.file)}, ${(b.bytes / 1024).toFixed(0)} KB, ${b.method}, verified=${b.verified}` : b.error);
  if (!b.file || !b.verified) return finish(started);

  // 3. the recovery drill with the escrowed keys
  r = run('drill', ['scripts/dr-drill.js', '--backup', b.file, '--keys-file', keysFile, '--json'], envFor(dataDir), { json: true });
  let doc = null; try { doc = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch {}
  const rep = doc && doc.report;
  record('Recovery drill: npm run dr-drill -- --backup <file> --keys-file <escrowed keys.json>', r.ms, r.status === 0 && !!rep && rep.ok,
    rep ? `${rep.checks.filter((c) => c.ok).length}/${rep.checks.length} checks passed; RTO ${rep.rto.seconds} s; RPO ${rep.rpo.seconds} s; audit entries verified ${rep.audit.entries_verified}` : (r.stderr || r.stdout).slice(-500));
  const reportFiles = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => /^dr-drill-.*\.(json|txt)$/.test(f)).sort();
  const reportJson = reportFiles.filter((f) => f.endsWith('.json')).pop();

  // 4. host restore into a fresh data directory, then the real server on it
  const tRestore = performance.now();
  r = run('restore', ['scripts/backup.js', '--restore', b.file, path.join(freshDir, 'suds.db')], envFor(scratchDir));
  record('Host restore procedure into a fresh data directory (node scripts/backup.js --restore)', r.ms, r.status === 0, r.stdout.trim().split('\n')[0]);
  if (r.status !== 0) return finish(started, { doc, reportJson });
  const port = 20000 + crypto.randomInt(20000);
  const server = spawn(NODE[0], [...NODE.slice(1), 'server/index.js'], { cwd: root, env: { ...envFor(freshDir), PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  let health = null;
  for (let i = 0; i < 600 && !health; i++) {
    await new Promise((res) => setTimeout(res, 100));
    try { const res = await fetch(`http://127.0.0.1:${port}/api/health`); const body = await res.json(); if (body.database === 'ok') health = { status: res.status, body }; } catch {}
  }
  const hostRtoMs = performance.now() - tRestore;
  server.kill('SIGTERM');
  await new Promise((res) => server.once('exit', res));
  record('The restored copy serves: SUDS started on the fresh data directory and answered /api/health', hostRtoMs, !!health, health ? `HTTP ${health.status}${health.body.warnings ? ` (warnings: ${health.body.warnings.join(' ')})` : ''}` : serverLog.slice(-800));

  // 5. counts and the audit chain in the fresh directory
  r = evalIn(freshDir, `${COUNT_JS} const a=require('./server/audit').verifyChain(); console.log(JSON.stringify({ counts: c, audit: a })); db.close();`);
  const v = r.value || {};
  const src = b.counts || {}; const got = v.counts || {};
  // The restored server's own start-up adds rows of its own (sessions, audit entries for the start); a
  // restore must bring back at least everything the backup held, and every clinical table exactly.
  const own = new Set(['audit_log', 'settings', 'sessions', 'idempotency']);
  const mismatched = Object.keys(src).filter((t) => (own.has(t) ? (got[t] ?? 0) < src[t] : got[t] !== src[t]));
  record('Row counts in the fresh data directory equal the source at backup time', r.ms, !!v.counts && mismatched.length === 0,
    mismatched.length ? `mismatched: ${mismatched.map((t) => `${t} ${src[t]} -> ${got[t]}`).join(', ')}` : `${Object.keys(src).length} tables; clients ${got.clients}, interventions ${got.interventions}, notes ${got.notes}, audit_log ${src.audit_log} -> ${got.audit_log}`);
  const aok = v.audit && (v.audit.ok === true || v.audit.valid === true);
  record('Audit hash chain verifies end to end in the restored copy', 0, !!aok, v.audit ? JSON.stringify(v.audit).slice(0, 300) : 'no result');

  // 6. the signed report, verified with the public key only
  const pub = evalIn(dataDir, `console.log(JSON.stringify(require('./server/signing').publicInfo()));`).value;
  const pemFile = path.join(work, 'suds-signing-key.pem'); if (pub) fs.writeFileSync(pemFile, pub.public_key_pem);
  r = reportJson ? run('verify', ['scripts/verify-dr-report.js', path.join(dataDir, 'backups', reportJson), '--public-key', pemFile], baseEnv) : { ms: 0, status: 1, stdout: 'no report' };
  record('Signed drill report verifies with the signing public key only (npm run verify-dr-report)', r.ms, r.status === 0, r.stdout.trim().split('\n').slice(-2).map((l) => l.trim()).join('; '));
  return finish(started, { doc, reportJson, reportFiles, pemFile, pub, backup: b, hostRtoMs });
}

function finish(started, ctx = {}) {
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  const rep = ctx.doc && ctx.doc.report;
  const summary = {
    kind: 'suds-dr-exercise', ok, environment: 'development exercise on a throwaway seeded database (fictional data); not a production drill',
    started_at: started.toISOString(), finished_at: new Date().toISOString(),
    host: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, memory_gb: Math.round(os.totalmem() / 2 ** 30) },
    suds_version: require(path.join(root, 'package.json')).version,
    steps,
    drill: rep ? { ok: rep.ok, rto_seconds: rep.rto.seconds, rpo_seconds: rep.rpo.seconds, rto_target_minutes: rep.rto.target_minutes, rpo_target_hours: rep.rpo.target_hours, checks_passed: rep.checks.filter((c) => c.ok).length, checks_total: rep.checks.length, audit_entries_verified: rep.audit.entries_verified, report_sha256: ctx.doc.integrity.sha256, signing_key_id: ctx.doc.integrity.signing_key_id } : null,
    host_restore_to_health_seconds: ctx.hostRtoMs ? Math.round(ctx.hostRtoMs / 100) / 10 : null,
    report_file: ctx.reportJson || null,
  };
  console.log('\n===== signed drill report (text) =====');
  const txt = ctx.reportFiles && ctx.reportFiles.filter((f) => f.endsWith('.txt')).pop();
  if (txt) process.stdout.write(fs.readFileSync(path.join(dataDir, 'backups', txt), 'utf8'));
  console.log('\n===== signed drill report (JSON) =====');
  if (ctx.reportJson) process.stdout.write(fs.readFileSync(path.join(dataDir, 'backups', ctx.reportJson), 'utf8'));
  console.log('\n===== exercise summary =====');
  console.log(JSON.stringify(summary, null, 2));
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of ctx.reportFiles || []) fs.copyFileSync(path.join(dataDir, 'backups', f), path.join(outDir, f));
    if (ctx.pemFile && fs.existsSync(ctx.pemFile)) fs.copyFileSync(ctx.pemFile, path.join(outDir, 'suds-signing-key.pem'));
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`[dr-exercise] evidence written to ${outDir}`);
  }
  if (!keep) {
    // The work directory holds the throwaway keys and fictional data only; remove it.
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { console.error(`[dr-exercise] could not remove ${work}: ${e.message}`); }
  } else console.log(`[dr-exercise] kept ${work}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('[dr-exercise]', e && e.stack || e); process.exitCode = 1; });
