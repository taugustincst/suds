'use strict';
// The Authenticode signature of a Windows executable (PE file): where it is, and removing it. The official node.exe
// is signed by the OpenJS Foundation; once the SUDS bootstrap is injected into a copy of it that signature no longer
// matches, so it is removed first (Node's single-executable docs: `signtool remove /s`). scripts/build-windows.js
// uses signtool on the Windows runner and this on any other machine (a local cross-build), and checks with it that
// no signature is left either way. Node built-ins only.

/** { offset, size, sizeField, checksumField } of the certificate table (data directory 4), or throws if not a PE. */
function certificateTable(buf) {
  if (buf.length < 0x40 || buf.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a Windows executable (no MZ header)');
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) throw new Error('not a Windows executable (no PE header)');
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirs = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
  if (dirs < 0) throw new Error(`unknown PE optional header (magic 0x${magic.toString(16)})`);
  const count = buf.readUInt32LE(dirs - 4);
  if (count < 5) return { offset: 0, size: 0, entry: null, checksumField: opt + 64 };
  const entry = dirs + 4 * 8;
  return { offset: buf.readUInt32LE(entry), size: buf.readUInt32LE(entry + 4), entry, checksumField: opt + 64 };
}

function isSigned(buf) { const t = certificateTable(buf); return t.size > 0; }

/** A copy of `buf` with its Authenticode signature removed (what `signtool remove /s` does). */
function stripSignature(buf) {
  const t = certificateTable(buf);
  if (!t.size) return Buffer.from(buf);
  if (t.offset + t.size > buf.length) throw new Error('the certificate table runs past the end of the file');
  // The table is at the end of the file (it is not mapped into memory); anything after it would be lost.
  const tail = buf.subarray(t.offset + t.size);
  if (tail.some((b) => b !== 0)) throw new Error('data follows the certificate table: not removing it');
  const out = Buffer.from(buf.subarray(0, t.offset));
  out.writeUInt32LE(0, t.entry); out.writeUInt32LE(0, t.entry + 4);
  out.writeUInt32LE(0, t.checksumField); // the image checksum covered the signed file; 0 = not set
  return out;
}

module.exports = { certificateTable, isSigned, stripSignature };
