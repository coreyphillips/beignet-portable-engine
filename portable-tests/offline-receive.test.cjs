const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const path = require('node:path');
const output = buildSync({
	entryPoints: [path.join(__dirname, '../portable/offline-receive.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false
}).outputFiles[0].text;
const fixtureModule = { exports: {} };
new Function('module', 'exports', 'require', output)(
	fixtureModule,
	fixtureModule.exports,
	require
);
const { OfflineReceive } = fixtureModule.exports;
const channelId = '11'.repeat(32),
	epochId = '22'.repeat(32),
	peer = '02' + '33'.repeat(32);
function fixture(overrides = {}) {
	let now = 1000000,
		queries = 0,
		closes = 0;
	const job = {
		id: 'test',
		peer,
		amountSats: 20000,
		allocationId: '44'.repeat(16),
		channelId,
		epochId,
		expiresAt: now + 600000,
		...overrides
	};
	const epoch = {
		channelId,
		epochId,
		state: 'ACTIVE',
		slots: [{ state: 'exposed', amountMsat: '20000000', bolt11: 'invoice' }]
	};
	const node = {
		listChannels: () => [{ channelId, state: 'NORMAL' }],
		fforEpochs: () => [epoch],
		fforEpoch: () => epoch,
		decodeInvoice: () => ({ timestamp: 1000, expiry: 600 }),
		getFforReceiveService: () => ({
			receipts: async () => {
				queries++;
			}
		}),
		fforRecover: async (body) => {
			assert.deepEqual(body, { channelId });
			closes++;
			epoch.state = 'CLOSED';
		}
	};
	const coordinator = new OfflineReceive(
		node,
		() => {},
		[job],
		() => now
	);
	return {
		coordinator,
		node,
		epoch,
		job,
		get queries() {
			return queries;
		},
		get closes() {
			return closes;
		},
		set now(v) {
			now = v;
		}
	};
}
test('reopening an unpaid request queries receipts without closing its reservation', async () => {
	const f = fixture();
	await f.coordinator.sync();
	await f.coordinator.sync();
	assert.equal(f.queries, 2);
	assert.equal(f.closes, 0);
});
test('paid receipt closes once and terminal state releases the reservation', async () => {
	const f = fixture();
	f.epoch.slots[0].state = 'settled';
	await f.coordinator.sync();
	await f.coordinator.sync();
	assert.equal(f.closes, 1);
	assert.equal(f.coordinator.reservedIds().size, 0);
});
test('expired invoices keep a settlement grace period and failed queries never close them', async () => {
	const f = fixture({ expiresAt: 1000000 });
	f.now = 1119999;
	await f.coordinator.sync();
	assert.equal(f.closes, 0);
	f.now = 1120000;
	f.node.getFforReceiveService = () => ({
		receipts: async () => {
			throw Error('offline');
		}
	});
	await f.coordinator.sync();
	assert.equal(f.closes, 0);
	f.node.getFforReceiveService = () => ({ receipts: async () => {} });
	await f.coordinator.sync();
	assert.equal(f.closes, 1);
});
test('startup repairs expiry from the durable invoice before deciding whether to release', async () => {
	const f = fixture({ expiresAt: undefined });
	await f.coordinator.sync();
	assert.equal(f.job.expiresAt, 1600000);
	assert.equal(f.closes, 0);
});
test('a replaced epoch is never recovered through an older request', async () => {
	const f = fixture();
	f.epoch.epochId = '55'.repeat(32);
	await f.coordinator.sync();
	assert.equal(f.queries, 0);
	assert.equal(f.closes, 0);
});
test('an unused reservation from interrupted creation is released, not exposed as a new invoice', async () => {
	const f = fixture({ expiresAt: undefined });
	f.epoch.slots = [{ state: 'unissued', amountMsat: '20000000' }];
	await f.coordinator.sync();
	assert.equal(f.closes, 1);
});
test('stopping prevents background mutations and corrupt journals fail closed', async () => {
	const f = fixture();
	f.coordinator.stop();
	await f.coordinator.sync();
	assert.equal(f.queries, 0);
	assert.throws(
		() => new OfflineReceive(f.node, () => {}, [{}]),
		/Invalid receive journal/
	);
});

test('below-trim requests fail before querying or allocating provider funds', async () => {
 const f=fixture();await assert.rejects(f.coordinator.quote(peer,1),{code:'AMOUNT_TOO_SMALL'});assert.equal(f.queries,0);
});
test('changed sender fees fail before a reservation or channel is created',async()=>{
 const f=fixture();let saves=0;
 f.node.getFforReceiveService=()=>({request:async()=>({version:1,feeBaseMsat:1,feePpm:0})});
 const coordinator=new OfflineReceive(f.node,()=>{saves++;},[],()=>1000);
 await assert.rejects(coordinator.create({requestId:'review',amountSats:20000,quote:{peer,amountSats:20000,terms:{feeBaseMsat:0,feePpm:0},expiresAt:2000}},peer),{code:'FEE_CHANGED'});
 assert.equal(saves,0);
});

function receiver(channels, { epochs = [], jobs = [], fees = { feeBaseMsat: 0, feePpm: 0 } } = {}) {
	let requests = 0;
	const node = {
		listChannels: () => channels,
		fforEpochs: () => epochs,
		getFforReceiveService: () => ({
			request: async () => {
				requests++;
				return { version: 1, ...fees };
			}
		})
	};
	const coordinator = new OfflineReceive(node, () => {}, jobs, () => 1000);
	return {
		coordinator,
		get requests() {
			return requests;
		}
	};
}
const empty = (remoteBalanceSats, extra = {}) => ({
	channelId,
	peerPubkey: peer,
	state: 'NORMAL',
	htlcUsable: true,
	localBalanceSats: 0,
	remoteBalanceSats,
	...extra
});
const most = (channels, options) =>
	receiver(channels, options).coordinator.capacity(peer).maxSats;

test('capacity counts only an empty usable channel with the primary, less the headroom', () => {
	assert.equal(most([]), 0);
	assert.equal(most([empty(80000)]), 30000);
	assert.equal(most([empty(80000), empty(120000, { channelId: '55'.repeat(32) })]), 70000);
	assert.equal(most([empty(80000, { localBalanceSats: 1 })]), 0);
	assert.equal(most([empty(80000, { peerPubkey: '03' + '33'.repeat(32) })]), 0);
	assert.equal(most([empty(80000, { htlcUsable: false })]), 0);
	assert.equal(most([empty(80000, { state: 'SPLICING' })]), 0);
});
test('capacity is 0 below the minimum offline amount', () => {
	assert.equal(most([empty(50353)]), 0);
	assert.equal(most([empty(50354)]), 354);
});
test('a reserved channel or one with a live epoch holds no further offline receive', () => {
	const held = { id: 'held', peer, amountSats: 1000, allocationId: '44'.repeat(16), channelId };
	assert.equal(most([empty(80000)], { jobs: [held] }), 0);
	assert.equal(most([empty(80000)], { jobs: [{ ...held, done: true }] }), 30000);
	assert.equal(most([empty(80000)], { epochs: [{ channelId, state: 'ACTIVE' }] }), 0);
	assert.equal(most([empty(80000)], { epochs: [{ channelId, state: 'CLOSED' }] }), 30000);
});
test('quote refuses before asking the primary when no channel can hold the amount', async () => {
	const none = receiver([empty(80000, { localBalanceSats: 5000 })]);
	await assert.rejects(none.coordinator.quote(peer, 20000), {
		code: 'RECEIVE_UNAVAILABLE',
		message: /No channel can hold an offline receive right now/
	});
	assert.equal(none.requests, 0);
	const small = receiver([empty(80000)]);
	await assert.rejects(small.coordinator.quote(peer, 30001), {
		code: 'RECEIVE_UNAVAILABLE',
		message: /up to 30000 sats/
	});
	assert.equal(small.requests, 0);
	const quote = await small.coordinator.quote(peer, 30000);
	assert.equal(quote.available, true);
	assert.equal(small.requests, 1);
});
test('a retried create is not refused over its own reservation', async () => {
	const r = receiver([empty(80000)], {
		jobs: [{ id: 'review', peer, amountSats: 20000, allocationId: '44'.repeat(16), channelId }],
		fees: { feeBaseMsat: 1, feePpm: 0 }
	});
	await assert.rejects(
		r.coordinator.create(
			{
				requestId: 'review',
				amountSats: 20000,
				quote: { peer, amountSats: 20000, terms: { feeBaseMsat: 0, feePpm: 0 }, expiresAt: 2000 }
			},
			peer
		),
		{ code: 'FEE_CHANGED' }
	);
});

/** A wallet whose primary answers the receive-terms quote as `answer` says. */
function primary(answer) {
	let requests = 0,
		now = 1000;
	const node = {
		listChannels: () => [],
		fforEpochs: () => [],
		getFforReceiveService: () => ({
			request: async (_peer, body, timeout) => {
				requests++;
				assert.deepEqual(body, { op: 'quote' });
				assert.equal(timeout, 15000);
				return answer();
			}
		})
	};
	const coordinator = new OfflineReceive(node, () => {}, [], () => now);
	return {
		coordinator,
		get requests() {
			return requests;
		},
		set now(v) {
			now = v;
		}
	};
}
const unprobed = { available: null, reason: null, probedAt: null };
test('a primary that answers the quote with an unsupported version leaves the flag false with the reason', async () => {
	const p = primary(async () => ({ version: 2, feeBaseMsat: 0, feePpm: 0 }));
	const answer = await p.coordinator.probe(peer);
	assert.deepEqual(answer, {
		available: false,
		reason: 'Your node returned unsupported receive terms.',
		probedAt: 1000
	});
	assert.deepEqual(p.coordinator.availability(peer), answer);
	assert.equal(p.requests, 1);
});
test('a primary that refuses, or never answers within the bound, is recorded with that refusal', async () => {
	const refused = primary(async () => {
		throw Object.assign(new Error('Your node does not provide offline receiving.'), {
			code: 'RECEIVE_UNAVAILABLE'
		});
	});
	await refused.coordinator.probe(peer);
	assert.deepEqual(refused.coordinator.availability(peer), {
		available: false,
		reason: 'Your node does not provide offline receiving.',
		probedAt: 1000
	});
	const silent = primary(async () => {
		throw Object.assign(new Error('Your node did not answer the receive request.'), {
			code: 'RECEIVE_UNAVAILABLE'
		});
	});
	await silent.coordinator.probe(peer);
	assert.equal(silent.coordinator.availability(peer).available, false);
	assert.match(silent.coordinator.availability(peer).reason, /did not answer/);
});
test('a supported answer sets the flag true, and a review that reaches the primary records what it learned', async () => {
	const p = primary(async () => ({ version: 1, feeBaseMsat: 10, feePpm: 5 }));
	await p.coordinator.probe(peer);
	assert.deepEqual(p.coordinator.availability(peer), {
		available: true,
		reason: null,
		probedAt: 1000
	});
	// The quote path asks the same question, so its answer counts too: a
	// primary that stopped settling since the probe flips the flag, and the
	// review is still refused before an invoice is shared.
	let answer = async () => ({ version: 1, feeBaseMsat: 0, feePpm: 0 });
	let now = 1000;
	const node = {
		listChannels: () => [empty(80000)],
		fforEpochs: () => [],
		getFforReceiveService: () => ({ request: () => answer() })
	};
	const reviewed = new OfflineReceive(node, () => {}, [], () => now);
	assert.deepEqual(reviewed.availability(peer), unprobed);
	await reviewed.quote(peer, 30000);
	assert.deepEqual(reviewed.availability(peer), {
		available: true,
		reason: null,
		probedAt: 1000
	});
	now = 2000;
	answer = async () => ({ version: 3 });
	await assert.rejects(reviewed.quote(peer, 30000), { code: 'RECEIVE_UNAVAILABLE' });
	assert.deepEqual(reviewed.availability(peer), {
		available: false,
		reason: 'Your node returned unsupported receive terms.',
		probedAt: 2000
	});
});
test('a wallet whose primary has not connected leaves the flag null, and so does a changed primary', async () => {
	const p = primary(async () => ({ version: 1, feeBaseMsat: 0, feePpm: 0 }));
	assert.deepEqual(p.coordinator.availability(peer), unprobed);
	assert.equal(p.requests, 0);
	await p.coordinator.probe(peer);
	assert.equal(p.coordinator.availability(peer).available, true);
	assert.deepEqual(p.coordinator.availability('03' + '33'.repeat(32)), unprobed);
});
test('probes in flight for one primary share a request, and a stopped coordinator asks nothing', async () => {
	let resolve;
	const p = primary(() => new Promise((r) => (resolve = r)));
	const first = p.coordinator.probe(peer);
	const second = p.coordinator.probe(peer);
	assert.equal(p.requests, 1);
	resolve({ version: 1, feeBaseMsat: 0, feePpm: 0 });
	assert.deepEqual(await first, await second);
	assert.equal((await first).available, true);
	p.coordinator.stop();
	assert.equal((await p.coordinator.probe(peer)).available, true);
	assert.equal(p.requests, 1);
});
