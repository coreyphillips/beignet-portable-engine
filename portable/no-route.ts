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
	primaryPubkey: string | null;
	primaryConnected: boolean;
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
	if (open.length === 0)
		return {
			code: 'NO_CHANNEL',
			message: 'This wallet has no Lightning channel to send from yet.'
		};
	if (!open.some((c) => c.htlcUsable)) {
		if (f.primaryPubkey && !f.primaryConnected)
			return {
				code: 'PRIMARY_DOWN',
				message:
					'Your primary node is not connected, so this wallet cannot send over Lightning right now.'
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
					'Your channel is on hold until its state is confirmed with your primary node, so it cannot send yet.'
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
	if (f.primaryPubkey && !f.graphChannelCount(f.primaryPubkey))
		return {
			code: 'NO_ROUTE',
			message:
				"No route found. This wallet's map of the Lightning network has no public channels for your primary node, so it cannot find a way past it. Try again once the map has synced."
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
			'No route to the recipient was found through your primary node with enough capacity for this amount.'
	};
}
