'use strict';
// Adds a decrypted client display name to a list row that carries the client's encrypted name columns
// (selected as c_first_name_enc / c_last_name_enc). A role without clients:read gets the code only.
const auth = require('./auth');
const M = require('./clients-model');

// With the participant code (1.21.0): a client known only by one is listed as "Participant CODE" (clients-model.js).
const SELECT = 'c.first_name_enc AS c_first_name_enc, c.last_name_enc AS c_last_name_enc, c.participant_code_enc AS c_participant_code_enc';

function withClientName(ctx, x) {
  const deidentify = !auth.hasPerm(ctx.user, 'clients:read');
  let client_name = null;
  if (x.client_id && !deidentify && (x.c_first_name_enc || x.c_last_name_enc || x.c_participant_code_enc)) {
    try { client_name = M.decryptRow({ first_name_enc: x.c_first_name_enc, last_name_enc: x.c_last_name_enc, participant_code_enc: x.c_participant_code_enc || null }).display_name || null; } catch { client_name = null; }
  }
  const out = { ...x, client_name };
  delete out.c_first_name_enc; delete out.c_last_name_enc; delete out.c_participant_code_enc;
  return out;
}
module.exports = { withClientName, SELECT };
