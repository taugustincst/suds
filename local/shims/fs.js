// No filesystem in the browser: the kernel keeps everything in the SQLite database.
const nofs = () => { const e = new Error('ENOENT: no filesystem in local mode'); e.code = 'ENOENT'; throw e; };
export const existsSync = () => false; export const readFileSync = nofs; export const writeFileSync = () => {}; export const mkdirSync = () => {}; export const chmodSync = () => {}; export const statSync = nofs; export const unlinkSync = () => {};
export default { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, unlinkSync };
