'use strict';
// Context packs for the AI assistant (server/ai-assistant.js; docs/AI-COPILOT.md, "The assistant"): what the
// assistant may know when it answers one question, built here from the records the person asking may already see.
//
// A pack is structured fields only (version 1, an owner decision of 2026-10-24): dates, kinds, statuses, counts,
// the care plan's own problem, goal and step entries, supply levels, the referral directory. No narrative text is
// ever read for a pack: not a note's content, not a contact's summary, not a referral's outcome or barrier text,
// not a to-do's title or details (free text a worker typed, which can name anyone). SUD counseling notes (42 CFR
// §2.11) are not read at all: the only notes query here counts the person's own unsigned drafts, counseling notes
// left out of the count itself.
//
// Each pack is { text, sections: [{ id, label }] }: plain text under one heading per section, each heading carrying
// its id ("## Contacts and visits [client.contacts]") so the answer can cite it. A section is in the pack only when
// the person holds the permission that reads it; an answer citing a section that is not in the pack is refused
// (server/ai-assistant.js). Every list is capped at CAP rows, with a last line saying how many more were left out.
// Access is asserted here, not only in the route, so no caller can build a pack for a client out of reach.
//
// The text still holds PHI (and Part 2 information) until server/ai-copilot.js deidentify() replaces the
// identifiers: nothing here is sent anywhere, logged or stored.
const db = require('./db');
const auth = require('./auth');
const O = require('./options');
const LD = require('./local-date');
const { decrypt } = require('./crypto');
const { notFound } = require('./http');

const CAP = 50;
const CONTACTS = 10;
const SUPPLY_DAYS = 90;
const CLOSED_REFERRAL = ['completed', 'closed', 'declined_by_client', 'declined_by_provider'];
const OPEN_TASK = `status IN ('open','in_progress')`;

const plain = (v) => { if (!v) return ''; try { return decrypt(v); } catch { return ''; } };
const day = (v) => LD.dayOf(v) || '';
const label = (list, code) => (code ? String(O.labelOf(list, code)) : '');
const yes = (v) => (Number(v) ? 'yes' : 'no');
// A field value on one line: a structured entry is short, but the care plan's wording is the worker's.
const one = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A pack being built: sections in order, each a heading and its lines. */
function builder() {
  const sections = []; const parts = [];
  return {
    add(id, title, lines, { more = 0, empty = 'None recorded.' } = {}) {
      sections.push({ id, label: title });
      const body = lines.length ? lines.map(l => `- ${l}`) : [empty];
      if (more > 0) body.push(`…and ${more} more not shown`);
      parts.push(`## ${title} [${id}]\n${body.join('\n')}`);
    },
    done() { return { text: parts.join('\n\n'), sections }; },
  };
}
/** The first CAP rows of `rows` and how many were left out. */
const capped = (rows, cap = CAP) => ({ rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap) });

/** What a to-do is, from what it is linked to (its title is free text and is never read). */
function todoKind(t) {
  if (t.referral_id) return 'referral follow-up';
  if (t.intervention_id) return 'visit follow-up';
  if (t.call_id) return 'call follow-up';
  if (t.is_milestone) return 'milestone';
  return 'to-do';
}

// ---------------------------------------------------------------- client brief
/**
 * One client, before a visit: who (name, pronouns, language), where they are in the programme, their active care
 * plan, their last contacts, open referrals, supplies given lately and what is coming up. `ctx.user` must reach the
 * client; a restriction the programme agreed is the engine's to refuse (server/ai-assistant.js), before this runs.
 */
function clientBrief(ctx, clientId) {
  const row = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL`, clientId);
  if (!row) throw notFound('Client not found');
  auth.assertClientAccess(ctx, clientId);
  const u = ctx.user;
  const may = (p) => auth.hasPerm(u, p);
  const c = require('./clients-model').decryptRow(row);
  const b = builder();
  const today = LD.today();

  const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
  b.add('client.header', 'Client', [
    name ? `Name: ${name}${c.preferred_name ? ` (goes by ${c.preferred_name})` : ''}` : 'Name: not recorded (known by participant code)',
    c.pronouns ? `Pronouns: ${one(c.pronouns, 40)}` : null,
    c.preferred_language ? `Preferred language: ${one(c.preferred_language, 40)}` : null,
    `Status: ${row.status}${row.intake_date ? `; intake ${day(row.intake_date)}` : ''}${row.discharge_date ? `; discharged ${day(row.discharge_date)}` : ''}`,
    row.risk_level ? `Risk level: ${row.risk_level}` : null,
    row.housing_status ? `Housing: ${label('HOUSING_STATUS', row.housing_status) || row.housing_status}` : null,
    row.mat_status ? `Medication for addiction treatment: ${row.mat_status}` : null,
    `Naloxone given before: ${yes(row.naloxone_provided)}${row.naloxone_last_date ? ` (last ${day(row.naloxone_last_date)})` : ''}`,
    Number(row.overdose_history) ? `Overdose history: yes${row.last_overdose_date ? ` (last ${day(row.last_overdose_date)})` : ''}` : 'Overdose history: none recorded',
    `OK to text: ${yes(row.ok_to_text)}; OK to leave voicemail: ${yes(row.ok_to_voicemail)}`,
  ].filter(Boolean));

  if (may('careplan:read')) {
    const problems = db.all(`SELECT id, problem_enc, onset_date FROM problems WHERE client_id=? AND status='active' ORDER BY created_at`, clientId);
    const goals = db.all(`SELECT id, problem_id, goal_enc, status, target_date, review_date FROM care_plan_goals WHERE client_id=? AND status='active' ORDER BY created_at`, clientId);
    const steps = db.all(`SELECT goal_id, step_enc, owner_role, target_date FROM care_plan_steps WHERE client_id=? AND status='open' ORDER BY target_date IS NULL, target_date`, clientId);
    const lines = [
      ...problems.map(p => `Problem: ${one(plain(p.problem_enc))}${p.onset_date ? ` (since ${day(p.onset_date)})` : ''}`),
      ...goals.map(g => `Goal: ${one(plain(g.goal_enc))}${g.target_date ? `; target ${day(g.target_date)}` : ''}${g.review_date ? `; review ${day(g.review_date)}` : ''}`),
      ...steps.map(s => `Open step: ${one(plain(s.step_enc))} (${s.owner_role.replace(/_/g, ' ')}${s.target_date ? `, by ${day(s.target_date)}` : ''})`),
    ];
    const k = capped(lines);
    b.add('client.careplan', 'Active care plan', k.rows, { more: k.more, empty: 'No active care plan entries.' });
  }

  if (may('interventions:read')) {
    const n = db.one(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, clientId).n;
    // Never summary_enc: what happened, in the worker's words, is narrative.
    const rows = db.all(`SELECT occurred_at, type, location, modality, duration_minutes, outcome, naloxone_kits, fentanyl_strips, follow_up_due
      FROM interventions WHERE client_id=? ORDER BY occurred_at DESC LIMIT ?`, clientId, CONTACTS);
    b.add('client.contacts', `Contacts and visits (the ${CONTACTS} most recent)`, rows.map(v => [
      `${day(v.occurred_at)}: ${label('INTERVENTION_TYPES', v.type)}`,
      [v.modality ? label('MODALITIES', v.modality) : '', v.location ? label('LOCATIONS', v.location) : '', v.duration_minutes ? `${v.duration_minutes} min` : ''].filter(Boolean).join(', '),
      v.outcome ? `outcome: ${label('OUTCOMES', v.outcome)}` : '',
      Number(v.naloxone_kits) ? `naloxone kits: ${v.naloxone_kits}` : '',
      Number(v.fentanyl_strips) ? `test strips: ${v.fentanyl_strips}` : '',
      v.follow_up_due ? `follow-up due ${day(v.follow_up_due)}` : '',
    ].filter(Boolean).join('; ')), { more: Math.max(0, n - rows.length), empty: 'No contacts recorded.' });

    const since = LD.addDays(today, -SUPPLY_DAYS);
    const given = db.all(`SELECT s.name, s.unit, SUM(x.quantity) qty FROM intervention_supplies x JOIN interventions i ON i.id=x.intervention_id JOIN supply_items s ON s.id=x.item_id
      WHERE i.client_id=? AND substr(i.occurred_at,1,10) >= ? GROUP BY s.id ORDER BY s.sort_order, s.name`, clientId, since);
    const k = capped(given.map(g => `${one(g.name, 100)}: ${g.qty}${g.unit && g.unit !== 'each' ? ` ${g.unit}` : ''}`));
    b.add('client.supplies', `Supplies given (last ${SUPPLY_DAYS} days)`, k.rows, { more: k.more, empty: `None in the last ${SUPPLY_DAYS} days.` });
  }

  if (may('referrals:read')) {
    // The directory entry's name, never the referral's outcome, barrier or notes text.
    const rows = db.all(`SELECT r.referred_at, r.status, r.urgency, r.appointment_at, r.follow_up_due, r.warm_handoff, x.name, x.organization, x.category
      FROM referrals r JOIN resources x ON x.id=r.resource_id WHERE r.client_id=? AND r.status NOT IN (${CLOSED_REFERRAL.map(() => '?').join(',')}) ORDER BY r.referred_at DESC`, clientId, ...CLOSED_REFERRAL);
    const k = capped(rows.map(r => [
      `${one(r.organization ? `${r.name} (${r.organization})` : r.name, 160)}: ${label('REFERRAL_STATUSES', r.status)}`,
      `referred ${day(r.referred_at)}`, r.urgency && r.urgency !== 'routine' ? `${r.urgency}` : '',
      r.appointment_at ? `appointment ${day(r.appointment_at)}` : '', r.follow_up_due ? `follow-up due ${day(r.follow_up_due)}` : '', Number(r.warm_handoff) ? 'warm hand-off' : '',
    ].filter(Boolean).join('; ')));
    b.add('client.referrals', 'Open referrals', k.rows, { more: k.more, empty: 'No open referrals.' });
  }

  // What is coming up: open to-dos for this client that the person may see (what each is, never its title), and
  // referral appointments from today on.
  const upcoming = [];
  if (may('tasks:read')) {
    for (const t of db.all(`SELECT due_at, priority, status, assigned_to, referral_id, intervention_id, call_id, is_milestone FROM tasks WHERE client_id=? AND ${OPEN_TASK} AND due_at IS NOT NULL ORDER BY due_at`, clientId)) {
      upcoming.push({ at: day(t.due_at), line: `${day(t.due_at)}: ${todoKind(t)}${t.priority !== 'normal' ? ` (${t.priority})` : ''}${day(t.due_at) < today ? ', overdue' : ''}${t.assigned_to === u.id ? ', yours' : ''}` });
    }
  }
  if (may('referrals:read')) {
    for (const r of db.all(`SELECT r.appointment_at, x.name FROM referrals r JOIN resources x ON x.id=r.resource_id WHERE r.client_id=? AND r.appointment_at IS NOT NULL AND substr(r.appointment_at,1,10) >= ? AND r.status NOT IN (${CLOSED_REFERRAL.map(() => '?').join(',')})`, clientId, today, ...CLOSED_REFERRAL)) {
      upcoming.push({ at: day(r.appointment_at), line: `${day(r.appointment_at)}: appointment at ${one(r.name, 120)}` });
    }
  }
  if (may('tasks:read') || may('referrals:read')) {
    const k = capped(upcoming.sort((a, z) => a.at.localeCompare(z.at)).map(x => x.line));
    b.add('client.upcoming', 'Coming up', k.rows, { more: k.more, empty: 'Nothing scheduled.' });
  }
  return b.done();
}

// ---------------------------------------------------------------- my day
/**
 * The person's own day: their to-dos due on `dateISO` and referral appointments that day for referrals they made,
 * their overdue to-dos, and how many of their own notes are unsigned. Only their own work, and only clients they
 * reach. Clients are named in the pack by a reference ([C1], [C2]…), never by name or code: `refs` maps each to
 * its client id, for the engine to mask and to name them in the answer (server/ai-assistant.js).
 */
function myDay(ctx, dateISO = LD.today()) {
  const u = ctx.user;
  const may = (p) => auth.hasPerm(u, p);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || '')) ? dateISO : LD.today();
  const b = builder();
  const refs = new Map(); // clientId -> 'C1'
  const ref = (clientId) => {
    if (!clientId) return 'no client';
    if (!refs.has(clientId)) refs.set(clientId, `C${refs.size + 1}`);
    return `[${refs.get(clientId)}]`;
  };
  const cf = auth.caseloadFilter(u, 't.client_id');
  const reach = `(t.client_id IS NULL OR (${cf.sql} AND EXISTS (SELECT 1 FROM clients c WHERE c.id=t.client_id AND c.deleted_at IS NULL)))`;

  if (may('tasks:read')) {
    const todos = db.all(`SELECT t.client_id, t.due_at, t.priority, t.status, t.referral_id, t.intervention_id, t.call_id, t.is_milestone FROM tasks t
      WHERE t.assigned_to=? AND t.${OPEN_TASK} AND t.due_at IS NOT NULL AND ${reach} ORDER BY t.due_at`, u.id, ...cf.params);
    const dueToday = todos.filter(t => day(t.due_at) === date);
    // Urgent and high first, then the oldest: what the cap keeps is what matters most.
    const RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
    const overdue = todos.filter(t => day(t.due_at) < date).sort((a, z) => (RANK[a.priority] ?? 2) - (RANK[z.priority] ?? 2) || String(a.due_at).localeCompare(String(z.due_at)));
    const sched = dueToday.map(t => `${String(t.due_at).length > 10 ? `${String(LD.formatter('en-US', { timeZone: LD.orgTimezone(), hour: 'numeric', minute: '2-digit' }).format(new Date(t.due_at)))} ` : ''}${todoKind(t)} for ${ref(t.client_id)}${t.priority !== 'normal' ? ` (${t.priority})` : ''}`);
    if (may('referrals:read')) {
      const rf = auth.caseloadFilter(u, 'r.client_id');
      for (const r of db.all(`SELECT r.client_id, r.appointment_at, x.name FROM referrals r JOIN resources x ON x.id=r.resource_id JOIN clients c ON c.id=r.client_id
        WHERE r.user_id=? AND r.appointment_at IS NOT NULL AND c.deleted_at IS NULL AND ${rf.sql} AND r.status NOT IN (${CLOSED_REFERRAL.map(() => '?').join(',')})`, u.id, ...rf.params, ...CLOSED_REFERRAL)) {
        if (day(r.appointment_at) === date) sched.push(`appointment for ${ref(r.client_id)} at ${one(r.name, 120)}`);
      }
    }
    const s = capped(sched);
    b.add('day.schedule', `Due on ${date}`, s.rows, { more: s.more, empty: 'Nothing due that day.' });
    const o = capped(overdue.map(t => `${day(t.due_at)}: ${todoKind(t)} for ${ref(t.client_id)}${t.priority !== 'normal' ? ` (${t.priority})` : ''}`));
    b.add('day.overdue', 'Overdue to-dos', o.rows, { more: o.more, empty: 'Nothing overdue.' });
  }

  // A count and the oldest date of the person's own unsigned notes: never a note's text, and SUD counseling notes
  // (§2.11) are not counted at all.
  const n = db.one(`SELECT COUNT(*) n, MIN(occurred_at) oldest FROM notes WHERE author_id=? AND status='draft' AND deleted_at IS NULL AND counseling_note=0`, u.id);
  b.add('day.unsigned', 'Your unsigned notes', n.n ? [`${n.n} unsigned note${n.n === 1 ? '' : 's'}; the oldest is from ${day(n.oldest)}`] : [], { empty: 'None.' });
  return { ...b.done(), refs: new Map([...refs].map(([id, r]) => [r, id])) };
}

// ---------------------------------------------------------------- programme reference
/**
 * Programme facts, with no client data at all: supply levels by site, the sites, and the referral directory
 * (organisations and their services: programme data, not anyone's record). The directory is long; when there is a
 * question, the entries that share the most words with it come first, so the 50 sent are the likeliest to answer it.
 */
function programmeReference(ctx, { question = '' } = {}) {
  const u = ctx.user;
  const may = (p) => auth.hasPerm(u, p);
  const b = builder();
  if (may('supplies:read')) {
    const S = require('./supplies');
    const st = S.stock();
    const items = new Map(db.all(`SELECT id, name, unit, low_stock FROM supply_items WHERE is_active=1`).map(i => [i.id, i]));
    const sites = new Map(db.all(`SELECT id, name FROM supply_sites`).map(x => [x.id, x]));
    const rows = st.bySite.filter(x => items.has(x.item_id) && sites.has(x.site_id))
      .map(x => { const i = items.get(x.item_id); return { site: sites.get(x.site_id).name, line: `${one(sites.get(x.site_id).name, 80)}: ${one(i.name, 100)} ${x.quantity}${i.unit && i.unit !== 'each' ? ` ${i.unit}` : ''} on hand${i.low_stock != null && x.quantity <= i.low_stock ? ' (low)' : ''}` }; })
      .sort((a, z) => a.site.localeCompare(z.site) || a.line.localeCompare(z.line));
    const k = capped(rows.map(r => r.line));
    b.add('programme.supplies', 'Supplies on hand by site', k.rows, { more: k.more, empty: 'No stock recorded.' });
    const live = db.all(`SELECT name, kind FROM supply_sites WHERE is_active=1 ORDER BY sort_order, name`);
    const s = capped(live.map(x => `${one(x.name, 80)} (${String(x.kind).replace(/_/g, ' ')})`));
    b.add('programme.sites', 'Sites', s.rows, { more: s.more, empty: 'No sites recorded.' });
  }
  if (may('resources:read')) {
    const all = db.all(`SELECT name, organization, category, services, service_tags, phone, hours, eligibility, languages, city, accepts_medicaid, accepts_uninsured FROM resources WHERE is_active=1 ORDER BY name`);
    const words = new Set(String(question || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
    const score = (r) => { if (!words.size) return 0; const hay = `${r.name} ${r.organization || ''} ${r.category} ${r.services || ''} ${r.service_tags || ''}`.toLowerCase(); let n = 0; for (const w of words) if (hay.includes(w)) n++; return n; };
    const ranked = all.map(r => ({ r, s: score(r) })).sort((a, z) => z.s - a.s).map(x => x.r);
    const k = capped(ranked.map(r => [
      `${one(r.organization && r.organization !== r.name ? `${r.name} (${r.organization})` : r.name, 160)}: ${label('RESOURCE_CATEGORIES', r.category) || r.category}`,
      r.services ? `services: ${one(r.services, 300)}` : '', r.phone ? `phone ${one(r.phone, 40)}` : '', r.hours ? `hours: ${one(r.hours, 120)}` : '',
      r.eligibility ? `eligibility: ${one(r.eligibility, 200)}` : '', r.languages ? `languages: ${one(r.languages, 80)}` : '', r.city ? one(r.city, 60) : '',
      Number(r.accepts_medicaid) ? 'accepts Medi-Cal' : '', Number(r.accepts_uninsured) ? 'accepts uninsured' : '',
    ].filter(Boolean).join('; ')));
    b.add('programme.referrals', 'Referral directory', k.rows, { more: k.more, empty: 'The directory is empty.' });
  }
  return b.done();
}

module.exports = { CAP, CONTACTS, SUPPLY_DAYS, clientBrief, myDay, programmeReference };
