const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { before, test } = require('node:test');
const { compileFunction } = require('node:vm');
const esbuild = require('esbuild');

let createPortableRuntime;
// Exercise the normal wallet manager API with the node and Electrum under
// test control. The shipped ESM and CommonJS bundles share this runtime source.
before(async () => {
	const { outputFiles } = await esbuild.build({
		entryPoints: [require.resolve('../portable/runtime.ts')],
		format: 'cjs',
		platform: 'node',
		packages: 'external',
		bundle: true,
		write: false,
		plugins: [{
			name: 'test-node-and-network',
			setup(build) {
				build.onResolve({ filter: /^(\.\.\/src\/cli\/beignet-node|\.\/network)$/ }, args =>
					args.importer.endsWith('/portable/runtime.ts')
						? { path: args.path, namespace: 'fixture' } : undefined);
				build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
					contents: args.path === './network'
						? 'export const verifyElectrumNetwork = async () => {};'
						: 'export const BeignetNode = { create: async options => options.testNode };'
				}));
			}
		}]
	});
	const bundle = { exports: {} };
	compileFunction(outputFiles[0].text, ['module', 'exports', 'require'])(bundle, bundle.exports, require);
	createPortableRuntime = bundle.exports.createPortableRuntime;
});

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

async function fixture({ preparePrimaryDial, recovery, hosts = ['a.test', 'b.test'] } = {}) {
	const rows = hosts.map((host, index) => {
		const pubkey = ['02' + 'ab'.repeat(32), '03' + 'cd'.repeat(32)][index];
		return { pubkey, uri: `${pubkey}@${host}:9735`, rank: index + 1, setup: 'ready' };
	});
	const node = new EventEmitter();
	const peers = new Set();
	const channels = [];
	const attempts = rows.map(() => deferred());
	const dialled = [];
	const seen = [];
	const policy = { primaries: rows, receiveTarget: rows[0].pubkey, fillThresholdSat: null };
	Object.assign(node, {
		getHealth: () => ({ electrumConnected: true }),
		getInfo: () => ({ nodeId: rows[0].pubkey }),
		getNode: () => ({ getPeerManager: () => undefined }),
		getRecoverySurfaceStatus: () => recovery ? { state: 'restore-required' } : {},
		waitForInitialSync: async () => {},
		listPrimaries: () => policy,
		listPeers: () => [...peers].map(pubkey => ({ pubkey, state: 'connected' })),
		listChannels: () => channels,
		configureDirectFunding: () => {},
		addTrustedPeer: () => {},
		gracefulShutdown: async () => {},
		destroy: async () => {},
		connectPeer: async (pubkey, host) => {
			const index = rows.findIndex(row => row.pubkey === pubkey);
			dialled.push(host);
			await attempts[index].promise;
			peers.add(pubkey);
			node.emit('peer:connect', { pubkey });
		}
	});
	const storage = new Map([['/wallet/registry.json', Buffer.from(JSON.stringify({
		record: {
			id: 'test', network: 'regtest', electrum: { host: 'electrum.test', port: 60001 },
			lfbw: { enabled: true, mode: 'external', primariesSyncedAt: 1, primaries: rows, primaryUri: rows[0].uri }
		},
		mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
	}))]]);
	const runtime = await createPortableRuntime({
		nodeOptions: { testNode: node }, preparePrimaryDial,
		volume: { read: key => storage.get(key) ?? null, write: (key, value) => storage.set(key, value) },
		onDiagnostic: event => seen.push(event),
		databaseFactory() { throw Error('Unexpected database open'); },
		socketFactory() { throw Error('Unexpected socket'); }
	});
	return {
		attempts, dialled, seen, storage, channels,
		setAppBackgrounded: backgrounded => runtime.setAppBackgrounded(backgrounded),
		start: () => runtime.request({ method: 'POST', path: '/api/wallets/test/start' }),
		record: () => runtime.request({ path: '/api/wallets/test' }),
		close: () => runtime.close()
	};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('first ready primary releases the start while a failed secondary retains its own state and retry', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = await fixture();
	try {
		const started = f.start();
		await settle();
		assert.deepEqual(f.dialled, ['a.test', 'b.test']);
		f.attempts[0].resolve();
		const record = await started;
		assert.equal(record.lfbw.setup, 'ready');
		assert.deepEqual(record.lfbw.primaries.map(p => p.setup), ['ready', 'pending']);
		f.attempts[1].reject(Error('peer timeout'));
		await settle();
		const final = await f.record();
		assert.equal(final.lfbw.setup, 'ready');
		assert.equal(final.lfbw.primaries[1].setup, 'failed');
		assert.equal(final.lfbw.primaries[1].setupError, 'peer timeout');
		t.mock.timers.tick(5000);
		await settle();
		assert.ok(f.dialled.filter(host => host === 'b.test').length > 1);
	} finally { await f.close(); }
});

test('with all peers down the start waits for the last result before reporting failure', async () => {
	const f = await fixture();
	try {
		let returned = false;
		const started = f.start().then(record => { returned = true; return record; });
		await settle();
		f.attempts[0].reject(Error('rank 1 offline'));
		await settle();
		assert.equal(returned, false);
		f.attempts[1].reject(Error('rank 2 offline'));
		const record = await started;
		assert.equal(record.lfbw.setup, 'failed');
		assert.deepEqual(record.lfbw.primaries.map(p => p.setupError), ['rank 1 offline', 'rank 2 offline']);
	} finally { await f.close(); }
});

test('a recovering wallet waits for both setup results', async () => {
	const f = await fixture({ recovery: true });
	try {
		let returned = false;
		const started = f.start().then(() => { returned = true; });
		await settle();
		f.attempts[0].resolve();
		await settle();
		assert.equal(returned, false);
		f.attempts[1].resolve();
		await started;
	} finally { await f.close(); }
});

test('a direct primary can start while an onion peer prepares, and a closed wallet never dials it', async () => {
	const tor = deferred();
	const f = await fixture({
		hosts: ['direct.test', 'peer.onion'],
		preparePrimaryDial: async host => { if (host === 'peer.onion') await tor.promise; }
	});
	const started = f.start();
	await settle();
	assert.deepEqual(f.dialled, ['direct.test']);
	f.attempts[0].resolve();
	assert.equal((await started).lfbw.setup, 'ready');
	await f.close();
	const saved = f.storage.get('/wallet/registry.json');
	tor.resolve();
	await settle();
	assert.deepEqual(f.dialled, ['direct.test']);
	assert.equal(f.storage.get('/wallet/registry.json'), saved);
});

test('a pending secondary dial cannot overwrite wallet storage after the runtime closes', async () => {
	const f = await fixture();
	const started = f.start();
	await settle();
	f.attempts[0].resolve();
	await started;
	await f.close();
	const saved = f.storage.get('/wallet/registry.json');
	f.attempts[1].resolve();
	await settle();
	assert.equal(f.storage.get('/wallet/registry.json'), saved);
});

test('the runtime gives a reestablish reply buffered during suspension time to arrive', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = await fixture({ hosts: ['peer.test'] });
	try {
		const started = f.start();
		f.attempts[0].resolve();
		const record = await started;
		const channel = { peerPubkey: record.lfbw.primaries[0].pubkey, state: 'AWAITING_REESTABLISH' };
		f.channels.push(channel);
		t.mock.timers.tick(7000);
		f.setAppBackgrounded(true);
		t.mock.timers.tick(600000);
		f.setAppBackgrounded(false);
		t.mock.timers.tick(7999);
		channel.state = 'NORMAL';
		t.mock.timers.tick(1);
		assert.deepEqual(f.seen.filter(event => event.phase === 'primary-redial'), []);
		assert.deepEqual(f.dialled, ['peer.test']);
	} finally { await f.close(); }
});
