'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { notFound, badRequest } = require('../http');
const { validate } = require('../validate');
const { uuid, encrypt } = require('../crypto');
const rules = require('../rules');

module.exports = (r) => {
  r.post('/api/clients/:id/assignments', auth.requireAuth, auth.requirePerm('assignments:manage'), (ctx) => {
    const c = db.one(`SELECT id FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id); if (!c) throw notFound();
    // The fields and the rule that the worker is active: server/rules/assignments.js, as sync push applies them.
    const v = validate(ctx.body, rules.forTable('assignments').shape());
    rules.assertWrite('assignments', { client_id: c.id, ...rules.toColumns('assignments', v) }, ctx);
    // ?restores=<id>: the Undo after ending an assignment. The same worker and role go back on the case from
    // now (a new assignment; the ended one stays in the history), and the audit entry says which one it undoes.
    const restores = ctx.query.get('restores');
    const undone = restores ? db.one(`SELECT id FROM assignments WHERE id=? AND client_id=? AND user_id=? AND role_on_case=? AND end_date IS NOT NULL`, restores, c.id, v.user_id, v.role_on_case || 'primary') : null;
    if (restores && !undone) throw badRequest('The assignment to restore was not found, or it has not ended.');
    const id = uuid();
    db.transaction(() => {
      if ((v.role_on_case || 'primary') === 'primary') db.run(`UPDATE assignments SET end_date=?, updated_at=? WHERE client_id=? AND role_on_case='primary' AND end_date IS NULL`, require('../local-date').today(), db.now(), c.id);
      db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,notes_enc,created_by) VALUES(?,?,?,?,?,?,?)`, id, c.id, v.user_id, v.role_on_case || 'primary', v.start_date || require('../local-date').today(), v.notes ? encrypt(v.notes) : null, ctx.user.id);
    });
    audit.log({ user: ctx.user, action: undone ? 'assignment.restore' : 'assignment.create', entity: 'assignment', entityId: id, clientId: c.id, ip: ctx.ip, details: { user_id: v.user_id, role: v.role_on_case, ...(undone ? { restores: undone.id } : {}) } });
    ctx.status = 201; return { id };
  });
  r.post('/api/assignments/:id/end', auth.requireAuth, auth.requirePerm('assignments:manage'), (ctx) => {
    const a = db.one(`SELECT * FROM assignments WHERE id=?`, ctx.params.id); if (!a) throw notFound();
    // The same reach as adding one (server/rules/assignments.js): a client this person can open, or clients:all.
    if (!auth.hasPerm(ctx.user, 'clients:all')) auth.assertClientAccess(ctx, a.client_id);
    // ended_at, not just end_date: the worker loses the client now rather than at the end of the day.
    db.run(`UPDATE assignments SET end_date=?, ended_at=?, updated_at=? WHERE id=?`, require('../local-date').today(), db.now(), db.now(), a.id);
    audit.log({ user: ctx.user, action: 'assignment.end', entity: 'assignment', entityId: a.id, clientId: a.client_id, ip: ctx.ip });
    return { ok: true };
  });
  // My caseload summary
  r.get('/api/caseload', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const uid = ctx.query.get('user_id') && auth.hasPerm(ctx.user, 'clients:all') ? ctx.query.get('user_id') : ctx.user.id;
    const rows = db.all(`SELECT a.role_on_case, c.id, c.client_code, c.status, c.risk_level, c.updated_at,
        (SELECT MAX(t) FROM (SELECT MAX(occurred_at) t FROM interventions i WHERE i.client_id=c.id UNION ALL SELECT MAX(started_at) FROM calls ca WHERE ca.client_id=c.id AND ca.outcome IN ('reached','replied'))) AS last_contact,
        (SELECT COUNT(*) FROM tasks t WHERE t.client_id=c.id AND t.status IN ('open','in_progress') AND t.due_at < ?) AS overdue_tasks
      FROM assignments a JOIN clients c ON c.id=a.client_id WHERE a.user_id=? AND ${auth.activeAssignment('a.')} AND c.deleted_at IS NULL ORDER BY c.risk_level='critical' DESC, c.risk_level='high' DESC, last_contact ASC`, db.now(), uid);
    const M = require('../clients-model');
    const full = db.all(`SELECT * FROM clients WHERE id IN (${rows.map(() => '?').join(',') || "''"})`, ...rows.map(x => x.id));
    const byId = Object.fromEntries(full.map(x => [x.id, M.summary(x)]));
    return { caseload: rows.map(x => ({ ...x, ...byId[x.id] })) };
  });
};
