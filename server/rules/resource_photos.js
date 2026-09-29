'use strict';
// The rules for a resource's photos, for /api/resources/:id/photos and sync push (the image itself travels as a
// blob, fetched and uploaded on its own): resources:write, a caption and sizes the photo routes accept, a picture
// type (the blob route checks the bytes). A picture is the directory's, not a person's (it shows a treatment
// centre, not a client), so anyone who keeps the directory may remove one, by sync as over REST: sync used to drop
// such a removal quietly unless its user held records:manage-others (security review of 1.16.0, L5).
const { define, refuse } = require('./core');

const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

module.exports = define({
  table: 'resource_photos',
  deviceColumns: ['content_type', 'bytes', 'thumb_b64'], createdBy: ['uploaded_by'],
  deletableBy: () => null,
  check(row) { return row.content_type !== undefined && !PICTURE_TYPES.includes(row.content_type) ? refuse('has a value the office does not accept (a picture must be a JPEG, PNG or WebP image)') : null; },
  fields: { caption: { type: 'string', maxLen: 200 }, width: { type: 'number', min: 1, max: 20000, integer: true }, height: { type: 'number', min: 1, max: 20000, integer: true }, sort_order: { type: 'number', min: 0, max: 1000, integer: true } },
});
