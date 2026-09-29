'use strict';
// The anonymous syringe services participant code (1.17.0, docs/SUPPLIES.md "Participant codes").
//
// A syringe services program has to say how many different people it served, yet most of its contacts are
// anonymous: a participant who gives no name gives, instead, a short code built the same way every time from
// details only they know and can reproduce (the program's own recipe; SUDS suggests one in the visit form's
// help). SUDS never stores or asks for the details themselves, only the code, and treats the code as what it
// is — built from personal details, so possibly identifying in a small community:
//   * it is stored encrypted (interventions.participant_code_enc) like any other PHI, and only on a contact
//     with no client record (a client is already counted by their record);
//   * it is counted by its blind index (participant_code_idx, HMAC-SHA256 under the index key, as client
//     search is), so the SSP summary counts unique codes without decrypting one;
//   * it is never printed in a report, never in a de-identified export (a random per-file reference stands in
//     for it there), and never in a publication release.
// Written the same way by every door, through server/rules/interventions.js participantCode: the visit routes
// (server/routes/interventions.js), sync push (server/rules/interventions.js normalise, server/sync-tables.js
// importRow), and key rotation (scripts/rotate-index-key.js).
const { blindIndex } = require('./crypto');

const MIN = 4;
const MAX = 20;

/** The code as stored: upper case, letters and digits only (spaces, dashes and dots people type dropped); null when blank. */
function normalise(code) {
  if (code === null || code === undefined) return null;
  const s = String(code).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s || null;
}

/** Why a code cannot be stored, or null. Checked on the normalised form. */
function problem(code) {
  if (code === null || code === undefined || String(code).trim() === '') return null;
  const n = normalise(code);
  if (!n || n.length < MIN) return `must have at least ${MIN} letters or digits`;
  if (n.length > MAX) return `must have at most ${MAX} letters or digits`;
  return null;
}

/** The blind index a code is counted by (a separate domain from the name indexes); null when blank. */
function index(code) {
  const n = normalise(code);
  return n ? blindIndex(`ssp participant ${n}`) : null;
}

module.exports = { normalise, problem, index, MIN, MAX };
