'use strict';
// PowerDMS (docs/integration/POWERDMS.md): a county keeps its policies in PowerDMS, where staff read and sign them. SUDS
// links each policy in its library to the PowerDMS document, says which roles must sign which revision, and reads the
// signature or training report a PowerDMS administrator exports, so a supervisor sees in SUDS who has signed the
// current revision. SUDS never connects to PowerDMS: PowerDMS publishes no API documentation (its open API is a beta
// sold per use), so the report file is the integration, and a connector waits for the county's API access.
//
// Pure functions with no file or network access: the rules (server/rules/policy_documents.js) call the link and role
// checks on a device too. No client data is involved anywhere here: the report names staff and policies.
const C = require('./constants');

const ROLES = C.STAFF_ROLES;

/** Why `v` is not a PowerDMS document address, or null. https on powerdms.com or one of its subdomains, no credentials. */
function urlProblem(v) {
  if (v == null || v === '') return null;
  let u; try { u = new URL(String(v)); } catch { return 'must be a web address starting with https://'; }
  if (u.protocol !== 'https:') return 'must be a web address starting with https://';
  if (u.username || u.password) return 'must not contain a user name or password';
  const host = u.hostname.toLowerCase();
  if (host !== 'powerdms.com' && !host.endsWith('.powerdms.com')) return 'must be an address on powerdms.com (the PowerDMS document\'s own link)';
  return null;
}

/** The roles asked to sign, as stored ('clinician,navigator'), from a list or a comma-separated string; throws a message. */
function normaliseRoles(v) {
  if (v == null || v === '') return null;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean);
  const bad = list.filter(r => !ROLES.includes(r));
  if (bad.length) throw new Error(`unknown role${bad.length > 1 ? 's' : ''}: ${bad.join(', ')} (one of ${ROLES.join(', ')})`);
  const out = [...new Set(list)].sort();
  return out.length ? out.join(',') : null;
}
const rolesOf = (stored) => (stored ? String(stored).split(',').filter(Boolean) : []);

/** The PowerDMS document number in a document's address (…/documents/12345, …/document/12345, ?documentId=12345), or null. */
function documentNumber(url) {
  if (!url) return null;
  const s = String(url);
  const m = /\/documents?\/(\d{2,})(?:[/?#]|$)/i.exec(s) || /[?&](?:document_?id|docid|id)=(\d{2,})/i.exec(s);
  return m ? m[1] : null;
}

// ---- Reading a PowerDMS report ----
// PowerDMS's reports (signature status, document status, training completion) export to Excel or CSV, with headings
// that differ by report and by version. Each column SUDS needs is found by its heading, lower-cased with everything
// but letters and digits taken out; the first match wins. A file without a staff column, a document column and a
// date column is refused, with what was found.
const COLUMNS = {
  email: ['email', 'emailaddress', 'useremail', 'workemail'],
  username: ['username', 'login', 'loginname', 'userid', 'employeeid', 'employeenumber', 'badgenumber'],
  name: ['name', 'user', 'fullname', 'employee', 'employeename', 'member', 'person', 'signer', 'assignee'],
  first: ['firstname', 'first', 'givenname'],
  last: ['lastname', 'last', 'surname', 'familyname'],
  docnum: ['documentid', 'docid', 'documentnumber', 'docnumber', 'courseid'],
  title: ['document', 'documentname', 'documenttitle', 'title', 'policy', 'policyname', 'course', 'coursename', 'training', 'trainingname'],
  revision: ['revision', 'revisionnumber', 'rev', 'version', 'documentrevision', 'revisionname'],
  date: ['signeddate', 'datesigned', 'signaturedate', 'signedon', 'signed', 'completed', 'completiondate', 'datecompleted', 'completedon', 'completeddate', 'acknowledgeddate', 'dateacknowledged', 'date'],
  status: ['status', 'signaturestatus', 'signedstatus', 'completionstatus', 'state'],
};
const key = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function findColumns(headers) {
  const keys = headers.map(key); const out = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    for (const n of names) { const i = keys.indexOf(n); if (i >= 0 && !Object.values(out).includes(headers[i])) { out[field] = headers[i]; break; } }
  }
  return out;
}
const SIGNED = /\b(signed|complete|completed|acknowledged|passed|done|yes)\b/i;
const NOT_SIGNED = /\b(unsigned|not signed|pending|incomplete|not complete|assigned|overdue|expired|failed|no)\b/i;

/** A report cell as a calendar day or a time (ISO), or null: an Excel serial day, YYYY-MM-DD[...], or M/D/YYYY[ h:mm[ AM]]. */
function readDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return real(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(s);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return real(y, +m[1], +m[2]); }
  return null;
}
function real(y, mo, d) {
  if (y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

/** "Rivera, Maria" and "Maria Rivera" read the same; case, accents and punctuation are ignored. */
function nameKey(s) {
  if (!s) return '';
  let t = String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (t.includes(',')) { const [a, b] = t.split(',', 2); t = `${b} ${a}`; }
  return t.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Match a report's rows to SUDS staff and documents. `sheet` is { headers, rows } (server/spreadsheet.js parseFile);
 * `users` [{ id, username, email, display_name }]; `documents` [{ id, title, powerdms_url, revision }];
 * `have` a Set of `${document_id}|${user_id}|${revision}` already recorded. Returns { columns, rows, counts } where
 * each row is { line, outcome, user_id?, document_id?, revision, acknowledged_at, staff, document } and outcome is
 * 'record' | 'already' | 'not_signed' | 'unknown_staff' | 'ambiguous_staff' | 'unknown_document' | 'no_date'.
 * Throws a message when the file lacks a column SUDS needs.
 */
function matchReport(sheet, { users, documents, have = new Set() }) {
  const col = findColumns(sheet.headers || []);
  const missing = [];
  if (!col.email && !col.username && !col.name && !(col.first && col.last)) missing.push('who (an email, user name or name column)');
  if (!col.docnum && !col.title) missing.push('which document (a document ID or document name column)');
  if (!col.date) missing.push('when (a signed or completed date column)');
  if (missing.length) {
    const e = new Error(`This report has no column for ${missing.join('; ')}. Its columns are: ${(sheet.headers || []).filter(Boolean).join(', ') || 'none'}.`);
    e.columns = col; throw e;
  }
  const byEmail = new Map(); const byUser = new Map(); const byName = new Map();
  for (const u of users) {
    if (u.email) byEmail.set(String(u.email).toLowerCase().trim(), u);
    byUser.set(String(u.username).toLowerCase(), u);
    const k = nameKey(u.display_name); if (k) byName.set(k, [...(byName.get(k) || []), u]);
  }
  const byNumber = new Map(); const byTitle = new Map();
  for (const d of documents) {
    const n = documentNumber(d.powerdms_url); if (n) byNumber.set(n, d);
    const t = nameKey(d.title); if (t) byTitle.set(t, [...(byTitle.get(t) || []), d]);
  }
  const rows = []; const seen = new Set();
  (sheet.rows || []).forEach((r, i) => {
    const cell = (c) => (c && r[c] != null ? String(r[c]).trim() : '');
    const staff = cell(col.name) || [cell(col.first), cell(col.last)].filter(Boolean).join(' ') || cell(col.email) || cell(col.username);
    const docLabel = cell(col.title) || cell(col.docnum);
    const out = { line: i + 2, staff, document: docLabel, revision: cell(col.revision), acknowledged_at: col.date ? readDate(r[col.date]) : null };
    if (!staff && !docLabel) return; // a blank or total line
    const status = cell(col.status);
    if (status && (NOT_SIGNED.test(status) || !SIGNED.test(status))) { rows.push({ ...out, outcome: 'not_signed' }); return; }
    let user = null; let ambiguous = false;
    const email = cell(col.email).toLowerCase(); const uname = cell(col.username).toLowerCase();
    if (email && byEmail.has(email)) user = byEmail.get(email);
    else if (uname && byUser.has(uname)) user = byUser.get(uname);
    else if (email && byUser.has(email)) user = byUser.get(email); // an account whose user name is its email address
    else {
      const k = nameKey(cell(col.name) || [cell(col.first), cell(col.last)].filter(Boolean).join(' '));
      const hits = k ? byName.get(k) || [] : [];
      if (hits.length === 1) user = hits[0]; else if (hits.length > 1) ambiguous = true;
    }
    if (!user) { rows.push({ ...out, outcome: ambiguous ? 'ambiguous_staff' : 'unknown_staff' }); return; }
    let doc = null;
    const num = cell(col.docnum).replace(/\D/g, '');
    if (num && byNumber.has(num)) doc = byNumber.get(num);
    else { const hits = byTitle.get(nameKey(cell(col.title))) || []; if (hits.length === 1) doc = hits[0]; }
    if (!doc) { rows.push({ ...out, user_id: user.id, outcome: 'unknown_document' }); return; }
    if (!out.acknowledged_at) { rows.push({ ...out, user_id: user.id, document_id: doc.id, outcome: 'no_date' }); return; }
    const k = `${doc.id}|${user.id}|${out.revision}`;
    const outcome = have.has(k) || seen.has(k) ? 'already' : 'record';
    seen.add(k);
    rows.push({ ...out, user_id: user.id, document_id: doc.id, outcome });
  });
  const counts = {};
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  return { columns: col, rows, counts };
}

/**
 * Who must sign what, and who has: for each active document with ack_roles, every active staff account in one of those
 * roles, with their newest acknowledgement of it. Current = an acknowledgement of the document's revision (any, when
 * the document names no revision). `acks` [{ document_id, user_id, revision, acknowledged_at, source, id }].
 */
function compliance(documents, users, acks) {
  const docs = documents.filter(d => d.is_active && rolesOf(d.ack_roles).length);
  const byPair = new Map();
  for (const a of acks) { const k = `${a.document_id}|${a.user_id}`; byPair.set(k, [...(byPair.get(k) || []), a]); }
  const status = (d, u) => {
    const list = (byPair.get(`${d.id}|${u.id}`) || []).slice().sort((a, b) => String(b.acknowledged_at).localeCompare(String(a.acknowledged_at)));
    const current = list.find(a => !d.revision || a.revision === d.revision) || null;
    const latest = list[0] || null;
    return { required: rolesOf(d.ack_roles).includes(u.role), current: !!current, acknowledgement: current || latest };
  };
  const staff = users.map(u => {
    const items = docs.map(d => ({ document_id: d.id, ...status(d, u) })).filter(x => x.required);
    return { id: u.id, display_name: u.display_name, role: u.role, required: items.length, signed: items.filter(x => x.current).length, items };
  });
  const perDocument = docs.map(d => {
    const owed = staff.filter(s => s.items.some(x => x.document_id === d.id));
    const signed = owed.filter(s => s.items.find(x => x.document_id === d.id).current).length;
    return { id: d.id, title: d.title, revision: d.revision || null, powerdms_url: d.powerdms_url || null, roles: rolesOf(d.ack_roles), owed: owed.length, signed };
  });
  return { documents: perDocument, staff };
}

module.exports = { ROLES, urlProblem, normaliseRoles, rolesOf, documentNumber, findColumns, readDate, nameKey, matchReport, compliance };
