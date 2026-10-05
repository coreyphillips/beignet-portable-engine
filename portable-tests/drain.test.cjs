const { test } = require('node:test');
const assert = require('node:assert/strict');
const { drainCoordinator } = require('../portable/drain.cjs');
const { channelizePause } = require('../portable/channelize-pause.cjs');
const { drainFence } = require('../portable/drain-fence.cjs');

const copy = (value) =>
	value == null ? value : JSON.parse(JSON.stringify(value));
const failure = (code, message, status = 400) => {
	throw Object.assign(new Error(message), { code, status });
};
const coin = { txid: 'ab'.repeat(32), vout: 1, valueSats: 2000, frozen: false };
const request = { requestId: 'review-drain-001', address: 'external-address' };

function harness({ home = true, coins = true } = {}) {
	let journal = null,
		hold = null,
		time = 1000;
	let disabled = false,
		pending = false,
		unavailable = false;
	let failWrite = () => false;
	let generation = 0;
	const calls = [];
	const channel = {
		channelId: 'home',
		peerPubkey: 'primary',
		fundingTxid: 'cd'.repeat(32),
		fundingOutputIndex: 0,
		localBalanceSats: 10000,
		state: 'NORMAL',
		htlcUsable: true,
		htlcCount: 0
	};
	const state = {
		channels: home ? [channel] : [],
		coins: coins ? [copy(coin)] : [],
		peers: [{ pubkey: 'primary', state: 'connected' }],
		payments: [],
		offline: { reservedChannelIds: [], requests: [] },
		transactions: [],
		closeSeen: false,
		closeHeight: 0,
		sweep: null,
		sweepConfirmed: false,
		closeFailure: false,
		sweepFailure: false,
		preparedFailure: false
	};
	const pause = channelizePause({
		read: () => hold,
		write: (next) => {
			hold = copy(next);
			calls.push(next ? 'pause' : 'unpause');
		},
		busy: () => false,
		failure
	});
	const engine = {
		listPeers: () => state.peers,
		listChannels: () => state.channels,
		listPayments: () => state.payments,
		listUtxos: () => state.coins,
		listOnchainTransactions: () => state.transactions,
		getFeeEstimates: async () => ({ normal: 2 }),
		closeQuote: async () => ({ amountSats: 9500, feeSats: 500 }),
		quoteOnchain: async () => ({
			maxSendSats:
				state.coins.reduce((sum, entry) => sum + entry.valueSats, 0) - 300,
			feeSats: 300
		}),
		getOnchainSweep: () => state.sweep,
		prepareOnchainSweep: async (input) => {
			calls.push('prepare');
			assert.equal(hold.requestId, request.requestId);
			assert.equal(disabled, true);
			assert.equal(input.debitSats, 2000);
			assert.deepEqual(input.inputOutpoints, [
				{ txid: coin.txid, vout: coin.vout }
			]);
			state.coins[0].frozen = true;
			state.sweep ??= {
				requestId: input.requestId,
				status: 'prepared',
				amountSats: 1700,
				feeSats: 300,
				txid: 'sweep-tx'
			};
			if (state.preparedFailure) throw new Error('lost prepare response');
			return copy(state.sweep);
		},
		closeChannel: async (id, ack, address) => {
			calls.push('close');
			assert.deepEqual([id, ack, address], ['home', false, request.address]);
			assert.equal(
				journal.records.find((row) => row.requestId === request.requestId)
					.phase,
				'closing'
			);
			assert.equal(disabled, true);
			channel.state = 'CLOSED';
			state.transactions = [
				{
					source: 'cooperative-close',
					channelId: 'home',
					address,
					txid: 'close-tx',
					valueSats: 9600,
					feeSats: 400
				}
			];
			if (state.closeFailure) throw new Error('lost close response');
			return { ok: true };
		},
		submitOnchainSweep: async (id) => {
			calls.push('submit');
			assert.equal(id, request.requestId);
			assert.ok(!home || state.closeSeen);
			state.sweep.status = state.sweepConfirmed ? 'confirmed' : 'submitted';
			state.sweep.error = state.sweepFailure
				? 'broadcast reply lost'
				: undefined;
			state.coins = state.coins.filter((entry) => entry.txid !== coin.txid);
			return copy(state.sweep);
		},
		cancelOnchainSweep: async () => {
			calls.push('cancel');
			state.sweep.status = 'cancelled';
			state.coins[0].frozen = false;
		}
	};
	const create = () =>
		drainCoordinator({
			read: () => copy(journal),
			write: (next) => {
				if (failWrite(next)) throw new Error('storage unavailable');
				journal = copy(next);
			},
			node: () => engine,
			primary: () => 'primary',
			ready: () => {
				if (unavailable) failure('RECOVERY_HELD', 'Recovery is pending', 409);
			},
			busy: () => pending,
			activityPending: () => false,
			offline: () => state.offline,
			pause,
			disableReceive: async () => {
				disabled = true;
				calls.push('disable');
			},
			restoreReceive: async () => {
				if (state.restoreFailure)
					throw new Error('restore receive interrupted');
				disabled = false;
				calls.push('restore');
			},
			observe: async () => {
				if (state.observationFailure)
					throw new Error('observation unavailable');
				return { exists: state.closeSeen, height: state.closeHeight };
			},
			closeNotStarted: () => channel.state === 'NORMAL',
			failure,
			now: () => time,
			lifecycle: () => generation
		});
	return {
		create,
		state,
		calls,
		engine,
		stop: () => {
			generation++;
		},
		paused: () => !!hold,
		disabled: () => disabled,
		journal: () => journal,
		failWrites: (test) => {
			failWrite = test;
		},
		setBusy: (value) => {
			pending = value;
		},
		recovery: () => {
			unavailable = true;
		},
		advance: (ms) => {
			time += ms;
		}
	};
}

test('review holds nothing and returns only display amounts and an opaque identity', async () => {
	const h = harness(),
		drain = h.create();
	const review = await drain.quote(request);
	assert.equal(review.amountSats, 11200);
	assert.equal(review.feeSats, 800);
	assert.equal(review.debitSats, 12000);
	assert.equal(review.phase, 'review');
	assert.equal(h.paused(), false);
	assert.deepEqual(h.calls, []);
	assert.equal(JSON.stringify(review).includes(coin.txid), false);
	assert.equal(drain.active(), null);
	assert.deepEqual(await drain.quote(request), review);
	await assert.rejects(drain.quote({ ...request, address: 'other' }), {
		code: 'REQUEST_ID_CONFLICT'
	});
});

test('an observed close and submitted frozen sweep release the hold before confirmations', async () => {
	const h = harness(),
		drain = h.create();
	await drain.quote(request);
	const started = await drain.send(request.requestId);
	assert.equal(started.phase, 'closing');
	assert.deepEqual(h.calls, ['pause', 'disable', 'prepare', 'close']);
	assert.equal(h.paused(), true);
	await assert.rejects(drain.cancel(request.requestId), {
		code: 'DRAIN_ALREADY_COMMITTED'
	});
	h.state.closeSeen = true;
	h.state.coins.push({ ...coin, txid: 'ef'.repeat(32), valueSats: 700 });
	const pending = await h.create().sync();
	assert.equal(pending.phase, 'pending');
	assert.equal(pending.amountSats, 11300);
	assert.equal(pending.feeSats, 700);
	assert.deepEqual(pending.txids, ['close-tx', 'sweep-tx']);
	assert.equal(h.paused(), false);
	assert.equal(h.disabled(), false);
	assert.equal(h.create().blocksWallet(), false);
	h.state.closeHeight = 50;
	h.state.sweepConfirmed = true;
	const completed = await h.create().sync();
	assert.equal(completed.phase, 'completed');
	assert.equal(completed.residualSats, 700);
	assert.equal(h.paused(), false);
	assert.equal(h.disabled(), false);
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
});

test('a lost close response retains the hold and restart never repeats the close', async () => {
	const h = harness();
	await h.create().quote(request);
	h.state.closeFailure = true;
	await assert.rejects(
		h.create().send(request.requestId),
		/lost close response/
	);
	assert.equal(h.paused(), true);
	h.state.closeSeen = true;
	await h.create().sync();
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
	assert.equal(h.calls.filter((call) => call === 'submit').length, 1);
});

test('prepared sweep survives a lost response and can either resume or be cancelled before close', async () => {
	for (const cancel of [false, true]) {
		const h = harness();
		await h.create().quote(request);
		h.state.preparedFailure = true;
		await assert.rejects(
			h.create().send(request.requestId),
			/lost prepare response/
		);
		assert.equal(h.create().active().phase, 'preparing');
		h.state.preparedFailure = false;
		if (cancel) {
			assert.equal(
				(await h.create().cancel(request.requestId)).phase,
				'cancelled'
			);
			assert.equal(h.paused(), false);
			assert.equal(h.state.coins[0].frozen, false);
			assert.equal(h.calls.includes('close'), false);
		} else {
			assert.equal((await h.create().sync()).phase, 'closing');
			assert.equal(h.calls.filter((call) => call === 'close').length, 1);
		}
	}
});

test('later coins are excluded from the reviewed sweep', async () => {
	const h = harness({ home: false });
	await h.create().quote(request);
	h.state.coins.push({ ...coin, txid: 'ef'.repeat(32), valueSats: 600 });
	await h.create().send(request.requestId);
	assert.equal(h.state.coins.length, 1);
	assert.equal(h.state.coins[0].valueSats, 600);
	assert.equal(h.calls.includes('close'), false);
});

test('an accepted sweep with an ambiguous reply stays pending and uses the same request after restart', async () => {
	const h = harness({ home: false });
	await h.create().quote(request);
	h.state.sweepFailure = true;
	assert.equal((await h.create().send(request.requestId)).phase, 'pending');
	assert.equal(h.create().get(request.requestId).error, 'broadcast reply lost');
	h.state.sweepFailure = false;
	h.state.sweepConfirmed = true;
	assert.equal((await h.create().sync()).phase, 'completed');
	assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);
});

test('expired or changed reviews refuse before acquiring a hold or signing', async () => {
	for (const change of [
		(h) => h.advance(120001),
		(h) => {
			h.state.channels[0].localBalanceSats++;
		},
		(h) => {
			h.state.coins = [];
		}
	]) {
		const h = harness();
		await h.create().quote(request);
		change(h);
		await assert.rejects(h.create().send(request.requestId), {
			code: 'DRAIN_REVIEW_EXPIRED'
		});
		assert.deepEqual(h.calls, []);
	}
});

test('busy, offline, foreign-channel, splice, recovery and offline-reservation states refuse before review', async () => {
	for (const change of [
		(h) => h.setBusy(true),
		(h) => {
			h.state.peers = [];
		},
		(h) => {
			h.state.channels[0].peerPubkey = 'other';
		},
		(h) => {
			h.state.channels[0].pendingSpliceTxid = 'pending';
		},
		(h) => h.recovery(),
		(h) => {
			h.state.offline.reservedChannelIds = ['home'];
		},
		(h) => {
			h.state.payments = [{ status: 'pending' }];
		},
		(h) => {
			h.state.channels[0].htlcCount = 1;
		},
		(h) => {
			h.state.coins[0].frozen = true;
		}
	]) {
		const h = harness();
		change(h);
		await assert.rejects(h.create().quote(request));
		assert.deepEqual(h.calls, []);
		assert.equal(h.journal(), null);
	}
});

test('unpaid receive invoices do not block a drain, including after restart', async () => {
	const h = harness();
	h.state.payments = [
		{ direction: 'INCOMING', status: 'PENDING' },
		{ direction: 'incoming', status: 'pending' }
	];
	await h.create().quote(request);
	assert.equal((await h.create().send(request.requestId)).phase, 'closing');
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
});

test('live or unidentified payments block review and dispatch before any drain mutation', async () => {
	for (const payment of [
		{ direction: 'OUTGOING', status: 'PENDING' },
		{ direction: 'outgoing', status: 'pending' },
		{ direction: 'incoming', status: 'in_flight' },
		{ direction: 'incoming', status: 'INFLIGHT' },
		{ status: 'pending' },
		{ direction: 'unknown', status: 'pending' }
	]) {
		for (const afterReview of [false, true]) {
			const h = harness();
			if (afterReview) await h.create().quote(request);
			h.state.payments = [payment];
			await assert.rejects(
				afterReview
					? h.create().send(request.requestId)
					: h.create().quote(request),
				{
					code: 'DRAIN_BUSY',
					message: 'Wait for the pending payment to finish'
				}
			);
			assert.deepEqual(h.calls, []);
		}
	}
});

test('incoming HTLCs and commitment updates still block a drain with pending receive invoices', async () => {
	for (const afterReview of [false, true]) {
		for (const blocker of afterReview ? ['htlc'] : ['htlc', 'commitment']) {
			const h = harness();
			h.state.payments = [{ direction: 'INCOMING', status: 'PENDING' }];
			if (afterReview) await h.create().quote(request);
			if (blocker === 'htlc') h.state.channels[0].htlcCount = 1;
			else
				h.engine.closeQuote = async () => {
					throw new Error('Cannot close cooperatively: pending updates');
				};
			await assert.rejects(
				afterReview
					? h.create().send(request.requestId)
					: h.create().quote(request),
				blocker === 'htlc'
					? {
							code: 'DRAIN_BUSY',
							message: 'The home channel is not ready for a cooperative close'
					  }
					: /Cannot close cooperatively: pending updates/
			);
			assert.deepEqual(h.calls, []);
		}
	}
});

test('a failed intent write cannot sign or close and a second request cannot take an active hold', async () => {
	const h = harness(),
		drain = h.create();
	await drain.quote(request);
	h.failWrites((journal) => journal.records[0].phase === 'preparing');
	await assert.rejects(drain.send(request.requestId), /storage unavailable/);
	assert.deepEqual(h.calls, []);
	h.failWrites(() => false);
	await drain.send(request.requestId);
	await assert.rejects(
		drain.quote({ ...request, requestId: 'another-review-id' }),
		{ code: 'DRAIN_IN_PROGRESS' }
	);
});

test('a channel-only drain finishes without preparing or submitting a sweep', async () => {
	const h = harness({ coins: false });
	await h.create().quote(request);
	h.state.closeSeen = true;
	h.state.closeHeight = 60;
	assert.equal((await h.create().send(request.requestId)).phase, 'completed');
	assert.equal(h.calls.includes('prepare'), false);
	assert.equal(h.calls.includes('submit'), false);
	assert.equal(h.paused(), false);
});

test('restart completes cancellation after a lost reply without dispatching close', async () => {
	const h = harness();
	await h.create().quote(request);
	h.state.preparedFailure = true;
	await assert.rejects(
		h.create().send(request.requestId),
		/lost prepare response/
	);
	const cancel = h.engine.cancelOnchainSweep;
	h.engine.cancelOnchainSweep = async (...args) => {
		await cancel(...args);
		throw new Error('lost cancellation reply');
	};
	await assert.rejects(
		h.create().cancel(request.requestId),
		/lost cancellation reply/
	);
	assert.equal(h.create().active().phase, 'cancelling');
	h.engine.cancelOnchainSweep = cancel;
	assert.equal((await h.create().sync()).phase, 'cancelled');
	assert.equal(h.paused(), false);
	assert.equal(h.disabled(), false);
	assert.equal(h.calls.includes('close'), false);
});

test('a definitive close refusal remains cancellable and an ambiguous one does not', async () => {
	for (const dispatched of [false, true]) {
		const h = harness();
		await h.create().quote(request);
		h.engine.closeChannel = async () => {
			if (dispatched) h.state.channels[0].state = 'AWAITING_REESTABLISH';
			return { ok: false, error: 'close refused' };
		};
		await assert.rejects(h.create().send(request.requestId), /close refused/);
		if (dispatched) {
			await assert.rejects(h.create().cancel(request.requestId), {
				code: 'DRAIN_ALREADY_COMMITTED'
			});
			assert.equal(h.paused(), true);
		} else {
			assert.equal(
				(await h.create().cancel(request.requestId)).phase,
				'cancelled'
			);
			assert.equal(h.paused(), false);
		}
	}
});

test('new HTLCs during sweep preparation refuse before close and leave cancellation available', async () => {
	const h = harness();
	await h.create().quote(request);
	const prepare = h.engine.prepareOnchainSweep;
	h.engine.prepareOnchainSweep = async (input) => {
		const result = await prepare(input);
		h.state.channels[0].htlcCount = 1;
		return result;
	};
	await assert.rejects(h.create().send(request.requestId), {
		code: 'DRAIN_BUSY'
	});
	assert.equal(h.calls.includes('close'), false);
	assert.equal((await h.create().cancel(request.requestId)).phase, 'cancelled');
});

test('a payment crossing shutdown updates actual debit without changing the reviewed debit', async () => {
	const h = harness();
	await h.create().quote(request);
	await h.create().send(request.requestId);
	h.state.transactions[0].valueSats += 1000;
	h.state.closeSeen = true;
	h.state.closeHeight = 40;
	h.state.sweepConfirmed = true;
	const result = await h.create().sync();
	assert.equal(result.amountSats, 12300);
	assert.equal(result.feeSats, 700);
	assert.equal(result.debitSats, 13000);
	assert.equal(result.reviewedDebitSats, 12000);
});

test('an aborted offline epoch with no remaining slots permits a drain', async () => {
	const h = harness();
	h.state.channels[0].ffor = { state: 'ABORTED', unresolvedSlots: 0 };
	assert.equal((await h.create().quote(request)).phase, 'review');
	h.state.channels[0].ffor.unresolvedSlots = 1;
	await assert.rejects(h.create().send(request.requestId), {
		code: 'DRAIN_BUSY'
	});
});

test('journal capacity refuses a new review without corrupting existing history', async () => {
	const h = harness();
	await h.create().quote(request);
	const original = copy(h.journal().records[0]);
	h.journal().records = Array.from({ length: 1000 }, (_, i) => ({
		...original,
		requestId: `review-${i}-retained`
	}));
	await assert.rejects(h.create().quote(request), {
		code: 'DRAIN_HISTORY_FULL'
	});
	assert.equal(h.create().list().length, 1000);
	assert.equal(h.paused(), false);
});

test('a shallow close reorg reopens pending state and keeps the same sweep and close identities', async () => {
	const h = harness();
	await h.create().quote(request);
	h.state.closeSeen = true;
	h.state.closeHeight = 50;
	h.state.sweepConfirmed = true;
	assert.equal((await h.create().send(request.requestId)).phase, 'completed');
	h.state.closeSeen = false;
	const reorg = await h.create().sync();
	assert.equal(reorg.phase, 'pending');
	assert.equal(h.paused(), false);
	assert.equal(h.create().blocksWallet(), false);
	assert.equal(h.journal().records[0].close.confirmed, false);
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
	assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);
	h.state.closeSeen = true;
	assert.equal((await h.create().sync()).phase, 'completed');
	assert.equal(h.paused(), false);
	assert.deepEqual(h.create().get(request.requestId).txids, [
		'close-tx',
		'sweep-tx'
	]);
});

test('a shallow sweep reorg resumes only the original signed sweep after restart', async () => {
	const h = harness({ home: false });
	await h.create().quote(request);
	h.state.sweepConfirmed = true;
	assert.equal((await h.create().send(request.requestId)).phase, 'completed');
	h.state.sweepConfirmed = false;
	h.state.coins.push({ ...coin, txid: 'ef'.repeat(32), valueSats: 900 });
	assert.equal((await h.create().sync()).phase, 'pending');
	assert.equal(h.paused(), false);
	assert.equal(h.create().blocksWallet(), false);
	assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);
	assert.equal(h.state.coins[0].valueSats, 900);
	h.state.sweepConfirmed = true;
	assert.equal((await h.create().sync()).phase, 'completed');
	assert.equal(h.paused(), false);
});

test('stopping during asynchronous sweep preparation prevents later close and journal writes', async () => {
	const h = harness();
	await h.create().quote(request);
	let release;
	const prepare = h.engine.prepareOnchainSweep;
	h.engine.prepareOnchainSweep = async (input) => {
		const prepared = await prepare(input);
		await new Promise((resolve) => {
			release = resolve;
		});
		return prepared;
	};
	const pending = h.create().send(request.requestId);
	await new Promise((resolve) => setImmediate(resolve));
	const saved = JSON.stringify(h.journal());
	h.stop();
	release();
	await assert.rejects(pending, { code: 'WALLET_CLOSED' });
	assert.equal(JSON.stringify(h.journal()), saved);
	assert.equal(h.calls.includes('close'), false);
});

test('retry keeps the reviewed sweep fee cap when the prepared fee is lower', async () => {
	const h = harness();
	await h.create().quote(request);
	const prepare = h.engine.prepareOnchainSweep;
	h.engine.prepareOnchainSweep = async (input) => {
		assert.equal(input.maxFeeSats, 300);
		const prepared = await prepare(input);
		return { ...prepared, feeSats: 299, amountSats: 1701 };
	};
	const close = h.engine.closeChannel;
	h.engine.closeChannel = async () => ({
		ok: false,
		error: 'refused before shutdown'
	});
	await assert.rejects(
		h.create().send(request.requestId),
		/refused before shutdown/
	);
	h.engine.closeChannel = close;
	assert.equal((await h.create().sync()).phase, 'closing');
});

test('cancelling the current owner preserves the hold for an older pending drain', async () => {
	const h = harness();
	await h.create().quote(request);
	h.state.preparedFailure = true;
	await assert.rejects(
		h.create().send(request.requestId),
		/lost prepare response/
	);
	const older = copy(h.journal().records[0]);
	older.requestId = 'older-drain-001';
	older.phase = 'pending';
	h.journal().records.unshift(older);
	assert.equal((await h.create().cancel(request.requestId)).phase, 'cancelled');
	assert.equal(h.paused(), true);
	assert.equal(h.create().active().requestId, older.requestId);
	assert.equal(h.calls.includes('close'), false);
});

test('confirmed payouts clear stale broadcast warnings across restart and reorg', async () => {
	const h = harness();
	await h.create().quote(request);
	h.state.closeSeen = true;
	h.state.sweepFailure = true;
	assert.equal((await h.create().send(request.requestId)).phase, 'pending');
	assert.equal(h.create().get(request.requestId).error, 'broadcast reply lost');
	h.state.sweepConfirmed = true;
	// A confirmed sweep alone does not resolve an unconfirmed closing output.
	assert.equal((await h.create().sync()).phase, 'pending');
	assert.equal(h.create().get(request.requestId).error, 'broadcast reply lost');
	h.state.closeHeight = 50;
	const completed = await h.create().sync();
	assert.equal(completed.phase, 'completed');
	assert.equal(completed.error, undefined);
	assert.equal(h.create().get(request.requestId).error, undefined);
	assert.equal(h.journal().records[0].error, undefined);
	assert.equal(await h.create().sync(), null);
	assert.equal(h.create().get(request.requestId).error, undefined);
	assert.deepEqual(completed.txids, ['close-tx', 'sweep-tx']);
	h.state.sweepConfirmed = false;
	const pending = await h.create().sync();
	assert.equal(pending.phase, 'pending');
	assert.equal(pending.error, 'broadcast reply lost');
	assert.equal(h.paused(), false);
	assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
});

test('a confirmed close clears its earlier transport warning without a sweep', async () => {
	const h = harness({ coins: false });
	await h.create().quote(request);
	h.state.closeFailure = true;
	await assert.rejects(
		h.create().send(request.requestId),
		/lost close response/
	);
	assert.equal(h.create().get(request.requestId).error, 'lost close response');
	h.state.closeSeen = true;
	h.state.closeHeight = 50;
	const completed = await h.create().sync();
	assert.equal(completed.phase, 'completed');
	assert.equal(completed.error, undefined);
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
});

test('receive requests resume after submission and restart while the drain stays pending', async () => {
	for (const options of [{}, { home: false }, { coins: false }]) {
		const h = harness(options);
		const fence = drainFence({
			active: () => h.create().blocksWallet(),
			failure
		});
		const receive = () =>
			fence.run(
				{ method: 'POST', path: '/wallets/w/api/jit/invoice' },
				() => 'new invoice'
			);
		await h.create().quote(request);
		if (options.home !== false) {
			await h.create().send(request.requestId);
			await assert.rejects(receive(), { code: 'DRAIN_IN_PROGRESS' });
		}
		h.state.closeSeen = true;
		const submitted =
			options.home === false
				? await h.create().send(request.requestId)
				: await h.create().sync();
		assert.equal(submitted.phase, 'pending');
		assert.equal(h.journal().records[0].fundsCommitted, true);
		assert.equal(h.create().blocksWallet(), false);
		assert.equal(await receive(), 'new invoice');
		assert.equal(h.paused(), false);
		assert.equal((await h.create().sync()).phase, 'pending');
		assert.equal(await receive(), 'new invoice');
		await assert.rejects(
			h.create().quote({ ...request, requestId: 'second-drain-001' }),
			{ code: 'DRAIN_IN_PROGRESS' }
		);
	}
});

test('an unsubmitted or mismatched sweep never releases the wallet hold', async () => {
	for (const change of [
		(sweep) => ({ ...sweep, status: 'prepared' }),
		(sweep) => ({ ...sweep, requestId: 'another-drain-001' }),
		(sweep) => ({ ...sweep, txid: 'different-transaction' })
	]) {
		const h = harness();
		await h.create().quote(request);
		h.state.closeSeen = true;
		const submit = h.engine.submitOnchainSweep;
		h.engine.submitOnchainSweep = async (id) => change(await submit(id));
		await h
			.create()
			.send(request.requestId)
			.catch((error) => {
				assert.equal(error.code, 'DRAIN_SWEEP_MISMATCH');
			});
		assert.equal(h.create().blocksWallet(), true);
		assert.equal(h.paused(), true);
		assert.notEqual(h.journal().records[0].fundsCommitted, true);
	}
});

test('submission must be durably recorded before receiving is unlocked', async () => {
	const h = harness();
	await h.create().quote(request);
	h.state.closeSeen = true;
	h.failWrites((journal) => journal.records[0].fundsCommitted === true);
	await assert.rejects(
		h.create().send(request.requestId),
		/storage unavailable/
	);
	assert.equal(h.create().blocksWallet(), true);
	assert.equal(h.paused(), true);
	h.failWrites(() => false);
	assert.equal((await h.create().sync()).phase, 'pending');
	assert.equal(h.create().blocksWallet(), false);
	assert.equal(h.paused(), false);
	assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
});

test('a pending drain saved by the previous version releases after verifying its existing payouts', async () => {
	const h = harness();
	await h.create().quote(request);
	h.state.closeSeen = true;
	await h.create().send(request.requestId);
	delete h.journal().records[0].fundsCommitted;
	assert.equal(h.create().blocksWallet(), true);
	assert.equal((await h.create().sync()).phase, 'pending');
	assert.equal(h.create().blocksWallet(), false);
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
	assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);
});

test('invalid saved submission markers fail closed before receive admission', async () => {
	for (const marker of ['true', 1, null, true]) {
		const h = harness();
		await h.create().quote(request);
		h.journal().records[0].fundsCommitted = marker;
		assert.throws(() => h.create().blocksWallet(), {
			code: 'DRAIN_JOURNAL_INVALID'
		});
	}
});

test('restart releases a committed owner before a failing network observation', async () => {
	const h = harness();
	await h.create().quote(request);
	h.state.closeSeen = true;
	h.state.restoreFailure = true;
	await assert.rejects(
		h.create().send(request.requestId),
		/restore receive interrupted/
	);
	assert.equal(h.journal().records[0].fundsCommitted, true);
	assert.equal(h.paused(), true);
	h.state.restoreFailure = false;
	h.state.observationFailure = true;
	await assert.rejects(h.create().sync(), /observation unavailable/);
	assert.equal(h.paused(), false);
	assert.equal(h.create().blocksWallet(), false);
});

test('an older committed drain cannot starve a newer submitting drain without a saved pause', async () => {
	const h = harness();
	await h.create().quote(request);
	const current = h.journal().records[0];
	current.phase = 'preparing';
	const older = {
		...copy(current),
		requestId: 'older-drain-001',
		phase: 'pending',
		fundsCommitted: true,
		channelId: 'older-home',
		coins: [],
		close: { txid: 'older-close', amountSats: 9500, feeSats: 500 },
		sweep: null
	};
	h.journal().records.unshift(older);
	assert.equal(h.paused(), false);
	assert.equal(h.create().active().requestId, request.requestId);
	const revision = older.revision;
	assert.equal((await h.create().sync()).phase, 'closing');
	assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);
	assert.equal(h.calls.filter((call) => call === 'close').length, 1);
	assert.equal(h.paused(), true);
	assert.ok(
		h.journal().records[0].revision > revision,
		'older payout is still tracked'
	);
});
