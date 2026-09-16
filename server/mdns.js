'use strict';
// Minimal multicast-DNS responder so phones and computers on the same network can open https://suds.local
// without typing an IP address. Answers A queries for the configured names with the host's LAN IPv4 addresses.
const dgram = require('node:dgram');
const os = require('node:os');

const MCAST = '224.0.0.251', PORT = 5353;
let socket = null; let names = []; let service = null; // { port, tls, host }
const SERVICE = '_suds._tcp.local'; const INSTANCE = 'SUDS._suds._tcp.local';

function lanIPv4() { const out = []; for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address); return out; }

function encodeName(name) { const parts = name.replace(/\.$/, '').split('.'); const bufs = parts.map(p => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'ascii')])); return Buffer.concat([...bufs, Buffer.from([0])]); }
function decodeName(msg, off) {
  const labels = []; let jumped = false; let end = off; let guard = 0;
  while (guard++ < 64) {
    const len = msg[off];
    if (len === undefined) break;
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) { const ptr = ((len & 0x3f) << 8) | msg[off + 1]; if (!jumped) end = off + 2; jumped = true; off = ptr; continue; }
    labels.push(msg.toString('ascii', off + 1, off + 1 + len)); off += 1 + len;
  }
  if (!jumped) end = off;
  return { name: labels.join('.'), end };
}
function parseQuestions(msg) {
  if (msg.length < 12) return null;
  const flags = msg.readUInt16BE(2); if (flags & 0x8000) return null; // response, ignore
  const qd = msg.readUInt16BE(4); const qs = []; let off = 12;
  for (let i = 0; i < qd && off < msg.length; i++) { const { name, end } = decodeName(msg, off); if (end + 4 > msg.length) break; qs.push({ name: name.toLowerCase(), type: msg.readUInt16BE(end), unicast: !!(msg.readUInt16BE(end + 2) & 0x8000) }); off = end + 4; }
  return { id: msg.readUInt16BE(0), questions: qs };
}
function rr(name, type, rdata, ttl = 120, flush = true) { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(flush ? 0x8001 : 1, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(rdata.length, 8); return Buffer.concat([encodeName(name), h, rdata]); }
function buildResponse(id, answers) {
  const header = Buffer.alloc(12); header.writeUInt16BE(id, 0); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(0, 4); header.writeUInt16BE(answers.length, 6);
  const rrs = answers.map(a => {
    if (a.ip) return rr(a.name, 1, Buffer.from(a.ip.split('.').map(Number)));
    if (a.ptr) return rr(a.name, 12, encodeName(a.ptr), 4500, false);
    if (a.srv) { const b = Buffer.alloc(6); b.writeUInt16BE(0, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(a.srv.port, 4); return rr(a.name, 33, Buffer.concat([b, encodeName(a.srv.target)])); }
    if (a.txt) return rr(a.name, 16, Buffer.concat(a.txt.map(t => Buffer.concat([Buffer.from([Buffer.byteLength(t)]), Buffer.from(t)]))));
    return Buffer.alloc(0);
  });
  return Buffer.concat([header, ...rrs]);
}
function serviceRecords() {
  if (!service) return [];
  const target = names[0] || 'suds.local';
  return [{ name: SERVICE, ptr: INSTANCE }, { name: INSTANCE, srv: { port: service.port, target } }, { name: INSTANCE, txt: [`tls=${service.tls ? 1 : 0}`, `path=/`, `name=SUDS`, `v=1`] }, ...lanIPv4().map(ip => ({ name: target, ip }))];
}
function answersFor(questions) {
  const ips = lanIPv4(); const out = [];
  for (const q of questions) {
    if ((q.type === 1 || q.type === 255) && names.includes(q.name)) for (const ip of ips) out.push({ name: q.name, ip });
    if (service && (q.type === 12 || q.type === 255) && (q.name === SERVICE || q.name === '_services._dns-sd._udp.local')) out.push(...(q.name === SERVICE ? serviceRecords() : [{ name: '_services._dns-sd._udp.local', ptr: SERVICE }]));
    if (service && (q.type === 33 || q.type === 16 || q.type === 255) && q.name === INSTANCE) out.push(...serviceRecords().slice(1));
  }
  return out;
}

function start(hostnames, svc) {
  names = [...new Set(hostnames.map(n => (n.endsWith('.local') ? n : n + '.local').toLowerCase()))];
  if (svc) service = svc;
  if (socket) return names;
  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (e) => { console.warn('[suds] mDNS disabled:', e.message); try { socket.close(); } catch {} socket = null; });
    socket.on('message', (msg, rinfo) => {
      const p = parseQuestions(msg); if (!p) return;
      const answers = answersFor(p.questions); if (!answers.length) return;
      const res = buildResponse(p.questions.some(q => q.unicast) ? p.id : 0, answers);
      if (p.questions.some(q => q.unicast)) socket.send(res, rinfo.port, rinfo.address); else socket.send(res, PORT, MCAST);
    });
    socket.bind(PORT, () => {
      try { socket.addMembership(MCAST); socket.setMulticastTTL(255); socket.setMulticastLoopback(true); } catch (e) { console.warn('[suds] mDNS multicast unavailable:', e.message); }
      // unsolicited announcement
      const ann = buildResponse(0, [...names.flatMap(n => lanIPv4().map(ip => ({ name: n, ip }))), ...serviceRecords()]); if (ann.length > 12) { try { socket.send(ann, PORT, MCAST); } catch {} }
      console.log(`[suds] mDNS: advertising ${names.join(', ')}`);
    });
  } catch (e) { console.warn('[suds] mDNS disabled:', e.message); socket = null; }
  return names;
}
function stop() { if (socket) { try { socket.close(); } catch {} socket = null; } }
function active() { return !!socket; }

module.exports = { start, stop, active, serviceRecords, SERVICE, INSTANCE, parseQuestions, buildResponse, answersFor, encodeName, decodeName, names: () => names, lanIPv4 };
