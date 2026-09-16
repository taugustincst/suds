'use strict';
// Microsoft OneNote import from exported files and from the Microsoft Graph API.
// File formats: .mht/.mhtml (Single File Web Page export), .html/.htm, .docx (Word export), .txt/.md, .pdf is not supported (export as MHT instead).
const T = require('./text');
const config = require('../config');

function pageFromHtml(html, { filename = '' } = {}) {
  const title = T.extractTitle(html) || filename.replace(/\.[^.]+$/, '');
  // OneNote HTML exports put the page created date in <meta name="created"> or as the second line after the title
  const meta = /<meta[^>]+name="?(?:created|creation-date|date)"?[^>]+content="([^"]+)"/i.exec(html);
  const text = T.htmlToText(html);
  const captured_at = (meta && T.sniffDate(meta[1])) || T.sniffDate(text.split('\n').slice(0, 4).join(' ')) || null;
  return { external_id: null, title: title.slice(0, 200), content: text, captured_at, metadata: { source: 'onenote', filename, hints: T.sniffClientHints(`${title}\n${text}`) } };
}

// Split one long text export into pages using OneNote's convention: title line, blank, date line, time line
function splitTextPages(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const pages = []; let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isHeader = l.trim() && lines[i + 1] !== undefined && lines[i + 1].trim() === '' && lines[i + 2] && /^\s*(\w+day, )?\w+ \d{1,2}, \d{4}\s*$/.test(lines[i + 2]);
    if (isHeader) { if (cur) pages.push(cur); cur = { title: l.trim(), lines: [], date: lines[i + 2].trim() + ' ' + (lines[i + 3] || '').trim() }; i += 3; continue; }
    if (!cur) cur = { title: '', lines: [], date: '' };
    cur.lines.push(l);
  }
  if (cur) pages.push(cur);
  return pages.map((p, i) => {
    const content = p.lines.join('\n').trim();
    return { external_id: null, title: (p.title || `OneNote page ${i + 1}`).slice(0, 200), content, captured_at: T.sniffDate(p.date) || T.sniffDate(content.slice(0, 300)), metadata: { source: 'onenote', hints: T.sniffClientHints(`${p.title}\n${content}`) } };
  }).filter(p => p.content || p.title);
}

function parseFile(buf, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'mht' || ext === 'mhtml' || /^(From|MIME-Version|Content-Type):/i.test(buf.toString('latin1', 0, 64))) {
    const parts = T.parseMime(buf);
    const htmlParts = parts.filter(p => p.contentType.includes('text/html'));
    if (!htmlParts.length) throw new Error('MHT file contains no HTML pages');
    return htmlParts.map((p, i) => pageFromHtml(typeof p.body === 'string' ? p.body : p.body.toString('utf8'), { filename: p.location || `${filename}#${i + 1}` }));
  }
  if (ext === 'html' || ext === 'htm' || /^\s*<(!doctype|html)/i.test(buf.toString('utf8', 0, 200))) {
    const html = buf.toString('utf8');
    // Multiple pages in one HTML export are separated by page-break divs
    const chunks = html.split(/<div[^>]+page-break-before:\s*always[^>]*>/i);
    return chunks.length > 1 ? chunks.map((c, i) => pageFromHtml(c, { filename: `${filename}#${i + 1}` })).filter(p => p.content) : [pageFromHtml(html, { filename })];
  }
  if (ext === 'docx' || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const text = T.docxToText(buf);
    const pages = splitTextPages(text);
    return pages.length ? pages : [{ external_id: null, title: filename.replace(/\.[^.]+$/, ''), content: text, captured_at: T.sniffDate(text.slice(0, 300)), metadata: { source: 'onenote', filename, hints: T.sniffClientHints(text) } }];
  }
  if (ext === 'pdf' || buf.toString('latin1', 0, 5) === '%PDF-') throw new Error('PDF export is not supported. In OneNote use File → Export → Single File Web Page (.mht) or Word (.docx).');
  // txt / md
  const text = buf.toString('utf8');
  const pages = splitTextPages(text);
  return pages.length > 1 ? pages : [{ external_id: null, title: (text.split('\n')[0] || filename).trim().slice(0, 200), content: text.trim(), captured_at: T.sniffDate(text.slice(0, 300)), metadata: { source: 'onenote', filename, hints: T.sniffClientHints(text) } }];
}

// ---- Microsoft Graph connector (application permissions: Notes.Read.All) ----
async function graphToken() {
  const { tenantId, clientId, clientSecret } = config.msGraph;
  if (!tenantId || !clientId || !clientSecret) throw new Error('Microsoft Graph is not configured (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET)');
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Graph token request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}
function graphBase(user) { return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user || config.msGraph.user)}/onenote`; }
async function graphGet(url, token, accept = 'application/json') {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
  if (!res.ok) throw new Error(`Graph request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return accept === 'application/json' ? res.json() : res.text();
}
async function listNotebooks({ token, user } = {}) {
  token = token || await graphToken();
  const nb = await graphGet(`${graphBase(user)}/notebooks?$expand=sections($select=id,displayName)`, token);
  return (nb.value || []).map(n => ({ id: n.id, name: n.displayName, lastModified: n.lastModifiedDateTime, sections: (n.sections || []).map(s => ({ id: s.id, name: s.displayName })) }));
}
async function listPages(sectionId, { token, user, since } = {}) {
  token = token || await graphToken();
  let url = `${graphBase(user)}/sections/${encodeURIComponent(sectionId)}/pages?$select=id,title,createdDateTime,lastModifiedDateTime&$top=100${since ? `&$filter=lastModifiedDateTime ge ${since}` : ''}`;
  const out = [];
  while (url) { const j = await graphGet(url, token); out.push(...(j.value || [])); url = j['@odata.nextLink']; }
  return out.map(p => ({ id: p.id, title: p.title, created: p.createdDateTime, modified: p.lastModifiedDateTime }));
}
async function fetchPages(pageIds, { token, user } = {}) {
  token = token || await graphToken();
  const items = [];
  for (const id of pageIds) {
    const meta = await graphGet(`${graphBase(user)}/pages/${encodeURIComponent(id)}?$select=id,title,createdDateTime,lastModifiedDateTime,parentSection`, token);
    const html = await graphGet(`${graphBase(user)}/pages/${encodeURIComponent(id)}/content?includeIDs=false`, token, 'text/html');
    const page = pageFromHtml(html, { filename: meta.title });
    page.external_id = id; page.title = (meta.title || page.title || 'Untitled').slice(0, 200);
    page.captured_at = meta.createdDateTime || page.captured_at;
    page.metadata.modified = meta.lastModifiedDateTime; page.metadata.section = meta.parentSection?.displayName;
    items.push(page);
  }
  return items;
}

module.exports = { parseFile, pageFromHtml, splitTextPages, listNotebooks, listPages, fetchPages, graphToken };
