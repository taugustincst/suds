# deploy/docker — the container path, where it differs from SUDS Server on a VM

`Dockerfile` and `docker-compose.yml` at the repository root are the container deployment ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md),
*Docker*). The image already runs SUDS as a non-root user with a read-only root filesystem, no capabilities and
`no-new-privileges`, behind Caddy with the same `Caddyfile` the Linux installer uses (TLS 1.2+, HSTS). This page covers
only what the Linux installer ([deploy/linux](../linux/README.md)) guarantees and a container cannot, because it belongs
to the host.

| Control | On a VM (install.sh) | In a container: yours, on the host |
| --- | --- | --- |
| Disk encryption | Refuses to install unless `/var/lib/suds` is on LUKS | Put the `suds-data` volume (and Docker's data root) on an encrypted disk: LUKS, BitLocker, or a cloud disk with a customer-managed key. Nothing inside the container can see or enforce it |
| Host firewall | ufw / firewalld: 443 (80), SSH from the admin network | The host's firewall; note Docker publishes ports around ufw's rules (use `DOCKER-USER` chain rules or bind `ports:` to a specific address) |
| Time sync, security updates, journal retention | Configured and checked | The host's, and the base images': rebuild and pull regularly (`node:22.x-alpine`, `caddy:2.x-alpine` are pinned to a minor line) |
| Keys | Root-only files loaded by `LoadCredential=` | **Docker secrets or files, not `.env`** — below |
| Weekly compliance check | `suds-compliance.timer` | Host checks do not apply inside a container; run `docker compose exec suds node scripts/compliance-check.js --no-host` for the app-level checks and a signed report, and record the host's controls by your own means |

## Keys as secrets, not environment variables

`.env` puts the keys into the container's environment, where `docker inspect`, a crash dump or anything that can read
`/proc/<pid>/environ` sees them. SUDS reads every secret from a file instead when `<NAME>_FILE` names one
(server/config.js): `SUDS_ENCRYPTION_KEY_FILE`, `SUDS_INDEX_KEY_FILE`, `SUDS_BACKUP_KEY_FILE`, `SUDS_SIGNING_KEY_FILE`,
`METRICS_TOKEN_FILE`, `OIDC_CLIENT_SECRET_FILE`, `MS_CLIENT_SECRET_FILE`, `ANTHROPIC_API_KEY_FILE`. The value is read once
and never copied into the process environment.

Use [docker-compose.secrets.yml](docker-compose.secrets.yml) as an override:

```bash
sudo install -d -m 0700 /etc/suds/credentials
for k in suds_encryption_key suds_index_key suds_backup_key suds_signing_key; do
  sudo sh -c "umask 077; od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > /etc/suds/credentials/$k"
done
# Compose (without Swarm) bind-mounts file secrets with the host file's owner and mode. The image runs SUDS as
# uid/gid 10001 (Dockerfile), a number reserved for it that is no account on the host: only it can read them.
getent passwd 10001 && echo "uid 10001 is taken on this host: pick another and rebuild with it" >&2
sudo chown 10001:10001 /etc/suds/credentials/suds_*; sudo chmod 0400 /etc/suds/credentials/suds_*
docker compose -f docker-compose.yml -f deploy/docker/docker-compose.secrets.yml up -d
```

and remove the keys from `.env`. Never hand the key files to the uid a `docker compose run ... id -u` happens to
print (Alpine's system users are small numbers, and 1000 is usually the first person's account on the host): that
host account could then read every key. 10001 is fixed in the `Dockerfile` for this reason; if it is taken on your
host, change it there and here, and keep it unused on the host.

**Upgrading an existing Docker install to the image with uid 10001** (earlier images used whatever uid Alpine's
`adduser -S` chose): the volumes still belong to the old uid, so hand them over once, with SUDS stopped:
`docker compose run --rm --no-deps --user root --entrypoint chown suds -R 10001:10001 /data /anchors`. Escrow the key files with your key custodian, as on a VM. Under Docker Swarm or
Kubernetes, use the platform's secrets (mounted under `/run/secrets/...`) with the same `*_FILE` variables.
