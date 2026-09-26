# Pinned to a minor line, not a floating major: a rebuild picks up patch releases of the same runtime, never a
# surprise minor. Bump deliberately, together with .nvmrc and the CI check.
#
# No `npm install` anywhere: SUDS has no runtime dependencies (CLAUDE.md), so the image is Node plus the
# source, and nothing from the npm registry. Runs as a non-root user; docker-compose.yml also makes the root
# filesystem read-only, drops every capability and forbids privilege escalation. Everything SUDS writes goes
# to /data (database, backups, logs, keys.json when keys are not in the environment) and /anchors (audit
# anchors — mount write-once storage there; docs/security/LOGGING-AND-AUDIT.md).
FROM node:26.10-alpine
ENV NODE_ENV=production SUDS_ENV=production HOST=0.0.0.0 PORT=8080 SUDS_DATA_DIR=/data AUDIT_ANCHOR_DIR=/anchors
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
# The application files belong to root and are read-only to the service user: a compromised process cannot
# rewrite the code it runs. Only /data and /anchors are writable by it.
RUN addgroup -S suds && adduser -S suds -G suds && mkdir -p /data /anchors && chown suds:suds /data /anchors && chmod 700 /data /anchors \
 && chmod -R a-w /app
USER suds
VOLUME ["/data", "/anchors"]
EXPOSE 8080
# Run with an init process as PID 1: `init: true` in docker-compose.yml, or `docker run --init` (Docker's own
# tini; nothing is added to this image). Without one node is PID 1: SIGTERM needs explicit handling and zombie
# children are not reaped. The instance lock (server/instance-lock.js) is safe either way — a stale lock that
# names this process's own pid, after a kill or power loss, is taken over rather than crash-looping.
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health > /dev/null || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
