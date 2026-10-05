const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { engineDiagnostics } = require('../portable/engine-diagnostics.cjs');

const recorder = () => {
	const seen = [];
	return { seen, onDiagnostic: (entry) => seen.push(entry) };
};

test('create and initial-sync are reported as engine-perf marks with their duration', async () => {
	const { seen, onDiagnostic } = recorder();
	let clock = 1000;
	const perf = engineDiagnostics({ onDiagnostic, now: () => clock });
	const node = await perf.time('create', async () => {
		clock += 812;
		return 'node';
	});
	assert.equal(node, 'node');
	await perf.time('initial-sync', async () => {
		clock += 2140;
	});
	assert.deepEqual(seen, [
		{ phase: 'engine-perf', message: 'create 812ms' },
		{ phase: 'engine-perf', message: 'initial-sync 2140ms' }
	]);
	// The client files each timing under the first word and keeps the rest.
	const [mark, ...detail] = seen[1].message.split(' ');
	assert.equal(mark, 'initial-sync');
	assert.equal(detail.join(' '), '2140ms');
});

test('a step that fails is not reported and its error passes through', async () => {
	const { seen, onDiagnostic } = recorder();
	const perf = engineDiagnostics({ onDiagnostic, now: () => 0 });
	await assert.rejects(
		perf.time('create', async () => {
			throw new Error('Electrum refused');
		}),
		/Electrum refused/
	);
	assert.deepEqual(seen, []);
});

test('gossip:synced reports the import timings and the channels it added', () => {
	const { seen, onDiagnostic } = recorder();
	const perf = engineDiagnostics({ onDiagnostic });
	const node = new EventEmitter();
	perf.watchGossip(node);
	perf.watchGossip(node);
	assert.equal(node.listenerCount('gossip:synced'), 1);
	node.emit('gossip:synced', {
		channelsAdded: 28000,
		updatesApplied: 56000,
		downloadMs: 950,
		applyMs: 3100,
		busyMs: 2400,
		slices: 310
	});
	// An engine before 0.28.0 sends the counts alone.
	node.emit('gossip:synced', { channelsAdded: 12, updatesApplied: 24 });
	node.emit('gossip:synced', undefined);
	assert.deepEqual(
		seen.map((entry) => entry.message),
		[
			'gossip-synced download 950ms apply 3100ms busy 2400ms slices 310 channels 28000',
			'gossip-synced channels 12',
			'gossip-synced'
		]
	);
	assert.ok(seen.every((entry) => entry.phase === 'engine-perf'));
	// A node from a later start gets its own listener.
	const next = new EventEmitter();
	perf.watchGossip(next);
	assert.equal(next.listenerCount('gossip:synced'), 1);
});

test('without a hook nothing is timed or listened to', async () => {
	const perf = engineDiagnostics({
		now: () => assert.fail('the clock is not read without a hook')
	});
	assert.equal(await perf.time('create', async () => 'node'), 'node');
	const node = new EventEmitter();
	perf.watchGossip(node);
	assert.equal(node.listenerCount('gossip:synced'), 0);
});

test('a hook that throws fails neither the step nor the engine event', async () => {
	const perf = engineDiagnostics({
		onDiagnostic: () => {
			throw new Error('hook broke');
		},
		now: () => 0
	});
	assert.equal(await perf.time('create', async () => 'node'), 'node');
	const node = new EventEmitter();
	perf.watchGossip(node);
	assert.equal(node.emit('gossip:synced', { channelsAdded: 1 }), true);
});
