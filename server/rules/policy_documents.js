'use strict';
// The rules for policy documents (the programme's policies, procedures and contracts), for /api/documents and
// sync push: documents:write, and the document's fields (the file travels as a blob). From migration 72 a document may
// be the county's PowerDMS document instead of a file here (powerdms_url, docs/integration/POWERDMS.md), name the
// revision staff must sign, and the roles asked to sign it (ack_roles, comma-separated).
const C = require('../constants');
const { define, refuse } = require('./core');
const P = require('../powerdms');

module.exports = define({
  table: 'policy_documents',
  deviceColumns: ['content_type', 'bytes', 'search_text', 'is_active'], createdBy: ['uploaded_by'],
  fields: {
    title: { type: 'string', required: true, maxLen: 200 }, category: { type: 'string', required: true, enum: C.DOCUMENT_CATEGORIES }, description: { type: 'string', maxLen: 2000 },
    effective_date: { type: 'date' }, expires_at: { type: 'date' }, filename: { type: 'string', maxLen: 200 },
    powerdms_url: { type: 'string', maxLen: 500 }, revision: { type: 'string', maxLen: 60 }, ack_roles: { type: 'string', maxLen: 120 },
  },
  check(row, c) {
    const out = [];
    const url = c.plain('powerdms_url');
    const problem = P.urlProblem(url);
    if (problem) out.push(refuse(`powerdms_url ${problem}`, { fields: { powerdms_url: problem }, permanent: true }));
    const roles = c.plain('ack_roles');
    if (roles) { try { P.normaliseRoles(roles); } catch (e) { out.push(refuse(`ack_roles: ${e.message}`, { fields: { ack_roles: e.message }, permanent: true })); } }
    return out;
  },
});
