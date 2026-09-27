'use strict';
// Accounts are the office's: a device receives them (its own password hash, never an MFA secret) and never
// writes them back. Every user id a device sends in another table is remapped instead (server/rules/push.js).
const { define } = require('./core');

module.exports = define({ table: 'users', pushable: false });
