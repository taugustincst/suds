#!/bin/bash
# Host side: start one systemd container for the installer run. $1: container name; $2: its directory (shares);
# $3: the release prepare.sh unpacks. As the 1.23.0 run's start.sh: the image suds-vm-ubuntu2404 built from
# ../../installer-container-run-2026-09-30/environment/Dockerfile, no network, this folder's files/ mounted read-only.
set -euo pipefail
V=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$V/$2/offsite" "$V/$2/anchors"
docker run -d --name "$1" --privileged --network none --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock -v "$V/files:/root/files:ro" -v "$V/$2/offsite:/mnt/suds-offsite" \
  -v "$V/$2/anchors:/mnt/worm/suds-anchors" suds-vm-ubuntu2404 >/dev/null
for i in $(seq 1 30); do docker exec "$1" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
docker exec "$1" systemctl is-system-running || true
docker exec "$1" /root/files/prepare.sh "$3"
