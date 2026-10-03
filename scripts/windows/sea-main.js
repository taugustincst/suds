'use strict';
// The bootstrap of suds.exe: Node.js's single executable application (SEA) main script, injected into a copy of the
// official node.exe by scripts/build-windows.js. It is deliberately tiny and holds no SUDS logic. Inside a SEA,
// `require` reaches only Node's built-in modules, so it finds the app\ folder beside suds.exe and loads the real
// command line from there (app\scripts\windows\cli.js) with Node's ordinary module loader. An update therefore
// replaces app\ and leaves suds.exe alone, unless the Node.js runtime itself changes.
//
// It also runs SUDS's own scripts when suds.exe is started as `suds.exe [--node-flag...] <app\...\script.js> args`:
// that is how the server starts its child processes (the recovery drill's checker, server/dr-drill.js; the sample
// data for `suds try`, scripts/try-local.js), which spawn process.execPath, and process.execPath is suds.exe. Only a
// script inside app\ is run this way: suds.exe is not a general JavaScript runner.
//
// Exported for test/windows-cli.test.js; it does something only when it is the main script of a SEA.
const path = require('node:path');
const fs = require('node:fs');

const CLI = ['scripts', 'windows', 'cli.js'];

/** The app folder for this suds.exe: SUDS_APP_DIR if set, else app\ beside it. null when neither holds SUDS. */
function locateApp(exePath, { env = process.env, exists = fs.existsSync, P = path } = {}) {
  const candidates = [env.SUDS_APP_DIR, P.join(P.dirname(exePath), 'app')].filter(Boolean);
  for (const dir of candidates) {
    if (exists(P.join(dir, 'package.json')) && exists(P.join(dir, ...CLI))) return P.resolve(dir);
  }
  return null;
}

/**
 * `args` (after the exe) as a Node invocation of one of the app's scripts: { file, args } when the first argument that
 * is not a --flag names a .js/.cjs file inside appDir that exists; else null (an ordinary suds command).
 */
function scriptToRun(args, appDir, { exists = fs.existsSync, P = path } = {}) {
  let i = 0;
  while (i < args.length && /^--[a-z]/i.test(args[i]) && !/\.c?js$/i.test(args[i])) i++;
  const a = args[i];
  if (!a || !/\.c?js$/i.test(a)) return null;
  const file = P.resolve(a);
  const rel = P.relative(appDir, file);
  if (!rel || rel.startsWith('..') || P.isAbsolute(rel) || !exists(file)) return null;
  return { file, args: args.slice(i + 1) };
}

/**
 * node:sqlite prints an ExperimentalWarning at every start. `npm start` silences it with --no-warnings=ExperimentalWarning;
 * a SEA cannot be given Node options, so the same warning (that type only) is dropped here.
 */
function quietExperimentalWarnings(proc = process) {
  const emit = proc.emitWarning;
  proc.emitWarning = function emitWarning(warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    if (type === 'ExperimentalWarning' || (warning && warning.name === 'ExperimentalWarning')) return undefined;
    return emit.call(this, warning, ...rest);
  };
}

function main() {
  let sea = false;
  try { sea = require('node:sea').isSea(); } catch { sea = false; }
  if (!sea) return;
  quietExperimentalWarnings();
  const exe = process.execPath;
  const appDir = locateApp(exe);
  if (!appDir) {
    console.error(`SUDS cannot find its app folder: ${path.join(path.dirname(exe), 'app')} is missing or incomplete. Unzip the whole SUDS download again, keeping suds.exe and the app folder together.`);
    process.exitCode = 3; // scripts/windows/cli.js EXIT.BROKEN
    return;
  }
  process.env.SUDS_EXE = exe;
  const Module = require('node:module');
  const args = process.argv.slice(2);
  const script = scriptToRun(args, appDir);
  const file = script ? script.file : path.join(appDir, ...CLI);
  process.argv = [exe, file, ...(script ? script.args : args)];
  // As `node <file>` loads it: the ordinary CommonJS loader, with the file as require.main.
  Module._load(file, null, true);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { locateApp, scriptToRun, quietExperimentalWarnings, CLI };
main();
