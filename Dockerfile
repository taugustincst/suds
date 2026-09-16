FROM node:22-alpine
ENV NODE_ENV=production SUDS_ENV=production HOST=0.0.0.0 PORT=8080 SUDS_DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
RUN addgroup -S suds && adduser -S suds -G suds && mkdir -p /data && chown -R suds:suds /data /app
USER suds
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/meta/constants > /dev/null || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
