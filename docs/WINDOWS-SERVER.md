# SUDS on a Windows server (for county IT)

SUDS ships a Windows build of the office server: one zip with one program, `suds.exe`, which runs the server,
installs it as a Windows service and manages it. Nothing else needs installing. Node.js is inside `suds.exe`,
and the server has no npm packages. This is the same office server as the Linux install (DEPLOYMENT.md), with
the same data, keys, backups and audit log. It is the system of record for its programme (PLATFORM.md).

The Windows build exists by an owner decision of 2026-10-03, to make SUDS simpler for county IT
(PLATFORM.md, *Windows server executable*). The old Android app and desktop launchers are still removed.

To **try** SUDS with made-up data on any Windows PC, see [TRY-ON-WINDOWS.md](TRY-ON-WINDOWS.md).

## What is in the zip

`suds-<version>-windows-x64.zip` is on each GitHub Release, with `suds-<version>-windows-x64.zip.sha256` beside
it. Every CI run also builds one, as the run's artifact `suds-windows-x64`.

| File | What it is |
| --- | --- |
| `suds.exe` | The SUDS server and its command line. It is the official `node.exe` of the pinned Node.js 22 release, with a small start-up script added (Node's *single executable applications*). |
| `app\` | SUDS itself: `server\`, `public\` (the web app), the `scripts\` the commands run, `package.json`, `LICENSE` (SUDS is proprietary: production use needs a signed licence agreement) and `NOTICE` (third-party licences). An update replaces this folder. |
| `suds-service.exe` | The Windows service wrapper: [WinSW](https://github.com/winsw/winsw) v2.12.0 (MIT licence), unchanged. |
| `suds-service.xml` | The wrapper's settings. `suds service install` writes it again. |
| `README-WINDOWS.txt` | A one-page quick start. |
| `THIRD-PARTY-NOTICES.txt` | The licences of Node.js (with the libraries built into it) and WinSW. |

Check the download before you unzip it:

```powershell
(Get-FileHash .\suds-1.24.0-windows-x64.zip -Algorithm SHA256).Hash.ToLower()
Get-Content .\suds-1.24.0-windows-x64.zip.sha256
```

The two hashes must be the same. Release builds are signed with Authenticode when the project has a
code-signing certificate. Without one, Windows SmartScreen warns about an unknown publisher (see *Troubleshooting*).

## System requirements

* Windows Server 2019 or 2022, or Windows 10/11 (64-bit, x64). ARM is not built.
* 2 CPU cores, 4 GB RAM, and 10 GB free disk for the data folder (more for backups and documents).
* An NTFS drive for `C:\ProgramData\SUDS`, encrypted with **BitLocker** (see below).
* Windows PowerShell 5.1 (part of Windows) for the Event Log source. `icacls` and `sc.exe` (also part of Windows).
* Staff need a current Edge, Chrome, Firefox or Safari.

## Install as a Windows service in five steps

1. **Unzip** the whole zip to `C:\Program Files\SUDS` (or `C:\SUDS`). Keep `suds.exe` and `app\` together.
   In Explorer, right-click the zip, choose **Properties**, tick **Unblock** if it is shown, then **Extract All**.
2. **Open an elevated terminal.** Right-click Start, choose **Terminal (Admin)**, then:
   ```powershell
   cd "C:\Program Files\SUDS"
   ```
3. **Install the service:**
   ```powershell
   .\suds service install
   ```
   This writes `suds-service.xml`, installs the service **SUDS** (automatic, delayed start, restarted if it
   fails), running as the virtual account `NT SERVICE\SUDS`, creates `C:\ProgramData\SUDS` and sets its
   permissions, and registers the Event Log source `SUDS`.
4. **Start it:**
   ```powershell
   .\suds service start
   ```
   It waits until SUDS answers and prints the address, `http://localhost:8080`.
5. **Finish setup.** Open that address **in a browser on this server** and complete the setup wizard. The
   wizard creates the first administrator. It asks whether other computers may connect, and it can create a
   self-signed HTTPS certificate. Then it moves SUDS to the address staff will use (see *HTTPS* and
   *Firewall*).

Until setup is finished, SUDS listens on `127.0.0.1` only. Nothing on the network can reach the wizard.

Then, before real records go in:

* Download the **key backup** (**Settings → System & backups → Download key backup**, or copy
  `C:\ProgramData\SUDS\keys.json`) and store it apart from the server and its backups. Without it, the database and every backup are unreadable.
* Set `AUDIT_ANCHOR_DIR` to write-once storage outside the data folder (see *Settings*). Until you do,
  `/api/health` and `suds status` report a warning.
* Turn on scheduled backups with an offsite folder (see *Backups*). The wizard turns on 4-hourly local backups.
* Set `WEBAUTHN_RP_ID` to the server's name if staff will use fingerprint sign-in (FINGERPRINT.md).
* Run `suds status`.

## Settings

The server reads its settings from three places. Environment variables come first, then
`C:\ProgramData\SUDS\.env`, then the wizard's `C:\ProgramData\SUDS\server.json`. The service runs with the data
folder as its working directory, so put service settings in **`C:\ProgramData\SUDS\.env`**, one `NAME=value` per
line. Every variable in DEPLOYMENT.md works the same way. Then restart: `suds service restart`.

```ini
# C:\ProgramData\SUDS\.env
TLS_CERT_PATH=C:\ProgramData\SUDS\certs\county.crt
TLS_KEY_PATH=C:\ProgramData\SUDS\certs\county.key
AUDIT_ANCHOR_DIR=\\worm-nas\suds-anchors
WEBAUTHN_RP_ID=suds.county.gov
```

Keep this file to Administrators. The data folder's permissions already do that.

## HTTPS

Use one of the existing TLS options (DEPLOYMENT.md, *1. Configuration*: `TLS_CERT_PATH`, `TLS_KEY_PATH`, `TRUST_PROXY`):

* **The county's certificate, in SUDS.** Save the certificate (full chain) and its private key as PEM files in
  `C:\ProgramData\SUDS\certs\`. Set `TLS_CERT_PATH` and `TLS_KEY_PATH` in `.env` and restart. SUDS serves
  HTTPS itself, TLS 1.2 or later. A `.pfx` from the Windows certificate store converts with
  `openssl pkcs12 -in county.pfx -out county.crt -clcerts -nokeys` and `... -nocerts -nodes -out county.key`.
  OpenSSL comes with Git for Windows.
* **The wizard's self-signed certificate.** This is fine for a pilot. Each device must trust it once
  (INSTALL.md, *The certificate: what the wizard makes, and what a county should use instead*).
* **A reverse proxy** (IIS with ARR, or Caddy) in front of `127.0.0.1:8080`. It terminates TLS with the county
  certificate. Set `TRUST_PROXY=1` so audit entries and rate limits see the client's address. The proxy must
  append to `X-Forwarded-For`, as ARR does.

Port: the wizard uses 443 for HTTPS (8443 if 443 is taken) or 8080 for HTTP. `PORT=` in `.env` fixes it.

## Firewall

Other computers reach SUDS only after you add an inbound rule for its port. In an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "SUDS (HTTPS 443)" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Domain,Private -Program "C:\Program Files\SUDS\suds.exe"
```

Use the port `suds status` shows. Leave out `Public`. Limit `-RemoteAddress` to the office subnets if you can.
SUDS on 127.0.0.1, behind a proxy on the same server, needs no rule for SUDS itself.

## Where things live

| What | Where |
| --- | --- |
| The program | `C:\Program Files\SUDS` (`suds.exe`, `app\`, `suds-service.exe`, `suds-service.xml`) |
| The data folder | `C:\ProgramData\SUDS`. A `data` folder beside `suds.exe` is used instead if it exists (a portable install). `--data <folder>` on any command, or `SUDS_DATA_DIR`, chooses another. |
| Database | `C:\ProgramData\SUDS\suds.db` (encrypted fields; SQLite WAL files beside it) |
| Keys | `C:\ProgramData\SUDS\keys.json`, made on the first start, exactly as on Linux. Or set them in the environment or `.env` (`SUDS_ENCRYPTION_KEY`, `SUDS_INDEX_KEY`, `SUDS_SIGNING_KEY`, or the `*_FILE` forms). |
| Settings | `C:\ProgramData\SUDS\server.json` (the wizard) and `.env` (yours) |
| Server logs | `C:\ProgramData\SUDS\logs\suds-YYYY-MM-DD.log` |
| Service wrapper logs | `C:\ProgramData\SUDS\logs\service\` (`suds-service.wrapper.log`, `.out.log`, `.err.log`) |
| Backups | `C:\ProgramData\SUDS\backups\` and the offsite folder you configure |
| Audit anchors | `C:\ProgramData\SUDS\audit-anchors\` until you set `AUDIT_ANCHOR_DIR` |
| First administrator's temporary password | `C:\ProgramData\SUDS\first-admin-password.txt`, deleted once it is changed. You do not need it if you use the wizard. |
| The last update check | `C:\ProgramData\SUDS\update-check.json` |

## The service account and folder permissions

The service runs as **`NT SERVICE\SUDS`**, a virtual account Windows creates for the service. It has no password
and cannot sign in interactively. It is not LocalSystem. `suds service install` sets:

* `C:\ProgramData\SUDS`: inheritance removed. **Full control** for Administrators and SYSTEM, **Modify** for
  `NT SERVICE\SUDS`, and nobody else. Users can no longer read it, as they could under `%ProgramData%`.
* `C:\Program Files\SUDS`: **Read & execute** for `NT SERVICE\SUDS`, added to the folder's usual permissions.

The same rule as on Linux applies: the data folder holds PHI and the keys to it. So `suds backup`, `suds logs`,
`suds status` (for the backup details) and the other commands that open it need an **elevated** terminal while
the service owns it.

Network shares (the offsite backup folder, `AUDIT_ANCHOR_DIR`): a virtual account reaches the network as the
computer account, `DOMAIN\SERVERNAME$`. Grant that account write access on the share, and write-only for the
anchor share where the storage allows. Use a UNC path (`\\nas\suds-backups`), not a mapped drive letter, which
the service does not see.

## BitLocker

Turn on BitLocker for the drive holding `C:\ProgramData\SUDS` and for any drive with backups. On Windows Server,
add the feature first (`Install-WindowsFeature BitLocker -Restart`), then
`Enable-BitLocker -MountPoint C: -EncryptionMethod XtsAes256 -TpmProtector`. Escrow the recovery key with the
county (Active Directory or Entra ID). SUDS encrypts the PHI columns itself, but the database file, the logs and
the key file are on that disk, so full-disk encryption is required (docs/HIPAA.md).

## Backups and the offsite copy

* **Scheduled:** Administration → **Settings → Scheduled backups**. Set the interval (the wizard sets 4 hours) and an
  **offsite directory**, a UNC path the service account can write to (see above). The folder must exist: SUDS
  never creates it. Results show under **System & backups**, in `suds status` (*Last backup*) and in `/api/health`.
* **Now:** `suds backup` in an elevated terminal writes an encrypted backup to `C:\ProgramData\SUDS\backups`, or to a
  folder you name: `suds backup D:\suds-backups`. This works while the service runs.
* **Prove they restore:** `suds dr-drill` restores the newest backup into a temporary folder and checks it,
  with a signed report. Run it monthly. `suds dr-drill --keys-file E:\keys.json` also proves the escrowed key
  copy works.
* **Restore:** stop the service (`suds service stop`), then `suds backup --restore-in-place <file.enc>`, then
  `suds service start`. security/BACKUP-AND-DR.md has the full procedure.

Backups are encrypted with a key derived from `SUDS_ENCRYPTION_KEY`. Keep `keys.json` apart from them.

## Logs, monitoring and the Event Log

* **Server logs:** `suds logs` shows the last 50 lines, `--lines N` more, `--follow` new lines as they come, and
  `--errors` only errors, from every log file, with the wrapper's error output. One file a day,
  `logs\suds-YYYY-MM-DD.log` (named by the UTC date). A file over **8 MB** is rolled aside
  (`.log.<time>.old`). Files older than **30 days** are deleted by the hourly housekeeping. These limits are fixed
  in `server/log.js`. `LOG_FORMAT=json` writes one JSON object per line for a log collector. Log lines never
  carry client information (CLAUDE.md, *PHI*).
* **Service wrapper logs:** `logs\service\`. WinSW's own log and whatever the server printed, rolled by size:
  **10 MB** a file, **8** kept (`suds-service.xml`, `<log mode="roll-by-size">`). `suds logs --service` shows them.
  A temporary password the server prints on its first start is replaced by a note before it reaches these files.
* **Windows Event Log:** **Event Viewer → Windows Logs → Application**, source **SUDS**. WinSW records the
  service's start and stop and its own errors there. SUDS also writes
  an **Error, event ID 1001** when the server stops because of an error while running as the service. The entry
  gives no detail beyond where to look (`suds logs --errors`). County monitoring (SCOM, Splunk, Windows Event
  Forwarding) can alert on `Source=SUDS, Level=Error`. The service's Service Control Manager events (7031, 7034:
  *terminated unexpectedly*) are in **System**, source *Service Control Manager*.
* **Health:** `suds status --json` gives the version, the service's state and account, health, port, folders,
  last backup, disk space and the last update check, for a monitoring script. It exits **0** when SUDS answers
  and reports itself healthy, and **1** otherwise. It goes nowhere but this computer.
  `GET /api/health/live` (is it up) and `GET /api/health` (warnings, 503 when someone must act) work as on Linux
  (DEPLOYMENT.md, *Monitoring and logs*).

## Updates

* `suds update --check` asks the release feed for the newest version. The feed is `UPDATE_FEED_URL` if set (a county
  mirror), otherwise GitHub's releases of SUDS. This is the only command that goes to the internet, and only when
  you run it. `suds status` shows the answer.
* To install a release: download `suds-<version>-windows-x64.zip` **and** its `.sha256` file into one folder, then
  in an elevated terminal:
  ```powershell
  .\suds update --from C:\Users\me\Downloads\suds-1.25.0-windows-x64.zip
  ```
  It checks the zip against the `.sha256` and takes a backup. Then it stops the service, replaces `app\` (the old
  one is kept as `app.previous`) and `suds.exe` (the old one becomes `suds.exe.old`), and starts the service
  again. An older release is refused, because a migrated database may not open in it.
* By hand: `suds service stop`, take a backup, replace `app\` (and `suds.exe` if the release notes say the Node.js
  runtime changed) with the new zip's, then `suds service start`.
* **Roll back:** `suds service stop`. Rename `app` to `app.failed` and `app.previous` to `app` (and
  `suds.exe.old` to `suds.exe`). Then `suds service start`. If the new release migrated the database, restore the
  backup the update took instead (*Backups*).

Read the release notes (CHANGELOG.md) before each update. They say when a release changes the database.

## Uninstall

```powershell
.\suds service stop
.\suds service uninstall
```

This removes the service and keeps `C:\ProgramData\SUDS`. Back the folder up (with `keys.json` kept apart), then
delete it and `C:\Program Files\SUDS` if SUDS is gone for good. Records are kept under the county's retention
rules. The firewall rule and the Event Log source `SUDS` stay until you remove them
(`Remove-NetFirewallRule -DisplayName "SUDS*"`).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The service will not start | Run `suds logs --errors`. Then Event Viewer → Windows Logs → **Application** (source SUDS) and **System** (Service Control Manager). A missing or wrong `keys.json` for an existing database is refused on purpose: restore the key backup. |
| *Port 8080 is already in use* | Another program has the port. `Get-NetTCPConnection -LocalPort 8080 \| Select OwningProcess` shows which one. Stop it, or set `PORT=` in `.env` and restart. |
| *SUDS is already running* | Another copy runs against the same data folder (the service, say). Use `suds open`, or stop it first: `suds service stop`. |
| *needs an administrator* (exit code 4) | Open **Terminal (Admin)** and run the command again. |
| SmartScreen: *Windows protected your PC* | The build is not code-signed. Check the SHA-256 (above), then choose **More info → Run anyway**, or unblock the zip before extracting it. Signed release builds do not show this. |
| *cannot find its app folder* (exit code 3) | `suds.exe` was copied without `app\`. Unzip the whole download again. |
| Staff cannot connect from their PCs | Check that the wizard opened SUDS to the network (`suds status` shows the host). Check the firewall rule and the port. With a self-signed certificate, each device must trust it. |
| `suds status` shows *Health: NOT OK* | The warning under it says what to fix (anchors, backups, certificate, disk space). |
| `suds compliance-check` exits 5 | The host compliance check is for Linux servers. The in-app checks still apply: **Settings → Security status** and **Settings → Compliance**. On Windows, use the hardening checklist below. |

## Hardening checklist (Windows)

* BitLocker on the data and backup drives, with the recovery key escrowed.
* The data folder's permissions as `suds service install` set them (`icacls C:\ProgramData\SUDS`).
* HTTPS with the county certificate, or a TLS proxy, and the inbound firewall rule limited to office subnets.
* `AUDIT_ANCHOR_DIR` on write-once storage. Scheduled backups with an offsite folder. A monthly `suds dr-drill`.
* Windows Update on. Updates of SUDS through `suds update --check` and the release notes.
* Antivirus may scan `C:\ProgramData\SUDS`. If it slows the database, exclude `suds.db`, `suds.db-wal` and
  `suds.db-shm` only, with the county security team's agreement.
* **Settings → Security status** shows no problems.

## Command reference

Run `suds help`, or `suds <command> --help`. Commands that change the service, and `suds update --from`, need an
elevated terminal.

| Command | What it does |
| --- | --- |
| `suds` (or double-click `suds.exe`) | Start SUDS in this window and open the browser: the setup wizard on a first run, the sign-in page afterwards. It prints the address, the data folder and the log file. Ctrl+C stops it cleanly. If SUDS is already running, it opens the browser on it. |
| `suds start` (`suds serve`) | The same without opening a browser. `--port <n>`, `--data <folder>`. The service runs `suds start --service`. |
| `suds open` | Open SUDS in the default browser. |
| `suds try [--reset] [--port <n>] [--data <folder>]` | A test copy with fictional sample data, on 127.0.0.1 only, in `data-try` beside `suds.exe` (TRY-ON-WINDOWS.md). Never for real records. |
| `suds status [--json]` | Version, service (installed, state, account, start type), health, address and port, data folder, log file, last backup and its result, disk free, and the last update check. |
| `suds service install` | Install the service SUDS as `NT SERVICE\SUDS`: automatic (delayed) start, restart on failure (10 s, 30 s, then every 60 s; the count resets after an hour), 30 s to stop cleanly. Also sets the folder permissions and the Event Log source. |
| `suds service start` / `stop` / `restart` | Start (and wait until SUDS answers), stop (SUDS shuts down cleanly: WinSW sends Ctrl+C), or both. |
| `suds service status` | Whether the service is installed and running, and as which account. |
| `suds service uninstall` | Stop and remove the service. The data folder is kept. |
| `suds logs [--lines N] [--follow] [--errors] [--service]` | Show the server log (see *Logs*). |
| `suds backup [<folder>]` | An encrypted backup now. `--restore <file.enc> [<out.db>]` decrypts one to a separate file. `--restore-in-place <file.enc>` replaces the live database, with the service stopped. |
| `suds dr-drill [--backup <file>] [--fresh] [--keys-file <file>] [--json]` | A recovery drill, with a signed report. |
| `suds create-admin [<username>]` | Create an administrator, or reset one's password. It asks for the password, or reads `SUDS_ADMIN_PASSWORD`. |
| `suds reset-admin <username>` | Let a locked-out administrator back in with a new temporary password, printed once. The reset is audited. |
| `suds update --check` / `--from <zip>` | Check for a release, or install a downloaded one (see *Updates*). |
| `suds verify-audit-export <file> [...]` | Check an audit export away from the server (security/LOGGING-AND-AUDIT.md). |
| `suds compliance-check` | Linux servers only. On Windows it says so and exits 5. |
| `suds version [--json]` | The SUDS and Node.js versions. |
| `suds help` | The list of commands. |

Most commands take `--data <folder>` to name the data folder.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done. For `suds status`: SUDS answers and reports itself healthy. For `suds service status`: running. |
| 1 | Failed. The message says why in one sentence and what to do next. `suds status`: not answering or not healthy. |
| 2 | The command line was wrong (an unknown command or option, or a missing value). |
| 3 | SUDS's own files are incomplete (no `app\` beside `suds.exe`, or no `suds-service.exe`). |
| 4 | Needs an elevated (administrator) terminal. |
| 5 | Not available on this system (`suds compliance-check` on Windows, `suds service` off Windows). |

The wrapped scripts (`backup`, `dr-drill`, `reset-admin`, `create-admin`, `verify-audit-export`) keep their own
codes: 0 success, 1 failure, 2 usage error.

## How it is built (for reviewers)

`scripts/build-windows.js` builds the zip, in CI only (`.github/workflows/ci.yml` job `windows-exe` on every push;
`release.yml` jobs `windows-exe` and `windows-sign` for a release). The steps:

1. It takes `node-v22.x.y-win-x64.zip` from nodejs.org, WinSW-x64.exe from WinSW's GitHub release, and postject's
   npm tarball. Each must match its hash, pinned in `ci.yml`. A mismatch stops the build.
2. It removes the Authenticode signature from `node.exe` (`signtool remove /s`).
3. It makes the single-executable blob from `scripts/windows/sea-main.js` with the same Node.js release, and
   injects it with postject's API. postject is a build tool only: it is not in `package.json` and is not shipped.
4. It copies `app\` from the commit, writes the default `suds-service.xml`, `README-WINDOWS.txt` and
   `THIRD-PARTY-NOTICES.txt`, and zips them. The zip is deterministic: an unsigned build of the same commit has
   the same bytes.
5. It signs `suds.exe` and `suds-service.exe` (release only, when the certificate secrets exist).

The bootstrap only finds `app\` beside `suds.exe` and loads `app\scripts\windows\cli.js` with Node's ordinary
loader. The SBOM (`scripts/sbom.js`) lists the Node.js Windows zip and WinSW as shipped in this zip, and postject
as build tooling, with their hashes. docs/RELEASE.md, *The Windows server zip*, covers bumping the pins and adding
the signing certificate.
