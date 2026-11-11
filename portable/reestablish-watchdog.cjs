'use strict';

const WATCHDOG_MS = 8000;
const MAX_REDIALS = 3;

/** A connected peer that never answers channel_reestablish needs a new transport. */
function reestablishWatchdog({ node, pendingTimers, canRedial, redial }) {
	const checks = new Map();
	const attempts = new Map();
	let backgrounded = false;
	let closed = false;
	function cancelTimer(check) {
		if (check.timer != null) {
			clearTimeout(check.timer);
			pendingTimers.delete(check.timer);
			check.timer = null;
		}
	}
	function disconnected(pubkey) {
		const check = checks.get(pubkey);
		if (check) cancelTimer(check);
		checks.delete(pubkey);
	}
	function arm(pubkey, check) {
		check.due = Date.now() + check.remaining;
		const timer = setTimeout(() => {
			if (check.timer !== timer) return;
			checks.delete(pubkey);
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
		}, check.remaining);
		check.timer = timer;
		pendingTimers.add(timer);
	}
	function connected(pubkey) {
		if (closed) return;
		disconnected(pubkey);
		const check = { timer: null, due: 0, remaining: WATCHDOG_MS, grantedGrace: backgrounded };
		checks.set(pubkey, check);
		if (!backgrounded) arm(pubkey, check);
	}
	function setAppBackgrounded(value) {
		if (closed || value === backgrounded) return;
		backgrounded = value;
		for (const [pubkey, check] of checks) {
			if (backgrounded) {
				cancelTimer(check);
				// Allow a queued reply one fresh foreground window. Multiple app
				// switches during that window spend the same time budget.
				check.remaining = check.grantedGrace
					? Math.max(0, Math.min(check.remaining, check.due - Date.now())) : WATCHDOG_MS;
				check.grantedGrace = true;
			} else {
				arm(pubkey, check);
			}
		}
	}
	function close() {
		closed = true;
		for (const pubkey of checks.keys()) disconnected(pubkey);
		attempts.clear();
	}
	return { connected, disconnected, setAppBackgrounded, close };
}

module.exports = { reestablishWatchdog };
