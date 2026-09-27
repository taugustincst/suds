'use strict';
// The rules for a resource's photos, for /api/resources/:id/photos and sync push (the image itself travels as a
// blob, fetched and uploaded on its own): resources:write, and a caption and sizes the photo routes accept.
const { define } = require('./core');

module.exports = define({
  table: 'resource_photos',
  fields: { caption: { type: 'string', maxLen: 200 }, width: { type: 'number', min: 1, max: 20000, integer: true }, height: { type: 'number', min: 1, max: 20000, integer: true }, sort_order: { type: 'number', min: 0, max: 1000, integer: true } },
});
