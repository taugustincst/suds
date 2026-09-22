'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { sendJson } = require('../http');
const M = require('../clients-model');

function range(ctx) {
  const to = ctx.query.get('to') || new Date().toISOString().slice(0, 10);
  const from = ctx.query.get('from') || new Date(Date.parse(to) - 89 * 86400000).toISOString().slice(0, 10);
  return { from, to, toEnd: to + 'T23:59:59.999Z' };
}


module.exports = (r) => {
  r.get('/api/reports/dashboard', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const { from, to, toEnd } = range(ctx);
    const cf = auth.caseloadFilter(ctx.user, 'c.id');
    // {CF} is expanded to the caseload filter; its bound params are spliced in at the position of the placeholder
    const expand = (sql, p) => { const before = sql.slice(0, sql.indexOf('{CF}')); const n = (before.match(/\?/g) || []).length; return [sql.replace('{CF}', cf.sql), [...p.slice(0, n), ...cf.params, ...p.slice(n)]]; };
    const scoped = (sql, ...p) => { const [q, a] = expand(sql, p); return db.all(q, ...a); };
    const scoped1 = (sql, ...p) => { const [q, a] = expand(sql, p); return db.one(q, ...a); };
    const today = new Date().toISOString().slice(0, 10);
    const out = {
      from, to,
      clients: { active: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF}`).n, waitlist: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='waitlist' AND {CF}`).n,
        new_in_range: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND intake_date BETWEEN ? AND ? AND {CF}`, from, to).n,
        high_risk: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND risk_level IN ('high','critical') AND {CF}`).n,
        no_contact_30d: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF} AND NOT EXISTS (SELECT 1 FROM interventions i WHERE i.client_id=c.id AND i.occurred_at >= ?) AND NOT EXISTS (SELECT 1 FROM calls ca WHERE ca.client_id=c.id AND ca.outcome IN ('reached','replied') AND ca.started_at >= ?)`, new Date(Date.now() - 30 * 86400000).toISOString(), new Date(Date.now() - 30 * 86400000).toISOString()).n,
        by_status: scoped(`SELECT status, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND {CF} GROUP BY status`),
        by_substance: scoped(`SELECT COALESCE(primary_substance,'unknown') k, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF} GROUP BY k ORDER BY n DESC`),
        mat: scoped(`SELECT COALESCE(mat_status,'unknown') k, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF} GROUP BY k`),
      },
      interventions: { total: scoped1(`SELECT COUNT(*) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE i.occurred_at BETWEEN ? AND ? AND {CF}`, from, toEnd).n,
        minutes: scoped1(`SELECT COALESCE(SUM(duration_minutes),0) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE i.occurred_at BETWEEN ? AND ? AND {CF}`, from, toEnd).n,
        by_type: db.all(`SELECT i.type k, COUNT(*) n, SUM(duration_minutes) minutes FROM interventions i JOIN clients c ON c.id=i.client_id WHERE i.occurred_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY i.type ORDER BY n DESC`, from, toEnd, ...cf.params),
        by_week: db.all(`SELECT strftime('%Y-%W', i.occurred_at) k, COUNT(*) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE i.occurred_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY k ORDER BY k`, from, toEnd, ...cf.params),
        naloxone_kits: scoped1(`SELECT COALESCE(SUM(naloxone_kits),0) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE i.occurred_at BETWEEN ? AND ? AND {CF}`, from, toEnd).n,
        fentanyl_strips: scoped1(`SELECT COALESCE(SUM(fentanyl_strips),0) n FROM interventions i JOIN clients c ON c.id=i.client_id WHERE i.occurred_at BETWEEN ? AND ? AND {CF}`, from, toEnd).n,
        by_worker: db.all(`SELECT u.display_name k, COUNT(*) n, SUM(duration_minutes) minutes FROM interventions i JOIN users u ON u.id=i.user_id JOIN clients c ON c.id=i.client_id WHERE i.occurred_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY u.id ORDER BY n DESC`, from, toEnd, ...cf.params),
      },
      calls: { total: db.one(`SELECT COUNT(*) n FROM calls WHERE started_at BETWEEN ? AND ?`, from, toEnd).n, minutes: db.one(`SELECT COALESCE(SUM(duration_minutes),0) n FROM calls WHERE started_at BETWEEN ? AND ?`, from, toEnd).n,
        crisis: db.one(`SELECT COUNT(*) n FROM calls WHERE crisis=1 AND started_at BETWEEN ? AND ?`, from, toEnd).n, by_outcome: db.all(`SELECT outcome k, COUNT(*) n FROM calls WHERE started_at BETWEEN ? AND ? GROUP BY outcome ORDER BY n DESC`, from, toEnd),
        by_direction: db.all(`SELECT direction k, COUNT(*) n FROM calls WHERE started_at BETWEEN ? AND ? GROUP BY direction`, from, toEnd),
        // Texts are logged alongside calls, so say how the total splits rather than reporting them as calls.
        texts: db.one(`SELECT COUNT(*) n FROM calls WHERE method='text' AND started_at BETWEEN ? AND ?`, from, toEnd).n },
      referrals: { total: db.one(`SELECT COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql}`, from, toEnd, ...cf.params).n,
        by_status: db.all(`SELECT r.status k, COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY r.status ORDER BY n DESC`, from, toEnd, ...cf.params),
        by_category: db.all(`SELECT res.category k, COUNT(*) n, SUM(CASE WHEN r.status IN ('admitted','completed') THEN 1 ELSE 0 END) successful FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN clients c ON c.id=r.client_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY res.category ORDER BY n DESC`, from, toEnd, ...cf.params),
        open: db.one(`SELECT COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.status IN ('pending','contacted','accepted','waitlisted','scheduled') AND ${cf.sql}`, ...cf.params).n,
        median_days_to_admit: (() => { const d = db.all(`SELECT (julianday(admitted_at)-julianday(referred_at)) d FROM referrals WHERE admitted_at IS NOT NULL AND referred_at BETWEEN ? AND ? ORDER BY d`, from, toEnd).map(x => x.d); return d.length ? d[Math.floor(d.length / 2)] : null; })() },
      tasks: { open: db.one(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','in_progress') AND (assigned_to=? OR ?)`, ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n,
        overdue: db.one(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','in_progress') AND (CASE WHEN length(due_at)=10 THEN due_at < date('now','localtime') ELSE due_at < ? END) AND (assigned_to=? OR ?)`, db.now(), ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n,
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
      budget: auth.hasPerm(ctx.user, 'budget:read') ? db.one(`SELECT (SELECT COALESCE(SUM(total_amount),0) FROM funding_sources WHERE is_active=1) total, (SELECT COALESCE(SUM(amount),0) FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE f.is_active=1 AND e.status IN ('approved','reimbursed')) spent, (SELECT COALESCE(SUM(amount),0) FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE f.is_active=1 AND e.status='pending') pending`) : null,
      // Scoped to active clients so this count matches what #/clients?consent_expiring=1 shows by default —
      // otherwise the badge counts a closed or inactive client's consent that the deep-linked list, filtered
      // to active, never displays.
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
      spend: auth.hasPerm(ctx.user, 'budget:read') ? db.all(`SELECT substr(spent_at,1,7) month, SUM(amount) amount FROM expenditures WHERE status IN ('approved','reimbursed') AND spent_at >= ? GROUP BY month ORDER BY month`, s) : [],
      time: db.all(`SELECT substr(work_date,1,7) month, SUM(minutes) minutes FROM time_entries WHERE work_date >= ? GROUP BY month ORDER BY month`, s),
    };
  });

  // The report a funder actually asks for: how many distinct people were served in the period, counted once
  // each, broken down the way a grant report is broken down. Every count on this page is unduplicated —
  // COUNT(DISTINCT client_id) — because "1,400 services" and "310 people" are different questions and the
  // platform could previously only answer the first.
  r.get('/api/reports/funder', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const { from, to, toEnd } = range(ctx);
    const cf = auth.caseloadFilter(ctx.user, 'c.id');
    const fund = ctx.query.get('funding_source_id') || null;
    // Restricting to a funding source means counting only the work charged to it.
    const fundJoin = fund ? 'AND i.funding_source_id=?' : '';
    const fundP = fund ? [fund] : [];

    const served = db.one(`SELECT COUNT(DISTINCT x.client_id) n FROM (
        SELECT i.client_id FROM interventions i JOIN clients c ON c.id=i.client_id WHERE i.occurred_at BETWEEN ? AND ? AND ${cf.sql} ${fundJoin}
        UNION SELECT ca.client_id FROM calls ca JOIN clients c ON c.id=ca.client_id WHERE ca.started_at BETWEEN ? AND ? AND ca.client_id IS NOT NULL AND ${cf.sql}
      ) x`, from, toEnd, ...cf.params, ...fundP, from, toEnd, ...cf.params).n;

    const demographics = (col, label) => db.all(`SELECT COALESCE(NULLIF(c.${col},''),'unknown') k, COUNT(DISTINCT c.id) n
      FROM clients c WHERE c.deleted_at IS NULL AND ${cf.sql} AND EXISTS (SELECT 1 FROM interventions i WHERE i.client_id=c.id AND i.occurred_at BETWEEN ? AND ?)
      GROUP BY k ORDER BY n DESC`, ...cf.params, from, toEnd).map(x => ({ ...x, dimension: label }));

    // race_codes is comma separated because a person may report more than one, so each is counted
    // separately and the total will exceed the number of people served. That is how funders want it.
    const raceRows = db.all(`SELECT c.race_codes FROM clients c WHERE c.deleted_at IS NULL AND ${cf.sql}
      AND EXISTS (SELECT 1 FROM interventions i WHERE i.client_id=c.id AND i.occurred_at BETWEEN ? AND ?)`, ...cf.params, from, toEnd);
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
      events: db.one(`SELECT COUNT(*) n FROM overdose_events o WHERE o.occurred_at BETWEEN ? AND ?`, from, toEnd).n,
      reversals: db.one(`SELECT COUNT(*) n FROM overdose_events o WHERE o.occurred_at BETWEEN ? AND ? AND o.naloxone_used=1 AND o.survived=1`, from, toEnd).n,
      fatal: db.one(`SELECT COUNT(*) n FROM overdose_events o WHERE o.occurred_at BETWEEN ? AND ? AND (o.kind='fatal' OR o.survived=0)`, from, toEnd).n,
      community_reported: db.one(`SELECT COUNT(*) n FROM overdose_events o WHERE o.occurred_at BETWEEN ? AND ? AND o.client_id IS NULL`, from, toEnd).n,
      naloxone_doses: db.one(`SELECT COALESCE(SUM(o.naloxone_doses),0) n FROM overdose_events o WHERE o.occurred_at BETWEEN ? AND ?`, from, toEnd).n,
      by_month: db.all(`SELECT substr(o.occurred_at,1,7) month, COUNT(*) n, SUM(CASE WHEN o.naloxone_used=1 AND o.survived=1 THEN 1 ELSE 0 END) reversals FROM overdose_events o WHERE o.occurred_at BETWEEN ? AND ? GROUP BY month ORDER BY month`, from, toEnd),
      by_administered_by: db.all(`SELECT COALESCE(o.administered_by,'unknown') k, COUNT(*) n FROM overdose_events o WHERE o.occurred_at BETWEEN ? AND ? AND o.naloxone_used=1 GROUP BY k ORDER BY n DESC`, from, toEnd),
    };

    // Naloxone that went out the door, including community distribution with no identified client.
    const distribution = db.one(`SELECT COALESCE(SUM(i.naloxone_kits),0) kits, COALESCE(SUM(i.fentanyl_strips),0) strips,
      COALESCE(SUM(CASE WHEN i.client_id IS NULL THEN i.naloxone_kits ELSE 0 END),0) community_kits
      FROM interventions i WHERE i.occurred_at BETWEEN ? AND ? ${fundJoin}`, from, toEnd, ...fundP);

    const out = {
      from, to, funding_source_id: fund,
      unduplicated: {
        served,
        new_admissions: db.one(`SELECT COUNT(DISTINCT c.id) n FROM clients c WHERE c.deleted_at IS NULL AND c.intake_date BETWEEN ? AND ? AND ${cf.sql}`, from, to, ...cf.params).n,
        with_a_referral: db.one(`SELECT COUNT(DISTINCT r.client_id) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql}`, from, toEnd, ...cf.params).n,
        admitted_after_referral: db.one(`SELECT COUNT(DISTINCT r.client_id) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.admitted_at BETWEEN ? AND ? AND ${cf.sql}`, from, toEnd, ...cf.params).n,
        on_mat: db.one(`SELECT COUNT(DISTINCT c.id) n FROM clients c WHERE c.deleted_at IS NULL AND c.mat_status='active' AND ${cf.sql}`, ...cf.params).n,
      },
      demographics: {
        by_gender: demographics('gender', 'gender'),
        by_language: demographics('preferred_language', 'language'),
        by_housing: demographics('housing_status', 'housing'),
        by_insurance: demographics('insurance', 'insurance'),
        by_race_code: Object.entries(byRace).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n),
        by_ethnicity: demographics('race_ethnicity', 'ethnicity'),
      },
      episodes, overdose, naloxone_distribution: distribution,
      by_funding_source: db.all(`SELECT f.id, f.name, f.grant_number, f.fiscal_year_start, f.fiscal_year_end,
          (SELECT COUNT(DISTINCT i.client_id) FROM interventions i WHERE i.funding_source_id=f.id AND i.occurred_at BETWEEN ? AND ?) AS clients_served,
          (SELECT COUNT(*) FROM interventions i WHERE i.funding_source_id=f.id AND i.occurred_at BETWEEN ? AND ?) AS services,
          (SELECT COALESCE(SUM(t.minutes),0) FROM time_entries t WHERE t.funding_source_id=f.id AND t.work_date BETWEEN ? AND ? AND t.status='approved') AS approved_minutes
        FROM funding_sources f WHERE f.is_active=1 ORDER BY f.name`, from, toEnd, from, toEnd, from, to),
    };
    audit.log({ user: ctx.user, action: 'report.funder', ip: ctx.ip, details: { from, to, funding_source_id: fund || undefined, served } });
    return out;
  });

  // Exports: CSV or Excel per table, or one Excel workbook with every table. De-identified unless identified=1 and export:read.
  r.get('/api/reports/export/:kind', auth.requireAuth, auth.requirePerm('reports:read'), async (ctx) => {
    const { from, to, toEnd } = range(ctx);
    const identified = ctx.query.get('identified') === '1' && auth.hasPerm(ctx.user, 'export:identified');
    const format = ctx.query.get('format') === 'xlsx' || ctx.params.kind === 'workbook' ? 'xlsx' : 'csv';
    const D = require('../exports').datasets(ctx, { from, to, toEnd, identified });
    const S = require('../spreadsheet');
    const label = (k) => ({ key: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) });
    // Coded values ("naloxone_supplies", "reimbursed") go out the way the screen shows them ("Naloxone
    // Supplies", "Reimbursed"); a funder should not have to decode enum names. Identifier-like columns are
    // left exactly as stored.
    const RAW = new Set(['client_code', 'receipt_ref', 'grant_number', 'email', 'website', 'phone', 'fax', 'zip', 'username', 'document_ref', 'medicaid_id', 'address', 'first_name', 'last_name', 'contact_name', 'name', 'organization', 'vendor', 'title', 'template_name', 'fund', 'line', 'resource', 'worker', 'approver', 'assignee', 'completed_by', 'created_by', 'disclosed_by', 'recipient', 'summary', 'description', 'notes', 'purpose', 'what', 'goals', 'flags', 'hours', 'eligibility', 'services', 'languages', 'capacity_notes', 'contact_person', 'intake_process', 'cost_notes', 'restrictions', 'label', 'city']);
    const humanize = (v) => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSbirt\b/, 'SBIRT').replace(/\bMat\b/g, 'MAT').replace(/\bOtp\b/, 'OTP').replace(/\bObot\b/, 'OBOT').replace(/\bEd\b/, 'ED').replace(/\bMh\b/, 'MH').replace(/\bIds\b/, 'IDs').replace(/\bRoi\b/, 'ROI');
    const pretty = (rows) => rows.map(r => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = (typeof v === 'string' && !RAW.has(k) && /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(v) && v.length <= 40) ? humanize(v) : v; return o; });
    let body, filename, type;
    if (ctx.params.kind === 'workbook') {
      // Every dataset, decrypted, in one file. Yield between sheets so a full-year export does not hold
      // the event loop for several seconds and stall everyone else's requests.
      const sheets = [];
      for (const [, d] of Object.entries(D)) {
        sheets.push({ name: d.label, columns: d.columns.map(label), rows: pretty(d.rows()) });
        await new Promise((resolve) => setImmediate(resolve));
      }
      audit.log({ user: ctx.user, action: 'report.export', ip: ctx.ip, details: { kind: 'workbook', sheets: sheets.map(s => [s.name, s.rows.length]), identified, from, to } });
      body = await S.writeWorkbookAsync(sheets); filename = `suds-export-${from}_${to}.xlsx`; type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else {
      const d = D[ctx.params.kind === 'clients' ? 'clients' : ctx.params.kind]; if (!d) throw require('../http').notFound('Unknown export');
      const rows = pretty(d.rows());
      audit.log({ user: ctx.user, action: 'report.export', ip: ctx.ip, details: { kind: ctx.params.kind, rows: rows.length, identified, from, to, format } });
      if (format === 'xlsx') { body = S.writeWorkbook([{ name: d.label, columns: d.columns.map(label), rows }]); filename = `suds-${ctx.params.kind}-${from}_${to}.xlsx`; type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
      else { body = S.toCsv(rows, d.columns.map(label)); filename = `suds-${ctx.params.kind}-${from}_${to}.csv`; type = 'text/csv; charset=utf-8'; }
    }
    ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"` });
    ctx.res.end(body);
  });
};
