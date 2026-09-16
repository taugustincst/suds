'use strict';
// Pocket AI (mobile voice-note / meeting-note app) import.
// Supported inputs:
//  - JSON export: an array (or {notes:[...]}, {recordings:[...]}, {items:[...]}) of objects with any of
//    id, title/name, transcript/transcription/text/content/body, summary, notes, action_items/actionItems,
//    created_at/createdAt/date/timestamp, tags, duration
//  - Markdown / plain text export: notes separated by '---' or '# ' headings; a "Date:"/"Created:" line is used when present
//  - Webhook/share payload (same JSON shape, single object)
const { sniffDate, sniffClientHints } = require('./text');

function pick(o, keys) { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; }

function normalizeItem(o, i) {
  if (typeof o === 'string') return normalizeTextNote(o, i);
  const title = pick(o, ['title', 'name', 'subject', 'heading']) || `Pocket AI note ${i + 1}`;
  const transcript = pick(o, ['transcript', 'transcription', 'text', 'content', 'body', 'raw_text']);
  const summary = pick(o, ['summary', 'ai_summary', 'aiSummary', 'abstract']);
  const notes = pick(o, ['notes', 'note', 'key_points', 'keyPoints', 'highlights']);
  const actions = pick(o, ['action_items', 'actionItems', 'actions', 'todos', 'tasks']);
  const parts = [];
  if (summary) parts.push('## Summary\n' + str(summary));
  if (notes) parts.push('## Notes\n' + str(notes));
  if (actions) parts.push('## Action items\n' + (Array.isArray(actions) ? actions.map(a => '- ' + str(a)).join('\n') : str(actions)));
  if (transcript) parts.push('## Transcript\n' + str(transcript));
  const content = parts.join('\n\n').trim() || str(o);
  const rawDate = pick(o, ['created_at', 'createdAt', 'date', 'timestamp', 'recorded_at', 'recordedAt', 'start_time', 'updated_at']);
  let captured_at = null;
  if (rawDate !== undefined) { const d = typeof rawDate === 'number' ? new Date(rawDate < 1e12 ? rawDate * 1000 : rawDate) : new Date(rawDate); if (!isNaN(d)) captured_at = d.toISOString(); }
  if (!captured_at) captured_at = sniffDate(title) || sniffDate(content);
  const tags = pick(o, ['tags', 'labels', 'categories']);
  const hints = sniffClientHints(`${title}\n${content}`);
  return { external_id: pick(o, ['id', 'uuid', 'note_id', 'recording_id']) ? String(pick(o, ['id', 'uuid', 'note_id', 'recording_id'])) : null, title: String(title).slice(0, 200), content, captured_at,
    metadata: { source: 'pocket_ai', tags: Array.isArray(tags) ? tags : (tags ? [String(tags)] : []), duration: pick(o, ['duration', 'duration_seconds', 'length']), hints, has_transcript: !!transcript, has_summary: !!summary } };
}
function str(v) { if (v === null || v === undefined) return ''; if (typeof v === 'string') return v; if (Array.isArray(v)) return v.map(str).join('\n'); if (typeof v === 'object') { if (v.text) return str(v.text); if (v.content) return str(v.content); return JSON.stringify(v, null, 2); } return String(v); }

function normalizeTextNote(text, i) {
  const lines = text.trim().split('\n');
  let title = lines[0].replace(/^#+\s*/, '').trim().slice(0, 200) || `Pocket AI note ${i + 1}`;
  const body = lines.slice(1).join('\n').trim();
  const dateLine = /^(?:date|created|recorded)\s*[:\-]\s*(.+)$/im.exec(text);
  const captured_at = (dateLine && sniffDate(dateLine[1])) || sniffDate(title) || sniffDate(body.slice(0, 300));
  return { external_id: null, title, content: body || text.trim(), captured_at, metadata: { source: 'pocket_ai', hints: sniffClientHints(text) } };
}

function splitText(text) {
  const t = String(text).replace(/\r\n/g, '\n').trim();
  let chunks = t.split(/\n\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*\n/).map(s => s.trim()).filter(Boolean);
  if (chunks.length === 1 && /^#\s/m.test(t)) chunks = t.split(/\n(?=#\s)/).map(s => s.trim()).filter(Boolean);
  return chunks;
}

function parse(input, { filename = '' } = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data; try { data = JSON.parse(trimmed); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
    let arr = Array.isArray(data) ? data : (data.notes || data.recordings || data.items || data.data || data.results);
    if (!Array.isArray(arr)) arr = [data];
    return arr.map(normalizeItem);
  }
  return splitText(text).map(normalizeTextNote);
}

module.exports = { parse, normalizeItem };
