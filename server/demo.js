'use strict';
// Fictional sample data so a new program can explore SUDS before entering real clients.
// Used by `npm run seed` (dev) and by the in-app "Load sample data" button (office and phone).
// Everything created here is tagged in the `demo_ids` setting so it can be removed in one click.
const db = require('./db');
const C = require('./constants');
const { encrypt, blindIndex, uuid } = require('./crypto');
const audit = require('./audit');

const DEMO_PREFIX = 'DEMO-';
const TABLES = ['expenditures', 'disclosures', 'consents', 'note_addenda', 'notes', 'tasks', 'referrals', 'time_entries', 'calls', 'interventions', 'assignments', 'clients', 'budget_lines', 'funding_sources', 'resources'];
const SYNCED = new Set(['expenditures', 'disclosures', 'consents', 'note_addenda', 'notes', 'tasks', 'referrals', 'time_entries', 'calls', 'interventions', 'assignments', 'clients', 'budget_lines', 'funding_sources', 'resources']);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function status() {
  const ids = JSON.parse(db.getSetting('demo_ids', 'null') || 'null');
  const counts = {}; let total = 0;
  if (ids) for (const [t, list] of Object.entries(ids)) { counts[t] = list.length; total += list.length; }
  return { loaded: !!ids, loaded_at: db.getSetting('demo_loaded_at', null), counts, total, clients_total: db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n };
}

const PEOPLE = [
  ['Jamie', 'Nguyen', 'Jay', 'they/them', '1988-04-12', 'opioids_fentanyl', 'xylazine', 'injected', 'critical', 'active', 'active', 'buprenorphine', 1, 'shelter', 'medicaid', '2.1', 'emergency_dept', 1, 1, 0, 'contemplation', 'Stay on bupe; get an ID; find a bed at Bridge Housing'],
  ['Marcus', 'Bell', null, 'he/him', '1975-11-02', 'alcohol', '', 'oral', 'moderate', 'active', 'none', null, 0, 'stable', 'uninsured', '1.0', 'self', 0, 0, 0, 'action', 'Keep the job; attend IOP three nights a week'],
  ['Tanya', 'Ortiz', 'T', 'she/her', '1993-07-23', 'methamphetamine', 'opioids_fentanyl', 'smoked', 'critical', 'active', 'interested', null, 1, 'unsheltered', 'medicaid', '3.5', 'outreach', 1, 1, 1, 'preparation', 'Detox bed then residential; reconnect with daughter'],
  ['Robert', 'Kowalski', 'Bob', 'he/him', '1969-01-30', 'opioids_rx', 'benzodiazepines', 'oral', 'moderate', 'active', 'referred', null, 1, 'doubled_up', 'medicare', 'OTP', 'primary_care', 0, 0, 1, 'action', 'Start methadone; manage chronic pain with the clinic'],
  ['Aisha', 'Freeman', null, 'she/her', '1999-09-09', 'opioids_fentanyl', '', 'snorted', 'high', 'waitlist', 'unknown', null, 0, 'unknown', 'pending', 'unknown', 'jail', 1, 0, 0, 'precontemplation', 'Meet after release; apply for Medicaid'],
  ['Luis', 'Herrera', null, 'he/him', '1982-03-15', 'cocaine', 'alcohol', 'snorted', 'low', 'closed', 'none', null, 0, 'stable', 'private', '1.0', 'court_probation', 1, 0, 0, 'maintenance', 'Completed program; monthly check-in call'],
  ['Danielle', 'Park', 'Dani', 'she/her', '1996-12-05', 'opioids_heroin', 'methamphetamine', 'injected', 'high', 'active', 'active', 'methadone', 1, 'transitional', 'medicaid', 'OTP', 'hospital_or_ed', 0, 1, 1, 'action', 'Daily dosing; prenatal care; housing application'],
  ['Samuel', 'Okafor', 'Sam', 'he/him', '1961-06-18', 'alcohol', 'nicotine', 'oral', 'high', 'active', 'none', null, 0, 'stable', 'medicare', '2.5', 'family', 0, 0, 1, 'contemplation', 'Reduce drinking; see cardiologist; grief support'],
  ['Brianna', 'Lopez', 'Bree', 'she/her', '2001-02-27', 'benzodiazepines', 'cannabis', 'oral', 'moderate', 'active', 'none', null, 0, 'stable', 'private', '1.0', 'school', 0, 0, 1, 'preparation', 'Taper with prescriber; finish semester'],
  ['Trevor', 'Miller', null, 'he/him', '1984-08-08', 'opioids_fentanyl', 'cocaine', 'smoked', 'critical', 'active', 'discontinued', 'buprenorphine', 1, 'unsheltered', 'medicaid', '3.7', 'outreach', 1, 0, 0, 'relapse', 'Restart bupe; naloxone on hand; shelter bed'],
  ['Grace', 'Whitfield', null, 'she/her', '1958-10-21', 'opioids_rx', '', 'oral', 'low', 'inactive', 'active', 'naltrexone', 0, 'stable', 'medicare', '1.0', 'primary_care', 0, 0, 0, 'maintenance', 'Monthly Vivitrol; stay connected to church group'],
  ['Andre', 'Jackson', 'Dre', 'he/him', '1990-05-14', 'methamphetamine', '', 'smoked', 'high', 'active', 'none', null, 1, 'jail', 'pending', '2.1', 'jail', 1, 0, 0, 'contemplation', 'Release planning; Medicaid; job program'],
];
const RESOURCES = [
  ['Riverside Recovery Center', 'residential', '555-0200', 'buprenorphine, naltrexone', 1, 1, 'Mon–Fri 8–5; intake line 24/7', '28-day residential; medically supervised. Adults 18+.', 'English, Spanish'],
  ['County Opioid Treatment Program', 'mat_otp', '555-0201', 'methadone, buprenorphine', 1, 1, 'Dosing 5:30am–11am daily', 'Methadone and buprenorphine; same-day intake Tue/Thu.', 'English, Spanish'],
  ['Hope Street Detox', 'detox_withdrawal_mgmt', '555-0202', '', 1, 1, '24/7', 'Social and medical detox; call for bed availability.', 'English'],
  ['Bridge Housing Collaborative', 'sober_living', '555-0203', '', 1, 0, 'Mon–Fri 9–4', 'Recovery housing; 30 days sober required.', 'English'],
  ['Downtown Shelter', 'shelter', '555-0204', '', 0, 1, 'Check-in 6pm', 'Emergency shelter; low-barrier; pets allowed.', 'English, Spanish'],
  ['Community Harm Reduction Coalition', 'syringe_services', '555-0205', '', 0, 1, 'Tue/Thu 1–5; mobile van Sat', 'Syringe services, naloxone, fentanyl test strips, wound care.', 'English, Spanish'],
  ['Valley Behavioral Health', 'mental_health', '555-0206', '', 1, 0, 'Mon–Fri 8–6', 'Outpatient mental health; co-occurring track.', 'English'],
  ['Second Chance Legal Aid', 'legal', '555-0207', '', 0, 1, 'Wed 10–2 walk-in', 'Expungement, warrants, benefits appeals.', 'English'],
  ['Family Health Clinic (OBOT)', 'mat_obot', '555-0208', 'buprenorphine', 1, 1, 'Mon–Sat 8–8', 'Office-based buprenorphine; telehealth follow-ups.', 'English, Spanish, Vietnamese'],
  ['Recovery Rides', 'transportation', '555-0209', '', 0, 1, 'Book 24h ahead', 'Free rides to treatment and court.', 'English'],
  ['Northside IOP', 'intensive_outpatient', '555-0210', '', 1, 0, 'Evenings Mon/Wed/Thu', 'Intensive outpatient; evening groups for working adults.', 'English'],
  ['County Crisis Line', 'crisis_line', '988', '', 1, 1, '24/7', 'Mobile crisis team dispatch.', 'English, Spanish'],
  ['Hands & Hearts Food Pantry', 'food', '555-0212', '', 0, 1, 'Sat 9–12', 'Groceries and hot meals; no ID required.', 'English'],
  ['WorkFirst Employment Services', 'employment', '555-0213', '', 0, 1, 'Mon–Fri 9–5', 'Job readiness, résumé help, fair-chance employers.', 'English, Spanish'],
  ['Recovery Café', 'recovery_community', '555-0214', '', 0, 1, 'Daily 10–6', 'Peer-led recovery community; meetings and meals.', 'English'],
];

/** staff: { workers: [ids], clinician?: id, supervisor: id, actor: id } */
function seed({ actor, workers, clinician = null, supervisor, seedValue = 42 }) {
  if (status().loaded) throw new Error('Sample data is already loaded');
  if (!workers || !workers.length) throw new Error('At least one worker is required');
  const rand = rng(seedValue);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const ids = {}; const track = (t, id) => { (ids[t] = ids[t] || []).push(id); return id; };
  const d = (off, hour = 10) => { const x = new Date(Date.now() - off * 86400000); x.setUTCHours(hour, Math.floor(rand() * 4) * 15, 0, 0); return x.toISOString(); };
  const day = (off) => d(off).slice(0, 10);
  const nowIso = db.now();

  db.transaction(() => {
    // Resources
    const rids = RESOURCES.map(([name, cat, phone, mat, med, unins, hours, services, langs]) => {
      const id = track('resources', uuid());
      db.run(`INSERT INTO resources(id,name,category,phone,mat_offered,accepts_medicaid,accepts_uninsured,city,hours,services,languages,last_verified_at,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, name, cat, phone, mat || null, med, unins, 'Springfield', hours, services, langs, day(Math.floor(rand() * 90)), 'Sample resource (fictional)');
      return id;
    });
    // Funding
    const y = new Date().getFullYear();
    const fund = track('funding_sources', uuid());
    db.run(`INSERT INTO funding_sources(id,name,source_type,grant_number,fiscal_year_start,fiscal_year_end,total_amount,restrictions) VALUES(?,?,?,?,?,?,?,?)`, fund, `Opioid Settlement – Navigation FY${String(y + 1).slice(2)}`, 'opioid_settlement', 'OS-2026-014', `${y}-07-01`, `${y + 1}-06-30`, 180000, 'Abatement uses only; no indirect above 10%');
    const lines = { client_assistance: 25000, transportation: 8000, naloxone_supplies: 6000, housing_assistance: 30000, staffing: 100000, training: 3000, ids_documents: 2000, phones_communication: 3000, outreach_materials: 3000 };
    const lineIds = {}; for (const [cat, amt] of Object.entries(lines)) { lineIds[cat] = track('budget_lines', uuid()); db.run(`INSERT INTO budget_lines(id,funding_source_id,category,label,allocated_amount) VALUES(?,?,?,?,?)`, lineIds[cat], fund, cat, null, amt); }
    const fund2 = track('funding_sources', uuid());
    db.run(`INSERT INTO funding_sources(id,name,source_type,grant_number,fiscal_year_start,fiscal_year_end,total_amount,restrictions) VALUES(?,?,?,?,?,?,?,?)`, fund2, 'SOR IV – Peer Support', 'sor_grant', 'SOR-4-0087', `${y}-01-01`, `${y}-12-31`, 60000, 'Peer support and recovery housing only');
    for (const [cat, amt] of [['staffing', 45000], ['housing_assistance', 10000], ['peer_support', 5000]]) { const id = track('budget_lines', uuid()); db.run(`INSERT INTO budget_lines(id,funding_source_id,category,label,allocated_amount) VALUES(?,?,?,?,?)`, id, fund2, C.BUDGET_CATEGORIES.includes(cat) ? cat : 'other', cat === 'peer_support' ? 'Peer support stipends' : null, amt); }

    // Clients
    const cids = [];
    PEOPLE.forEach((p, i) => {
      const [fn, ln, pref, pron, dob, sub, sub2, route, risk, cstatus, mat, matMed, od, housing, ins, asam, refSrc, justice, preg, mh, stage, goals] = p;
      const worker = workers[i % workers.length];
      const id = track('clients', uuid()); cids.push({ id, worker, fn, ln, risk, cstatus, sub, stage, od, mat });
      const phone = `555-01${String(i + 1).padStart(2, '0')}`;
      const intake = 150 - i * 11;
      db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,last_name_idx,full_name_idx,preferred_name_enc,dob_enc,dob_idx,phone_enc,phone_idx,email_enc,address_enc,city,zip,gender,pronouns,preferred_language,status,intake_date,discharge_date,discharge_reason,primary_substance,secondary_substances,route_of_use,risk_level,mat_status,mat_medication,overdose_history,last_overdose_date,naloxone_provided,naloxone_last_date,housing_status,insurance,asam_level,referral_source,justice_involved,pregnant_or_parenting,co_occurring_mh,goals,flags,ok_to_text,ok_to_voicemail,created_by,created_at) VALUES(${Array(45).fill('?').join(',')})`,
        id, `${DEMO_PREFIX}${String(i + 1).padStart(4, '0')}`, encrypt(fn), encrypt(ln), blindIndex(ln), blindIndex(ln + fn), pref ? encrypt(pref) : null, encrypt(dob), blindIndex(dob), encrypt(phone), blindIndex(phone.replace(/\D/g, '')), i % 3 === 0 ? encrypt(`${fn.toLowerCase()}.${ln.toLowerCase()}@example.com`) : null, encrypt(`${100 + i * 7} Demo St, Apt ${i + 1}`), 'Springfield', '00000', pron.startsWith('he') ? 'male' : pron.startsWith('she') ? 'female' : 'nonbinary', pron, i === 8 ? 'Spanish' : 'English', cstatus, day(intake), cstatus === 'closed' ? day(20) : null, cstatus === 'closed' ? 'completed' : null, sub, sub2 || null, route, risk, mat, matMed, od, od ? day(intake + 5) : null, od ? 1 : 0, od ? day(Math.floor(rand() * 40)) : null, housing, ins, asam, refSrc, justice, preg, mh, goals, i === 2 ? 'safety_plan' : i === 9 ? 'no_home_visits' : null, i % 2, i % 3 ? 1 : 0, actor, d(intake, 9));
      db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, track('assignments', uuid()), id, worker, 'primary', day(intake), supervisor);
      if (clinician && i % 2 === 0) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, track('assignments', uuid()), id, clinician, 'clinician', day(intake - 3), supervisor);
      if (workers.length > 1 && i % 4 === 1) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, track('assignments', uuid()), id, workers[(i + 1) % workers.length], 'secondary', day(intake - 10), supervisor);
    });

    // Activity per client
    const SUMMARIES = {
      outreach: 'Met at the drop-in center. Talked about program services and what would help most this week.', screening_sbirt: 'Completed AUDIT/DAST screening; discussed results and options.', assessment: 'Completed ASAM-based level of care assessment.', intake: 'Completed intake paperwork, consents and releases.',
      care_coordination: 'Coordinated with treatment provider about intake date and paperwork.', warm_handoff: 'Accompanied client to the appointment and introduced them to staff.', referral: 'Made referral and set a follow-up date.', case_management: 'Reviewed goals and barriers; updated recovery plan.',
      harm_reduction: 'Discussed safer use; provided fentanyl test strips and wound care supplies.', naloxone_distribution: 'Provided naloxone kit and reviewed how to use it.', peer_support: 'Peer check-in; shared recovery meeting options.', crisis_response: 'Responded to crisis call; client is safe; safety plan updated.',
      post_overdose_follow_up: 'Follow-up after ED visit for overdose; offered MAT and naloxone.', transport: 'Drove client to appointment.', housing_assistance: 'Completed housing application and gathered documents.', benefits_enrollment: 'Submitted Medicaid application.',
    };
    const NOTE_BODIES = [
      ['contact', 'Outreach contact', 'Met client at drop-in. Client engaged and asked about MAT options. Gave naloxone and clinic hours. Will follow up Thursday.'],
      ['progress', 'Weekly progress', 'Client attended two groups this week and reports no use for 9 days. Reviewed triggers around weekends. Continue weekly contact.'],
      ['contact', 'Phone check-in', 'Reached client by phone. Doing okay; needs a ride to Tuesday intake. Booked Recovery Rides.'],
      ['collateral', 'Collateral: family', 'Spoke with client’s mother (ROI on file). She reports client is staying with her and sleeping better. Shared crisis line number.'],
    ];
    let counts = { interventions: 0, calls: 0, notes: 0 };
    cids.forEach((c, i) => {
      const n = c.cstatus === 'closed' ? 6 : c.cstatus === 'waitlist' ? 2 : 8 + Math.floor(rand() * 7);
      const types = ['outreach', 'case_management', 'care_coordination', 'harm_reduction', 'naloxone_distribution', 'referral', 'warm_handoff', 'transport', 'peer_support', 'housing_assistance', 'benefits_enrollment', 'screening_sbirt', 'post_overdose_follow_up', 'crisis_response'];
      for (let k = 0; k < n; k++) {
        const off = Math.floor(rand() * 140); const type = k === 0 ? 'intake' : k === 1 ? 'assessment' : pick(types); const dur = 15 + Math.floor(rand() * 8) * 10;
        const loc = type === 'transport' ? 'community' : type === 'outreach' ? pick(['field', 'shelter', 'community']) : type === 'crisis_response' ? pick(['emergency_dept', 'home', 'phone']) : pick(['office', 'field', 'home', 'treatment_facility']);
        const iid = track('interventions', uuid());
        db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome,stage_of_change,naloxone_kits,fentanyl_strips,funding_source_id,summary,follow_up_due,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          iid, c.id, c.worker, type, d(off), dur, loc, loc === 'phone' ? 'phone' : 'in_person', rand() < 0.8 ? 'completed' : pick(['partial', 'no_show', 'rescheduled', 'unable_to_locate']), c.stage, type === 'naloxone_distribution' ? 1 + Math.floor(rand() * 2) : 0, type === 'harm_reduction' ? 5 : 0, fund, SUMMARIES[type] || `${type.replace(/_/g, ' ')} contact`, rand() < 0.3 ? day(-Math.floor(rand() * 10)) : null, d(off, 16));
        db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,funding_source_id,intervention_id,description) VALUES(?,?,?,?,?,?,?,?,?)`, track('time_entries', uuid()), c.worker, c.id, day(off), dur, type === 'transport' ? 'travel' : type === 'care_coordination' ? 'care_coordination' : type === 'outreach' ? 'outreach' : 'direct_service', fund, iid, type.replace(/_/g, ' '));
        counts.interventions++;
      }
      const nc = c.cstatus === 'waitlist' ? 1 : 3 + Math.floor(rand() * 4);
      for (let k = 0; k < nc; k++) {
        const ct = pick(['client', 'client', 'client', 'family', 'provider', 'agency', 'pharmacy']);
        const out = pick(C.CALL_OUTCOMES.slice(0, 4));
        db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,duration_minutes,contact_type,contact_name_enc,purpose,outcome,crisis,follow_up_needed,follow_up_due,summary_enc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('calls', uuid()), c.id, c.worker, rand() < 0.5 ? 'inbound' : 'outbound', d(Math.floor(rand() * 90), 9 + Math.floor(rand() * 8)), out === 'reached' ? 5 + Math.floor(rand() * 20) : 1, ct, ct === 'family' ? encrypt('Mother') : ct === 'provider' ? encrypt('OTP intake nurse') : null, pick(['Check-in', 'Appointment reminder', 'Referral follow-up', 'Benefits question', 'Housing update']), out, 0, out !== 'reached' ? 1 : 0, out !== 'reached' ? day(-1) : null, encrypt(out === 'reached' ? 'Talked through next steps; client will call back if anything changes.' : 'Left message asking client to call back.'));
        counts.calls++;
      }
      // Referrals
      const nr = c.cstatus === 'waitlist' ? 1 : 2 + Math.floor(rand() * 2);
      for (let k = 0; k < nr; k++) {
        const rid = rids[(i * 3 + k * 5) % rids.length]; const st = k === 0 ? pick(['admitted', 'scheduled', 'accepted', 'completed']) : pick(C.REFERRAL_STATUSES); const off = 10 + Math.floor(rand() * 100);
        db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status,urgency,appointment_at,admitted_at,closed_at,outcome,barrier,warm_handoff,follow_up_due,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('referrals', uuid()), c.id, rid, c.worker, d(off), st, c.risk === 'critical' ? 'urgent' : 'routine', ['scheduled', 'admitted', 'completed'].includes(st) ? d(off - 3) : null, ['admitted', 'completed'].includes(st) ? d(off - 5) : null, ['completed', 'closed', 'declined_by_client', 'declined_by_provider'].includes(st) ? d(off - 12) : null, st === 'completed' ? 'Completed program' : null, ['waitlisted', 'declined_by_provider'].includes(st) ? pick(['no beds', 'insurance', 'transportation']) : null, rand() < 0.5 ? 1 : 0, ['pending', 'contacted', 'waitlisted'].includes(st) ? day(-2) : null, null);
      }
      // Tasks
      const TASKS = [['Call about detox bed', 'urgent', -1], ['Bring ID paperwork to DMV', 'high', 1], ['Confirm OTP intake time', 'high', 0], ['Housing application follow-up', 'normal', 4], ['Send ROI to Valley Behavioral', 'normal', 2], ['Monthly check-in call', 'low', 12], ['Naloxone refill', 'normal', -3]];
      const nt = c.cstatus === 'closed' ? 1 : 2 + Math.floor(rand() * 2);
      for (let k = 0; k < nt; k++) { const [title, pri, dueOff] = TASKS[(i + k * 2) % TASKS.length]; const done = c.cstatus === 'closed' || rand() < 0.3; db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title,description,due_at,priority,status,is_milestone,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, track('tasks', uuid()), c.id, c.worker, k === 0 ? supervisor : c.worker, title, null, d(-dueOff), pri, done ? 'done' : 'open', title.includes('intake') ? 1 : 0, done ? d(1) : null); }
      // Notes
      const nn = c.cstatus === 'waitlist' ? 1 : 2 + Math.floor(rand() * 3);
      for (let k = 0; k < nn; k++) { const [fmtName, title, body] = NOTE_BODIES[(i + k) % NOTE_BODIES.length]; const off = 5 + Math.floor(rand() * 100); const signed = k > 0 || rand() < 0.5; db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title,content_enc,occurred_at,status,signed_at,signed_by,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('notes', uuid()), c.id, c.worker, 'admin', fmtName, title, encrypt(body + ' (Sample data)'), d(off), signed ? 'signed' : 'draft', signed ? d(off, 17) : null, signed ? c.worker : null, 'manual', d(off, 17), d(off, 17)); counts.notes++; }
      if (clinician && i % 2 === 0) {
        const S = `Reports ${c.sub.replace(/_/g, ' ')} use ${pick(['daily', 'most days', 'on weekends'])}; motivated by ${pick(['family', 'health', 'housing', 'court'])}.`; const O = 'Alert and oriented; mild withdrawal symptoms; PHQ-9 = 12.'; const A = `${c.sub.startsWith('opioid') ? 'Opioid' : 'Substance'} use disorder, ${c.risk === 'critical' ? 'severe' : 'moderate'}; stage of change: ${c.stage}.`; const P = 'Continue navigation contacts weekly; MAT referral; naloxone on hand; reassess in 30 days.';
        db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title,content_enc,structured_enc,occurred_at,status,signed_at,signed_by,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('notes', uuid()), c.id, clinician, 'clinical', i % 4 === 0 ? 'SOAP' : 'DAP', 'Clinical assessment', encrypt(i % 4 === 0 ? `S: ${S}\nO: ${O}\nA: ${A}\nP: ${P} (Sample data)` : `D: ${S} ${O}\nA: ${A}\nP: ${P} (Sample data)`), encrypt(JSON.stringify(i % 4 === 0 ? { S, O, A, P } : { D: `${S} ${O}`, A, P })), d(30 + i), i % 4 === 0 ? 'signed' : 'draft', i % 4 === 0 ? d(30 + i, 18) : null, i % 4 === 0 ? clinician : null, 'manual', d(30 + i, 18), d(30 + i, 18)); counts.notes++;
      }
      // Consents & disclosures
      const consentId = track('consents', uuid());
      db.run(`INSERT INTO consents(id,client_id,type,recipient,purpose,scope,signed_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)`, consentId, c.id, 'part2_disclosure', 'County Opioid Treatment Program', 'Treatment coordination and referral', 'Referral summary, diagnosis, MAT status', day(60 + i), day(i === 3 ? 5 : i === 5 ? -10 : -300 + i * 20), c.worker);
      if (i % 3 === 0) db.run(`INSERT INTO consents(id,client_id,type,recipient,purpose,scope,signed_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)`, track('consents', uuid()), c.id, 'roi', 'Family member (mother)', 'Care coordination with family', 'Appointment dates and general progress', day(50 + i), day(-315), c.worker);
      if (i % 2 === 0) db.run(`INSERT INTO disclosures(id,client_id,consent_id,disclosed_to,purpose,info_disclosed,method,disclosed_at,disclosed_by,basis) VALUES(?,?,?,?,?,?,?,?,?,?)`, track('disclosures', uuid()), c.id, consentId, 'County Opioid Treatment Program', 'Referral for MAT intake', 'Referral summary and MAT status', 'fax', d(40 + i), c.worker, 'consent');
      // Expenditures
      const EXP = [['transportation', 'Metro Transit', 'Bus pass (monthly)', 45], ['client_assistance', 'Walgreens', 'Hygiene kit and phone charger', 32.18], ['housing_assistance', 'Motel 6', 'Emergency motel, 3 nights', 267], ['ids_documents', 'DMV', 'State ID fee', 28], ['client_assistance', 'Uber', 'Ride to intake appointment', 18.75], ['phones_communication', 'Metro PCS', 'Prepaid phone (recovery contact)', 40], ['naloxone_supplies', 'Harm Reduction Coalition', 'Naloxone kits (5)', 150]];
      const ne = c.cstatus === 'waitlist' ? 0 : 1 + Math.floor(rand() * 3);
      for (let k = 0; k < ne; k++) { const [cat, vendor, desc, amt] = EXP[(i + k * 3) % EXP.length]; const st = k === 0 ? 'approved' : pick(['pending', 'approved', 'reimbursed']); db.run(`INSERT INTO expenditures(id,funding_source_id,budget_line_id,client_id,user_id,spent_at,amount,category,vendor,description,status,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('expenditures', uuid()), fund, lineIds[cat] || lineIds.client_assistance, c.id, c.worker, day(5 + Math.floor(rand() * 80)), amt, cat, vendor, desc, st, st === 'pending' ? null : supervisor, st === 'pending' ? null : d(3)); }
    });
    // Non-client time (meetings, documentation, training) for each worker
    for (const w of workers) for (let k = 0; k < 10; k++) { const cat = pick(['documentation', 'meeting', 'travel', 'training', 'supervision', 'admin', 'outreach']); db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,funding_source_id,description) VALUES(?,?,?,?,?,?,?,?)`, track('time_entries', uuid()), w, null, day(Math.floor(rand() * 60)), 30 + Math.floor(rand() * 6) * 15, cat, cat === 'training' ? fund2 : fund, { documentation: 'Charting and note sign-off', meeting: 'Weekly team huddle', travel: 'Drive between sites', training: 'Naloxone train-the-trainer', supervision: 'Supervision with program manager', admin: 'Data entry for monthly report', outreach: 'Encampment outreach walk' }[cat]); }
    // Program-level expenditures
    for (const [cat, vendor, desc, amt] of [['naloxone_supplies', 'Harm Reduction Coalition', 'Naloxone kits (50)', 1500], ['outreach_materials', 'PrintPro', 'Outreach flyers and cards', 220], ['training', 'State Peer Academy', 'Peer certification course', 650]]) db.run(`INSERT INTO expenditures(id,funding_source_id,budget_line_id,user_id,spent_at,amount,category,vendor,description,status,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, track('expenditures', uuid()), fund, lineIds[cat], workers[0], day(20 + Math.floor(rand() * 60)), amt, cat, vendor, desc, 'approved', supervisor, d(15));

    db.setSetting('demo_ids', JSON.stringify(ids)); db.setSetting('demo_loaded_at', nowIso);
    audit.log({ user: actor ? { id: actor, username: 'sample-data' } : { id: null, username: 'seed' }, action: 'demo.load', details: { clients: cids.length, ...counts } });
  });
  return status();
}

function remove({ actor, tombstones = true } = {}) {
  const ids = JSON.parse(db.getSetting('demo_ids', 'null') || 'null');
  if (!ids) return { removed: 0 };
  let removed = 0;
  db.transaction(() => {
    for (const t of TABLES) {
      for (const id of ids[t] || []) {
        const r = db.run(`DELETE FROM ${t} WHERE id=?`, id);
        if (r && r.changes) removed += r.changes;
        if (tombstones && SYNCED.has(t)) db.tombstone(t, id);
      }
    }
    db.run(`DELETE FROM settings WHERE key IN ('demo_ids','demo_loaded_at')`);
    audit.log({ user: actor ? { id: actor, username: 'sample-data' } : { id: null, username: 'seed' }, action: 'demo.remove', details: { removed } });
  });
  return { removed };
}

/** Chooses which existing staff carry the sample caseload: the requesting user plus other active workers. */
function staffFor(user) {
  const active = db.all(`SELECT id, role FROM users WHERE is_active=1 AND role IN ('admin','supervisor','clinician','navigator')`);
  const byRole = (r) => active.filter(u => u.role === r).map(u => u.id);
  let workers = [...byRole('navigator'), ...byRole('clinician').slice(0, 1)];
  if (!workers.includes(user.id) && user.role !== 'finance' && user.role !== 'readonly') workers.unshift(user.id);
  if (!workers.length) workers = [user.id];
  const clinician = byRole('clinician')[0] || null;
  const supervisor = byRole('supervisor')[0] || byRole('admin')[0] || user.id;
  return { actor: user.id, workers: workers.slice(0, 4), clinician, supervisor };
}

module.exports = { seed, remove, status, staffFor, DEMO_PREFIX };
