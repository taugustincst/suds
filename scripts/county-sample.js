'use strict';
// Sample county submissions for trying the county view (docs/COUNTY-VIEW.md) on a development server or in tests:
// three fictional programmes, each with its own Ed25519 key (derived from its name, so the same every run) and a
// signed submission for each of the last two complete calendar quarters. Nothing here touches a database: the
// files are what three programmes' own SUDS servers would have made under Send to the county.
//
//   node scripts/county-sample.js <dir>     writes <dir>/programmes.json (name, public key, fingerprint of each)
//                                            and <dir>/<programme>-<from>_<to>.json (the signed files)
//
// Then, on a server signed in as an administrator: County view › Programmes › Register a programme (paste each
// public key), and Import a submission (each file). `npm run seed` stays a programme's data; this is the county's.
// It needs no database, keys or data directory of a server (signWithSeed signs with each sample programme's own
// key): run as a command, it loads SUDS's modules as the test suite does, so it never reads or writes a server's
// data folder whatever SUDS_ENV the shell has.
if (require.main === module) { process.env.SUDS_ENV = 'test'; process.env.SUDS_DB_PATH = ':memory:'; }
process.env.SUDS_ENV = process.env.SUDS_ENV || 'test';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const K = require('../server/county');

const PROGRAMMES = [
  { slug: 'riverbend', name: 'Riverbend Harm Reduction Collective', scale: 1.0,
    funds: [{ name: 'County settlement share', grant_number: 'OSF-RB-1', category: 'core_a', hiaa: 'hiaa_6' }, { name: 'City abatement grant', grant_number: null, category: 'approved_h', hiaa: 'hiaa_4' }] },
  { slug: 'eastside', name: 'Eastside Recovery Outreach', scale: 0.6,
    funds: [{ name: 'County settlement share', grant_number: 'OSF-ER-7', category: 'approved_c', hiaa: 'hiaa_3' }] },
  { slug: 'hillview', name: 'Hillview Youth Prevention Project', scale: 0.3,
    funds: [{ name: 'Settlement prevention fund', grant_number: 'OSF-HV-2', category: 'core_g', hiaa: 'hiaa_5' }] },
];
const seedOf = (slug) => crypto.createHash('sha256').update(`suds-county-sample:${slug}`).digest();

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

/** A plausible, fictional payload for one programme and period (`k` varies the figures between periods). */
function payloadFor(p, period, k = 1) {
  const n = (x) => Math.round(x * p.scale * k);
  const vals = (w) => ({ contacts: n(420 * w), naloxone_kits: n(260 * w), fentanyl_strips: n(900 * w), syringes: n(3000 * w), reversals: n(9 * w), treatment_admissions: n(14 * w),
    education_contacts: n(35 * w), staff_training_hours: Math.round(40 * w * p.scale * k * 10) / 10, referrals_made: n(60 * w), people_served: n(310 * w), people_linked: n(22 * w), moud_linked: n(11 * w), people_trained: n(80 * w) });
  const share = p.funds.map((_, i) => (p.funds.length === 1 ? 1 : i === 0 ? 0.7 : 0.3));
  const funds = p.funds.map((f, i) => { const spent = Math.round(52000 * p.scale * k * share[i] * 100) / 100; return { ...f, spend: { own_category: spent, other_categories: 0, approved: spent, pending: Math.round(spent * 0.05 * 100) / 100 }, values: vals(share[i]) }; });
  const sum = (key) => Object.fromEntries(Object.keys(funds[0].values).map(v => [v, Math.round(funds.reduce((t, f) => t + f.values[v], 0) * 10) / 10]));
  const cats = [...new Set(funds.map(f => f.category))].map(c => { const fs2 = funds.filter(f => f.category === c); return { key: c, spend_own_category: Math.round(fs2.reduce((t, f) => t + f.spend.own_category, 0) * 100) / 100, values: vals(fs2.reduce((t, f, i) => t + share[funds.indexOf(f)], 0)) }; });
  return {
    schema_version: K.SCHEMA_VERSION, programme: p.name, period, generated_at: `${period.to}T23:00:00.000Z`, suds_version: require('../package.json').version, counts: 'exact',
    funds, categories: cats, total: { spend: { approved: Math.round(funds.reduce((t, f) => t + f.spend.approved, 0) * 100) / 100, pending: Math.round(funds.reduce((t, f) => t + f.spend.pending, 0) * 100) / 100 }, values: sum() },
  };
}

/** Every sample programme with its key, and its signed files for `periods`. */
function sample({ periods = lastQuarters(), programmes = PROGRAMMES } = {}) {
  return programmes.map(p => {
    const seed = seedOf(p.slug);
    const files = periods.map((period, i) => ({ period, ...K.signWithSeed(payloadFor(p, period, 1 + i * 0.1), seed) }));
    return { slug: p.slug, name: p.name, seed, public_key: files[0].public_key, fingerprint: files[0].fingerprint, fingerprint_display: K.formatFingerprint(files[0].fingerprint), files };
  });
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/county-sample.js <output directory>'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  const s = sample();
  fs.writeFileSync(path.join(dir, 'programmes.json'), JSON.stringify(s.map(p => ({ name: p.name, public_key: p.public_key, fingerprint: p.fingerprint_display })), null, 2) + '\n');
  for (const p of s) for (const f of p.files) fs.writeFileSync(path.join(dir, `${p.slug}-${f.period.from}_${f.period.to}.json`), JSON.stringify(f.file, null, 2) + '\n');
  console.log(`Wrote ${s.length} programmes and ${s.reduce((n, p) => n + p.files.length, 0)} signed submissions to ${dir}`);
}

module.exports = { PROGRAMMES, sample, payloadFor, lastQuarters, seedOf };
