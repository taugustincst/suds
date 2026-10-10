# deploy/fleet — one SUDS Server per tenant (Option A)

Operator tooling, not part of the app: nothing here is shipped to, or runs inside, SUDS. It provisions and tears down
**one AWS Lightsail VM per tenant** (a county or a provider organisation), each with its own static IP, disks, keys,
database and DNS name, and installs SUDS Server on it with [`deploy/linux/install.sh`](../linux/README.md), unchanged.
SUDS stays single-tenant: a "fleet" is many separate installs, never one install serving several tenants.

| File | What it is |
| --- | --- |
| `provision-tenant.sh <tenant.env> [--apply] [--allow-unencrypted-demo]` | Provision one tenant. **Dry run unless `--apply`** |
| `decommission-tenant.sh <tenant.env> [--apply]` | Tear one tenant down, irreversibly. **Dry run unless `--apply`** |
| `escrow.sh open <slug> --reason "…"` / `escrow.sh verify` | Open a tenant's escrowed keys (logged every time); check the logs' hash chains |
| `prepare-host.sh` | Copied to the VM and run there by `provision-tenant.sh`: the LUKS2 data volume and the two share disks |
| `lib.sh` | Shared by the scripts (it reuses `deploy/linux/lib.sh`) |
| `tenant.env.example` | Every setting for one tenant, with no values that belong to a real tenant |

Tested in `test/deploy-fleet.test.js`, against stub `aws`, `curl`, `ssh`, `scp` and `gpg` executables only: no test,
and no dry run, contacts AWS, Porkbun, DNS or a VM.
**Status (2026-10-10): not yet run against real infrastructure.** Nothing has been provisioned with it; its first real
run is the drill tenant below, on the owner's go and with the owner's credentials. The only production install today
is the vendor's own suds.systems (fictional data only), installed by hand with `deploy/linux/install.sh` before this
tooling existed.

## Private by design

Everything that names a tenant or unlocks one lives in **`FLEET_HOME`**, a private directory outside this public
repository: the tenants' settings, the register, the escrow and the credentials. Every script **refuses to run** when
`FLEET_HOME` is unset, is inside this repository's working tree (or inside any clone of SUDS), or is readable by other
users; it refuses a settings file outside `FLEET_HOME`, and a credentials file or SSH key readable by anyone but its
owner. `.gitignore` here is a second guard (`register/`, `escrow/`, `credentials/`, `*.tar.gpg`, `*.tenant.env`,
`deploy/fleet/*.env`). Nothing committed to this repository may name a tenant or a county contact, give an agreement's
status, or hold a credential.

```
$FLEET_HOME/                        mode 0700, a private git repository (see below)
  tenants/<slug>.env                one per tenant, from tenant.env.example            (in git)
  register/<slug>.env               the tenant record: written by the scripts, BAA/QSOA/export fields by the owner (in git)
  register/<slug>.log               the tenant's history, hash-chained                 (in git)
  escrow/access.log                 every escrow put, open and shred, hash-chained     (in git)
  escrow/<slug>/keys-<time>.tar.gpg the keys, encrypted for the owner                  (NOT in git: see Teardown)
  credentials/porkbun.env           PORKBUN_API_KEY=… and PORKBUN_SECRET_API_KEY=…, mode 0600 (NOT in git)
  keys/suds-fleet.pem               the Lightsail SSH key, mode 0600                   (NOT in git)
  releases/suds-v<version>.zip      release zips, checked against RELEASE_SHA256       (NOT in git)
  known_hosts                       the VMs' SSH host keys
```

## Agreements, isolation and who operates the fleet (read before any real data)

- **Two agreements per tenant, both signed before any real client record:** a **HIPAA business associate agreement
  (BAA)** and a **42 CFR Part 2 qualified service organization agreement (QSOA)** between the tenant and the operator.
  SUDS holds Part 2 records; a BAA alone does not allow the operator to receive them. Drafts:
  [docs/market/templates/BAA-QSOA-DRAFT.md](../../docs/market/templates/BAA-QSOA-DRAFT.md) (counsel must review them).
  The owner records both in the tenant record (`BAA_STATUS`, `QSOA_STATUS`); the provisioning run warns while either is
  blank.
- **The AWS BAA covers the infrastructure only** (Lightsail, its disks and snapshots, under the operator's account). It
  is not an agreement with the tenant and does not replace either agreement above.
- **Isolation is between tenants, not from the operator.** Each tenant has its own VM, disks, database, keys and name,
  so one tenant's staff, data or compromise does not reach another's. But the operator holds root on every VM and an
  escrowed copy of every tenant's keys: the operator *can* decrypt every tenant's records. Sales material and agreement
  wording must say exactly that, for example: *"Your SUDS server is a separate virtual machine with its own encryption
  keys; no other customer's server can reach it. As your service provider we hold administrative access and an
  escrowed copy of your keys, used only as our agreement allows, and every use of the escrow is logged."* Never
  "zero-knowledge", "we cannot see your data" or "end-to-end encrypted".
- **AugustInnovations LLC operates the fleet** and signs each tenant's BAA and QSOA (owner decision of 2026-10-09).
  It is the licensor (`LICENSE`), so no separate licence for hosted operation is needed; were any other company ever to
  operate it, that company would need a written licence from AugustInnovations LLC first (`LICENSE` section 3). The
  customer-facing agreement is the draft [licence and subscription agreement](../../docs/market/templates/LICENCE-AND-SUBSCRIPTION-AGREEMENT-DRAFT.md),
  with the BAA and QSOA as its exhibits (all for counsel). [docs/market/HOSTING.md](../../docs/market/HOSTING.md) lists what else must exist before a
  hosted service is offered.
- **LUKS before real data.** The provisioning run fails unless `/var/lib/suds` is on a LUKS (dm-crypt) volume.
  `--allow-unencrypted-demo` downgrades that to a loud warning for a demonstration tenant, and records `DEMO_ONLY=yes`
  in the tenant record: such a tenant must never hold a real client's record.

### Limits to know (and to state to a tenant)

- **The "offsite" disk is not off-site.** It is a second Lightsail disk in the same availability zone, attached to the
  same VM: it satisfies install.sh's share checks and survives losing the data disk, not losing the zone or the
  account. For real data add a copy that leaves the VM and the zone (scheduled disk snapshots copied to another region,
  or object storage with object lock) — an owner decision ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md), §4a).
- **The anchor disk is not write-once.** It holds the audit anchors outside `/var/lib/suds`, but root can rewrite it;
  object storage with object lock is the WORM option ([security/LOGGING-AND-AUDIT.md](../../docs/security/LOGGING-AND-AUDIT.md)).
- **The LUKS key file is on the root disk** (`/etc/suds-luks`, root only), so the volume opens unattended at boot. It
  protects a detached data disk, a disk snapshot, or a disk image on its own; it does not protect against whoever
  holds the running VM or its root disk. It is escrowed with the SUDS keys.

## Prerequisites (once)

1. **The private ops directory.** On the operator's machine (Linux or macOS with bash 4+, `aws` CLI v2, `curl`, `ssh`,
   `scp`, `gpg`):
   ```bash
   mkdir -m 0700 ~/suds-ops && cd ~/suds-ops && git init
   mkdir -m 0700 tenants register escrow credentials keys releases
   printf '%s\n' 'escrow/*/' credentials/ keys/ releases/ > .gitignore    # escrow/access.log stays in git
   export FLEET_HOME=~/suds-ops
   ```
   Push it, if at all, to a **private** repository the owner controls, never to this one.
2. **AWS.** An IAM user or role in the owner's account limited to Lightsail (`lightsail:*`), with MFA;
   `aws configure --profile suds-fleet` and `export AWS_PROFILE=suds-fleet`. The AWS BAA accepted in AWS Artifact
   (done on 2026-10-08 for the account that runs suds.systems; the account must be the operator's, AugustInnovations
   LLC's). A Lightsail key pair in each region used:
   `aws lightsail create-key-pair --region us-west-2 --key-pair-name suds-fleet --query privateKeyBase64 --output text > keys/suds-fleet.pem && chmod 0600 keys/suds-fleet.pem`.
3. **Porkbun.** In the Porkbun account, *API Access* on for the zone (`suds.systems`) and an API key:
   `credentials/porkbun.env` with `PORKBUN_API_KEY=pk1_…` and `PORKBUN_SECRET_API_KEY=sk1_…`, `chmod 0600`. The scripts
   send both in the JSON body on stdin, never on a command line or in a log.
4. **The escrow key.** A gpg key pair the owner controls, its private half offline (a hardware token, or an offline
   machine with a paper backup), its public half in the operator's keyring:
   `gpg --quick-generate-key "SUDS key escrow" default default 3y`, then `gpg --export --armor <fingerprint>` to the
   operator machine and `gpg --import`. Its 40-hex fingerprint goes in `ESCROW_GPG_RECIPIENT`. Keys are encrypted to it
   as they leave the VM: they never touch the operator's disk in the clear.
5. **The release.** `suds-v<version>.zip` from the GitHub Release into `releases/`; its SHA-256 from the Release notes
   **and** the version's CHANGELOG section on `main` (they must agree) into `RELEASE_SHA256`.

## Provision a tenant

1. `cp deploy/fleet/tenant.env.example "$FLEET_HOME/tenants/<slug>.env"` and fill it. `ADMIN_CIDR`/`ADMIN_CIDR6` are
   the networks you run the scripts from (`curl -4 https://checkip.amazonaws.com`); install.sh refuses to run if this
   SSH session comes from outside `ADMIN_CIDR` (or over IPv6, unless `ADMIN_CIDR6` is `::/0`).
2. **Dry run:** `deploy/fleet/provision-tenant.sh "$FLEET_HOME/tenants/<slug>.env"`. It prints every step and command
   and calls nothing. Read it.
3. **Only with the owner's go** (it creates billable resources): the same command with `--apply`. In order:
   - **0. Preflight**: the tools; the zip against `RELEASE_SHA256`; the escrow key in the keyring (*no escrow, no
     go-live*: nothing is created without it); the Porkbun credentials.
   - **1–4. Lightsail**: the instance (Ubuntu 24.04, dual-stack), the static IP, the data, offsite and anchor disks,
     and the Lightsail firewall (443 and 80 open; 22 only from the two admin networks) — each waited for and checked
     (running, attached, exact open ports) before the next.
   - **5. DNS**: A records for the name (and `www.` with `WWW_REDIRECT=yes`) at Porkbun, created or updated, then
     checked through DNS-over-HTTPS (`https://dns.google/resolve`), not this machine's resolver. A county's own domain:
     the run prints the record to create and waits until DNS-over-HTTPS shows it.
   - **6. The VM**: SSH, the zip and `prepare-host.sh` copied over, the zip's SHA-256 checked again on the VM, the data
     disk made a LUKS2 volume at `/var/lib/suds` (and `suds.service` made to require that mount), the share disks at
     `/mnt/suds-offsite` and `/mnt/suds-anchors`.
   - **7. install.sh** with `--domain`, `--admin-cidr`, `--admin-cidr6`, `--offsite`, `--anchors`, `--tls=caddy`,
     `--version`, `--source` and `--release-sha256` (and `--www-redirect`, `--acme-email` when set). install.sh adds the
     IPv6 SSH rule itself (from 1.25.4, so `SUDS_VERSION` must be 1.25.4 or later), and keeps it on every re-run.
   - **8. Asserts** — each failure fails the run (exit 1, `STATUS=failed-asserts`, nothing escrowed, no go-live):
     a **brand-new SSH connection succeeds after the install session has closed** (the launch-day lock-out only showed
     in the next connection); `ufw status` allows port 22 on **IPv4 and IPv6**; `systemctl is-active suds caddy`;
     HTTPS 200 from outside on the name; `/version.json` is `SUDS_VERSION`; `/var/lib/suds` on LUKS/dm-crypt
     (fail-closed); with `WWW_REDIRECT=yes`, `Caddyfile.d/www-redirect.caddy` exists and `www.` answers 301/308 to the
     name. If the fresh SSH connection fails, the host firewall has locked SSH out (the Lightsail browser terminal uses
     the same port): no data is live yet, so tear the tenant down and provision it again, after recording an export
     receipt that says so (`EXPORT_FILE=none-never-live`, `EXPORT_SHA256` of an empty file,
     `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
   - **9. Key escrow**: `/etc/suds/credentials` and the LUKS key, streamed from the VM straight into `gpg --encrypt`
     for the owner, written to `escrow/<slug>/keys-<time>.tar.gpg` (0400), its SHA-256 in the record and in
     `escrow/access.log`. Copy it to the owner's offline escrow medium the same day.
   - **10. The record** (`STATUS=active`) and **first sign-in**: open `https://<name>`, sign in as **`guest`** with the
     temporary password in `/var/lib/suds/first-admin-password.txt` on the VM (`sudo cat` it once; the run never prints
     it), change it, enrol two-step verification.
4. A failed run is safe to repeat after the fix: what exists is kept (instance, IP, disks, records), install.sh is
   idempotent, a mounted disk is never formatted again.

## Key escrow

- `escrow.sh open <slug> --reason "why; the ticket or incident"` logs who, when and why in `escrow/access.log`
  **before** decrypting, checks the file against `ESCROW_SHA256`, decrypts into a new private temporary directory (the
  owner's private key must be available to gpg) and logs the result; it prints the `shred` command for when you are
  done. A replaced or unreadable file is refused and the attempt logged.
- `escrow.sh verify` checks the hash chain of `escrow/access.log` and every `register/<slug>.log` (each line carries the
  SHA-256 of the line before it) and prints each chain's newest hash. Keep that hash somewhere else too (the ops
  repository's commit history does): a chain cannot show its own last lines being cut off.
- Restore with escrowed keys: put each `suds_*` file back in `/etc/suds/credentials` (root 0600) per
  [docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md), *Backup and restore*; the LUKS key opens the data disk attached to
  a new VM.

## The drill tenant (`drill.suds.systems`)

Prove the whole pipeline before the first real tenant, and again after any change to these scripts, with the owner's
credentials and go:

1. `tenants/drill.env` from the example: `TENANT_SLUG=drill`, `WWW_REDIRECT=yes`, the admin networks, the region,
   `SUDS_VERSION` and `RELEASE_SHA256`, `ESCROW_GPG_RECIPIENT`.
2. Dry run, read it; then `--apply`. Every assert must pass (`STATUS=active`, `LUKS=yes`, no `--allow-unencrypted-demo`).
3. Sign in as `guest`, change the password, enrol two-step verification; check Settings › Security status.
4. `escrow.sh open drill --reason "drill: prove the escrow opens"`, compare the opened `suds_*` file names with
   `sudo ls /etc/suds/credentials` on the VM, shred the opened copy; `escrow.sh verify`.
5. Export something from the drill server (Reports, or a backup file), and fill the receipt in `register/drill.env`:
   `EXPORT_FILE`, `EXPORT_SHA256` (`sha256sum`), `EXPORT_CONFIRMED_ON` (today).
6. `decommission-tenant.sh tenants/drill.env` (dry run), then `--apply`, typing `drill` and then `DESTROY`.
7. Check nothing is left: `aws lightsail get-instances`, `get-disks`, `get-static-ips`, `get-instance-snapshots`,
   `get-disk-snapshots`; `https://dns.google/resolve?name=drill.suds.systems&type=A` has no answer. `escrow.sh verify`;
   commit the register and the access log to the ops repository.

## Upgrades

One tenant at a time, never all at once: the drill tenant (or the smallest tenant) first, then each tenant after the
previous one has run cleanly for a day. Per tenant, follow docs/SELF-HOSTING.md, *Upgrading*, with
[`deploy/linux/upgrade.sh`](../linux/upgrade.sh) (stage, verify, back up, swap, health check, roll back on failure):
copy the new zip to the VM (`scp`), then
`sudo /opt/suds/current/deploy/linux/upgrade.sh <version> --source=<zip> --release-sha256=<hex>`. Then set
`SUDS_VERSION` and `RELEASE_SHA256` in the tenant's settings file **and** its record, and run
`provision-tenant.sh --apply` again: it changes nothing that exists and re-checks every assert, including
`/version.json`, and takes a fresh escrow copy. `provision-tenant.sh` refuses a `SUDS_VERSION` that differs from the
record's: an upgrade never goes through install.sh.

## Teardown

`decommission-tenant.sh` is **irreversible**: no one can restore the tenant afterwards. It refuses unless the tenant's
record has an **export receipt** — `EXPORT_FILE` (where the export delivered to the tenant is), `EXPORT_SHA256`, and
`EXPORT_CONFIRMED_ON`, the date the tenant confirmed they had checked it (Medi-Cal and county retention rules can
require the records for years: the tenant keeps them, from that export) — and, with `--apply`, unless you type the
tenant's slug and then `DESTROY` at two separate prompts. It then deletes the DNS records first (so the name never
points at a released address), every snapshot of the instance and its disks, the instance, the disks and the static IP,
each checked gone; shreds `escrow/<slug>/`; and appends a hashed note to the tenant's history and the escrow log
(`STATUS=decommissioned`). Destroy every offline copy of the escrow file too, and record who did it and when in the
tenant record. Keep the escrow ciphertext out of git: a file in a repository's history cannot be shredded.
