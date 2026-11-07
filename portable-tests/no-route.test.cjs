const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const path = require('node:path');
const output = buildSync({
	entryPoints: [path.join(__dirname, '../portable/no-route.ts')],
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
const { explainNoRoute } = fixtureModule.exports;
const primary = '02' + '11'.repeat(32),
	payee = '03' + '22'.repeat(32);
const usable = { state: 'NORMAL', htlcUsable: true, localBalanceSats: 30000 };
function facts(overrides = {}) {
	return {
		amountSats: 24425,
		destination: payee,
		hasRoutingHints: false,
		primaries: [{ pubkey: primary, connected: true }],
		channels: [usable],
		sendableSats: 29000,
		graphChannelCount: (pubkey) => (pubkey === primary ? 1 : 40),
		...overrides
	};
}
const code = (overrides) => explainNoRoute(facts(overrides)).code;
const message = (overrides) => explainNoRoute(facts(overrides)).message;

test('no channel, or only a closing one, says there is nothing to send from', () => {
	assert.equal(code({ channels: [] }), 'NO_CHANNEL');
	assert.equal(code({ channels: [{ state: 'CLOSING', htlcUsable: false }] }), 'NO_CHANNEL');
});
test('a channel that takes no new payment names why', () => {
	const held = { state: 'NORMAL', htlcUsable: false };
	assert.equal(code({ channels: [held], primaries: [{ pubkey: primary, connected: false }] }), 'PRIMARY_DOWN');
	assert.match(
		message({ channels: [{ ...held, fundingUnaccounted: true }] }),
		/Electrum server has not seen its funding transaction/
	);
	assert.match(
		message({ channels: [{ ...held, restoreRecencyUnproven: true }] }),
		/on hold until its state is confirmed/
	);
	assert.match(
		message({ channels: [{ state: 'AWAITING_REESTABLISH', htlcUsable: false }] }),
		/cannot send yet \(awaiting reestablish\)/
	);
});
test('an amount the channel cannot cover with a fee says how much it can send', () => {
	assert.equal(code({ sendableSats: 24000 }), 'INSUFFICIENT_FUNDS');
	assert.equal(code({ sendableSats: 24425 }), 'INSUFFICIENT_FUNDS');
	assert.match(message({ sendableSats: 24000 }), /can send up to 24,000 sats/);
});
test('a map without the primary or the recipient says so', () => {
	assert.match(
		message({ graphChannelCount: (pubkey) => (pubkey === primary ? null : 40) }),
		/no public channels for your primary node/
	);
	assert.match(
		message({ graphChannelCount: (pubkey) => (pubkey === primary ? 0 : 40) }),
		/no public channels for your primary node/
	);
	assert.match(
		message({ graphChannelCount: (pubkey) => (pubkey === primary ? 1 : null) }),
		/recipient is not in this wallet's map/
	);
	// Route hints can reach a recipient the map lacks, so that is not the reason.
	assert.match(
		message({
			hasRoutingHints: true,
			graphChannelCount: (pubkey) => (pubkey === primary ? 1 : null)
		}),
		/with enough capacity for this amount/
	);
});
test('an unreadable invoice is not blamed on the channel', () => {
	assert.equal(code({ amountSats: null }), 'INVALID_INVOICE');
	assert.equal(code({ destination: null }), 'INVALID_INVOICE');
});
test('with several primaries one connected primary is enough, none connected is PRIMARY_DOWN in the plural, and the map must reach past a connected one', () => {
	const other = '02' + '33'.repeat(32);
	const held = { state: 'NORMAL', htlcUsable: false };
	const two = (a, b) => [{ pubkey: primary, connected: a }, { pubkey: other, connected: b }];
	assert.equal(code({ channels: [held], primaries: two(false, true) }), 'CHANNEL_NOT_READY');
	assert.equal(code({ channels: [held], primaries: two(false, false) }), 'PRIMARY_DOWN');
	assert.match(message({ channels: [held], primaries: two(false, false) }), /None of your primary nodes is connected/);
	assert.match(message({ channels: [held], primaries: [{ pubkey: primary, connected: false }] }), /Your primary node is not connected/);
	// The map lacks the connected primary but has the other: no way past.
	assert.match(
		message({ primaries: two(true, false), graphChannelCount: (pubkey) => (pubkey === primary ? null : 40) }),
		/no public channels for your primary nodes, so it cannot find a way past them/
	);
	// The map has the connected one: the recipient is the question.
	assert.match(
		message({ primaries: two(false, true), graphChannelCount: (pubkey) => (pubkey === other ? 1 : null), hasRoutingHints: true }),
		/through your primary nodes with enough capacity/
	);
	assert.equal(code({ primaries: [] }), 'NO_ROUTE');
	assert.equal(code({ channels: [held], primaries: [] }), 'CHANNEL_NOT_READY');
});

