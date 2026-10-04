const { test } = require('node:test');
const assert = require('node:assert/strict');
const { drainFence } = require('../portable/drain-fence.cjs');

const failure = (code, message, status) => { throw Object.assign(new Error(message), { code, status }); };

test('new sends, quotes that reserve, receives, primary edits and manual unpause are fenced', async () => {
	const fence = drainFence({ active: () => ({ phase: 'closing' }), failure });
	for (const [method, path] of [
		['POST', '/wallets/w/api/invoice/pay-safe'], ['POST', '/wallets/w/api/invoice/pay-all'],
		['POST', '/wallets/w/api/channel/splice-out'], ['POST', '/wallets/w/api/direct-funding/send'],
		['POST', '/wallets/w/api/receive/invoice'], ['POST', '/wallets/w/api/ffor/epoch/start'],
		['POST', '/wallets/w/api/channelize/pause'], ['POST', '/api/wallets/w/lfbw/channelize'],
		['PATCH', '/api/wallets/w'], ['GET', '/wallets/w/api/receive/quote?amountSats=1000']
	]) {
		await assert.rejects(fence.run({ method, path }, () => assert.fail('must be fenced')), { code: 'DRAIN_IN_PROGRESS', status: 409 });
	}
	assert.equal(fence.pending(), 0);
});

test('status, drain controls and lifecycle remain usable during a durable hold', async () => {
	const fence = drainFence({ active: () => true, failure });
	for (const [method, path] of [
		['GET', '/wallets/w/api/drain'], ['GET', '/wallets/w/api/transactions'],
		['GET', '/api/wallets/w/activity'], ['POST', '/wallets/w/api/drain/send'],
		['POST', '/wallets/w/api/drain/cancel'], ['POST', '/api/wallets/w/stop'], ['POST', '/api/wallets/w/start']
	]) assert.equal(await fence.run({ method, path }, () => 'ok'), 'ok');
	assert.equal(fence.pending(), 0);
});

test('an admitted mutation is counted before awaiting and released on either result', async () => {
	let held = false;
	const fence = drainFence({ active: () => held, failure });
	let finish;
	const pending = fence.run({ method: 'POST', path: '/wallets/w/api/invoice/pay-all' }, () => new Promise((resolve) => { finish = resolve; }));
	assert.equal(fence.pending(), 1);
	held = true;
	await assert.rejects(fence.run({ method: 'POST', path: '/wallets/w/api/address/new' }, () => {}), { code: 'DRAIN_IN_PROGRESS' });
	finish('settled');
	assert.equal(await pending, 'settled');
	assert.equal(fence.pending(), 0);
	held = false;
	await assert.rejects(fence.run({ method: 'PATCH', path: '/api/wallets/w' }, () => { throw new Error('write failed'); }), /write failed/);
	assert.equal(fence.pending(), 0);
});
