'use strict';

/**
 * Engine boot timings for the client's diagnostic hook, under phase
 * `engine-perf`. Every message is `<mark> <detail>`: the client files a
 * timing under the message's first word and keeps the rest as its detail.
 *
 *   create 812ms
 *   restore-graph 3900ms channels 14670 stale 0 nodes 12721 orphans 0 ...
 *   initial-sync 2140ms
 *   gossip-synced download 950ms apply 3100ms busy 2400ms slices 310 channels 28000
 *
 * Without a hook nothing is timed, listened to or reported.
 */
function engineDiagnostics({ onDiagnostic, now = Date.now }) {
	const enabled = typeof onDiagnostic === 'function';
	const report = (message) => {
		// A failing hook must not fail the start or the engine's own sync.
		try {
			onDiagnostic({ phase: 'engine-perf', message });
		} catch {}
	};
	const watched = new WeakSet();
	const restored = new WeakSet();
	return {
		/**
		 * Await one boot step and report how long it took once it succeeds.
		 * @template T
		 * @param {string} mark
		 * @param {() => Promise<T>} run
		 * @returns {Promise<T>}
		 */
		async time(mark, run) {
			if (!enabled) return run();
			const started = now();
			const value = await run();
			report(`${mark} ${now() - started}ms`);
			return value;
		},
		/**
		 * Report how the node brought back its stored network map as it was
		 * built, once per node. An engine before Beignet 0.29.0 has no
		 * getGraphRestoreStats and reports nothing.
		 */
		graphRestored(node) {
			if (!enabled || restored.has(node)) return;
			if (typeof node?.getGraphRestoreStats !== 'function') return;
			let stats;
			try {
				stats = node.getGraphRestoreStats();
			} catch {
				return;
			}
			if (!stats) return;
			restored.add(node);
			report(restoreGraph(stats));
		},
		/** Report every Rapid Gossip Sync import the node finishes, one listener per node. */
		watchGossip(node) {
			if (!enabled || watched.has(node)) return;
			watched.add(node);
			node.on('gossip:synced', (data) => report(gossipSynced(data)));
		}
	};
}

/**
 * Beignet 0.28.0 added downloadMs, applyMs, busyMs and slices to
 * gossip:synced; a field an older engine does not send is left out.
 */
function gossipSynced(data) {
	const fields = [
		['download', data?.downloadMs, 'ms'],
		['apply', data?.applyMs, 'ms'],
		['busy', data?.busyMs, 'ms'],
		['slices', data?.slices, ''],
		['channels', data?.channelsAdded, '']
	];
	return ['gossip-synced']
		.concat(
			fields
				.filter(([, value]) => Number.isFinite(value))
				.map(([name, value, unit]) => `${name} ${value}${unit}`)
		)
		.join(' ');
}

/**
 * The network map's part of the restore first, then its rows, then each
 * step, then the whole restore and the whole node build. A field the stats
 * lack is left out.
 */
function restoreGraph(stats) {
	const fields = [
		['channels', stats?.channelRows, ''],
		['stale', stats?.staleChannels, ''],
		['nodes', stats?.nodeRows, ''],
		['orphans', stats?.orphanNodes, ''],
		['graph-channels', stats?.graphChannels, ''],
		['graph-nodes', stats?.graphNodes, ''],
		['load-channels', stats?.loadChannelsMs, 'ms'],
		['restore-channels', stats?.restoreChannelsMs, 'ms'],
		['load-nodes', stats?.loadNodesMs, 'ms'],
		['restore-nodes', stats?.restoreNodesMs, 'ms'],
		['delete', stats?.deleteMs, 'ms'],
		['prune', stats?.pruneMs, 'ms'],
		['reannounce', stats?.reannounceMs, 'ms'],
		['restore', stats?.restoreMs, 'ms'],
		['construct', stats?.constructMs, 'ms']
	];
	const head = Number.isFinite(stats?.graphMs)
		? `restore-graph ${stats.graphMs}ms`
		: 'restore-graph';
	return [head]
		.concat(
			fields
				.filter(([, value]) => Number.isFinite(value))
				.map(([name, value, unit]) => `${name} ${value}${unit}`)
		)
		.join(' ');
}

module.exports = { engineDiagnostics, gossipSynced, restoreGraph };
