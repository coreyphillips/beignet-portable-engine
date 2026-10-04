const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendRoutes } = require('../portable/send-routes.cjs');

const failure = (code, message, status = 400) => {
	throw Object.assign(new Error(message), { code, status });
};
const routes = (node) => sendRoutes({ node, channelsWithFunding: (channels) => channels.map((c) => ({ ...c, fundingConfirmed: true })), failure });

test('the destination-aware quote forwards the address and preserves an engine refusal', () => {
	const calls = [];
	const refusal = Object.assign(new Error('Invalid regtest address'), { code: 'INVALID_PARAMS', statusCode: 400 });
	const api = routes({ spliceQuote: (...args) => { calls.push(args); throw refusal; } });
	assert.throws(() => api['POST /channel/splice-quote']({ channelId: 'home', direction: 'out', feeratePerkw: 2500, address: 'bc1p-destination' }), (error) => error === refusal);
	assert.deepEqual(calls, [['home', 'out', 2500, 'bc1p-destination']]);
});

test('omitting the quote destination retains the engine wallet destination', () => {
	const quote = { maxAmountSats: 9000, feeSats: 100, commitmentCostSats: 944 };
	const api = routes({ spliceQuote: (...args) => { assert.deepEqual(args, ['home', 'out', 253, undefined]); return quote; } });
	assert.equal(api['POST /channel/splice-quote']({ channelId: 'home', direction: 'out', feeratePerkw: 253 }), quote);
});

test('drain quotes price the external address and accept only the strict stale-state acknowledgement', async () => {
	const closeCalls = [];
	const api = routes({
		closeQuote: (...args) => { closeCalls.push(args); return { amountSats: 9000, feeSats: 100 }; },
		quoteOnchain: async (body) => { assert.deepEqual(body, { address: 'destination', amountSats: undefined, satsPerVbyte: 2, max: true, channelFunding: undefined }); return { maxSendSats: 800, feeSats: 200 }; }
	});
	for (const acceptStaleStateRisk of [undefined, 'true', 1, true])
		await api['POST /channel/close-quote']({ channelId: 'home', address: 'destination', acceptStaleStateRisk });
	assert.deepEqual(closeCalls, [false, false, false, true].map((ack) => ['home', 'destination', ack]));
	assert.deepEqual(await api['POST /tx/quote']({ address: 'destination', satsPerVbyte: 2, max: true }), { maxSendSats: 800, feeSats: 200 });
});

test('channel annotation and liquidity keep exact send ceilings and both waiver directions', () => {
	const channel = { channelId: 'home', maxSendableSats: 9734, localReserveWaived: true, remoteReserveWaived: false, localReserveSats: 0, remoteReserveSats: 1000, isOpener: false };
	const liquidity = { sendableSats: 10000, maxSendableSats: 9734 };
	const api = routes({ listChannels: () => [channel], getLiquiditySnapshot: () => liquidity });
	assert.deepEqual(api['GET /channels'](), [{ ...channel, fundingConfirmed: true }]);
	assert.equal(api['GET /liquidity'](), liquidity);
});

test('pay-all quote and send pass exact msat strings without converting them to numbers', async () => {
	const payAll = { debitMsat: '9007199254741001', maxFeeMsat: '2001', deliveredMsat: '9007199254739000', feeMsat: '2001', remainderMsat: '0' };
	const payment = { paymentHash: 'ab'.repeat(32), status: 'pending', payAll };
	const api = routes({
		quotePayAll: (invoice, cap) => { assert.equal(invoice, 'invoice'); assert.equal(cap, payAll.maxFeeMsat); return payAll; },
		payInvoiceAll: async (...args) => { assert.deepEqual(args, ['invoice', payAll.debitMsat, payAll.maxFeeMsat, 1234]); return payment; },
		listPayments: () => [payment],
		getPayment: (hash) => hash === payment.paymentHash ? payment : null
	});
	assert.equal(api['POST /invoice/pay-all/quote']({ bolt11: 'invoice', maxFeeMsat: payAll.maxFeeMsat }), payAll);
	assert.equal(await api['POST /invoice/pay-all']({ bolt11: 'invoice', debitMsat: payAll.debitMsat, maxFeeMsat: payAll.maxFeeMsat, timeoutMs: 1234 }), payment);
	assert.deepEqual(api['GET /payments'](), [payment]);
	assert.equal(api['GET /payment']({}, new URLSearchParams({ paymentHash: payment.paymentHash })), payment);
	assert.throws(() => api['GET /payment']({}, new URLSearchParams({ paymentHash: 'unknown' })), (error) => error.code === 'NOT_FOUND');
});

test('an unresolved or expired pay-all propagates the engine error without retrying', async () => {
	let attempts = 0;
	const refusal = Object.assign(new Error('Review budget is no longer available'), { code: 'PAY_ALL_REVIEW_EXPIRED' });
	const api = routes({ payInvoiceAll: async () => { attempts++; throw refusal; } });
	await assert.rejects(api['POST /invoice/pay-all']({ bolt11: 'invoice', debitMsat: '10000', maxFeeMsat: '1000' }), (error) => error === refusal);
	assert.equal(attempts, 1);
});

test('incomplete pay-all requests are refused before reaching the engine', () => {
	const api = routes({});
	for (const body of [{}, { bolt11: 'invoice' }, { bolt11: null, maxFeeMsat: '1' }])
		assert.throws(() => api['POST /invoice/pay-all/quote'](body), (error) => error.code === 'INVALID_PARAMS');
	for (const body of [{}, { bolt11: 'invoice', maxFeeMsat: '1' }, { bolt11: 'invoice', debitMsat: '1' }])
		assert.throws(() => api['POST /invoice/pay-all'](body), (error) => error.code === 'INVALID_PARAMS');
	assert.throws(() => api['GET /payment']({}, new URLSearchParams()), (error) => error.code === 'INVALID_PARAMS');
});

test('cooperative close forwards the destination with a strict acknowledgement and never force closes', async () => {
	const calls = [];
	const api = routes({ closeChannel: async (...args) => { calls.push(args); return { success: true }; } });
	for (const acceptStaleStateRisk of [undefined, 'true', true])
		assert.deepEqual(await api['POST /channel/close']({ channelId: 'home', address: 'destination', acceptStaleStateRisk, force: true }), { success: true });
	assert.deepEqual(calls, [[ 'home', false, 'destination' ], [ 'home', false, 'destination' ], [ 'home', true, 'destination' ]]);
	assert.throws(() => api['POST /channel/close']({ address: 'destination' }), error => error.code === 'INVALID_PARAMS');
});

test('sweep routes retain the reviewed coin set, fee cap and durable request identity', async () => {
	const approved = { requestId: 'drain-one', address: 'destination', satsPerVbyte: 2, inputOutpoints: ['ab:0', 'cd:1'], debitSats: 20000, maxFeeSats: 500 };
	const prepared = { ...approved, phase: 'prepared', txid: 'ef'.repeat(32) };
	const api = routes({
		prepareOnchainSweep: async args => { assert.deepEqual(args, approved); return prepared; },
		submitOnchainSweep: async id => { assert.equal(id, approved.requestId); return { ...prepared, phase: 'submitted' }; },
		cancelOnchainSweep: async id => { assert.equal(id, approved.requestId); return { cancelled: true }; },
		getOnchainSweep: id => id === approved.requestId ? prepared : undefined
	});
	assert.equal(await api['POST /tx/sweep/prepare']({ ...approved, max: true }), prepared);
	assert.equal((await api['POST /tx/sweep/submit']({ requestId: approved.requestId, address: 'changed' })).phase, 'submitted');
	assert.deepEqual(await api['POST /tx/sweep/cancel']({ requestId: approved.requestId }), { cancelled: true });
	assert.equal(api['GET /tx/sweep']({}, new URLSearchParams({ requestId: approved.requestId })), prepared);
	assert.throws(() => api['GET /tx/sweep']({}, new URLSearchParams({ requestId: 'missing' })), error => error.code === 'NOT_FOUND');
});
