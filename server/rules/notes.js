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

const isYes = (v) => v === true || v === 1 || v === '1' || v === 'true';
// Shared with POST /api/notes/:id/sign and PUT /api/notes/:id (1.17.1; engineering review of 1.17.0, L2), so the
// REST routes and sync push accept the same review statement and keep the AI-assisted mark the same way.
/** The author's statement that they reviewed AI-drafted text, as the sign route and a push both read it. */
const aiReviewed = (v) => isYes(v);
/** AI-assisted stays AI-assisted: once the stored note has the mark, a later save cannot take it off. */
const keepAiAssisted = (value, existing) => (existing && Number(existing.ai_assisted) ? 1 : value);
const parseList = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
// Everything about a signed note stays as signed, except asking a supervisor to look at it (request-cosign).
const SIGNED_KEEPS = ['kind', 'format', 'title_enc', 'content_enc', 'structured_enc', 'occurred_at', 'intervention_id', 'call_id', 'part2_protected', 'counseling_note', 'problem_ids',
  'status', 'signed_by', 'signed_at', 'signature_hash', 'source', 'source_ref', 'import_item_id', 'deleted_at', 'ai_assisted'];
// What a signed note says (its signature's bookkeeping aside): a push that would change any of it is refused, as
// PUT /api/notes/:id refuses it, never reported as applied while the office quietly keeps what was signed (pen test
// of 1.23.6, L3). The message is the REST route's own.
const SIGNED_CONTENT = ['kind', 'format', 'title_enc', 'content_enc', 'structured_enc', 'occurred_at', 'intervention_id', 'call_id', 'part2_protected', 'counseling_note', 'problem_ids'];
const SIGNED_MESSAGE = 'Signed notes cannot be edited; add an addendum instead';
/** Do two values of a note column say the same thing (a list, a yes/no, a moment may arrive written another way)? */
function sameValue(col, a, b) {
  const blank = (x) => x === undefined || x === null || x === '';
  if (col === 'problem_ids') { const list = (x) => { try { return JSON.stringify(blank(x) ? [] : parseList(x) || []); } catch { return String(x); } }; return list(a) === list(b); }
  if (col === 'part2_protected' || col === 'counseling_note') return Number(isYes(a)) === Number(isYes(b));
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (col === 'occurred_at') { const ms = (x) => Date.parse(x); return String(a) === String(b) || (Number.isFinite(ms(a)) && ms(a) === ms(b)); }
  return String(a) === String(b);
}
/** The refusal for a push that would change a signed note, or null. */
function signedNoteEdit(row, c) {
  const e = c.existing;
  if (!e || e.status === 'draft') return null;
  const unsigns = row.status !== undefined && row.status !== null && row.status !== e.status && row.status === 'draft';
  if (!unsigns && !SIGNED_CONTENT.some(col => row[col] !== undefined && !sameValue(col, row[col], c.was(col)))) return null;
  return refuse(`not permitted: ${SIGNED_MESSAGE}`, { message: SIGNED_MESSAGE });
}

/**
 * A supervisor's "Finish and sign your note" reminder (public/views/supervision.js) has done its job once the note is
 * signed: it is closed rather than left open for the author to tick off (1.16.0). Only the author's own open to-dos
 * for this client, given them by someone else, are read. Returns the ids.
 * Which reminder (1.23.2): its details end with SIGN_REMINDER, no record id, and it asks the author to sign their
 * drafts on that client's record, so it closes once the last of them is signed. Until 1.23.2 its last line named the
 * note's record id ("Reference: supervision reminder for note <id>"), which the worker read as noise; a reminder made
 * with that line still closes when that note is signed.
 */
const SIGN_REMINDER = 'This reminder closes itself once your draft notes on this client\'s record are signed.';
const OLD_REMINDER_REF = /Reference: supervision reminder for note ([\w-]+)/;
// Either line, as written now or before 1.23.2: the write check (rules/tasks.js) and recognition both use this, so the
// old line cannot be pasted into a to-do to pass for a reminder (review of 1.23.3).
const hasReminderLine = (text) => !!text && (String(text).includes(SIGN_REMINDER) || OLD_REMINDER_REF.test(String(text)));
// Who may send one: whoever sees the drafts it is about and has Remind, that is holds notes:cosign (the supervision
// queue's unsigned notes are theirs; public/views/supervision.js). Checked against the maker's account as it is now.
const maySendSignReminder = (user) => auth.hasPerm(user, 'notes:cosign');
const makerMaySend = (userId) => { const u = userId && db.one(`SELECT id, role FROM users WHERE id=?`, userId); return !!u && maySendSignReminder(u); };
/**
 * Is this to-do a supervisor's sign reminder (1.23.3)? Its details carry the reminder's line (or the line before
 * 1.23.2), it was given to its assignee by someone else, and that someone may send one (notes:cosign). Until 1.23.3
 * anyone could make a to-do with the line in it for a colleague, and it passed for a supervisor's: Supervision showed the
 * colleague's draft as reminded, and signing closed it (market evaluation of 1.23.2). Such a to-do is an ordinary one.
 * `text` is the decrypted details. The UI trusts the `sign_reminder` flag the to-do routes set from this.
 */
function isSignReminder(t, text) {
  if (!t || !text || !t.created_by || t.created_by === t.assigned_to) return false;
  if (!hasReminderLine(text)) return false;
  return makerMaySend(t.created_by);
}
// `cause: 'deleted'`: the last draft was deleted, not signed, so the reminder is cancelled rather than done (1.23.3);
// `cause: 'reassigned'` (1.24.0): the last draft was handed on to another worker (reassignRefusal below), likewise.
function closeSignReminders(authorId, noteId, clientId, { cause = 'signed' } = {}) {
  const { decrypt } = require('../crypto');
  const ref = `Reference: supervision reminder for note ${noteId}`;
  const draftsLeft = db.one(`SELECT COUNT(*) n FROM notes WHERE author_id=? AND client_id IS ? AND status='draft' AND deleted_at IS NULL AND id<>?`, authorId, clientId, noteId).n;
  const done = db.all(`SELECT id, created_by, assigned_to, description_enc FROM tasks WHERE assigned_to=? AND status IN ('open','in_progress') AND client_id IS ? AND description_enc IS NOT NULL`, authorId, clientId)
    .filter(t => { let text; try { text = decrypt(t.description_enc); } catch { return false; } return isSignReminder(t, text) && (text.includes(ref) || (!draftsLeft && text.includes(SIGN_REMINDER))); });
  const now = db.now();
  for (const t of done) {
    if (cause === 'deleted' || cause === 'reassigned') db.run(`UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?`, now, t.id);
    else db.run(`UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?`, now, now, t.id);
  }
  // A reminder linked to this draft (tasks.note_id, released in 1.24.0) that stays open, because other drafts of theirs on
  // this record are left, loses the link: it opens the client's drafts list again rather than a note with nothing to
  // finish. The reminder is not re-pointed at another draft (the supervisor chose this one); it closes as before.
  const closed = new Set(done.map(t => t.id));
  for (const t of db.all(`SELECT id FROM tasks WHERE note_id=? AND status IN ('open','in_progress')`, noteId)) if (!closed.has(t.id)) db.run(`UPDATE tasks SET note_id=NULL, updated_at=? WHERE id=?`, now, t.id);
  return done.map(t => t.id);
}

/**
 * A note no longer a SUD counseling note is sent again to the devices that dropped it (routes/sync.js exportInto,
 * dropHidden); its addenda, unchanged themselves, are stamped so they follow it. Called by PUT /api/notes/:id and push.
 */
function reissueAddenda(noteId, was, now) {
  if (Number(was) && !Number(now)) db.run(`UPDATE note_addenda SET updated_at=? WHERE note_id=?`, db.now(), noteId);
}

/**
 * Copilot drafts not yet in a note (security review of 1.17.0, r11 finding 2). A draft asked for in a saved note
 * marks that note on the server (routes/ai.js); one asked for in a note not saved yet has no note to mark, and
 * until now the note it went into was marked AI-assisted only if the browser said so. So a successful note draft
 * with no note id is remembered here, for its author and client, for AI_DRAFT_MINUTES: the next note that author
 * writes text into for that client (a new note, or new text in a draft, over REST or sync push) is marked
 * AI-assisted by the office, whatever the browser sends, and uses it up. Several drafts before a save (asking
 * again) are one pending draft: they go into one note. Held in memory (SUDS runs one server process per
 * database; the copilot runs only on the office server): no schema change, and a restart forgets them.
 * Consequences of the mark are the existing ones: signing needs the review statement, and a SUD counseling note
 * is refused while one is pending (the author writes one without the copilot, or saves the draft first).
 */
const AI_DRAFT_MINUTES = 120;
const pendingDrafts = new Map(); // `${userId}|${clientId}` -> expiry (ms)
const draftKey = (userId, clientId) => `${userId}|${clientId}`;
function copilotDrafted(userId, clientId) {
  const now = Date.now();
  if (pendingDrafts.size > 5000) for (const [k, exp] of pendingDrafts) if (exp <= now) pendingDrafts.delete(k);
  pendingDrafts.set(draftKey(userId, clientId), now + AI_DRAFT_MINUTES * 60_000);
}
function draftPending(userId, clientId) {
  const k = draftKey(userId, clientId); const exp = pendingDrafts.get(k);
  if (exp === undefined) return false;
  if (exp <= Date.now()) { pendingDrafts.delete(k); return false; }
  return true;
}
const useDraft = (userId, clientId) => pendingDrafts.delete(draftKey(userId, clientId));
/** Does this write put text into the note: a new note, or new title, text or sections in a draft? */
const writesText = (c) => !c.existing || (c.existing.status === 'draft' && c.changed().some(k => ['title_enc', 'content_enc', 'structured_enc'].includes(k)));

/** Does this push sign the note: a new note that is not a draft, or a draft that stops being one? */
const signs = (row, c) => !!row.status && row.status !== 'draft' && (!c.existing || c.existing.status === 'draft');
/**
 * "Require fingerprint or authenticator for signing" (Settings → Security policy, docs/FINGERPRINT.md): a signature
 * then needs a fingerprint or an authenticator code given to the office, which a device syncing a note it signed
 * offline cannot have given (its signature rests on the device's password). So such a note lands as a DRAFT, flagged
 * so the device says why, and audited (sync.conflict with flagged "strong_signing", and note.sign.failed); its author
 * signs it at the office. REST signing enforces the same policy in auth.verifySigner. Never on a device itself.
 */
const strongSigningRequired = () => !require('../config').local && auth.policy().signStrongRequired;
const STRONG_SIGNING_FLAG = 'was saved as a draft, not signed: your programme requires your fingerprint or an authenticator code to sign a note, which cannot be given from a device. Open the note in SUDS at the office address and sign it there.';

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
  // Said by the device with a row, never stored (push.js): the author's review of AI-drafted text as they sign.
  statements: ['ai_reviewed'],
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
    // A copilot draft this author asked for this client, not in a note yet: this note is where it went (above).
    const fromDraft = !!c.user && writesText(c) && draftPending(c.user.id, c.existing ? e.client_id : row.client_id);
    if (fromDraft) { row.ai_assisted = 1; c.copilotDraft = true; }
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
    // A SUD counseling note is never drafted with the AI copilot (docs/AI-COPILOT.md; the strategy's rule until
    // counsel says otherwise): a note with copilot text cannot become one, nor a counseling note take copilot text.
    const counseling = Number(row.counseling_note ?? e.counseling_note) === 1;
    const ai = Number(row.ai_assisted) === 1 || Number(e.ai_assisted) === 1;
    if (counseling && ai && (!c.existing || ['counseling_note', 'ai_assisted'].some(k => row[k] !== undefined && row[k] !== null && Number(row[k]) !== Number(e[k] || 0)))) {
      if (fromDraft && Number(e.ai_assisted) !== 1) out.push(refuse('has a value the office does not accept (a SUD counseling note cannot include text drafted by the AI copilot: a copilot draft for this client is not in a note yet)', { message: `You asked the AI copilot for a note draft for this client in the last ${AI_DRAFT_MINUTES / 60} hours that has not been saved in a note, so this note is treated as including it, and a SUD counseling note cannot include text drafted by the AI copilot. Save the drafted note first, or write the counseling note later.`, fields: { counseling_note: 'a copilot draft for this client is not in a note yet' } }));
      else out.push(refuse('has a value the office does not accept (a SUD counseling note cannot include text drafted by the AI copilot)', { message: 'A SUD counseling note cannot include text drafted by the AI copilot', fields: { counseling_note: 'this note has AI-drafted text; a SUD counseling note is written without the copilot' } }));
    }
    // An AI-assisted note is signed only with its author's statement that they reviewed the drafted text, over sync
    // as over REST (security review of 1.17.0, L1): the device sends it with the row (local/sync.js).
    if (c.via === 'sync' && signs(row, c) && ai && !aiReviewed(c.statements && c.statements.ai_reviewed)) {
      out.push(refuse('needs the author\'s review statement: this note includes text drafted by the AI copilot', { message: 'This note includes text drafted by the AI copilot. Confirm you have reviewed and corrected it before signing.', fields: { ai_reviewed: 'confirm you reviewed the AI-drafted text' } }));
    }
    // Only the person who wrote a note signs it, and only they (POST /api/notes/:id/sign): on push, the syncing user
    // signing their own note. A supervisor countersigns instead.
    if (c.via === 'sync' && signs(row, c) && (c.user.id !== (c.existing ? e.author_id : row.author_id) || (row.signed_by && row.signed_by !== c.user.id))) {
      out.push(refuse('not permitted: only the author can sign a note', { status: 403, message: 'Only the author can sign a note. Supervisors countersign instead.' }));
    }
    // Used up by this note once nothing refuses it: over REST now (the route writes next), over sync once it lands.
    if (fromDraft && !out.length && c.via !== 'sync') useDraft(c.user.id, c.existing ? e.client_id : row.client_id);
    return out;
  },
  normalise(row, c) {
    const e = c.existing;
    // A signed note is the legal record: a device's change to it is refused and the device told (signedNoteEdit).
    const signedEdit = signedNoteEdit(row, c);
    if (signedEdit) return signedEdit;
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
      row.ai_assisted = keepAiAssisted(row.ai_assisted, e); // AI-assisted stays AI-assisted
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
    const flags = [];
    if (signs(row, c) && c.via === 'sync' && strongSigningRequired()) {
      row.status = 'draft'; c.signRefused = true;
      flags.push(flag(STRONG_SIGNING_FLAG, { code: 'strong_signing' }));
    }
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
    if (asserted) flags.push(flag('was accepted, but not the countersignature on it: a supervisor countersigns at the office, never by sync', { code: 'ruling' }));
    return flags.length ? flags : null;
  },
  // A note signed on a device closes its reminder at the office too, as signing here does (routes/notes.js).
  // The signature is recomputed as POST /api/notes/:id/sign computes it, and audited as that route audits it.
  afterApply(row, o, c) {
    if (c.copilotDraft) {
      useDraft(c.user.id, c.existing ? c.existing.client_id : row.client_id);
      require('../audit').log({ user: c.user, action: 'note.ai_assisted', entity: 'note', entityId: row.id, clientId: c.existing ? c.existing.client_id : row.client_id, ip: 'device', details: { via: 'sync', cause: 'copilot_draft' } });
    }
    if (c.existing) reissueAddenda(row.id, c.existing.counseling_note, o.counseling_note ?? c.existing.counseling_note);
    if (c.signRefused) require('../audit').log({ user: c.user, action: 'note.sign.failed', entity: 'note', entityId: row.id, clientId: c.existing ? c.existing.client_id : row.client_id, ip: 'device', success: false, details: { via: 'sync', reason: 'fingerprint or authenticator code required', kept: 'draft' } });
    if (c.existing && c.existing.status !== 'draft') return;
    // A draft deleted on a device: as over REST, a reminder to sign that author's drafts on this record closes once none is left.
    if (c.existing && !c.existing.deleted_at && row.deleted_at) {
      const reminders = closeSignReminders(c.existing.author_id, c.existing.id, c.existing.client_id, { cause: 'deleted' });
      for (const id of reminders) require('../audit').log({ user: c.user, action: 'task.update', entity: 'task', entityId: id, clientId: c.existing.client_id, ip: 'device', details: { via: 'sync', status: 'cancelled', cause: 'deleted', note: c.existing.id } });
      return;
    }
    const n = db.one(`SELECT id, author_id, client_id, status, signed_by, content_enc, structured_enc, cosign_required, ai_assisted FROM notes WHERE id=?`, row.id);
    if (!n || n.status === 'draft') return;
    const hash = require('../note-signature').signatureHash(n, n.signed_by);
    db.run(`UPDATE notes SET signature_hash=? WHERE id=?`, hash, n.id);
    const reminders = closeSignReminders(n.author_id, n.id, n.client_id);
    require('../audit').log({ user: c.user, action: 'note.sign', entity: 'note', entityId: n.id, clientId: n.client_id, ip: 'device', details: { hash, via: 'sync', cosign_required: !!n.cosign_required, reminders_closed: reminders.length ? reminders : undefined, ai_assisted: Number(n.ai_assisted) ? true : undefined, ai_reviewed: Number(n.ai_assisted) ? true : undefined } });
    // Each reminder closed by the signature has its own entry, as a delete's and a transfer's have (market evaluation of 1.23.4, D4).
    for (const id of reminders) require('../audit').log({ user: c.user, action: 'task.update', entity: 'task', entityId: id, clientId: n.client_id, ip: 'device', details: { via: 'sync', status: 'done', cause: 'signed', note: n.id } });
  },
});
module.exports.closeSignReminders = closeSignReminders;
module.exports.SIGN_REMINDER = SIGN_REMINDER;
module.exports.SIGNED_MESSAGE = SIGNED_MESSAGE;
module.exports.hasReminderLine = hasReminderLine;
Object.assign(module.exports, { isSignReminder, maySendSignReminder });
module.exports.reissueAddenda = reissueAddenda;
Object.assign(module.exports, { AI_DRAFT_MINUTES, copilotDrafted, draftPending, pendingDrafts, aiReviewed, keepAiAssisted, strongSigningRequired });

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

/**
 * Handing on a departed worker's draft notes (1.24.0; market evaluation of 1.23.4, D5). A draft is its author's,
 * and only its author signs it, so a draft left by someone who has gone (their account inactive) could only be
 * deleted: the work in it was lost, or the client's record kept an unsigned note nobody could finish. A manager
 * (records:manage-others, the "or a manager" power over another worker's drafts) may now give such a draft to
 * another worker, who then edits and signs it as its author. The rule, shared by POST /api/notes/:id/reassign and
 * POST /api/notes/reassign-drafts:
 *   - only a draft: a signed note is the legal record and its author never changes;
 *   - only from an author whose account is inactive: an active author finishes (or deletes) their own draft;
 *   - only to an active account that may write that kind of note (notes:<kind>:write) and reach the client;
 *   - a SUD counseling note (42 CFR §2.11) only to someone who may read one as staff, that is who holds
 *     notes:clinical:write (readsCounseling below): never to a navigator, who could not even open it.
 * Who wrote a note is never a device's to say (createdBy: author_id is confined to the syncing user on push, and kept
 * on every update), so sync push cannot reassign a note at all, and this is an office act (assertRulingHere).
 * `actor` and `target` are user rows; `note` a notes row. Returns null, or { code, status, message, field }:
 * `code` is counseling, kind or reach when it is this note that cannot go to this worker (a batch skips it).
 */
function reassignRefusal(actor, note, target) {
  if (!auth.hasPerm(actor, 'records:manage-others')) return { code: 'permission', status: 403, message: 'Handing on another worker\'s draft notes needs a supervisor or administrator (records:manage-others)' };
  if (!note || note.deleted_at) return { code: 'missing', status: 404, message: 'Note not found' };
  if (note.status !== 'draft') return { code: 'signed', status: 400, message: 'A signed note is part of the legal record: its author cannot be changed. Add an addendum instead.' };
  const author = db.one(`SELECT id, is_active FROM users WHERE id=?`, note.author_id);
  if (author && author.is_active) return { code: 'author_active', status: 400, message: 'The author\'s account is still active: they finish or delete their own draft. Only a departed worker\'s drafts are handed on.' };
  if (!target) return { code: 'target', status: 404, message: 'Worker not found', field: 'to_user_id' };
  if (target.id === note.author_id) return { code: 'target', status: 400, message: 'Choose a different worker', field: 'to_user_id' };
  if (!target.is_active) return { code: 'target', status: 400, message: 'That worker\'s account is not active', field: 'to_user_id' };
  if (Number(note.counseling_note) && !readsCounseling(target)) return { code: 'counseling', status: 400, message: 'A SUD counseling note can only go to a worker who writes clinical notes (a clinician or supervisor)', field: 'to_user_id' };
  if (!auth.hasPerm(target, `notes:${note.kind}:write`)) return { code: 'kind', status: 400, message: `That worker cannot write ${note.kind} notes`, field: 'to_user_id' };
  if (!auth.canAccessClient(target, note.client_id)) return { code: 'reach', status: 400, message: 'That worker cannot open this client\'s record (it is not on their caseload)', field: 'to_user_id' };
  return null;
}
/**
 * Give the draft to `target` (reassignRefusal has passed): it is theirs to edit and sign. A countersignature the old
 * author's account required stays required, and the new author's own requirement is added (never lowered). A
 * reminder to sign the old author's drafts on this record is cancelled once none is left. Audited as note.reassign,
 * with user ids only (no title, no content). Returns the ids of the reminders cancelled.
 */
function reassignDraft(actor, note, target, { ip, bulk = false } = {}) {
  const audit = require('../audit');
  const req = db.one(`SELECT requires_cosign FROM users WHERE id=?`, target.id);
  const cosign = Number(note.cosign_required) || (req && req.requires_cosign) ? 1 : 0;
  db.run(`UPDATE notes SET author_id=?, cosign_required=?, updated_at=? WHERE id=? AND status='draft' AND deleted_at IS NULL`, target.id, cosign, db.now(), note.id);
  const reminders = closeSignReminders(note.author_id, note.id, note.client_id, { cause: 'reassigned' });
  audit.log({ user: actor, action: 'note.reassign', entity: 'note', entityId: note.id, clientId: note.client_id, ip, details: { from: note.author_id, to: target.id, kind: note.kind, counseling_note: Number(note.counseling_note) ? true : undefined, bulk: bulk || undefined, reminders_closed: reminders.length ? reminders : undefined } });
  for (const id of reminders) audit.log({ user: actor, action: 'task.update', entity: 'task', entityId: id, clientId: note.client_id, ip, details: { status: 'cancelled', cause: 'reassigned', note: note.id } });
  return reminders;
}
const PER_NOTE_REFUSALS = ['counseling', 'kind', 'reach'];
Object.assign(module.exports, { reassignRefusal, reassignDraft, PER_NOTE_REFUSALS });
