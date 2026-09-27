'use strict';
// The programme's supply items are the office's (server/routes/supplies.js), pull-only like Settings → Lists: a
// device offers the same items offline and cannot change them (sync-tables.js serverOwned).
const { define } = require('./core');

module.exports = define({ table: 'supply_items' });
