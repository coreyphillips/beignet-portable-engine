const { test } = require('node:test');
const assert = require('node:assert/strict');
const { channelizePause } = require('../portable/channelize-pause.cjs');
const { runChannelize } = require('../portable/channelize.cjs');
const rules = require('../portable/lfbw.cjs');

const failure = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }); };

test('pause persists before acknowledgement and survives a runtime restart until its owner resumes', async () => {
	let saved;
	const config = { read: () => saved, write: (value) => { saved = value; }, busy: () => false, failure, now: () => 42 };
	const first = channelizePause(config);
	assert.deepEqual(first.status(), { paused: false });
	assert.deepEqual(await first.set({ paused: true, requestId: 'drain-one' }), { paused: true, requestId: 'drain-one', since: 42 });
	const restored = channelizePause({ ...config, read: () => JSON.parse(JSON.stringify(saved)) });
	assert.deepEqual(restored.status(), first.status());
	await assert.rejects(restored.set({ paused: false, requestId: 'drain-two' }), (error) => error.code === 'CHANNELIZE_PAUSED');
	assert.equal(restored.status().paused, true);
	assert.deepEqual(await restored.set({ paused: false, requestId: 'drain-one' }), { paused: false });
});

test('a failed persistent pause is not acknowledged', async () => {
	const pause = channelizePause({ read: () => null, write: () => { throw new Error('disk full'); }, busy: () => false, failure });
	await assert.rejects(pause.set({ paused: true, requestId: 'drain-one' }), /disk full/);
	assert.equal(pause.status().paused, false);
});

test('pausing waits for an active channelize pass and retains the hold on timeout', async () => {
	let saved;
	let inFlight = true;
	let time = 0;
	let waited = 0;
	const pause = channelizePause({
		read: () => saved, write: (value) => { saved = value; }, busy: () => inFlight, failure,
		now: () => time, wait: async () => { assert.equal(saved.paused, true); waited++; inFlight = false; }
	});
	await pause.set({ paused: true, requestId: 'drain-one' });
	assert.equal(waited, 1);
	inFlight = true;
	const blocked = channelizePause({
		read: () => saved, write: (value) => { saved = value; }, busy: () => inFlight, failure,
		now: () => time, wait: async () => { time = 15000; }
	});
	await assert.rejects(blocked.set({ paused: true, requestId: 'drain-one' }), (error) => error.code === 'CHANNELIZE_BUSY');
	assert.equal(blocked.status().paused, true);
});

test('a pause that arrives during a quote prevents a new channelize spend', async () => {
	let saved;
	const pause = channelizePause({ read: () => saved, write: (value) => { saved = value; }, busy: () => false, failure });
	let spends = 0;
	const node = {
		getBalance: () => ({ onchain: 60000, lightning: 0 }),
		listUtxos: () => [{ height: 100, valueSats: 60000 }],
		listChannels: () => [],
		getFeeEstimates: async () => ({ normal: 2 }),
		quoteOnchain: async () => {
			await pause.set({ paused: true, requestId: 'drain-one' });
			return { maxSendSats: 58000, feeSats: 400 };
		},
		connectAndOpenChannel: () => { spends++; },
		spliceIn: () => { spends++; }
	};
	const result = await runChannelize({ node, record: { lfbw: { primaryPubkey: 'primary' } }, primary: () => ({}), rules, mayMutate: () => !pause.status().paused });
	assert.equal(result.last, null);
	assert.equal(spends, 0);
});

test('a cancelled pause cannot later acknowledge an active hold', async () => {
	let saved;
	let inFlight = true;
	let pause;
	pause = channelizePause({
		read: () => saved, write: (value) => { saved = value; }, busy: () => inFlight, failure,
		wait: async () => { await pause.set({ paused: false, requestId: 'drain-one' }); inFlight = false; }
	});
	await assert.rejects(pause.set({ paused: true, requestId: 'drain-one' }), (error) => error.code === 'CHANNELIZE_PAUSE_RELEASED');
	assert.equal(pause.status().paused, false);
});

test('pause inputs are strict booleans and durable operation identities', async () => {
	let writes = 0;
	const pause = channelizePause({ read: () => null, write: () => { writes++; }, busy: () => false, failure });
	for (const body of [{}, { paused: 'false', requestId: 'drain-one' }, { paused: true, requestId: 'short' }, { paused: true, requestId: '../invalid' }])
		await assert.rejects(pause.set(body), (error) => error.code === 'INVALID_PARAMS');
	assert.equal(writes, 0);
});
