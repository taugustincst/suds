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

## Step 4 — Setup wizard (first run only)
The wizard asks for:
1. **Program name**, county and privacy officer contact.
2. **Your administrator account** — username and a strong password (12+ characters with upper and lower case, a number and a symbol).
3. **Who can reach SUDS**:
   * *Only this computer* — safest; staff use SUDS on this machine only.
   * *Phones, tablets and other computers on the office network* — enables mobile use. SUDS creates its own HTTPS certificate so traffic is encrypted.
4. Click **Finish**. SUDS switches to its final address and shows a **QR code** you can scan with a phone.

Encryption keys are generated for you and stored in `data/keys.json`. **Immediately download the key backup** offered at the end of the wizard (also available later under Administration → System) and store it somewhere separate from the computer — for example the county password manager. Without the keys, a backup of the database cannot be read.

## Step 5 — Sign in and add staff
Sign in with the administrator account, enroll multi-factor authentication when prompted, then go to **Administration → Users** to add navigators, clinicians and supervisors. Give each person their temporary password in person or by phone.

## Using SUDS on a phone or tablet
1. On the phone, connect to the office Wi-Fi.
2. Scan the QR code from Administration → Network, or type the address shown there (for example `https://192.168.1.20:8443`).
3. The first time, the browser warns that the certificate is not trusted (it is self-signed by your SUDS). Tap **Advanced → Proceed** (Android/Chrome) or **Show Details → visit this website** (iPhone/Safari). To remove the warning permanently, download the certificate from Administration → Network and install it on the device (IT can push it with MDM).
4. Add SUDS to the home screen: **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android). It then opens full-screen like an app, with the same 15-minute auto sign-out.

## Backups
Administration → **System → Download encrypted backup** weekly (or use IT's scheduled backup of the whole `data` folder). Keep backups and the key file in different places.

## Stopping, restarting, updating
* **Stop:** close the black window.
* **Restart:** double-click the launcher again.
* **Update:** replace the SUDS folder with the new version but keep your `data` folder. Then start as usual.
* **Start automatically at login:** Windows — create a shortcut to `Start-SUDS.bat` in `shell:startup`; Mac — System Settings → General → Login Items → add `Start-SUDS.command`.

## Getting help from IT
If IT wants to run SUDS as a proper service with a real certificate and domain name, point them to `docs/DEPLOYMENT.md`. Everything the wizard did can also be configured with environment variables.
