'use strict';

const WATCHDOG_MS = 8000;
const MAX_REDIALS = 3;

/** A connected peer that never answers channel_reestablish needs a new transport. */
function reestablishWatchdog({ node, pendingTimers, canRedial, redial }) {
	const timers = new Map();
	const attempts = new Map();
	function disconnected(pubkey) {
		const previous = timers.get(pubkey);
		if (previous !== undefined) {
			clearTimeout(previous);
			pendingTimers.delete(previous);
			timers.delete(pubkey);
		}
	}
	function connected(pubkey) {
		disconnected(pubkey);
		const timer = setTimeout(() => {
			if (timers.get(pubkey) !== timer) return;
			timers.delete(pubkey);
			pendingTimers.delete(timer);
			if (!canRedial(pubkey)) return;
			const peerChannels = node.listChannels().filter(channel => channel.peerPubkey === pubkey);
			const waiting = peerChannels.some(channel => channel.state === 'AWAITING_REESTABLISH');
			// One working channel already demonstrates a live connection.
			const usable = peerChannels.some(channel => channel.htlcUsable ?? channel.state === 'NORMAL');
			if (!waiting || usable) {
				attempts.delete(pubkey);
				return;
			}
			const count = attempts.get(pubkey) || 0;
			if (count >= MAX_REDIALS) return;
			attempts.set(pubkey, count + 1);
			redial(pubkey, `channel still awaiting reestablish 8s after connecting, dialling again (${count + 1}/${MAX_REDIALS})`);
		}, WATCHDOG_MS);
		timers.set(pubkey, timer);
		pendingTimers.add(timer);
	}
	return { connected, disconnected };
}

module.exports = { reestablishWatchdog };
