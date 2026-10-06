'use strict';

/**
 * Engine boot timings for the client's diagnostic hook, under phase
 * `engine-perf`. Every message is `<mark> <detail>`: the client files a
 * timing under the message's first word and keeps the rest as its detail.
 *
 *   create 812ms
 *   restore-graph 3812ms channels 20328 nodes 7934 load 3006+489ms add 265+39ms restore 4761ms construct 4866ms
 *   restore-graph 6100ms busy 3900ms slices 480 channels 20328 nodes 7934 load 3006+489ms add 265+39ms restore 950ms construct 1100ms
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
		 * Report how the node brought back its stored network map, once per
		 * node: at once when it came back inside create, or when a deferred
		 * restore (deferGraphRestore) emits graph:restored. An engine
		 * without getGraphRestoreStats (coreyphillips/beignet#1343) reports
		 * nothing.
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
			restored.add(node);
			if (stats) {
				report(restoreGraph(stats));
				return;
			}
			if (typeof node.once === 'function') {
				node.once('graph:restored', (later) => report(restoreGraph(later)));
			}
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
 * The network map's part of the restore first, from its start to its end,
 * then for a deferred one the time spent restoring (`busy`) and the slices
 * it took, then the rows it read, how long reading and parsing them took
 * (`load`) and adding them to the graph (`add`), channels then nodes, then
 * the restore inside create (the map's included only when it was not
 * deferred) and the whole node build. It is kept short so the client's boot report keeps the marks after
 * it; the stale and orphan counts and the smaller steps are in the engine's
 * own `peer:graph_restored` log. A figure the stats lack is left out.
 */
function restoreGraph(stats) {
	const pair = (a, b) =>
		Number.isFinite(a) && Number.isFinite(b) ? `${a}+${b}` : undefined;
	const sliced = stats?.cooperative === true;
	const fields = [
		['busy', sliced ? stats?.busyMs : undefined, 'ms'],
		['slices', sliced ? stats?.slices : undefined, ''],
		['channels', stats?.channelRows, ''],
		['nodes', stats?.nodeRows, ''],
		['load', pair(stats?.loadChannelsMs, stats?.loadNodesMs), 'ms'],
		['add', pair(stats?.restoreChannelsMs, stats?.restoreNodesMs), 'ms'],
		['restore', stats?.restoreMs, 'ms'],
		['construct', stats?.constructMs, 'ms'],
		['steps', stats?.steps, '']
	];
	const head = Number.isFinite(stats?.graphMs)
		? `restore-graph ${stats.graphMs}ms`
		: 'restore-graph';
	return [head]
		.concat(
			fields
				.filter(
					([, value]) => Number.isFinite(value) || typeof value === 'string'
				)
				.map(([name, value, unit]) => `${name} ${value}${unit}`)
		)
		.join(' ');
}

module.exports = { engineDiagnostics, gossipSynced, restoreGraph };
