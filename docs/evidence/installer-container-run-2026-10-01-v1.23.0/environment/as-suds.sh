#!/bin/bash
# Run a SUDS script as the suds user with the service's own credentials (docs/SELF-HOSTING.md, "Backup and
# restore"), plus the escrowed key file as a credential of its own, readable only inside the transient unit.
unit=suds-ops
exec systemd-run --wait --pipe --collect --unit="$unit" --uid=suds --gid=suds --working-directory=/opt/suds/current \
  -p EnvironmentFile=/etc/suds/suds.env -E SUDS_ENV=production -E SUDS_DATA_DIR=/var/lib/suds \
  -p LoadCredential=suds_encryption_key:/etc/suds/credentials/suds_encryption_key \
  -p LoadCredential=suds_index_key:/etc/suds/credentials/suds_index_key \
  -p LoadCredential=suds_backup_key:/etc/suds/credentials/suds_backup_key \
  -p LoadCredential=suds_signing_key:/etc/suds/credentials/suds_signing_key \
  -p LoadCredential=escrow:/root/escrowed-keys.env \
  -p ReadWritePaths=/mnt/suds-offsite -p ReadWritePaths=/mnt/worm/suds-anchors \
  /opt/suds/node/bin/node --no-warnings=ExperimentalWarning "$@"
