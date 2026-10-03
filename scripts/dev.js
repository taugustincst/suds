'use strict';
// `npm run dev`: the office server in development, restarted when a file changes (node --watch).
// It was `SUDS_ENV=development node ...` in package.json, which only a POSIX shell understands: Windows'
// Command Prompt and PowerShell (where npm runs scripts through cmd.exe) answer "'SUDS_ENV' is not
// recognized". Setting the variable here works the same on Windows, macOS and Linux, with no dependency.
// SUDS_ENV is set even when a .env file says otherwise, as the old command line did.
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--watch', path.join('server', 'index.js'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, SUDS_ENV: 'development' },
});

// Ctrl+C reaches the server directly (the terminal signals the whole process group; on Windows the console
// sends it to every process attached to it), so this wrapper only waits for it to stop. A signal sent to this
// process alone (kill <pid>, a process manager) is passed on — except SIGINT on Windows, where child.kill()
// cannot deliver a Ctrl+C and would end the server without its clean stop.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try {
    process.on(sig, () => {
      if (process.platform === 'win32' && sig !== 'SIGTERM') return;
      try { child.kill(sig); } catch {}
    });
  } catch { /* a signal this platform cannot listen for */ }
}
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
child.on('error', (e) => { console.error(`[suds] could not start the server: ${e.message}`); process.exitCode = 1; });
