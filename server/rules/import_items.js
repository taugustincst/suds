'use strict';
// The rules for the pages of an import: its importer's, like the import itself (server/rules/imports.js).
const db = require('../db');
const { define } = require('./core');

const ofImport = (user, row) => { const imp = db.one(`SELECT imported_by FROM imports WHERE id=?`, row.import_id); return imp ? require('./imports').importersOnly(user, imp) : null; };

module.exports = define({
  table: 'import_items',
  fields: { title: { type: 'string', maxLen: 200 } },
  editableBy: ofImport,
  authorise(row, c) { return c.existing ? null : ofImport(c.user, row); },
});
