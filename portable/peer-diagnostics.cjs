'use strict';

/**
 * The client's diagnostic entry for one of the engine's error and peer
 * events (`node:error`, `peer:error`, `peer:warning`, `peer:connect`,
 * `peer:disconnect`, `htlc:forward-refused`).
 *
 * BeignetNode emits each as one object: the error events carry a `message`
 * and `code`, and the peer events a `pubkey`. A peer:connect message stays
 * the bare pubkey, which the client compares with its primary's. Since
 * Beignet 0.35.0 a peer:disconnect also says who closed the connection and
 * why (`closedBy`, `reason`, `direction`, `uptimeMs`), and its message puts
 * that cause after the pubkey:
 *
 *   02ab...ef closed by peer: read ECONNRESET (outbound, up 41200ms)
 *
 * A listener that hands over (pubkey, error) as two arguments, as the
 * lower-level LightningNode does, is still read as before.
 *
 * Since Beignet 0.37.0 two things that used to arrive as a CHANNEL_ERROR
 * `node:error` have events of their own (upstream #1961, #1962). They read
 * as the old text did, with the peer, the channel or the amount after it:
 *
 *   Remote warning: Unknown UTXO 504311x1993x0 (peer 02abab..., channel 1f2e...)
 *   Forward refused: Insufficient balance for HTLC (150000000 msat)
 */
function peerDiagnostic(event, first, second) {
	if (event === 'peer:warning') return warningDiagnostic(first);
	if (event === 'htlc:forward-refused') return forwardRefusedDiagnostic(first);
	const peerKey =
		typeof first === 'string' ? first : String(first?.pubkey ?? '');
	const detail =
		second instanceof Error
			? second.message
			: typeof second?.message === 'string'
				? second.message
				: undefined;
	const code = second?.code ?? first?.code;
	return {
		phase: event,
		message:
			detail !== undefined
				? `${detail} (peer ${peerKey.slice(0, 16)})`
				: event === 'peer:disconnect' && disconnectCause(first)
					? [peerKey, disconnectCause(first)].filter(Boolean).join(' ')
					: String(
							first?.message ??
								first?.error ??
								(typeof first === 'string' ? first : first?.pubkey) ??
								event
						),
		code: typeof code === 'string' ? code : undefined
	};
}

/** `closed by peer: read ECONNRESET (outbound, up 41200ms)`, or '' when the engine named no cause. */
function disconnectCause(data) {
	if (data?.closedBy !== 'peer' && data?.closedBy !== 'us') return '';
	const reason =
		typeof data.reason === 'string' && data.reason ? `: ${data.reason}` : '';
	const context = [
		data.direction === 'inbound' || data.direction === 'outbound'
			? data.direction
			: '',
		Number.isFinite(data.uptimeMs) && data.uptimeMs >= 0
			? `up ${Math.round(data.uptimeMs)}ms`
			: ''
	].filter(Boolean);
	return `closed by ${data.closedBy}${reason}${
		context.length ? ` (${context.join(', ')})` : ''
	}`;
}

/** A peer's BOLT 1 warning: `{ pubkey, channelId: hex | null, text }`. */
function warningDiagnostic(data) {
	const text = typeof data?.text === 'string' ? data.text : '';
	const where = [
		typeof data?.pubkey === 'string' && data.pubkey
			? `peer ${data.pubkey.slice(0, 16)}`
			: '',
		typeof data?.channelId === 'string' && data.channelId
			? `channel ${data.channelId.slice(0, 16)}`
			: ''
	].filter(Boolean);
	return {
		phase: 'peer:warning',
		message: `Remote warning: ${text}${
			where.length ? ` (${where.join(', ')})` : ''
		}`,
		code: undefined
	};
}

/** A forward the outgoing channel refused to add, failed back upstream. */
function forwardRefusedDiagnostic(data) {
	const reason =
		typeof data?.reason === 'string' && data.reason ? data.reason : 'refused';
	const amount =
		typeof data?.amountMsat === 'string' && /^\d+$/.test(data.amountMsat)
			? ` (${data.amountMsat} msat)`
			: '';
	return {
		phase: 'htlc:forward-refused',
		message: `Forward refused: ${reason}${amount}`,
		code:
			typeof data?.channelErrorCode === 'string'
				? data.channelErrorCode
				: undefined
	};
}

module.exports = { peerDiagnostic };
