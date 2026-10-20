import { inflateSync as _inflate, deflateSync as _deflate, zlibSync, unzlibSync } from 'fflate';
// maxOutputLength as Node has it (1.26.1, H2: server/importers/text.js unzip caps what it inflates). fflate cannot stop
// part way, so the cap is checked after; on a device the memory spent is that browser tab's own.
const capped = (out, opts) => { if (opts && opts.maxOutputLength && out.length > opts.maxOutputLength) { const e = new RangeError('Cannot create a Buffer larger than maxOutputLength'); e.code = 'ERR_BUFFER_TOO_LARGE'; throw e; } return Buffer.from(out); };
export function inflateRawSync(buf, opts) { return capped(_inflate(new Uint8Array(buf)), opts); }
export function deflateRawSync(buf) { return Buffer.from(_deflate(new Uint8Array(buf))); }
export function deflateSync(buf) { return Buffer.from(zlibSync(new Uint8Array(buf))); }
export function inflateSync(buf, opts) { return capped(unzlibSync(new Uint8Array(buf)), opts); }
export default { inflateRawSync, deflateRawSync, deflateSync, inflateSync };
