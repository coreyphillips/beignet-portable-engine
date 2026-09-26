const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
	STALLED_SUBMISSION_MS,
	noteBroadcastError,
	watchBroadcastErrors,
	reconcileSpliceRow
} = require('../portable/splice-status.cjs');

const OLD = '11'.repeat(32);
const SPLICE = '22'.repeat(32);
const OTHER = '33'.repeat(32);
const HOME = 'ab'.repeat(32);
const ELSEWHERE = 'cd'.repeat(32);
const SUBMITTED = 'Payment submitted. Confirmation has not yet been verified.';
const T0 = 1700000000000;

/** A splice-out row as POST /channel/splice-out journals it. */
const spliceRow = (over = {}) => ({
	id: 'submission:one',
	requestId: 'one',
	kind: 'sent',
	status: 'pending',
	amountSats: 2000,
	address: 'bcrt1qexample',
	channelId: HOME,
	previousFundingTxid: OLD,
	previousFundingOutputIndex: 0,
	createdAt: T0,
	statusNote: SUBMITTED,
	...over
});
/** A zero-conf home channel that has adopted the splice as its funding. */
const adopted = () => ({
	channelId: HOME,
	state: 'NORMAL',
	fundingTxid: SPLICE,
	fundingOutputIndex: 0
});
const fakeNode = (channels) => {
	const node = new EventEmitter();
	node.listChannels = () => channels;
	return node;
};
const retainedFailure = (over = {}) => ({
	code: 'BROADCAST_PERMANENT_FAILURE',
	channelId: HOME,
	txid: SPLICE,
	retained: true,
	message: `Broadcast permanently failed after 6 retries: ${SPLICE}; the node still holds this transaction and rebroadcasts it on every block until it confirms`,
	timestamp: T0 + 500000,
	...over
});

test('a retained broadcast error puts the reason on the matching row, keeps it pending and leaves other rows alone', () => {
	const row = spliceRow();
	const unrelated = spliceRow({
		id: 'submission:two',
		requestId: 'two',
		channelId: ELSEWHERE,
		previousFundingTxid: OTHER
	});
	const funding = {
		id: 'df',
		method: 'direct-funding',
		status: 'pending',
		offerId: 'offer',
		channelId: HOME,
		statusNote: 'Direct funding submitted.'
	};
	const settled = spliceRow({
		id: 'submission:three',
		requestId: 'three',
		status: 'completed',
		txid: SPLICE,
		statusNote: 'Transaction confirmed.'
	});
	const activity = [row, unrelated, funding, settled];
	const node = fakeNode([adopted()]);
	let saves = 0;
	watchBroadcastErrors({
		node,
		activity,
		save: () => saves++,
		now: () => T0 + 500000
	});
	node.emit('node:error', retainedFailure());
	assert.equal(row.status, 'pending');
	assert.match(row.statusNote, /refused this transaction so far/);
	assert.match(row.statusNote, /keeps retrying/);
	assert.match(row.statusNote, /permanently failed after 6 retries/);
	assert.doesNotMatch(row.statusNote, /still holds/);
	assert.deepEqual(row.broadcast, {
		txid: SPLICE,
		code: 'BROADCAST_PERMANENT_FAILURE',
		reason: `Broadcast permanently failed after 6 retries: ${SPLICE}`,
		retained: true,
		at: T0 + 500000
	});
	assert.equal(saves, 1);
	assert.equal(unrelated.status, 'pending');
	assert.equal(unrelated.statusNote, SUBMITTED);
	assert.equal('broadcast' in unrelated, false);
	assert.equal(funding.statusNote, 'Direct funding submitted.');
	assert.equal('broadcast' in funding, false);
	assert.equal(settled.status, 'completed');
	assert.equal(settled.statusNote, 'Transaction confirmed.');
});

test('a splice refusal carries the backend reason; the same report twice does not save twice', () => {
	const row = spliceRow();
	const activity = [row];
	const node = fakeNode([adopted()]);
	let saves = 0;
	watchBroadcastErrors({ node, activity, save: () => saves++ });
	const refused = {
		code: 'SPLICE_BROADCAST_REFUSED',
		channelId: HOME,
		txid: SPLICE,
		retained: true,
		message: `splice ${SPLICE} refused by the chain backend: min relay fee not met, 100 < 110; the node still holds the transaction and rebroadcasts it on every block until it confirms`,
		timestamp: T0
	};
	node.emit('node:error', refused);
	assert.equal(row.status, 'pending');
	assert.equal(
		row.statusNote,
		'The Bitcoin network has refused this transaction so far (min relay fee not met, 100 < 110). Your wallet keeps retrying until it confirms.'
	);
	assert.equal(row.broadcast.reason, 'min relay fee not met, 100 < 110');
	assert.equal(saves, 1);
	node.emit('node:error', refused);
	assert.equal(saves, 1);
	// A different reason for the same transaction is news.
	node.emit('node:error', {
		...refused,
		message: `splice ${SPLICE} refused by the chain backend: too-long-mempool-chain`
	});
	assert.equal(saves, 2);
	assert.equal(row.broadcast.reason, 'too-long-mempool-chain');
});

test('a broadcast error is never a failure on its own, retained or not', () => {
	const row = spliceRow();
	const node = fakeNode([adopted()]);
	let saves = 0;
	watchBroadcastErrors({ node, activity: [row], save: () => saves++ });
	node.emit('node:error', retainedFailure({ retained: false, message: 'rejected' }));
	assert.equal(row.status, 'pending');
	assert.match(row.statusNote, /refused this transaction \(rejected\)/);
	assert.match(row.statusNote, /no longer retrying/);
	assert.equal(row.broadcast.retained, false);
	// An engine that did not say whether it retains the transaction gets
	// neither promise on the note.
	node.emit('node:error', retainedFailure({ retained: undefined, message: 'rejected' }));
	assert.equal(row.broadcast.retained, null);
	assert.doesNotMatch(row.statusNote, /retrying/);
	assert.equal(row.status, 'pending');
	assert.equal(saves, 2);
});

test('the error must name the row\'s channel and its current splice', () => {
	const row = spliceRow();
	const uncertain = spliceRow({
		id: 'submission:u',
		requestId: 'u',
		status: 'uncertain'
	});
	// About the funding the row was submitted against: not this splice.
	assert.deepEqual(
		noteBroadcastError({
			activity: [row],
			channels: [adopted()],
			error: retainedFailure({ txid: OLD })
		}),
		[]
	);
	// The same transaction on another channel.
	assert.deepEqual(
		noteBroadcastError({
			activity: [row],
			channels: [adopted()],
			error: retainedFailure({ channelId: ELSEWHERE })
		}),
		[]
	);
	// An older engine's payload names neither: nothing to match on.
	assert.deepEqual(
		noteBroadcastError({
			activity: [row],
			channels: [adopted()],
			error: { code: 'BROADCAST_PERMANENT_FAILURE', message: 'x', timestamp: T0 }
		}),
		[]
	);
	// A code that is not about a broadcast.
	assert.deepEqual(
		noteBroadcastError({
			activity: [row],
			channels: [adopted()],
			error: retainedFailure({ code: 'CHAIN_WATCHER_ERROR' })
		}),
		[]
	);
	assert.equal(row.statusNote, SUBMITTED);
	// A confirm-first splice is named by the channel before adoption
	// (pendingSpliceTxid) and matched through it, and an uncertain row is
	// told too, its status left as it is.
	const waiting = {
		channelId: HOME,
		state: 'SPLICING',
		fundingTxid: OLD,
		fundingOutputIndex: 0,
		pendingSpliceTxid: SPLICE,
		pendingSpliceLocalBalanceSats: 1000
	};
	const changed = noteBroadcastError({
		activity: [row, uncertain],
		channels: [waiting],
		error: retainedFailure({ code: 'BROADCAST_FAILED', message: 'bad-txns' })
	});
	assert.deepEqual(changed, [row, uncertain]);
	assert.equal(row.status, 'pending');
	assert.equal(uncertain.status, 'uncertain');
	assert.match(uncertain.statusNote, /bad-txns/);
});

test('an adopted zero-conf splice the server has never seen gets an explanation after the stalled interval and stays pending', async () => {
	const row = spliceRow();
	const asked = [];
	const verify = async (txid) => {
		asked.push(txid);
		return { matched: false, unseen: true };
	};
	const args = { row, channel: adopted(), verify };
	// Within the interval the row still says what it said at submission.
	assert.equal(
		await reconcileSpliceRow({ ...args, now: T0 + STALLED_SUBMISSION_MS }),
		false
	);
	assert.equal(row.statusNote, SUBMITTED);
	assert.equal(
		await reconcileSpliceRow({ ...args, now: T0 + STALLED_SUBMISSION_MS + 1 }),
		true
	);
	assert.equal(row.status, 'pending');
	assert.equal(
		row.statusNote,
		'The Bitcoin network has not seen this transaction yet. Your wallet keeps rebroadcasting it until it confirms.'
	);
	assert.equal(row.txid, undefined);
	// Said once; the next poll is not a change to save.
	assert.equal(
		await reconcileSpliceRow({ ...args, now: T0 + STALLED_SUBMISSION_MS + 2 }),
		false
	);
	assert.deepEqual(asked, [SPLICE, SPLICE, SPLICE]);
});

test('a server that could not be asked is no evidence, and a broadcast reason on the row stands over the unseen note', async () => {
	const row = spliceRow();
	const late = T0 + STALLED_SUBMISSION_MS + 1;
	assert.equal(
		await reconcileSpliceRow({
			row,
			channel: adopted(),
			verify: async () => {
				throw new Error('Chain evidence unavailable');
			},
			now: late
		}),
		false
	);
	assert.equal(row.status, 'pending');
	assert.equal(row.statusNote, SUBMITTED);
	const told = spliceRow();
	noteBroadcastError({
		activity: [told],
		channels: [adopted()],
		error: retainedFailure()
	});
	const note = told.statusNote;
	assert.equal(
		await reconcileSpliceRow({
			row: told,
			channel: adopted(),
			verify: async () => ({ matched: false, unseen: true }),
			now: late
		}),
		false
	);
	assert.equal(told.statusNote, note);
	assert.equal(told.status, 'pending');
});

test('the stalled timer still turns a row with an unchanged funding and no splice in flight uncertain', async () => {
	const row = spliceRow();
	const unchanged = { ...adopted(), fundingTxid: OLD };
	const verify = async () => {
		throw new Error('must not be asked: the funding is the one submitted against');
	};
	assert.equal(
		await reconcileSpliceRow({
			row,
			channel: unchanged,
			verify,
			now: T0 + STALLED_SUBMISSION_MS
		}),
		false
	);
	assert.equal(row.status, 'pending');
	// While the engine is still working on the splice, the timer waits.
	assert.equal(
		await reconcileSpliceRow({
			row,
			channel: { ...unchanged, pendingSpliceLocalBalanceSats: 5 },
			verify,
			now: T0 + STALLED_SUBMISSION_MS + 1
		}),
		false
	);
	assert.equal(
		await reconcileSpliceRow({
			row,
			channel: unchanged,
			verify,
			now: T0 + STALLED_SUBMISSION_MS + 1
		}),
		true
	);
	assert.equal(row.status, 'uncertain');
	assert.match(row.statusNote, /no longer working on it/);
});

test('a verified splice promotes the row as before, through pendingSpliceTxid before the lock and the funding after it', async () => {
	const row = spliceRow();
	const waiting = {
		channelId: HOME,
		state: 'SPLICING',
		fundingTxid: OLD,
		fundingOutputIndex: 0,
		pendingSpliceTxid: SPLICE,
		pendingSpliceLocalBalanceSats: 1000
	};
	const asked = [];
	assert.equal(
		await reconcileSpliceRow({
			row,
			channel: waiting,
			verify: async (txid) => {
				asked.push(txid);
				return { matched: true, confirmed: false };
			},
			now: T0 + 1
		}),
		true
	);
	assert.deepEqual(asked, [SPLICE]);
	assert.equal(row.status, 'pending');
	assert.equal(row.txid, SPLICE);
	assert.equal(row.reference, SPLICE);
	assert.equal(row.statusNote, 'Transaction verified. Waiting for confirmation.');
	assert.equal(
		await reconcileSpliceRow({
			row,
			channel: adopted(),
			verify: async () => ({ matched: true, confirmed: true }),
			now: T0 + 2
		}),
		true
	);
	assert.equal(row.status, 'completed');
	assert.equal(row.title, 'Bitcoin sent');
	// A transaction that is not this row's says nothing about it.
	const other = spliceRow({ id: 'submission:o', requestId: 'o' });
	assert.equal(
		await reconcileSpliceRow({
			row: other,
			channel: adopted(),
			verify: async () => null,
			now: T0 + STALLED_SUBMISSION_MS + 1
		}),
		false
	);
	assert.equal(other.status, 'pending');
	assert.equal(other.statusNote, SUBMITTED);
});
