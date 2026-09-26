# Installing SUDS

This guide is for the person who will host SUDS on an office computer or small server. It covers the server and its setup wizard; staff then use SUDS in a browser (there is no app to install — see [PLATFORM.md](PLATFORM.md)). Allow about 15 minutes. IT teams running it as a service behind a reverse proxy should read [DEPLOYMENT.md](DEPLOYMENT.md) as well.

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
Open a terminal (Command Prompt / PowerShell on Windows, Terminal on Mac) in the SUDS folder and run:

```bash
SUDS_ENV=production npm start        # Windows PowerShell: $env:SUDS_ENV='production'; npm start
```

Leave that window open (closing it stops SUDS) and open the address it prints — normally **http://127.0.0.1:8080** — in your browser: the **setup wizard** appears.

For anything other staff depend on, run SUDS as a service instead so it survives a closed window and a reboot: systemd on Linux, NSSM on Windows, or Docker, as [DEPLOYMENT.md](DEPLOYMENT.md) describes. The data folder and the wizard's settings carry over unchanged. (The double-click launchers that older versions shipped were removed in 1.9.3.)

## Step 4 — Setup wizard (first run only)
The wizard asks for:
1. **Program name**, county and privacy officer contact.
   **What kind of program is this?** *Harm reduction & outreach* (the default: outreach, visits, supplies, referrals and grant reporting) or *Treatment-adjacent* (adds care plans, assessments, CalOMS Tx, the FHIR API and the county EHR hand-off). It changes only what the screens show; an administrator can change it, or switch single modules on, under **Settings → Programme** (docs/USER_GUIDE.md, *Programme profile and modules*).
2. **Your administrator account** — username and a strong password (12+ characters with upper and lower case, a number and a symbol).
3. **Who can reach SUDS**:
   * *Only this computer* — safest; staff use SUDS on this machine only.
   * *Phones, tablets and other computers on the office network* — staff use SUDS in the browser on their own devices. SUDS creates its own HTTPS certificate so traffic is encrypted.
4. **Allow staff to keep an offline copy on their devices?** For a harm-reduction & outreach programme the wizard recommends *Yes*: outreach happens where there is no signal, and the copy is encrypted on the device under each person's password ([ADR-0008](architecture/ADR-0008-device-encryption.md)). The trade-off: if someone forgets their password, whatever on that device has not been synced yet cannot be recovered, so staff should sync often. For a treatment-adjacent programme the recommendation stays *No* — staff use SUDS only while connected to this server — unless there is a documented field-work need, on county-managed devices (see *Working offline* below). The answer is saved in `data/server.json`; IT can override it later with `LOCAL_MODE_ENABLED`.
5. Click **Finish**. SUDS moves to its final address — normally **https://suds.local** — and shows a QR code a phone can scan to open it.

Encryption keys are generated for you and stored in `data/keys.json`. **Immediately download the key backup** offered at the end of the wizard (also available later under Administration → System) and store it somewhere separate from the computer — for example the county password manager. Without the keys, a backup of the database cannot be read.

## Step 5 — Sign in and add staff
Sign in with the administrator account, enroll multi-factor authentication when prompted, then go to **Administration → Users** to add navigators, clinicians and supervisors. Give each person their temporary password in person or by phone.

Staff can also ask for an account themselves: the sign-in page has two options, **Log in** and **Sign up**. Sign up sends a request (name, username, optional email, the password they choose, and a line about their role); it cannot sign in until an administrator approves it under **Settings → Users & roles → Access requests**, choosing the role and, if wanted, a supervisor. Home shows administrators how many requests are waiting. Two-step verification then applies exactly as for any new account. To turn Sign up off, set **Settings → Programme → Security policy → Sign up on the sign-in page** to *Off*; the page then tells people to ask an administrator. The **Privacy officer / program contact** you enter in the wizard or in Settings is shown at the foot of the sign-in page.

**Filling the resource directory.** Under **Resource directory** you can add the Sacramento region starter directory: 81 real programs across eight counties, with summaries, service tags and contact details. They arrive marked "needs verification" because they were compiled from public web sources rather than confirmed with the providers, so call each one, correct anything wrong and press "Verified today". "Download provider pictures" fetches each program's picture from its own website if this computer has outbound internet access (behind a proxy, see DEPLOYMENT.md, "Outbound internet"), makes the directory card show it, and says how many it got and why any are missing.

**Want to look around first?** On the home screen (or under **Settings → Programme → Sample data**) choose **Load sample data**. SUDS adds fictional clients, visits, notes, referrals, reminders and funding so every screen has something on it. It is only offered while you have no clients yet, and **Remove sample data** clears all of it in one click before you enter real people.

## Using SUDS on a phone, tablet or another computer
Nothing to install or configure on the device: SUDS is used in the browser, and the `/app` page on the server (for example `https://suds.local/app`) walks staff through these steps. Everything a person does on their phone is immediately on their computer and vice versa, because both talk to the same SUDS.
1. On the phone, connect to the office Wi-Fi.
2. Open the browser and go to **https://suds.local** (SUDS announces this name on the network), or scan the QR code from Settings → Network & devices.
3. The first time, the browser warns that the certificate is not trusted (SUDS made its own). Tap **Advanced → Proceed** (Android/Chrome) or **Show Details → visit this website** (iPhone/Safari). To remove the warning permanently, download the certificate from Administration → Network & devices and install it on the device: it is a small certificate authority of SUDS's own, which is what Android (Settings → Security → Install a certificate → CA certificate) and iPhone (install the profile, then Settings → General → About → Certificate Trust Settings → enable full trust) accept. IT can push it with MDM.
   *Android browsers do not resolve `suds.local`*: on an Android phone use the numeric address shown under Settings → Network & devices (or the QR code, which carries it).
4. Add SUDS to the home screen: **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android; desktop Chrome and Edge offer *Install* too). It then opens like an app, with the same 15-minute auto sign-out. Until the certificate has been installed on the device, the browser treats it as a bookmark rather than an installed app (no offline shell), which is fine — everything still works while on the office network.

### The certificate: what the wizard makes, and what a county should use instead

The certificate the wizard creates is signed by a small private certificate authority of SUDS's own. That CA is deliberately narrow: it is **name-constrained** to the addresses SUDS listens on (`suds.local`, the computer's name, its office IP addresses and anything typed under *Extra names*), so a phone that installs it trusts it for this one server and nothing else, and it **expires 30 days after the server certificate** (about 27 months from setup) rather than living for years. SUDS warns on its health check and the Administration page from 60 days before expiry.

That narrowness has a cost. **When the certificate is renewed** (Administration → Network & devices → tick *Create a new certificate* and save — nothing renews it by itself, which is what the 60-day warning is for), a new CA comes with it, and every phone and computer that installed the old one must install the new one — *re-enrolment* — or the browser warning returns. Plan a renewal like a small rollout: create the new certificate on a quiet day, download it from Network & devices, push it with MDM if you have it, and walk the rest of the devices through the install steps in point 3 above. Devices that never installed the CA (they tap through the warning) need nothing.

**For a county deployment, use the county's PKI instead.** IT gives the SUDS computer a name in the county DNS, issues a certificate from the county CA (which every county-managed device already trusts) and either sets `TLS_CERT_PATH` / `TLS_KEY_PATH` or, better, puts SUDS behind the county's reverse proxy (IIS, nginx, Caddy) that terminates HTTPS with that certificate and forwards to SUDS on `127.0.0.1` with `TRUST_PROXY=1`. Then renewals happen where IT already renews everything else, nothing has to be installed on phones, and the self-signed path above is never needed. `docs/DEPLOYMENT.md` has the settings.

## No office server? SUDS on this device
SUDS also runs with no server at all, as a web app published on GitHub Pages: each person's records are kept encrypted in their own browser, protected by device backups they download. It suits a single navigator or a very small programme; a programme whose staff share records needs the office server this guide installs. See [WEB_APP.md](WEB_APP.md), especially *Where your records live*.

## Working offline (local mode)
SUDS needs a connection to the office server. For navigators who record visits where there is no signal, the server can hand out an offline copy that runs inside the browser (`https://suds.local/?local=1`) and syncs later. **It is off unless you turn it on**: answer *Yes* to the wizard's offline-copy question, or have IT set `LOCAL_MODE_ENABLED=true`. Leave it off unless there is a documented need; while it is off, `?local=1` shows a short explanation instead of the app. The rules it runs under (the office server is authoritative; permanent rejections are final; purged records do not come back) are in [PLATFORM.md](PLATFORM.md). The former Android and iOS apps were removed in 1.9.3: a phone that still has one should sync once more, erase its copy and uninstall it, and the administrator retires it under Settings → Synced devices (steps in PLATFORM.md).

## Backups
Administration → **System & backups → Download encrypted backup** weekly, or turn on scheduled backups under Settings (each one is read back and opened after it is written, and the result shows under System & backups). If IT backs up the `data` folder with its own tools, **exclude `data/keys.json`** from that job and keep the key file somewhere else on its own — a backup that sits next to its key is not encrypted in any useful sense.

A backup can only be opened with this installation's encryption keys, so a stolen backup file is not a breach — and a backup without the keys cannot be restored at all. That is why step 4 of the wizard asks you to save the key backup somewhere separate.

## Putting a backup back
If the computer is replaced, the database is damaged, or something was deleted that should not have been:

1. Install SUDS on the machine and restore the **same `data/keys.json`** you saved at setup, or set the same encryption keys. A backup made with different keys cannot be read.
2. Sign in as an administrator and go to Administration → **System & backups → Restore from a backup**.
3. Choose the backup file and press **Check this backup**. SUDS tells you what is inside it — how many clients, when it was taken, which version — and changes nothing yet.
4. If it is the right file, press **Replace everything with this backup**, type `REPLACE`, and enter your password.

Everything recorded after that backup was taken will be gone, so check the summary first. The database being replaced is kept on the server as `suds.db.before-restore-…`, so a restore of the wrong file can be undone by whoever looks after the machine. Everyone is signed out afterwards, and any local-mode devices should sync once.

A backup from an older version of SUDS is brought up to date automatically when it is restored.

Restoring through the browser handles databases up to about 450 MB. A bigger one (a county with years of scanned forms) is restored on the server itself: `node scripts/backup.js --restore <file>`, which has no size limit.

## Stopping, restarting, updating
* **Stop / restart:** stop or restart the service (or close and reopen the terminal window if you started it by hand).
* **Update:** take a backup first (above), then replace the SUDS folder with the new version but keep your `data` folder. Then start as usual — the database is brought up to date the first time the new version starts. Before it does, SUDS keeps a copy of the database in `data/pre-migration/`; if the update stops with an error, the database is left as it was at the last completed step and that copy (or your backup) is the way back — put the old SUDS folder back, restore, and call IT rather than retrying. SUDS will not open a `data` folder written by a *newer* version than the one you are running, so if you ever need to go back, restore the backup that matches.

## Getting help from IT
If IT wants to run SUDS as a proper service with a real certificate and domain name, point them to `docs/DEPLOYMENT.md`. Everything the wizard did can also be configured with environment variables.
