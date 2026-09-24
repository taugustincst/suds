# Adopting SUDS: a plan for a county CIO

SUDS is small, open-source software that holds 42 CFR Part 2 records. The code is only part of what makes it
safe to run. This page sets out the governance, pilot, release and staffing a county should have in place
before navigators depend on it. It is written for the CIO or IT director signing off the deployment, and for
the programme manager who will run it.

Related reading: [PLATFORM.md](PLATFORM.md) (the web app on the office server is the system of record),
[DEPLOYMENT.md](DEPLOYMENT.md) (installation, keys, backups, hardening), [HIPAA.md](HIPAA.md) (controls, and
the *Risk register notes* to copy into the county's register), [RELEASE.md](RELEASE.md) (how a release is cut).

## 1. Ownership and change control

- **A named code owner.** One person (county staff or a contracted developer) is accountable for the code
  the county runs: they review every change, answer for it, and hold the decision to deploy. Record the
  name and a deputy. With nobody in that role, do not adopt SUDS.
- **Human review of every change.** Every change to the code the county deploys, whoever or whatever wrote
  it (staff, contractor, automated tooling), is reviewed and approved by a person other than its author
  before it merges. Protect the release branch: pull requests only, one approving review, CI green.
- **The county deploys releases, not branches.** Install from a tagged release (`suds-v<version>.zip` and
  its `.sha256`), never from `main`. The public demo is also published only from releases (WEB_APP.md).
- **Keep a change log of what was deployed where and when**, beside the key-custodian log.

## 2. Pilot (60 days)

| | |
| --- | --- |
| **Who** | 3–5 navigators and their supervisor, one programme. |
| **Where** | The office server only. Local mode stays off (the default; the setup wizard's recommended *No*). No phone apps (there are none). |
| **Data** | Real caseload for the pilot group, entered in SUDS *and* kept in the existing system of record for the pilot's duration, so nothing depends on SUDS alone until the pilot has passed. |
| **Length** | 60 days, with a check-in at day 14 and day 30. |
| **Exit criteria** | No unresolved data-integrity defect (a record lost, duplicated or shown to the wrong person); a restore drill and a key-rotation drill completed (section 5); the monthly audit review done once; navigators can do a normal week's work without the paper fallback; an independent review scheduled (section 6). |
| **Stop criteria** | Any PHI shown to someone outside the caseload rules, any record lost, or an audit chain that fails verification: stop, restore from backup if needed, and treat as a possible breach under the county's procedure. |

## 3. Staged release cadence

- **Pilot group first.** A new release goes to the pilot server (or the pilot users) first.
- **Everyone else a week later**, if the pilot group reports nothing blocking. "Blocking" means any
  data-integrity or access-control problem, a failed migration, or a workflow navigators cannot complete.
- **Security fixes** can shorten the week to a day, still pilot first.
- Take an encrypted backup before every upgrade (migrations also snapshot the database, but on the same disk).
- On each deploy, check the **version shown on screen** is the release being deployed (RELEASE.md).

## 4. Real-device release checklist

Automated tests run Chromium, plus an advisory WebKit subset on Linux, which is *not* iOS Safari. Before a
release goes beyond the pilot, a person runs this on **2 iPhones and 2 Android phones** (different OS
versions if possible), against the release on the pilot server:

- [ ] **Install to home screen**: iPhone Safari → Share → *Add to Home Screen*; Android Chrome → ⋮ →
      *Install app*. The icon opens SUDS full-screen and sign-in works (with MFA).
- [ ] **Update after deploy**: with the previous release installed on the home screen, deploy the new one,
      reopen the icon; within one reload the on-screen version is the new one, and nothing typed before the
      update is lost.
- [ ] **Offline**: turn on airplane mode; SUDS says it is offline and does not pretend to save; turn it
      back off and carry on. (If the county has turned local mode on, also: record a visit offline, sync,
      and confirm it on the office server.)
- [ ] **Two tabs**: open SUDS in two tabs (or the home-screen icon and a browser tab); edit in one, reload
      the other; no stale overwrite, no error.
- [ ] Idle sign-out after the configured minutes; sign-in again resumes where the person was.
- [ ] Certificate: no warning on devices that have the county CA (or the SUDS certificate) installed.

Record who ran it, on which devices and OS versions, and the result, with the release.

## 5. Drills

| Drill | How often | What proves it worked |
| --- | --- | --- |
| **Restore** | Quarterly, and once during the pilot | An encrypted backup restored to a *separate* machine with the saved keys (DEPLOYMENT.md, "Backups"); client counts and a sample of records match; the audit chain verifies. Time it — that is the county's real recovery time. |
| **Key rotation** | Annually, and once during the pilot (on a copy) | `npm run rotate-key` and `npm run rotate-index-key` on a restored copy (DEPLOYMENT.md, "Key rotation runbook"); search still finds clients, the audit chain verifies under the new index key, and a backup taken afterwards restores. Retired keys filed with the dates of the backups they open. |
| **Lost device** | Annually | An administrator revokes and wipes a test device under Settings → Synced devices (only relevant if local mode is on). |

## 6. Independent review before county-wide rollout

Before SUDS goes beyond the pilot programme, commission an **independent security and 42 CFR Part 2
review**: someone who did not write the code reviews the deployment (host, TLS, keys, backups, access), the
consent and disclosure behaviour against Part 2 (§2.31, §2.32, §2.13 accounting) with county counsel, and
the risks in HIPAA.md's *Risk register notes*. Fix or formally accept each finding before rollout, and
repeat after any major change (a new data flow, local mode turned on, a new integration).

## 7. Staffing

| Role | Time | Responsibilities |
| --- | --- | --- |
| **System administrator** | 0.25–0.5 FTE | Accounts and roles, MFA enrolment, backups and restore drills, upgrades (pilot first), certificate renewal, monitoring `/api/health`, device revocation. |
| **Key custodian** (and a deputy) | a few hours a quarter | Holds the encryption, index and backup keys in the county secrets manager; runs key rotations; keeps the key-custodian log; is not the same person as the system administrator where staffing allows. |
| **Audit reviewer** (privacy officer or delegate) | monthly, ~2 hours | Reviews break-glass events, access denials and exports (Administration → Audit log); confirms the audit chain verifies; answers patient requests within 30 days. |
| **Developer / code owner** | as needed; budget for it | Reviews and merges changes, cuts releases, handles security fixes, keeps Node and the kernel's build tools current (DEPLOYMENT.md, "Node.js support and the move to 24"; RELEASE.md). A county without in-house capacity contracts this. |

## 8. Before go-live checklist

- [ ] Code owner and deputy named; branch protection with required review on.
- [ ] DEPLOYMENT.md hardening checklist complete; local mode off unless a documented need exists.
- [ ] HIPAA.md *Risk register notes* copied into the county risk register, with owners.
- [ ] BAAs in place (hosting, and Pocket AI / Microsoft if used).
- [ ] Pilot completed and exit criteria met; restore and key-rotation drills done.
- [ ] Independent security / Part 2 review done, findings closed or accepted.
- [ ] Staffing in section 7 assigned by name.
