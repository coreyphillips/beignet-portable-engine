'use strict';
// Rebuild the application's real worker entry against the current engine.
// This qualifies encrypted OPFS persistence in a browser-like JS realm, not browser UI.
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { build } = require('esbuild');
exports.start = async ({ h, directory }) => {
	const web = process.env.BEIGNET_WEB_DIR;
	if (!web)
		throw Error('Set BEIGNET_WEB_DIR to the production web source checkout');
	fs.mkdirSync(directory, { recursive: true });
	const bundle = await build({
		entryPoints: [path.join(web, 'lib/local/wallet.worker.mjs')],
		bundle: true,
		platform: 'browser',
		format: 'iife',
		write: false,
		external: ['fs', 'path', 'crypto'],
		alias: {
			'@beignet/portable-engine/sqljs': path.resolve(
				__dirname,
				'../dist/sqljs.mjs'
			),
			'@beignet/portable-engine': path.resolve(
				__dirname,
				'../dist/portable.mjs'
			),
			'@beignet/wallet-core': path.join(
				process.env.BEIGNET_WALLET_CORE_DIR,
				'src/index.js'
			)
		}
	});
	const source = bundle.outputFiles[0].text;
	const thread = new Worker(path.join(__dirname, 'regtest-worker-realm.mjs'), {
		workerData: {
			source,
			origin: 'http://127.0.0.1',
			workerFile: 'wallet.worker.js',
			temp: directory,
			wasm: require.resolve('sql.js/dist/sql-wasm.wasm')
		}
	});
	let next = 0;
	const pending = new Map();
	let readyResolve, readyReject;
	const ready = new Promise((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	thread.on('message', ({ ready, id, result, error }) => {
		if (ready) return readyResolve();
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		error
			? entry.reject(Object.assign(Error(error.message), error))
			: entry.resolve(result);
	});
	thread.on('error', (error) => {
		readyReject(error);
		for (const entry of pending.values()) entry.reject(error);
		pending.clear();
	});
	async function call(operation, payload) {
		await ready;
		return new Promise((resolve, reject) => {
			const id = ++next;
			pending.set(id, { resolve, reject });
			thread.postMessage({ id, operation, payload });
		});
	}
	try {
		await call('unlock', {
			password: 'disposable regtest passphrase',
			options: {
				network: 'regtest',
				primaryUri: h.primaryUri,
				electrum: h.electrum,
				token: h.token,
				electrumUrl: `ws://127.0.0.1:${h.relayPort}/electrum`,
				peerUrl: `ws://127.0.0.1:${h.relayPort}/peer`
			}
		});
		return {
			request: (body) => call('request', body),
			stop: () => thread.terminate(),
			identity: {
				threadId: thread.threadId,
				workerSha256: createHash('sha256').update(source).digest('hex'),
				encrypted: true
			}
		};
	} catch (error) {
		await thread.terminate();
		throw error;
	}
};

if (require.main === module) {
	process.env.FFOR_RUNTIME_ADAPTER = __filename;
	require('./regtest-ffor.cjs');
}
