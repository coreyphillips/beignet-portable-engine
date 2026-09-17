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
