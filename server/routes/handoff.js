'use strict';
// County EHR hand-off: the billing boundary made explicit.
//
// SUDS does not bill. It does not produce 837 transactions, Short-Doyle/Medi-Cal claims or any other claim,
// and it is not a Drug Medi-Cal billing system (docs/SCOPE.md). Where a service has to generate revenue, the
// county's EHR / billing system (SmartCare or its equivalent) is the system of record for the claim, and
// this is the hand-off to it: one row per client, per service day, per kind of service, per worker, with
// the minutes, place, modality and funding source a biller needs to key or import the encounter there.
//
// The file names clients (name, date of birth, Medi-Cal ID), so it is an identified disclosure outside the
// programme: export:identified only, a named recipient and purpose, a lawful basis — a live consent on file
// for each client (clients without one are left out and listed), or a QSOA / "other" basis for the whole
// file — and one accounting-of-disclosures row per client it contains (server/disclosure.js). It follows the
// identified-export rules (requireExportBasis): the consent must be one that can authorise a disclosure in
// this programme (a Part 2 consent, the 2024 single TPO consent included — a general release of information
// only when this is not a Part 2 programme — never one limited to counseling notes or a proceeding); it is
// never for a legal proceeding; clients with an agreed restriction need the worker's confirmation; the file
// carries the §2.32 notice; and a file naming very many clients opens a draft incident.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest } = require('../http');
const { decrypt } = require('../crypto');

const NOT_A_CLAIM = 'Encounter hand-off for entry into the county EHR / billing system. This is not a claim: SUDS does not submit Drug Medi-Cal (837 / Short-Doyle) claims. Minutes are the total of the services recorded; the county EHR decides what is billable.';
const BASES = ['consent', 'qsoa', 'other'];
const COLUMNS = [
  ['service_date', 'Service Date'], ['client_code', 'Client Code'], ['last_name', 'Last Name'], ['first_name', 'First Name'], ['dob', 'Date Of Birth'],
  ['medi_cal_id', 'Medi-Cal ID'], ['insurance', 'Insurance'], ['service_type', 'Service Type'], ['service_type_code', 'Service Type Code'], ['contacts', 'Contacts'],
  ['minutes', 'Minutes'], ['location', 'Location'], ['modality', 'Modality'], ['staff', 'Staff'], ['staff_title', 'Staff Title'], ['funding_source', 'Funding Source'],
].map(([key, label]) => ({ key, label }));

/** The services in the period, grouped per client, service day (organisation time zone), type, worker, place, modality and fund. */
function encounters(ctx, { tsP, ts }) {
  const cf = auth.caseloadFilter(ctx.user, 'c.id');
  const rows = db.all(`SELECT i.client_id, i.type, i.occurred_at, i.duration_minutes, i.location, i.modality, i.user_id, i.funding_source_id, c.client_code, c.first_name_enc, c.last_name_enc, c.dob_enc, c.medicaid_id_enc, c.insurance,
      u.display_name staff, u.title staff_title, f.name funding_source
    FROM interventions i JOIN clients c ON c.id=i.client_id JOIN users u ON u.id=i.user_id LEFT JOIN funding_sources f ON f.id=i.funding_source_id
    WHERE i.client_id IS NOT NULL AND c.deleted_at IS NULL AND ${ts('i.occurred_at')} AND ${cf.sql} ORDER BY i.occurred_at LIMIT 50000`, ...tsP, ...cf.params);
  const { localDate } = require('./budget');
  const O = require('../options');
  const types = O.labelMap('INTERVENTION_TYPES'), locs = O.labelMap('LOCATIONS'), mods = O.labelMap('MODALITIES');
  const d = (v) => { try { return v ? decrypt(v) : ''; } catch { return ''; } };
  const groups = new Map();
  for (const r of rows) {
    const day = String(r.occurred_at).length === 10 ? r.occurred_at : localDate(r.occurred_at);
    const key = [r.client_id, day, r.type, r.user_id, r.location || '', r.modality || '', r.funding_source_id || ''].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { _client_id: r.client_id, service_date: day, client_code: r.client_code, _enc: r, insurance: r.insurance || '', service_type: types[r.type] || O.humanize(r.type), service_type_code: r.type,
        contacts: 0, minutes: 0, location: locs[r.location] || (r.location ? O.humanize(r.location) : ''), modality: mods[r.modality] || (r.modality ? O.humanize(r.modality) : ''), staff: r.staff, staff_title: r.staff_title || '', funding_source: r.funding_source || '' };
      groups.set(key, g);
    }
    g.contacts++; g.minutes += Number(r.duration_minutes) || 0;
  }
  const names = new Map();
  return [...groups.values()].map(g => {
    if (!names.has(g._client_id)) names.set(g._client_id, { last_name: d(g._enc.last_name_enc), first_name: d(g._enc.first_name_enc), dob: d(g._enc.dob_enc), medi_cal_id: d(g._enc.medicaid_id_enc) });
    const o = { ...g, ...names.get(g._client_id) }; delete o._enc; return o;
  }).sort((a, b) => a.service_date.localeCompare(b.service_date) || a.client_code.localeCompare(b.client_code));
}

/** The newest live consent that can put a client in the file (disclosure.fileConsentTypes), if any. */
function consentFor(clientId) {
  const types = require('../disclosure').fileConsentTypes();
  return db.one(`SELECT id FROM consents WHERE client_id=? AND type IN (${types.map(() => '?').join(',')}) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now')) ORDER BY signed_at DESC LIMIT 1`, clientId, ...types) || null;
}

module.exports = (r) => {
  // What an export for the period would hold, without a name in it: how many rows and clients, and which
  // client codes have no consent on file (they would be left out of a consent-based hand-off).
  r.get('/api/handoff/summary', auth.requireAuth, auth.requirePerm('export:identified'), (ctx) => {
    const p = require('./reports').range(ctx);
    const rows = encounters(ctx, p);
    const clients = [...new Map(rows.map(x => [x._client_id, x.client_code])).entries()];
    const without = clients.filter(([id]) => !consentFor(id)).map(([, code]) => code).sort();
    const restricted = new Set(db.all(`SELECT DISTINCT client_id FROM patient_requests WHERE kind='restriction' AND status='fulfilled'`).map(x => x.client_id));
    audit.log({ user: ctx.user, action: 'handoff.preview', ip: ctx.ip, details: { from: p.from, to: p.to, rows: rows.length, clients: clients.length } });
    return { from: p.from, to: p.to, rows: rows.length, clients: clients.length, minutes: rows.reduce((s, x) => s + x.minutes, 0), without_consent: without,
      restricted: clients.filter(([id]) => restricted.has(id)).length, not_a_claim: NOT_A_CLAIM, consent_types: require('../disclosure').fileConsentTypes() };
  });

  r.get('/api/handoff/export', auth.requireAuth, auth.requirePerm('export:identified'), async (ctx) => {
    const p = require('./reports').range(ctx);
    const recipient = (ctx.query.get('recipient') || '').trim().slice(0, 200); const purpose = (ctx.query.get('purpose') || '').trim().slice(0, 500);
    if (!recipient || !purpose) throw badRequest('The hand-off names clients: say who receives it and why (recipient= and purpose=); both go into each client\'s accounting of disclosures');
    const basis = ctx.query.get('basis') || 'consent';
    if (!BASES.includes(basis)) throw badRequest(`basis must be one of ${BASES.join(', ')}`);
    const disclosure = require('../disclosure');
    if (ctx.query.get('legal_proceeding') === '1') disclosure.requireExportBasis([], { basis: 'internal', legal_proceeding: true }); // always refuses: never a bulk file
    // A QSOA or "other" basis covers the whole file; checked once, before anything is read. "Other" is the
    // supervisor/administrator override and needs its written justification (disclosure.requireBasis). Agreed
    // restrictions are checked below, against the clients actually in the file.
    const fileBasis = basis === 'consent' ? null : disclosure.requireBasis(null, { basis, justification: ctx.query.get('justification'), user: ctx.user, restriction_reviewed: true });
    const all = encounters(ctx, p);
    const consentOf = new Map(); const excluded = new Set();
    if (basis === 'consent') for (const id of new Set(all.map(x => x._client_id))) { const c = consentFor(id); if (c) consentOf.set(id, c.id); else excluded.add(id); }
    const rows = all.filter(x => !excluded.has(x._client_id));
    const excludedCodes = [...new Set(all.filter(x => excluded.has(x._client_id)).map(x => x.client_code))].sort();
    const clientIds = [...new Set(rows.map(x => x._client_id))];
    try { disclosure.requireRestrictionReview(clientIds, ctx.query.get('restriction_reviewed') === '1'); }
    catch (e) { audit.log({ user: ctx.user, action: 'handoff.export.refused', ip: ctx.ip, success: false, details: { basis, clients: clientIds.length, reason: 'restriction_review' } }); throw e; }
    db.transaction(() => {
      for (const clientId of clientIds) disclosure.record({ clientId, consentId: consentOf.get(clientId) || null, recipient, purpose, what: `County EHR encounter hand-off (${p.from} to ${p.to}): service dates, types, minutes, staff and funding; name, date of birth, Medi-Cal ID`, method: 'export', basis, justification: fileBasis ? fileBasis.justification : null, source: 'ehr_handoff', sourceRef: `handoff:${p.from}_${p.to}`, user: ctx.user, ip: ctx.ip });
    });
    require('../incidents').maybeMassExport({ clients: clientIds.length, kind: 'ehr-handoff', user: ctx.user });
    audit.log({ user: ctx.user, action: 'handoff.export', ip: ctx.ip, details: { from: p.from, to: p.to, rows: rows.length, basis, clients_disclosed: clientIds.length, excluded_no_consent: excludedCodes.length || undefined } });
    const notice = disclosure.notice(); const part2 = disclosure.part2Program();
    const out = rows.map(x => { const o = { ...x }; delete o._client_id; return o; });
    const S = require('../spreadsheet');
    const xlsx = ctx.query.get('format') === 'xlsx';
    const name = `suds-ehr-handoff-${p.from}_${p.to}-identified.${xlsx ? 'xlsx' : 'csv'}`;
    const body = xlsx
      ? await S.writeWorkbookAsync([{ name: 'Encounters', columns: COLUMNS, rows: out }, { name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: [
        { k: 'Not a claim', v: NOT_A_CLAIM }, { k: 'Classification', v: `Identified — PHI. Disclosed to: ${recipient}. Purpose: ${purpose}. Basis: ${basis}.` },
        { k: 'Period', v: `${p.from} to ${p.to}` }, { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
        { k: 'Left out (no consent on file)', v: excludedCodes.join(', ') || 'none' },
        ...(part2 ? [{ k: 'Protected by 42 CFR Part 2', v: notice.short }, { k: 'Notice to recipient (42 CFR §2.32)', v: notice.text }] : [])] }])
      // CSV: the §2.32 notice as the last row, after a blank one, as the identified exports do (reports.js).
      : S.toCsv(out, COLUMNS) + (part2 ? '\r\n\r\n' + S.toCsv([{ n: disclosure.fileNotice() }], [{ key: 'n', label: '' }]).split('\r\n')[1] : '');
    ctx.res.writeHead(200, { 'Content-Type': xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`,
      'X-SUDS-Export': `Identified export - PHI. Disclosed to: ${recipient}. Purpose: ${purpose}. Basis: ${basis}.${part2 ? ` ${notice.short}` : ''} Not a claim.`.replace(/[^\x20-\x7e]/g, '?').slice(0, 900),
      'X-SUDS-Handoff-Excluded': excludedCodes.join(',').slice(0, 900) });
    ctx.res.end(body);
  });
};
module.exports.NOT_A_CLAIM = NOT_A_CLAIM;
