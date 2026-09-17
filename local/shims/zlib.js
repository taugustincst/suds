import { inflateSync as _inflate, deflateSync as _deflate, zlibSync, unzlibSync } from 'fflate';
export function inflateRawSync(buf) { return Buffer.from(_inflate(new Uint8Array(buf))); }
export function deflateRawSync(buf) { return Buffer.from(_deflate(new Uint8Array(buf))); }
export function deflateSync(buf) { return Buffer.from(zlibSync(new Uint8Array(buf))); }
export function inflateSync(buf) { return Buffer.from(unzlibSync(new Uint8Array(buf))); }
export default { inflateRawSync, deflateRawSync, deflateSync, inflateSync };
