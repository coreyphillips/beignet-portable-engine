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
