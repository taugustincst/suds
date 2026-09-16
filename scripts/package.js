'use strict';
// Builds a distributable zip of the current commit (no data, no secrets): suds-v<version>.zip
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const version = require('../package.json').version;
const out = path.resolve(process.argv[2] || `suds-v${version}.zip`);
execFileSync('git', ['archive', '--format=zip', `--prefix=suds-v${version}/`, '-o', out, 'HEAD'], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
console.log(`Wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
