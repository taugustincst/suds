'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { sendJson, badRequest } = require('../http');
const M = require('../clients-model');
const CFX = require('../client-filters');
// Yield to other work between sheets; setImmediate does not exist in the browser kernel.
const { defer } = require('../spreadsheet');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/**
 * A report period, as calendar days in the organisation's time zone. `from`/`to` bound date columns
 * (intake_date, work_date…) as they are; timestamp columns (occurred_at, started_at…) are bounded by the
 * instants those local days begin and end — `fromTs` and `toEnd` — through `ts(col)`, whose parameters are
 * `tsP`. A timestamp column can also hold a bare calendar day (validate.js keeps "2026-09-26" as it was
 * given), which is compared as a day. Taking the day's bounds in UTC dropped an evening visit on the last
 * day of a fiscal year out of it (and pulled the first evening of the next one in).
 */
function range(ctx) {
  const { localDate, localMidnight } = require('./budget');
  const to = ctx.query.get('to') || localDate();
  const from = ctx.query.get('from') || addDays(to, -89);
  if (!DAY.test(to) || !DAY.test(from) || !Number.isFinite(Date.parse(to)) || !Number.isFinite(Date.parse(from))) throw badRequest('from and to must be dates (YYYY-MM-DD)');
  const fromTs = localMidnight(from);
  const toEnd = new Date(Date.parse(localMidnight(addDays(to, 1))) - 1).toISOString();
  const ts = (col) => `((length(${col})>10 AND ${col} BETWEEN ? AND ?) OR (length(${col})=10 AND ${col} BETWEEN ? AND ?))`;
  return { from, to, fromTs, toEnd, ts, tsP: [fromTs, toEnd, from, to] };
}

module.exports = (r) => {
  r.get('/api/reports/dashboard', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const { from, to, ts, tsP } = range(ctx);
    const cf = auth.caseloadFilter(ctx.user, 'c.id');
    // {CF} is expanded to the caseload filter; its bound params are spliced in at the position of the placeholder
    const expand = (sql, p) => { const before = sql.slice(0, sql.indexOf('{CF}')); const n = (before.match(/\?/g) || []).length; return [sql.replace('{CF}', cf.sql), [...p.slice(0, n), ...cf.params, ...p.slice(n)]]; };
    const scoped = (sql, ...p) => { const [q, a] = expand(sql, p); return db.all(q, ...a); };
    const scoped1 = (sql, ...p) => { const [q, a] = expand(sql, p); return db.one(q, ...a); };
    const today = require('./budget').localDate();
    const out = {
      from, to,
      clients: { active: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF}`).n, waitlist: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='waitlist' AND {CF}`).n,
        new_in_range: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND intake_date BETWEEN ? AND ? AND {CF}`, from, to).n,
        // The tiles use the client list's own predicates (server/client-filters.js), so a tile and the list it
        // opens count the same people.
        high_risk: (() => { const f = CFX.risk('high'); return scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND ${f.sql} AND {CF}`, ...f.params).n; })(),
        no_contact_30d: (() => { const f = CFX.noContactSince(); return scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF} AND ${f.sql}`, ...f.params).n; })(),
        by_status: scoped(`SELECT status, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND {CF} GROUP BY status`),
        by_substance: scoped(`SELECT COALESCE(primary_substance,'unknown') k, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF} GROUP BY k ORDER BY n DESC`),
        mat: scoped(`SELECT COALESCE(mat_status,'unknown') k, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF} GROUP BY k`),
      },
      interventions: { total: scoped1(`SELECT COUNT(*) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND {CF}`, ...tsP).n,
        minutes: scoped1(`SELECT COALESCE(SUM(duration_minutes),0) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND {CF}`, ...tsP).n,
        by_type: db.all(`SELECT i.type k, COUNT(*) n, SUM(duration_minutes) minutes FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND ${cf.sql} GROUP BY i.type ORDER BY n DESC`, ...tsP, ...cf.params),
        by_week: db.all(`SELECT strftime('%Y-%W', i.occurred_at) k, COUNT(*) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND ${cf.sql} GROUP BY k ORDER BY k`, ...tsP, ...cf.params),
        naloxone_kits: scoped1(`SELECT COALESCE(SUM(naloxone_kits),0) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND {CF}`, ...tsP).n,
        fentanyl_strips: scoped1(`SELECT COALESCE(SUM(fentanyl_strips),0) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND {CF}`, ...tsP).n,
        by_worker: db.all(`SELECT u.display_name k, COUNT(*) n, SUM(duration_minutes) minutes FROM interventions i JOIN users u ON u.id=i.user_id JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND ${cf.sql} GROUP BY u.id ORDER BY n DESC`, ...tsP, ...cf.params),
      },
      calls: { total: db.one(`SELECT COUNT(*) n FROM calls WHERE ${ts('started_at')}`, ...tsP).n, minutes: db.one(`SELECT COALESCE(SUM(duration_minutes),0) n FROM calls WHERE ${ts('started_at')}`, ...tsP).n,
        crisis: db.one(`SELECT COUNT(*) n FROM calls WHERE crisis=1 AND ${ts('started_at')}`, ...tsP).n, by_outcome: db.all(`SELECT outcome k, COUNT(*) n FROM calls WHERE ${ts('started_at')} GROUP BY outcome ORDER BY n DESC`, ...tsP),
        by_direction: db.all(`SELECT direction k, COUNT(*) n FROM calls WHERE ${ts('started_at')} GROUP BY direction`, ...tsP),
        // Texts are logged alongside calls, so say how the total splits rather than reporting them as calls.
        texts: db.one(`SELECT COUNT(*) n FROM calls WHERE method='text' AND ${ts('started_at')}`, ...tsP).n },
      referrals: { total: db.one(`SELECT COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE ${ts('r.referred_at')} AND ${cf.sql}`, ...tsP, ...cf.params).n,
        by_status: db.all(`SELECT r.status k, COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE ${ts('r.referred_at')} AND ${cf.sql} GROUP BY r.status ORDER BY n DESC`, ...tsP, ...cf.params),
        by_category: db.all(`SELECT res.category k, COUNT(*) n, SUM(CASE WHEN r.status IN ('admitted','completed') THEN 1 ELSE 0 END) successful FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN clients c ON c.id=r.client_id WHERE ${ts('r.referred_at')} AND ${cf.sql} GROUP BY res.category ORDER BY n DESC`, ...tsP, ...cf.params),
        open: db.one(`SELECT COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.status IN ('pending','contacted','accepted','waitlisted','scheduled') AND ${cf.sql}`, ...cf.params).n,
        median_days_to_admit: (() => { const d = db.all(`SELECT (julianday(admitted_at)-julianday(referred_at)) d FROM referrals WHERE admitted_at IS NOT NULL AND ${ts('referred_at')} ORDER BY d`, ...tsP).map(x => x.d); return d.length ? d[Math.floor(d.length / 2)] : null; })() },
      tasks: { open: db.one(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','in_progress') AND (assigned_to=? OR ?)`, ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n,
        overdue: db.one(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','in_progress') AND (CASE WHEN length(due_at)=10 THEN due_at < ? ELSE due_at < ? END) AND (assigned_to=? OR ?)`, today, db.now(), ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n,
        due_today: db.one(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','in_progress') AND substr(due_at,1,10)=? AND (assigned_to=? OR ?)`, today, ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n },
      time: auth.hasPerm(ctx.user, 'time:read') || auth.hasPerm(ctx.user, 'time:write') ? { minutes: db.one(`SELECT COALESCE(SUM(minutes),0) n FROM time_entries WHERE work_date BETWEEN ? AND ? AND (user_id=? OR ?)`, from, to, ctx.user.id, auth.hasPerm(ctx.user, 'time:all') ? 1 : 0).n,
        by_category: db.all(`SELECT category k, SUM(minutes) n FROM time_entries WHERE work_date BETWEEN ? AND ? AND (user_id=? OR ?) GROUP BY category ORDER BY n DESC`, from, to, ctx.user.id, auth.hasPerm(ctx.user, 'time:all') ? 1 : 0) } : null,
      // A supervisor's unsigned-notes alert covers the team's drafts, the same way the overdue-tasks alert
      // above already covers the team's to-dos -- a program manager rarely writes routine notes themselves,
      // so an alert scoped to their own drafts was dead for exactly the role it matters most to.
      notes: (() => {
        const team = auth.hasPerm(ctx.user, 'notes:cosign') && auth.hasPerm(ctx.user, 'clients:all');
        const scope = team ? '1=1' : 'author_id=?'; const p = team ? [] : [ctx.user.id];
        return { team,
          unsigned: db.one(`SELECT COUNT(*) n FROM notes WHERE status='draft' AND deleted_at IS NULL AND ${scope}`, ...p).n,
          unsigned_overdue: db.one(`SELECT COUNT(*) n FROM notes WHERE status='draft' AND deleted_at IS NULL AND ${scope} AND created_at < ?`, ...p, new Date(Date.now() - Number(db.getSetting('note_lock_days', '3')) * 86400000).toISOString()).n,
          staged_imports: db.one(`SELECT COUNT(*) n FROM import_items x JOIN imports i ON i.id=x.import_id WHERE x.status='staged' AND (i.imported_by=? OR i.imported_by IS NULL OR ?)`, ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n }; })(),
      budget: auth.hasPerm(ctx.user, 'budget:read') ? db.one(`SELECT ROUND((SELECT COALESCE(SUM(total_amount),0) FROM funding_sources WHERE is_active=1),2) total, ROUND((SELECT COALESCE(SUM(amount),0) FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE f.is_active=1 AND e.status IN ('approved','reimbursed')),2) spent, ROUND((SELECT COALESCE(SUM(amount),0) FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE f.is_active=1 AND e.status='pending'),2) pending`) : null,
      // Scoped to active clients so this count matches what #/clients?consent_expiring=1 shows by default —
      // otherwise the badge counts a closed or inactive client's consent that the deep-linked list, filtered
      // to active, never displays.
      // Emergency accesses nobody has reviewed yet — the count a supervisor sees on their home page.
      breakglass_pending: auth.hasPerm(ctx.user, 'audit:read') ? db.one(`SELECT COUNT(*) n FROM breakglass_events WHERE acknowledged_at IS NULL`).n : null,
      // Patient-rights requests (access, amendment, restriction, accounting) each run a 30-day clock; the
      // count of open ones, and how many have run out, so a deadline is not first noticed when it is missed.
      patient_requests: auth.hasPerm(ctx.user, 'patient-requests:read') || auth.hasPerm(ctx.user, 'patient-requests:write')
        ? scoped1(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN p.due_at < ? THEN 1 ELSE 0 END),0) overdue FROM patient_requests p JOIN clients c ON c.id=p.client_id WHERE p.status='open' AND c.deleted_at IS NULL AND {CF}`, today)
        : null,
      // 42 CFR §2.22: active clients on this person's caseload with no record of being given the notice.
      part2_notice_missing: (auth.hasPerm(ctx.user, 'consents:read') || auth.hasPerm(ctx.user, 'consents:write')) && require('../disclosure').part2Program()
        ? scoped1(`SELECT COUNT(*) n FROM clients c WHERE ${require('./part2').MISSING_NOTICE} AND {CF}`).n : null,
      // The privacy officer's registers: open complaints, and incidents whose breach-notification clock
      // needs attention (a determination not made, or a notice owed) — how many are due within two weeks or late.
      // The programme's Part 2 protections switched off (routes/part2.js): who did it and when, for administrators.
      part2_program_off: auth.hasPerm(ctx.user, 'settings:manage') && !require('../disclosure').part2Program()
        ? (() => { try { return JSON.parse(db.getSetting('part2_program_off', '') || 'null') || { since: null }; } catch { return { since: null }; } })() : null,
      complaints_open: auth.hasPerm(ctx.user, 'complaints:read') ? db.one(`SELECT COUNT(*) n FROM complaints WHERE status IN ('open','investigating')`).n : null,
      incidents: auth.hasPerm(ctx.user, 'incidents:read') ? (() => {
        const ob = db.all(`SELECT * FROM privacy_incidents WHERE status='open'`).map(i => require('../incidents').obligations(i));
        return { open: ob.length, attention: ob.filter(o => o.attention).length, due_soon: ob.filter(o => o.warn && !o.overdue).length, overdue: ob.filter(o => o.overdue).length };
      })() : null,
      // The number of clients the "consent expiring" list shows (the card below lists the first 20 consents).
      consents_expiring_clients: (() => { const f = CFX.consentExpiring(); return scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND ${f.sql} AND {CF}`, ...f.params).n; })(),
      consents_expiring: db.all(`SELECT co.id, co.client_id, co.type, co.recipient_enc, co.expires_at, c.client_code FROM consents co JOIN clients c ON c.id=co.client_id WHERE co.revoked_at IS NULL AND co.expires_at BETWEEN ? AND ? AND c.status='active' AND ${cf.sql} ORDER BY co.expires_at LIMIT 20`, today, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), ...cf.params).map(x => ({ ...x, recipient: x.recipient_enc ? require('../crypto').decrypt(x.recipient_enc) : null, recipient_enc: undefined })),
    };
    // The dashboard reads across nearly every PHI table; that is a PHI read like any other.
    audit.log({ user: ctx.user, action: 'report.dashboard', ip: ctx.ip, details: { from, to } });
    return out;
  });

  // Outcomes / monthly program report
  r.get('/api/reports/monthly', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const months = Math.min(24, Math.max(1, Number(ctx.query.get('months') || 12)));
    const start = new Date(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - months + 1);
    const s = start.toISOString().slice(0, 10);
    return {
      intakes: db.all(`SELECT substr(intake_date,1,7) month, COUNT(*) n FROM clients WHERE deleted_at IS NULL AND intake_date >= ? GROUP BY month ORDER BY month`, s),
      discharges: db.all(`SELECT substr(discharge_date,1,7) month, COUNT(*) n FROM clients WHERE deleted_at IS NULL AND discharge_date >= ? GROUP BY month ORDER BY month`, s),
      interventions: db.all(`SELECT substr(occurred_at,1,7) month, COUNT(*) n, SUM(duration_minutes) minutes, COUNT(DISTINCT client_id) clients FROM interventions WHERE occurred_at >= ? GROUP BY month ORDER BY month`, s),
      calls: db.all(`SELECT substr(started_at,1,7) month, COUNT(*) n, SUM(duration_minutes) minutes FROM calls WHERE started_at >= ? GROUP BY month ORDER BY month`, s),
      referrals: db.all(`SELECT substr(referred_at,1,7) month, COUNT(*) n, SUM(CASE WHEN status IN ('admitted','completed') THEN 1 ELSE 0 END) successful FROM referrals WHERE referred_at >= ? GROUP BY month ORDER BY month`, s),
      naloxone: db.all(`SELECT substr(occurred_at,1,7) month, SUM(naloxone_kits) kits, SUM(fentanyl_strips) strips FROM interventions WHERE occurred_at >= ? GROUP BY month ORDER BY month`, s),
      overdose_events: db.all(`SELECT substr(occurred_at,1,7) month, COUNT(*) n, SUM(CASE WHEN naloxone_used=1 AND survived=1 THEN 1 ELSE 0 END) reversals, SUM(CASE WHEN kind='fatal' OR survived=0 THEN 1 ELSE 0 END) fatal FROM overdose_events WHERE occurred_at >= ? GROUP BY month ORDER BY month`, s),
      episodes: db.all(`SELECT substr(opened_at,1,7) month, COUNT(*) admissions, (SELECT COUNT(*) FROM episodes x WHERE substr(x.closed_at,1,7)=substr(e.opened_at,1,7)) discharges FROM episodes e WHERE opened_at >= ? GROUP BY month ORDER BY month`, s),
      unduplicated_clients: db.all(`SELECT substr(occurred_at,1,7) month, COUNT(DISTINCT client_id) clients FROM interventions WHERE occurred_at >= ? AND client_id IS NOT NULL GROUP BY month ORDER BY month`, s),
      mat_linkage: db.all(`SELECT substr(referred_at,1,7) month, COUNT(*) n FROM referrals r JOIN resources res ON res.id=r.resource_id WHERE res.category IN ('mat_otp','mat_obot') AND r.status IN ('admitted','completed') AND referred_at >= ? GROUP BY month ORDER BY month`, s),
      spend: auth.hasPerm(ctx.user, 'budget:read') ? db.all(`SELECT substr(spent_at,1,7) month, ROUND(SUM(amount),2) amount FROM expenditures WHERE status IN ('approved','reimbursed') AND spent_at >= ? GROUP BY month ORDER BY month`, s) : [],
      time: db.all(`SELECT substr(work_date,1,7) month, SUM(minutes) minutes FROM time_entries WHERE work_date >= ? GROUP BY month ORDER BY month`, s),
    };
  });

  // The report a funder actually asks for: how many distinct people were served in the period, counted once
  // each, broken down the way a grant report is broken down. Every count on this page is unduplicated —
  // COUNT(DISTINCT client_id) — because "1,400 services" and "310 people" are different questions and the
  // platform could previously only answer the first.
  r.get('/api/reports/funder', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const { from, to, ts, tsP } = range(ctx);
    const cf = auth.caseloadFilter(ctx.user, 'c.id');
    const fund = ctx.query.get('funding_source_id') || null;
    // Restricting to a funding source means counting only the work charged to it.
    const fundJoin = fund ? 'AND i.funding_source_id=?' : '';
    const fundP = fund ? [fund] : [];

    // One set of people served per report, and every per-person metric below is counted within it: a
    // service (visit) or a contact (call) in the period, by a client still on the books (not deleted), in
    // the caller's caseload — and, when a funding source is chosen, only work charged to that source. A
    // call carries no funding source, so under a fund filter it cannot make someone "served by" that fund.
    // (Before this, the fund filter reached the visits half only, the demographics counted anyone with a
    // visit whatever it was charged to, and deleted records were counted as served.)
    const servedSql = `SELECT DISTINCT i.client_id AS id FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND c.deleted_at IS NULL AND ${cf.sql} ${fundJoin}`
      + (fund ? '' : ` UNION SELECT ca.client_id FROM calls ca JOIN clients c ON c.id=ca.client_id WHERE ${ts('ca.started_at')} AND c.deleted_at IS NULL AND ${cf.sql}`);
    const servedP = fund ? [...tsP, ...cf.params, ...fundP] : [...tsP, ...cf.params, ...tsP, ...cf.params];
    // `WITH served(id)` goes in front of each query that counts within the set.
    const inServed = (sql, ...p) => [`WITH served(id) AS (${servedSql}) ${sql}`, ...servedP, ...p];
    const one = (sql, ...p) => { const [q, ...a] = inServed(sql, ...p); return db.one(q, ...a); };
    const all = (sql, ...p) => { const [q, ...a] = inServed(sql, ...p); return db.all(q, ...a); };

    const served = one(`SELECT COUNT(*) n FROM served`).n;

    const demographics = (col, label) => all(`SELECT COALESCE(NULLIF(c.${col},''),'unknown') k, COUNT(*) n
      FROM clients c JOIN served s ON s.id=c.id GROUP BY k ORDER BY n DESC`).map(x => ({ ...x, dimension: label }));

    // race_codes is comma separated because a person may report more than one, so each is counted
    // separately and the total will exceed the number of people served. That is how funders want it.
    const raceRows = all(`SELECT c.race_codes FROM clients c JOIN served s ON s.id=c.id`);
    const byRace = {};
    for (const row of raceRows) {
      const codes = String(row.race_codes || '').split(',').map(x => x.trim()).filter(Boolean);
      for (const code of (codes.length ? codes : ['unknown'])) byRace[code] = (byRace[code] || 0) + 1;
    }

    const episodes = {
      admissions: db.one(`SELECT COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.opened_at BETWEEN ? AND ? AND ${cf.sql}`, from, to, ...cf.params).n,
      discharges: db.one(`SELECT COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.closed_at BETWEEN ? AND ? AND ${cf.sql}`, from, to, ...cf.params).n,
      open_at_end: db.one(`SELECT COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.opened_at <= ? AND (e.closed_at IS NULL OR e.closed_at > ?) AND ${cf.sql}`, to, to, ...cf.params).n,
      by_discharge_reason: db.all(`SELECT COALESCE(e.discharge_reason,'unknown') k, COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.closed_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY k ORDER BY n DESC`, from, to, ...cf.params),
      median_length_of_stay_days: (() => {
        const d = db.all(`SELECT (julianday(e.closed_at)-julianday(e.opened_at)) d FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.closed_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY d`, from, to, ...cf.params).map(x => x.d);
        return d.length ? Math.round(d[Math.floor(d.length / 2)]) : null;
      })(),
    };

    const overdose = {
      events: db.one(`SELECT COUNT(*) n FROM overdose_events o WHERE ${ts('o.occurred_at')}`, ...tsP).n,
      reversals: db.one(`SELECT COUNT(*) n FROM overdose_events o WHERE ${ts('o.occurred_at')} AND o.naloxone_used=1 AND o.survived=1`, ...tsP).n,
      fatal: db.one(`SELECT COUNT(*) n FROM overdose_events o WHERE ${ts('o.occurred_at')} AND (o.kind='fatal' OR o.survived=0)`, ...tsP).n,
      community_reported: db.one(`SELECT COUNT(*) n FROM overdose_events o WHERE ${ts('o.occurred_at')} AND o.client_id IS NULL`, ...tsP).n,
      naloxone_doses: db.one(`SELECT COALESCE(SUM(o.naloxone_doses),0) n FROM overdose_events o WHERE ${ts('o.occurred_at')}`, ...tsP).n,
      by_month: db.all(`SELECT substr(o.occurred_at,1,7) month, COUNT(*) n, SUM(CASE WHEN o.naloxone_used=1 AND o.survived=1 THEN 1 ELSE 0 END) reversals FROM overdose_events o WHERE ${ts('o.occurred_at')} GROUP BY month ORDER BY month`, ...tsP),
      by_administered_by: db.all(`SELECT COALESCE(o.administered_by,'unknown') k, COUNT(*) n FROM overdose_events o WHERE ${ts('o.occurred_at')} AND o.naloxone_used=1 GROUP BY k ORDER BY n DESC`, ...tsP),
    };

    // Naloxone that went out the door, including community distribution with no identified client.
    const distribution = db.one(`SELECT COALESCE(SUM(i.naloxone_kits),0) kits, COALESCE(SUM(i.fentanyl_strips),0) strips,
      COALESCE(SUM(CASE WHEN i.client_id IS NULL THEN i.naloxone_kits ELSE 0 END),0) community_kits
      FROM interventions i WHERE ${ts('i.occurred_at')} ${fundJoin}`, ...tsP, ...fundP);

    // Small-cell suppression: a breakdown row counting fewer than eleven people can identify them once it is
    // crossed with another table (the one Vietnamese-speaking veteran in a small county). Totals stay exact;
    // any row under the threshold is reported as "<11" with the count withheld.
    const SMALL_CELL = 11;
    const suppress = (rows) => rows.map(x => (typeof x.n === 'number' && x.n > 0 && x.n < SMALL_CELL ? { ...x, n: '<11', suppressed: true } : x));

    const out = {
      from, to, funding_source_id: fund,
      small_cell_threshold: SMALL_CELL,
      unduplicated: {
        served,
        new_admissions: db.one(`SELECT COUNT(DISTINCT c.id) n FROM clients c WHERE c.deleted_at IS NULL AND c.intake_date BETWEEN ? AND ? AND ${cf.sql}`, from, to, ...cf.params).n,
        // Of the people served: how many were referred on, admitted somewhere, and are on MAT.
        with_a_referral: one(`SELECT COUNT(DISTINCT r.client_id) n FROM referrals r JOIN served s ON s.id=r.client_id WHERE ${ts('r.referred_at')}`, ...tsP).n,
        admitted_after_referral: one(`SELECT COUNT(DISTINCT r.client_id) n FROM referrals r JOIN served s ON s.id=r.client_id WHERE ${ts('r.admitted_at')}`, ...tsP).n,
        on_mat: one(`SELECT COUNT(*) n FROM clients c JOIN served s ON s.id=c.id WHERE c.mat_status='active'`).n,
      },
      demographics: {
        by_gender: suppress(demographics('gender', 'gender')),
        by_language: suppress(demographics('preferred_language', 'language')),
        by_housing: suppress(demographics('housing_status', 'housing')),
        by_insurance: suppress(demographics('insurance', 'insurance')),
        by_race_code: suppress(Object.entries(byRace).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n)),
        by_ethnicity: suppress(demographics('race_ethnicity', 'ethnicity')),
      },
      episodes: { ...episodes, by_discharge_reason: suppress(episodes.by_discharge_reason) },
      overdose: { ...overdose, by_administered_by: suppress(overdose.by_administered_by) },
      naloxone_distribution: distribution,
      by_funding_source: db.all(`SELECT f.id, f.name, f.grant_number, f.fiscal_year_start, f.fiscal_year_end,
          (SELECT COUNT(DISTINCT i.client_id) FROM interventions i JOIN clients c ON c.id=i.client_id WHERE i.funding_source_id=f.id AND c.deleted_at IS NULL AND ${ts('i.occurred_at')}) AS clients_served,
          (SELECT COUNT(*) FROM interventions i WHERE i.funding_source_id=f.id AND ${ts('i.occurred_at')}) AS services,
          (SELECT COALESCE(SUM(t.minutes),0) FROM time_entries t WHERE t.funding_source_id=f.id AND t.work_date BETWEEN ? AND ? AND t.status='approved') AS approved_minutes
        FROM funding_sources f WHERE f.is_active=1 ORDER BY f.name`, ...tsP, ...tsP, from, to),
    };
    audit.log({ user: ctx.user, action: 'report.funder', ip: ctx.ip, details: { from, to, funding_source_id: fund || undefined, served } });
    return out;
  });

  // Exports: CSV or Excel per table, or one Excel workbook with every table. Needs export:read; de-identified
  // (HIPAA Safe Harbor) unless identified=1 and the user holds export:identified — and an identified export
  // is a disclosure: it must say to whom and why, and it writes one accounting row per client it contains.
  r.get('/api/reports/export/:kind', auth.requireAuth, auth.requirePerm('export:read'), async (ctx) => {
    const period = range(ctx); const { from, to } = period;
    const identified = ctx.query.get('identified') === '1' && auth.hasPerm(ctx.user, 'export:identified');
    const recipient = (ctx.query.get('recipient') || '').trim(); const purpose = (ctx.query.get('purpose') || '').trim();
    if (identified && (!recipient || !purpose)) throw require('../http').badRequest('An identified export must name its recipient and purpose (recipient= and purpose=); they are written to the accounting of disclosures for every client it contains');
    const disclosure = require('../disclosure');
    // An identified export is a disclosure like any other and passes the same gate (server/disclosure.js):
    // one lawful basis for the file, checked against every client in it once the rows are known. Under
    // consent, a client whose consent does not name the stated recipient is left out of the file (and
    // listed by code); a QSOA, research or audit basis names its registered agreement with the recipient.
    const gate = { basis: ctx.query.get('basis') || '', restriction_reviewed: ctx.query.get('restriction_reviewed') === '1', legal_proceeding: ctx.query.get('legal_proceeding') === '1',
      recipient, agreement_id: ctx.query.get('agreement_id') || undefined, user: ctx.user };
    if (identified) disclosure.requireExportBasis([], gate);
    const part2 = identified && disclosure.part2Program(); const notice = disclosure.notice();
    const format = ctx.query.get('format') === 'xlsx' || ctx.params.kind === 'workbook' ? 'xlsx' : 'csv';
    const X = require('../exports');
    const D = X.datasets(ctx, { ...period, identified });
    const S = require('../spreadsheet');
    // Which of the file's clients it may name (all of them, except under consent), and why the rest cannot.
    let excludedCodes = [];
    const admit = (kind, ids) => {
      if (!identified) return { consentOf: new Map(), excluded: [], agreement: null };
      let g;
      try { g = disclosure.requireExportBasis(ids, gate); }
      catch (e) { audit.log({ user: ctx.user, action: 'report.export.refused', ip: ctx.ip, success: false, details: { kind, basis: gate.basis, clients: ids.length, reason: String(e.message).slice(0, 200) } }); throw e; }
      if (g.excluded.length) {
        excludedCodes = db.all(`SELECT client_code FROM clients WHERE id IN (${g.excluded.map(() => '?').join(',')})`, ...g.excluded).map(r => r.client_code).sort();
        aboutSheet.rows.push({ k: 'Left out (no consent on file naming this recipient)', v: excludedCodes.join(', ') });
      }
      return g;
    };
    // One accounting row per client per export file: the workbook is one disclosure of everything it
    // holds, not one per sheet, so the recipient's name does not appear a dozen times in a client's accounting.
    const accountFor = (kind, ids, g) => {
      if (!identified) return [];
      const written = ids.map(clientId => disclosure.record({ clientId, consentId: g.consentOf.get(clientId) || null, agreementId: g.agreement?.id || null, recipient, purpose, what: `Identified export: ${kind} (${from} to ${to})`, method: 'export', basis: gate.basis, source: 'export', sourceRef: kind, user: ctx.user, ip: ctx.ip }));
      // A file naming a great many people at once is exactly what a privacy officer wants to look at, lawful
      // or not: past the threshold it opens a draft incident for review (server/incidents.js).
      require('../incidents').maybeMassExport({ clients: ids.length, kind, user: ctx.user });
      return written;
    };
    const aboutSheet = { name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: [
      { k: 'Classification', v: identified ? `Identified export — PHI. Disclosed to: ${recipient}. Purpose: ${purpose}. Lawful basis: ${gate.basis}.` : X.DEID_LABEL },
      { k: 'Period', v: `${from} to ${to}` }, { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
      ...(part2 ? [{ k: 'Protected by 42 CFR Part 2', v: notice.short }, { k: 'Notice to recipient (42 CFR §2.32)', v: notice.text }] : [])] };
    const label = (k) => ({ key: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) });
    // Coded values ("naloxone_supplies", "reimbursed") go out the way the screen shows them ("Naloxone
    // Supplies", "Reimbursed"); a funder should not have to decode enum names. Identifier-like columns are
    // left exactly as stored.
    const RAW = new Set(['client_code', 'receipt_ref', 'grant_number', 'email', 'website', 'phone', 'fax', 'zip', 'username', 'document_ref', 'medicaid_id', 'address', 'first_name', 'last_name', 'contact_name', 'name', 'organization', 'vendor', 'title', 'template_name', 'fund', 'line', 'resource', 'worker', 'approver', 'assignee', 'completed_by', 'created_by', 'disclosed_by', 'recipient', 'summary', 'description', 'notes', 'purpose', 'what', 'goals', 'flags', 'hours', 'eligibility', 'services', 'languages', 'capacity_notes', 'contact_person', 'intake_process', 'cost_notes', 'restrictions', 'label', 'city']);
    const humanize = (v) => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSbirt\b/, 'SBIRT').replace(/\bMat\b/g, 'MAT').replace(/\bOtp\b/, 'OTP').replace(/\bObot\b/, 'OBOT').replace(/\bEd\b/, 'ED').replace(/\bMh\b/, 'MH').replace(/\bIds\b/, 'IDs').replace(/\bRoi\b/, 'ROI');
    const pretty = (rows, kind) => rows.map(r => { const listed = X.LIST_COLUMNS[kind] || {}; const o = {}; for (const [k, v] of Object.entries(r)) o[k] = (typeof v === 'string' && !RAW.has(k) && !(k in listed) && /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(v) && v.length <= 40) ? humanize(v) : v; return o; });
    // The classification travels in a response header and the filename (and, for Excel, the About sheet).
    // It used to be a "# …" comment line ahead of the CSV header, which put the label in row 1 of every
    // spreadsheet and broke re-import; CSV has no comment syntax.
    const classification = identified ? `Identified export - PHI. Disclosed to: ${recipient}. Purpose: ${purpose}. Basis: ${gate.basis}.${part2 ? ` ${notice.short}` : ''} Generated ${db.now()}.` : `${X.DEID_LABEL} Generated ${db.now()}.`;
    const headerSafe = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 900);
    let body, filename, type;
    if (ctx.params.kind === 'workbook') {
      // Every dataset, decrypted, in one file. Yield between sheets so a full-year export does not hold
      // the event loop for several seconds and stall everyone else's requests. The accounting of
      // disclosures sheet is rendered last, after the workbook's own disclosure rows have been written,
      // and without them: a file should not account for itself.
      // The rows are read first, so the clients the file may name are known before any sheet is built.
      const read = []; const clientIds = new Set();
      for (const [kind, d] of Object.entries(D)) {
        if (kind === 'disclosures') { read.push([kind, d, null]); continue; }
        const rows = d.rows();
        for (const id of X.clientIdsOf(rows)) clientIds.add(id);
        read.push([kind, d, rows]);
        await new Promise((resolve) => defer(resolve));
      }
      const g = admit('workbook', [...clientIds]); const out = new Set(g.excluded);
      const sheets = [aboutSheet]; let disclosuresSlot = -1;
      for (const [kind, d, rows] of read) {
        if (kind === 'disclosures') { disclosuresSlot = sheets.length; sheets.push(null); continue; }
        sheets.push({ name: d.label, columns: d.columns.map(label), rows: pretty(X.publicRows(rows.filter(r => !out.has(r._client_id))), kind) });
      }
      const written = new Set(accountFor('workbook', [...clientIds].filter(id => !out.has(id)), g));
      if (disclosuresSlot >= 0) {
        const rows = D.disclosures.rows().filter(r => !written.has(r.id) && !out.has(r._client_id));
        sheets[disclosuresSlot] = { name: D.disclosures.label, columns: D.disclosures.columns.map(label), rows: pretty(X.publicRows(rows), 'disclosures') };
      }
      audit.log({ user: ctx.user, action: 'report.export', ip: ctx.ip, details: { kind: 'workbook', sheets: sheets.map(s => [s.name, s.rows.length]), identified, from, to, clients_disclosed: identified ? clientIds.size : undefined } });
      body = await S.writeWorkbookAsync(sheets); filename = `suds-export-${from}_${to}-${identified ? 'identified' : 'deidentified'}.xlsx`; type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else {
      const d = D[ctx.params.kind === 'clients' ? 'clients' : ctx.params.kind]; if (!d) throw require('../http').notFound('Unknown export');
      const all = d.rows(); const ids = X.clientIdsOf(all);
      const g = admit(ctx.params.kind, ids); const out = new Set(g.excluded);
      const raw = out.size ? all.filter(r => !out.has(r._client_id)) : all;
      const clientsDisclosed = accountFor(ctx.params.kind, ids.filter(id => !out.has(id)), g).length;
      const rows = pretty(X.publicRows(raw), ctx.params.kind);
      audit.log({ user: ctx.user, action: 'report.export', ip: ctx.ip, details: { kind: ctx.params.kind, rows: rows.length, identified, from, to, format, clients_disclosed: identified ? clientsDisclosed : undefined } });
      const suffix = identified ? 'identified' : 'deidentified';
      if (format === 'xlsx') { body = S.writeWorkbook([{ name: d.label, columns: d.columns.map(label), rows }, aboutSheet]); filename = `suds-${ctx.params.kind}-${from}_${to}-${suffix}.xlsx`; type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
      else {
        // CSV has no place for a cover sheet, so an identified file carries the §2.32 notice as its last row,
        // after a blank one: the header stays row 1, and the notice travels with the data wherever it goes.
        body = S.toCsv(rows, d.columns.map(label));
        if (part2) body += '\r\n\r\n' + S.toCsv([{ n: disclosure.fileNotice() }], [{ key: 'n', label: '' }]).split('\r\n')[1];
        filename = `suds-${ctx.params.kind}-${from}_${to}-${suffix}.csv`; type = 'text/csv; charset=utf-8';
      }
    }
    ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"`, 'X-SUDS-Export': headerSafe(classification),
      ...(identified && gate.basis === 'consent' ? { 'X-SUDS-Export-Excluded': excludedCodes.join(',').slice(0, 900) } : {}) });
    ctx.res.end(body);
  });
};
// The report period helper, for other exports that bound a period the same way (server/routes/handoff.js).
module.exports.range = range;
