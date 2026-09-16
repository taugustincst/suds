#!/bin/bash
# macOS launcher: double-click in Finder. (If macOS says it cannot be opened, right-click → Open once.)
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Opening https://nodejs.org — download the LTS installer, run it, then double-click Start-SUDS.command again."
  open https://nodejs.org; read -p "Press Enter to close"; exit 1
fi
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" || { echo "SUDS needs Node.js 22 or newer. Update from https://nodejs.org"; read -p "Press Enter to close"; exit 1; }
export SUDS_ENV=production
echo "Starting SUDS... keep this window open while using the app. Close it to stop SUDS."
URL=$(node scripts/print-url.js)
(sleep 2; open "$URL") &
node --no-warnings=ExperimentalWarning server/index.js
