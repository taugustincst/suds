'use strict';
// Fictional sample data so a new program can explore SUDS before entering real clients.
// Used by `npm run seed` (dev) and by the in-app "Load sample data" button (office and phone).
// Everything created here is tagged in the `demo_ids` setting so it can be removed in one click.
const db = require('./db');
const C = require('./constants');
const { encrypt, blindIndex, uuid } = require('./crypto');
const M = require('./clients-model');
const audit = require('./audit');

const DEMO_PREFIX = 'DEMO-';
const TABLES = ['client_form_files', 'client_forms', 'form_templates', 'expenditures', 'disclosures', 'consents', 'note_addenda', 'notes', 'tasks', 'referrals', 'time_entries', 'calls', 'interventions', 'episodes', 'assignments', 'clients', 'budget_lines', 'funding_sources', 'resource_photos', 'resources', 'supply_stock'];
const SYNCED = new Set(['client_form_files', 'client_forms', 'form_templates', 'expenditures', 'disclosures', 'consents', 'note_addenda', 'notes', 'tasks', 'referrals', 'time_entries', 'calls', 'interventions', 'episodes', 'assignments', 'clients', 'budget_lines', 'funding_sources', 'resource_photos', 'resources', 'supply_stock']);

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
  // name, category, phone, mat, medicaid, uninsured, hours, services, languages, summary, service_tags, levels_of_care, populations, intake_process, cost_notes, photos
  ['Riverside Recovery Center', 'residential', '555-0200', 'buprenorphine, naltrexone', 1, 1, 'Mon–Fri 8–5; intake line 24/7', '28-day residential; medically supervised. Adults 18+.', 'English, Spanish',
    'A 42-bed residential program on the river with medical staff on site around the clock. Clients start with a medical assessment and, if needed, medically supervised withdrawal, then move into a structured 28-day program of group and individual counseling, MAT (buprenorphine or naltrexone), family sessions and discharge planning. Most clients step down to Northside IOP or Bridge Housing.',
    'residential,detox,mat_buprenorphine,mat_naltrexone,individual_counseling,group_counseling,family_program,co_occurring,aftercare,spanish_speaking', '3.5, 3.7', 'adults,women,men,justice_involved', 'Call the intake line any time; a nurse screens by phone in about 20 minutes. Bring ID and insurance card if you have them; neither is required to be admitted. Beds are usually available within 1–3 days.', 'Medicaid and most commercial plans; county-funded beds for uninsured residents.', 3],
  ['County Opioid Treatment Program', 'mat_otp', '555-0201', 'methadone, buprenorphine', 1, 1, 'Dosing 5:30am–11am daily', 'Methadone and buprenorphine; same-day intake Tue/Thu.', 'English, Spanish',
    'The county\'s licensed opioid treatment program. Daily observed methadone or buprenorphine dosing with take-home doses earned over time, plus counseling, peer support and on-site naloxone. Same-day intake on Tuesdays and Thursdays for anyone who arrives before 9am.',
    'mat_methadone,mat_buprenorphine,medication_management,individual_counseling,group_counseling,peer_support,naloxone,same_day_intake,walk_in,spanish_speaking', 'OTP', 'adults,pregnant_parenting,justice_involved', 'Walk in Tue/Thu before 9am with a photo ID if possible. A navigator warm handoff speeds things up: call the intake nurse the day before.', 'Medicaid covers dosing in full; sliding scale for uninsured (about $15/week).', 2],
  ['Hope Street Detox', 'detox_withdrawal_mgmt', '555-0202', '', 1, 1, '24/7', 'Social and medical detox; call for bed availability.', 'English',
    'Short-stay (3–7 day) withdrawal management with nursing 24/7 and a physician on call. Comfort medications for opioid, alcohol and benzodiazepine withdrawal. Staff connect every client to a next step before discharge.',
    'detox,medical_care,naloxone,crisis_24_7,aftercare', '3.2, 3.7', 'adults', 'Call for bed availability; if a bed is open the client can come the same day. Ambulance or navigator transport is fine.', 'No cost to county residents.', 2],
  ['Bridge Housing Collaborative', 'sober_living', '555-0203', '', 1, 0, 'Mon–Fri 9–4', 'Recovery housing; 30 days sober required.', 'English',
    'Shared recovery homes (2–3 people per room) with house managers, weekly house meetings and required recovery-meeting attendance. Residents may stay up to 12 months while they work, study or attend treatment.',
    'sober_living,housing,peer_support,employment,aftercare', '', 'adults,men,women', 'Application plus a short interview; 30 days of sobriety and a referral from a treatment provider or navigator are required.', 'Rent $450/month; first month can be covered by the housing assistance line.', 2],
  ['Downtown Shelter', 'shelter', '555-0204', '', 0, 1, 'Check-in 6pm', 'Emergency shelter; low-barrier; pets allowed.', 'English, Spanish',
    'Low-barrier overnight shelter with 120 beds, showers, lockers and a hot dinner. Sobriety is not required. Case managers on site help with IDs, benefits and housing applications.', 'housing,case_management,walk_in,harm_reduction,naloxone', '', 'adults,unhoused,veterans', 'Walk in at 6pm; no referral needed.', 'Free.', 1],
  ['Community Harm Reduction Coalition', 'syringe_services', '555-0205', '', 0, 1, 'Tue/Thu 1–5; mobile van Sat', 'Syringe services, naloxone, fentanyl test strips, wound care.', 'English, Spanish',
    'Peer-run harm reduction center and mobile van. Free naloxone, fentanyl and xylazine test strips, safer-use supplies, wound care by a nurse, HIV/HCV testing and a warm, no-judgment place to sit down.', 'harm_reduction,naloxone,syringe_services,medical_care,peer_support,walk_in,spanish_speaking', '', 'adults,unhoused,lgbtq', 'No referral or ID needed. The van schedule is posted on their website weekly.', 'Free.', 2],
  ['Valley Behavioral Health', 'mental_health', '555-0206', '', 1, 0, 'Mon–Fri 8–6', 'Outpatient mental health; co-occurring track.', 'English',
    'Community mental health center with psychiatry, therapy and a co-occurring disorders track for people managing both substance use and mental health conditions. Telehealth available.', 'mental_health,co_occurring,medication_management,individual_counseling,group_counseling,telehealth,trauma_informed', '1.0', 'adults,adolescents,families', 'Phone intake, then an assessment within two weeks. Navigators can request an expedited slot for clients leaving detox or jail.', 'Medicaid and commercial insurance; county contract covers uninsured residents.', 1],
  ['Second Chance Legal Aid', 'legal', '555-0207', '', 0, 1, 'Wed 10–2 walk-in', 'Expungement, warrants, benefits appeals.', 'English',
    'Free civil legal help for people in recovery: expungement, clearing warrants, driver\'s license reinstatement, benefits appeals and landlord issues.', 'legal_help,walk_in', '', 'adults,justice_involved', 'Walk in Wednesdays or call for an appointment.', 'Free.', 1],
  ['Family Health Clinic (OBOT)', 'mat_obot', '555-0208', 'buprenorphine', 1, 1, 'Mon–Sat 8–8', 'Office-based buprenorphine; telehealth follow-ups.', 'English, Spanish, Vietnamese',
    'Primary care clinic that prescribes buprenorphine as part of regular medical care, so clients can get their MAT, blood pressure and prenatal care in one place. Telehealth follow-ups after the first visit.', 'mat_buprenorphine,medical_care,telehealth,medication_management,spanish_speaking', '1.0', 'adults,pregnant_parenting,families', 'Call for a same-week new-patient visit; bring a medication list. A navigator can attend the first visit.', 'Medicaid, Medicare and commercial plans; sliding scale for uninsured.', 2],
  ['Recovery Rides', 'transportation', '555-0209', '', 0, 1, 'Book 24h ahead', 'Free rides to treatment and court.', 'English',
    'Volunteer drivers give free rides to treatment appointments, court dates, dosing and recovery meetings within the county.', 'transportation', '', 'adults', 'Book by phone or online at least 24 hours ahead; same-day rides when a driver is free.', 'Free.', 1],
  ['Northside IOP', 'intensive_outpatient', '555-0210', '', 1, 0, 'Evenings Mon/Wed/Thu', 'Intensive outpatient; evening groups for working adults.', 'English',
    'Nine hours a week of evening group therapy plus a weekly individual session, designed for people who work or care for children during the day. Eight to twelve weeks, followed by an aftercare group.', 'intensive_outpatient,group_counseling,individual_counseling,aftercare,family_program', '2.1', 'adults,men,women', 'Phone screening, then an assessment within a week. Referrals from residential programs are prioritised.', 'Medicaid and commercial insurance.', 2],
  ['County Crisis Line', 'crisis_line', '988', '', 1, 1, '24/7', 'Mobile crisis team dispatch.', 'English, Spanish',
    'Call or text 988 any time. Counselors can dispatch the mobile crisis team, which comes to the person instead of sending police, and can arrange a same-day crisis bed.', 'crisis_24_7,mental_health,co_occurring,spanish_speaking', '', 'adults,adolescents', 'Call or text 988.', 'Free.', 0],
  ['Hands & Hearts Food Pantry', 'food', '555-0212', '', 0, 1, 'Sat 9–12', 'Groceries and hot meals; no ID required.', 'English',
    'Weekly groceries, hot meals on Saturdays and hygiene supplies. No ID or paperwork.', 'walk_in', '', 'adults,families,unhoused', 'Walk in Saturday mornings.', 'Free.', 1],
  ['WorkFirst Employment Services', 'employment', '555-0213', '', 0, 1, 'Mon–Fri 9–5', 'Job readiness, résumé help, fair-chance employers.', 'English, Spanish',
    'Job-readiness classes, résumé and interview help and a network of fair-chance employers who hire people with records. Paid work-experience placements for people in recovery.', 'employment,peer_support,spanish_speaking', '', 'adults,justice_involved', 'Orientation every Monday at 9am; no referral needed.', 'Free.', 1],
  ['Recovery Café', 'recovery_community', '555-0214', '', 0, 1, 'Daily 10–6', 'Peer-led recovery community; meetings and meals.', 'English',
    'A membership-based recovery community: meals, meetings, art and music groups, and peer recovery coaches. Members commit to 24 hours of sobriety before each visit and to a weekly recovery circle.', 'peer_support,walk_in,aftercare,employment', '', 'adults,lgbtq,unhoused', 'Drop in for a tour any day; membership starts after a short orientation.', 'Free; members volunteer a few hours a month.', 2],
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
    const png = require('./png');
    const rids = RESOURCES.map(([name, cat, phone, mat, med, unins, hours, services, langs, summary, tags, loc, pops, intake, cost, nPhotos], ri) => {
      const id = track('resources', uuid());
      db.run(`INSERT INTO resources(id,name,category,phone,mat_offered,accepts_medicaid,accepts_uninsured,address,city,zip,hours,services,languages,summary,service_tags,levels_of_care,populations,intake_process,cost_notes,website,last_verified_at,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, name, cat, phone, mat || null, med, unins, `${200 + ri * 40} Sample Ave`, 'Springfield', '00000', hours, services, langs, summary, tags, loc || null, pops || null, intake, cost, `https://example.org/${name.toLowerCase().replace(/[^a-z]+/g, '-')}`, day(Math.floor(rand() * 90)), 'Sample resource (fictional)');
      // placeholder pictures (drawn, not real photographs)
      const captions = ['Main entrance', 'Group room', 'Reception and waiting area'];
      for (let k = 0; k < (nPhotos || 0); k++) {
        const full = png.placeholder(640, 400, ri * 7 + k + 1, ri + k); const thumb = png.placeholder(240, 150, ri * 7 + k + 1, ri + k);
        db.run(`INSERT INTO resource_photos(id,resource_id,caption,content_type,bytes,width,height,data_b64,thumb_b64,sort_order,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, track('resource_photos', uuid()), id, captions[k] + ' (sample picture)', 'image/png', full.length, 640, 400, full.toString('base64'), thumb.toString('base64'), k, actor);
      }
      return id;
    });
    // Funding
    const y = new Date().getFullYear();
    const fundStart = `${y}-07-01`; // the settlement fund's fiscal year; work before it is not charged to it
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
      db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,last_name_idx,full_name_idx,name_prefix_idx,name_phonetic_idx,first_name_idx,first_name_prefix_idx,preferred_name_enc,dob_enc,dob_idx,phone_enc,phone_idx,email_enc,address_enc,city,zip,gender,pronouns,preferred_language,status,intake_date,discharge_date,discharge_reason,primary_substance,secondary_substances,route_of_use,risk_level,mat_status,mat_medication,overdose_history,last_overdose_date,naloxone_provided,naloxone_last_date,housing_status,insurance,asam_level,referral_source,justice_involved,pregnant_or_parenting,co_occurring_mh,goals_enc,flags_enc,ok_to_text,ok_to_voicemail,created_by,created_at) VALUES(${Array(49).fill('?').join(',')})`,
        id, `${DEMO_PREFIX}${String(i + 1).padStart(4, '0')}`, encrypt(fn), encrypt(ln), blindIndex(ln), blindIndex(ln + fn), M.namePrefixIndex(ln), M.namePhoneticIndex(ln), blindIndex(fn.trim().toLowerCase()), M.namePrefixIndex(fn), pref ? encrypt(pref) : null, encrypt(dob), blindIndex(dob), encrypt(phone), blindIndex(phone.replace(/\D/g, '')), i % 3 === 0 ? encrypt(`${fn.toLowerCase()}.${ln.toLowerCase()}@example.com`) : null, encrypt(`${100 + i * 7} Demo St, Apt ${i + 1}`), 'Springfield', '00000', pron.startsWith('he') ? 'male' : pron.startsWith('she') ? 'female' : 'nonbinary', pron, i === 8 ? 'Spanish' : 'English', cstatus, day(intake), cstatus === 'closed' ? day(20) : null, cstatus === 'closed' ? 'completed' : null, sub, sub2 || null, route, risk, mat, matMed, od, od ? day(intake + 5) : null, od ? 1 : 0, od ? day(Math.floor(rand() * 40)) : null, housing, ins, asam, refSrc, justice, preg, mh, encrypt(goals), encrypt(i === 2 ? 'safety_plan' : i === 9 ? 'no_home_visits' : ''), i % 2, i % 3 ? 1 : 0, actor, d(intake, 9));
      db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, track('assignments', uuid()), id, worker, 'primary', day(intake), supervisor);
      // Every admitted person has an episode of care: open while they are served, closed with the discharge.
      // Someone on the waitlist has not started yet, so has none.
      if (cstatus !== 'waitlist') {
        const closed = cstatus === 'closed';
        db.run(`INSERT INTO episodes(id,client_id,opened_at,opened_by,referral_source,closed_at,closed_by,discharge_reason,discharge_disposition,discharge_summary_enc,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          track('episodes', uuid()), id, day(intake), worker, refSrc, closed ? day(20) : null, closed ? supervisor : null, closed ? 'completed' : null, closed ? 'Monthly recovery check-in calls' : null, closed ? encrypt('Completed navigation goals; connected to outpatient care and stable housing. (Sample data)') : null, closed ? 'closed' : 'open');
      }
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
        db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome,stage_of_change,naloxone_kits,fentanyl_strips,funding_source_id,summary_enc,follow_up_due,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          iid, c.id, c.worker, type, d(off), dur, loc, loc === 'phone' ? 'phone' : 'in_person', rand() < 0.8 ? 'completed' : pick(['partial', 'no_show', 'rescheduled', 'unable_to_locate']), c.stage, type === 'naloxone_distribution' ? 1 + Math.floor(rand() * 2) : 0, type === 'harm_reduction' ? 5 : 0, fund, encrypt(SUMMARIES[type] || `${type.replace(/_/g, ' ')} contact`), rand() < 0.3 ? day(-Math.floor(rand() * 10)) : null, d(off, 16));
        db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,funding_source_id,intervention_id,description) VALUES(?,?,?,?,?,?,?,?,?)`, track('time_entries', uuid()), c.worker, c.id, day(off), dur, type === 'transport' ? 'travel' : type === 'care_coordination' ? 'care_coordination' : type === 'outreach' ? 'outreach' : 'direct_service', day(off) >= fundStart ? fund : null, iid, type.replace(/_/g, ' '));
        counts.interventions++;
      }
      const nc = c.cstatus === 'waitlist' ? 1 : 3 + Math.floor(rand() * 4);
      for (let k = 0; k < nc; k++) {
        const ct = pick(['client', 'client', 'client', 'family', 'provider', 'agency', 'pharmacy']);
        const out = pick(C.CALL_OUTCOMES.slice(0, 4));
        db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,duration_minutes,contact_type,contact_name_enc,purpose,outcome,crisis,follow_up_needed,follow_up_due,summary_enc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('calls', uuid()), c.id, c.worker, rand() < 0.5 ? 'inbound' : 'outbound', d(Math.floor(rand() * 90), 9 + Math.floor(rand() * 8)), out === 'reached' ? 5 + Math.floor(rand() * 20) : 1, ct, ct === 'family' ? encrypt('Mother') : ct === 'provider' ? encrypt('OTP intake nurse') : null, pick(['Check-in', 'Appointment reminder', 'Referral follow-up', 'Benefits question', 'Housing update']), out, 0, out !== 'reached' ? 1 : 0, out !== 'reached' ? day(-1) : null, encrypt(out === 'reached' ? 'Talked through next steps; client will call back if anything changes.' : 'Left message asking client to call back.'));
        counts.calls++;
      }
      // Text messages: the quickest contact a navigator makes, and the one most often left unlogged.
      const ntx = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < ntx; k++) {
        const outbound = rand() < 0.7;
        const out = outbound ? pick(['replied', 'sent', 'no_reply']) : 'replied';
        db.run(`INSERT INTO calls(id,client_id,user_id,method,direction,started_at,duration_minutes,contact_type,purpose,outcome,crisis,follow_up_needed,follow_up_due,summary_enc) VALUES(?,?,?,'text',?,?,?,?,?,?,?,?,?,?)`,
          track('calls', uuid()), c.id, c.worker, outbound ? 'outbound' : 'inbound', d(Math.floor(rand() * 60), 8 + Math.floor(rand() * 10)), 1, 'client',
          pick(['Appointment reminder', 'Checking in', 'Confirming a ride', 'Sent the clinic address']), out, 0, out === 'no_reply' ? 1 : 0, out === 'no_reply' ? day(-1) : null,
          encrypt(outbound ? 'Reminded about tomorrow and offered a ride.' : 'Client said they are running late but will be there.'));
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
      for (let k = 0; k < nn; k++) { const [fmtName, title, body] = NOTE_BODIES[(i + k) % NOTE_BODIES.length]; const off = 5 + Math.floor(rand() * 100); const signed = k > 0 || rand() < 0.5; db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title_enc,content_enc,occurred_at,status,signed_at,signed_by,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('notes', uuid()), c.id, c.worker, 'admin', fmtName, encrypt(title), encrypt(body + ' (Sample data)'), d(off), signed ? 'signed' : 'draft', signed ? d(off, 17) : null, signed ? c.worker : null, 'manual', d(off, 17), d(off, 17)); counts.notes++; }
      // A shift hand-off for the next worker on, and a safety plan for the person flagged with one.
      if (i === 0) db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title_enc,content_enc,occurred_at,status,signed_at,signed_by,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('notes', uuid()), c.id, c.worker, 'admin', 'handoff', encrypt('Hand-off: detox bed pending'), encrypt('Hope Street has a bed opening tomorrow morning. Client knows to be at the drop-in by 8am; needs a ride booked. Call the intake nurse first thing if no confirmation by 7:30. (Sample data)'), d(0, 17), 'signed', d(0, 17), c.worker, 'manual', d(0, 17), d(0, 17));
      if (i === 2) {
        const plan = { warning_signs: 'Not sleeping; stops answering texts; talk of "being done"', coping: 'Walk to the river; call sponsor; music', distraction: 'Recovery Café; sister\'s place on weekends', people_to_ask: 'Sister (Rosa); peer coach at the Café', professionals: 'Navigator 555-0100; County Crisis Line 988; Valley Behavioral 555-0206', environment: 'Naloxone on hand; no using alone; roommate knows the plan', reasons_for_living: 'Daughter; getting back to work' };
        db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title_enc,content_enc,structured_enc,occurred_at,status,signed_at,signed_by,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('notes', uuid()), c.id, c.worker, 'admin', 'safety_plan', encrypt('Safety plan'), encrypt(Object.entries(plan).map(([k, v]) => `${k}: ${v}`).join('\n\n') + ' (Sample data)'), encrypt(JSON.stringify(plan)), d(12, 14), 'signed', d(12, 15), c.worker, 'manual', d(12, 14), d(12, 15));
      }
      if (clinician && i % 2 === 0) {
        const S = `Reports ${c.sub.replace(/_/g, ' ')} use ${pick(['daily', 'most days', 'on weekends'])}; motivated by ${pick(['family', 'health', 'housing', 'court'])}.`; const O = 'Alert and oriented; mild withdrawal symptoms; PHQ-9 = 12.'; const A = `${c.sub.startsWith('opioid') ? 'Opioid' : 'Substance'} use disorder, ${c.risk === 'critical' ? 'severe' : 'moderate'}; stage of change: ${c.stage}.`; const P = 'Continue navigation contacts weekly; MAT referral; naloxone on hand; reassess in 30 days.';
        db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title_enc,content_enc,structured_enc,occurred_at,status,signed_at,signed_by,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('notes', uuid()), c.id, clinician, 'clinical', i % 4 === 0 ? 'SOAP' : 'DAP', encrypt('Clinical assessment'), encrypt(i % 4 === 0 ? `S: ${S}\nO: ${O}\nA: ${A}\nP: ${P} (Sample data)` : `D: ${S} ${O}\nA: ${A}\nP: ${P} (Sample data)`), encrypt(JSON.stringify(i % 4 === 0 ? { S, O, A, P } : { D: `${S} ${O}`, A, P })), d(30 + i), i % 4 === 0 ? 'signed' : 'draft', i % 4 === 0 ? d(30 + i, 18) : null, i % 4 === 0 ? clinician : null, 'manual', d(30 + i, 18), d(30 + i, 18)); counts.notes++;
      }
      // Consents & disclosures
      const consentId = track('consents', uuid());
      db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)`, consentId, c.id, 'part2_disclosure', encrypt('County Opioid Treatment Program'), encrypt('Treatment coordination and referral'), encrypt('Referral summary, diagnosis, MAT status'), day(60 + i), day(i === 3 ? 5 : i === 5 ? -10 : -300 + i * 20), c.worker);
      if (i % 3 === 0) db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)`, track('consents', uuid()), c.id, 'roi', encrypt('Family member (mother)'), encrypt('Care coordination with family'), encrypt('Appointment dates and general progress'), day(50 + i), day(-315), c.worker);
      if (i % 2 === 0) db.run(`INSERT INTO disclosures(id,client_id,consent_id,recipient_enc,purpose_enc,what_enc,method,disclosed_at,disclosed_by,basis,source) VALUES(?,?,?,?,?,?,?,?,?,?,'manual')`, track('disclosures', uuid()), c.id, consentId, encrypt('County Opioid Treatment Program'), encrypt('Referral for MAT intake'), encrypt('Referral summary and MAT status'), 'fax', d(40 + i), c.worker, 'consent');
      // Expenditures
      const EXP = [['transportation', 'Metro Transit', 'Bus pass (monthly)', 45], ['client_assistance', 'Walgreens', 'Hygiene kit and phone charger', 32.18], ['housing_assistance', 'Motel 6', 'Emergency motel, 3 nights', 267], ['ids_documents', 'DMV', 'State ID fee', 28], ['client_assistance', 'Uber', 'Ride to intake appointment', 18.75], ['phones_communication', 'Metro PCS', 'Prepaid phone (recovery contact)', 40], ['naloxone_supplies', 'Harm Reduction Coalition', 'Naloxone kits (5)', 150]];
      const ne = c.cstatus === 'waitlist' ? 0 : 1 + Math.floor(rand() * 3);
      for (let k = 0; k < ne; k++) { const [cat, vendor, desc, amt] = EXP[(i + k * 3) % EXP.length]; const st = k === 0 ? 'approved' : pick(['pending', 'approved', 'reimbursed']); db.run(`INSERT INTO expenditures(id,funding_source_id,budget_line_id,client_id,user_id,spent_at,amount,category,vendor,description,status,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, track('expenditures', uuid()), fund, lineIds[cat] || lineIds.client_assistance, c.id, c.worker, day(5 + Math.floor(rand() * 80)), amt, cat, vendor, desc, st, st === 'pending' ? null : supervisor, st === 'pending' ? null : d(3)); }
    });
    // County form library: three typical forms (generated PDFs) and a few filled-out examples
    const pdf = require('./pdf');
    const TEMPLATES = [
      ['Consent for Release of Information (42 CFR Part 2)', 'consent_release', 'Authorizes the program to share SUD treatment information with a named provider or agency.', 'Review each line with the client. Part 2 consents must name who receives the information, what is shared and why, and when the consent expires.',
        [{ key: 'client_name', label: 'Client name', type: 'text', required: true, autofill: 'client.full_name' }, { key: 'dob', label: 'Date of birth', type: 'date', autofill: 'client.dob' }, { key: 'client_code', label: 'Client ID', type: 'text', autofill: 'client.client_code' },
         { key: 'sec_release', label: 'Release', type: 'section' }, { key: 'recipient', label: 'Information may be released to (name / agency)', type: 'text', required: true }, { key: 'purpose', label: 'Purpose of the disclosure', type: 'textarea', required: true }, { key: 'info', label: 'Information to be released', type: 'select', options: ['Referral summary', 'Diagnosis and MAT status', 'Attendance and progress', 'Full record'], required: true },
         { key: 'expires', label: 'This consent expires on', type: 'date', required: true }, { key: 'redisclosure', label: 'I understand that my records are protected under 42 CFR Part 2 and cannot be re-disclosed without my written consent.', type: 'checkbox' }, { key: 'revoke', label: 'I understand I may revoke this consent at any time except to the extent action has been taken in reliance on it.', type: 'checkbox' },
         { key: 'sec_sign', label: 'Signatures', type: 'section' }, { key: 'client_sig', label: 'Client signature', type: 'signature', required: true }, { key: 'date', label: 'Date', type: 'date', autofill: 'today', required: true }, { key: 'witness', label: 'Witness / navigator', type: 'text', autofill: 'worker.name' }]],
      ['Navigation Intake & Screening Sheet', 'intake_screening', 'First-contact intake for the county SUD navigation program.', 'Complete at the first meeting. Leave blank anything the client does not want to answer.',
        [{ key: 'sec_id', label: 'Identification', type: 'section' }, { key: 'client_name', label: 'Client name', type: 'text', required: true, autofill: 'client.full_name' }, { key: 'preferred_name', label: 'Preferred name', type: 'text', autofill: 'client.preferred_name' }, { key: 'dob', label: 'Date of birth', type: 'date', autofill: 'client.dob' }, { key: 'phone', label: 'Best phone number', type: 'text', autofill: 'client.phone' }, { key: 'address', label: 'Where are you staying?', type: 'text', autofill: 'client.address' }, { key: 'insurance', label: 'Insurance', type: 'text', autofill: 'client.insurance' },
         { key: 'sec_use', label: 'Substance use', type: 'section' }, { key: 'substance', label: 'Primary substance', type: 'text', autofill: 'client.primary_substance' }, { key: 'last_use', label: 'Last use', type: 'date' }, { key: 'od_year', label: 'Overdose in the past 12 months', type: 'checkbox' }, { key: 'naloxone', label: 'Has naloxone', type: 'checkbox' }, { key: 'mat_interest', label: 'Interested in medication (MAT)?', type: 'select', options: ['Yes', 'No', 'Not sure', 'Already on MAT'] },
         { key: 'sec_needs', label: 'Immediate needs', type: 'section' }, { key: 'needs', label: 'What would help most this week?', type: 'textarea' }, { key: 'safety', label: 'Safety concerns (self, others, domestic violence)', type: 'textarea' },
         { key: 'navigator', label: 'Navigator', type: 'text', autofill: 'worker.name' }, { key: 'date', label: 'Date', type: 'date', autofill: 'today' }]],
      ['Client Assistance Request (Transportation / Basic Needs)', 'assistance_request', 'Request to spend client-assistance funds (bus passes, IDs, phones, emergency motel).', 'Attach the receipt to the expenditure after purchase. Requests over $250 need supervisor approval before spending.',
        [{ key: 'client_name', label: 'Client name', type: 'text', required: true, autofill: 'client.full_name' }, { key: 'client_code', label: 'Client ID', type: 'text', autofill: 'client.client_code' }, { key: 'date', label: 'Date', type: 'date', autofill: 'today' },
         { key: 'item', label: 'Item / service requested', type: 'select', options: ['Bus pass', 'Ride to appointment', 'State ID fee', 'Birth certificate', 'Prepaid phone', 'Emergency motel', 'Hygiene / clothing', 'Other'], required: true }, { key: 'amount', label: 'Estimated cost ($)', type: 'number', required: true }, { key: 'vendor', label: 'Vendor', type: 'text' },
         { key: 'justification', label: 'How this supports the recovery plan', type: 'textarea', required: true }, { key: 'urgent', label: 'Urgent (needed within 24 hours)', type: 'checkbox' },
         { key: 'navigator', label: 'Requested by', type: 'text', autofill: 'worker.name', required: true }, { key: 'supervisor', label: 'Supervisor approval (name)', type: 'signature' }]],
    ];
    const tids = TEMPLATES.map(([name, cat, desc, instr, flds], ti) => {
      const id = track('form_templates', uuid()); const file = pdf.renderForm({ title: name, subtitle: desc, org: 'Sample County Behavioral Health', meta: ['Form SC-' + (100 + ti), 'Rev. 2026-01'], fields: flds, values: {}, footer: 'Sample county form (fictional) generated for demonstration' });
      db.run(`INSERT INTO form_templates(id,name,description,category,version,filename,content_type,bytes,file_b64,fields_json,instructions,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, name, desc, cat, '2026-01', `SC-${100 + ti}.pdf`, 'application/pdf', file.length, file.toString('base64'), JSON.stringify(flds), instr, actor);
      return id;
    });
    cids.slice(0, 6).forEach((c, i) => {
      const ti = i % 3; const [name, , , , flds] = TEMPLATES[ti]; const done = i < 4;
      const base = { client_name: `${c.fn} ${c.ln}`, dob: PEOPLE[i][4], client_code: `${DEMO_PREFIX}${String(i + 1).padStart(4, '0')}`, date: day(10 + i), navigator: 'Sample Navigator', witness: 'Sample Navigator' };
      const extra = ti === 0 ? { recipient: 'County Opioid Treatment Program', purpose: 'Coordinate MAT intake and share referral summary', info: 'Referral summary', expires: day(-300), redisclosure: true, revoke: true, client_sig: done ? `${c.fn} ${c.ln}` : '' }
        : ti === 1 ? { preferred_name: PEOPLE[i][2] || '', phone: `555-01${String(i + 1).padStart(2, '0')}`, address: `${100 + i * 7} Demo St`, insurance: PEOPLE[i][14], substance: c.sub.replace(/_/g, ' '), last_use: day(3), od_year: !!c.od, naloxone: !!c.od, mat_interest: c.mat === 'active' ? 'Already on MAT' : 'Yes', needs: 'Shelter bed this week; help getting a state ID; bus pass for OTP.', safety: 'None reported.' }
        : { item: 'Bus pass', amount: '45', vendor: 'Metro Transit', justification: 'Daily dosing at the OTP requires two bus rides; client has no income yet.', urgent: i === 2, supervisor: done ? 'Sample Supervisor' : '' };
      const fid = track('client_forms', uuid());
      db.run(`INSERT INTO client_forms(id,client_id,template_id,template_name,fields_json,values_enc,status,completed_at,completed_by,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, fid, c.id, tids[ti], name + ' (v2026-01)', JSON.stringify(flds), encrypt(JSON.stringify({ ...base, ...extra })), done ? 'completed' : 'draft', done ? d(9 + i, 15) : null, done ? c.worker : null, c.worker, d(10 + i, 14), d(9 + i, 15));
      if (i === 0) { const scan = png.placeholder(600, 780, 99, 4); db.run(`INSERT INTO client_form_files(id,client_form_id,client_id,filename,content_type,bytes,data_enc,uploaded_by) VALUES(?,?,?,?,?,?,?,?)`, track('client_form_files', uuid()), fid, c.id, 'signed-consent-scan.png', 'image/png', scan.length, encrypt(scan.toString('base64')), c.worker); }
    });
    // Non-client time (meetings, documentation, training) for each worker
    for (const w of workers) for (let k = 0; k < 10; k++) { const cat = pick(['documentation', 'meeting', 'travel', 'training', 'supervision', 'admin', 'outreach']); const wd = day(Math.floor(rand() * 60)); db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,funding_source_id,description) VALUES(?,?,?,?,?,?,?,?)`, track('time_entries', uuid()), w, null, wd, 30 + Math.floor(rand() * 6) * 15, cat, cat === 'training' ? fund2 : (wd >= fundStart ? fund : null), { documentation: 'Charting and note sign-off', meeting: 'Weekly team huddle', travel: 'Drive between sites', training: 'Naloxone train-the-trainer', supervision: 'Supervision with program manager', admin: 'Data entry for monthly report', outreach: 'Encampment outreach walk' }[cat]); }
    // Program-level expenditures
    for (const [cat, vendor, desc, amt] of [['naloxone_supplies', 'Harm Reduction Coalition', 'Naloxone kits (50)', 1500], ['outreach_materials', 'PrintPro', 'Outreach flyers and cards', 220], ['training', 'State Peer Academy', 'Peer certification course', 650]]) db.run(`INSERT INTO expenditures(id,funding_source_id,budget_line_id,user_id,spent_at,amount,category,vendor,description,status,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, track('expenditures', uuid()), fund, lineIds[cat], workers[0], day(20 + Math.floor(rand() * 60)), amt, cat, vendor, desc, 'approved', supervisor, d(15));

    // Supply cupboard, so the Supplies page has something to draw down.
    for (const [item, qty] of [['Naloxone kit', 42], ['Fentanyl test strips', 180], ['Xylazine test strips', 60], ['Wound care kit', 25]]) {
      if (!db.one(`SELECT 1 FROM supply_stock WHERE item=? COLLATE NOCASE`, item)) db.run(`INSERT INTO supply_stock(id,item,quantity,updated_by) VALUES(?,?,?,?)`, track('supply_stock', uuid()), item, qty, workers[0]);
    }
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
