'use strict';
// The rules for the pages of an import: its importer's, like the import itself (server/rules/imports.js).
const db = require('../db');
const { define } = require('./core');

const ofImport = (user, row) => { const imp = db.one(`SELECT imported_by FROM imports WHERE id=?`, row.import_id); return imp ? require('./imports').importersOnly(user, imp) : null; };

module.exports = define({
  table: 'import_items',
  deviceColumns: ['external_id', 'content_enc', 'captured_at', 'metadata_enc', 'suggested_client_id', 'status', 'note_id'],
  fields: { title: { type: 'string', maxLen: 200 } },
  editableBy: ofImport,
  authorise(row, c) { return c.existing ? null : ofImport(c.user, row); },
  // A filed page's text lives in its note; the item keeps none of it, whatever a device sends (the REST commit
  // clears it the same way: routes/imports.js).
  storeRow(o, row, c) { if ((o.status ?? c.existing?.status) === 'committed') { o.content_enc = ''; o.title_enc = null; o.metadata_enc = null; } },
});
