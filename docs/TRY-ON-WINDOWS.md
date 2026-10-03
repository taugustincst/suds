# Try SUDS on Windows 11 (for testing)

This runs the SUDS office server on your own Windows PC, with **fictional sample data**, so you can test it in
your browser. It takes about ten minutes, most of which is installing Node.js. The same steps work on macOS
and Linux, using a terminal.

**This is for testing on your own computer, not for real client records.** The licence ([LICENSE](../LICENSE), section 2) allows evaluation for up to 90 days with fictional data only. The sample clients and staff are
made up. This copy keeps its encryption keys in the same folder as its database, and it does no backups. It runs
over plain HTTP and only this computer can open it. For real records, install the office server as
[INSTALL.md](INSTALL.md) and [DEPLOYMENT.md](DEPLOYMENT.md) describe: production settings, HTTPS, BitLocker on
the computer that holds the data, and scheduled backups.

## The easiest way: `suds try` (nothing to install)

Each release has a Windows build of SUDS, `suds-<version>-windows-x64.zip`, with Node.js inside it
([WINDOWS-SERVER.md](WINDOWS-SERVER.md)).

1. Download `suds-<version>-windows-x64.zip` from the SUDS releases page on GitHub. Right-click it, choose
   **Properties**, tick **Unblock** if it is shown, then **Extract All…**.
2. Open the extracted folder (the one with `suds.exe` in it). Right-click an empty part of it and choose
   **Open in Terminal**. Then type:
   ```powershell
   .\suds try
   ```
3. It prints the same banner as below: the address, the sample accounts and their password. Open the address in
   your browser. Press **Ctrl+C** in the window to stop it. `.\suds try --reset` starts over, and
   `.\suds try --port 8081` uses another port.

The test copy keeps its data in a `data-try` folder beside `suds.exe` (or in `%LOCALAPPDATA%\SUDS\data-try` when
that folder cannot be written), apart from any real install. If Windows SmartScreen says *Windows protected your
PC*, the build is not code-signed: choose **More info → Run anyway**. Do not double-click `suds.exe` for testing:
that starts the real server, with no sample data.

If you have Node.js already, or want to run SUDS from its source code, use `npm run try` instead, as the rest of
this page describes.

## 1. Install Node.js 22 LTS or later

Node.js is the only thing to install. SUDS needs version **22.13 or later**.

* In PowerShell or Terminal: `winget install OpenJS.NodeJS.LTS`
* Or download the **LTS** Windows installer from https://nodejs.org and accept the defaults.

Then open a **new** PowerShell window and check the version:

```powershell
node -v
```

It should print `v22.13.0` or a later version. If it prints an older one, install the LTS again. If it says `node` is not recognized, close the window and open a new one.

## 2. Download SUDS

* On the SUDS GitHub page, click **Code → Download ZIP**. You can also download the `.zip` from a release.
* Find the ZIP in Downloads, right-click it and choose **Extract All…**, then **Extract**.

Use the extracted folder. Do not open the files from inside the ZIP, because Windows only shows them there and
SUDS cannot run from it. The folder you want is the one that contains `package.json`, for example
`Downloads\suds-main\suds-main`.

## 3. Start SUDS

Open that folder in File Explorer. Right-click an empty part of the folder (or Shift+right-click) and choose
**Open in Terminal**. In the PowerShell window that opens, type:

```powershell
npm run try
```

The first start takes a few seconds to create the sample data. Then it prints something like this:

```text
  ================================================================
  SUDS is running on this computer, for testing.
  ================================================================

  Open:        http://localhost:8080   (in Edge, Chrome or Firefox)

  Sign in with a sample account. Password for all of them: Navigator2026!!
    mrivera    navigator
    dchen      navigator
    kpatel     clinician
    jwalker    supervisor
    afinance   finance
    rreader    read-only
    guest      administrator
  ...
  Stop:        press Ctrl+C in this window
  Start again: npm run try
  Start over:  npm run try -- --reset   (deletes only the data-try folder, then makes fresh sample data)
```

You do **not** need `npm install`. SUDS uses only what comes with Node.js. If you run `npm install` anyway, it
does no harm. It downloads the tools used to build SUDS into a `node_modules` folder, which the server never
loads. It needs an internet connection.

## 4. Open it in your browser

Open **http://localhost:8080** (or the address printed in the window) in Edge or Chrome. Sign in with one of the
sample accounts. The password is printed above them (`Navigator2026!!`).

* `mrivera` shows a navigator's day. `jwalker` (supervisor) and `kpatel` (clinician) show review and sign-off.
  `guest` is the administrator, with Settings and Users & permissions.
* Leave the PowerShell window open while you test. It shows what the server is doing.
* Windows Defender Firewall should not ask anything. SUDS only listens on this computer (127.0.0.1), so phones
  and other computers cannot reach it. If a firewall prompt appears anyway, you can click **Cancel**.

## 5. Stop, start again, start over

* **Stop:** click the PowerShell window and press **Ctrl+C**. If Windows asks `Terminate batch job (Y/N)?`, type
  `Y`. Closing the window also stops SUDS.
* **Start again**, with everything you changed: `npm run try`
* **Start over** with fresh sample data: `npm run try -- --reset`. This deletes only the `data-try` folder inside
  the SUDS folder. It refuses to delete a folder it did not create, or one that SUDS is still using.
* **Another port**, if 8080 is in use (SUDS tells you when it is): `npm run try -- --port 8081`, then open
  http://localhost:8081

The test data is in the `data-try` folder inside the SUDS folder. To remove SUDS completely, stop it and delete
the SUDS folder.

## If something goes wrong

* **`npm.ps1 cannot be loaded because running scripts is disabled on this system`**: PowerShell is blocking npm's
  own script. Type `npm.cmd run try` instead, or `node scripts/try-local.js`. Both do the same thing.
* **`SUDS needs Node.js 22.13 or later`**: install the LTS version (step 1), then open a new window.
* **`Port 8080 is already in use`**: another program, or SUDS in another window, is using it. Close it, or use
  `npm run try -- --port 8081`.
* **`SUDS is already running from …`**: it is already running in another window. Use that window's address, or
  stop it there with Ctrl+C.
* **After three days, each account asks you to set up two-step verification.** A real office server does the
  same. Set it up with any authenticator app, or start over with `npm run try -- --reset`.

## What it is, for the technically minded

`npm run try` runs `scripts/try-local.js`. It starts the office server in this one Node process, with these
settings:

* in **development** mode (`SUDS_ENV=development`), with no TLS. The keys are generated into the data folder, the
  same way `npm run dev` does;
* bound to `127.0.0.1` only, on port 8080 unless you give `--port`;
* with its own data folder, `data-try/` (gitignored). The folder is marked with a `.suds-try` file, and a folder
  without that file is never used or deleted;
* with the environment and any `.env` file set aside, so a real install's keys, database path or audit-anchor
  folder cannot be picked up;
* seeded once by `scripts/seed.js`, the same fictional data as `npm run seed`. That script refuses a production
  database.

Local mode (`/?local=1`) is off, as it is on any office server by default. The scripts testers use also work on
Windows: `npm run dev` no longer needs a POSIX shell, and `npm run seed`, `create-admin`, `reset-admin` and
`backup` are plain `node` commands. CI runs this whole path on `windows-latest` on every push
(`.github/workflows/ci.yml`, *Windows: npm run try*).
