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
		builder.onResolve({ filter: /^\.\/proof$/ }, () => ({ path: 'proof', namespace: 'fixture' }));
		builder.onResolve({ filter: /^\.\/network$/ }, () => ({ path: 'network', namespace: 'fixture' }));
		builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
			contents: name === 'proof'
				? 'export const verifySubmission = (...args) => fixture.verify(...args); export const fundingConfirmed = async () => false; export const queryElectrum = async () => null;'
				: name === 'node'
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
async function fixture(
	volume = memory(),
	storedChannels = [],
	runtimeOptions = {}
) {
	const connects = [];
	const calls = [],
		intervals = new Set(),
		timers = new Set();
	const node = new EventEmitter();
	let status = {
		state: 'running',
		autoApply: { enabled: true, phase: 'idle' },
		node: { gate: 'unguarded', fenced: false }
	};
	let connected = false;
	Object.assign(node, {
		getRecoverySurfaceStatus: () => status,
		getStorage: () => ({ loadAllChannels: () => storedChannels }),
		getHealth: () => ({ electrumConnected: true }),
		getInfo: () => ({ nodeId: PK, blockHeight: 100 }),
		waitForInitialSync: async () => {},
		listChannels: () =>
			storedChannels.map((row) => ({ channelId: row.channelId, ...row.state })),
		listPeers: () => (connected ? [{ pubkey: PK, state: 'connected' }] : []),
		getBalance: () => ({ onchain: 0, lightning: 0 }),
		listUtxos: () => [],
		addTrustedPeer: () => calls.push('trust'),
		removeTrustedPeer: () => calls.push('untrust'),
		configureDirectFunding: () => calls.push('configure-funding'),
		connectPeer: async (...args) => {
			connects.push(args);
			calls.push('connect');
			connected = true;
		},
		disconnectPeer: () => {
			calls.push('disconnect');
			connected = false;
		},
		createInvoice: () => {
			calls.push('invoice');
			throw Error('test must not create an invoice');
		},
		getFforReceiveService: () => ({
			receipts: async () => calls.push('receipts')
		}),
		fforEpochs: () => [],
		gracefulShutdown: async () => calls.push('shutdown'),
		destroy: async () => calls.push('destroy')
	});
	const control = {
		node,
		verified: 0,
		verify: async () => null,
		options: [],
		create: async (options) => {
			control.options.push(options);
			return node;
		}
	};
	const mod = { exports: {} };
	new Function(
		'module',
		'exports',
		'require',
		'fixture',
		'setInterval',
		'setTimeout',
		'clearInterval',
		'clearTimeout',
		await compiled
	)(
		mod,
		mod.exports,
		require,
		control,
		(callback, ms) => {
			const timer = { callback, ms };
			intervals.add(timer);
			return timer;
		},
		(callback, ms) => {
			const timer = { callback, ms };
			timers.add(timer);
			return timer;
		},
		(timer) => intervals.delete(timer),
		(timer) => timers.delete(timer)
	);
	const runtime = await mod.exports.createPortableRuntime({
		volume,
		electrum,
		...runtimeOptions,
		databaseFactory: () => {
			throw Error('unexpected database');
		},
		socketFactory: () => {
			throw Error('unexpected network');
		}
	});
	return {
		runtime,
		node,
		calls,
		control,
		volume,
		connects,
		expireStop: () => { for (const timer of timers) if (timer.ms === 15000) { timers.delete(timer); timer.callback(); } },
		set status(value) {
			status = value;
		},
		get status() {
			return status;
		},
		registry: () =>
			JSON.parse(Buffer.from(volume.read('/wallet/registry.json')).toString()),
		tick: async () => {
			for (const timer of [...intervals, ...timers]) {
				if (timer.ms === 15000) continue;
				timers.delete(timer);
				await timer.callback();
			}
			await new Promise((resolve) => setImmediate(resolve));
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


test('an Iroh primary enables only the injected native endpoint and passes fallback settings on every dial', async () => {
	const factory = async () => {
		throw Error('fake node must not call native factory');
	};
	const f = await fixture(memory(), [], { iroh: { factory } });
	const primaryUri = `${PK}@iroh:${'ab'.repeat(
		32
	)}?relay=https%3A%2F%2Frelay.example%2F`;
	const fallback = `${PK}@${'a'.repeat(56)}.onion:9735`;
	try {
		await create(f, { lfbw: { primaryUri, primaryFallbackUri: fallback } });
		assert.equal(f.control.options[0].iroh, true);
		assert.equal(f.control.options[0].irohFactory, factory);
		assert.deepEqual(f.connects[0][3], {
			type: 'iroh',
			endpointId: 'ab'.repeat(32),
			relayUrl: 'https://relay.example/',
			fallbackOnion: { host: 'a'.repeat(56) + '.onion', port: 9735 }
		});
		assert.equal(f.registry().record.lfbw.primaryFallbackUri, fallback);
	} finally {
		await f.runtime.close();
	}
});

test('conventional primaries leave Iroh unbound even when the host offers its factory', async () => {
	const f = await fixture(memory(), [], {
		iroh: {
			factory: async () => {
				throw Error('must stay unused');
			}
		}
	});
	try {
		await create(f);
		assert.equal(f.control.options[0].iroh, false);
	} finally {
		await f.runtime.close();
	}
});

test('an unsupported Iroh primary is refused before a wallet record or seed is saved', async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			create(f, { lfbw: { primaryUri: `${PK}@iroh:${'ab'.repeat(32)}` } }),
			{ code: 'IROH_UNSUPPORTED' }
		);
		assert.equal(f.volume.read('/wallet/registry.json'), null);
		assert.equal(f.control.options.length, 0);
	} finally {
		await f.runtime.close();
	}
});

test('primary edits restart only when Iroh enablement changes', async () => {
	const f = await fixture(memory(), [], { iroh: { factory: async () => {} } });
	try {
		const id = (await create(f)).record.id;
		const patch = (lfbw) =>
			f.runtime.request({
				method: 'PATCH',
				path: `/api/wallets/${id}`,
				body: { lfbw: { enabled: true, ...lfbw } }
			});
		await patch({ primaryUri: `${PK}@other.example:9735` });
		assert.equal(f.control.options.length, 1);
		const primaryUri = `${PK}@iroh:${'ab'.repeat(32)}`;
		await patch({ primaryUri });
		assert.equal(f.control.options.length, 2);
		await patch({
			primaryUri,
			primaryFallbackUri: `${PK}@${'a'.repeat(56)}.onion:9735`
		});
		assert.equal(f.control.options.length, 2);
		assert.equal(f.connects.at(-1)[3].fallbackOnion.port, 9735);
		await patch({ primaryUri, primaryFallbackUri: null });
		assert.equal(f.control.options.length, 2);
		assert.equal(f.connects.at(-1)[3].fallbackOnion, undefined);
		await patch({ primaryUri: `${PK}@other.example:9735` });
		assert.equal(f.control.options.length, 3);
		assert.equal(f.control.options[2].iroh, false);
	} finally {
		await f.runtime.close();
	}
});


test('drain observation settling after runtime teardown cannot write to the released volume', async () => {
  const f = await fixture();
  const id = (await create(f)).record.id;
  const requestId = 'runtime-drain-001';
  const address = 'external-address';
  const row = {
    requestId, address, primary: PK, phase: 'pending',
    channelId: 'ab'.repeat(32), fundingTxid: 'cd'.repeat(32), fundingOutputIndex: 0,
    coins: [], close: { amountSats: 9500, feeSats: 500, txid: 'ef'.repeat(32) },
    sweep: null, amountSats: 9500, feeSats: 500, debitSats: 10000,
    reviewedDebitSats: 10000, createdAt: 1, expiresAt: 120001
  };
  f.volume.write('/wallet/drains.json', Buffer.from(JSON.stringify({version: 1, records: [row]})));
  Object.assign(f.node, {
    getNode: () => ({getCurrentBlockHeight: () => 100}),
    listOnchainTransactions: () => [{source: 'cooperative-close', channelId: row.channelId,
      address, valueSats: 9500, feeSats: 500, txid: row.close.txid}]
  });
  let release;
  f.control.verify = () => new Promise(resolve => { release = resolve; });
  await f.tick();
  assert.equal(typeof release, 'function');
  const closing = f.runtime.close();
  await new Promise(resolve => setImmediate(resolve));
  f.expireStop();
  await closing;
  const saved = Buffer.from(f.volume.read('/wallet/drains.json')).toString();
  release({matched: true, height: 90});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Buffer.from(f.volume.read('/wallet/drains.json')).toString(), saved);
  const next = await fixture(f.volume);
  await next.runtime.close();
});


test('drain retries and cancellation are refused when requested after stop begins', async () => {
  const f = await fixture();
  const id = (await create(f)).record.id;
  const requestId = 'stopping-drain-001';
  const row = {requestId, address: 'external-address', primary: PK, phase: 'pending',
    channelId: null, coins: [{txid: 'ab'.repeat(32), vout: 0, valueSats: 2000}],
    close: null, sweep: {amountSats: 1700, feeSats: 300, txid: 'cd'.repeat(32)},
    amountSats: 1700, feeSats: 300, debitSats: 2000, reviewedDebitSats: 2000,
    createdAt: 1, expiresAt: 120001};
  f.volume.write('/wallet/drains.json', Buffer.from(JSON.stringify({version: 1, records: [row]})));
  let finish, submits = 0, cancellations = 0;
  f.node.gracefulShutdown = () => new Promise(resolve => { finish = resolve; });
  f.node.submitOnchainSweep = async () => { submits++; return {...row.sweep, status: 'submitted'}; };
  f.node.cancelOnchainSweep = async () => { cancellations++; };
  const stopping = f.runtime.request({method: 'POST', path: `/api/wallets/${id}/stop`});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  for (const action of ['send', 'cancel'])
    await assert.rejects(f.runtime.request({method: 'POST', path: `/wallets/${id}/api/drain/${action}`, body: {requestId}}), {code: 'WALLET_CLOSED'});
  assert.equal(submits, 0);
  assert.equal(cancellations, 0);
  finish();
  await stopping;
  await f.runtime.close();
});
