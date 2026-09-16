#!/bin/bash
# Linux launcher (double-click and choose "Run in terminal", or run from a terminal).
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then echo "Node.js 22+ is required: https://nodejs.org"; exit 1; fi
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" || { echo "SUDS needs Node.js 22 or newer."; exit 1; }
export SUDS_ENV=production
if [ -f data/server.json ]; then URL=$(node -e "const c=require('./data/server.json');console.log((c.tls&&c.tls!=='none'?'https':'http')+'://localhost:'+(c.port||8080)+'/')"); else URL=http://localhost:8080/; fi
(sleep 2; xdg-open "$URL" >/dev/null 2>&1) &
echo "Starting SUDS at $URL — keep this window open; press Ctrl+C to stop."
node --no-warnings=ExperimentalWarning server/index.js
