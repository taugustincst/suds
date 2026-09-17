'use strict';
// Starter resource directories for a whole region: a curated list of real programs a county can load in one
// click instead of typing the directory from scratch. Entries arrive UNVERIFIED on purpose — they carry no
// verification date and a provenance note — so staff confirm each one in the app before giving details to a client.
const db = require('./db');
const C = require('./constants');
const audit = require('./audit');
const png = require('./png');
const { uuid } = require('./crypto');

const REGIONS = { 'sacramento-metro': require('./regions/sacramento-metro') };
const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
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
  db.transaction(() => {
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
        const hit = db.all(`SELECT id, name, city FROM resources`).find(r => norm(r.name) === norm(p.name) && norm(r.city) === norm(p.city));
        if (hit) id = hit.id;
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
  const region = REGIONS[regionId]; if (!region) throw new Error('Unknown region');
  const st = readState(regionId); if (!st) return [];
  return region.providers.filter(p => (p.image_url || p.website) && st.ids[p.key]).map(p => ({ key: p.key, id: st.ids[p.key], name: p.name, url: p.image_url || null, website: p.website }))
    .filter(t => db.one(`SELECT id FROM resources WHERE id=?`, t.id));
}
const sniff = (buf) => buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF ? 'image/jpeg'
  : buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 ? 'image/png'
  : buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;

/** Picks the picture a site advertises for itself: the social preview image, then the touch icon. */
function pickImageUrl(html, baseUrl) {
  const head = String(html).slice(0, 512 * 1024);
  const meta = (prop) => { const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i').exec(head); if (!m) return null; const c = /content=["']([^"']+)["']/i.exec(m[0]); return c ? c[1] : null; };
  const link = (rel) => { const m = new RegExp(`<link[^>]+rel=["'][^"']*${rel}[^"']*["'][^>]*>`, 'i').exec(head); if (!m) return null; const c = /href=["']([^"']+)["']/i.exec(m[0]); return c ? c[1] : null; };
  const candidate = meta('og:image') || meta('og:image:secure_url') || meta('twitter:image') || link('apple-touch-icon') || link('icon');
  if (!candidate) return null;
  try { const u = new URL(candidate, baseUrl); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}
async function get(url, { timeoutMs, maxBytes }) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { 'User-Agent': 'SUDS resource directory', Accept: '*/*' } });
  if (!res.ok) throw Object.assign(new Error(`site returned ${res.status}`), { soft: true });
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw Object.assign(new Error('file is too large'), { soft: true });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw Object.assign(new Error('file is too large'), { soft: true });
  return buf;
}

/** Downloads a provider picture from the provider's own website and makes it the resource's main picture. */
async function fetchPicture(target, { actor, timeoutMs = 12000 } = {}) {
  let url = target.url;
  try {
    if (!url) {
      if (!/^https:\/\//i.test(target.website || '')) return { key: target.key, ok: false, error: 'no website on file' };
      const html = await get(target.website, { timeoutMs, maxBytes: 2 * 1024 * 1024 });
      url = pickImageUrl(html.toString('utf8'), target.website);
      if (!url) return { key: target.key, ok: false, error: 'their website does not advertise a picture' };
    }
    if (!/^https:\/\//i.test(url)) return { key: target.key, ok: false, error: 'not an https address' };
    const buf = await get(url, { timeoutMs, maxBytes: MAX_PICTURE_BYTES });
    const type = sniff(buf); if (!type) return { key: target.key, ok: false, error: 'not a JPEG, PNG or WebP picture' };
    db.transaction(() => {
      db.run(`UPDATE resource_photos SET sort_order = sort_order + 1 WHERE resource_id=?`, target.id);
      db.run(`INSERT INTO resource_photos(id,resource_id,caption,content_type,bytes,data_b64,sort_order,uploaded_by) VALUES(?,?,?,?,?,?,0,?)`,
        uuid(), target.id, `From ${new URL(url).hostname}`, type, buf.length, buf.toString('base64'), actor || null);
      db.run(`UPDATE resources SET updated_at=? WHERE id=?`, db.now(), target.id);
    });
    audit.log({ user: { id: actor, username: 'region-import' }, action: 'region.picture', entity: 'resource', entityId: target.id, details: { url, bytes: buf.length, type } });
    return { key: target.key, ok: true, bytes: buf.length, type, url };
  } catch (e) {
    return { key: target.key, ok: false, error: e.soft ? e.message : e.name === 'TimeoutError' ? 'timed out' : (e.message || 'could not connect') };
  }
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
module.exports = { REGIONS, list, load, remove, pictureTargets, fetchPicture, pickImageUrl };
