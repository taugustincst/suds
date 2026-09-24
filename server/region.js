'use strict';
// Starter resource directories for a whole region: a curated list of real programs a county can load in one
// click instead of typing the directory from scratch. Entries arrive UNVERIFIED on purpose — they carry no
// verification date and a provenance note — so staff confirm each one in the app before giving details to a client.
const db = require('./db');
const C = require('./constants');
const audit = require('./audit');
const png = require('./png');
const { uuid } = require('./crypto');
const config = require('./config');
const pictures = require('./region-pictures');

const REGIONS = pictures.REGIONS;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tagList = (list, allowed) => (Array.isArray(list) ? list : String(list || '').split(',')).map(x => String(x).trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(x => allowed.includes(x)).filter((x, i, a) => a.indexOf(x) === i).join(',');
const stateKey = (id) => `region_loaded:${id}`;
const readState = (id) => { try { return JSON.parse(db.getSetting(stateKey(id), 'null')) || null; } catch { return null; } };

function provenance(region) { return `Imported from the ${region.name} starter directory on {DATE} using public web sources. Nobody has confirmed it with the provider yet. Call to confirm the address, phone number, hours and intake, then press "Verified today". Check phone numbers against the provider's own contact page: commercial rehab directories often substitute their own call-centre numbers.`; }

function list() {
  return Object.values(REGIONS).map(r => {
    const st = readState(r.id);
    const ids = st ? Object.values(st.ids) : [];
    const present = ids.length ? db.one(`SELECT COUNT(*) n FROM resources WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).n : 0;
    return { id: r.id, name: r.name, description: r.description, counties: r.counties, provider_count: r.providers.length, sources_note: r.sources_note,
      loaded: !!st, loaded_at: st ? st.at : null, present, unverified: ids.length ? db.one(`SELECT COUNT(*) n FROM resources WHERE last_verified_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, ...ids).n : 0 };
  });
}

/** Insert missing programs and enrich existing ones. Never overwrites a value a human already entered. */
function load({ regionId, actor, withPictures = true }) {
  const region = REGIONS[regionId]; if (!region) throw new Error('Unknown region');
  const today = new Date().toISOString().slice(0, 10);
  const note = provenance(region).replace('{DATE}', today);
  const prev = readState(regionId); const ids = prev ? { ...prev.ids } : {};
  let added = 0, enriched = 0, unchanged = 0, pictures = 0;
  // name+city -> id, for adopting a provider the county has already entered by hand.
  const existingByName = new Map();
  db.transaction(() => {
    for (const r of db.all(`SELECT id, name, city FROM resources`)) existingByName.set(`${norm(r.name)}|${norm(r.city)}`, r.id);
    for (const p of region.providers) {
      const row = {
        name: p.name, category: C.RESOURCE_CATEGORIES.includes(p.category) ? p.category : 'other', organization: p.organization || null,
        phone: p.phone || null, email: p.email || null, website: p.website || null, address: p.address || null, city: p.city || null, zip: p.zip || null,
        hours: p.hours || null, eligibility: p.eligibility || null, services: p.services || null, languages: p.languages || null,
        accepts_medicaid: p.accepts_medicaid ? 1 : 0, accepts_uninsured: p.accepts_uninsured ? 1 : 0, mat_offered: p.mat_offered || null,
        capacity_notes: p.capacity_notes || null, contact_person: p.contact_person || null, summary: p.summary || null,
        service_tags: tagList(p.service_tags, C.SERVICE_TAGS), populations: tagList(p.populations, C.POPULATIONS),
        levels_of_care: p.levels_of_care || null, intake_process: p.intake_process || null, cost_notes: p.cost_notes || null,
      };
      let id = ids[p.key] && db.one(`SELECT id FROM resources WHERE id=?`, ids[p.key]) ? ids[p.key] : null;
      if (!id) { // adopt a resource someone already created with the same name in the same city
        // Built once outside the loop: this used to be a full table scan per provider, so loading the
        // 81-provider starter directory scanned the resources table 81 times.
        const hit = existingByName.get(`${norm(p.name)}|${norm(p.city)}`);
        if (hit) id = hit;
      }
      if (!id) {
        id = uuid(); const keys = Object.keys(row);
        db.run(`INSERT INTO resources(id,${keys.join(',')},notes) VALUES(?,${keys.map(() => '?').join(',')},?)`, id, ...keys.map(k => row[k]), [note, p.caveat ? `Check before referring: ${p.caveat}` : null].filter(Boolean).join('\n\n'));
        added++;
      } else {
        const cur = db.one(`SELECT * FROM resources WHERE id=?`, id);
        const sets = []; const params = [];
        for (const [k, v] of Object.entries(row)) {
          if (v === null || v === '' || k === 'accepts_medicaid' || k === 'accepts_uninsured') continue;
          if (cur[k] === null || cur[k] === '' || cur[k] === undefined) { sets.push(`${k}=?`); params.push(v); }
        }
        if (!String(cur.notes || '').includes('starter directory')) { sets.push('notes=?'); params.push([cur.notes, note, p.caveat ? `Check before referring: ${p.caveat}` : null].filter(Boolean).join('\n\n')); }
        if (sets.length) { db.run(`UPDATE resources SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, db.now(), id); enriched++; } else unchanged++;
      }
      ids[p.key] = id;
      if (withPictures && !db.one(`SELECT COUNT(*) n FROM resource_photos WHERE resource_id=?`, id).n) {
        const full = png.initialsCard(p.name, row.category, 960, 540); const thumb = png.initialsCard(p.name, row.category, 320, 180);
        db.run(`INSERT INTO resource_photos(id,resource_id,caption,content_type,bytes,width,height,data_b64,thumb_b64,sort_order,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?,0,?)`,
          uuid(), id, `${p.name} (placeholder — replace with a photo of the site)`, 'image/png', full.length, 960, 540, full.toString('base64'), thumb.toString('base64'), actor || null);
        pictures++;
      }
    }
    db.setSetting(stateKey(regionId), JSON.stringify({ at: db.now(), ids }));
    audit.log({ user: actor ? { id: actor, username: 'region-import' } : { id: null, username: 'region-import' }, action: 'region.load', details: { region: regionId, added, enriched, unchanged, pictures } });
  });
  return { added, enriched, unchanged, pictures, total: region.providers.length };
}

/** Programs in a loaded region whose own website we could look at for a logo or photo. */
function pictureTargets(regionId) {
  if (!REGIONS[regionId]) throw new Error('Unknown region');
  const st = readState(regionId); if (!st) return [];
  return pictures.regionTargets(regionId).filter(t => st.ids[t.key]).map(t => ({ ...t, id: st.ids[t.key], region: regionId }))
    .map(t => { const r = db.one(`SELECT id, category FROM resources WHERE id=?`, t.id); return r ? { ...t, category: t.category || r.category } : null; })
    .filter(Boolean);
}

/**
 * Downloaded pictures still waiting for a real thumbnail. The browser makes those (on a canvas, as for a
 * photo someone adds by hand) and saves them with PUT /api/resources/:id/photos/:pid — the server cannot
 * resize a JPEG without a dependency. Until then the card shows the picture itself; pictures downloaded
 * before this was fixed carry the generated card as their thumbnail, which is why those count here too.
 */
function picturesNeedingThumbnails(regionId) {
  const ids = pictureTargets(regionId).map(t => t.id); if (!ids.length) return [];
  return db.all(`SELECT p.id AS photo_id, p.resource_id FROM resource_photos p WHERE p.resource_id IN (${ids.map(() => '?').join(',')}) AND p.caption LIKE 'From %'
    AND (p.thumb_b64 IS NULL OR p.thumb_b64 IN (SELECT q.thumb_b64 FROM resource_photos q WHERE q.resource_id=p.resource_id AND q.caption LIKE '%(placeholder%'))`, ...ids);
}

// ---- the static "SUDS on this device" build ----
// A browser cannot read a provider's website: the sites send no CORS headers, a manual redirect comes
// back opaque and User-Agent is a forbidden header, so every download used to fail. That build carries
// the pictures with it instead, fetched when the site is built (scripts/fetch-region-pictures.js) and
// served from its own origin under region-pictures/<region>/, and the kernel reads them from there.
const manifests = new Map();
function bundleBase(regionId) { return new URL(`region-pictures/${encodeURIComponent(regionId)}/`, globalThis.location.href); }
function bundledManifest(regionId) {
  if (!manifests.has(regionId)) {
    const p = (async () => {
      let res; try { res = await fetch(new URL('manifest.json', bundleBase(regionId)).href, { cache: 'no-cache' }); } catch { res = null; }
      if (!res || !res.ok) return null;
      try { const m = await res.json(); return m && m.pictures && typeof m.pictures === 'object' ? m : null; } catch { return null; }
    })();
    manifests.set(regionId, p);
    // A failed read is not remembered: the next click tries again (the phone may have been offline).
    p.then((m) => { if (!m) manifests.delete(regionId); });
  }
  return manifests.get(regionId);
}
const NOT_IN_BUILD = 'not available on this device build (it was published without a picture for this program)';
async function bundledPicture(target) {
  const manifest = await bundledManifest(target.region);
  if (!manifest) return { ok: false, error: 'provider pictures are not available on this device build (none were included when it was published)', bundle: 'missing' };
  const entry = manifest.pictures[target.key];
  if (!entry || typeof entry.file !== 'string') return { ok: false, error: NOT_IN_BUILD };
  const base = bundleBase(target.region); const file = new URL(entry.file, base);
  // Only a file beside the manifest, on this site's own origin.
  if (file.origin !== base.origin || !file.pathname.startsWith(base.pathname)) return { ok: false, error: NOT_IN_BUILD };
  let res; try { res = await fetch(file.href); } catch { return { ok: false, error: 'this device could not load the picture from the SUDS site; check the connection and try again' }; }
  if (!res.ok) return { ok: false, error: NOT_IN_BUILD };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > pictures.MAX_PICTURE_BYTES) return { ok: false, error: 'file is too large' };
  const type = pictures.sniff(buf); if (!type) return { ok: false, error: 'not a JPEG, PNG or WebP picture' };
  return { ok: true, buf, type, url: /^https:\/\//.test(entry.source_url || '') ? entry.source_url : file.href };
}
const isStaticBuild = () => { try { return globalThis.SUDS_STATIC_HOST === true; } catch { return false; } };
// A thumbnail stays within the upload route's limit; a small logo can be its own thumbnail.
const MAX_THUMB_BYTES = 96 * 1024;

/** Downloads a provider picture and makes it the resource's main picture. */
async function fetchPicture(target, { actor, timeoutMs = 12000, deadline = 0 } = {}) {
  let got;
  if (config.local) {
    // An offline copy that syncs with an office server receives the office's pictures at its next sync;
    // the static build reads the ones it was published with. Neither can reach a provider's website.
    got = isStaticBuild() ? await bundledPicture(target)
      : { ok: false, error: 'download provider pictures on the office server; they reach this device at its next sync' };
  } else {
    got = await pictures.downloadPicture(target, { timeoutMs, deadline });
  }
  if (!got.ok) { const { buf: _unused, ...rest } = got; return { key: target.key, ...rest }; }
  const { buf, type, url } = got;
  const photoId = uuid();
  db.transaction(() => {
    // Reordering is a change devices need to see, so it bumps updated_at like any other edit.
    db.run(`UPDATE resource_photos SET sort_order = sort_order + 1, updated_at=? WHERE resource_id=?`, db.now(), target.id);
    // The generated card is no longer stored as this picture's thumbnail: the card is what the directory
    // shows, so a successful download looked exactly like one that had done nothing. A small picture is
    // its own thumbnail; a larger one has none until the browser makes one (the result carries photo_id
    // for that), and meanwhile the directory shows the picture itself (server/routes/resources.js).
    db.run(`INSERT INTO resource_photos(id,resource_id,caption,content_type,bytes,data_b64,thumb_b64,sort_order,uploaded_by) VALUES(?,?,?,?,?,?,?,0,?)`,
      photoId, target.id, `From ${new URL(url).hostname}`, type, buf.length, buf.toString('base64'), buf.length <= MAX_THUMB_BYTES ? buf.toString('base64') : null, actor || null);
    db.run(`UPDATE resources SET updated_at=? WHERE id=?`, db.now(), target.id);
  });
  audit.log({ user: { id: actor, username: 'region-import' }, action: 'region.picture', entity: 'resource', entityId: target.id, details: { url, bytes: buf.length, type } });
  return { key: target.key, ok: true, bytes: buf.length, type, url, photo_id: photoId, resource_id: target.id };
}

/** Removes programs this import added that nobody has used or edited. */
function remove({ regionId, actor }) {
  const st = readState(regionId); if (!st) return { removed: 0, kept: 0 };
  let removed = 0, kept = 0;
  db.transaction(() => {
    for (const id of Object.values(st.ids)) {
      const r = db.one(`SELECT id, last_verified_at FROM resources WHERE id=?`, id); if (!r) continue;
      const used = db.one(`SELECT COUNT(*) n FROM referrals WHERE resource_id=?`, id).n;
      if (used || r.last_verified_at) { db.run(`UPDATE resources SET is_active=0, updated_at=? WHERE id=?`, db.now(), id); kept++; continue; }
      db.run(`DELETE FROM resource_photos WHERE resource_id=?`, id);
      db.run(`DELETE FROM resources WHERE id=?`, id); db.tombstone('resources', id); removed++;
    }
    db.run(`DELETE FROM settings WHERE key=?`, stateKey(regionId));
    audit.log({ user: { id: actor, username: 'region-import' }, action: 'region.remove', details: { region: regionId, removed, kept } });
  });
  return { removed, kept };
}
module.exports = { REGIONS, list, load, remove, pictureTargets, picturesNeedingThumbnails, fetchPicture, pickImageUrl: pictures.pickImageUrl };
