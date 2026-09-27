'use strict';
// The rules for the resource directory (agencies a client can be referred to), for /api/resources and sync push:
// resources:write, and the directory's fields.
const C = require('../constants');
const { define } = require('./core');

module.exports = define({
  table: 'resources',
  fields: {
    name: { type: 'string', required: true, maxLen: 200 }, category: { type: 'string', required: true, enum: C.RESOURCE_CATEGORIES }, organization: { type: 'string', maxLen: 200 },
    phone: { type: 'string', maxLen: 40 }, fax: { type: 'string', maxLen: 40 }, email: { type: 'string', maxLen: 200 }, website: { type: 'string', maxLen: 300 }, address: { type: 'string', maxLen: 300 },
    city: { type: 'string', maxLen: 100 }, zip: { type: 'string', maxLen: 12 }, hours: { type: 'string', maxLen: 200 }, eligibility: { type: 'string', maxLen: 1000 }, services: { type: 'string', maxLen: 1000 },
    languages: { type: 'string', maxLen: 200 }, accepts_medicaid: { type: 'boolean' }, accepts_uninsured: { type: 'boolean' }, mat_offered: { type: 'string', maxLen: 200 }, capacity_notes: { type: 'string', maxLen: 1000 },
    contact_person: { type: 'string', maxLen: 200 }, is_active: { type: 'boolean' }, last_verified_at: { type: 'date' }, notes: { type: 'string', maxLen: 2000 },
    summary: { type: 'string', maxLen: 3000 }, service_tags: { type: 'string', maxLen: 1000 }, levels_of_care: { type: 'string', maxLen: 200 }, populations: { type: 'string', maxLen: 500 }, intake_process: { type: 'string', maxLen: 2000 }, cost_notes: { type: 'string', maxLen: 1000 },
  },
});
