'use strict';
// Minimal multicast-DNS responder so phones and computers on the same network can open https://suds.local
// without typing an IP address. Answers A queries for the configured names with the host's LAN IPv4 addresses.
const dgram = require('node:dgram');
const os = require('node:os');

const MCAST = '224.0.0.251', PORT = 5353;
let socket = null; let names = [];

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
function buildResponse(id, answers) {
  const header = Buffer.alloc(12); header.writeUInt16BE(id, 0); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(0, 4); header.writeUInt16BE(answers.length, 6);
  const rrs = answers.map(({ name, ip }) => { const rr = Buffer.alloc(10); rr.writeUInt16BE(1, 0); rr.writeUInt16BE(0x8001, 2); rr.writeUInt32BE(120, 4); rr.writeUInt16BE(4, 8); return Buffer.concat([encodeName(name), rr, Buffer.from(ip.split('.').map(Number))]); });
  return Buffer.concat([header, ...rrs]);
}
function answersFor(questions) {
  const ips = lanIPv4(); const out = [];
  for (const q of questions) if ((q.type === 1 || q.type === 255) && names.includes(q.name)) for (const ip of ips) out.push({ name: q.name, ip });
  return out;
}

function start(hostnames) {
  names = [...new Set(hostnames.map(n => (n.endsWith('.local') ? n : n + '.local').toLowerCase()))];
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
      const ann = buildResponse(0, names.flatMap(n => lanIPv4().map(ip => ({ name: n, ip })))); if (ann.length > 12) { try { socket.send(ann, PORT, MCAST); } catch {} }
      console.log(`[suds] mDNS: advertising ${names.join(', ')}`);
    });
  } catch (e) { console.warn('[suds] mDNS disabled:', e.message); socket = null; }
  return names;
}
function stop() { if (socket) { try { socket.close(); } catch {} socket = null; } }
function active() { return !!socket; }

module.exports = { start, stop, active, parseQuestions, buildResponse, answersFor, encodeName, decodeName, names: () => names, lanIPv4 };
