'use strict';
// The rules for the form library (county forms), for /api/forms/templates and sync push: forms:manage, and a
// template's fields (the file travels as a blob).
const C = require('../constants');
const { define } = require('./core');

module.exports = define({
  table: 'form_templates',
  fields: { name: { type: 'string', required: true, maxLen: 200 }, description: { type: 'string', maxLen: 1000 }, category: { type: 'string', enum: C.FORM_CATEGORIES }, version: { type: 'string', maxLen: 40 }, filename: { type: 'string', maxLen: 200 }, instructions: { type: 'string', maxLen: 3000 }, is_active: { type: 'boolean' } },
});
