'use strict';
// Prints the local URL SUDS will listen on (used by the launchers to open the browser).
const fs = require('node:fs'); const path = require('node:path');
let c = {};
try { c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'server.json'), 'utf8')); } catch {}
const scheme = c.tls && c.tls !== 'none' ? 'https' : 'http';
process.stdout.write(`${scheme}://localhost:${process.env.PORT || c.port || 8080}/`);
