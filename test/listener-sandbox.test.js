'use strict';
// Under SUDS Server's systemd sandbox the network interface list cannot be read (os.networkInterfaces() throws
// EAFNOSUPPORT without AF_NETLINK). The installer run on 1.21.0 found that this aborted the listener's start before
// "listening on" and gave 500s on the routes that describe it; the LAN addresses are now "none" instead
// (server/listener.js lanAddresses).
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');

test('the listener starts and describes itself when the interface list cannot be read (systemd sandbox)', async () => {
  process.env.HOST = '0.0.0.0'; process.env.PORT = '0';
  const real = os.networkInterfaces;
  os.networkInterfaces = () => { const e = new Error('A system error occurred: uv_interface_addresses returned Unknown system error 97'); e.code = 'ERR_SYSTEM_ERROR'; throw e; };
  const L = require('../server/listener');
  try {
    assert.deepEqual(L.lanAddresses(), []);
    await L.start((req, res) => res.end('ok'));
    const d = L.describe();
    assert.ok(d, 'the listener is described');
    assert.deepEqual(d.lan, []);
    assert.ok(Array.isArray(d.urls));
  } finally {
    os.networkInterfaces = real;
    await new Promise((r) => L.stop(r));
  }
});
