'use strict';
// The rules for the signed or scanned copies attached to a client's form, for /api/forms/:id/files and sync push
// (the file travels as a blob): forms:write, at most ten to a form, a file type the form library takes, and the
// form's own rules (security review of 1.16.0, M1/M2): an attachment is removed or replaced on a completed form
// only by a supervisor (forms:manage), and otherwise by the person who added it, the person who started the form,
// or records:manage-others. Adding one stays open: the signed copy of a completed form is scanned after it is
// completed and printed.
const db = require('../db');
const auth = require('../auth');
const { define, refuse, flag, notPermitted } = require('./core');

const MAX_FILES = 10;
const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
const formOf = (row) => db.one(`SELECT id, status, created_by FROM client_forms WHERE id=?`, row.client_form_id) || {};
const completed = (form, user) => (form.status === 'completed' && !auth.hasPerm(user, 'forms:manage')
  ? refuse('not permitted: the form is completed; a supervisor can reopen it', { status: 403, message: 'This form is completed. Ask a supervisor to reopen it.' }) : null);
function mayChange(user, row) {
  const form = formOf(row);
  return completed(form, user) || (row.uploaded_by === user.id || form.created_by === user.id || auth.hasPerm(user, 'records:manage-others')
    ? null : notPermitted('Only the person who added this attachment or started the form, or a supervisor, can remove it'));
}

module.exports = define({
  table: 'client_form_files',
  deviceColumns: ['content_type', 'bytes'], createdBy: ['uploaded_by'],
  fields: { filename: { type: 'string', maxLen: 200 } },
  editableBy: mayChange,
  deletableBy: mayChange,
  // The signed copy on a completed form is never replaced through the blob route, whoever asks.
  fileFrozen: (row) => formOf(row).status === 'completed',
  check(row, c) {
    if (row.content_type !== undefined && !TYPES.includes(row.content_type)) return refuse('has a value the office does not accept (an attachment must be a PDF, Word document, picture or text file)');
    if (c.existing) return null;
    const n = db.one(`SELECT COUNT(*) n FROM client_form_files WHERE client_form_id=?`, row.client_form_id).n;
    return n >= MAX_FILES ? flag(`was accepted, but its form already had ${MAX_FILES} attachments; the office will review it`, { message: `At most ${MAX_FILES} attachments per form`, code: 'too_many_files' }) : null;
  },
});
module.exports.MAX_FILES = MAX_FILES;
