const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../portable/lfbw.cjs');
const { runChannelize } = require('../portable/channelize.cjs');

const PRIMARY = 'ab'.repeat(33);
const primary = () => ({
	pubkey: PRIMARY,
	connectHost: '127.0.0.1',
	connectPort: 9735,
	relayHost: '127.0.0.1',
	relayPort: 9735
});
const record = { lfbw: { primaryPubkey: PRIMARY, trusted: true, setup: 'ready' } };

/** A node with one confirmed 60,000 sat coin and whatever channels the test says. */
function fakeNode({ channels = [], spliceIn, openChannelV2, connectAndOpenChannel } = {}) {
	const calls = [];
	return {
		calls,
		getBalance: () => ({ onchain: 60000, lightning: 0 }),
		listUtxos: () => [{ height: 100, valueSats: 60000 }],
		listChannels: () => channels,
		getFeeEstimates: async () => ({ normal: 2 }),
		getInfo: () => ({ blockHeight: 100 }),
		spliceQuote: (channelId, direction, feeratePerkw) => {
			calls.push(['spliceQuote', channelId, direction, feeratePerkw]);
			return { maxAmountSats: 58000, feeSats: 400 };
		},
		quoteOnchain: async (opts) => {
			calls.push(['quoteOnchain', opts]);
			return { maxSendSats: 58000, feeSats: 400 };
		},
		spliceIn: (...args) => {
			calls.push(['spliceIn', ...args]);
			return spliceIn ? spliceIn(...args) : { ok: true };
		},
		openChannelV2: (...args) => {
			calls.push(['openChannelV2', ...args]);
			if (openChannelV2) return openChannelV2(...args);
		},
		connectAndOpenChannel: async (...args) => {
			calls.push(['connectAndOpenChannel', ...args]);
			if (connectAndOpenChannel) return connectAndOpenChannel(...args);
		}
	};
}

const home = { channelId: 'home', peerPubkey: PRIMARY, state: 'NORMAL', htlcUsable: true };

test('a recovery hold prevents channelization even when a funding quote was already in flight', async () => {
	let allowed = true;
	const node = fakeNode();
	node.quoteOnchain = async () => {
		allowed = false;
		return { maxSendSats: 58000, feeSats: 400 };
	};
	const result = await runChannelize({ node, record, primary, rules, mayMutate: () => allowed });
	assert.equal(result.last, null);
	assert.equal(node.calls.some(call => ['spliceIn', 'openChannelV2', 'connectAndOpenChannel'].includes(call[0])), false);
	const held = await runChannelize({ node: {}, record, primary, rules, mayMutate: () => false });
	assert.equal(held.last, null);
});

test('a dual-funded open the primary refuses falls back to the plain open', async () => {
	const node = fakeNode({
		openChannelV2: () => {
			throw new Error('peer does not support option_dual_fund');
		}
	});
	const diagnostics = [];
	// The runtime itself no longer buys inbound; the fallback stays for a
	// caller that does, so it is driven through a rules module that does.
	const buying = {
		...rules,
		channelizeOrder: (target, opts) =>
			rules.channelizeOrder(target, { ...opts, buyInbound: true })
	};
	const { last, retryAt } = await runChannelize({
		node,
		record,
		primary,
		rules: buying,
		now: 1000,
		onDiagnostic: (e) => diagnostics.push(e)
	});
	assert.equal(last.action, 'open');
	assert.equal(last.fallbackFrom, 'open-v2');
	assert.match(last.reason, /option_dual_fund/);
	assert.equal(last.at, 1000);
	assert.equal(retryAt, 0);
	const open = node.calls.find((c) => c[0] === 'connectAndOpenChannel');
	assert.ok(open, 'the plain open ran');
	assert.equal(open[1], PRIMARY);
	assert.equal(open[2], '127.0.0.1');
	assert.equal(open[3], 9735);
	assert.ok(open[4] > 0);
	assert.equal(diagnostics[0].phase, 'channelize-open-v2');
	// No request body ever reaches the record the client reads.
	assert.equal('body' in last, false);
	assert.equal('fallback' in last, false);
});

test('the runtime opens plainly and never asks the primary to sell inbound', async () => {
	const node = fakeNode({
		openChannelV2: () => {
			throw new Error('must not be called');
		}
	});
	const { last } = await runChannelize({ node, record, primary, rules, now: 5 });
	assert.equal(last.action, 'open');
	assert.equal('fallbackFrom' in last, false);
	assert.ok(last.amountSats > 0);
	assert.equal(node.calls.some((c) => c[0] === 'openChannelV2'), false);
	const open = node.calls.find((c) => c[0] === 'connectAndOpenChannel');
	assert.ok(open);
	// Confirm-first: the phone does not ask the primary for a zero-conf
	// channel it has no standing to be trusted for.
	assert.equal(open[5].trusted, false);
});

test('the rules still prepare a dual-funded open with a plain fallback when inbound is for sale', () => {
	const order = rules.channelizeOrder(
		{ action: 'open' },
		{
			txQuote: { maxSendSats: 58000, feeSats: 400 },
			feeNormal: 2,
			mode: 'external',
			trusted: false,
			blockHeight: 100,
			primary: primary()
		}
	);
	assert.equal(order.action, 'open-v2');
	assert.equal(order.fallback.action, 'open');
	const plain = rules.channelizeOrder(
		{ action: 'open' },
		{
			txQuote: { maxSendSats: 58000, feeSats: 400 },
			feeNormal: 2,
			mode: 'external',
			trusted: false,
			blockHeight: 100,
			primary: primary(),
			buyInbound: false
		}
	);
	assert.equal(plain.action, 'open');
	assert.equal('fallback' in plain, false);
});

test('a refused splice-in records the failure with its code and backs off', async () => {
	const node = fakeNode({
		channels: [home],
		spliceIn: () => ({ ok: false, code: 'SPLICING_NOT_NEGOTIATED', error: 'peer lacks option_splice' })
	});
	const first = await runChannelize({ node, record, primary, rules, now: 1000 });
	assert.equal(first.last.action, 'failed');
	assert.equal(first.last.code, 'SPLICING_NOT_NEGOTIATED');
	assert.match(first.last.error, /option_splice/);
	assert.equal(first.retryAt, 1000 + rules.CHANNELIZE_RETRY_MS);
	assert.equal(first.last.retryAt, first.retryAt);
	// Inside the backoff nothing runs and nothing is recorded.
	const before = node.calls.length;
	const second = await runChannelize({
		node,
		record,
		primary,
		rules,
		now: 2000,
		retryAt: first.retryAt
	});
	assert.equal(second.last, null);
	assert.equal(second.retryAt, first.retryAt);
	assert.equal(node.calls.length, before);
	// The owner asking again is not bound by the backoff.
	const forced = await runChannelize({
		node,
		record,
		primary,
		rules,
		now: 2000,
		retryAt: first.retryAt,
		force: true
	});
	assert.equal(forced.last.action, 'failed');
	assert.ok(node.calls.length > before);
	// Once the backoff has passed, the next pass runs.
	const later = await runChannelize({
		node,
		record,
		primary,
		rules,
		now: first.retryAt,
		retryAt: first.retryAt
	});
	assert.equal(later.last.action, 'failed');
});

test('a splice-in that is accepted is recorded with its amount and clears nothing else', async () => {
	const node = fakeNode({ channels: [home] });
	const { last, retryAt } = await runChannelize({ node, record, primary, rules, now: 7, retryAt: 0 });
	assert.equal(last.action, 'splice-in');
	assert.equal(last.amountSats, 58000);
	assert.equal(retryAt, 0);
});

test('a wait is recorded with its reason and sets no backoff', async () => {
	const node = fakeNode({ channels: [{ ...home, state: 'SPLICING', htlcUsable: true }] });
	const { last, retryAt } = await runChannelize({ node, record, primary, rules, now: 9 });
	assert.equal(last.action, 'wait');
	assert.equal(last.reason, 'splicing');
	assert.equal(retryAt, 0);
	assert.equal(node.calls.length, 0, 'no quote is fetched for a wait');
});

test('a fee wait carries the figures the client needs to explain it', async () => {
	const node = fakeNode({ channels: [home] });
	node.spliceQuote = () => ({ maxAmountSats: 58000, feeSats: 5000 });
	const { last } = await runChannelize({ node, record, primary, rules, now: 9 });
	assert.equal(last.action, 'wait');
	assert.equal(last.reason, 'fee-too-high');
	assert.equal(last.feeSats, 5000);
	assert.equal(last.amountSats, 58000);
});
