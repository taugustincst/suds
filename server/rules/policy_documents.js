'use strict';
// The rules for policy documents (the programme's policies, procedures and contracts), for /api/documents and
// sync push: documents:write, and the document's fields (the file travels as a blob).
const C = require('../constants');
const { define } = require('./core');

module.exports = define({
  table: 'policy_documents',
  fields: { title: { type: 'string', required: true, maxLen: 200 }, category: { type: 'string', required: true, enum: C.DOCUMENT_CATEGORIES }, description: { type: 'string', maxLen: 2000 }, effective_date: { type: 'date' }, expires_at: { type: 'date' }, filename: { type: 'string', maxLen: 200 } },
});
