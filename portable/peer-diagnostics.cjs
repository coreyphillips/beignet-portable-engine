'use strict';

/**
 * The client's diagnostic entry for one of the engine's error and peer
 * events (`node:error`, `peer:error`, `peer:connect`, `peer:disconnect`).
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
 */
function peerDiagnostic(event, first, second) {
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

module.exports = { peerDiagnostic };
