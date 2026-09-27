'use strict';
// The rules for imports (a OneNote page, a Pocket AI transcript waiting to be filed): an import is its importer's
// until it is filed against a client, as the REST routes show it to nobody else without clients:all
// (routes/imports.js), and a device's copy is the same.
const auth = require('../auth');
const { define, notPermitted } = require('./core');

const importersOnly = (user, row) => (!row.imported_by || row.imported_by === user.id || auth.hasPerm(user, 'clients:all') ? null : notPermitted('That import belongs to another worker'));

module.exports = define({
  table: 'imports',
  fields: { filename: { type: 'string', maxLen: 200 } },
  editableBy: importersOnly,
});
module.exports.importersOnly = importersOnly;
