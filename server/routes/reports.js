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

function csv(rows, columns) {
  const esc = v => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\r\n');
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
        no_contact_30d: scoped1(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND {CF} AND NOT EXISTS (SELECT 1 FROM interventions i WHERE i.client_id=c.id AND i.occurred_at >= ?) AND NOT EXISTS (SELECT 1 FROM calls ca WHERE ca.client_id=c.id AND ca.outcome='reached' AND ca.started_at >= ?)`, new Date(Date.now() - 30 * 86400000).toISOString(), new Date(Date.now() - 30 * 86400000).toISOString()).n,
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
        by_direction: db.all(`SELECT direction k, COUNT(*) n FROM calls WHERE started_at BETWEEN ? AND ? GROUP BY direction`, from, toEnd) },
      referrals: { total: db.one(`SELECT COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql}`, from, toEnd, ...cf.params).n,
        by_status: db.all(`SELECT r.status k, COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY r.status ORDER BY n DESC`, from, toEnd, ...cf.params),
        by_category: db.all(`SELECT res.category k, COUNT(*) n, SUM(CASE WHEN r.status IN ('admitted','completed') THEN 1 ELSE 0 END) successful FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN clients c ON c.id=r.client_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY res.category ORDER BY n DESC`, from, toEnd, ...cf.params),
        open: db.one(`SELECT COUNT(*) n FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.status IN ('pending','contacted','accepted','waitlisted','scheduled') AND ${cf.sql}`, ...cf.params).n,
        median_days_to_admit: (() => { const d = db.all(`SELECT (julianday(admitted_at)-julianday(referred_at)) d FROM referrals WHERE admitted_at IS NOT NULL AND referred_at BETWEEN ? AND ? ORDER BY d`, from, toEnd).map(x => x.d); return d.length ? d[Math.floor(d.length / 2)] : null; })() },
      tasks: { open: db.one(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','in_progress') AND (assigned_to=? OR ?)`, ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n,
        overdue: db.one(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','in_progress') AND due_at < ? AND (assigned_to=? OR ?)`, db.now(), ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n,
        due_today: db.one(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','in_progress') AND substr(due_at,1,10)=? AND (assigned_to=? OR ?)`, today, ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n },
      time: auth.hasPerm(ctx.user, 'time:read') || auth.hasPerm(ctx.user, 'time:write') ? { minutes: db.one(`SELECT COALESCE(SUM(minutes),0) n FROM time_entries WHERE work_date BETWEEN ? AND ? AND (user_id=? OR ?)`, from, to, ctx.user.id, auth.hasPerm(ctx.user, 'time:all') ? 1 : 0).n,
        by_category: db.all(`SELECT category k, SUM(minutes) n FROM time_entries WHERE work_date BETWEEN ? AND ? AND (user_id=? OR ?) GROUP BY category ORDER BY n DESC`, from, to, ctx.user.id, auth.hasPerm(ctx.user, 'time:all') ? 1 : 0) } : null,
      notes: { unsigned: db.one(`SELECT COUNT(*) n FROM notes WHERE status='draft' AND deleted_at IS NULL AND author_id=?`, ctx.user.id).n,
        unsigned_overdue: db.one(`SELECT COUNT(*) n FROM notes WHERE status='draft' AND deleted_at IS NULL AND author_id=? AND created_at < ?`, ctx.user.id, new Date(Date.now() - Number(db.getSetting('note_lock_days', '3')) * 86400000).toISOString()).n, staged_imports: db.one(`SELECT COUNT(*) n FROM import_items x JOIN imports i ON i.id=x.import_id WHERE x.status='staged' AND (i.imported_by=? OR i.imported_by IS NULL OR ?)`, ctx.user.id, auth.hasPerm(ctx.user, 'clients:all') ? 1 : 0).n },
      budget: auth.hasPerm(ctx.user, 'budget:read') ? db.one(`SELECT (SELECT COALESCE(SUM(total_amount),0) FROM funding_sources WHERE is_active=1) total, (SELECT COALESCE(SUM(amount),0) FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE f.is_active=1 AND e.status IN ('approved','reimbursed')) spent, (SELECT COALESCE(SUM(amount),0) FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE f.is_active=1 AND e.status='pending') pending`) : null,
      consents_expiring: db.all(`SELECT co.id, co.client_id, co.type, co.recipient, co.expires_at, c.client_code FROM consents co JOIN clients c ON c.id=co.client_id WHERE co.revoked_at IS NULL AND co.expires_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY co.expires_at LIMIT 20`, today, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), ...cf.params),
    };
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
      mat_linkage: db.all(`SELECT substr(referred_at,1,7) month, COUNT(*) n FROM referrals r JOIN resources res ON res.id=r.resource_id WHERE res.category IN ('mat_otp','mat_obot') AND r.status IN ('admitted','completed') AND referred_at >= ? GROUP BY month ORDER BY month`, s),
      spend: auth.hasPerm(ctx.user, 'budget:read') ? db.all(`SELECT substr(spent_at,1,7) month, SUM(amount) amount FROM expenditures WHERE status IN ('approved','reimbursed') AND spent_at >= ? GROUP BY month ORDER BY month`, s) : [],
      time: db.all(`SELECT substr(work_date,1,7) month, SUM(minutes) minutes FROM time_entries WHERE work_date >= ? GROUP BY month ORDER BY month`, s),
    };
  });

  // CSV exports (de-identified by default; identified requires export:read)
  r.get('/api/reports/export/:kind', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const { from, to, toEnd } = range(ctx);
    const identified = ctx.query.get('identified') === '1' && auth.hasPerm(ctx.user, 'export:read');
    const cf = auth.caseloadFilter(ctx.user, 'c.id');
    let rows, cols;
    switch (ctx.params.kind) {
      case 'interventions':
        rows = db.all(`SELECT i.occurred_at, c.client_code, i.type, i.duration_minutes, i.location, i.modality, i.outcome, i.naloxone_kits, i.fentanyl_strips, u.display_name worker, f.name funding_source, i.cost, i.summary FROM interventions i JOIN clients c ON c.id=i.client_id JOIN users u ON u.id=i.user_id LEFT JOIN funding_sources f ON f.id=i.funding_source_id WHERE i.occurred_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY i.occurred_at`, from, toEnd, ...cf.params);
        cols = ['occurred_at', 'client_code', 'type', 'duration_minutes', 'location', 'modality', 'outcome', 'naloxone_kits', 'fentanyl_strips', 'worker', 'funding_source', 'cost', 'summary']; break;
      case 'calls':
        rows = db.all(`SELECT ca.started_at, c.client_code, ca.direction, ca.contact_type, ca.duration_minutes, ca.outcome, ca.crisis, ca.purpose, u.display_name worker FROM calls ca LEFT JOIN clients c ON c.id=ca.client_id JOIN users u ON u.id=ca.user_id WHERE ca.started_at BETWEEN ? AND ? ORDER BY ca.started_at`, from, toEnd);
        cols = ['started_at', 'client_code', 'direction', 'contact_type', 'duration_minutes', 'outcome', 'crisis', 'purpose', 'worker']; break;
      case 'time':
        rows = db.all(`SELECT t.work_date, u.display_name worker, c.client_code, t.category, t.minutes, t.billable, f.name funding_source, t.description FROM time_entries t JOIN users u ON u.id=t.user_id LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN funding_sources f ON f.id=t.funding_source_id WHERE t.work_date BETWEEN ? AND ? AND (t.user_id=? OR ?) ORDER BY t.work_date`, from, to, ctx.user.id, auth.hasPerm(ctx.user, 'time:all') ? 1 : 0);
        cols = ['work_date', 'worker', 'client_code', 'category', 'minutes', 'billable', 'funding_source', 'description']; break;
      case 'referrals':
        rows = db.all(`SELECT r.referred_at, c.client_code, res.name resource, res.category, r.status, r.urgency, r.warm_handoff, r.appointment_at, r.admitted_at, r.closed_at, r.outcome, r.barrier, u.display_name worker FROM referrals r JOIN clients c ON c.id=r.client_id JOIN resources res ON res.id=r.resource_id JOIN users u ON u.id=r.user_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY r.referred_at`, from, toEnd, ...cf.params);
        cols = ['referred_at', 'client_code', 'resource', 'category', 'status', 'urgency', 'warm_handoff', 'appointment_at', 'admitted_at', 'closed_at', 'outcome', 'barrier', 'worker']; break;
      case 'expenditures':
        auth.requirePerm('budget:read')(ctx);
        rows = db.all(`SELECT e.spent_at, f.name fund, b.label line, e.category, e.amount, e.status, c.client_code, e.vendor, e.description, e.receipt_ref, u.display_name worker FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id LEFT JOIN budget_lines b ON b.id=e.budget_line_id LEFT JOIN clients c ON c.id=e.client_id JOIN users u ON u.id=e.user_id WHERE e.spent_at BETWEEN ? AND ? ORDER BY e.spent_at`, from, to);
        cols = ['spent_at', 'fund', 'line', 'category', 'amount', 'status', 'client_code', 'vendor', 'description', 'receipt_ref', 'worker']; break;
      case 'clients': {
        const raw = db.all(`SELECT c.* FROM clients c WHERE c.deleted_at IS NULL AND ${cf.sql} ORDER BY c.client_code`, ...cf.params);
        rows = raw.map(x => { const d = M.decryptRow(x, { deidentify: !identified }); return d; });
        cols = ['client_code', ...(identified ? ['last_name', 'first_name', 'dob', 'phone'] : []), 'status', 'intake_date', 'discharge_date', 'primary_substance', 'asam_level', 'mat_status', 'risk_level', 'housing_status', 'insurance', 'overdose_history', 'naloxone_provided', 'referral_source', 'city', 'zip']; break;
      }
      default: throw require('../http').notFound('Unknown export');
    }
    audit.log({ user: ctx.user, action: 'report.export', ip: ctx.ip, details: { kind: ctx.params.kind, rows: rows.length, identified, from, to } });
    const body = csv(rows, cols);
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="suds-${ctx.params.kind}-${from}_${to}.csv"` });
    ctx.res.end(body);
  });
};
