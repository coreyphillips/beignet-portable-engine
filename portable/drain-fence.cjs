'use strict';

/** Count admitted wallet mutations synchronously, before their first await. */
function drainFence({ active, failure }) {
	let pending = 0;
	return {
		pending: () => pending,
		async run(input, execute) {
			const method = String(input.method ?? 'GET').toUpperCase();
			const path = String(input.path ?? '').split('?')[0];
			const control = /^\/wallets\/[^/]+\/api\/drain\/(quote|send|cancel)$/.test(path) ||
				/^\/api\/wallets\/[^/]+\/(start|stop)$/.test(path);
			// Offline receive quoting can reserve capacity, despite using GET.
			const mutation = !control && (method !== 'GET' || /^\/wallets\/[^/]+\/api\/receive\/quote$/.test(path));
			if (mutation && active()) failure('DRAIN_IN_PROGRESS', 'Finish or cancel the wallet drain before changing this wallet', 409);
			if (mutation) pending++;
			try {
				return await execute(input);
			} finally {
				if (mutation) pending--;
			}
		}
	};
}

module.exports = { drainFence };
