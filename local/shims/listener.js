export function describe() { return { scheme: 'local', host: 'local', port: 0, tls: false, urls: [], lan: [], hostname: 'this-device', mdns: false, friendly: null }; }
export function lanAddresses() { return []; }
export async function relisten() { throw new Error('Not available in local mode'); }
export default { describe, lanAddresses, relisten, start() {}, stop() {} };
