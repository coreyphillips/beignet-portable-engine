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
		primaryPubkey: primary,
		primaryConnected: true,
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
	assert.equal(code({ channels: [held], primaryConnected: false }), 'PRIMARY_DOWN');
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
