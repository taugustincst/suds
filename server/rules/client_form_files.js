'use strict';
// The rules for the signed or scanned copies attached to a client's form, for /api/forms/:id/files and sync push
// (the file travels as a blob): forms:write, and at most ten to a form.
const db = require('../db');
const { define, flag } = require('./core');

const MAX_FILES = 10;
module.exports = define({
  table: 'client_form_files',
  fields: { filename: { type: 'string', maxLen: 200 } },
  check(row, c) {
    if (c.existing) return null;
    const n = db.one(`SELECT COUNT(*) n FROM client_form_files WHERE client_form_id=?`, row.client_form_id).n;
    return n >= MAX_FILES ? flag(`was accepted, but its form already had ${MAX_FILES} attachments; the office will review it`, { message: `At most ${MAX_FILES} attachments per form`, code: 'too_many_files' }) : null;
  },
});
module.exports.MAX_FILES = MAX_FILES;
