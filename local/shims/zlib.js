import { inflateSync, deflateSync } from 'fflate';
export function inflateRawSync(buf) { return Buffer.from(inflateSync(new Uint8Array(buf))); }
export function deflateRawSync(buf) { return Buffer.from(deflateSync(new Uint8Array(buf))); }
export default { inflateRawSync, deflateRawSync };
