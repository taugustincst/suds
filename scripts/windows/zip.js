'use strict';
// A small ZIP writer and reader (stored or deflated entries, no ZIP64, no encryption), Node built-ins only. The
// Windows server zip (scripts/build-windows.js) is written with it, and `suds update --from <zip>` reads it
// (scripts/windows/cli.js). The writer is deterministic: the same files give the same bytes (entries in the order
// given, one fixed timestamp, no extra fields), so a release re-run can compare the zip it builds with the one
// already published (scripts/release-existing.js).
const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50; const SIG_CENTRAL = 0x02014b50; const SIG_END = 0x06054b50;
const LIMIT = 0xffffffff;

/** A Date as the MS-DOS date and time fields a ZIP header holds (local time is not used: the date is taken as UTC). */
function dosDateTime(date) {
  const d = new Date(date);
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function checkName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.split('/').some((p) => p === '..' || p === '')) {
    throw new Error(`zip: refusing the entry name ${JSON.stringify(name)} (a relative path with forward slashes, no "..")`);
  }
}

/**
 * entries: [{ name: 'app/server/index.js', data: Buffer }] in the order they are written. Directories are implied
 * by the file paths (no directory entries). mtime: one timestamp for every entry.
 */
function writeZip(entries, { mtime = '2026-01-01T00:00:00Z', level = 9 } = {}) {
  const { time, date } = dosDateTime(mtime);
  const locals = []; const centrals = []; let offset = 0;
  const seen = new Set();
  for (const e of entries) {
    checkName(e.name);
    if (seen.has(e.name)) throw new Error(`zip: ${e.name} is listed twice`);
    seen.add(e.name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const deflated = zlib.deflateRawSync(data, { level });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    if (data.length >= LIMIT || body.length >= LIMIT || offset >= LIMIT) throw new Error(`zip: ${e.name} needs ZIP64, which this writer does not do`);
    const crc = zlib.crc32(data) >>> 0;
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36); central.writeUInt32LE(((e.mode || 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  if (entries.length > 0xffff) throw new Error('zip: more than 65535 entries needs ZIP64');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** The entries of a ZIP: [{ name, size, data() }]. Directory entries are left out. */
function readZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === SIG_END) { end = i; break; }
  if (end < 0) throw new Error('zip: this is not a ZIP file (no end of central directory)');
  const count = buf.readUInt16LE(end + 10); const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === LIMIT) throw new Error('zip: ZIP64 archives are not read here');
  const out = []; let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('zip: damaged central directory');
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20); const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new Error(`zip: ${name} is encrypted`);
    if (csize === LIMIT || size === LIMIT || local === LIMIT) throw new Error(`zip: ${name} needs ZIP64, which is not read here`);
    if (name.endsWith('/')) continue;
    checkName(name);
    if (buf.readUInt32LE(local) !== SIG_LOCAL) throw new Error(`zip: damaged local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({
      name, size,
      data() {
        const raw = buf.subarray(start, start + csize);
        const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
        if (!data) throw new Error(`zip: ${name} uses compression method ${method}, which is not read here`);
        if (data.length !== size || (zlib.crc32(data) >>> 0) !== crc) throw new Error(`zip: ${name} is damaged (its size or CRC does not match)`);
        return data;
      },
    });
  }
  return out;
}

module.exports = { writeZip, readZip, dosDateTime };
