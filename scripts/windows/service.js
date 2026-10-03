'use strict';
// The SUDS Windows service (docs/WINDOWS-SERVER.md, "Run it as a Windows service"): the WinSW configuration
// `suds service install` writes, and the Windows commands the `suds service` subcommands run. WinSW (the bundled
// suds-service.exe, MIT licence) is the service wrapper: the Service Control Manager starts it, it starts
// `suds.exe start --service`, restarts it when it fails, and stops it with Ctrl+C, which reaches the server's own
// clean stop (server/index.js). It writes the service's start, stop and failures to the Windows Event Log
// (Application log, source SUDS).
//
// The service runs as its own virtual account, NT SERVICE\SUDS: not LocalSystem, no password to manage, and the
// data folder's permissions name it alone (with Administrators and SYSTEM). Everything Windows-specific goes through
// `exec` (spawnSync by default), so the logic here is tested on any system (test/windows-cli.test.js).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVICE_ID = 'SUDS';
const SERVICE_NAME = 'SUDS';
const ACCOUNT_DOMAIN = 'NT SERVICE';
const ACCOUNT_USER = SERVICE_ID; // a virtual account is named after its service
const ACCOUNT = `${ACCOUNT_DOMAIN}\\${ACCOUNT_USER}`;
const EVENT_SOURCE = 'SUDS';
const WRAPPER_EXE = 'suds-service.exe';
const WRAPPER_XML = 'suds-service.xml';
// Failure actions: restart after 10 s, then 30 s, then every 60 s; the count resets after an hour of running.
const RESTARTS = ['10 sec', '30 sec', '60 sec'];
const RESET_FAILURE = '1 hour';
// The server's clean stop closes the listener (at most 3 s), flushes the audit counters, closes the database and
// flushes the log. 30 s is ample; past it WinSW ends the process.
const STOP_TIMEOUT = '30 sec';
// WinSW's own logs (the wrapper's, and anything the server printed to the console) roll at 10 MB, 8 kept.
const WRAPPER_LOG_KB = 10240;
const WRAPPER_LOG_KEEP = 8;
// Windows integrity levels: High (an elevated administrator) and System.
const ELEVATED_SIDS = ['S-1-16-12288', 'S-1-16-16384'];
// Well-known SIDs, so the permissions do not depend on the language Windows is installed in.
const SID_ADMINISTRATORS = '*S-1-5-32-544';
const SID_SYSTEM = '*S-1-5-18';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Where WinSW writes its logs: <data>\logs\service (the server's own logs are <data>\logs). */
function wrapperLogDir(dataDir) { return path.win32.join(dataDir, 'logs', 'service'); }

/**
 * The WinSW configuration (suds-service.xml beside suds-service.exe). dataDir: the data folder, as Windows writes
 * it (an environment variable such as %ProgramData% is expanded by WinSW).
 */
function serviceXml({ dataDir, version = '' }) {
  if (!dataDir || /["\r\n]/.test(dataDir)) throw new Error(`The data folder ${JSON.stringify(dataDir)} cannot be used for the service`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Written by "suds service install" (scripts/windows/service.js). Run that again, from an elevated prompt,',
    '     rather than editing this file: it is read when the service is installed and when it starts. -->',
    '<service>',
    `  <id>${SERVICE_ID}</id>`,
    `  <name>${SERVICE_NAME}</name>`,
    `  <description>${xml(`SUDS office server${version ? ` ${version}` : ''} (SUD Navigator Services Tracker). Data folder: ${dataDir}. Manage it with suds.exe in the same folder (suds help).`)}</description>`,
    '  <executable>%BASE%\\suds.exe</executable>',
    `  <arguments>start --service --data "${xml(dataDir)}"</arguments>`,
    `  <workingdirectory>${xml(dataDir)}</workingdirectory>`,
    '  <startmode>Automatic</startmode>',
    '  <delayedAutoStart>true</delayedAutoStart>',
    '  <serviceaccount>',
    `    <domain>${ACCOUNT_DOMAIN}</domain>`,
    `    <user>${ACCOUNT_USER}</user>`,
    '  </serviceaccount>',
    ...RESTARTS.map((d) => `  <onfailure action="restart" delay="${d}"/>`),
    `  <resetfailure>${RESET_FAILURE}</resetfailure>`,
    `  <stoptimeout>${STOP_TIMEOUT}</stoptimeout>`,
    `  <logpath>${xml(wrapperLogDir(dataDir))}</logpath>`,
    '  <log mode="roll-by-size">',
    `    <sizeThreshold>${WRAPPER_LOG_KB}</sizeThreshold>`,
    `    <keepFiles>${WRAPPER_LOG_KEEP}</keepFiles>`,
    '  </log>',
    '  <env name="SUDS_ENV" value="production"/>',
    '</service>',
    '',
  ].join('\r\n');
}

function defaultExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** Whether this process runs elevated (an administrator's "Run as administrator" prompt, or SYSTEM). */
function isElevated(exec = defaultExec) {
  const r = exec('whoami', ['/groups']);
  return r.status === 0 && ELEVATED_SIDS.some((s) => r.stdout.includes(s));
}

const STATES = { 1: 'stopped', 2: 'starting', 3: 'stopping', 4: 'running', 5: 'resuming', 6: 'pausing', 7: 'paused' };

/** `sc.exe query` output → { installed, state }. */
function parseQuery(r) {
  if (r.status === 1060 || /1060|does not exist/i.test(r.stdout + r.stderr)) return { installed: false, state: 'not installed' };
  const m = /STATE\s*:\s*(\d+)/.exec(r.stdout);
  if (r.status !== 0 || !m) return { installed: null, state: 'unknown', error: (r.stderr || r.stdout || (r.error && r.error.message) || '').trim().split(/\r?\n/)[0] || `sc.exe exited ${r.status}` };
  return { installed: true, state: STATES[m[1]] || `state ${m[1]}` };
}

/** `sc.exe qc` output → { account, startType, command }. */
function parseConfig(r) {
  if (r.status !== 0) return {};
  const field = (name) => { const m = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, 'm').exec(r.stdout); return m ? m[1].trim() : null; };
  const start = field('START_TYPE');
  return {
    account: field('SERVICE_START_NAME'),
    startType: start ? (/DELAYED/i.test(start) ? 'automatic (delayed start)' : /AUTO/i.test(start) ? 'automatic' : /DEMAND/i.test(start) ? 'manual' : /DISABLED/i.test(start) ? 'disabled' : start) : null,
    command: field('BINARY_PATH_NAME'),
  };
}

function query(exec = defaultExec) {
  const q = parseQuery(exec('sc.exe', ['query', SERVICE_ID]));
  if (q.installed) Object.assign(q, parseConfig(exec('sc.exe', ['qc', SERVICE_ID])));
  return q;
}

/** Wait (polling sc.exe) until the service reaches `want`; resolves with the last state seen. */
async function waitFor(want, { exec = defaultExec, timeoutMs = 90000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + timeoutMs; let q;
  for (;;) {
    q = parseQuery(exec('sc.exe', ['query', SERVICE_ID]));
    if (q.state === want || Date.now() > until || q.installed === false) return q;
    await sleep(1000);
  }
}

/**
 * The commands that set the folder permissions: the data folder for Administrators, SYSTEM and the service account
 * only (nothing inherited from %ProgramData%, which lets every user read), and read access to the program folder.
 */
function permissionCommands({ dataDir, installDir }) {
  return [
    ['icacls', [dataDir, '/inheritance:r', '/grant:r', `${SID_ADMINISTRATORS}:(OI)(CI)F`, `${SID_SYSTEM}:(OI)(CI)F`, `${ACCOUNT}:(OI)(CI)M`]],
    ['icacls', [installDir, '/grant', `${ACCOUNT}:(OI)(CI)RX`]],
  ];
}

// The Application log source, registered once by an administrator so both WinSW and SUDS itself can write to it
// as the service account (which may not create a source). Windows PowerShell 5.1 is part of every supported Windows.
const REGISTER_SOURCE = `if (-not [System.Diagnostics.EventLog]::SourceExists('${EVENT_SOURCE}')) { [System.Diagnostics.EventLog]::CreateEventSource('${EVENT_SOURCE}', 'Application') }`;

/** Write one entry to the Application log (source SUDS). The message comes through the environment, never a command line. */
function writeEvent(message, { type = 'Error', id = 1001, exec = defaultExec } = {}) {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Write-EventLog -LogName Application -Source '${EVENT_SOURCE}' -EventId ${Number(id)} -EntryType ${type === 'Warning' ? 'Warning' : type === 'Information' ? 'Information' : 'Error'} -Message $env:SUDS_EVENT_MESSAGE`],
  { env: { ...process.env, SUDS_EVENT_MESSAGE: String(message).slice(0, 2000) }, timeout: 20000 });
}

module.exports = {
  SERVICE_ID, SERVICE_NAME, ACCOUNT, ACCOUNT_DOMAIN, ACCOUNT_USER, EVENT_SOURCE, WRAPPER_EXE, WRAPPER_XML, RESTARTS, RESET_FAILURE,
  STOP_TIMEOUT, WRAPPER_LOG_KB, WRAPPER_LOG_KEEP, REGISTER_SOURCE,
  serviceXml, wrapperLogDir, isElevated, parseQuery, parseConfig, query, waitFor, permissionCommands, writeEvent, defaultExec,
  writeXml: (installDir, opts) => fs.writeFileSync(path.join(installDir, WRAPPER_XML), serviceXml(opts)),
};
