# Real-device check of SUDS on this device — checklist (owner-pending)

**Status: owner-pending. No run is recorded yet.** [../ADOPTION.md](../ADOPTION.md) §4 asks for a real-device run on
**two iPhones** (and two Android phones) before a release goes beyond a pilot, and for a record of who ran it, on which
devices and versions, with the result. CI's `webkit` job runs Playwright's WebKit on Linux, which is not iOS Safari: it
skips the checks only a phone can make, and it has failed device sign-ins and first loads on `main` for reasons not yet
established on a real device ([../RELEASE.md](../RELEASE.md), *Flake register*;
[../architecture/ADR-0008-device-encryption.md](../architecture/ADR-0008-device-encryption.md)). This checklist is that
record. A development sandbox has no iPhone, so it is for the owner, an IT partner or a pilot lead.

**How to use it.** Copy this file to `real-device-check-<YYYY-MM-DD>-v<version>.md` in this folder, fill one copy per
release checked (all devices in one copy), and commit it with the screenshots (*Where the record goes*, below). Use
**fictional data only**: a made-up client, never a real person. Name the person who ran it **by role** (for example
"pilot lead", "IT partner"), not by personal name.

It covers the device-only flows of SUDS on this device at its official address (`https://taugustincst.github.io/suds/`,
the build [../WEB_APP.md](../WEB_APP.md) describes), and the items of ADOPTION §4 that apply to it. For an office
server's pilot, run ADOPTION §4 itself against the pilot server as well.

## The devices

| | Device 1 | Device 2 | Device 3 (Android) | Device 4 (Android) |
| --- | --- | --- | --- | --- |
| Model (e.g. iPhone 13) | | | | |
| OS version (Settings → General → About) | | | | |
| Browser and version (iOS: Safari, which follows iOS) | | | | |
| SUDS version shown on screen | | | | |
| Previous SUDS version on the home screen, for step 11 | | | | |
| Storage free before the run | | | | |
| Date and time (with time zone) | | | | |
| Run by (role, not name) | | | | |

Two iPhones on **different iOS versions** if possible (ADOPTION §4). The Android columns may be left empty when only the
iPhone record is owed; say so in *Result*.

## Before you start

- [ ] The release's version is known (the GitHub Release marked Latest) and the published site shows it (`version.json`
      next to the site, or the version on the sign-in page).
- [ ] Each phone has **no SUDS data** for the official address (a fresh device, or Safari → Settings → Advanced →
      Website Data → remove the site's data). Note in *Notes* if a device already had SUDS from an earlier run.
- [ ] A computer or a second place to keep the recovery code file, the backup file and the screenshots.
- [ ] Screenshots: take one at each step marked [Screenshot.] below (side button + volume up on iPhone), named
      `<device>-<step>.png` (for example `d1-04.png`).

## Steps

Record each result in the table under *Results* as **pass**, **fail** (with what happened, word for word) or **not run**
(with why).

1. **Open the site online.** Open the official address in Safari. The sign-in page opens on **Sign up** (a device with
   no account), with no wording that calls it a demo or a trial. [Screenshot.]
2. **Sign up.** Create the first account (it manages the device), choose a role, tick that you understand where the
   records are kept. The storage confirmation appears (*Storage: Protected* or *May be cleared by the browser*); note
   which. [Screenshot.]
3. **Recovery code.** The recovery code is shown once. Use *Download as a text file* (and note where iOS saved it) or
   *Print*, then tick *I have saved my recovery code*. [Screenshot.]
4. **Add a client.** Add one fictional client with a date of birth (for example 9 July 1981 typed as `7/9/81`) and one
   visit or contact. The client list shows it and the date of birth reads 1981, not 2081. [Screenshot.]
5. **Add to Home Screen.** Safari → Share → *Add to Home Screen*. Open SUDS from the icon: it opens full-screen and asks
   for a sign-in; sign in. [Screenshot.]
6. **Offline reload and unlock.** Turn on airplane mode. Close SUDS (swipe it away) and open it from the icon. SUDS opens
   with no connection, asks for the password, unlocks, and the client from step 4 is there. Turn airplane mode off. [Screenshot.]
7. **Reload and sign in, ten times.** Online, from the icon: sign out (or reload), sign in, check the client list
   appears. Repeat ten times. Write down how many of the ten failed and the exact message of any failure (this is the
   failure CI sees in WebKit on Linux). If a sign-in is refused with "The records stored on this device could not be
   opened", go to step 12 before doing anything else. [Screenshot of any failure.]
8. **Passphrase backup.** This device → Keep your records safe → **Download a backup**; type a passphrase (12+
   characters) twice. A `suds-device-backup-<date>.sudsbackup` file is saved; note its size and where iOS saved it, and
   move a copy off the phone. [Screenshot.]
9. **Restore from the backup.** Add a second fictional client (so the restore visibly replaces it). Then **Restore from
   a backup** with the file and passphrase: SUDS shows what the backup holds (clients, accounts, when made), changes
   nothing until you type `RESTORE`, then reloads; sign in with the account from the backup. The client from step 4 is
   there and the second one is gone. Also try a **wrong passphrase** once: it is refused as a wrong passphrase, and
   nothing changes. [Screenshot.]
10. **Recovery code sign-in.** Sign out. On the sign-in page, **Can't sign in? → Use your recovery code**: the code from
    step 3 and a new password. SUDS signs in, the records are all there, and a new recovery code is shown once. [Screenshot.]
11. **Offline after an update** (only when a previous release was on the home screen; ADOPTION §4, *iPhone: offline
    after an update*). Open the icon online once so the new release takes over (the on-screen version changes), close
    it, turn on airplane mode, open the icon: SUDS opens and unlocks with the password; then open *Use SUDS on your phone
    or tablet* (`get-app.html`, linked from the sign-in tips): it opens offline too. [Screenshot.]
12. **The damaged-copy path** (only if it happens; never cause it on purpose with real data). If a sign-in says the
    records stored on this device could not be opened: **do not choose Start over.** Use **Save the damaged copy** and
    keep the file off the phone; note the exact message and the time. Then sign in again once: from 1.25.5 the engine is
    retried before a database is declared damaged, so record whether the second attempt opened the records. If it did
    not, follow what the screen offers to restore (a backup from step 8, or the saved damaged copy where the release
    accepts it) and record what worked. Report it the same day (*Where the record goes*). [Screenshot.]
13. **Two tabs.** Open SUDS in Safari and from the home-screen icon; edit the client in one, reload the other; no stale
    overwrite, no error (ADOPTION §4).
14. **Idle sign-out.** Leave SUDS signed in and untouched for 15 minutes: it locks; signing in again resumes where you
    were (ADOPTION §4).
15. **Clean up.** Start over on this device (This device, or *Can't sign in?*) to erase the fictional records, or remove
    the site's data in Safari's settings. Delete the backup and recovery-code files, or keep them only with the record.

## Results

| Step | Device 1 | Device 2 | Device 3 | Device 4 | Screenshot(s) |
| --- | --- | --- | --- | --- | --- |
| 1. Open online | | | | | |
| 2. Sign up (storage answer) | | | | | |
| 3. Recovery code | | | | | |
| 4. Add a client | | | | | |
| 5. Add to Home Screen | | | | | |
| 6. Offline reload and unlock | | | | | |
| 7. Ten sign-ins (failures of 10) | | | | | |
| 8. Passphrase backup (file size) | | | | | |
| 9. Restore (and wrong passphrase) | | | | | |
| 10. Recovery code sign-in | | | | | |
| 11. Offline after an update | | | | | |
| 12. Damaged-copy path (seen? outcome) | | | | | |
| 13. Two tabs | | | | | |
| 14. Idle sign-out | | | | | |

**Result:** `[pass / pass with notes / fail]` — one sentence per device.

**Notes:** anything unexpected, word for word, with the step and time.

## Where the record goes

- The filled copy: `docs/evidence/real-device-check-<YYYY-MM-DD>-v<version>.md`, with its screenshots in a folder of the
  same name. Before committing, check every screenshot shows **fictional data only** and no personal account, email,
  phone number or notification.
- A line in the evidence index ([README.md](README.md), *Artefacts in this folder*) naming the release, the devices and
  the result, and the release's *Record* in [../RELEASE.md](../RELEASE.md).
- A failure at step 7 or step 12: a row in the flake register ([../RELEASE.md](../RELEASE.md), *Flake register*) with the
  device, iOS version and message, and an issue in the repository.
