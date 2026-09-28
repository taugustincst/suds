'use strict';
// The rules for notes, for /api/notes and sync push. A clinical note is written only by a role holding
// notes:clinical:write, and only a clinical note can be a SUD counseling note (42 CFR §2.11). A draft is its
// author's (or a manager's) to change. A signed note is the legal record: nothing about it changes except the
// request for a review, and an addendum is how it grows (server/rules/note_addenda.js). Only the author signs;
// a countersignature is the supervisor's act on the office server and is never taken from a device.
const db = require('../db');
const auth = require('../auth');
const { define, refuse, notPermitted } = require('./core');

const parseList = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
// Everything about a signed note stays as signed, except asking a supervisor to look at it (request-cosign).
const SIGNED_KEEPS = ['kind', 'format', 'title_enc', 'content_enc', 'structured_enc', 'occurred_at', 'intervention_id', 'call_id', 'part2_protected', 'counseling_note', 'problem_ids',
  'status', 'signed_by', 'signed_at', 'signature_hash', 'source', 'source_ref', 'import_item_id', 'deleted_at'];

/**
 * A supervisor's "Finish and sign your note" reminder (public/views/supervision.js puts a reference line naming
 * the note in the to-do's details) has done its job once the note is signed: it is closed rather than left open
 * for the author to tick off (1.16.0). Only the author's own open to-dos for this client are read. Returns the ids.
 */
function closeSignReminders(authorId, noteId, clientId) {
  const { decrypt } = require('../crypto');
  const ref = `Reference: supervision reminder for note ${noteId}`;
  const done = db.all(`SELECT id, description_enc FROM tasks WHERE assigned_to=? AND status IN ('open','in_progress') AND client_id IS ? AND description_enc IS NOT NULL`, authorId, clientId)
    .filter(t => { try { return decrypt(t.description_enc).includes(ref); } catch { return false; } });
  const now = db.now();
  for (const t of done) db.run(`UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?`, now, now, t.id);
  return done.map(t => t.id);
}

module.exports = define({
  table: 'notes',
  fields: {
    client_id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['clinical', 'admin'] }, format: { type: 'string', list: 'NOTE_FORMATS' },
    title: { type: 'string', maxLen: 200 }, content: { type: 'string', required: true, maxLen: 50000 }, structured: { type: 'object', fromColumn: JSON.parse }, occurred_at: { type: 'datetime', required: true },
    intervention_id: { type: 'string' }, call_id: { type: 'string' }, part2_protected: { type: 'boolean' }, counseling_note: { type: 'boolean' }, cosign_requested: { type: 'boolean' },
    source: { type: 'string', enum: ['manual', 'pocket_ai', 'onenote', 'import', 'api'] }, source_ref: { type: 'string', maxLen: 300 },
    // The problem-list entries this note addresses (CalAIM: a progress note ties the service to the problem list).
    problem_ids: { type: 'array', maxLen: 30, of: 'string', fromColumn: JSON.parse },
  },
  tombstone: 'never',
  owner: { col: 'author_id', all: 'clients:all' },
  editableBy: (user, row) => (row.status === 'draft' && row.author_id !== user.id && !auth.hasPerm(user, 'clients:all') ? notPermitted('Only the author can edit a draft') : null),
  authorise(row, c) {
    const kind = c.existing ? c.existing.kind : row.kind;
    if (kind === 'clinical' && !auth.hasPerm(c.user, 'notes:clinical:write')) return refuse('clinical notes not permitted for this role', { status: 403, message: 'You cannot author clinical notes' });
    return null;
  },
  check(row, c) {
    const e = c.existing || {};
    const kind = c.existing ? e.kind : row.kind;
    const out = [];
    if (row.counseling_note && Number(row.counseling_note) && kind !== 'clinical') out.push(refuse('has a value the office does not accept (only a clinical note can be a SUD counseling note)', { message: 'Only a clinical note can be a SUD counseling note' }));
    // Problem ids must be on this client's problem list.
    if (row.problem_ids !== undefined && row.problem_ids !== null && (!c.existing || String(row.problem_ids) !== String(e.problem_ids))) {
      let ids = []; try { ids = parseList(row.problem_ids) || []; } catch { ids = [null]; }
      const clientId = c.existing ? e.client_id : row.client_id;
      for (const id of Array.isArray(ids) ? ids : [null]) {
        const p = id ? db.one(`SELECT client_id FROM problems WHERE id=?`, id) : null;
        if (!p || p.client_id !== clientId) { out.push(refuse('has a value the office does not accept (it is linked to a problem that is not on this client\'s problem list)', { message: 'Validation failed', fields: { problem_ids: 'names a problem that is not on this client\'s problem list' } })); break; }
      }
    }
    // Only the person who wrote a note signs it; a supervisor countersigns instead (POST /api/notes/:id/sign).
    if (c.via === 'sync' && row.status && row.status !== 'draft' && (!c.existing || e.status === 'draft') && row.signed_by && row.signed_by !== (row.author_id || e.author_id)) {
      out.push(refuse('not permitted: only the author can sign a note', { status: 403, message: 'Only the author can sign a note. Supervisors countersign instead.' }));
    }
    return out;
  },
  normalise(row, c) {
    const e = c.existing;
    if (e) {
      row.kind = e.kind; // a note's kind is decided when it is written (no route changes it)
      if (e.status !== 'draft') for (const col of SIGNED_KEEPS) row[col] = col.endsWith('_enc') ? undefined : e[col];
      // A countersignature is the supervisor's act on the office server; a device can never assert one.
      row.cosigned_by = e.cosigned_by; row.cosigned_at = e.cosigned_at; row.cosignature_hash = e.cosignature_hash; row.cosign_note_enc = undefined;
    } else { row.cosigned_by = null; row.cosigned_at = null; row.cosignature_hash = null; }
    return null;
  },
  // A note signed on a device closes its reminder at the office too, as signing here does (routes/notes.js).
  afterApply(row, o, c) {
    if (c.existing && c.existing.status !== 'draft') return;
    const n = db.one(`SELECT id, author_id, client_id, status FROM notes WHERE id=?`, row.id);
    if (n && n.status !== 'draft') closeSignReminders(n.author_id, n.id, n.client_id);
  },
});
module.exports.closeSignReminders = closeSignReminders;
