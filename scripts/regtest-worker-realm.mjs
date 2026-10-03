import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { source, origin, workerFile, temp } = workerData;
const locks = new Set(),
	timers = new Set();
const schedule = (fn, ms, ...args) => {
	const t = setTimeout(fn, ms, ...args);
	timers.add(t);
	return t;
};
function directoryHandle(root) {
	return {
		async getDirectoryHandle(name) {
			const p = path.join(root, name);
			fs.mkdirSync(p, { recursive: true });
			return directoryHandle(p);
		},
		async getFileHandle(name) {
			const p = path.join(root, name);
			return {
				async createSyncAccessHandle() {
					if (locks.has(p))
						throw Object.assign(new Error('locked'), {
							name: 'NoModificationAllowedError'
						});
					locks.add(p);
					const fd = fs.openSync(p, fs.existsSync(p) ? 'r+' : 'w+', 0o600);
					let closed = false;
					return {
						getSize: () => fs.fstatSync(fd).size,
						read: (bytes, { at = 0 } = {}) =>
							fs.readSync(fd, bytes, 0, bytes.length, at),
						write: (bytes, { at = 0 } = {}) =>
							fs.writeSync(fd, bytes, 0, bytes.length, at),
						truncate: (size) => fs.ftruncateSync(fd, size),
						flush: () => fs.fsyncSync(fd),
						close() {
							if (!closed) {
								closed = true;
								fs.closeSync(fd);
								locks.delete(p);
							}
						}
					};
				}
			};
		}
	};
}
const sandbox = {
	isSecureContext: true,
	importScripts() {},
	crypto: webcrypto,
	TextEncoder,
	TextDecoder,
	URL,
	URLSearchParams,
	Uint8Array,
	Uint16Array,
	Uint32Array,
	Int8Array,
	Int16Array,
	Int32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
	ArrayBuffer,
	DataView,
	WebAssembly,
	fetch: (url, options) =>
		String(url).endsWith('/engine/sql-wasm.wasm')
			? Promise.resolve(
					new Response(fs.readFileSync(workerData.wasm), {
						headers: { 'Content-Type': 'application/wasm' }
					})
			  )
			: fetch(url, options),
	Response,
	Request,
	Headers,
	AbortController,
	AbortSignal,
	performance,
	atob,
	btoa,
	console: { log() {}, warn() {}, error() {}, debug() {} },
	setTimeout: schedule,
	clearTimeout,
	setInterval: (fn, ms) => {
		const t = setInterval(fn, ms);
		timers.add(t);
		return t;
	},
	clearInterval,
	queueMicrotask,
	location: { origin, href: `${origin}/_next/static/workers/${workerFile}` },
	navigator: { storage: { getDirectory: async () => directoryHandle(temp) } },
	WebSocket: class {
		constructor(url, protocols) {
			return new WebSocket(url, protocols, { origin });
		}
	},
	postMessage: ({ id, result, error }) => {
		parentPort.postMessage({ id, result, error });
	}
};
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: workerFile, timeout: 20000 });
parentPort.on('message', (data) => {
	void context.onmessage({ data });
});
parentPort.postMessage({ ready: true });
