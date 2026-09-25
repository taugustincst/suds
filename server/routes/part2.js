'use strict';
// 42 CFR Part 2 programme controls that are not a disclosure in themselves: whether this is a Part 2
// programme at all, the §2.22 patient notice (its text, and a record of each time it was given), and the
// subpart E court orders a disclosure for legal proceedings has to rest on. docs/compliance/PART2.md.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const disclosure = require('../disclosure');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { encrypt, decrypt, uuid } = require('../crypto');
const M = require('../clients-model');

// The §2.22 notice as the 2024 rule shapes it (aligned with the HIPAA notice of privacy practices,
// §164.520): the required header, how records may be used and disclosed with and without consent, the
// protection against use in proceedings, the patient's rights, the programme's duties (including breach
// notification), how to complain to the programme and to the Secretary without retaliation, a contact,
// and an effective date. A starting point for the programme's counsel, not legal advice; an administrator
// replaces it under Privacy & Part 2 → Patient notice. {org} and {contact} are filled in when shown.
const DEFAULT_NOTICE = `NOTICE OF PRIVACY PRACTICES — {org}

THIS NOTICE DESCRIBES HOW HEALTH INFORMATION ABOUT YOU MAY BE USED AND DISCLOSED AND HOW YOU CAN GET ACCESS TO THIS INFORMATION. PLEASE REVIEW IT CAREFULLY.

Your substance use disorder (SUD) treatment records are protected by federal law: 42 CFR part 2 and the HIPAA Privacy Rule (45 CFR parts 160 and 164). Generally, {org} may not say to anyone outside the program that you attend it, or disclose any information identifying you as having or having had a substance use disorder, unless you agree in writing or the law allows it.

HOW WE MAY USE AND DISCLOSE YOUR RECORDS
• With your written consent. You may give one consent for all future uses and disclosures for treatment, payment and health care operations. Records disclosed to a HIPAA covered entity or business associate under that consent may be redisclosed by them as HIPAA permits.
• SUD counseling notes are disclosed only with a separate consent for those notes alone.
• Without your consent, only as 42 CFR part 2 allows: to medical personnel in a medical emergency; for research and for audit or evaluation under strict conditions; to report suspected child abuse or neglect as state law requires; about a crime on program premises or against program staff; to a qualified service organization that works for us under a written agreement; and as authorized by a court order that meets 42 CFR part 2, subpart E.
• Your records, and testimony about them, may not be used or disclosed in any civil, criminal, administrative or legislative proceeding against you unless you consent in writing to that use alone or a court orders it under 42 CFR part 2 after notice and an opportunity to respond. A subpoena alone is not enough.

YOUR RIGHTS
• To ask us to restrict how we use or disclose your records. We are not required to agree, except to a request not to disclose to your health plan information about care you paid for in full yourself.
• To ask us to contact you in a particular way or at a particular place.
• To see and get a copy of your records.
• To receive an accounting of disclosures of your records made with and without your consent, and a list of disclosures made by an intermediary under a general designation.
• To revoke a consent in writing at any time, except for action already taken in reliance on it.
• To choose someone to act for you, and to receive a paper copy of this notice on request.
• To be told if there is a breach of your unsecured records.
• If we ever contact you to raise funds for the program, to opt out of any further fundraising communications.

OUR DUTIES
We are required by law to protect the privacy of your records, to give you this notice of our legal duties and privacy practices, to follow the terms of the notice currently in effect, and to notify you following a breach of your unsecured records. We may change this notice; a changed notice applies to all records we hold and will be made available to you.

COMPLAINTS
If you believe your privacy rights have been violated, you may complain to us, and to the Secretary of the U.S. Department of Health and Human Services (Office for Civil Rights, www.hhs.gov/ocr/complaints). We will not retaliate against you for filing a complaint. Violations of 42 CFR part 2 may also be reported to the United States Attorney for the judicial district in which the violation occurred.

CONTACT: {contact}

Effective date: {effective}`;

function settings() {
  const custom = db.getSetting('part2_notice_text', null);
  return {
    part2_program: disclosure.part2Program(),
    notice_template: { text: custom || DEFAULT_NOTICE, is_default: !custom, version: db.getSetting('part2_notice_version', '1'), effective_date: db.getSetting('part2_notice_effective', null) },
    redisclosure_notice: disclosure.notice(),
    mass_export_threshold: require('../incidents').massExportThreshold(),
  };
}
/** The notice as a patient is given it: the template with this programme's name, contact and date filled in. */
function renderedNotice() {
  const s = settings().notice_template;
  const fill = { org: db.getSetting('org_name', null) || 'this program', contact: db.getSetting('program_contact', null) || 'the program\'s privacy officer', effective: s.effective_date || 'on file with the program' };
  return { ...s, rendered: s.text.replace(/\{(org|contact|effective)\}/g, (_, k) => fill[k]) };
}

function presentNotice(n) { return { ...n, notes: n.notes_enc ? decrypt(n.notes_enc) : null, notes_enc: undefined }; }
/** The most recent time this client was given the notice, or null. */
function latestNotice(clientId) {
  const n = db.one(`SELECT n.*, u.display_name AS given_by_name FROM part2_notices n JOIN users u ON u.id=n.given_by WHERE n.client_id=? ORDER BY n.given_at DESC, n.created_at DESC LIMIT 1`, clientId);
  return n ? presentNotice(n) : null;
}
/** SQL: active clients (alias c) with no notice on record. */
const MISSING_NOTICE = `c.deleted_at IS NULL AND c.merged_into IS NULL AND c.status='active' AND NOT EXISTS (SELECT 1 FROM part2_notices n WHERE n.client_id=c.id)`;

const ORDER_SHAPE = {
  order_type: { type: 'string', required: true, enum: C.COURT_ORDER_TYPES }, court: { type: 'string', required: true, maxLen: 200 }, case_ref: { type: 'string', maxLen: 120 },
  issued_at: { type: 'date', required: true }, expires_at: { type: 'date' }, recipient: { type: 'string', maxLen: 300 }, purpose: { type: 'string', required: true, maxLen: 500 },
  scope: { type: 'string', required: true, maxLen: 1000 }, findings_recorded: { type: 'boolean' }, notice_requirement_met: { type: 'boolean' }, covers_counseling_notes: { type: 'boolean' },
  document_ref: { type: 'string', maxLen: 300 },
};

module.exports = (r) => {
  // ---- programme settings and the §2.22 notice text ----
  r.get('/api/part2/settings', auth.requireAuth, () => settings());
  r.get('/api/part2/notice', auth.requireAuth, () => renderedNotice());
  r.put('/api/part2/settings', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const v = validate(ctx.body, { part2_program: { type: 'boolean' }, notice_text: { type: 'string', maxLen: 20000 }, notice_effective_date: { type: 'date' }, reset_notice: { type: 'boolean' }, mass_export_threshold: { type: 'number', integer: true, min: 1, max: 1000000 } }, { partial: true });
    const changed = [];
    db.transaction(() => {
      if (v.part2_program !== undefined && v.part2_program !== null) { db.setSetting('part2_program', v.part2_program ? '1' : '0'); changed.push('part2_program'); }
      if (v.reset_notice || (v.notice_text !== undefined && v.notice_text !== null)) {
        const text = v.reset_notice ? null : String(v.notice_text).trim();
        if (!v.reset_notice && text.length < 200) throw badRequest('The patient notice must say what 42 CFR §2.22 requires; this text is too short to');
        if (text) db.setSetting('part2_notice_text', text); else db.run(`DELETE FROM settings WHERE key='part2_notice_text'`);
        // Every change is a new version: a client's "notice given" record names the version they were given.
        db.setSetting('part2_notice_version', String(Number(db.getSetting('part2_notice_version', '1')) + 1));
        changed.push('notice_text');
      }
      if (v.notice_effective_date) { db.setSetting('part2_notice_effective', v.notice_effective_date); changed.push('notice_effective_date'); }
      if (v.mass_export_threshold) { db.setSetting('mass_export_threshold', String(v.mass_export_threshold)); changed.push('mass_export_threshold'); }
    });
    audit.log({ user: ctx.user, action: 'part2.settings.update', ip: ctx.ip, details: { changed, version: db.getSetting('part2_notice_version', '1') } });
    return settings();
  });

  // ---- §2.22: the notice given to each client ----
  r.get('/api/clients/:id/part2-notices', auth.requireAuth, auth.requirePerm('consents:read', 'consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=?`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const rows = db.all(`SELECT n.*, u.display_name AS given_by_name FROM part2_notices n JOIN users u ON u.id=n.given_by WHERE n.client_id=? ORDER BY n.given_at DESC`, ctx.params.id).map(presentNotice);
    audit.log({ user: ctx.user, action: 'part2_notice.list', entity: 'client', entityId: ctx.params.id, clientId: ctx.params.id, ip: ctx.ip, details: { count: rows.length } });
    return { rows };
  });
  r.post('/api/clients/:id/part2-notices', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, { given_at: { type: 'date', required: true }, method: { type: 'string', required: true, enum: C.PART2_NOTICE_METHODS }, acknowledged: { type: 'boolean' }, ack_refused: { type: 'boolean' }, notes: { type: 'string', maxLen: 2000 } });
    if (v.given_at > new Date().toISOString().slice(0, 10)) throw badRequest('The notice cannot have been given in the future');
    if (v.acknowledged && v.ack_refused) throw badRequest('Either the client signed the acknowledgement or declined to; not both');
    const id = uuid();
    db.run(`INSERT INTO part2_notices(id,client_id,given_at,method,notice_version,acknowledged,ack_refused,notes_enc,given_by) VALUES(?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, v.given_at, v.method, db.getSetting('part2_notice_version', '1'), v.acknowledged ? 1 : 0, v.ack_refused ? 1 : 0, v.notes ? encrypt(v.notes) : null, ctx.user.id);
    audit.log({ user: ctx.user, action: 'part2_notice.create', entity: 'part2_notice', entityId: id, clientId: ctx.params.id, ip: ctx.ip, details: { method: v.method, acknowledged: !!v.acknowledged } });
    ctx.status = 201; return { id };
  });
  // Active clients on this worker's caseload who have no record of being given the notice.
  r.get('/api/part2/notices/missing', auth.requireAuth, auth.requirePerm('consents:read', 'consents:write'), (ctx) => {
    const cf = auth.caseloadFilter(ctx.user, 'c.id');
    const rows = db.all(`SELECT c.id, c.client_code, c.first_name_enc, c.last_name_enc, c.preferred_name_enc, c.intake_date FROM clients c WHERE ${MISSING_NOTICE} AND ${cf.sql} ORDER BY c.intake_date DESC LIMIT 500`, ...cf.params)
      .map(x => { const d = M.decryptRow(x); return { id: x.id, client_code: x.client_code, display_name: d.display_name || `${d.first_name || ''} ${d.last_name || ''}`.trim(), intake_date: x.intake_date }; });
    const total = db.one(`SELECT COUNT(*) n FROM clients c WHERE ${MISSING_NOTICE} AND ${cf.sql}`, ...cf.params).n;
    audit.log({ user: ctx.user, action: 'part2_notice.missing', ip: ctx.ip, details: { count: rows.length } });
    return { rows, total, part2_program: disclosure.part2Program() };
  });

  // ---- subpart E court orders ----
  r.get('/api/clients/:id/court-orders', auth.requireAuth, auth.requirePerm('court-orders:read', 'court-orders:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=?`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const rows = db.all(`SELECT o.*, u.display_name AS recorded_by_name FROM court_orders o JOIN users u ON u.id=o.recorded_by WHERE o.client_id=? ORDER BY o.issued_at DESC`, ctx.params.id).map(require('./consents').presentOrder);
    audit.log({ user: ctx.user, action: 'court_order.list', entity: 'client', entityId: ctx.params.id, clientId: ctx.params.id, ip: ctx.ip, details: { count: rows.length } });
    return { rows };
  });
  r.post('/api/clients/:id/court-orders', auth.requireAuth, auth.requirePerm('court-orders:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, ORDER_SHAPE);
    if (v.expires_at && v.expires_at < v.issued_at) throw badRequest('An order cannot expire before it was issued');
    const id = uuid();
    db.run(`INSERT INTO court_orders(id,client_id,order_type,court_enc,case_ref_enc,issued_at,expires_at,recipient_enc,purpose_enc,scope_enc,findings_recorded,notice_requirement_met,covers_counseling_notes,document_ref,recorded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, v.order_type, encrypt(v.court), v.case_ref ? encrypt(v.case_ref) : null, v.issued_at, v.expires_at || null, v.recipient ? encrypt(v.recipient) : null, encrypt(v.purpose), encrypt(v.scope),
      v.findings_recorded ? 1 : 0, v.notice_requirement_met ? 1 : 0, v.covers_counseling_notes ? 1 : 0, v.document_ref || null, ctx.user.id);
    audit.log({ user: ctx.user, action: 'court_order.create', entity: 'court_order', entityId: id, clientId: ctx.params.id, ip: ctx.ip, details: { order_type: v.order_type, qualifying: !!(v.findings_recorded && v.notice_requirement_met) } });
    const row = db.one(`SELECT * FROM court_orders WHERE id=?`, id);
    // Recorded either way (the order exists); the answer says whether it can authorise a disclosure yet.
    ctx.status = 201; return { id, problems: disclosure.courtOrderProblems(row) };
  });
  r.get('/api/court-orders/:id', auth.requireAuth, auth.requirePerm('court-orders:read', 'court-orders:write'), (ctx) => {
    const o = db.one(`SELECT o.*, u.display_name AS recorded_by_name FROM court_orders o JOIN users u ON u.id=o.recorded_by WHERE o.id=?`, ctx.params.id); if (!o) throw notFound();
    auth.assertClientAccess(ctx, o.client_id);
    audit.log({ user: ctx.user, action: 'court_order.view', entity: 'court_order', entityId: o.id, clientId: o.client_id, ip: ctx.ip });
    return { row: require('./consents').presentOrder(o) };
  });
  r.post('/api/court-orders/:id/vacate', auth.requireAuth, auth.requirePerm('court-orders:write'), (ctx) => {
    const o = db.one(`SELECT * FROM court_orders WHERE id=?`, ctx.params.id); if (!o) throw notFound();
    auth.assertClientAccess(ctx, o.client_id);
    if (o.status === 'vacated') throw badRequest('This order has already been vacated');
    const { reason } = validate(ctx.body, { reason: { type: 'string', required: true, maxLen: 300 } });
    db.run(`UPDATE court_orders SET status='vacated', vacated_at=?, vacated_reason=?, updated_at=? WHERE id=?`, db.now(), reason, db.now(), o.id);
    audit.log({ user: ctx.user, action: 'court_order.vacate', entity: 'court_order', entityId: o.id, clientId: o.client_id, ip: ctx.ip });
    return { ok: true };
  });

  // ---- the programme at a glance (counts only, no client detail) ----
  r.get('/api/part2/summary', auth.requireAuth, auth.requirePerm('complaints:read', 'incidents:read', 'settings:manage'), (ctx) => {
    const n = (sql, ...p) => db.one(sql, ...p).n;
    const out = {
      part2_program: disclosure.part2Program(),
      clients_missing_notice: n(`SELECT COUNT(*) n FROM clients c WHERE ${MISSING_NOTICE}`),
      consents_legacy_active: n(`SELECT COUNT(*) n FROM consents WHERE type IN (${C.PART2_CONSENT_TYPES.map(() => '?').join(',')}) AND (rule_version IS NULL OR rule_version<>'2024') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now'))`, ...C.PART2_CONSENT_TYPES),
      court_orders_active: n(`SELECT COUNT(*) n FROM court_orders WHERE status='active' AND (expires_at IS NULL OR expires_at >= date('now'))`),
      disclosures_90d: n(`SELECT COUNT(*) n FROM disclosures WHERE disclosed_at >= ?`, new Date(Date.now() - 90 * 86400000).toISOString()),
      complaints_open: n(`SELECT COUNT(*) n FROM complaints WHERE status IN ('open','investigating')`),
      incidents_open: n(`SELECT COUNT(*) n FROM privacy_incidents WHERE status='open'`),
      counseling_notes: n(`SELECT COUNT(*) n FROM notes WHERE counseling_note=1 AND deleted_at IS NULL`),
    };
    audit.log({ user: ctx.user, action: 'part2.summary', ip: ctx.ip });
    return out;
  });
};
module.exports.latestNotice = latestNotice;
module.exports.MISSING_NOTICE = MISSING_NOTICE;
module.exports.DEFAULT_NOTICE = DEFAULT_NOTICE;
