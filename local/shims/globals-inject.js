// Injected by esbuild into every module that references Buffer or process.
import { Buffer as B } from 'buffer';
const proc = { env: {}, versions: {}, on() {}, exit() {}, stdout: { write() {} } };
export { B as Buffer, proc as process };
