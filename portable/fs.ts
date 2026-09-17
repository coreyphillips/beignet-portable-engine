import { Buffer } from 'buffer';
import { environment } from './state';
const volume = () => environment().volume;
export function readFileSync(path: string, encoding?: any) {
	const b = volume().read(String(path));
	if (b === null) {
		const e: any = new Error(`Missing file: ${path}`);
		e.code = 'ENOENT';
		throw e;
	}
	return encoding
		? Buffer.from(b).toString(
				typeof encoding === 'string' ? encoding : encoding.encoding
		  )
		: Buffer.from(b);
}
export function writeFileSync(path: string, data: any, encoding?: any) {
	volume().write(
		String(path),
		Buffer.from(
			data,
			typeof encoding === 'string' ? encoding : encoding?.encoding
		)
	);
}
export function existsSync(path: string) {
	return volume().read(String(path)) !== null;
}
export function mkdirSync() {
	/* Flat durable volume has no directory metadata. */
}
export function renameSync(a: string, b: string) {
	volume().rename(String(a), String(b));
}
export function unlinkSync(path: string) {
	volume().remove(String(path));
}
export function copyFileSync(a: string, b: string) {
	writeFileSync(b, readFileSync(a));
}
export function readdirSync(prefix: string) {
	return volume().list?.(prefix) ?? [];
}
export function statSync(path: string) {
	const b = readFileSync(path);
	return {
		size: b.length,
		isFile: () => true,
		isDirectory: () => false,
		mtimeMs: Date.now()
	};
}
export function chmodSync() {}
export function openSync() {
	throw new Error(
		'File descriptors are unavailable; use the durable volume API'
	);
}
export function closeSync() {}
export function writeSync() {
	throw new Error('Use durable volume writes');
}
export function fsyncSync() {
	throw new Error('Use durable volume writes');
}
export function createWriteStream() {
	throw new Error('Wire capture is disabled in portable wallets');
}
export const constants = { COPYFILE_EXCL: 1 };
export default {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	unlinkSync,
	copyFileSync,
	readdirSync,
	statSync,
	chmodSync,
	openSync,
	closeSync,
	writeSync,
	fsyncSync,
	createWriteStream,
	constants
};

export function appendFileSync(path: string, data: any) {
	const current = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
	writeFileSync(path, Buffer.concat([current, Buffer.from(data)]));
}
