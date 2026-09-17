import { unzlibSync, zlibSync } from 'fflate';
import { Buffer } from 'buffer';
export const inflateSync = (b: any) => Buffer.from(unzlibSync(b));
export const deflateSync = (b: any) => Buffer.from(zlibSync(b));
export default { inflateSync, deflateSync };
