'use strict';
// Seeds a development database with demo users, clients (fictional), resources, funds and activity.
// Usage: npm run seed   (refuses to run in production)
const config = require('../server/config');
if (config.isProd) { console.error('Refusing to seed a production database'); process.exit(1); }
const db = require('../server/db');
const { ensureBootstrap } = require('../server/bootstrap');
const { hashPassword, encrypt, blindIndex, uuid } = require('../server/crypto');
const audit = require('../server/audit');

db.open();
ensureBootstrap();
const PW = process.env.SEED_PASSWORD || 'Navigator2026!!';
function user(username, display_name, role, title, hourly) {
  const ex = db.one(`SELECT id FROM users WHERE username=?`, username); if (ex) return ex.id;
  const id = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,title,hourly_cost,password_changed_at) VALUES(?,?,?,?,?,?,?,?)`, id, username, hashPassword(PW), display_name, role, title, hourly, db.now());
  return id;
}
const nav1 = user('mrivera', 'Maria Rivera', 'navigator', 'SUD Navigator', 42);
const nav2 = user('dchen', 'David Chen', 'navigator', 'Peer Navigator', 35);
const clin = user('kpatel', 'Dr. Kiran Patel', 'clinician', 'LCSW, Clinical Supervisor', 65);
const sup = user('jwalker', 'Jordan Walker', 'supervisor', 'Program Manager', 58);
user('afinance', 'Alex Finance', 'finance', 'Fiscal Analyst', 40);
db.run(`UPDATE users SET must_change_password=0 WHERE username='admin'`);

if (db.one(`SELECT COUNT(*) n FROM clients`).n === 0) {
  const d = (off) => new Date(Date.now() - off * 86400000).toISOString();
  const day = (off) => d(off).slice(0, 10);
  const C = require('../server/constants');
  const clients = [
    ['Jamie', 'Nguyen', '1988-04-12', '555-0101', 'opioids_fentanyl', 'high', 'active', 'active', 1, 'shelter', 'medicaid', nav1],
    ['Marcus', 'Bell', '1975-11-02', '555-0102', 'alcohol', 'moderate', 'active', 'none', 0, 'stable', 'uninsured', nav1],
    ['Tanya', 'Ortiz', '1993-07-23', '555-0103', 'methamphetamine', 'critical', 'active', 'interested', 1, 'unsheltered', 'medicaid', nav2],
    ['Robert', 'Kowalski', '1969-01-30', '555-0104', 'opioids_rx', 'moderate', 'active', 'referred', 1, 'doubled_up', 'medicare', nav2],
    ['Aisha', 'Freeman', '1999-09-09', '555-0105', 'opioids_fentanyl', 'high', 'waitlist', 'unknown', 0, 'unknown', 'pending', nav1],
    ['Luis', 'Herrera', '1982-03-15', '555-0106', 'cocaine', 'low', 'closed', 'none', 0, 'stable', 'private', nav1],
  ];
  const ids = [];
  clients.forEach(([fn, ln, dob, phone, sub, risk, status, mat, od, housing, ins, worker], i) => {
    const id = uuid(); ids.push(id);
    db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,last_name_idx,full_name_idx,dob_enc,dob_idx,phone_enc,phone_idx,address_enc,city,zip,gender,preferred_language,status,intake_date,primary_substance,risk_level,mat_status,overdose_history,naloxone_provided,housing_status,insurance,asam_level,referral_source,co_occurring_mh,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, `C${String(new Date().getFullYear()).slice(2)}-${String(i + 1).padStart(4, '0')}`, encrypt(fn), encrypt(ln), blindIndex(ln), blindIndex(ln + fn), encrypt(dob), blindIndex(dob), encrypt(phone), blindIndex(phone.replace(/\D/g, '')), encrypt('100 Demo St'), 'Springfield', '00000', i % 2 ? 'male' : 'female', 'English', status, day(120 - i * 15), sub, risk, mat, od, i % 2, housing, ins, ['2.1', '1.0', '3.5', 'OTP', 'unknown', '1.0'][i], ['emergency_dept', 'self', 'outreach', 'primary_care', 'jail', 'court_probation'][i], i % 3 === 0 ? 1 : 0, worker);
    db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, uuid(), id, worker, 'primary', day(120 - i * 15), sup);
    if (i < 3) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, uuid(), id, clin, 'clinician', day(100), sup);
  });
  const resources = [
    ['Riverside Recovery Center', 'residential', '555-0200', 'buprenorphine, naltrexone', 1, 1], ['County Opioid Treatment Program', 'mat_otp', '555-0201', 'methadone, buprenorphine', 1, 1], ['Hope Street Detox', 'detox_withdrawal_mgmt', '555-0202', '', 1, 1],
    ['Bridge Housing Collaborative', 'sober_living', '555-0203', '', 1, 0], ['Downtown Shelter', 'shelter', '555-0204', '', 0, 1], ['Community Harm Reduction Coalition', 'syringe_services', '555-0205', '', 0, 1],
    ['Valley Behavioral Health', 'mental_health', '555-0206', '', 1, 0], ['Second Chance Legal Aid', 'legal', '555-0207', '', 0, 1], ['Family Health Clinic (OBOT)', 'mat_obot', '555-0208', 'buprenorphine', 1, 1], ['Recovery Rides', 'transportation', '555-0209', '', 0, 1],
  ];
  const rids = resources.map(([name, cat, phone, mat, med, unins]) => { const id = uuid(); db.run(`INSERT INTO resources(id,name,category,phone,mat_offered,accepts_medicaid,accepts_uninsured,city,last_verified_at,services) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, name, cat, phone, mat || null, med, unins, 'Springfield', day(30), 'Demo resource'); return id; });
  const fund = uuid();
  db.run(`INSERT INTO funding_sources(id,name,source_type,grant_number,fiscal_year_start,fiscal_year_end,total_amount,restrictions) VALUES(?,?,?,?,?,?,?,?)`, fund, 'Opioid Settlement – Navigation FY26', 'opioid_settlement', 'OS-2026-014', `${new Date().getFullYear()}-07-01`, `${new Date().getFullYear() + 1}-06-30`, 180000, 'Abatement uses only; no indirect above 10%');
  const lines = { client_assistance: 25000, transportation: 8000, naloxone_supplies: 6000, housing_assistance: 30000, staffing: 100000, training: 3000 };
  const lineIds = {}; for (const [cat, amt] of Object.entries(lines)) { lineIds[cat] = uuid(); db.run(`INSERT INTO budget_lines(id,funding_source_id,category,label,allocated_amount) VALUES(?,?,?,?,?)`, lineIds[cat], fund, cat, null, amt); }
  const fund2 = uuid();
  db.run(`INSERT INTO funding_sources(id,name,source_type,fiscal_year_start,fiscal_year_end,total_amount) VALUES(?,?,?,?,?,?)`, fund2, 'SOR IV – Peer Support', 'sor_grant', `${new Date().getFullYear()}-01-01`, `${new Date().getFullYear()}-12-31`, 60000);
  // activity
  const types = C.INTERVENTION_TYPES;
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    const worker = clients[i][11];
    for (let k = 0; k < 6 + i; k++) {
      const off = Math.floor(Math.random() * 110); const type = types[(i * 3 + k * 5) % types.length]; const dur = 15 + ((k * 17) % 60);
      const iid = uuid();
      db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome,naloxone_kits,funding_source_id,summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, iid, ids[i], worker, type, d(off), dur, C.LOCATIONS[k % C.LOCATIONS.length], 'in_person', C.OUTCOMES[k % 4], type === 'naloxone_distribution' ? 2 : 0, fund, `Demo ${type.replace(/_/g, ' ')} contact`);
      db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,funding_source_id,intervention_id,description) VALUES(?,?,?,?,?,?,?,?,?)`, uuid(), worker, ids[i], d(off).slice(0, 10), dur, 'direct_service', fund, iid, type.replace(/_/g, ' '));
      n++;
    }
    for (let k = 0; k < 3; k++) db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,duration_minutes,contact_type,purpose,outcome,summary_enc) VALUES(?,?,?,?,?,?,?,?,?,?)`, uuid(), ids[i], worker, k % 2 ? 'inbound' : 'outbound', d(Math.floor(Math.random() * 60)), 5 + k * 4, 'client', 'Check-in', C.CALL_OUTCOMES[k % 3], encrypt('Demo call summary'));
    db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status,urgency,warm_handoff,admitted_at) VALUES(?,?,?,?,?,?,?,?,?)`, uuid(), ids[i], rids[i % rids.length], worker, d(40 - i * 3), C.REFERRAL_STATUSES[(i * 2) % 6], i === 2 ? 'urgent' : 'routine', i % 2, i % 3 === 0 ? d(30 - i * 3) : null);
    db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title,due_at,priority,status) VALUES(?,?,?,?,?,?,?,?)`, uuid(), ids[i], worker, worker, `Follow up with ${clients[i][0]} on ${['housing', 'MAT intake', 'ID documents', 'court date', 'insurance', 'recovery plan'][i]}`, d(i - 2), ['normal', 'high', 'urgent', 'normal', 'low', 'normal'][i], i === 5 ? 'done' : 'open');
    db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title,content_enc,occurred_at,status,signed_at,signed_by,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, uuid(), ids[i], worker, 'admin', 'contact', 'Outreach contact', encrypt('Met client at drop-in center. Discussed program services and next steps. (Demo data)'), d(20 + i), 'signed', d(20 + i), worker, 'manual');
    if (i < 3) db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title,content_enc,structured_enc,occurred_at,status,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, uuid(), ids[i], clin, 'clinical', 'SOAP', 'Clinical assessment', encrypt('S: Reports daily fentanyl use.\nO: Alert, oriented, mild withdrawal.\nA: OUD, severe.\nP: Warm handoff to OTP; naloxone provided. (Demo data)'), encrypt(JSON.stringify({ S: 'Reports daily fentanyl use.', O: 'Alert, oriented, mild withdrawal.', A: 'OUD, severe.', P: 'Warm handoff to OTP; naloxone provided.' })), d(15 + i), 'draft', 'manual');
    db.run(`INSERT INTO consents(id,client_id,type,recipient,purpose,scope,signed_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)`, uuid(), ids[i], 'part2_disclosure', 'County Opioid Treatment Program', 'Treatment coordination and referral', 'Referral summary, diagnosis, MAT status', day(60), day(-305 + i * 40), worker);
    db.run(`INSERT INTO expenditures(id,funding_source_id,budget_line_id,client_id,user_id,spent_at,amount,category,vendor,description,status,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, uuid(), fund, lineIds[i % 2 ? 'transportation' : 'client_assistance'], ids[i], worker, day(10 + i * 5), [45, 120.5, 300, 62, 18.75, 500][i], i % 2 ? 'transportation' : 'client_assistance', ['Metro Transit', 'Walgreens', 'Motel 6', 'DMV', 'Uber', 'Bridge Housing'][i], 'Demo client assistance', i < 4 ? 'approved' : 'pending', i < 4 ? sup : null, i < 4 ? d(5) : null);
  }
  audit.log({ user: { id: null, username: 'seed' }, action: 'seed.run', details: { clients: ids.length, interventions: n } });
  console.log(`Seeded ${ids.length} clients, ${n} interventions, ${resources.length} resources.`);
}
console.log(`Demo logins (password "${PW}"): mrivera (navigator), dchen (navigator), kpatel (clinician), jwalker (supervisor), afinance (finance), admin`);
db.close();
