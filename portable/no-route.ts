/**
 * Why the router found no route, in words the wallet can show.
 *
 * estimatePayment answers only null, which reached the wallet as "Unable to
 * estimate payment" whatever the cause. This reads the facts the router works
 * from, in the order a user can act on them: a channel to send from, whether
 * that channel takes a new payment, whether it holds enough, and whether the
 * network map reaches the recipient.
 */
export type NoRouteFacts = {
	amountSats: number | null;
	destination: string | null;
	hasRoutingHints: boolean;
	/**
	 * The ranked primaries and whether each is a connected peer now; empty
	 * when none is configured. One entry reads as the one primary did.
	 */
	primaries: Array<{ pubkey: string; connected: boolean }>;
	/** GET /channels rows. `htlcUsable` is the channel's own new-HTLC gate. */
	channels: any[];
	/** GET /liquidity sendableSats: balance above the reserve, summed. */
	sendableSats: number;
	/** Public channels the map holds for a node, or null when it is absent. */
	graphChannelCount: (pubkey: string) => number | null;
};

const CLOSING = /CLOS|SHUTTING_DOWN/;

export function explainNoRoute(f: NoRouteFacts): {
	code: string;
	message: string;
} {
	if (!f.amountSats || !f.destination)
		return {
			code: 'INVALID_INVOICE',
			message: 'The wallet could not read the amount or recipient of this invoice.'
		};
	const open = f.channels.filter((c) => !CLOSING.test(String(c.state)));
	const several = f.primaries.length > 1;
	const nodes = several ? 'primary nodes' : 'primary node';
	const connected = f.primaries.filter((p) => p.connected);
	if (open.length === 0)
		return {
			code: 'NO_CHANNEL',
			message: 'This wallet has no Lightning channel to send from yet.'
		};
	if (!open.some((c) => c.htlcUsable)) {
		if (f.primaries.length > 0 && connected.length === 0)
			return {
				code: 'PRIMARY_DOWN',
				message: several
					? 'None of your primary nodes is connected, so this wallet cannot send over Lightning right now.'
					: 'Your primary node is not connected, so this wallet cannot send over Lightning right now.'
			};
		if (open.some((c) => c.fundingUnaccounted))
			return {
				code: 'CHANNEL_NOT_READY',
				message:
					"Your channel cannot send yet: your Electrum server has not seen its funding transaction. This lifts by itself once the transaction shows up."
			};
		if (
			open.some(
				(c) =>
					c.restoreRecencyUnproven ||
					c.reestablishRecencyUnproven ||
					c.reestablishSecretMissing ||
					c.restoreRevokedRisk
			)
		)
			return {
				code: 'CHANNEL_NOT_READY',
				message:
					`Your channel is on hold until its state is confirmed with your ${nodes}, so it cannot send yet.`
			};
		return {
			code: 'CHANNEL_NOT_READY',
			message: `Your channel cannot send yet (${String(open[0].state).toLowerCase().replace(/_/g, ' ')}).`
		};
	}
	if (f.amountSats >= f.sendableSats)
		return {
			code: 'INSUFFICIENT_FUNDS',
			message: `This wallet can send up to ${f.sendableSats.toLocaleString('en-US')} sats over Lightning right now, which does not cover this payment and its routing fee. Part of the channel balance is held back as a reserve.`
		};
	// The map must reach past at least one primary a payment can leave
	// through: a connected one when any is, else any configured one.
	const past = connected.length > 0 ? connected : f.primaries;
	if (past.length > 0 && past.every((p) => !f.graphChannelCount(p.pubkey)))
		return {
			code: 'NO_ROUTE',
			message: `No route found. This wallet's map of the Lightning network has no public channels for your ${nodes}, so it cannot find a way past ${several ? 'them' : 'it'}. Try again once the map has synced.`
		};
	if (!f.hasRoutingHints && f.graphChannelCount(f.destination) === null)
		return {
			code: 'NO_ROUTE',
			message:
				"No route found. The recipient is not in this wallet's map of the Lightning network."
		};
	return {
		code: 'NO_ROUTE',
		message:
			`No route to the recipient was found through your ${nodes} with enough capacity for this amount.`
	};
}
