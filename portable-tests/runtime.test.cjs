const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPortableRuntime } = require('../dist/portable.cjs');
const memory = () => {
	const map = new Map();
	return {
		read: (p) => map.get(p) ?? null,
		write: (p, b) => map.set(p, new Uint8Array(b)),
		remove: (p) => map.delete(p),
		rename: (a, b) => {
			map.set(b, map.get(a));
			map.delete(a);
		}
	};
};
const options = (volume) => ({
	volume,
	databaseFactory() {
		throw Error('No database should be opened');
	},
	socketFactory() {
		throw Error('No network should be opened');
	}
});
test('corrupt registry cannot poison subsequent runtime creation', async () => {
	const broken = memory();
	broken.write('/wallet/registry.json', Buffer.from('{'));
	await assert.rejects(createPortableRuntime(options(broken)));
	const good = await createPortableRuntime(options(memory()));
	assert.deepEqual(await good.request({ path: '/api/wallets' }), []);
	await good.close();
	await good.close();
	await assert.rejects(
		good.request({ path: '/api/wallets' }),
		(e) => e.code === 'WALLET_CLOSED'
	);
});
test('invalid network transport is refused before a wallet identity is persisted', async () => {
	const volume = memory();
	const runtime = await createPortableRuntime(options(volume));
	try {
		await assert.rejects(
			runtime.request({
				method: 'POST',
				path: '/api/wallets',
				body: {
					network: 'regtest',
					lfbw: {
						primaryUri:
							'028c6651b7759f24585df5864b4f1eaa2fc32acd17eecfef316199bf9a7606ba67@127.0.0.1:19846'
					}
				}
			}),
			(e) => e.code === 'ELECTRUM_REQUIRED'
		);
		assert.equal(volume.read('/wallet/registry.json'), null);
	} finally {
		await runtime.close();
	}
});
test('only one runtime owns an engine realm until successful shutdown', async () => {
	const first = await createPortableRuntime(options(memory()));
	await assert.rejects(createPortableRuntime(options(memory())), /Only one/);
	await first.close();
	const second = await createPortableRuntime(options(memory()));
	await second.close();
});

test('explicit backup works while offline and ordinary records never expose the phrase', async () => {
	const volume = memory();
	const mnemonic =
		'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
	volume.write(
		'/wallet/registry.json',
		Buffer.from(
			JSON.stringify({
				record: {
					id: 'offline',
					network: 'regtest',
					name: 'Offline fixture',
					lfbw: { enabled: true },
					lfbwLast: {
						at: 1700000000000,
						action: 'failed',
						error: 'peer lacks option_splice',
						code: 'SPLICING_NOT_NEGOTIATED',
						retryAt: 1700000120000
					}
				},
				mnemonic
			})
		)
	);
	const runtime = await createPortableRuntime(options(volume));
	try {
		const records = await runtime.request({ path: '/api/wallets' });
		assert.equal(JSON.stringify(records).includes('abandon'), false);
		// The last channelize decision survives a restart and is readable by
		// the client, which is how a stuck move stops being invisible.
		assert.deepEqual(records[0].lfbw.lastChannelize, {
			at: 1700000000000,
			action: 'failed',
			error: 'peer lacks option_splice',
			code: 'SPLICING_NOT_NEGOTIATED',
			retryAt: 1700000120000
		});
		assert.equal(records[0].lfbw.lastOffer, null);
		assert.equal(
			(await runtime.request({ path: '/wallets/offline/api/mnemonic' }))
				.mnemonic,
			mnemonic
		);
	} finally {
		await runtime.close();
	}
});

test('the direct-funding policy lets every beignet payer grow the home channel', () => {
  const rules = require('../portable/lfbw.cjs');
  const primary = { pubkey: 'ab'.repeat(33), relayHost: 'relay.example', relayPort: 9735 };
  const cfg = rules.directFundingConfig({ mode: 'external', trusted: true }, primary);
  assert.equal(cfg.allowSplice, true);
  // A stranger's confirmed coin splices too (beignet #760); the lock depth is
  // left to the engine's default, so it is not named here.
  assert.equal(cfg.allowUnpairedSplice, true);
  assert.equal('unpairedSpliceDepth' in cfg, false);
  assert.equal(cfg.trusted, true);
  const held = rules.directFundingConfig({ mode: 'external' }, primary, {
    allowSpliceSupported: false,
  });
  assert.equal('allowSplice' in held, false);
  assert.equal('allowUnpairedSplice' in held, false);
});

test('the networks accepted at creation are the networks advertised', async () => {
	const volume = memory();
	const runtime = await createPortableRuntime(options(volume));
	try {
		const config = await runtime.request({ path: '/api/config' });
		assert.deepEqual(config.supportedNetworks, [
			'mainnet',
			'testnet',
			'signet',
			'regtest'
		]);
		// With no Electrum transport, creation stops right after the network
		// check, so the refusal names which side of that check a network fell
		// on without opening a database or a socket.
		const refusal = async (network) => {
			try {
				await runtime.request({
					method: 'POST',
					path: '/api/wallets',
					body: { network }
				});
			} catch (e) {
				return e.code;
			}
			return null;
		};
		for (const network of config.supportedNetworks)
			assert.equal(await refusal(network), 'ELECTRUM_REQUIRED', network);
		for (const network of ['testnet4', 'bitcoin', 'liquid', ''])
			assert.equal(await refusal(network), 'INVALID_NETWORK', network);
		assert.equal(volume.read('/wallet/registry.json'), null);
	} finally {
		await runtime.close();
	}
});

test('the config flag says the engine implements offline receiving; the record says whether the primary answered', async () => {
	const volume = memory();
	volume.write(
		'/wallet/registry.json',
		Buffer.from(
			JSON.stringify({
				record: {
					id: 'stopped',
					network: 'regtest',
					name: 'Stopped fixture',
					lfbw: {
						enabled: true,
						mode: 'external',
						primaryPubkey: '02' + '33'.repeat(32),
						setup: 'ready'
					}
				},
				mnemonic:
					'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
			})
		)
	);
	const runtime = await createPortableRuntime(options(volume));
	try {
		// Engine-wide and answered before any wallet exists: it cannot speak
		// for a primary, so it keeps meaning "the engine implements this".
		const config = await runtime.request({ path: '/api/config' });
		assert.equal(config.offlineReceiveAvailable, true);
		// Per wallet: null until the primary has connected and answered.
		const [record] = await runtime.request({ path: '/api/wallets' });
		assert.equal(record.lfbw.offlineReceiveAvailable, null);
		assert.equal(record.lfbw.offlineReceiveReason, null);
		assert.equal('offlineReceiveAvailable' in record.lfbw, true);
	} finally {
		await runtime.close();
	}
});

test('the config advertises channel sends and ranked primaries; the policy routes need a started wallet', async () => {
	const volume = memory();
	volume.write(
		'/wallet/registry.json',
		Buffer.from(
			JSON.stringify({
				record: {
					id: 'stopped',
					network: 'regtest',
					name: 'Stopped fixture',
					lfbw: {
						enabled: true,
						mode: 'external',
						primaryPubkey: '02' + '33'.repeat(32),
						setup: 'ready'
					}
				},
				mnemonic:
					'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
			})
		)
	);
	const runtime = await createPortableRuntime(options(volume));
	try {
		const config = await runtime.request({ path: '/api/config' });
		// The engine in this bundle pays an address out of one or several
		// channels through /channel-send, and the router serves those routes.
		assert.equal(config.channelSendAvailable, true);
		// The runtime keeps the engine's list, dials every primary and steers
		// receives by it, so a client may present ranked primaries against this
		// build (coreyphillips/beignet#1924).
		assert.equal(config.primariesAvailable, true);
		// The policy lives in the engine, so with the wallet stopped there is
		// nothing to read or write; the refusal is the one every daemon route
		// gives, and nothing is persisted.
		const before = volume.read('/wallet/registry.json').toString();
		for (const [method, path, body] of [
			['GET', '/wallets/stopped/api/primaries'],
			['POST', '/wallets/stopped/api/primaries/add', { pubkey: '02' + '44'.repeat(32), host: 'b.example', port: 9735 }],
			['POST', '/wallets/stopped/api/channel-send/quote', { address: 'bcrt1q', amountSats: 1000, feeratePerkw: 253 }]
		]) {
			await assert.rejects(
				runtime.request({ method, path, body }),
				(error) => error.code === 'WALLET_STOPPED' && error.status === 409
			);
		}
		assert.equal(volume.read('/wallet/registry.json').toString(), before);
	} finally {
		await runtime.close();
	}
});

const KEY_A = '02' + 'aa'.repeat(32);
const KEY_B = '03' + 'bb'.repeat(32);
const URI_A = `${KEY_A}@a.example:9735`;
const URI_B = `${KEY_B}@b.example:9736`;
const MNEMONIC =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** A volume that counts its writes, so a load that changes nothing can be seen to write nothing. */
const counting = () => {
	const volume = memory();
	const write = volume.write;
	volume.writes = 0;
	volume.write = (p, b) => {
		volume.writes += 1;
		return write(p, b);
	};
	return volume;
};
const legacyRegistry = (lfbw = {}) =>
	Buffer.from(
		JSON.stringify({
			record: {
				id: 'legacy',
				network: 'regtest',
				name: 'Legacy fixture',
				lfbw: {
					enabled: true,
					mode: 'external',
					primaryWalletId: null,
					primaryUri: URI_A,
					primaryPubkey: KEY_A,
					trusted: true,
					initialChannelSats: 0,
					initialChannelOpened: false,
					setup: 'ready',
					setupError: null,
					setupAt: 1700000000000,
					previousPrimary: { pubkey: KEY_B, walletId: null, at: 1 },
					...lfbw
				}
			},
			mnemonic: MNEMONIC
		})
	);

test('a record from before ranked primaries is read as a one-entry list, written back once, and left alone by the next load', async () => {
	const volume = counting();
	volume.write('/wallet/registry.json', legacyRegistry());
	volume.writes = 0;
	const runtime = await createPortableRuntime(options(volume));
	try {
		assert.equal(volume.writes, 1, 'the migrated record is written back at load');
		const [record] = await runtime.request({ path: '/api/wallets' });
		assert.deepEqual(record.lfbw.primaries, [
			{
				pubkey: KEY_A,
				uri: URI_A,
				trusted: true,
				initialChannelOpened: false,
				setup: 'ready',
				setupError: null,
				setupAt: 1700000000000,
				connected: false,
				offlineReceiveAvailable: null,
				offlineReceiveReason: null
			}
		]);
		// The scalar fields older readers look at are the rank-1 entry's.
		assert.equal(record.lfbw.primaryUri, URI_A);
		assert.equal(record.lfbw.primaryPubkey, KEY_A);
		assert.equal(record.lfbw.setup, 'ready');
		assert.equal(record.lfbw.setupAt, 1700000000000);
		assert.equal(record.lfbw.primariesThresholdSat, null);
		assert.equal(record.lfbw.receiveTarget, KEY_A);
		// Derived from the channels now, and there are none with a stopped node.
		assert.equal(record.lfbw.previousPrimary, null);
		assert.deepEqual(record.lfbw.retainedPeers, []);
		assert.equal(JSON.stringify(record).includes('abandon'), false);
		const stored = JSON.parse(Buffer.from(volume.read('/wallet/registry.json')).toString());
		assert.equal(stored.mnemonic, MNEMONIC);
		assert.equal('previousPrimary' in stored.record.lfbw, false);
		assert.equal('primariesSyncedAt' in stored.record.lfbw, false, 'unsynced: the first start seeds the engine');
	} finally {
		await runtime.close();
	}
	volume.writes = 0;
	const again = await createPortableRuntime(options(volume));
	try {
		await again.request({ path: '/api/wallets' });
		assert.equal(volume.writes, 0, 'an already migrated record is not rewritten');
	} finally {
		await again.close();
	}
});

test('a primary edit on a stopped wallet is kept, as one list or as a rank-1 replacement, before the start it needs is refused', async () => {
	const volume = memory();
	volume.write('/wallet/registry.json', legacyRegistry({ setup: 'pending', setupAt: null }));
	const runtime = await createPortableRuntime(options(volume));
	try {
		const stored = () => JSON.parse(Buffer.from(volume.read('/wallet/registry.json')).toString()).record.lfbw;
		// The legacy manager shape: one primary replaces rank 1.
		await assert.rejects(
			runtime.request({ method: 'PATCH', path: '/api/wallets/legacy', body: { primaryNodeUri: URI_B } }),
			(e) => e.code === 'ELECTRUM_REQUIRED'
		);
		let lf = stored();
		assert.deepEqual(lf.primaries.map((e) => e.pubkey), [KEY_B]);
		assert.equal(lf.primaryUri, URI_B);
		assert.equal(lf.primaryPubkey, KEY_B);
		assert.equal(lf.primariesSyncedAt, null);
		// The list shape: every entry, ranked.
		await assert.rejects(
			runtime.request({
				method: 'PATCH',
				path: '/api/wallets/legacy',
				body: { lfbw: { enabled: true, primaries: [{ uri: URI_A, trusted: false }, { uri: URI_B }], primariesThresholdSat: 250000 } }
			}),
			(e) => e.code === 'ELECTRUM_REQUIRED'
		);
		lf = stored();
		assert.deepEqual(lf.primaries.map((e) => [e.pubkey, e.trusted]), [[KEY_A, false], [KEY_B, true]]);
		assert.equal(lf.primariesThresholdSat, 250000);
		assert.equal(lf.primaryPubkey, KEY_A);
		assert.equal(lf.trusted, false);
		// A rank-1 replacement (the one-primary client's edit) keeps the rest
		// of the list, and a node already listed lower is listed once.
		const KEY_C = '02' + 'cc'.repeat(32);
		await assert.rejects(
			runtime.request({ method: 'PATCH', path: '/api/wallets/legacy', body: { primaryNodeUri: `${KEY_C}@c.example:1` } }),
			(e) => e.code === 'ELECTRUM_REQUIRED'
		);
		lf = stored();
		assert.deepEqual(lf.primaries.map((e) => e.pubkey), [KEY_C, KEY_B]);
		assert.equal(lf.primaries[1].trusted, true, 'the kept entry is untouched');
		await assert.rejects(
			runtime.request({ method: 'PATCH', path: '/api/wallets/legacy', body: { primaryNodeUri: `${KEY_B}@moved.example:1` } }),
			(e) => e.code === 'ELECTRUM_REQUIRED'
		);
		lf = stored();
		assert.deepEqual(lf.primaries.map((e) => e.uri), [`${KEY_B}@moved.example:1`]);
		// A malformed list leaves the record as it was.
		const before = JSON.stringify(stored());
		await assert.rejects(
			runtime.request({ method: 'PATCH', path: '/api/wallets/legacy', body: { lfbw: { enabled: true, primaries: [{ uri: URI_A }, { uri: URI_A }] } } }),
			(e) => e.code === 'BAD_LFBW_PEER'
		);
		assert.equal(JSON.stringify(stored()), before);
	} finally {
		await runtime.close();
	}
});

test('behind a relay that reaches one fixed upstream peer a wallet keeps one primary', async () => {
	const relayed = (volume) => {
		const o = options(volume);
		o.socketFactory = Object.assign(() => {
			throw Error('No network should be opened');
		}, { fixedUpstream: true });
		return o;
	};
	const volume = memory();
	volume.write('/wallet/registry.json', legacyRegistry());
	const runtime = await createPortableRuntime(relayed(volume));
	try {
		const before = Buffer.from(volume.read('/wallet/registry.json')).toString();
		await assert.rejects(
			runtime.request({ method: 'PATCH', path: '/api/wallets/legacy', body: { lfbw: { enabled: true, primaries: [{ uri: URI_A }, { uri: URI_B }] } } }),
			(e) => e.code === 'TRANSPORT_SINGLE_PEER' && e.status === 409
		);
		assert.equal(Buffer.from(volume.read('/wallet/registry.json')).toString(), before, 'nothing was written');
		// Replacing the one primary is still allowed.
		await assert.rejects(
			runtime.request({ method: 'PATCH', path: '/api/wallets/legacy', body: { primaryNodeUri: URI_B } }),
			(e) => e.code === 'ELECTRUM_REQUIRED'
		);
		const lf = JSON.parse(Buffer.from(volume.read('/wallet/registry.json')).toString()).record.lfbw;
		assert.deepEqual(lf.primaries.map((e) => e.pubkey), [KEY_B]);
	} finally {
		await runtime.close();
	}
	const fresh = await createPortableRuntime(relayed(memory()));
	try {
		await assert.rejects(
			fresh.request({
				method: 'POST',
				path: '/api/wallets',
				body: {
					network: 'regtest',
					electrum: { host: '127.0.0.1', port: 60001, tls: false },
					lfbw: { enabled: true, primaries: [{ uri: URI_A }, { uri: URI_B }] }
				}
			}),
			(e) => e.code === 'TRANSPORT_SINGLE_PEER'
		);
	} finally {
		await fresh.close();
	}
});

test('a wallet created with a ranked list keeps every entry, unsynced until its engine first runs', async () => {
	const volume = memory();
	const runtime = await createPortableRuntime(options(volume));
	try {
		const created = await runtime.request({
			method: 'POST',
			path: '/api/wallets',
			body: {
				network: 'regtest',
				electrum: { host: '127.0.0.1', port: 60001, tls: false },
				lfbw: { enabled: true, primaries: [{ uri: URI_B }, { uri: URI_A }], primariesThresholdSat: 1000 }
			}
		});
		// No network in this test: the start fails and the record says so,
		// exactly as a one-primary creation did.
		assert.equal(created.record.lfbw.setup, 'failed');
		assert.deepEqual(created.record.lfbw.primaries.map((e) => e.pubkey), [KEY_B, KEY_A]);
		assert.equal(created.record.lfbw.primaryPubkey, KEY_B);
		assert.equal(created.record.lfbw.primariesThresholdSat, 1000);
		const stored = JSON.parse(Buffer.from(volume.read('/wallet/registry.json')).toString()).record.lfbw;
		assert.equal(stored.primariesSyncedAt, null);
		assert.equal(stored.primaries.length, 2);
	} finally {
		await runtime.close();
	}
});

