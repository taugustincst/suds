'use strict';
// The rules for note addenda: what is added to a note after it is signed. Part of the legal record, so a device
// may add one and never change or delete it; and only to a note its user may write (the note's client on the
// caseload, and a clinical note only with notes:clinical:write), as POST /api/notes/:id/addenda requires.
const db = require('../db');
const auth = require('../auth');
const { define, refuse } = require('./core');

module.exports = define({
  table: 'note_addenda',
  fields: { content: { type: 'string', required: true, maxLen: 20000 }, reason: { type: 'string', maxLen: 300 } },
  immutable: true, tombstone: 'never',
  // An addendum to a signed note makes it "amended", as POST /api/notes/:id/addenda does (the note's own row
  // cannot carry that change: a signed note's status is the office's, server/rules/notes.js).
  afterApply(row) { db.run(`UPDATE notes SET status='amended', updated_at=? WHERE id=? AND status='signed'`, db.now(), row.note_id); },
  authorise(row, c) {
    const note = db.one(`SELECT client_id, kind FROM notes WHERE id=?`, row.note_id);
    if (!note || !auth.canAccessClient(c.user, note.client_id) || (note.kind === 'clinical' && !auth.hasPerm(c.user, 'notes:clinical:write'))) return refuse('not permitted');
    return null;
  },
});
