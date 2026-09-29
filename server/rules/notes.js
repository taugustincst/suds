'use strict';
// The rules for notes, for /api/notes and sync push. A clinical note is written only by a role holding
// notes:clinical:write, and only a clinical note can be a SUD counseling note (42 CFR §2.11). A draft is its
// author's (or a manager's) to change. A signed note is the legal record: nothing about it changes except the
// request for a review, and an addendum is how it grows (server/rules/note_addenda.js). Only the author signs;
// a countersignature is the supervisor's act on the office server and is never taken from a device. Who wrote a note
// is the account that synced it (createdBy), as over REST, and a signature a device brings is its author's own:
// the syncing user signing their own draft. The office works the signature's hash out itself and audits it as
// note.sign (security review of 1.16.1, H1: a manage-others push signed a clinician's draft in their name).
const db = require('../db');
const auth = require('../auth');
const { define, refuse, flag, notPermitted } = require('./core');

const parseList = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
// Everything about a signed note stays as signed, except asking a supervisor to look at it (request-cosign).
const SIGNED_KEEPS = ['kind', 'format', 'title_enc', 'content_enc', 'structured_enc', 'occurred_at', 'intervention_id', 'call_id', 'part2_protected', 'counseling_note', 'problem_ids',
  'status', 'signed_by', 'signed_at', 'signature_hash', 'source', 'source_ref', 'import_item_id', 'deleted_at', 'ai_assisted'];

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

/**
 * A note no longer a SUD counseling note is sent again to the devices that dropped it (routes/sync.js exportInto,
 * dropHidden); its addenda, unchanged themselves, are stamped so they follow it. Called by PUT /api/notes/:id and push.
 */
function reissueAddenda(noteId, was, now) {
  if (Number(was) && !Number(now)) db.run(`UPDATE note_addenda SET updated_at=? WHERE note_id=?`, db.now(), noteId);
}

/** Does this push sign the note: a new note that is not a draft, or a draft that stops being one? */
const signs = (row, c) => !!row.status && row.status !== 'draft' && (!c.existing || c.existing.status === 'draft');

module.exports = define({
  table: 'notes',
  deviceColumns: ['status', 'signed_at', 'signed_by', 'signature_hash', 'cosign_required', 'cosigned_by', 'cosigned_at', 'cosignature_hash', 'cosign_note_enc', 'import_item_id', 'deleted_at'],
  fields: {
    client_id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['clinical', 'admin'] }, format: { type: 'string', list: 'NOTE_FORMATS' },
    title: { type: 'string', maxLen: 200 }, content: { type: 'string', required: true, maxLen: 50000 }, structured: { type: 'object', fromColumn: JSON.parse }, occurred_at: { type: 'datetime', required: true },
    intervention_id: { type: 'string' }, call_id: { type: 'string' }, part2_protected: { type: 'boolean' }, counseling_note: { type: 'boolean' }, cosign_requested: { type: 'boolean' },
    source: { type: 'string', enum: ['manual', 'pocket_ai', 'onenote', 'import', 'api'] }, source_ref: { type: 'string', maxLen: 300 },
    // The problem-list entries this note addresses (CalAIM: a progress note ties the service to the problem list).
    problem_ids: { type: 'array', maxLen: 30, of: 'string', fromColumn: JSON.parse },
    // Some of the text was drafted by the AI documentation copilot (docs/AI-COPILOT.md). Set by the author's
    // editor when a draft is used; never cleared once set (normalise), and kept as signed.
    ai_assisted: { type: 'boolean' },
  },
  tombstone: 'never',
  createdBy: ['author_id'],
  editableBy: (user, row) => (row.status === 'draft' && row.author_id !== user.id && !auth.hasPerm(user, 'records:manage-others') ? notPermitted('Only the author can edit a draft') : null),
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
    // Only the person who wrote a note signs it, and only they (POST /api/notes/:id/sign): on push, the syncing user
    // signing their own note. A supervisor countersigns instead.
    if (c.via === 'sync' && signs(row, c) && (c.user.id !== (c.existing ? e.author_id : row.author_id) || (row.signed_by && row.signed_by !== c.user.id))) {
      out.push(refuse('not permitted: only the author can sign a note', { status: 403, message: 'Only the author can sign a note. Supervisors countersign instead.' }));
    }
    return out;
  },
  normalise(row, c) {
    const e = c.existing;
    // When a new note was written is the device's to say (offline work), but never after now: it bounds the signature's
    // time below, and a future one hid the note from a later flag's drop (security review of 1.16.3, N7).
    if (!e) { const ms = Date.parse(row.created_at); const now = db.now(); row.created_at = Number.isFinite(ms) && new Date(ms).toISOString() < now ? new Date(ms).toISOString() : now; }
    // A countersignature is the supervisor's act on the office server (POST /api/notes/:id/cosign); a device can
    // never assert one, and one it asks for is flagged rather than dropped unseen (security review of 1.15.3, H1).
    const COSIGN = ['cosigned_by', 'cosigned_at', 'cosignature_hash'];
    const has = (v) => v !== undefined && v !== null && v !== '';
    const asserted = COSIGN.some(k => has(row[k]) && String(row[k]) !== String((e && e[k]) ?? '')) || (has(row.cosign_note_enc) && String(row.cosign_note_enc) !== String((e && c.was('cosign_note_enc')) ?? ''));
    if (e) {
      row.kind = e.kind; // a note's kind is decided when it is written (no route changes it)
      if (Number(e.ai_assisted)) row.ai_assisted = 1; // AI-assisted stays AI-assisted
      if (e.status !== 'draft') for (const col of SIGNED_KEEPS) row[col] = col.endsWith('_enc') ? undefined : e[col];
      // Asking for a review is the author's (POST /api/notes/:id/request-cosign), or records:manage-others'
      // (security review of 1.16.0, L2); nor is it asked again of a note already countersigned.
      if ((e.author_id !== c.user.id && !auth.hasPerm(c.user, 'records:manage-others')) || e.cosigned_at) row.cosign_requested = e.cosign_requested;
      for (const k of COSIGN) row[k] = e[k];
      row.cosign_note_enc = undefined;
      // Whether it needs a countersignature comes from its author's account when it was written, as over REST.
      row.cosign_required = e.cosign_required;
    }
    // A signature arriving now (checked above to be the syncing author's own): theirs, a signed note, with the hash
    // the office works out in afterApply over what it stores, whatever the device sent.
    // When it was signed is the device's to say (a legal fact, never shifted by its clock offset), but never before
    // the note was written nor after now (security review of 1.16.2, L1). A draft carries no signature columns at
    // all, whatever a device sent (L2).
    if (signs(row, c)) {
      const now = db.now(); const ms = row.signed_at ? Date.parse(row.signed_at) : NaN;
      const at = Number.isFinite(ms) ? new Date(ms).toISOString() : now;
      const from = (e ? e.created_at : row.created_at) || now;
      row.status = 'signed'; row.signed_by = c.user.id; row.signature_hash = null;
      const notBefore = at < from ? from : at;
      row.signed_at = notBefore > now ? now : notBefore;
    } else if ((row.status ?? (e ? e.status : 'draft')) === 'draft') { row.signed_by = null; row.signed_at = null; row.signature_hash = null; }
    if (!e) {
      for (const k of COSIGN) row[k] = null;
      row.cosign_note_enc = undefined;
      const author = db.one(`SELECT requires_cosign FROM users WHERE id=?`, row.author_id || c.user.id);
      row.cosign_required = author && author.requires_cosign ? 1 : 0;
    }
    return asserted ? flag('was accepted, but not the countersignature on it: a supervisor countersigns at the office, never by sync', { code: 'ruling' }) : null;
  },
  // A note signed on a device closes its reminder at the office too, as signing here does (routes/notes.js).
  // The signature is recomputed as POST /api/notes/:id/sign computes it, and audited as that route audits it.
  afterApply(row, o, c) {
    if (c.existing) reissueAddenda(row.id, c.existing.counseling_note, o.counseling_note ?? c.existing.counseling_note);
    if (c.existing && c.existing.status !== 'draft') return;
    const n = db.one(`SELECT id, author_id, client_id, status, signed_by, content_enc, structured_enc, cosign_required FROM notes WHERE id=?`, row.id);
    if (!n || n.status === 'draft') return;
    const hash = require('../crypto').sha256(`${n.id}|${n.signed_by}|${n.content_enc}|${n.structured_enc || ''}`);
    db.run(`UPDATE notes SET signature_hash=? WHERE id=?`, hash, n.id);
    const reminders = closeSignReminders(n.author_id, n.id, n.client_id);
    require('../audit').log({ user: c.user, action: 'note.sign', entity: 'note', entityId: n.id, clientId: n.client_id, ip: 'device', details: { hash, via: 'sync', cosign_required: !!n.cosign_required, reminders_closed: reminders.length ? reminders : undefined } });
  },
});
module.exports.closeSignReminders = closeSignReminders;
module.exports.reissueAddenda = reissueAddenda;

/**
 * Who may read a SUD counseling note (42 CFR §2.11), restricted by design from 1.16.1 (the owner's decision): its
 * author, its co-signer, and staff who write clinical notes (notes:clinical:write: clinicians and supervisors).
 * notes:clinical:read alone (a navigator, from 1.16.0) reads every other clinical note, never a counseling note,
 * and break-glass does not open one. As §2.31(b) keeps a counseling note out of any consent but one given for it
 * alone, and 45 CFR 164.508(a)(2) treats psychotherapy notes apart: an analogy, not a certification. Every door
 * that reads notes asks this (routes/notes.js, the client timeline, sync pull and its scope key).
 */
const readsCounseling = (user) => auth.hasPerm(user, 'notes:clinical:write');
const mayReadCounseling = (user, n) => !Number(n.counseling_note) || readsCounseling(user) || n.author_id === user.id || (!!n.cosigned_by && n.cosigned_by === user.id);
/** The same rule as SQL on a notes alias. */
function counselingFilter(user, alias = 'n') {
  return readsCounseling(user) ? { sql: '1=1', params: [] } : { sql: `(${alias}.counseling_note=0 OR ${alias}.author_id=? OR ${alias}.cosigned_by IS ?)`, params: [user.id, user.id] };
}
Object.assign(module.exports, { readsCounseling, mayReadCounseling, counselingFilter });
