'use strict';
// The rules for notes, for /api/notes and sync push. A clinical note is written only by a role holding
// notes:clinical:write, and only a clinical note can be a SUD counseling note (42 CFR §2.11). A draft is its
// author's (or a manager's) to change. A signed note is the legal record: nothing about it changes except the
// request for a review, and an addendum is how it grows (server/rules/note_addenda.js). Only the author signs;
// a countersignature is the supervisor's act on the office server and is never taken from a device.
const db = require('../db');
const auth = require('../auth');
const { define, refuse, flag, notPermitted } = require('./core');

const parseList = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
// Everything about a signed note stays as signed, except asking a supervisor to look at it (request-cosign).
const SIGNED_KEEPS = ['kind', 'format', 'title_enc', 'content_enc', 'structured_enc', 'occurred_at', 'intervention_id', 'call_id', 'part2_protected', 'counseling_note', 'problem_ids',
  'status', 'signed_by', 'signed_at', 'signature_hash', 'source', 'source_ref', 'import_item_id', 'deleted_at'];

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
    // A countersignature is the supervisor's act on the office server (POST /api/notes/:id/cosign); a device can
    // never assert one, and one it asks for is flagged rather than dropped unseen (security review of 1.15.3, H1).
    const COSIGN = ['cosigned_by', 'cosigned_at', 'cosignature_hash'];
    const has = (v) => v !== undefined && v !== null && v !== '';
    const asserted = COSIGN.some(k => has(row[k]) && String(row[k]) !== String((e && e[k]) ?? '')) || (has(row.cosign_note_enc) && String(row.cosign_note_enc) !== String((e && c.was('cosign_note_enc')) ?? ''));
    if (e) {
      row.kind = e.kind; // a note's kind is decided when it is written (no route changes it)
      if (e.status !== 'draft') for (const col of SIGNED_KEEPS) row[col] = col.endsWith('_enc') ? undefined : e[col];
      for (const k of COSIGN) row[k] = e[k];
      row.cosign_note_enc = undefined;
      // Whether it needs a countersignature comes from its author's account when it was written, as over REST.
      row.cosign_required = e.cosign_required;
    } else {
      for (const k of COSIGN) row[k] = null;
      row.cosign_note_enc = undefined;
      const author = db.one(`SELECT requires_cosign FROM users WHERE id=?`, row.author_id || c.user.id);
      row.cosign_required = author && author.requires_cosign ? 1 : 0;
    }
    return asserted ? flag('was accepted, but not the countersignature on it: a supervisor countersigns at the office, never by sync', { code: 'ruling' }) : null;
  },
});
