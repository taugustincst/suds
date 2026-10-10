# Installer run in a systemd container — 2026-10-10 (SUDS 1.25.3)

> **Not a VM run.** As the [1.23.0 run](../installer-container-run-2026-10-01-v1.23.0/README.md) and the runs before
> it, this is `deploy/linux/install.sh` and `upgrade.sh` run for real, as root, on Ubuntu 24.04 with systemd 255 as PID
> 1, inside a privileged Docker container in a development sandbox. The one real-VM install so far is the vendor's own,
> suds.systems (1.25.1, Ubuntu 24.04 on AWS Lightsail, 2026-10-08, reported in prose by the project: no transcript or
> signed report from it is stored here). This run checks, in a container, what 1.25.3 changed after that launch, and
> records **the first hand-over between two real releases**. The limits of the earlier runs apply unchanged (no LUKS
> volume, no SSH, same-disk non-WORM "shares", no NTP, no network during the run, no ACME, no reboot, **no RHEL 9**).

`deploy/linux/` did not change between 1.23.0 and 1.25.1 (`git diff --stat v1.23.0 v1.25.1 -- deploy/linux` is
empty), so the 1.23.0 run still describes the scripts 1.25.1 shipped. 1.25.3 changed `install.sh`, `upgrade.sh`,
`lib.sh` and the `Caddyfile` after the launch of suds.systems: the firewall clean-up runs before the administration
network's SSH rule is added (launch finding 1), the end of the run prints the firewall rules in force, the Caddyfile
imports a site-local directory `/etc/caddy/Caddyfile.d/` that upgrades never touch, site blocks appended to the
Caddyfile are moved there instead of being discarded (launch finding 2), `--www-redirect`, the first administrator's
username in the final message, and no `Via` header (pen test INFO-2).

## Environment

The 1.23.0 run's, re-used:

* Host: the development sandbox (kernel 6.18.44, no `/dev/kvm`); Docker started there with the earlier runs' data root.
* Image: `suds-vm-ubuntu2404`, built for the 1.19.0 run from
  [environment/Dockerfile](../installer-container-run-2026-09-30/environment/Dockerfile) (Ubuntu 24.04.5, `systemd`,
  `dbus`, `ufw` and the packages the installer asks for, fetched at build time); no network during the runs.
* Each container, from the host: [environment/start.sh](environment/start.sh) `<name> <dir> <release>`, which runs
  [prepare.sh](environment/prepare.sh) (`mount --make-rshared /`, `suds.county.test` and `www.suds.county.test` →
  127.0.0.1, a throwaway CA and a certificate naming both, the release unpacked). The whole sequence of each container
  is a script: [run-fresh-install.sh](environment/run-fresh-install.sh) and
  [run-upgrade-from-1.25.1.sh](environment/run-upgrade-from-1.25.1.sh).
* Releases: `suds-v1.25.3.zip` = `git archive --format=zip --prefix=suds-v1.25.3/ v1.25.3` (`fdd248d0`), SHA-256
  `d70101e1d0332beff63beef329cea7089bbe1afd4f58e34beb845a1e556239cc`, and `suds-v1.25.1.zip` from `v1.25.1`
  (`03bdca9a`), SHA-256 `f81b65ceaf390bc2430ca8205a787781873411b12681c842c5cb19a727a28e1b`: both the values
  [../RELEASE-HANDOFF.md](../RELEASE-HANDOFF.md) records, rebuilt here byte for byte, each passed as
  `--release-sha256`. Node.js v22.23.3 and Caddy 2.10.2 tarballs: the earlier runs' downloads, checked by the installer
  against `deploy/linux/pins` (unchanged since 1.21.0).
* Installer options as in the 1.23.0 run (`--tls=county-cert`, `--ca-file`, `--admin-cidr=10.20.0.0/16`,
  `--console-access`, `--accept-unencrypted-disk=…`, `--ntp-server=time.county.test`, offline
  `--source`/`--node-tarball`/`--caddy-tarball`): [install-1.25.3.sh](environment/install-1.25.3.sh),
  [install-1.25.1.sh](environment/install-1.25.1.sh). The day-one checks: [after-install.sh](environment/after-install.sh);
  the firewall: [ufw-rules.sh](environment/ufw-rules.sh); the live test's MINOR-1:
  [lockout-probe.sh](environment/lockout-probe.sh); the operator's step 6: [escrow-drill.sh](environment/escrow-drill.sh)
  (it now reads the evidence public key before shredding the escrow file, which the 1.23.0 harness did not).

The transcripts are each step's output, unedited except that the sandbox's scratch path, where it appears, reads
`<scratch>`.

## Ubuntu 24.04: fresh install of 1.25.3 — [ubuntu-24.04-install-1.25.3/](ubuntu-24.04-install-1.25.3/)

The 1.23.0 run's steps, then two re-runs of the installer that change the administration network.

| Transcript | Outcome |
| --- | --- |
| [1-dry-run.txt](ubuntu-24.04-install-1.25.3/1-dry-run.txt) | `--dry-run`: exit 0. The release, Node and Caddy checksums; ends with "+ show the firewall rules now in force, and warn if none allows SSH" |
| [2-run-refused-shares.txt](ubuntu-24.04-install-1.25.3/2-run-refused-shares.txt) | Exit 1: the `suds` account created, then **one refusal naming both shares** with the remedies; `/opt/suds` and `/etc/suds` do not exist afterwards. Then `chown suds:suds` and `chmod 0700` on both |
| [3-run-stopped-after-staging-bad-caddy-tarball.txt](ubuntu-24.04-install-1.25.3/3-run-stopped-after-staging-bad-caddy-tarball.txt) | A truncated Caddy tarball: exit 1, `REFUSED: checksum mismatch for caddy_2.10.2_linux_amd64.tar.gz`; `/opt/suds/1.25.3` staged, no `/etc/suds` |
| [4-run-complete.txt](ubuntu-24.04-install-1.25.3/4-run-complete.txt) | **Exit 0**. First backup and recovery drill **PASSED, 11/11** (schema 71; RTO 0.7 s); compliance **38 pass, 1 fail, 6 warning, 2 could not check** of 47; the final message names the first administrator ("sign in with the username \"guest\""); then **"Firewall rules in force"**: `22/tcp ALLOW 10.20.0.0/16` and `443/tcp ALLOW Anywhere` |
| [5-day-one.txt](ubuntu-24.04-install-1.25.3/5-day-one.txt) | Anonymous `/api/health` → `{"ok":true,"uptime_seconds":20,"database":"ok"}` only (MINOR-2); `http://` → 308; HSTS; **no `Via` header** (INFO-2); **`/.env` and `/.git/HEAD` → 404, `POST /` → 405** (INFO-3); `Caddyfile.d/` present and empty, the Caddyfile ends with `import /etc/caddy/Caddyfile.d/*.caddy`; `guest` signs in over HTTPS (200, `must_change_password: true`; the password is not printed) |
| [5b-firewall.txt](ubuntu-24.04-install-1.25.3/5b-firewall.txt) | `ufw status verbose`: default deny incoming, SSH from 10.20.0.0/16, HTTPS |
| [5c-lockout-probe.txt](ubuntu-24.04-install-1.25.3/5c-lockout-probe.txt) | **MINOR-1:** an unknown name and `guest`, six wrong passwords each: **both `401 ×5, then 423`** |
| [6-rerun-admin-cidr-anywhere.txt](ubuntu-24.04-install-1.25.3/6-rerun-admin-cidr-anywhere.txt), [6b](ubuntu-24.04-install-1.25.3/6b-firewall-after-rerun.txt) | **Launch finding 1, checked with the real `ufw`:** the installer re-run with `--admin-cidr=0.0.0.0/0`, the setting that cut SSH off on suds.systems. Exit 0; "removing the previous SSH rule for 10.20.0.0/16"; the rules in force, and `ufw status` afterwards, **keep `22/tcp ALLOW Anywhere`** (1 SSH rule). (The weekly compliance check would now fail `host.firewall`, "SSH (22/tcp) is open to anywhere", as it should: the 1.25.3 trial run that showed it is not kept) |
| [6c-rerun-admin-cidr-back.txt](ubuntu-24.04-install-1.25.3/6c-rerun-admin-cidr-back.txt), [6d](ubuntu-24.04-install-1.25.3/6d-firewall-after-second-rerun.txt) | Re-run with `--admin-cidr=10.20.0.0/16` again: "removing the previous SSH rule for 0.0.0.0/0"; `22/tcp ALLOW 10.20.0.0/16` only |
| [7-escrow-drill-and-weekly-compliance.txt](ubuntu-24.04-install-1.25.3/7-escrow-drill-and-weekly-compliance.txt) | The operator's step 6: `scripts/dr-drill.js --offsite --keys-file <escrow>` as `suds` → **PASSED, 12/12, keys from the escrow file, the offsite copy**, RTO 0.6 s; then the weekly unit → **39 pass, 1 fail, 5 warning, 2 could not check** |

The only failure on any report of this install is `host.time_sync` (no network in the container). Not checked:
`host.disk_encryption` (overlay; the accepted risk), `host.suds_version` (no release feed). Warnings: `host.auditd`,
`app.mfa_coverage`, `app.sso`, `app.deprovisioning`, `app.audit_chain` (the daily verification had not run), and on the
installer's report `host.dr_evidence` (passes once step 7 has run). The same 47 checks and results as on 1.23.0.

## Ubuntu 24.04: 1.25.1 with a hand-added www block, upgraded by the installed 1.25.1 upgrader — [ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/)

The path suds.systems takes: a 1.25.1 server whose Caddyfile was edited by hand on launch day, upgraded straight to
1.25.3 with the upgrader it has.

| Transcript | Outcome |
| --- | --- |
| [1-install-1.25.1.txt](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/1-install-1.25.1.txt) | 1.25.1's own `install.sh`: **exit 0**, its first backup and recovery drill passed |
| [1b-day-one-on-1.25.1.txt](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/1b-day-one-on-1.25.1.txt) | **Before**, on 1.25.1: `via: 1.1 Caddy`; `/.env`, `/.git/HEAD` and `POST /` all **200** (the app shell) |
| [1c-lockout-probe-on-1.25.1.txt](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/1c-lockout-probe-on-1.25.1.txt) | **Before:** an unknown name, six wrong passwords: `401 ×6` (a real account answers 423 after five, so the lock told the two apart) |
| [2-www-block-appended-by-hand.txt](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/2-www-block-appended-by-hand.txt) | The Caddyfile is 1.25.1's own; a `www.suds.county.test { … redir https://suds.county.test{uri} permanent }` block appended to it by hand and Caddy restarted, as on launch day (here with the county TLS file imported, since there is no ACME without a network); `https://www.suds.county.test/foo` → **301**, `Location: https://suds.county.test/foo` |
| [3-upgrade-to-1.25.3-with-installed-1.25.1-upgrader.txt](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/3-upgrade-to-1.25.3-with-installed-1.25.1-upgrader.txt) | `cmp`: the installed and the new `upgrade.sh` and `lib.sh` **both differ**. The dry run names the possible hand-over. The real run, with the installed **1.25.1** upgrader: **"SUDS 1.25.3 has its own upgrade.sh: handing over to it"**; the 1.25.3 upgrader finds the stage complete ("every file matches its manifest"), then **"/etc/caddy/Caddyfile has site blocks added after the release's own: they will be moved to /etc/caddy/Caddyfile.d/local.caddy"**, stops SUDS, takes the pre-upgrade backup, switches, **"your site blocks are now in /etc/caddy/Caddyfile.d/local.caddy (your Caddyfile as it was: /etc/caddy/Caddyfile.local-…)"**, "SUDS 1.25.3 is ready", restarts Caddy; **exit 0**. Afterwards `/etc/caddy/Caddyfile` is 1.25.3's own (`cmp`: identical), `local.caddy` holds the www block, and **www still answers 301** to the apex. Its compliance report: 38 pass, 1 fail (`host.time_sync`), 6 warning, 2 could not check |
| [4-after-upgrade.txt](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/4-after-upgrade.txt) | **After**, on 1.25.3: no `Via`; `/.env` and `/.git/HEAD` **404**, `POST /` **405**; anonymous health `ok`, `uptime_seconds`, `database` only; `guest` signs in (200) |
| [4b-lockout-probe-after-upgrade.txt](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/4b-lockout-probe-after-upgrade.txt) | **After:** an unknown name, six wrong passwords: `401 ×5, then 423`, as a real account answers |
| [5-escrow-drill-and-weekly-compliance.txt](ubuntu-24.04-upgrade-1.25.1-to-1.25.3-with-the-installed-1.25.1-upgrader/5-escrow-drill-and-weekly-compliance.txt) | The escrowed-key drill against the offsite copy: **PASSED, 12/12**; the weekly unit: 39 pass, 1 fail (`host.time_sync`), 5 warning, 2 could not check |

## Signatures

Checked on the host from this branch:

```bash
E=docs/evidence/installer-container-run-2026-10-10-v1.25.3/ubuntu-24.04-install-1.25.3
npm run verify-dr-report -- $E/dr-drill-2026-10-10T00-10-29-926Z.json --public-key $E/suds-signing-key.pem          # VERIFIED, key id b51f354916009c0c
npm run verify-dr-report -- $E/dr-drill-2026-10-10T00-11-26-255Z.json --public-key $E/suds-signing-key.pem          # VERIFIED
npm run verify-compliance-report -- $E/compliance-2026-10-10T00-10-31-609Z.json --public-key $E/compliance-signing-key.pub.pem   # VERIFIED, key id 314ddcaf0a7e09d1
npm run verify-compliance-report -- $E/compliance-2026-10-10T00-11-27-595Z.json --public-key $E/compliance-signing-key.pub.pem   # VERIFIED
```

In the upgrade container's folder, the two drill reports verify with its `suds-signing-key.pem` (key id
`41c37687c6c5fbcc`) and the two compliance reports with its `compliance-signing-key.pub.pem` (key id
`8dfbe33bf1e39379`). No private key is in this folder; neither container's first-administrator password, nor any of
its keys, is in any transcript (each file was searched for them before the containers were removed).

## Findings

Recorded, not fixed here (no code was changed by this run).

1. **The hand-over between two real releases works** (closing the 1.23.0 run's finding 1): 1.25.1's installed
   upgrader handed over to 1.25.3's, which carried out the upgrade, including the Caddyfile handling the 1.25.1
   upgrader does not have.
2. **Launch finding 1 is fixed on a real `ufw`**: with `--admin-cidr=0.0.0.0/0` the SSH rule stays, and the end of
   the run shows it. Launch finding 2 is handled on upgrade: the hand-added www block moved to `Caddyfile.d/local.caddy`
   and kept working.
3. **Cosmetic (for 1.26):** when only the Caddyfile changed, the upgrade prints "Caddy  has a new Caddyfile:
   restarting it", with a double space where the version clause is left out (`deploy/linux/upgrade.sh`, step 5).
4. **For suds.systems:** its SSH rules were re-added by hand on launch day for `0.0.0.0/0` and `::/0`, so its weekly
   compliance check reports `host.firewall` as a failure ("SSH (22/tcp) is open to anywhere"), on 1.25.1 as on 1.25.3
   (the check is the same in both releases; a first trial of this run, not kept, showed the failure after step 6's
   re-run). The launch report's "0 fail" was taken at the end of the
   install, while 1.25.1 had removed the SSH rule (launch finding 1). Narrow the administration network, or record the
   failure as understood.

## What this run could not exercise

The same as the earlier runs: a LUKS data volume; SSH itself and the admin-network lock-out check (`--console-access`);
IPv6 firewall rules (the container has no IPv6, so `ufw` shows none); a real offsite host and a WORM share; a working
NTP source; package installation from the distribution's mirrors during the run; ACME (`--tls=caddy`, and so
`--www-redirect`, which needs it: `test/deploy-linux-real.test.js` covers the file it writes); a reboot; cloud
security groups; RHEL 9 entirely. The rollback path of `upgrade.sh` was not exercised here
(`test/deploy-linux-real.test.js` rolls one back for real in a fake root, including putting a moved Caddyfile back).
The manual path of deploy/linux/README.md, *Before upgrading suds.systems from 1.25.1* (moving the www block by hand
first), was not run separately: it leaves the Caddyfile equal to 1.25.1's, the case the 1.23.0 run's upgrade covered.
