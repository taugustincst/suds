'use strict';
// The AI assistant's context packs (server/ai-context.js): the fields and the short free text workers write on records
// (owner's decision of 2026-10-24), never a note's content, never a
// SUD counseling note; scoped to what the person may see; every list capped and saying so.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { encrypt, uuid } = require('../server/crypto');

let X, LD, nav, navCtx, clinCtx, capCtx, client, other, resourceId;
const COUNSELING_BODY = 'COUNSELING-BODY talked through the grief about her brother';
const PROGRESS_BODY = 'PROGRESS-BODY reviewed the housing paperwork together';
const SUMMARY = 'VISIT-SUMMARY found her at the creek camp, shaken';
const TASK_TITLE = 'TASK-TITLE Call about detox bed for her';
const REFERRAL_NOTE = 'REFERRAL-NOTES she was nervous about the intake';

before(async () => {
  await H.start();
  X = require('../server/ai-context');
  LD = require('../server/local-date');
  const navUser = H.makeUser('ctxnav', 'navigator');
  const clinUser = H.makeUser('ctxclin', 'clinician');
  const capUser = H.makeCaseloadUser('ctxcap', 'navigator');
  const db = H.db;
  const userRow = (u) => db.one(`SELECT * FROM users WHERE id=?`, u.id);
  navCtx = { user: userRow(navUser), ip: '127.0.0.1' };
  clinCtx = { user: userRow(clinUser), ip: '127.0.0.1' };
  capCtx = { user: userRow(capUser), ip: '127.0.0.1' };
  nav = H.client(); await nav.login('ctxnav', 'StaffPassw0rd!x');
  const c = await nav.post('/api/clients', { first_name: 'Maria', last_name: 'Lopez', preferred_name: 'Mari', dob: '1988-03-14', phone: '555-201-3344', confirm_duplicate: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  client = { id: c.data.id, code: db.one(`SELECT client_code FROM clients WHERE id=?`, c.data.id).client_code };
  other = (await nav.post('/api/clients', { first_name: 'Other', last_name: 'Person', confirm_duplicate: true })).data.id;
  const now = db.now(); const today = LD.today();
  // Narrative text everywhere it can be: none of it may reach a pack.
  db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status,counseling_note) VALUES(?,?,?,?,?,?,?,1)`, uuid(), client.id, clinUser.id, 'clinical', encrypt(COUNSELING_BODY), now, 'draft');
  db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status,counseling_note) VALUES(?,?,?,?,?,?,?,0)`, uuid(), client.id, clinUser.id, 'clinical', encrypt(PROGRESS_BODY), '2026-10-01T17:00:00.000Z', 'draft');
  db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status,counseling_note) VALUES(?,?,?,?,?,?,?,0)`, uuid(), client.id, clinUser.id, 'admin', encrypt('another draft'), now, 'draft');
  for (let i = 0; i < 12; i++) {
    db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome,naloxone_kits,summary_enc) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      uuid(), client.id, navUser.id, 'case_management', `2026-09-${String(10 + i).padStart(2, '0')}T18:00:00.000Z`, 30, 'field', 'in_person', null, i === 11 ? 2 : 0, encrypt(SUMMARY));
  }
  resourceId = uuid();
  db.run(`INSERT INTO resources(id,name,organization,category,services,phone) VALUES(?,?,?,?,?,?)`, resourceId, 'Creekside Wound Care', 'Valley Health', 'primary_care', 'walk-in wound care, vaccinations', '916-555-0101');
  db.run(`INSERT INTO resources(id,name,category,services) VALUES(?,?,?,?)`, uuid(), 'Northside Detox', 'detox_withdrawal_mgmt', 'medically supervised withdrawal');
  db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status,appointment_at,notes_enc,outcome_enc) VALUES(?,?,?,?,?,?,?,?,?)`,
    uuid(), client.id, resourceId, navUser.id, '2026-10-01', 'scheduled', today, encrypt(REFERRAL_NOTE), encrypt(REFERRAL_NOTE));
  const p = uuid();
  db.run(`INSERT INTO problems(id,client_id,problem_enc,status) VALUES(?,?,?, 'active')`, p, client.id, encrypt('Unstable housing'));
  db.run(`INSERT INTO care_plan_goals(id,client_id,problem_id,goal_enc,status,target_date) VALUES(?,?,?,?, 'active', '2026-12-01')`, uuid(), client.id, p, encrypt('Move into the Elm Street apartment'));
  db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,due_at,status) VALUES(?,?,?,?,?,?, 'open')`, uuid(), client.id, navUser.id, navUser.id, encrypt(TASK_TITLE), today);
  // 63 overdue to-dos for the navigator, spread over two clients.
  for (let i = 0; i < 63; i++) db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,due_at,status,priority) VALUES(?,?,?,?,?,?, 'open', ?)`,
    uuid(), i % 2 ? client.id : other, navUser.id, navUser.id, encrypt(`${TASK_TITLE} ${i}`), LD.addDays(today, -1 - (i % 20)), i === 0 ? 'urgent' : 'normal');
  const item = uuid(); const site = uuid();
  db.run(`INSERT INTO supply_items(id,name,category,low_stock) VALUES(?,?,?,?)`, item, 'Naloxone kit', 'naloxone', 5);
  db.run(`INSERT INTO supply_sites(id,name,kind) VALUES(?,?,?)`, site, 'North site', 'office');
  db.run(`INSERT INTO supply_ledger(id,item_id,site_id,quantity,kind,occurred_on,user_id) VALUES(?,?,?,?,?,?,?)`, uuid(), item, site, 4, 'received', today, navUser.id);
});
after(async () => { await H.stop(); });

const everyPack = () => [X.clientBrief(clinCtx, client.id).text, X.clientBrief(navCtx, client.id).text, X.myDay(clinCtx).text, X.myDay(navCtx).text, X.programmeReference(navCtx).text];

test('a client brief holds the fields and the workers\' free text under cited sections, and never a note\'s content', () => {
  const { text, sections } = X.clientBrief(navCtx, client.id);
  assert.deepEqual(sections.map(s => s.id), ['client.header', 'client.careplan', 'client.contacts', 'client.supplies', 'client.referrals', 'client.upcoming']);
  for (const s of sections) assert.ok(text.includes(`[${s.id}]`), `${s.id} is headed with its id`);
  assert.match(text, /Name: Maria Lopez \(goes by Mari\)/, 'the name is there for deidentify to replace');
  assert.match(text, /Problem: Unstable housing/);
  assert.match(text, /Goal: Move into the Elm Street apartment; target 2026-12-01/);
  assert.match(text, /Creekside Wound Care \(Valley Health\): Scheduled/);
  assert.match(text, /Naloxone kit|naloxone kits: 2/);
  assert.match(text, /…and 2 more not shown/, 'the 10 most recent contacts, and how many more');
  // The free text workers write on contacts, referrals and to-dos is there, for deidentify to clean before sending.
  assert.match(text, /summary: VISIT-SUMMARY found her at the creek camp, shaken/);
  assert.match(text, /outcome: REFERRAL-NOTES .*; barrier: REFERRAL-NOTES|notes: REFERRAL-NOTES/);
  assert.match(text, /to-do "TASK-TITLE Call about detox bed for her"/);
  // A note's content never is: not a progress note, and never a SUD counseling note.
  for (const body of [PROGRESS_BODY, COUNSELING_BODY]) assert.ok(!text.includes(body.split(' ')[0]), `no ${body.split(' ')[0]}`);
});

test('without the counseling-notes attestation, no counseling note nor any note body reaches a pack; the unsigned count now counts the person\'s own counseling drafts', () => {
  // The default harness records no agreement covering counseling notes, so a counseling note is read for no pack.
  for (const text of everyPack()) {
    assert.ok(!text.includes('COUNSELING-BODY'), 'counseling note text');
    assert.ok(!text.includes('PROGRESS-BODY'), 'progress note text');
    assert.ok(!/counsel/i.test(text), 'not even the word');
  }
  // The count is of the person's own unsigned drafts (a count, never content): their counseling draft is now counted
  // too (the owner's decision of 2026-10-24 reversed the old exclusion). clinUser authored all three drafts.
  const day = X.myDay(clinCtx).text;
  assert.match(day, /3 unsigned notes; the oldest is from 2026-10-01/, 'all three drafts counted, the counseling one included');
});

test('with the agreement recorded as covering SUD counseling notes, the client pack holds the counseling note content the person may read, masked like everything else; a reader who may not read it still never sees it', () => {
  const db = H.db;
  const prev = db.getSetting('ai_attestation', null);
  db.setSetting('ai_attestation', JSON.stringify({ provider: 'Anthropic', configured_provider: 'anthropic', baa: true, qsoa: true, counsel_reviewed: true, covers_assistant: true, covers_counseling: true }));
  try {
    // A clinician writes clinical notes (reads counseling notes): the section is present and holds the note's words.
    const { text, sections } = X.clientBrief(clinCtx, client.id);
    assert.ok(sections.some(s => s.id === 'client.notes'), 'the counseling-notes section is in the pack');
    assert.match(text, /SUD counseling notes \(42 CFR Part 2\) \[client.notes\]/, 'headed and cited');
    assert.ok(text.includes('COUNSELING-BODY'), 'the counseling note content is in the pack (deidentify masks it before it is sent)');
    // The note belongs to clinUser and the client is in reach; a clinician may read it. A navigator (read, not write)
    // who did not author or co-sign it may not: the counselingFilter leaves it out, so its body never appears.
    const navText = X.clientBrief(navCtx, client.id).text;
    assert.ok(!navText.includes('COUNSELING-BODY'), 'a navigator who may not read the counseling note never sees its body');
  } finally { db.setSetting('ai_attestation', prev === null ? '' : prev); } // '' → attestation() reads it back as none
});

test('a client brief refuses a client off the caller\'s caseload, and audits the refusal', () => {
  assert.throws(() => X.clientBrief(capCtx, client.id), (e) => e.status === 403 && /caseload/.test(e.message));
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='authz.denied' AND entity_id=?`, client.id));
  assert.throws(() => X.clientBrief(navCtx, 'no-such-client'), (e) => e.status === 404);
});

test('a section is in a pack only when the person holds the permission that reads it', () => {
  const u = H.makeUser('ctxnocp', 'navigator'); H.deny(u, 'careplan:read', 'referrals:*');
  const ctx = { user: H.db.one(`SELECT * FROM users WHERE id=?`, u.id) };
  const { text, sections } = X.clientBrief(ctx, client.id);
  assert.ok(!sections.some(s => s.id === 'client.careplan' || s.id === 'client.referrals'));
  assert.ok(!/Unstable housing|Creekside/.test(text));
});

test('the day pack caps its lists at 50 and says how many more, and names no client', () => {
  const { text, sections, refs } = X.myDay(navCtx, LD.today());
  assert.deepEqual(sections.map(s => s.id), ['day.schedule', 'day.overdue', 'day.unsigned']);
  assert.match(text, /…and 13 more not shown/);
  assert.equal(text.split('\n').filter(l => /^- \d{4}-\d{2}-\d{2}: .* for \[C\d+\]/.test(l)).length, 50);
  assert.match(text, /visit follow-up|to-do/);
  assert.match(text, /\(urgent\)/);
  assert.match(text, /appointment for \[C\d+\] at Creekside Wound Care/, 'today\'s referral appointment');
  assert.ok(!/Maria|Lopez|Mari\b|Other|Person/.test(text), 'no names');
  assert.ok(!text.includes(client.code), 'no client codes');
  assert.match(text, /to-do "TASK-TITLE Call about detox bed for her \d+" for \[C\d+\]/, 'each to-do with its title');
  assert.deepEqual([...refs.values()].sort(), [client.id, other].sort(), 'each reference maps to its client for the engine');
  // Only the person's own work: the clinician has none of these to-dos.
  assert.match(X.myDay(clinCtx).text, /Nothing overdue/);
});

test('the programme pack holds no client data, and puts the directory entries that match the question first', () => {
  const { text, sections } = X.programmeReference(navCtx, { question: 'Who takes walk-in wound care?' });
  assert.deepEqual(sections.map(s => s.id), ['programme.supplies', 'programme.sites', 'programme.referrals']);
  assert.match(text, /North site: Naloxone kit 4 on hand \(low\)/);
  const lines = text.split('\n');
  const first = lines.findIndex(l => l.includes('Creekside')); const second = lines.findIndex(l => l.includes('Northside'));
  assert.ok(first > 0 && first < second, 'the matching entry first');
  assert.ok(!/Maria|Lopez|Other Person/.test(text) && !text.includes(client.code));
});
