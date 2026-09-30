'use strict';
// Sample county submissions for trying the county view (docs/COUNTY-VIEW.md) on a development server or in tests:
// three fictional programs, each with its own Ed25519 key (derived from its name, so the same every run) and a
// signed submission for each of the last two complete calendar quarters, made for one county (its county code).
//
//   node scripts/county-sample.js --register
//       Development only: registers the three sample programs in this machine's development database (the one
//       `npm run dev` serves) and imports their files, made for that database's own county code; and registers a
//       fourth, "not on SUDS" (NOT_ON_SUDS), with figures entered by the county for the same quarters (built for
//       1.20.0; server/county-entry.js). A presenter is set up in under a minute: open County view. Refuses to run
//       against a production server's data.
//   node scripts/county-sample.js <dir> --county-code ABCD-EFGH
//       Writes <dir>/programmes.json (name, public key, fingerprint of each) and <dir>/<program>-<from>_<to>.json
//       (the signed files), made for the county whose code is given (County view › Programs shows it). Nothing
//       here touches a database: the files are what three programs' own SUDS servers would have made. Register
//       each key and import each file on the county's server (the browser suite does this through the API).
//
// `npm run seed` stays a program's data; this is the county's. Written to a directory, it needs no database, keys or
// data directory of a server (signWithSeed signs with each sample program's own key): it loads SUDS's modules as
// the test suite does, so it never reads or writes a server's data folder whatever SUDS_ENV the shell has.
// Required as a module (the tests, scripts/ui/county.mjs for lastQuarters), it loads SUDS's modules only when a
// file is signed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REGISTER = require.main === module && process.argv.includes('--register');
if (require.main === module && !REGISTER) { process.env.SUDS_ENV = 'test'; process.env.SUDS_DB_PATH = ':memory:'; }
const county = () => require('../server/county');

const PROGRAMMES = [
  { slug: 'riverbend', name: 'Riverbend Harm Reduction Collective', scale: 1.0,
    funds: [{ name: 'County settlement share', grant_number: 'OSF-RB-1', category: 'core_a', hiaa: 'hiaa_6' }, { name: 'City abatement grant', grant_number: null, category: 'approved_h', hiaa: 'hiaa_4' }] },
  { slug: 'eastside', name: 'Eastside Recovery Outreach', scale: 0.6,
    funds: [{ name: 'County settlement share', grant_number: 'OSF-ER-7', category: 'approved_c', hiaa: 'hiaa_3' }] },
  { slug: 'hillview', name: 'Hillview Youth Prevention Project', scale: 0.3,
    funds: [{ name: 'Settlement prevention fund', grant_number: 'OSF-HV-2', category: 'core_g', hiaa: 'hiaa_5' }] },
];
/** A fictional grantee that does not run SUDS: the county enters its figures (--register only). */
const NOT_ON_SUDS = { slug: 'canyon', name: 'Canyon Mobile Outreach', scale: 0.4,
  funds: [{ name: 'County settlement share', grant_number: 'OSF-CM-3', category: 'core_h', hiaa: 'hiaa_4' }] };
const seedOf = (slug) => crypto.createHash('sha256').update(`suds-county-sample:${slug}`).digest();
/** The county the sample files are made for when a test does not say (a fixed, valid county code). */
const SAMPLE_COUNTY = { county_code: 'SAMP1E00', county_name: 'Sample County Behavioral Health' };

/** The last `n` complete calendar quarters before `today` (YYYY-MM-DD), oldest first. */
function lastQuarters(today = new Date().toISOString().slice(0, 10), n = 2) {
  let y = Number(today.slice(0, 4)); let q = Math.floor((Number(today.slice(5, 7)) - 1) / 3); // the current quarter, 0-based
  const out = [];
  for (let i = 0; i < n; i++) {
    q--; if (q < 0) { q = 3; y--; }
    const m1 = q * 3 + 1; const last = new Date(Date.UTC(y, m1 + 2, 0)).toISOString().slice(0, 10);
    out.unshift({ from: `${y}-${String(m1).padStart(2, '0')}-01`, to: last });
  }
  return out;
}

/** A plausible, fictional payload for one program and period (`k` varies the figures between periods). */
function payloadFor(p, period, k = 1, { recipient = SAMPLE_COUNTY, generatedAt = `${period.to}T23:00:00.000Z` } = {}) {
  const K = county();
  const n = (x) => Math.round(x * p.scale * k);
  const vals = (w) => ({ contacts: n(420 * w), naloxone_kits: n(260 * w), fentanyl_strips: n(900 * w), syringes: n(3000 * w), reversals: n(9 * w), treatment_admissions: n(14 * w),
    education_contacts: n(35 * w), staff_training_hours: Math.round(40 * w * p.scale * k * 10) / 10, referrals_made: n(60 * w), people_served: n(310 * w), people_linked: n(22 * w), moud_linked: n(11 * w), people_trained: n(80 * w) });
  const share = p.funds.map((_, i) => (p.funds.length === 1 ? 1 : i === 0 ? 0.7 : 0.3));
  const funds = p.funds.map((f, i) => { const spent = Math.round(52000 * p.scale * k * share[i] * 100) / 100; return { ...f, spend: { own_category: spent, other_categories: 0, approved: spent, pending: Math.round(spent * 0.05 * 100) / 100 }, values: vals(share[i]) }; });
  const sum = () => Object.fromEntries(Object.keys(funds[0].values).map(v => [v, Math.round(funds.reduce((t, f) => t + f.values[v], 0) * 10) / 10]));
  const cats = [...new Set(funds.map(f => f.category))].map(c => { const fs2 = funds.filter(f => f.category === c); return { key: c, spend_own_category: Math.round(fs2.reduce((t, f) => t + f.spend.own_category, 0) * 100) / 100, values: vals(fs2.reduce((t, f) => t + share[funds.indexOf(f)], 0)) }; });
  return {
    schema_version: K.SCHEMA_VERSION, programme: p.name, recipient: { ...recipient }, period, generated_at: generatedAt, suds_version: require('../package.json').version, counts: 'exact',
    funds, categories: cats, total: { spend: { approved: Math.round(funds.reduce((t, f) => t + f.spend.approved, 0) * 100) / 100, pending: Math.round(funds.reduce((t, f) => t + f.spend.pending, 0) * 100) / 100 }, values: sum() },
  };
}

/** Every sample program with its key, and its signed files for `periods`, made for `recipient`. */
function sample({ periods = lastQuarters(), programmes = PROGRAMMES, recipient = SAMPLE_COUNTY } = {}) {
  const K = county();
  return programmes.map(p => {
    const seed = seedOf(p.slug);
    const files = periods.map((period, i) => ({ period, ...K.signWithSeed(payloadFor(p, period, 1 + i * 0.1, { recipient }), seed) }));
    return { slug: p.slug, name: p.name, seed, public_key: files[0].public_key, fingerprint: files[0].fingerprint, fingerprint_display: K.formatFingerprint(files[0].fingerprint), files };
  });
}

/**
 * --register: the sample programs registered in the development database and their files imported, as the
 * county's first administrator (audited as that person). Development only.
 */
function register() {
  // Asked before SUDS's configuration loads: on a production server's data folder it would otherwise start looking
  // for (or making) that server's keys.
  const prod = () => { console.error('Refusing to add sample county data to a production server. --register is for a development server (npm run dev).'); process.exit(1); };
  if ((process.env.SUDS_ENV || 'development') === 'production' || process.env.NODE_ENV === 'production') prod();
  const config = require('../server/config');
  if (config.isProd) prod();
  const db = require('../server/db'); const audit = require('../server/audit');
  db.open();
  require('../server/bootstrap').ensureBootstrap();
  const K = county();
  const admin = db.one(`SELECT * FROM users WHERE role='admin' AND is_active=1 ORDER BY rowid LIMIT 1`);
  const { code } = K.countyCode();
  const recipient = { county_code: code, county_name: db.getSetting('org_name', '') || 'Sample County' };
  let added = 0; let imported = 0;
  for (const p of sample({ recipient })) {
    let key = db.one(`SELECT * FROM county_programme_keys WHERE fingerprint=?`, p.fingerprint);
    if (!key) {
      const id = crypto.randomUUID(); const now = db.now();
      db.run(`INSERT INTO county_programmes(id,name,active,keep_files,notes,created_at,created_by,updated_at) VALUES(?,?,1,0,?,?,?,?)`, id, p.name, 'Fictional sample program (scripts/county-sample.js)', now, admin ? admin.id : null, now);
      db.run(`INSERT INTO county_programme_keys(id,programme_id,public_key,fingerprint,added_at,added_by) VALUES(?,?,?,?,?,?)`, crypto.randomUUID(), id, p.public_key, p.fingerprint, now, admin ? admin.id : null);
      audit.log({ user: admin, action: 'county.programme.add', entity: 'county_programme', entityId: id, details: { fingerprint: p.fingerprint, checked: 'sample', sample: true } });
      added++;
    }
    for (const f of p.files) {
      const out = K.importParsed(K.parseFile(JSON.stringify(f.file)), admin, { countyCode: code });
      if (out.status !== 'duplicate') { imported++; audit.log({ user: admin, action: 'county.submission.import', entity: 'county_submission', entityId: out.submission.id, details: { programme_id: out.programme.id, fingerprint: f.fingerprint, from: f.period.from, to: f.period.to, sha256: f.sha256, status: out.status, sample: true } }); }
    }
  }
  // The grantee not on SUDS: registered with no key, and its figures for each quarter entered as the county's staff
  // would in the Enter figures form (county-entry.js enter: the same checks and the same audit action).
  const E = require('../server/county-entry');
  let prog = db.one(`SELECT * FROM county_programmes WHERE name=? AND on_suds=0`, NOT_ON_SUDS.name);
  let addedOff = 0; let entered = 0;
  if (!prog) {
    const id = crypto.randomUUID(); const now = db.now();
    db.run(`INSERT INTO county_programmes(id,name,active,keep_files,notes,created_at,created_by,updated_at,on_suds) VALUES(?,?,1,0,?,?,?,?,0)`, id, NOT_ON_SUDS.name, 'Fictional sample program not on SUDS (scripts/county-sample.js)', now, admin ? admin.id : null, now);
    audit.log({ user: admin, action: 'county.programme.add', entity: 'county_programme', entityId: id, details: { on_suds: false, sample: true } });
    prog = db.one(`SELECT * FROM county_programmes WHERE id=?`, id); addedOff++;
  }
  const today = require('../server/routes/budget').localDate();
  lastQuarters(today).forEach((period, i) => {
    if (db.one(`SELECT 1 x FROM county_submissions WHERE programme_id=? AND period_from=? AND period_to=? AND source='county_entered'`, prog.id, period.from, period.to)) return;
    const pl = payloadFor(NOT_ON_SUDS, period, 1 + i * 0.1, { recipient });
    const funds = pl.funds.map(f => ({ name: f.name, grant_number: f.grant_number, category: f.category, hiaa: f.hiaa, spend_own_category: String(f.spend.own_category), spend_other_categories: String(f.spend.other_categories), spend_pending: String(f.spend.pending),
      ...Object.fromEntries(Object.entries(f.values).map(([k, v]) => [k, String(k === 'staff_training_hours' ? Math.round(v * 10) / 10 : Math.round(v))])) }));
    const out = E.enter(prog.id, { ...period, source_ref: `Sample quarterly report (fictional), ${period.from} to ${period.to}`, funds }, admin, { today });
    audit.log({ user: admin, action: 'county.entry.create', entity: 'county_submission', entityId: out.submission.id, details: { programme_id: prog.id, from: period.from, to: period.to, sha256: out.submission.sha256, via: 'form', status: out.status, sample: true } });
    entered++;
  });
  console.log(`County code ${K.formatCode(code)}: registered ${added} sample program(s) and imported ${imported} file(s); added ${addedOff} program(s) not on SUDS with ${entered} period(s) of figures entered by the county. Open County view.`);
  db.close();
}

if (require.main === module) {
  if (REGISTER) register();
  else {
    const args = process.argv.slice(2);
    const at = args.indexOf('--county-code'); const code = at >= 0 ? args[at + 1] : null;
    const dir = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
    const K = county(); const c = K.normaliseCode(code);
    if (!dir || !c) { console.error('usage: node scripts/county-sample.js <output directory> --county-code <the county\'s code, from County view › Programs>\n       node scripts/county-sample.js --register    (development server only)'); process.exit(2); }
    fs.mkdirSync(dir, { recursive: true });
    const s = sample({ recipient: { county_code: c, county_name: 'Sample County Behavioral Health' } });
    fs.writeFileSync(path.join(dir, 'programmes.json'), JSON.stringify(s.map(p => ({ name: p.name, public_key: p.public_key, fingerprint: p.fingerprint_display })), null, 2) + '\n');
    for (const p of s) for (const f of p.files) fs.writeFileSync(path.join(dir, `${p.slug}-${f.period.from}_${f.period.to}.json`), JSON.stringify(f.file, null, 2) + '\n');
    console.log(`Wrote ${s.length} programs and ${s.reduce((n, p) => n + p.files.length, 0)} signed submissions for county ${K.formatCode(c)} to ${dir}`);
  }
}

module.exports = { PROGRAMMES, NOT_ON_SUDS, SAMPLE_COUNTY, sample, payloadFor, lastQuarters, seedOf };
