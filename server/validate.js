'use strict';
const { badRequest } = require('./http');

// Tiny schema validator: shape = { field: { type, required, enum, min, max, maxLen, pattern } }
function validate(body, shape, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON object body required');
  const out = {}; const errors = {};
  for (const [k, rule] of Object.entries(shape)) {
    let v = body[k];
    if (v === '' ) v = null;
    if (v === undefined) { if (rule.required && !partial) errors[k] = 'required'; continue; }
    if (v === null) { if (rule.required) errors[k] = 'required'; else out[k] = null; continue; }
    switch (rule.type) {
      case 'string':
        if (typeof v !== 'string') { errors[k] = 'must be a string'; continue; }
        v = v.trim();
        if (rule.maxLen && v.length > rule.maxLen) { errors[k] = `max length ${rule.maxLen}`; continue; }
        if (rule.pattern && !rule.pattern.test(v)) { errors[k] = 'invalid format'; continue; }
        if (rule.enum && !rule.enum.includes(v)) { errors[k] = `must be one of ${rule.enum.join(', ')}`; continue; }
        if (!v && rule.required) { errors[k] = 'required'; continue; }
        break;
      case 'number':
        v = Number(v);
        if (!Number.isFinite(v)) { errors[k] = 'must be a number'; continue; }
        if (rule.min !== undefined && v < rule.min) { errors[k] = `min ${rule.min}`; continue; }
        if (rule.max !== undefined && v > rule.max) { errors[k] = `max ${rule.max}`; continue; }
        if (rule.integer && !Number.isInteger(v)) { errors[k] = 'must be an integer'; continue; }
        break;
      case 'boolean':
        v = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0; break;
      case 'date': // YYYY-MM-DD
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) { errors[k] = 'must be YYYY-MM-DD'; continue; }
        break;
      case 'datetime':
        if (typeof v !== 'string' || isNaN(Date.parse(v))) { errors[k] = 'must be an ISO datetime'; continue; }
        v = new Date(v).toISOString(); break;
      case 'object':
        if (typeof v !== 'object') { errors[k] = 'must be an object'; continue; }
        break;
      case 'array':
        if (!Array.isArray(v)) { errors[k] = 'must be an array'; continue; }
        break;
      default: break;
    }
    out[k] = v;
  }
  if (Object.keys(errors).length) throw badRequest('Validation failed', { fields: errors });
  return out;
}

function paging(query, defaults = { limit: 50, max: 500 }) {
  const limit = Math.min(defaults.max, Math.max(1, Number(query.get('limit') || defaults.limit)));
  const offset = Math.max(0, Number(query.get('offset') || 0));
  return { limit, offset };
}

module.exports = { validate, paging };
