'use strict';
// A synthetic programme of a chosen size for the funder-report performance and correctness tests
// (test/funder-report.test.js) and for measuring at the scale an evaluation reported (20,000 clients,
// 100,000 visits, 200,000 notes: `node test/fixtures/funder-scale.js` prints the timings). Rows are written
// straight into the tables, not through the API: the report reads them, so only their shape matters, and
// going through the API would take minutes. Names are one fixed ciphertext — nothing here is a person.
// Deterministic (a seeded generator), so two runs over the same size produce identical data.
const { encrypt, uuid } = require('../../server/crypto');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/**
 * Seed `db` (server/db.js, already open) with a programme of `clients` people over the fiscal year
 * 2025-07-01 .. 2026-06-30. Returns { userId, funds: [id…], resourceId }.
 */
function seed(db, { clients = 2000, visits = 10000, notes = 0, calls = 2000, seedValue = 42 } = {}) {
  const r = rng(seedValue);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const name = encrypt('Synthetic');
  const userId = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`, userId, `scale-${seedValue}-${Date.now()}`, 'x', 'Scale worker', 'navigator');
  const funds = [];
  for (const n of ['Opioid settlement', 'SOR', 'County general']) {
    const id = uuid(); funds.push(id);
    db.run(`INSERT INTO funding_sources(id,name,source_type,fiscal_year_start,fiscal_year_end,total_amount) VALUES(?,?,?,?,?,?)`, id, `${n} ${seedValue}`, 'other', '2025-07-01', '2026-06-30', 100000);
  }
  const resourceId = uuid();
  db.run(`INSERT INTO resources(id,name,category) VALUES(?,?,?)`, resourceId, 'Scale clinic', 'mat_obot');
  const start = Date.parse('2025-07-01T00:00:00Z'), span = 365 * 86400000;
  // Mostly full timestamps; one in twenty a bare calendar day, which the report compares as a day.
  const when = () => { const t = new Date(start + Math.floor(r() * span)).toISOString(); return r() < 0.05 ? t.slice(0, 10) : t; };
  const ids = [];
  db.transaction(() => {
    for (let i = 0; i < clients; i++) {
      const id = uuid(); ids.push(id);
      db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,gender,preferred_language,housing_status,insurance,race_codes,race_ethnicity,mat_status,intake_date,deleted_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, `S${seedValue}-${String(i).padStart(6, '0')}`, name, name, pick(['active', 'active', 'active', 'closed', 'waitlist']),
      pick(['female', 'male', 'male', 'nonbinary', '', null]), pick(['English', 'English', 'Spanish', 'Vietnamese', 'Tagalog']), pick(['housed', 'unhoused', 'unstably_housed', null]),
      pick(['medi_cal', 'medi_cal', 'none', 'private', 'medicare']), pick(['white', 'black_african_american', 'asian', 'white,other', 'american_indian_alaska_native', '', null]),
      pick(['hispanic_latino', 'not_hispanic_latino', null]), pick(['active', 'none', null]), new Date(start - 200 * 86400000 + Math.floor(r() * (span + 200 * 86400000))).toISOString().slice(0, 10),
      r() < 0.01 ? '2026-01-01T00:00:00.000Z' : null, userId);
    }
    for (let i = 0; i < visits; i++) {
      // One visit in twenty-five is anonymous community distribution; one in five is charged to no fund.
      const anon = r() < 0.04;
      db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,naloxone_kits,fentanyl_strips,funding_source_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        uuid(), anon ? null : pick(ids), userId, anon ? 'naloxone_distribution' : pick(['outreach', 'case_management', 'harm_reduction', 'peer_support']), when(), 30,
        pick(['field', 'community', 'office', 'shelter']), r() < 0.2 ? 1 + Math.floor(r() * 3) : 0, r() < 0.1 ? 5 : 0, r() < 0.2 ? null : pick(funds));
    }
    for (let i = 0; i < calls; i++) {
      db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,duration_minutes,outcome) VALUES(?,?,?,?,?,?,?)`, uuid(), r() < 0.9 ? pick(ids) : null, userId, pick(['inbound', 'outbound']), when(), 5, 'reached');
    }
    for (let i = 0; i < Math.floor(clients / 2); i++) {
      const at = when();
      db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status,admitted_at) VALUES(?,?,?,?,?,?,?)`, uuid(), pick(ids), resourceId, userId, at, pick(['pending', 'admitted', 'completed', 'declined_by_client']), r() < 0.3 ? at : null);
    }
    for (let i = 0; i < Math.floor(clients / 4); i++) {
      const opened = when().slice(0, 10); const closed = r() < 0.5 ? when().slice(0, 10) : null;
      db.run(`INSERT INTO episodes(id,client_id,opened_at,closed_at,discharge_reason,status) VALUES(?,?,?,?,?,?)`, uuid(), pick(ids), opened, closed && closed >= opened ? closed : null, closed && closed >= opened ? pick(['completed', 'lost_contact', 'transferred']) : null, closed && closed >= opened ? 'closed' : 'open');
    }
    for (let i = 0; i < Math.floor(clients / 10); i++) {
      const anon = r() < 0.5;
      db.run(`INSERT INTO overdose_events(id,client_id,occurred_at,kind,naloxone_used,naloxone_doses,administered_by,survived,location_type) VALUES(?,?,?,?,?,?,?,?,?)`,
        uuid(), anon ? null : pick(ids), when(), pick(['overdose', 'reversal', 'reversal', 'fatal']), r() < 0.8 ? 1 : 0, 1 + Math.floor(r() * 2), pick(['bystander', 'staff', 'first_responder', 'unknown']), r() < 0.9 ? 1 : 0, pick(['street', 'residence', 'shelter']));
    }
    for (let i = 0; i < Math.floor(clients / 2); i++) {
      db.run(`INSERT INTO time_entries(id,user_id,work_date,minutes,funding_source_id,status) VALUES(?,?,?,?,?,?)`, uuid(), userId, when().slice(0, 10), 60, pick([...funds, null]), pick(['draft', 'submitted', 'approved']));
    }
    const content = encrypt('Synthetic note');
    for (let i = 0; i < notes; i++) {
      db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status) VALUES(?,?,?,?,?,?,?)`, uuid(), pick(ids), userId, 'admin', content, when(), 'signed');
    }
  });
  db.run('ANALYZE');
  return { userId, funds, resourceId };
}
module.exports = { seed };

// `node test/fixtures/funder-scale.js [clients] [visits] [notes]`: seed an in-memory database at that size
// (default: the evaluation's 20,000 / 100,000 / 200,000), then time the funder report and a health check
// made while it runs.
if (require.main === module) {
  (async () => {
    const H = require('../helpers');
    await H.start();
    const [clients = 20000, visits = 100000, notes = 200000] = process.argv.slice(2).map(Number);
    let t = Date.now();
    seed(H.db, { clients, visits, notes, calls: Math.floor(visits / 5) });
    console.log(`seeded ${clients} clients, ${visits} visits, ${notes} notes in ${Date.now() - t} ms`);
    const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
    for (const q of ['from=2025-07-01&to=2026-06-30', 'from=2025-07-01&to=2026-06-30', 'from=2026-01-01&to=2026-03-31']) {
      t = Date.now();
      const rep = admin.get(`/api/reports/funder?${q}`);
      const h0 = Date.now(); const health = await fetch(`${await H.start()}/api/health`).then(() => Date.now() - h0);
      const res = await rep;
      console.log(`funder ${q}: ${res.status} ${Date.now() - t} ms (served ${res.data.unduplicated?.served}); /api/health answered after ${health} ms`);
    }
    for (const q of ['from=2025-07-01&to=2026-06-30']) {
      t = Date.now(); const d = await admin.get(`/api/reports/dashboard?${q}`); console.log(`dashboard ${q}: ${d.status} ${Date.now() - t} ms`);
    }
    await H.stop();
  })();
}
