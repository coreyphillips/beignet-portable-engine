import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
// Hermes may return a plain Uint8Array from inherited subarray(), ignoring
// Buffer's species. Beignet needs Node's zero-copy Buffer view semantics.
const byteSubarray = Uint8Array.prototype.subarray;
Buffer.prototype.subarray = function(start?:number,end?:number) {
 const view=byteSubarray.call(this,start,end);
 Object.setPrototypeOf(view,Buffer.prototype);
 return view as Buffer;
};

// buffer@6 knows base64 but not base64url, which Node has accepted since
// v15 and which the engine uses for the direct-funding envelope in every
// unified receive request. Without this the envelope mint threw "Unknown
// encoding: base64url" and every request on the phone silently degraded to
// a plain address and invoice. Node treats the two as one alphabet with
// optional padding, so the url spelling maps onto base64 here.
const isBase64Url = (encoding: unknown) =>
	typeof encoding === 'string' && encoding.toLowerCase() === 'base64url';
const toStandardBase64 = (value: string) => {
	let text = value.replace(/-/g, '+').replace(/_/g, '/');
	while (text.length % 4) text += '=';
	return text;
};
const toUrlBase64 = (value: string) =>
	value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bufferToString = Buffer.prototype.toString;
Buffer.prototype.toString = function (
	encoding?: any,
	start?: number,
	end?: number
) {
	if (isBase64Url(encoding))
		return toUrlBase64(bufferToString.call(this, 'base64', start, end));
	return bufferToString.call(this, encoding, start, end);
} as any;
const bufferWrite = Buffer.prototype.write;
Buffer.prototype.write = function (value: string, ...rest: any[]) {
	const at = rest.findIndex(isBase64Url);
	if (at >= 0) {
		rest[at] = 'base64';
		value = toStandardBase64(value);
	}
	return (bufferWrite as any).call(this, value, ...rest);
} as any;
const bufferFrom = Buffer.from;
Buffer.from = function (value: any, encodingOrOffset?: any, length?: any) {
	if (typeof value === 'string' && isBase64Url(encodingOrOffset))
		return bufferFrom.call(Buffer, toStandardBase64(value), 'base64');
	return (bufferFrom as any).call(Buffer, value, encodingOrOffset, length);
} as any;
const bufferByteLength = Buffer.byteLength;
Buffer.byteLength = function (value: any, encoding?: any) {
	if (typeof value === 'string' && isBase64Url(encoding))
		return bufferFrom.call(Buffer, toStandardBase64(value), 'base64').length;
	return (bufferByteLength as any).call(Buffer, value, encoding);
} as any;
const bufferIsEncoding = Buffer.isEncoding;
Buffer.isEncoding = ((encoding: string) =>
	isBase64Url(encoding) || bufferIsEncoding.call(Buffer, encoding)) as any;

const proc: any = new EventEmitter();
proc.env = {};
proc.browser = true;
proc.release = { name: 'beignet-portable' };
proc.platform = 'browser';
proc.pid = 1;
proc.cwd = () => '/';
proc.nextTick = (fn: any, ...args: any[]) => queueMicrotask(() => fn(...args));
proc.hrtime = (previous?: number[]) => {
	const ms = globalThis.performance?.now?.() ?? Date.now();
	const seconds = Math.floor(ms / 1000);
	const ns = Math.floor((ms - seconds * 1000) * 1e6);
	if (!previous) return [seconds, ns];
	let ds = seconds - previous[0],
		dn = ns - previous[1];
	if (dn < 0) {
		ds--;
		dn += 1e9;
	}
	return [ds, dn];
};
proc.hrtime.bigint = () =>
	BigInt(Math.floor((globalThis.performance?.now?.() ?? Date.now()) * 1e6));
export { Buffer };
export const process = proc;
export const global = globalThis;
export const setImmediate = (fn: any, ...args: any[]) =>
	setTimeout(fn, 0, ...args);
export const clearImmediate = clearTimeout;
