const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const output = buildSync({
	entryPoints: [require.resolve('../portable/offline-receive.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', output)(mod, mod.exports, require);
const { OfflineReceive } = mod.exports;
const channelId = '11'.repeat(32),
	epochId = '22'.repeat(32),
	peer = '02' + '33'.repeat(32);
function receiver() {
	let now = 1000000,
		saved = [],
		epoch,
		coordinator,
		terms = {
			version: 1,
			feeBaseMsat: 0,
			feePpm: 0,
			concurrent: true,
			concurrentVersion: 2
		};
	let starts = 0,
		syncs = 0,
		closes = 0,
		negotiated = true,
		failSave = false;
	const channel = {
		channelId,
		peerPubkey: peer,
		state: 'NORMAL',
		htlcUsable: true,
		localBalanceSats: 80000,
		remoteBalanceSats: 220000,
		htlcCount: 0
	};
	const node = {
		listChannels: () => [channel],
		fforConcurrentNegotiated: () => negotiated,
		fforEpochs: () => (epoch ? [epoch] : []),
		fforEpoch: () => epoch,
		getInfo: () => ({ blockHeight: 100 }),
		getFforReceiveService: () => ({
			request: async () => terms,
			receipts: () => {
				throw Error('Concurrent books must use signed sync');
			}
		}),
		fforStartEpoch(params) {
			assert.equal(saved[0].channelId, channelId);
			assert.equal(saved[0].concurrentVersion, 2);
			assert.equal(params.concurrent, true);
			assert.equal(params.concurrentVersion, 2);
			starts++;
			epoch = {
				channelId,
				epochId,
				state: 'ACTIVE',
				concurrent: true,
				concurrentVersion: 2,
				slots: [
					{
						state: 'unissued',
						amountMsat: '20000000',
						paymentHash: '55'.repeat(32)
					}
				]
			};
			channel.ffor = {
				state: 'ACTIVE',
				concurrent: true,
				concurrentVersion: 2,
				reservedInboundSats: 20000,
				unresolvedSlots: 1
			};
			return epoch;
		},
		fforCreateInvoice() {
			epoch.slots[0].bolt11 = 'invoice';
			epoch.slots[0].state = 'exposed';
			return { bolt11: 'invoice', paymentHash: epoch.slots[0].paymentHash };
		},
		getStorage: () => ({
			loadAllInvoices: () =>
				epoch?.slots[0].bolt11
					? [{ paymentHashHex: epoch.slots[0].paymentHash }]
					: []
		}),
		decodeInvoice: () => ({ timestamp: 1000, expiry: 600 }),
		fforSync() {
			syncs++;
		},
		fforCloseEpoch() {
			closes++;
			epoch.state = 'DRAINING';
			channel.ffor.state = 'DRAINING';
		},
		fforRecover() {
			throw Error('Concurrent books must not use legacy recovery');
		}
	};
	function restart() {
		coordinator = new OfflineReceive(
			node,
			(jobs) => {
				if (failSave) throw Error('disk unavailable');
				saved = structuredClone(jobs);
			},
			structuredClone(saved),
			() => now
		);
		return coordinator;
	}
	restart();
	return {
		node,
		channel,
		restart,
		get c() {
			return coordinator;
		},
		get epoch() {
			return epoch;
		},
		get saved() {
			return saved;
		},
		get starts() {
			return starts;
		},
		get syncs() {
			return syncs;
		},
		get closes() {
			return closes;
		},
		set now(v) {
			now = v;
		},
		set terms(v) {
			terms = v;
		},
		set negotiated(v) {
			negotiated = v;
		},
		set failSave(v) {
			failSave = v;
		}
	};
}
async function create(f, requestId = 'concurrent-request') {
	const quote = await f.c.quote(peer, 20000, requestId);
	return f.c.create({ requestId, amountSats: 20000, quote }, peer);
}
test('funded capacity requires negotiated concurrent terms and persists the profile before starting', async () => {
	const f = receiver();
	assert.equal(f.c.capacity(peer).maxSats, 0);
	await f.c.probe(peer);
	assert.equal(f.c.capacity(peer).maxSats, 170000);
	const invoice = await create(f);
	assert.equal(invoice.concurrentVersion, 2);
	assert.equal(f.starts, 1);
	assert.equal(f.c.capacity(peer).maxSats, 0);
	assert.equal(f.c.status().requests[0].reservedInboundSats, 20000);
	assert.equal(f.channel.htlcUsable, true);
});
test('baseline terms, unsupported versions and explicit opt-out refuse a funded channel', async () => {
	for (const mode of ['baseline', 'unsupported', 'opt-out']) {
		const f = receiver();
		if (mode === 'baseline')
			f.terms = { version: 1, feeBaseMsat: 0, feePpm: 0 };
		if (mode === 'unsupported')
			f.terms = {
				version: 1,
				feeBaseMsat: 0,
				feePpm: 0,
				concurrent: true,
				concurrentVersion: 3
			};
		if (mode === 'opt-out') f.negotiated = false;
		await assert.rejects(create(f), { code: 'RECEIVE_UNAVAILABLE' });
		assert.equal(f.starts, 0);
	}
});
test('busy creation and an expired quote retry on the same channel and profile after restart', async () => {
	const f = receiver();
	f.channel.htlcCount = 1;
	await assert.rejects(create(f), { code: 'RECEIVE_PENDING' });
	assert.equal(f.saved[0].channelId, channelId);
	assert.equal(f.saved[0].concurrentVersion, 2);
	f.restart();
	f.channel.htlcCount = 0;
	const quote = await f.c.quote(peer, 20000, 'concurrent-request');
	f.now = quote.expiresAt;
	await assert.rejects(
		f.c.create(
			{ requestId: 'concurrent-request', amountSats: 20000, quote },
			peer
		),
		{ code: 'QUOTE_EXPIRED' }
	);
	const invoice = await create(f);
	assert.equal(invoice.paymentHash, '55'.repeat(32));
	assert.equal(f.starts, 1);
	assert.equal(f.saved.length, 1);
});
test('saved concurrent requests never downgrade when the peer stops advertising support', async () => {
	const f = receiver();
	f.channel.htlcCount = 1;
	await assert.rejects(create(f), { code: 'RECEIVE_PENDING' });
	f.restart();
	f.channel.htlcCount = 0;
	f.terms = { version: 1, feeBaseMsat: 0, feePpm: 0 };
	await assert.rejects(f.c.quote(peer, 20000, 'concurrent-request'), {
		code: 'RECEIVE_UNAVAILABLE'
	});
	assert.equal(f.c.reservedIds().has(channelId), true);
	assert.equal(f.starts, 0);
});
test('two cold coordinator reloads sync a live book without retiring or duplicating its invoice', async () => {
	const f = receiver();
	const invoice = await create(f);
	for (let n = 0; n < 2; n++) {
		f.restart();
		await f.c.sync();
		assert.deepEqual(await create(f), invoice);
		assert.equal(f.epoch.state, 'ACTIVE');
	}
	assert.equal(f.syncs, 2);
	assert.equal(f.closes, 0);
	assert.equal(f.starts, 1);
});
test('a received proof is not redemption and does not retire a live book', async () => {
	const f = receiver();
	await create(f);
	f.epoch.slots[0].state = 'settled';
	await f.c.sync();
	assert.equal(f.closes, 0);
	assert.equal(f.c.reservedIds().has(channelId), true);
});
test('early closure and invoice expiry retain an unknown reservation through two restarts', async () => {
	const f = receiver();
	await create(f);
	f.now = 1720000;
	await f.c.sync();
	assert.equal(f.epoch.state, 'DRAINING');
	for (let n = 0; n < 2; n++) {
		f.restart();
		await f.c.sync();
		assert.equal(f.c.reservedIds().has(channelId), true);
		assert.equal(f.c.status().requests[0].unresolvedSlots, 1);
		assert.equal(f.channel.htlcUsable, true);
		await assert.rejects(create(f), { code: 'RECEIVE_UNAVAILABLE' });
	}
	assert.equal(f.closes, 1);
	assert.equal(f.syncs, 3);
});
test('terminal outcomes allow closure and only the engine terminal state releases a reservation', async () => {
	const f = receiver();
	await create(f);
	f.epoch.slots[0].state = 'redeemed';
	await f.c.sync();
	assert.equal(f.closes, 1);
	assert.equal(f.c.reservedIds().has(channelId), true);
	f.epoch.state = 'CLOSED';
	await f.c.sync();
	assert.equal(f.c.reservedIds().has(channelId), false);
});
test('journal failure stops coordinator mutation before an epoch can start', async () => {
	const f = receiver();
	f.failSave = true;
	await assert.rejects(create(f), /disk unavailable/);
	f.failSave = false;
	await assert.rejects(create(f), { code: 'RECEIVE_UNAVAILABLE' });
	assert.equal(f.starts, 0);
});
