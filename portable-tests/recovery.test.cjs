const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { build } = require('esbuild');
const path = require('node:path');

// Compile in memory with a fake node and network verifier. No production
// bundle, wallet storage, socket or payment is touched by these tests.
const compiled = build({
	entryPoints: [path.join(__dirname, '../portable/runtime.ts')],
	bundle: true, platform: 'node', format: 'cjs', write: false,
	plugins: [{ name: 'recovery-fixture', setup(builder) {
		builder.onResolve({ filter: /beignet-node$/ }, () => ({ path: 'node', namespace: 'fixture' }));
		builder.onResolve({ filter: /^\.\/network$/ }, () => ({ path: 'network', namespace: 'fixture' }));
		builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
			contents: name === 'node'
				? 'export const BeignetNode = { create: (options) => fixture.create(options) };'
				: 'export const verifyElectrumNetwork = async () => { fixture.verified++; };',
			loader: 'js'
		}));
	} }]
}).then(result => result.outputFiles[0].text);

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PK = '02' + '11'.repeat(32);
const electrum = { host: 'fixture.example', port: 50002, tls: true };
const createBody = { mnemonic: PHRASE, network: 'regtest', lfbw: { primaryUri: `${PK}@fixture.example:9735` } };
function memory() {
	const rows = new Map();
	return {
		read: key => rows.get(key) ?? null,
		write: (key, value) => rows.set(key, new Uint8Array(value)),
		remove: key => rows.delete(key),
		rename: (from, to) => { rows.set(to, rows.get(from)); rows.delete(from); },
		list: () => [...rows.keys()]
	};
}
async function fixture(volume = memory(), storedChannels = []) {
	const calls = [], intervals = new Set(), timers = new Set();
	const node = new EventEmitter();
	let status = { state: 'running', autoApply: { enabled: true, phase: 'idle' }, node: { gate: 'unguarded', fenced: false } };
	let connected = false;
	Object.assign(node, {
		getRecoverySurfaceStatus: () => status,
		getStorage: () => ({ loadAllChannels: () => storedChannels }),
		getHealth: () => ({ electrumConnected: true }),
		getInfo: () => ({ nodeId: PK, blockHeight: 100 }),
		waitForInitialSync: async () => {},
		listChannels: () => storedChannels.map(row => ({ channelId: row.channelId, ...row.state })),
		listPeers: () => connected ? [{ pubkey: PK, state: 'connected' }] : [],
		getBalance: () => ({ onchain: 0, lightning: 0 }),
		listUtxos: () => [],
		addTrustedPeer: () => calls.push('trust'),
		removeTrustedPeer: () => calls.push('untrust'),
		configureDirectFunding: () => calls.push('configure-funding'),
		connectPeer: async () => { calls.push('connect'); connected = true; },
		disconnectPeer: () => { calls.push('disconnect'); connected = false; },
		createInvoice: () => { calls.push('invoice'); throw Error('test must not create an invoice'); },
		getFforReceiveService: () => ({ receipts: async () => calls.push('receipts') }),
		fforEpochs: () => [],
		gracefulShutdown: async () => calls.push('shutdown'),
		destroy: async () => calls.push('destroy')
	});
	const control = {
		node, verified: 0, options: [],
		create: async options => { control.options.push(options); return node; }
	};
	const mod = { exports: {} };
	new Function('module', 'exports', 'require', 'fixture', 'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', await compiled)(
		mod, mod.exports, require, control,
		(callback, ms) => { const timer = { callback, ms }; intervals.add(timer); return timer; },
		(callback, ms) => { const timer = { callback, ms }; timers.add(timer); return timer; },
		timer => intervals.delete(timer), timer => timers.delete(timer)
	);
	const runtime = await mod.exports.createPortableRuntime({
		volume, electrum,
		databaseFactory: () => { throw Error('unexpected database'); },
		socketFactory: () => { throw Error('unexpected network'); }
	});
	return {
		runtime, node, calls, control, volume,
		set status(value) { status = value; },
		get status() { return status; },
		registry: () => JSON.parse(Buffer.from(volume.read('/wallet/registry.json')).toString()),
		tick: async () => {
			for (const timer of [...intervals, ...timers]) {
				if (timer.ms === 15000) continue;
				timers.delete(timer);
				await timer.callback();
			}
			await new Promise(resolve => setImmediate(resolve));
		}
	};
}
async function create(f, extra = {}) {
	return f.runtime.request({ method: 'POST', path: '/api/wallets', body: { ...createBody, ...extra } });
}
const statusPath = id => `/wallets/${id}/api/recovery/status`;

test('peer recovery requires a boolean opt-in and an explicit valid phrase before persistence or network', async () => {
	for (const extra of [
		{ recoveryAutoApply: 'true' }, { recoveryAutoApply: null },
		{ recoveryAutoApply: true, mnemonic: undefined },
		{ mnemonic: null }, { mnemonic: '' }, { mnemonic: 123 },
		{ recoveryAutoApply: true, mnemonic: '' },
		{ recoveryAutoApply: true, mnemonic: 'invalid words' }
	]) {
		const f = await fixture();
		try {
			await assert.rejects(create(f, extra), error => ['INVALID_PARAMS', 'INVALID_MNEMONIC'].includes(error.code));
			assert.equal(f.volume.read('/wallet/registry.json'), null);
			assert.equal(f.control.verified, 0);
			assert.equal(f.control.options.length, 0);
		} finally { await f.runtime.close(); }
	}
});

test('ordinary creation and seed import never imply automatic peer recovery', async () => {
	for (const extra of [{}, { mnemonic: undefined }, { recoveryAutoApply: false }]) {
		const f = await fixture();
		try {
			const result = await create(f, extra);
			assert.equal(f.control.options[0].recoveryAutoApply, false);
			assert.equal(f.registry().recoveryImport.autoApply, false);
			const status = await f.runtime.request({ path: statusPath(result.record.id) });
			assert.equal(status.importPending, false);
			assert.equal(status.importComplete, false);
			assert.ok(f.calls.includes('configure-funding'));
		} finally { await f.runtime.close(); }
	}
});

test('opted-in import persists across restart, keeps status readable and blocks mutations plus background work', async () => {
	const volume = memory();
	let id;
	for (let start = 0; start < 2; start++) {
		const f = await fixture(volume);
		try {
			if (start === 0) id = (await create(f, { recoveryAutoApply: true })).record.id;
			else await f.runtime.request({ method: 'POST', path: `/api/wallets/${id}/start` });
			assert.equal(f.control.options[0].recoveryAutoApply, true);
			const record = (await f.runtime.request({ path: '/api/wallets' }))[0];
			assert.equal('recoveryImport' in record, false);
			assert.equal('mnemonic' in record, false);
			assert.equal((await f.runtime.request({ path: '/api/config' })).recoveryAutoApplyAvailable, true);
			const status = await f.runtime.request({ path: statusPath(id) });
			assert.equal(status.importPending, true);
			assert.equal(status.autoApply.phase, 'idle');
			for (const request of [
				{ method: 'POST', path: `/wallets/${id}/api/invoice/create`, body: { amountSats: 10000 } },
				{ method: 'POST', path: `/wallets/${id}/api/direct-funding/request` },
				{ method: 'POST', path: `/api/wallets/${id}/lfbw/channelize`, body: { force: true } },
				{ method: 'PATCH', path: `/api/wallets/${id}`, body: { name: 'changed' } }
			]) await assert.rejects(f.runtime.request(request), { code: 'NODE_RESTORE_PENDING' });
			f.node.emit('peer:connect', PK);
			f.node.emit('peer:error', PK);
			await f.tick();
			assert.deepEqual(f.calls, ['connect']);
			assert.equal((await f.runtime.request({ path: `/wallets/${id}/api/mnemonic` })).mnemonic, PHRASE);
		} finally { await f.runtime.close(); }
	}
});

test('native restore and writer holds cannot be bypassed, while recovery status and shutdown remain available', async () => {
	const f = await fixture();
	try {
		const { record } = await create(f, { recoveryAutoApply: true });
		for (const [status, fields, code] of [
			[{ state: 'running', autoApply: { phase: 'settling' } }, {}, 'NODE_RESTORE_PENDING'],
			[{ state: 'restoring' }, { resuming: true }, 'NODE_RESTORE_PENDING'],
			[{ state: 'restore-required' }, { restorePending: true }, 'NODE_RESTORE_PENDING'],
			[{ state: 'restart-required' }, { restartRequired: true }, 'NODE_RESTART_REQUIRED'],
			[{ state: 'fenced' }, {}, 'NODE_FENCED'],
			[{ state: 'running', node: { fenced: true } }, {}, 'NODE_FENCED'],
			[{ state: 'running', autoApply: { phase: 'refused', lastReason: 'CAPSULE_RESTORE_GUARDIAN_BACKED' } }, {}, 'RECOVERY_UNAVAILABLE']
		]) {
			Object.assign(f.node, { resuming: false, restorePending: false, restartRequired: false }, fields);
			f.status = status;
			const read = await f.runtime.request({ path: statusPath(record.id) });
			assert.equal(read.state, status.state);
			await assert.rejects(f.runtime.request({ method: 'POST', path: `/wallets/${record.id}/api/invoice/create` }), { code });
			await f.tick();
		}
		assert.deepEqual(f.calls, ['connect']);
	} finally { await f.runtime.close(); }
	assert.ok(f.calls.includes('shutdown'));
});

test('native completion persists without lifting channel recency holds and normal reopening does not wait again', async () => {
	const volume = memory();
	const channels = [{ channelId: 'restored', state: { restoreRecencyUnproven: true } }];
	let id;
	const first = await fixture(volume);
	try {
		id = (await create(first, { recoveryAutoApply: true })).record.id;
		first.status.autoApply.phase = 'applied';
		first.node.emit('recovery:restored', { tier: 2, exact: true });
		assert.equal(first.registry().recoveryImport.complete, true);
	} finally { await first.runtime.close(); }
	const second = await fixture(volume, channels);
	try {
		await second.runtime.request({ method: 'POST', path: `/api/wallets/${id}/start` });
		const status = await second.runtime.request({ path: statusPath(id) });
		assert.equal(status.importComplete, true);
		assert.equal(status.importPending, false);
		assert.equal(status.autoApply.phase, 'idle');
		assert.ok(second.calls.includes('configure-funding'));
		assert.equal(channels[0].state.restoreRecencyUnproven, true);
	} finally { await second.runtime.close(); }
});

test('a crash after native install recovers import completion from durable channel flags', async () => {
	for (const state of [{ restoreRecencyUnproven: true }, { dataLossDetected: true }]) {
		const volume = memory();
		const first = await fixture(volume);
		const id = (await create(first, { recoveryAutoApply: true })).record.id;
		await first.runtime.close();
		const reopened = await fixture(volume, [{ channelId: 'restored', state }]);
		try {
			await reopened.runtime.request({ method: 'POST', path: `/api/wallets/${id}/start` });
			assert.equal(reopened.registry().recoveryImport.complete, true);
			assert.equal((await reopened.runtime.request({ path: statusPath(id) })).importPending, false);
			assert.deepEqual(state, Object.hasOwn(state, 'dataLossDetected') ? { dataLossDetected: true } : { restoreRecencyUnproven: true });
		} finally { await reopened.runtime.close(); }
	}
});
