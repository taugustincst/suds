# Installing SUDS without a terminal

This guide is for the person who will host SUDS on an office computer or small server. No command-line knowledge is needed. Allow about 15 minutes.

## What you need
* A Windows or Mac computer that stays on during working hours (a county workstation or a small server). Laptops that leave the building are **not** appropriate hosts for PHI.
* Node.js 22 or newer (free). It is the only thing to install.
* Disk encryption turned on (BitLocker on Windows, FileVault on Mac). Ask IT if unsure.

## Step 1 — Install Node.js
1. Open **https://nodejs.org** in your browser.
2. Click the green **LTS** download button.
3. Run the installer and click *Next* through the defaults.

## Step 2 — Get SUDS
* Download the SUDS folder (ZIP from GitHub → **Code → Download ZIP**, or from the person who gave you this guide).
* Unzip it somewhere permanent, for example `C:\SUDS` or `~/Applications/SUDS`. Do not put it in Downloads.

## Step 3 — Start SUDS
Open the `launchers` folder inside SUDS and double-click:

| Windows | Mac | Linux |
| --- | --- | --- |
| `Start-SUDS.bat` | `Start-SUDS.command` (first time: right-click → **Open**) | `start-suds.sh` |

A black window opens (leave it open — closing it stops SUDS) and your browser opens the **setup wizard**.

> **The launchers are for evaluation and single-workstation trials.** Nothing restarts SUDS if the window is closed or the computer reboots, and it runs as whoever double-clicked it. A county deployment — anything other staff depend on — runs as a service: systemd on Linux, NSSM on Windows, as `docs/DEPLOYMENT.md` describes. Ask IT to set that up before the programme goes live; the data folder and settings carry over unchanged.

## Step 4 — Setup wizard (first run only)
The wizard asks for:
1. **Program name**, county and privacy officer contact.
2. **Your administrator account** — username and a strong password (12+ characters with upper and lower case, a number and a symbol).
3. **Who can reach SUDS**:
   * *Only this computer* — safest; staff use SUDS on this machine only.
   * *Phones, tablets and other computers on the office network* — enables mobile use. SUDS creates its own HTTPS certificate so traffic is encrypted.
4. Click **Finish**. SUDS moves to its final address — normally **https://suds.local** — and shows a QR code you can scan with a phone.

Encryption keys are generated for you and stored in `data/keys.json`. **Immediately download the key backup** offered at the end of the wizard (also available later under Administration → System) and store it somewhere separate from the computer — for example the county password manager. Without the keys, a backup of the database cannot be read.

## Step 5 — Sign in and add staff
Sign in with the administrator account, enroll multi-factor authentication when prompted, then go to **Administration → Users** to add navigators, clinicians and supervisors. Give each person their temporary password in person or by phone.

**Filling the resource directory.** Under **Resource directory** you can add the Sacramento region starter directory: 81 real programs across eight counties, with summaries, service tags and contact details. They arrive marked "needs verification" because they were compiled from public web sources rather than confirmed with the providers, so call each one, correct anything wrong and press "Verified today". "Download provider pictures" fetches each program's picture from its own website if this computer has internet access.

**Want to look around first?** On the home screen (or under **Settings → Settings → Sample data**) choose **Load sample data**. SUDS adds fictional clients, visits, notes, referrals, reminders and funding so every screen has something on it. It is only offered while you have no clients yet, and **Remove sample data** clears all of it in one click before you enter real people.

## Using SUDS on a phone, tablet or another computer
Nothing to install or configure on the device. Everything a person does on their phone is immediately on their computer and vice versa, because both talk to the same SUDS.
1. On the phone, connect to the office Wi-Fi.
2. Open the browser and go to **https://suds.local** (SUDS announces this name on the network), or scan the QR code from Settings → Network & devices.
3. The first time, the browser warns that the certificate is not trusted (SUDS made its own). Tap **Advanced → Proceed** (Android/Chrome) or **Show Details → visit this website** (iPhone/Safari). To remove the warning permanently, download the certificate from Administration → Network & devices and install it on the device: it is a small certificate authority of SUDS's own, which is what Android (Settings → Security → Install a certificate → CA certificate) and iPhone (install the profile, then Settings → General → About → Certificate Trust Settings → enable full trust) accept. IT can push it with MDM.
   *Android browsers do not resolve `suds.local`*: on an Android phone use the numeric address shown under Settings → Network & devices (or the QR code, which carries it); the Android app finds the server on its own.
4. Add SUDS to the home screen: **Share → Add to Home Screen** (iPhone) or **⋮ → Add to Home screen** (Android). It then opens like an app, with the same 15-minute auto sign-out. Until the certificate has been installed on the device, the browser treats it as a bookmark rather than an installed app (no offline shell), which is fine — everything still works while on the office network.

### The certificate: what the wizard makes, and what a county should use instead

The certificate the wizard creates is signed by a small private certificate authority of SUDS's own. That CA is deliberately narrow: it is **name-constrained** to the addresses SUDS listens on (`suds.local`, the computer's name, its office IP addresses and anything typed under *Extra names*), so a phone that installs it trusts it for this one server and nothing else, and it **expires 30 days after the server certificate** (about 27 months from setup) rather than living for years. SUDS warns on its health check and the Administration page from 60 days before expiry.

That narrowness has a cost. **When the certificate is renewed** (Administration → Network & devices → tick *Create a new certificate* and save — nothing renews it by itself, which is what the 60-day warning is for), a new CA comes with it, and every phone and computer that installed the old one must install the new one — *re-enrolment* — or the browser warning returns. Plan a renewal like a small rollout: create the new certificate on a quiet day, download it from Network & devices, push it with MDM if you have it, and walk the rest of the devices through the install steps in point 3 above. Devices that never installed the CA (they tap through the warning) need nothing.

**For a county deployment, use the county's PKI instead.** IT gives the SUDS computer a name in the county DNS, issues a certificate from the county CA (which every county-managed device already trusts) and either sets `TLS_CERT_PATH` / `TLS_KEY_PATH` or, better, puts SUDS behind the county's reverse proxy (IIS, nginx, Caddy) that terminates HTTPS with that certificate and forwards to SUDS on `127.0.0.1` with `TRUST_PROXY=1`. Then renewals happen where IT already renews everything else, nothing has to be installed on phones, and the self-signed path above is never needed. `docs/DEPLOYMENT.md` has the settings.

## Native apps (optional)
Android staff can install a real app instead of the browser shortcut: see `docs/MOBILE_APPS.md`. Once the administrator has uploaded the app under Settings → Network & devices → Native apps, phones get it from **https://suds.local/app**.

## Backups
Administration → **System & backups → Download encrypted backup** weekly, or turn on scheduled backups under Settings (each one is read back and opened after it is written, and the result shows under System & backups). If IT backs up the `data` folder with its own tools, **exclude `data/keys.json`** from that job and keep the key file somewhere else on its own — a backup that sits next to its key is not encrypted in any useful sense.

A backup can only be opened with this installation's encryption keys, so a stolen backup file is not a breach — and a backup without the keys cannot be restored at all. That is why step 4 of the wizard asks you to save the key backup somewhere separate.

## Putting a backup back
If the computer is replaced, the database is damaged, or something was deleted that should not have been:

1. Install SUDS on the machine and restore the **same `data/keys.json`** you saved at setup, or set the same encryption keys. A backup made with different keys cannot be read.
2. Sign in as an administrator and go to Administration → **System & backups → Restore from a backup**.
3. Choose the backup file and press **Check this backup**. SUDS tells you what is inside it — how many clients, when it was taken, which version — and changes nothing yet.
4. If it is the right file, press **Replace everything with this backup**, type `REPLACE`, and enter your password.

Everything recorded after that backup was taken will be gone, so check the summary first. The database being replaced is kept on the server as `suds.db.before-restore-…`, so a restore of the wrong file can be undone by whoever looks after the machine. Everyone is signed out afterwards, and phones should sync once.

A backup from an older version of SUDS is brought up to date automatically when it is restored.

Restoring through the browser handles databases up to about 450 MB. A bigger one (a county with years of scanned forms) is restored on the server itself: `node scripts/backup.js --restore <file>`, which has no size limit.

## Stopping, restarting, updating
* **Stop:** close the black window.
* **Restart:** double-click the launcher again.
* **Update:** take a backup first (above), then replace the SUDS folder with the new version but keep your `data` folder. Then start as usual — the database is brought up to date the first time the new version starts. Before it does, SUDS keeps a copy of the database in `data/pre-migration/`; if the update stops with an error, the database is left as it was at the last completed step and that copy (or your backup) is the way back — put the old SUDS folder back, restore, and call IT rather than retrying. SUDS will not open a `data` folder written by a *newer* version than the one you are running, so if you ever need to go back, restore the backup that matches.
* **Start automatically at login:** Windows — create a shortcut to `Start-SUDS.bat` in `shell:startup`; Mac — System Settings → General → Login Items → add `Start-SUDS.command`.

## Getting help from IT
If IT wants to run SUDS as a proper service with a real certificate and domain name, point them to `docs/DEPLOYMENT.md`. Everything the wizard did can also be configured with environment variables.
