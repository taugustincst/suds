'use strict';
// Downloads each starter-directory provider's own picture (its social preview image or touch icon) into a
// folder, with a manifest, so the static "SUDS on this device" build can carry them: a browser cannot fetch
// them from the providers' websites itself (no CORS headers on those sites). scripts/build-static-site.js
// runs this into <site>/region-pictures/; the in-browser kernel reads them from there when someone presses
// "Download provider pictures" (server/region.js, bundledPicture).
//
// Same target list, picture choice, address checks and file-type check as the office server's own download
// (server/region-pictures.js). Best effort: a site that fails is listed in the manifest's `failures` and
// skipped; nothing here ever fails a build. With no network at all it writes nothing and says so.
//
// The pictures are build output, not repository content (.gitignore): they are other organisations' logos
// and photos, they change, and committing a few megabytes of them on every refresh would bloat the history.
//
// Usage: node scripts/fetch-region-pictures.js [out-dir]    (default: _region-pictures)
//        npm run fetch-region-pictures
// Behind a proxy, Node's fetch needs NODE_USE_ENV_PROXY=1 as well as HTTPS_PROXY (Node 22.21 or later).
const fs = require('node:fs');
const path = require('node:path');
const pictures = require('../server/region-pictures');

/**
 * Fetches every region's pictures into outDir/<region>/. Resolves to a summary; never rejects.
 * `budgetMs` bounds the whole run, so a build on a network that swallows connections still finishes.
 */
async function fetchAll({ outDir, concurrency = 6, timeoutMs = 12000, budgetMs = 180000, log = console.log } = {}) {
  const deadline = Date.now() + budgetMs;
  const summary = { regions: {}, bundled: 0, tried: 0 };
  for (const regionId of Object.keys(pictures.REGIONS)) {
    const targets = pictures.regionTargets(regionId);
    const entries = {}; const failures = {};
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const t = targets[next++];
        const got = await pictures.downloadPicture(t, { timeoutMs, deadline });
        if (got.ok) entries[t.key] = got; else failures[t.key] = got.error;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    const keys = Object.keys(entries).sort();
    const dir = path.join(outDir, regionId);
    fs.rmSync(dir, { recursive: true, force: true });
    if (keys.length) {
      fs.mkdirSync(dir, { recursive: true });
      const fetchedAt = new Date().toISOString();
      const manifest = { region: regionId, fetched_at: fetchedAt, pictures: {}, failures };
      for (const key of keys) {
        const { buf, type, url } = entries[key];
        const file = `${key.replace(/[^a-z0-9-]/gi, '_')}.${pictures.EXT[type]}`;
        fs.writeFileSync(path.join(dir, file), buf);
        manifest.pictures[key] = { file, content_type: type, bytes: buf.length, source_url: url, fetched_at: fetchedAt };
      }
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
    }
    summary.regions[regionId] = { bundled: keys.length, tried: targets.length, failures };
    summary.bundled += keys.length; summary.tried += targets.length;
    const reasons = {}; for (const e of Object.values(failures)) reasons[e] = (reasons[e] || 0) + 1;
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e, n]) => `${n}× ${e}`).join('; ');
    log(`[suds] region pictures, ${regionId}: ${keys.length} of ${targets.length} bundled${top ? ` (not bundled: ${top})` : ''}`);
  }
  return summary;
}

if (require.main === module) {
  const outDir = path.resolve(path.join(__dirname, '..'), process.argv[2] || '_region-pictures');
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
    console.log('[suds] HTTPS_PROXY is set: run with NODE_USE_ENV_PROXY=1 as well, or Node will not use the proxy.');
  }
  fetchAll({ outDir }).then((s) => { console.log(`[suds] ${s.bundled} of ${s.tried} provider pictures written to ${outDir}`); });
}
module.exports = { fetchAll };
