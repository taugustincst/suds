export function join(...p) { return p.filter(Boolean).join('/').replace(/\/+/g, '/'); }
export function resolve(...p) { return join(...p); }
export function dirname(p) { return p.split('/').slice(0, -1).join('/') || '/'; }
export function extname(p) { const m = /\.[^./]+$/.exec(p); return m ? m[0] : ''; }
export function basename(p) { return p.split('/').pop(); }
export const sep = '/';
export default { join, resolve, dirname, extname, basename, sep };
