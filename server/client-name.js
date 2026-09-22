'use strict';
// Adds a decrypted client display name to a list row that carries the client's encrypted name columns
// (selected as c_first_name_enc / c_last_name_enc). A role without clients:read gets the code only.
const auth = require('./auth');
const M = require('./clients-model');

const SELECT = 'c.first_name_enc AS c_first_name_enc, c.last_name_enc AS c_last_name_enc';

function withClientName(ctx, x) {
  const deidentify = !auth.hasPerm(ctx.user, 'clients:read');
  let client_name = null;
  if (x.client_id && !deidentify && (x.c_first_name_enc || x.c_last_name_enc)) {
    try { client_name = M.decryptRow({ first_name_enc: x.c_first_name_enc, last_name_enc: x.c_last_name_enc }).display_name || null; } catch { client_name = null; }
  }
  const out = { ...x, client_name };
  delete out.c_first_name_enc; delete out.c_last_name_enc;
  return out;
}
module.exports = { withClientName, SELECT };
