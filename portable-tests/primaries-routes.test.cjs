const { test } = require('node:test');
const assert = require('node:assert/strict');
const { primariesRoutes } = require('../portable/primaries-routes.cjs');

const failure = (code, message, status = 400) => {
	throw Object.assign(new Error(message), { code, status });
};
const PK_A = '02' + 'aa'.repeat(32);
const PK_B = '03' + 'bb'.repeat(32);
const info = (pubkeys, fillThresholdSat = null) => ({
	fillThresholdSat,
	primaries: pubkeys.map((pubkey, i) => ({ pubkey, rank: i + 1 })),
	receiveTarget: pubkeys[0] ?? null
});
const recording = (overrides = {}) => {
	const calls = [];
	const node = {
		listPrimaries: () => info([PK_A]),
		addPrimary: (opts) => { calls.push(['addPrimary', opts]); return info([PK_A, opts.pubkey]); },
		removePrimary: (pubkey) => { calls.push(['removePrimary', pubkey]); return info([]); },
		reorderPrimaries: (order) => { calls.push(['reorderPrimaries', order]); return info(order); },
		setPrimariesFillThreshold: (sats) => { calls.push(['setPrimariesFillThreshold', sats]); return info([PK_A], sats); },
		...overrides
	};
	return { node, calls };
};

test('the table serves exactly the daemon\'s five primaries routes', () => {
	const { node } = recording();
	assert.deepEqual(Object.keys(primariesRoutes({ node, failure })).sort(), [
		'GET /primaries',
		'POST /primaries/add',
		'POST /primaries/remove',
		'POST /primaries/reorder',
		'POST /primaries/threshold'
	]);
});

test('reads answer the engine\'s list as is', () => {
	const { node } = recording();
	assert.deepEqual(primariesRoutes({ node, failure })['GET /primaries']({}, new URLSearchParams()), info([PK_A]));
});

test('an add forwards only the keys the body names, by their daemon names', async () => {
	const { node, calls } = recording();
	const api = primariesRoutes({ node, failure });
	await api['POST /primaries/add']({ pubkey: PK_B, host: 'b.example', port: 9735 });
	await api['POST /primaries/add']({ pubkey: PK_B, uri: `${PK_B}@iroh:abc`, rank: 1 });
	await api['POST /primaries/add']({ pubkey: PK_B, host: undefined, extra: 'ignored' });
	assert.deepEqual(calls, [
		['addPrimary', { pubkey: PK_B, host: 'b.example', port: 9735 }],
		['addPrimary', { pubkey: PK_B, uri: `${PK_B}@iroh:abc`, rank: 1 }],
		['addPrimary', { pubkey: PK_B }]
	]);
});

test('remove, reorder (body key order) and threshold reach the engine and answer the whole list', async () => {
	const { node, calls } = recording();
	const api = primariesRoutes({ node, failure });
	assert.deepEqual(await api['POST /primaries/remove']({ pubkey: PK_A }), info([]));
	assert.deepEqual(await api['POST /primaries/reorder']({ order: [PK_B, PK_A] }), info([PK_B, PK_A]));
	assert.deepEqual(await api['POST /primaries/threshold']({ fillThresholdSat: 250000 }), info([PK_A], 250000));
	assert.deepEqual(await api['POST /primaries/threshold']({ fillThresholdSat: null }), info([PK_A], null));
	assert.deepEqual(calls, [
		['removePrimary', PK_A],
		['reorderPrimaries', [PK_B, PK_A]],
		['setPrimariesFillThreshold', 250000],
		['setPrimariesFillThreshold', null]
	]);
});

test('a threshold body without fillThresholdSat is refused before the engine is touched', () => {
	const { node, calls } = recording();
	const api = primariesRoutes({ node, failure });
	assert.throws(() => api['POST /primaries/threshold']({}), (error) => error.code === 'INVALID_PARAMS' && error.status === 400);
	assert.deepEqual(calls, []);
});

test('an engine refusal propagates with its own code and nothing is written after it', async () => {
	const refusal = Object.assign(new Error('pubkey already a primary'), { code: 'INVALID_PARAMS' });
	const writes = [];
	const { node } = recording({ addPrimary: () => { throw refusal; } });
	const api = primariesRoutes({ node, failure, onWrite: (...args) => writes.push(args) });
	await assert.rejects(api['POST /primaries/add']({ pubkey: PK_A }), (error) => error === refusal);
	assert.deepEqual(writes, []);
});

test('onWrite sees the engine\'s answer and the write it came from, and its failure fails the route', async () => {
	const { node } = recording();
	const writes = [];
	const api = primariesRoutes({ node, failure, onWrite: async (info, write) => { writes.push([info, write]); } });
	const answer = await api['POST /primaries/add']({ pubkey: PK_B, host: 'b.example', port: 9735 });
	assert.deepEqual(writes, [[answer, { kind: 'add', body: { pubkey: PK_B, host: 'b.example', port: 9735 } }]]);
	const broken = primariesRoutes({ node, failure, onWrite: async () => { throw Object.assign(new Error('disk'), { code: 'DURABILITY_FAILED' }); } });
	await assert.rejects(broken['POST /primaries/remove']({ pubkey: PK_A }), (error) => error.code === 'DURABILITY_FAILED');
});
