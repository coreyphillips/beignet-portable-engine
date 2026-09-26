'use strict';
/**
 * What a splice-out submission row learns from the engine beyond the chain.
 *
 * The runtime journals a splice-out as a row that is `pending` from the
 * moment the engine accepts it, and reconciliation promotes the row once
 * Electrum has a transaction that spends the channel's old funding and pays
 * the request. Two outcomes the chain cannot report used to leave such a row
 * `pending` with no reason for the life of the wallet (fork issue #7):
 *
 * 1. The network refused the broadcast. The engine reports that as a
 *    node:error (BROADCAST_FAILED, BROADCAST_PERMANENT_FAILURE and, since
 *    Beignet 0.23.1, SPLICE_BROADCAST_REFUSED with the backend's reason)
 *    that names the transaction, its channel and whether the node still
 *    holds the bytes and re-sends them on every block (`retained`, beignet
 *    #1062). A permanent failure is the chain watcher's own retry queue
 *    giving up, not the end of the attempt: a fully signed or adopted splice
 *    is re-sent on every block until it confirms and can still land, so a
 *    row is never marked failed on that error alone. The engine's reason
 *    goes on the row instead, and the stalled timer stays the fallback for a
 *    loss the engine never reported.
 * 2. A zero-conf channel adopts the splice at the peer's lock, before any
 *    chain evidence, so the channel's funding changes and reconciliation
 *    looks the new funding up. A server that has never seen the transaction
 *    refuses the lookup, and the stalled timer cannot run because the
 *    funding did change; before, that refusal was swallowed and the row
 *    waited in silence. The row now says the network has not seen the
 *    transaction yet, after the same interval the timer uses.
 *
 * Kept apart from the runtime so it runs against a fake node
 * (`portable-tests/splice-status.test.cjs`). Nothing here touches upstream
 * `src/`.
 */

/**
 * How long a splice submission may show no chain effect before the wallet
 * stops calling it "pending" without a word. Long enough to cover a slow
 * negotiation and a reconnect, short enough that nobody is left watching a
 * spinner for a payment that was never broadcast.
 */
const STALLED_SUBMISSION_MS = 600000;

/** The node:error codes that are about one transaction the node broadcast. */
const BROADCAST_ERROR_CODES = new Set([
	'BROADCAST_FAILED',
	'BROADCAST_PERMANENT_FAILURE',
	'SPLICE_BROADCAST_REFUSED'
]);

const STALLED_NOTE =
	'This payment has not appeared on the Bitcoin network and your wallet is no longer working on it. Check this address and your balance before sending again.';
const UNSEEN_NOTE =
	'The Bitcoin network has not seen this transaction yet. Your wallet keeps rebroadcasting it until it confirms.';

/**
 * Whether the engine is still working on a splice for this channel. Absence
 * of both markers is not proof that nothing happened, which is why a stalled
 * row becomes uncertain rather than failed.
 */
function spliceInFlight(channel) {
	return (
		!!channel &&
		(channel.payThroughSplice !== undefined ||
			channel.pendingSpliceLocalBalanceSats !== undefined)
	);
}

/** A splice-out submission row the wallet is still waiting on. */
function openSpliceRow(row) {
	return (
		!!row &&
		row.method !== 'direct-funding' &&
		typeof row.channelId === 'string' &&
		typeof row.previousFundingTxid === 'string' &&
		(row.status === 'pending' || row.status === 'uncertain')
	);
}

/**
 * The transaction ids the row's current splice may be known by: the one
 * reconciliation already verified, the channel's in-flight splice
 * (`pendingSpliceTxid`, beignet #1060) and, on a zero-conf channel that has
 * adopted the splice, the channel's new funding. Never the funding the row
 * was submitted against: an error about that transaction is about the open
 * or an earlier splice.
 */
function spliceTxids(row, channel) {
	const ids = new Set();
	if (typeof row.txid === 'string') ids.add(row.txid);
	for (const id of [channel?.pendingSpliceTxid, channel?.fundingTxid])
		if (typeof id === 'string' && id !== row.previousFundingTxid) ids.add(id);
	return ids;
}

/**
 * The engine's reason without the parts the row's own note already says:
 * the rebroadcast promise the node appends when the transaction is
 * retained, and the "splice <txid> refused by the chain backend" lead of
 * SPLICE_BROADCAST_REFUSED. Bounded, since it is shown as is.
 */
function engineReason(error) {
	const text = typeof error.message === 'string' ? error.message : '';
	return text
		.replace(/;\s*the node still holds (this|the) transaction[\s\S]*$/i, '')
		.replace(/^splice [0-9a-f]{64} refused by the chain backend:\s*/i, '')
		.trim()
		.slice(0, 300);
}

function broadcastNote(reason, retained) {
	const what = reason ? ` (${reason})` : '';
	if (retained === true)
		return `The Bitcoin network has refused this transaction so far${what}. Your wallet keeps retrying until it confirms.`;
	if (retained === false)
		return `The Bitcoin network refused this transaction${what} and your wallet is no longer retrying it. Check this address and your balance before sending again.`;
	return `The Bitcoin network has refused this transaction so far${what}.`;
}

/**
 * Put a broadcast error's reason on the splice-out rows it is about.
 *
 * A row matches when the error names its channel and one of the row's
 * splice transaction ids. The row's status is untouched: `pending` stays
 * `pending` while the node retains the transaction, and nothing here marks
 * a row failed, because the transaction can still land. Unrelated rows,
 * direct fundings and settled rows are left alone, and a repeat of the same
 * report changes nothing. Returns the rows changed.
 *
 * @param {object} args
 * @param {object[]} args.activity the runtime's activity journal
 * @param {object[]} args.channels the node's channel listing
 * @param {object} args.error the node:error payload: hex `channelId`, display-order `txid`, `retained`
 * @param {number} [args.now]
 * @returns {object[]}
 */
function noteBroadcastError({ activity, channels, error, now = Date.now() }) {
	if (!error || !BROADCAST_ERROR_CODES.has(error.code)) return [];
	if (typeof error.channelId !== 'string' || typeof error.txid !== 'string')
		return [];
	const changed = [];
	for (const row of activity) {
		if (!openSpliceRow(row) || row.channelId !== error.channelId) continue;
		const channel = channels.find((c) => c.channelId === row.channelId);
		if (!spliceTxids(row, channel).has(error.txid)) continue;
		const reason = engineReason(error);
		const retained =
			typeof error.retained === 'boolean' ? error.retained : null;
		const previous = row.broadcast;
		if (
			previous &&
			previous.txid === error.txid &&
			previous.code === error.code &&
			previous.reason === reason &&
			previous.retained === retained
		)
			continue;
		row.broadcast = {
			txid: error.txid,
			code: error.code,
			reason,
			retained,
			at: now
		};
		row.statusNote = broadcastNote(reason, retained);
		changed.push(row);
	}
	return changed;
}

/**
 * Listen for broadcast errors on a running node and record them on the
 * journal; `save` is called once per event that changed a row.
 *
 * @param {object} args
 * @param {{ on: Function, listChannels: () => object[] }} args.node
 * @param {object[]} args.activity
 * @param {() => void} args.save
 * @param {() => number} [args.now]
 */
function watchBroadcastErrors({ node, activity, save, now = Date.now }) {
	node.on('node:error', (error) => {
		try {
			const changed = noteBroadcastError({
				activity,
				channels: node.listChannels(),
				error,
				now: now()
			});
			if (changed.length > 0) save();
		} catch {
			// save() already fenced the runtime on a storage failure, and an
			// error listener must not throw into the emitter.
		}
	});
}

/**
 * The chain source answered that it does not have the transaction the row's
 * channel now runs on: an adopted zero-conf splice the network has not
 * seen, or a signed splice still waiting to propagate. Once the row is
 * older than the stalled interval, say so, once. A broadcast error already
 * on the row is the more exact account and stands. The row stays pending:
 * the node holds the transaction and re-sends it on every block.
 */
function noteUnseenSplice({ row, now, stalledMs }) {
	if (row.status !== 'pending' || row.txid || row.broadcast) return false;
	if (now - (row.createdAt ?? 0) <= stalledMs) return false;
	if (row.statusNote === UNSEEN_NOTE) return false;
	row.statusNote = UNSEEN_NOTE;
	return true;
}

/**
 * Reconcile one splice-out row against its channel and the chain.
 *
 * `verify(txid)` is the chain lookup. It resolves `{ matched, confirmed }`
 * for a transaction that spends the row's old funding and pays the request,
 * `{ matched: false, unseen: true }` when the server answered that it does
 * not have the transaction, `null` for a transaction that is not this
 * row's, and throws when the server could not be asked; a server that could
 * not answer is no evidence either way, so nothing changes then. Returns
 * whether the row changed.
 *
 * @param {object} args
 * @param {object} args.row a splice-out row that is pending or uncertain
 * @param {object | undefined} args.channel the row's channel, from the node's listing
 * @param {(txid: string) => Promise<any>} args.verify
 * @param {number} [args.now]
 * @param {number} [args.stalledMs]
 * @returns {Promise<boolean>}
 */
async function reconcileSpliceRow({
	row,
	channel,
	verify,
	now = Date.now(),
	stalledMs = STALLED_SUBMISSION_MS
}) {
	// The channel names the splice before it adopts it (beignet #1060), so a
	// confirm-first splice is verified against the chain from the moment it
	// is fully signed rather than after its lock.
	const candidate =
		row.txid ?? channel?.pendingSpliceTxid ?? channel?.fundingTxid;
	if (
		!candidate ||
		candidate === row.previousFundingTxid ||
		!row.previousFundingTxid ||
		row.previousFundingOutputIndex == null
	) {
		// A splice replaces the channel's funding, so an unchanged funding
		// txid means this submission never took effect on chain.
		// Reconciliation can only ever promote a row to completed, so
		// without this a submission that was never broadcast stays "pending"
		// for the life of the wallet: no transaction to look up, nothing
		// arriving at the destination, and no amount of waiting or mining
		// changes it. Say so instead, once it has clearly stopped
		// progressing.
		if (
			row.status === 'pending' &&
			!row.txid &&
			row.previousFundingTxid &&
			now - (row.createdAt ?? 0) > stalledMs &&
			!spliceInFlight(channel)
		) {
			row.status = 'uncertain';
			row.statusNote = STALLED_NOTE;
			return true;
		}
		return false;
	}
	let proof;
	try {
		proof = await verify(candidate);
	} catch {
		return false;
	}
	if (!proof?.matched)
		return !!proof?.unseen && noteUnseenSplice({ row, now, stalledMs });
	row.txid = candidate;
	row.reference = candidate;
	row.status = proof.confirmed ? 'completed' : 'pending';
	row.title = proof.confirmed ? 'Bitcoin sent' : 'Bitcoin payment pending';
	row.statusNote = proof.confirmed
		? 'Transaction confirmed.'
		: 'Transaction verified. Waiting for confirmation.';
	return true;
}

module.exports = {
	STALLED_SUBMISSION_MS,
	BROADCAST_ERROR_CODES,
	spliceInFlight,
	noteBroadcastError,
	watchBroadcastErrors,
	reconcileSpliceRow
};
