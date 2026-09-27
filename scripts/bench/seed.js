'use strict';
// A programme of realistic size for the performance benchmark (scripts/bench/run.js, docs/PERFORMANCE.md):
// by default 20,000 clients, 100,000 visits, 200,000 notes, 20,000 calls, a supply ledger of about 50,000 rows
// and 2,000 SUPRT-A records, a navigator with a 2,000-client caseload, 50 more navigators with 400 clients each
// (the concurrent-load run signs them in), and an audit log of 300,000 entries.
//
// Built on test/fixtures/funder-scale.js (the reporting tests' synthetic programme), then filled out with what
// makes the other screens and sync realistic: every client's name, date of birth, phone and address encrypted
// and blind-indexed as the API would write them; a note body per note, a summary on most visits, supplies by
// item, site and lot, visits' supply lines and their draw-downs, SUPRT-A answers. Rows go straight into the
// tables, not through the API (which would take an hour). Nobody here is a person: names come from short lists.
// Deterministic apart from ids and ciphertext (a seeded generator).
const path = require('node:path');

/**
 * Seed `db` (server/db.js of the tree under test, already open) and return what the benchmark needs:
 * { adminPassword, nav: { id, username, password, clients }, navigators: [{ username, clients }], heavyClientId, items, sites }.
 * `root` is the tree whose server modules are used (the benchmark can measure an older checkout).
 */
function seed(db, { root = path.join(__dirname, '..', '..'), clients = 20000, visits = 100000, notes = 200000, calls = 20000, ledger = 50000, suprt = 2000, audit = 300000, navigators = 50, analyze = false, log = () => {} } = {}) {
  const { encrypt, blindIndex, hashPassword, uuid } = require(path.join(root, 'server/crypto'));
  const M = require(path.join(root, 'server/clients-model'));
  const scale = require(path.join(root, 'test/fixtures/funder-scale'));
  let s = 1234567;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (a) => a[Math.floor(r() * a.length)];
  let t = Date.now();
  const step = (what) => { log(`  ${what}: ${Date.now() - t} ms`); t = Date.now(); };

  const fx = scale.seed(db, { clients, visits, notes, calls, seedValue: 7 });
  step(`funder-scale seed (${clients} clients, ${visits} visits, ${notes} notes, ${calls} calls)`);

  // Identities, as clients.js writes them (encrypted fields and their blind indexes).
  const FIRST = ['Maria', 'James', 'Linh', 'Ahmed', 'Rosa', 'Daniel', 'Aiyana', 'Kevin', 'Tamika', 'Jorge', 'Mei', 'Samuel', 'Priya', 'Luis', 'Grace', 'Omar', 'Hannah', 'Tyrone', 'Elena', 'Victor'];
  const LAST = ['Nguyen', 'Garcia', 'Smith', 'Johnson', 'Tran', 'Martinez', 'Lopez', 'Williams', 'Brown', 'Hernandez', 'Kim', 'Patel', 'Rodriguez', 'Lee', 'Walker', 'Young', 'Quintero-Vasquez', 'Begay', 'Okafor', 'Castillo'];
  const STREETS = ['Main St', 'Oak Ave', 'Pine Rd', 'Mission Blvd', 'Harbor Way', 'Elm St', '1st Ave', 'River Rd'];
  const ids = db.all(`SELECT id FROM clients ORDER BY client_code`).map(x => x.id);
  const upd = db.get().prepare(`UPDATE clients SET first_name_enc=?, last_name_enc=?, dob_enc=?, phone_enc=?, address_enc=?, goals_enc=?, last_name_idx=?, full_name_idx=?, name_prefix_idx=?, name_phonetic_idx=?, first_name_idx=?, first_name_prefix_idx=?, dob_idx=?, phone_idx=?, primary_substance=?, risk_level=?, updated_at=? WHERE id=?`);
  db.transaction(() => {
    ids.forEach((id, i) => {
      const f = pick(FIRST); const l = pick(LAST);
      const dob = `${1955 + Math.floor(r() * 50)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
      const phone = `707555${String(i % 10000).padStart(4, '0')}`;
      const e = M.encryptFields({ first_name: f, last_name: l, dob, phone });
      upd.run(encrypt(f), encrypt(l), encrypt(dob), encrypt(phone), encrypt(`${100 + Math.floor(r() * 9000)} ${pick(STREETS)}, Eureka CA`), r() < 0.5 ? encrypt('Stable housing within 90 days; reconnect with primary care; start MOUD') : null,
        e.last_name_idx, blindIndex(l + f), e.name_prefix_idx, e.name_phonetic_idx, e.first_name_idx, e.first_name_prefix_idx, e.dob_idx, e.phone_idx,
        pick(['opioids', 'methamphetamine', 'alcohol', 'fentanyl', 'polysubstance', null]), pick(['low', 'low', 'moderate', 'high', 'critical', null]),
        // Clients change over the year, not all at one instant (sync pages by updated_at).
        new Date(Date.parse('2025-07-01T00:00:00Z') + Math.floor(r() * 365 * 86400000)).toISOString(), id);
    });
  });
  step('client identities and blind indexes');

  // Note bodies (a progress note is a few paragraphs), visit and call summaries. Ciphertext per row, as written.
  const BODY = 'Met client at the drop-in. Discussed housing application status and upcoming appointment with the county benefits office. Client reports reduced use over the past week and interest in starting buprenorphine; offered warm hand-off to the bridge clinic. Provided naloxone refresher and fentanyl test strips. Plan: follow up Thursday re: ID replacement, confirm transport. ';
  const noteRows = db.all(`SELECT id FROM notes`);
  const updNote = db.get().prepare(`UPDATE notes SET content_enc=?, title_enc=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) WHERE id=?`);
  db.transaction(() => { for (const n of noteRows) updNote.run(encrypt(BODY.repeat(1 + Math.floor(r() * 3)).slice(0, 300 + Math.floor(r() * 900))), r() < 0.3 ? encrypt('Progress note') : null, n.id); });
  step(`note bodies (${noteRows.length})`);
  const updVisit = db.get().prepare(`UPDATE interventions SET summary_enc=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) WHERE id=?`);
  const visitRows = db.all(`SELECT id, client_id, occurred_at FROM interventions ORDER BY id`);
  db.transaction(() => { for (const v of visitRows) updVisit.run(r() < 0.6 ? encrypt(BODY.slice(0, 80 + Math.floor(r() * 200))) : null, v.id); });
  db.transaction(() => {
    const u = db.get().prepare(`UPDATE calls SET summary_enc=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', started_at) WHERE id=?`);
    for (const c of db.all(`SELECT id FROM calls`)) u.run(r() < 0.7 ? encrypt(BODY.slice(0, 60 + Math.floor(r() * 150))) : null, c.id);
  });
  step('visit and call summaries');

  // One client with years of history: the record and its timeline at the far end of the distribution.
  // Clients who are on the books (the fixture marks one in a hundred deleted): the ones people are assigned to.
  const live = db.all(`SELECT id FROM clients WHERE deleted_at IS NULL ORDER BY client_code`).map(x => x.id);
  const heavyClientId = live[0];
  const workerId = fx.userId;
  db.transaction(() => {
    const iv = db.get().prepare(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,summary_enc,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
    const nt = db.get().prepare(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 2000; i++) { const at = new Date(Date.parse('2022-01-01T00:00:00Z') + i * 43200000).toISOString(); iv.run(uuid(), heavyClientId, workerId, 'case_management', at, 30, 'office', encrypt(BODY.slice(0, 120)), at); }
    for (let i = 0; i < 3000; i++) { const at = new Date(Date.parse('2022-01-01T00:00:00Z') + i * 28800000).toISOString(); nt.run(uuid(), heavyClientId, workerId, 'admin', encrypt(BODY), at, 'signed', at); }
  });
  step('a client with 2,000 visits and 3,000 notes');

  // To-dos and consents: the client list's overdue and consent-expiring columns read them.
  db.transaction(() => {
    const tk = db.get().prepare(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,due_at,status) VALUES(?,?,?,?,?,?,?)`);
    for (let i = 0; i < clients / 2; i++) tk.run(uuid(), pick(ids), workerId, workerId, encrypt('Follow up on housing application'), new Date(Date.parse('2026-01-01T00:00:00Z') + Math.floor(r() * 300 * 86400000)).toISOString().slice(0, 10), pick(['open', 'open', 'done']));
    const cs = db.get().prepare(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,signed_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < clients / 2; i++) cs.run(uuid(), pick(ids), 'roi', encrypt('Bridge clinic'), encrypt('Care coordination'), '2025-08-01', new Date(Date.parse('2026-06-01T00:00:00Z') + Math.floor(r() * 400 * 86400000)).toISOString().slice(0, 10), workerId);
  });
  step('to-dos and consents');

  // Supplies: items, sites, lots received, transfers, and visits' supply lines drawn from the earliest lot.
  const itemDefs = [['Narcan 4 mg nasal spray', 'naloxone', 1], ['Kloxxado 8 mg', 'naloxone', 0], ['Fentanyl test strips', 'fentanyl_test_strips', 1], ['Xylazine test strips', 'xylazine_test_strips', 0],
    ['Syringes 1 mL 28G', 'syringes', 1], ['Syringes 0.5 mL 29G', 'syringes', 0], ['Sharps container 1 qt', 'sharps_container', 0], ['Cookers', 'cookers', 0], ['Cottons', 'cottons', 0], ['Alcohol pads', 'alcohol_pads', 0],
    ['Safer smoking kit', 'safer_smoking', 0], ['Wound care kit', 'wound_care', 0], ['Condoms', 'condoms', 0], ['Hygiene kit', 'hygiene_kit', 0], ['Tourniquets', 'other', 0], ['Sterile water', 'other', 0],
    ['Vitamin C', 'other', 0], ['Lip balm', 'other', 0], ['Socks', 'other', 0], ['Snack packs', 'other', 0]];
  const items = itemDefs.map(([name, category, quick], i) => {
    const id = uuid(); db.run(`INSERT INTO supply_items(id,name,category,unit,quick,low_stock,sort_order) VALUES(?,?,?,?,?,?,?)`, id, name, category, 'each', quick, 50, i + 1); return { id, category };
  });
  const sites = ['site-main', ...['North van', 'South van', 'Drop-in', 'Partner clinic'].map((name, i) => { const id = uuid(); db.run(`INSERT INTO supply_sites(id,name,kind,sort_order) VALUES(?,?,?,?)`, id, name, i ? 'van' : 'drop_in', i + 1); return id; })];
  const addL = db.get().prepare(`INSERT INTO supply_ledger(id,item_id,site_id,kind,quantity,lot_number,expires_on,occurred_on,source,intervention_id,user_id,transfer_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const addLine = db.get().prepare(`INSERT INTO intervention_supplies(id,intervention_id,client_id,user_id,item_id,quantity,untracked,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)`);
  let ledgerRows = 0;
  db.transaction(() => {
    // A lot a fortnight per item and site, big enough to cover what is handed out.
    const lotsOf = new Map();
    for (const it of items) for (const site of sites) {
      const lots = [];
      for (let k = 0; k < 26; k++) {
        const day = new Date(Date.parse('2025-06-15T00:00:00Z') + k * 14 * 86400000).toISOString().slice(0, 10);
        const lot = { lot: `L${k}-${it.id.slice(0, 4)}`, expires: new Date(Date.parse(day) + (300 + Math.floor(r() * 400)) * 86400000).toISOString().slice(0, 10), left: 400 };
        addL.run(uuid(), it.id, site, 'received', 400, lot.lot, lot.expires, day, pick(['ndp', 'purchase', 'donation']), null, workerId, null, `${day}T16:00:00.000Z`, `${day}T16:00:00.000Z`); ledgerRows++;
        lots.push(lot);
      }
      lotsOf.set(`${it.id}|${site}`, lots);
    }
    // Visits hand out one to three items each until the ledger reaches its size.
    for (const v of visitRows) {
      if (ledgerRows >= ledger) break;
      if (r() > 0.45) continue;
      const site = pick(sites); const at = String(v.occurred_at); const day = at.slice(0, 10);
      const chosen = new Set(); const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) chosen.add(pick(items));
      for (const it of chosen) {
        const q = 1 + Math.floor(r() * 4);
        addLine.run(uuid(), v.id, v.client_id, workerId, it.id, q, at.length > 10 ? at : `${at}T12:00:00.000Z`, at.length > 10 ? at : `${at}T12:00:00.000Z`);
        const lot = lotsOf.get(`${it.id}|${site}`).find(l => l.left >= q) || lotsOf.get(`${it.id}|${site}`)[0];
        lot.left -= q;
        addL.run(uuid(), it.id, site, 'distributed', -q, lot.lot, lot.expires, day, null, v.id, workerId, null, `${day}T18:00:00.000Z`, `${day}T18:00:00.000Z`); ledgerRows++;
      }
    }
  });
  step(`supplies: ${items.length} items, ${sites.length} sites, ${ledgerRows} ledger rows`);

  // SUPRT-A records: a baseline and follow-ups, with their answers (encrypted JSON, a couple of kilobytes).
  const answers = JSON.stringify(Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`item_${k}`, k % 3 ? 'yes' : 'no']).concat([['record_id', 'S7-000123'], ['services', ['case_management', 'peer_support', 'mat']]])));
  db.transaction(() => {
    const ins = db.get().prepare(`INSERT INTO suprt_assessments(id,client_id,assessment_type,assessment_date,status,answers_enc,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
    for (let k = 0; k < suprt; k++) {
      const date = new Date(Date.parse('2025-07-01T00:00:00Z') + Math.floor(r() * 365 * 86400000)).toISOString().slice(0, 10);
      ins.run(uuid(), ids[k % ids.length], k < suprt * 0.6 ? 'baseline' : pick(['reassessment', 'annual', 'closeout']), date, r() < 0.8 ? 'complete' : 'draft', encrypt(answers), workerId, `${date}T17:00:00.000Z`);
    }
  });
  step(`SUPRT-A records (${suprt})`);

  // The navigator whose device syncs a 2,000-client caseload (the first-sync measurement), and 50 more with 400
  // clients each for the concurrent-load run.
  const password = 'StaffPassw0rd!x';
  const hash = hashPassword(password);
  const mkNav = (username) => { const id = uuid(); db.run(`INSERT INTO users(id,username,password_hash,display_name,role,password_changed_at,must_change_password) VALUES(?,?,?,?,?,?,0)`, id, username, hash, username, 'navigator', db.now()); return id; };
  const navId = mkNav('nav');
  const asg = db.get().prepare(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`);
  const caseload = Math.min(2000, Math.floor(live.length / 10));
  const navClients = live.slice(0, caseload);
  const extra = [];
  db.transaction(() => {
    for (const id of navClients) asg.run(uuid(), id, navId, 'primary', '2025-01-01', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    for (let k = 0; k < navigators; k++) {
      const username = `nav${k + 1}`; const uid = mkNav(username);
      const mine = Array.from({ length: 400 }, (_, j) => live[(caseload + k * 360 + j) % live.length]);
      for (const id of mine) asg.run(uuid(), id, uid, 'primary', '2025-01-01', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      extra.push({ username, clients: mine });
    }
  });
  step(`navigators: 1 with ${navClients.length} clients, ${navigators} with 400`);

  // An audit log of realistic depth (the chain is valid: each entry's hash is chained as audit.js writes it).
  if (audit > 0) {
    const cfg = require(path.join(root, 'server/config'));
    const nodeCrypto = require('node:crypto');
    const ins = db.get().prepare(`INSERT INTO audit_log(at,user_id,username,action,entity,entity_id,client_id,ip,success,details,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    let prev = (db.one(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`) || { hash: 'GENESIS' }).hash;
    const base = Date.parse('2025-07-01T00:00:00Z');
    const actions = ['client.view', 'client.list', 'client.timeline', 'intervention.create', 'note.view', 'sync.pull'];
    db.transaction(() => {
      for (let k = 0; k < audit; k++) {
        const at = new Date(base + k * 90000).toISOString(); const cid = pick(ids); const action = pick(actions);
        const payload = [at, workerId, 'scale', action, 'client', cid, cid, '10.0.0.5', 1, '', prev].join('|');
        const hash = 'v2:' + nodeCrypto.createHmac('sha256', cfg.indexKey).update(payload).digest('hex');
        ins.run(at, workerId, 'scale', action, 'client', cid, cid, '10.0.0.5', 1, null, prev, hash); prev = hash;
      }
    });
    step(`audit log (${audit} entries)`);
  }
  // A SUDS database in service has whatever planner statistics SUDS itself gathers (none before 1.14.0), not the
  // ANALYZE the reporting fixture runs, so they are removed: the queries are measured as an office would run them.
  if (analyze) { db.run('ANALYZE'); step('ANALYZE'); }
  else if (db.one(`SELECT 1 AS x FROM sqlite_master WHERE name='sqlite_stat1'`)) db.run('DELETE FROM sqlite_stat1');
  return { nav: { id: navId, username: 'nav', password, clients: navClients }, navigators: extra.map(x => ({ ...x, password })), heavyClientId, items, sites, funds: fx.funds };
}

module.exports = { seed };
