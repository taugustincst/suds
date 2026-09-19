'use strict';
// Update checking: "is a newer release available", nothing more. Off by default — no request leaves this
// server unless an administrator both set UPDATE_FEED_URL and clicked "Check for updates". Actually
// applying an update is scripts/update.js, a separate CLI tool — a running server cannot safely overwrite
// the source files it is currently executing from.
const config = require('./config');

/**
 * Compare two dotted version strings numerically, segment by segment. Not full semver (no pre-release or
 * build metadata) — this project's own releases are plain X.Y.Z, which is all this needs to get right.
 * Returns >0 if a is newer than b, <0 if older, 0 if equal.
 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdate({ feedUrl = config.updateFeedUrl, currentVersion = config.version, fetchImpl = fetch } = {}) {
  if (!feedUrl) return { configured: false };
  const res = await fetchImpl(feedUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'suds-update-check' } });
  if (!res.ok) throw new Error(`Could not check for updates (HTTP ${res.status})`);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  if (!latest) throw new Error('The update feed did not report a version');
  return {
    configured: true,
    current: currentVersion,
    latest,
    available: compareVersions(latest, currentVersion) > 0,
    url: rel.html_url || null,
    published_at: rel.published_at || null,
  };
}

module.exports = { compareVersions, checkForUpdate };
