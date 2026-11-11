import { OfflineReceive } from './offline-receive';
import { explainNoRoute } from './no-route';
import { BeignetNode } from '../src/cli/beignet-node';
import { generateMnemonic, validateMnemonic } from 'bip39';
import { Buffer } from 'buffer';
import { configure, release } from './state';
import { randomBytes } from './crypto';
import { fundingConfirmed, queryElectrum, verifySubmission } from './proof';
import { lookupOnchainReceipts } from './receipts';
import {
	ReceiveRequestStore,
	allocateWatchedReceiveAddress
} from './receive-requests';
import { verifyElectrumNetwork } from './network';
import * as rules from './lfbw.cjs';
import { runChannelize } from './channelize.cjs';
import { sendRoutes } from './send-routes.cjs';
import { primariesRoutes } from './primaries-routes.cjs';
import {
	anyIroh,
	engineToEntries,
	entryToEngine,
	planPrimariesSync
} from './primaries-record.cjs';
import { channelizePause } from './channelize-pause.cjs';
import { drainCoordinator } from './drain.cjs';
import { drainFence } from './drain-fence.cjs';
import { closeNotStarted } from './drain-close-state.cjs';
import { reconcileSpliceRow, watchBroadcastErrors } from './splice-status.cjs';
import { engineDiagnostics } from './engine-diagnostics.cjs';
import { peerDiagnostic } from './peer-diagnostics.cjs';
import { reestablishWatchdog } from './reestablish-watchdog.cjs';
import { readRecoveryImport, validateRecoveryImport, recoveryRefusal, hasInstalledRecovery } from './recovery';
export { createRelaySocketFactory } from './relay';
export { IrohTransport, IROH_ALPN } from '../src/lightning/transport/iroh';
export { parsePrimaryUri, parsePrimaryFallback } from './primary-uri.cjs';
import { parsePrimaryFallback } from './primary-uri.cjs';
export const DEFAULT_PRIMARY =
	'025501f56b72e7b999443b836ae1bff4c6fff514943d3f6677302a9189949bd99c@ulyeemszaigzrvpjcjcby4ehibrvsuqi5sq4dmmew2urk2nse5f7spid.onion:9102';
// The upstream Beignet release this bundle was cut from. esbuild substitutes it
// from package.json's upstreamVersion (scripts/build-portable.cjs), so a resync
// cannot leave a stale version behind in GET /api/config.
declare const __BEIGNET_ENGINE_VERSION__: string;
const ENGINE_VERSION =
	typeof __BEIGNET_ENGINE_VERSION__ === 'string'
		? __BEIGNET_ENGINE_VERSION__
		: 'unknown-portable';
// Requests that find a route, and so wait for the stored network map
// (deferGraphRestore) before they run.
const ROUTE_FINDING: ReadonlySet<string> = new Set([
	'POST /payment/estimate',
	'POST /invoice/pay-safe',
	'POST /invoice/pay-all/quote',
	'POST /invoice/pay-all'
]);
// The networks a wallet can be created on. GET /api/config advertises this
// same list, so a client that trusts the config can create every wallet the
// engine accepts and no other (fork issue #4).
const SUPPORTED_NETWORKS: readonly string[] = Object.freeze([
	'mainnet',
	'testnet',
	'signet',
	'regtest'
]);
function failure(code: string, message: string, status = 400): never {
	throw Object.assign(new Error(message), { code, status });
}
const sleep = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
/**
 * How long a stop may spend waiting for a start that is still in flight, and
 * for the last request to drain. Past it the node is torn down anyway: the
 * caller holds an exclusive storage lease behind this call, and a close that
 * never returns strands every later wallet in the process.
 */
const STOP_DEADLINE_MS = 15000;
const clone = (v: any) =>
	JSON.parse(
		JSON.stringify(v, (_key, value) =>
			typeof value === 'bigint' ? value.toString() : value
		)
	);
export async function createPortableRuntime(options: any) {
	if (!options.databaseFactory || !options.volume || !options.socketFactory)
		throw new Error('Durable database, volume and transport are required');
	const volume = options.volume;
	const load = (path: string, fallback: any) => {
		const raw = volume.read(path);
		return raw === null
			? fallback
			: JSON.parse(Buffer.from(raw).toString('utf8'));
	};
	let durabilityFailed = false;
	const save = (path: string, value: any) => {
		try {
			volume.write(path, Buffer.from(JSON.stringify(value)));
		} catch (error) {
			durabilityFailed = true;
			throw error;
		}
	};
	const registry = load('/wallet/registry.json', null);
	let record: any = registry?.record ?? null;
	// A record from before ranked primaries names one scalar primary. It is
	// read as a one-entry list, the scalar fields staying as the rank-1
	// mirrors readers still look at, and written back once the volume writer
	// below exists (coreyphillips/beignet#1924).
	const migratedRecord =
		!!record?.lfbw?.enabled && !Array.isArray(record.lfbw.primaries);
	if (migratedRecord)
		record = { ...record, lfbw: rules.migrateLfbw(record.lfbw) };
	/** The ranked primaries as the record mirrors them, rank 1 first. */
	const primaries = (): any[] =>
		Array.isArray(record?.lfbw?.primaries) ? record.lfbw.primaries : [];
	const rank1 = (): any => primaries()[0];
	const entryOf = (pubkey: unknown): any =>
		typeof pubkey === 'string'
			? primaries().find((e) => e.pubkey === pubkey)
			: undefined;
	const anySetupFailed = () => primaries().some((e) => e.setup === 'failed');
	let storedMnemonic: string | null = registry?.mnemonic ?? null;
	const recoveryImport = readRecoveryImport(registry?.recoveryImport);
	const importPending = () => recoveryImport.autoApply && !recoveryImport.complete;
	let receiveStore: ReceiveRequestStore | undefined;
	const receiveRequests = () => {
		if (!record) failure('NO_WALLET', 'Create or restore a wallet first', 404);
		return (receiveStore ??= new ReceiveRequestStore({
			walletId: record.id,
			network: record.network,
			load: () => load('/wallet/receive-requests.json', null),
			save: (value) => save('/wallet/receive-requests.json', value)
		}));
	};
	let node: BeignetNode | undefined;
	let appBackgrounded = false;
	let activeWatchdog: ReturnType<typeof reestablishWatchdog> | undefined;
	let offlineReceive: OfflineReceive | undefined;
	let receiveTimer: any;
	let closed = false,
		busy = false;
	let timer: any;
	const pendingTimers = new Set<any>();
	const inFlight = new Set<Promise<any>>();
	let closing: Promise<void> | undefined;
	let released = false;
	let activity: any[] = load('/wallet/activity.json', []);
	let startPromise: Promise<any> | undefined;
	let stopPromise: Promise<any> | undefined;
	// A stop or close releases requests waiting for graph restore or primary transport.
	const stopWaits = new Set<() => void>();
	const endWaits = () => {
		activeWatchdog?.close();
		activeWatchdog = undefined;
		for (const end of stopWaits) end();
		stopWaits.clear();
	};
	const waitWhileRunning = async (work: Promise<unknown>) => {
		let end!: () => void;
		const ended = new Promise<void>((resolve) => { end = resolve; });
		stopWaits.add(end);
		try {
			await Promise.race([work, ended]);
		} finally {
			stopWaits.delete(end);
		}
	};
	let drainGeneration = 0;
	// The home channel's last splice conflict or revert (beignet #760), and
	// whether a payer this wallet has not paired with is growing the channel
	// right now. Both narrate the wallet's notes and die with the runtime, as
	// they do in the host manager.
	let lastSplice: {
		state: 'conflicted' | 'reverted';
		spliceTxid: string | null;
		conflictTxid: string | null;
		at: number;
	} | null = null;
	let unpairedFunding: { at: number } | null = null;
	// The last direct-funding offer this wallet answered, so the owner can see
	// why a Beignet payer was sent back to a plain address payment. Dies with
	// the runtime, like the two records above.
	let lastOffer: {
		state: 'accepted' | 'declined' | 'failed' | 'completed';
		reason: string | null;
		at: number;
	} | null = null;
	// Channelize backoff after a failed pass, and a hold while this wallet is
	// itself paying a direct funding, so the two never contend for one coin.
	let channelizeRetryAt = 0;
	let directFundingInFlight = 0;
	// Boot timings (phase engine-perf) for the client's diagnostic hook;
	// nothing is timed or listened to without one.
	const enginePerf = engineDiagnostics({ onDiagnostic: options.onDiagnostic });
	const persist = () =>
		save('/wallet/registry.json', { record, mnemonic: storedMnemonic, recoveryImport });
	if (migratedRecord) {
		try {
			persist();
		} catch {
			// save() fenced the runtime; the migrated record stays in memory.
		}
	}
	const channelizeHold = channelizePause({
		read: () => record?.channelizePause,
		write: (value) => {
			const previous = record.channelizePause;
			record.channelizePause = value;
			try { persist(); } catch (error) {
				record.channelizePause = previous;
				throw error;
			}
		},
		busy: () => busy,
		failure
	});
	const recoveryHold = () => node ? recoveryRefusal(node, importPending()) : null;
	const requireRecoveryReady = () => {
		const held = recoveryHold();
		if (held) failure(held.code, held.message, 503);
	};
	const nodeUnavailable = () => !!node && (
		node.resuming || node.restorePending || node.restartRequired
	);
	const healthy = () => !!node && !nodeUnavailable() && node.getHealth().electrumConnected;
	const drain = drainCoordinator({
		lifecycle: () => drainGeneration,
		operational: () => !closed && !stopPromise,
		read: () => load('/wallet/drains.json', null),
		write: (value: any) => save('/wallet/drains.json', value),
		node: () => node,
		primaries: () => primaries().map((e: any) => e.pubkey),
		ready: () => {
			requireRecoveryReady();
			if (closed || stopPromise || durabilityFailed || !healthy())
				failure('DRAIN_UNAVAILABLE', 'Wait for the wallet to reconnect and finish syncing', 409);
		},
		busy: () => {
			const engine = node?.getNode();
			const requests = engine?.getDirectFundingRequests();
			return busy || !!setupRunning || directFundingInFlight > 0 ||
				mutations.pending() > 0 ||
				(engine?.getDirectFundingReceiver()?.inflightCount() ?? 0) > 0 ||
				(requests?.activeFundings().length ?? 0) > 0 ||
				(requests?.lapsedFundings().length ?? 0) > 0;
		},
		activityPending: () => activity.some((row) => ['pending', 'uncertain'].includes(row.status)),
		offline: () => offlineReceive?.status() ?? {},
		pause: channelizeHold,
		// The durable journal is the receive admission fence. Keeping policy
		// intact lets existing offers and protocol obligations finish normally.
		disableReceive: async () => {},
		restoreReceive: async () => {},
		closeNotStarted: (channelId: string) => {
			try {
				const id = Buffer.from(channelId, 'hex');
				const manager = node?.getNode().getChannelManager();
				return closeNotStarted({
					channelId,
					live: manager?.getChannel(id)?.getFullState(),
					saved: node?.getStorage().loadChannel(channelId)?.state,
					monitor: manager?.getMonitor(id)?.getFullState(),
					held: durabilityFailed || !!recoveryHold()
				});
			} catch { return false; }
		},
		observe: async (payout: any, row: any) => {
			const seen = await verifySubmission(
				options.socketFactory, options.electrum ?? record.electrum,
				{ address: row.address, amountSats: payout.valueSats,
					previousFundingTxid: row.fundingTxid,
					previousFundingOutputIndex: row.fundingOutputIndex },
				payout.txid, record.network
			);
			const height = seen?.height ?? 0;
			return { exists: seen?.matched === true, height,
				depth: height > 0 ? Math.max(0, (node?.getNode().getCurrentBlockHeight() ?? 0) - height + 1) : 0 };
		},
		sweepDepth: (txid: string) => {
			const tx = node?.getWallet().transactions[txid];
			return tx?.height && tx.height > 0 && tx.exists !== false
				? Math.max(0, (node?.getNode().getCurrentBlockHeight() ?? 0) - tx.height + 1) : 0;
		},
		failure
	});
	const mutations = drainFence({ active: () => drain.blocksWallet(), failure });
	// Validate saved intent before any network starts. Corrupt intent must not
	// silently enable funding on a wallet that may still be draining.
	drain.blocksWallet();
	configure(options);
	let drainSync: Promise<any> | undefined;
	const syncDrain = () => {
		if (!node || closed || stopPromise || durabilityFailed || recoveryHold()) return Promise.resolve(null);
		if (!drainSync) {
			drainSync = drain.sync().finally(() => { drainSync = undefined; });
		}
		return drainSync;
	};
	const drainActivity = () => drain.list()
		.filter((row: any) => row.phase !== 'review' && (row.phase !== 'cancelled' || row.startedAt !== undefined))
		.map((row: any) => ({
			id: `drain:${row.requestId}`, requestId: row.requestId, type: 'send', method: 'drain',
			status: row.phase === 'completed' ? 'completed' : row.phase === 'cancelled' ? 'failed' : 'pending',
			title: row.phase === 'completed' ? 'Wallet emptied' : row.phase === 'cancelled' ? 'Wallet drain cancelled' : 'Emptying wallet',
			address: row.address, amountSats: row.amountSats, feeSats: row.feeSats,
			debitSats: row.debitSats, reviewedDebitSats: row.reviewedDebitSats,
			feeEstimated: row.feeEstimated, txids: row.txids,
			txid: row.txids[0] ?? null, reference: row.requestId, drain: row,
			timestamp: row.createdAt, description: row.phase === 'completed'
				? 'Reviewed funds sent to the destination.'
				: row.error ?? 'Closing the home channel and sending the reviewed loose coins.',
			residualSats: row.residualSats
		}));
	const completeRecoveryImport = () => {
		if (!importPending()) return;
		recoveryImport.complete = true;
		persist();
	};
	/**
	 * Whether a primary settles offline receives, as it last answered the
	 * probe: true, false with the refusal, or null before an answer (the
	 * wallet is stopped, the primary has not connected yet, or it was just
	 * added). GET /api/config's offlineReceiveAvailable says the engine
	 * implements the feature; this pair says whether the primary serves it,
	 * which is what the receive screen needs before offering it. Named for no
	 * pubkey, it speaks for the receive target: the primary a receive that
	 * names no peer goes to.
	 */
	const availabilityOf = (pubkey: unknown) => {
		const state =
			offlineReceive && typeof pubkey === 'string'
				? offlineReceive.availability(pubkey)
				: { available: null, reason: null };
		return {
			offlineReceiveAvailable: state.available,
			offlineReceiveReason: state.reason
		};
	};
	const offlineReceiveAvailability = () =>
		availabilityOf(receiveTargetEntry()?.pubkey);
	/** The engine's ranked list, or null while there is no node to ask. */
	const enginePrimaries = (): any | null => {
		if (!node) return null;
		try {
			return node.listPrimaries();
		} catch {
			return null;
		}
	};
	/**
	 * The entry a receive that names no peer goes to: the engine's receive
	 * target (rank order, then the lowest balance once every primary is at
	 * its fill threshold), else rank 1 while the engine is not running.
	 */
	const receiveTargetEntry = (): any =>
		entryOf(enginePrimaries()?.receiveTarget) ?? rank1();
	const publicRecord = () => {
		if (!record) return null;
		const policy = enginePrimaries();
		const figures = new Map<string, any>(
			((policy?.primaries ?? []) as any[]).map((p) => [p.pubkey, p])
		);
		let channels: any[] = [];
		try {
			channels = node && !nodeUnavailable() ? node.listChannels() : [];
		} catch {
			channels = [];
		}
		const retained = rules.retainedPeers(primaries(), channels);
		return clone({
			...record,
			lfbw: {
				...record.lfbw,
				// Each ranked primary with what the runtime and the engine know
				// of it now: connected, its offline-receive answer, and the
				// engine's balance, channel count and place in the receive order.
				primaries: primaries().map((entry) => {
					const f = figures.get(entry.pubkey);
					return {
						...entry,
						connected: peerConnected(entry.pubkey),
						...availabilityOf(entry.pubkey),
						...(f
							? {
									balanceSat: f.balanceSat,
									channelCount: f.channelCount,
									belowThreshold: f.belowThreshold,
									isReceiveTarget: f.isReceiveTarget,
									selectionOrder: f.selectionOrder
							  }
							: {})
					};
				}),
				...(policy ? { primariesThresholdSat: policy.fillThresholdSat } : {}),
				receiveTarget: policy?.receiveTarget ?? rank1()?.pubkey ?? null,
				// Channels at peers that are not ranked primaries any more: their
				// balance stays in the total and must stay visible. The shape
				// older readers knew is derived from them, never stored.
				retainedPeers: retained,
				previousPrimary: rules.derivedPreviousPrimary(retained),
				lastChannelize: record.lfbwLast ?? null,
				lastSplice,
				unpairedFunding,
				lastOffer,
				...offlineReceiveAvailability()
			},
			status: node ? 'running' : 'stopped',
			healthy: healthy(),
			runtime: {
				status: node ? 'running' : 'stopped',
				healthy: healthy(),
				lfbwLast: record.lfbwLast ?? null
			}
		});
	};
	/** A stored entry's address as the engine dials it, with its relay address for direct funding. */
	const parsedPrimary = (entry: any) => {
		const p = rules.parseNodeUri(entry.uri);
		const fallback = parsePrimaryFallback(p, entry.fallbackUri);
		return {
			...p,
			connectHost: p.host,
			connectPort: p.port,
			...(fallback
				? {
						transport: {
							...p.transport,
							fallbackOnion: { host: fallback.host, port: fallback.port }
						}
				  }
				: {}),
			relayHost: fallback?.host ?? p.host,
			relayPort: fallback?.port ?? p.port
		};
	};
	/** Rank 1: the direct-funding policy's liquidity peer, the path a request the list cannot bind falls back to. */
	const primary = () => parsedPrimary(rank1());
	const registeredPeer = (pubkey: unknown) =>
		typeof pubkey === 'string' && node && !nodeUnavailable()
			? node.listPeers().find((peer) => peer.pubkey === pubkey)
			: undefined;
	const peerConnected = (pubkey: unknown) => {
		const state = registeredPeer(pubkey)?.state;
		return state === 'connected' || state === 'ready';
	};
	/** Join a pending dial when the manager has already removed the lost peer. */
	const redialing = new Set<string>();
	const redialPrimary = async (entry: any, opts: { force?: boolean } = {}) => {
		if (!entry || redialing.has(entry.pubkey) || closed || !node) return;
		if (entry.setup !== 'ready') return;
		if (recoveryHold()) return;
		if (!opts.force && peerConnected(entry.pubkey)) return;
		redialing.add(entry.pubkey);
		try {
			const p = parsedPrimary(entry);
			// A stale registered entry makes connectPeer return immediately.
			// With no entry, disconnectPeer would abort a viable pending dial.
			if (registeredPeer(p.pubkey)) {
				try {
					node.disconnectPeer(p.pubkey);
				} catch {}
			}
			await node.connectPeer(p.pubkey, p.host, p.port, p.transport);
			options.onDiagnostic?.({
				phase: 'primary-redial',
				message: 'reconnected'
			});
			await channelize();
		} catch (error: any) {
			options.onDiagnostic?.({
				phase: 'primary-redial',
				message: String(error?.message ?? error)
			});
		} finally {
			redialing.delete(entry.pubkey);
		}
	};
	/** Every ready primary that is not connected, dialled again. */
	const redialPrimaries = () =>
		Promise.all(
			primaries()
				.filter((e) => e.setup === 'ready' && !peerConnected(e.pubkey))
				.map((e) => redialPrimary(e))
		);
	/**
	 * Ask a primary whether it settles offline receives, off the connect
	 * path: the connect handler runs inside the peer manager's bring-up, and
	 * the answer only informs the receive screen. The coordinator bounds the
	 * ask like a review's quote and keeps the answer per peer, so a primary
	 * that was just added is asked afresh on its first connection. Named for
	 * no pubkey, every connected primary that has not answered yet is asked.
	 */
	const probeOfflineReceive = (pubkey?: string) => {
		const pending = setTimeout(() => {
			pendingTimers.delete(pending);
			if (closed || !node || !offlineReceive || recoveryHold()) return;
			const asked =
				pubkey !== undefined
					? [pubkey]
					: primaries()
							.map((e) => e.pubkey)
							.filter(
								(pk) => offlineReceive!.availability(pk).available === null
							);
			for (const pk of asked) {
				if (!peerConnected(pk)) continue;
				void offlineReceive.probe(pk).catch(() => {});
			}
		}, 0);
		pendingTimers.add(pending);
	};
	let setupRunning: Promise<void> | undefined;
	/**
	 * A primary that did not answer at start (Tor still bootstrapping, a relay
	 * not yet up) used to wait for the next poll, a minute away, before the
	 * wallet tried again. Try again on a short backoff first; the poll stays
	 * the long-run retry, and close() clears whatever is pending.
	 */
	const SETUP_RETRY_MS = [5000, 15000, 30000];
	const retrySetupSoon = (attempt = 0) => {
		if (closed || attempt >= SETUP_RETRY_MS.length) return;
		const pending = setTimeout(() => {
			pendingTimers.delete(pending);
			if (closed || !node || !record || !anySetupFailed()) return;
			if (recoveryHold()) return;
			if (startPromise) return;
			void setup().then(async () => {
				if (closed) return;
				if (!anySetupFailed()) await channelize();
				else retrySetupSoon(attempt + 1);
			});
		}, SETUP_RETRY_MS[attempt]);
		pendingTimers.add(pending);
	};
	const setup = async (onReady?: () => void) => {
		if (!node || !record || closed || stopPromise) return;
		if (setupRunning) return setupRunning;
		setupRunning = runSetup(onReady);
		try {
			await setupRunning;
		} finally {
			setupRunning = undefined;
		}
	};
	const reportPolicyError = (error: any) => options.onDiagnostic?.({
		phase: 'primary-connect', message: error.message, stack: error.cause?.stack ?? error.stack
	});
	const configureFundingPrimary = (owner: BeignetNode, entry: any) => {
		try {
			owner.configureDirectFunding(rules.directFundingConfig(record.lfbw, parsedPrimary(entry)));
		} catch (error) {
			reportPolicyError(error);
		}
	};
	const configurePrimaryTrust = (owner: BeignetNode, entry: any, pubkey: string) => {
		if (entry.trusted !== false) owner.addTrustedPeer(pubkey);
		else owner.removeTrustedPeer(pubkey);
	};
	const setupAfterRestore = async (owner: BeignetNode) => {
		if (closed || stopPromise || durabilityFailed || node !== owner || recoveryHold()) return;
		if (!setupRunning) return setup();
		// Recovery rebuilt the node while a setup pass was still dialling.
		// Install policy on the restored node now and leave those dials alone.
		const entries = primaries();
		if (entries.length) configureFundingPrimary(owner, entries[0]);
		for (const entry of entries) {
			try {
				configurePrimaryTrust(owner, entry, parsedPrimary(entry).pubkey);
			} catch (error) {
				reportPolicyError(error);
			}
		}
	};
	const runSetup = async (onReady?: () => void) => {
		if (!node || !record) return;
		const owner = node;
		const held = recoveryHold();
		// The initial recovery connection retrieves storage only. Leave direct
		// funding disabled until the existing channel state has been installed.
		if (held && (held.code !== 'NODE_RESTORE_PENDING' || nodeUnavailable())) return;
		const entries = primaries();
		for (const entry of entries) entry.setup = 'pending';
		record.lfbw.setup = 'pending';
		persist();
		if (entries.length === 0) {
			record.lfbw.setup = 'failed';
			record.lfbw.setupError = 'No primary node is configured';
			persist();
			return;
		}
		// The policy names the liquidity peer every offer is negotiated with
		// and signs its address into every request: the first-ranked primary,
		// which is also where a request the ranked list could not bind falls
		// back to (the engine binds each request to the primary it steers to,
		// beignet #1935). It goes on before any connection is attempted: a
		// primary that is down at start used to leave the policy unset, every
		// offer declined with "no liquidity peer", and every request minted
		// with no way to reach this wallet, until the next restart.
		if (!held) configureFundingPrimary(owner, entries[0]);
		// Every primary is trusted (or not) and dialled, each on its own: one
		// that is down marks only its own entry failed, and the list is ready
		// as soon as any of them answers.
		await Promise.all(entries.map(async (entry) => {
			await setupEntry(entry, held);
			if (onReady && entries.length > 1 && !closed && !stopPromise && node === owner &&
				!held && !recoveryHold() &&
				entryOf(entry.pubkey)?.setup === 'ready' && peerConnected(entry.pubkey)) {
				if (record.lfbw.setup !== 'ready') {
					Object.assign(record.lfbw, rules.aggregateSetup(primaries()));
					persist();
				}
				onReady();
				onReady = undefined;
			}
		}));
		if (closed || stopPromise || node !== owner) return;
		Object.assign(record.lfbw, rules.aggregateSetup(primaries()));
		persist();
	};
	const setupEntry = async (entry: any, held: any) => {
		const owner = node;
		if (!owner || closed || stopPromise) return;
		// An edit can reorder, remove or replace an entry during a slow dial.
		const currentEntry = () => {
			const current = entryOf(entry.pubkey);
			return !closed && !stopPromise && node === owner && current?.uri === entry.uri
				? current : undefined;
		};
		try {
			const p = parsedPrimary(entry);
			if (!held) configurePrimaryTrust(owner, entry, p.pubkey);
			try {
				if (options.preparePrimaryDial) {
					await waitWhileRunning(options.preparePrimaryDial(p.host));
					if (!currentEntry()) return;
					if (!held && recoveryHold()) return;
				}
				await waitWhileRunning(owner.connectPeer(p.pubkey, p.host, p.port, p.transport));
			} catch (error) {
				if (!currentEntry() || nodeUnavailable()) return;
				if (
					!owner
						.listPeers()
						.some(
							(peer) => peer.pubkey === p.pubkey && peer.state === 'connected'
						)
				)
					throw error;
			}
			entry = currentEntry();
			if (!entry) return;
			entry.setup = 'ready';
			entry.setupError = null;
			entry.setupAt = Date.now();
		} catch (error: any) {
			entry = currentEntry();
			if (!entry) return;
			options.onDiagnostic?.({
				phase: 'primary-connect',
				message:
					primaries().length > 1
						? `${error.message} (primary ${String(entry.pubkey).slice(0, 16)})`
						: error.message,
				stack: error.cause?.stack ?? error.stack
			});
			entry.setup = 'failed';
			entry.setupError = error.message;
		}
	};
	/**
	 * Make the engine's ranked list and the record's mirror agree
	 * (coreyphillips/beignet#1924). The record is the authority while it is
	 * marked unsynced (a legacy record read as a list, a wallet created or
	 * edited while stopped, a write the engine could not persist): its entries
	 * are written to the engine, removes first, then adds, one reorder and
	 * the threshold. Otherwise the engine is the authority and the mirror is
	 * refreshed from it, carrying each node's trust, setup and fallback over.
	 * Never throws: an add the engine refuses as malformed drops that entry
	 * with a diagnostic, and a write it cannot persist leaves the record
	 * unsynced so the poll tries again.
	 */
	const convergePrimaries = () => {
		if (!node || !record?.lfbw?.enabled) return;
		let policy: any;
		try {
			policy = node.listPrimaries();
		} catch (error: any) {
			options.onDiagnostic?.({
				phase: 'primaries-sync',
				message: String(error?.message ?? error)
			});
			return;
		}
		if (record.lfbw.primariesSyncedAt == null) {
			let failed = false;
			const ops = planPrimariesSync(
				policy,
				primaries(),
				record.lfbw.primariesThresholdSat ?? null
			);
			for (const op of ops) {
				try {
					if (op.op === 'remove') node.removePrimary(op.pubkey);
					else if (op.op === 'add') node.addPrimary(entryToEngine(op.entry));
					else if (op.op === 'reorder') node.reorderPrimaries(op.order);
					else node.setPrimariesFillThreshold(op.fillThresholdSat);
				} catch (error: any) {
					options.onDiagnostic?.({
						phase: 'primaries-sync',
						message: `${op.op}: ${String(error?.message ?? error)}`
					});
					if (error?.code !== 'INVALID_PARAMS') {
						failed = true;
					} else if (op.op === 'add') {
						// A node the engine will not list (an address it cannot
						// read, its cap) cannot be kept as a primary here either.
						let listed = false;
						try {
							listed = node
								.listPrimaries()
								.primaries.some((p: any) => p.pubkey === op.entry.pubkey);
						} catch {}
						if (!listed)
							record.lfbw.primaries = primaries().filter(
								(e) => e.pubkey !== op.entry.pubkey
							);
					}
				}
			}
			try {
				policy = node.listPrimaries();
			} catch {
				failed = true;
			}
			if (!failed) {
				mirrorFromEngine(policy);
				record.lfbw.primariesSyncedAt = Date.now();
			}
		} else {
			mirrorFromEngine(policy);
		}
		persist();
	};
	/** The record's mirror from the engine's list, rank 1's fields under the scalar names. */
	const mirrorFromEngine = (policy: any) => {
		const next = engineToEntries(policy, primaries());
		record.lfbw = {
			...record.lfbw,
			primaries: next,
			primariesThresholdSat: policy.fillThresholdSat ?? null,
			...rules.primariesMirror(next)
		};
	};
	const SINGLE_PEER_RELAY =
		'The relay reaches one primary node. Switch to Native networking to add another.';
	/**
	 * The runtime's own checks on a policy write, before the engine is
	 * touched: an added address must be one this transport can dial (the
	 * engine admits peer URI forms the phone has no transport for), an Iroh
	 * primary needs the host's Iroh, an onion fallback must name the same
	 * node, and a relay that reaches one fixed upstream peer reaches one
	 * primary (coreyphillips/beignet#1924).
	 */
	const beforePrimariesWrite = (kind: string, body: any) => {
		if (kind !== 'add') return;
		if (typeof body?.pubkey !== 'string')
			failure('INVALID_PARAMS', 'pubkey required');
		const uri =
			typeof body.uri === 'string'
				? body.uri
				: `${body.pubkey}@${body.host}:${body.port}`;
		let parsed: any;
		try {
			parsed = rules.parseNodeUri(uri);
			parsePrimaryFallback(parsed, body.fallbackUri);
		} catch (error: any) {
			failure('BAD_LFBW_PEER', error.message);
		}
		if (parsed.transport?.type === 'iroh' && !options.iroh)
			failure('IROH_UNSUPPORTED', 'This host does not support Iroh.');
		if (
			options.socketFactory?.fixedUpstream === true &&
			primaries().some((e) => e.pubkey !== parsed.pubkey)
		)
			failure('TRANSPORT_SINGLE_PEER', SINGLE_PEER_RELAY, 409);
	};
	/**
	 * After the engine wrote: mirror its list onto the record (with the
	 * fallback and trust an add named), set a new primary up, re-arm the
	 * direct-funding policy when rank 1 changed, and restart the engine when
	 * the list gained or lost its first Iroh primary, as a primary edit does.
	 */
	const afterPrimariesWrite = async (info: any, { kind, body }: any) => {
		const before = primaries();
		const beforeRank1 = before[0]?.pubkey;
		const beforeIroh = anyIroh(before);
		mirrorFromEngine(info);
		const addedKey =
			kind === 'add' ? String(body.pubkey).toLowerCase() : undefined;
		if (addedKey !== undefined) {
			const added = entryOf(addedKey);
			if (added) {
				if (typeof body.fallbackUri === 'string' && body.fallbackUri.trim()) {
					try {
						added.fallbackUri = parsePrimaryFallback(
							rules.parseNodeUri(added.uri),
							body.fallbackUri
						)?.uri;
					} catch {}
				}
				if (body.trusted !== undefined) added.trusted = !!body.trusted;
			}
		}
		Object.assign(record.lfbw, rules.primariesMirror(primaries()));
		record.lfbw.primariesSyncedAt = Date.now();
		persist();
		const after = primaries();
		if (anyIroh(after) !== beforeIroh) {
			await stop();
			await start();
			return;
		}
		if (!node) return;
		if (addedKey !== undefined) {
			const added = entryOf(addedKey);
			if (added) {
				await setupEntry(added, recoveryHold());
				if (closed || stopPromise || !node) return;
				Object.assign(record.lfbw, rules.aggregateSetup(primaries()));
				persist();
				probeOfflineReceive(added.pubkey);
			}
		}
		if (after[0] && after[0].pubkey !== beforeRank1 && !recoveryHold()) {
			configureFundingPrimary(node, after[0]);
		}
	};
	const channelize = async (force = false) => {
		if (
			closed ||
			durabilityFailed ||
			!node ||
			recoveryHold() ||
			channelizeHold.status().paused ||
			drain.blocksWallet() ||
			busy ||
			directFundingInFlight > 0
		)
			return null;
		// Funds move toward the primary a receive would go to, once that
		// primary is set up; a target that is not answering waits.
		const toward = receiveTargetEntry();
		if (!toward || toward.setup !== 'ready') return null;
		busy = true;
		try {
			const { last, retryAt } = await runChannelize({
				node,
				excludeChannelIds: offlineReceive?.reservedIds(),
				record,
				primary: () => parsedPrimary(toward),
				toward: { pubkey: toward.pubkey, trusted: toward.trusted !== false },
				rules,
				force,
				retryAt: channelizeRetryAt,
				mayMutate: () => !closed && !durabilityFailed && !recoveryHold() && !channelizeHold.status().paused && !drain.blocksWallet(),
				onDiagnostic: options.onDiagnostic
			});
			if (closed) return null;
			channelizeRetryAt = retryAt;
			if (last) {
				record.lfbwLast = last;
				persist();
			}
			return record.lfbwLast ?? null;
		} finally {
			busy = false;
		}
	};
	const start = async () => {
		if (closed) failure('WALLET_CLOSED', 'Wallet runtime closed', 409);
		if (stopPromise) await stopPromise;
		if (closed) failure('WALLET_CLOSED', 'Wallet runtime closed', 409);
		if (node) return publicRecord();
		if (startPromise) return startPromise;
		startPromise = (async () => {
			const mnemonic = storedMnemonic;
			if (!record || !mnemonic)
				failure('NO_WALLET', 'Create or restore a wallet first', 404);
			const e = options.electrum ?? record.electrum;
			if (!e) failure('ELECTRUM_REQUIRED', 'Configure an Electrum transport');
			try {
				await verifyElectrumNetwork({
					network: record.network,
					electrum: e,
					socketFactory: options.socketFactory
				});
				if (closed) failure('WALLET_CLOSED', 'Wallet runtime closed', 409);
				record.electrum = e;
				persist();
				node = await enginePerf.time('create', () => BeignetNode.create({
					...options.nodeOptions,
					mnemonic,
					iroh: !!options.iroh && anyIroh(primaries()),
					irohFactory: options.iroh?.factory,
					irohRelays: options.iroh?.relays,
					irohDiscovery: options.iroh?.discovery,
					network: record.network,
					dataDir: '/wallet',
					allowMultipleInstances: true,
					electrumHost: e.host,
					electrumPort: e.port,
					electrumTls: e.tls,
					feeEstimationSource: 'electrum',
					autoBootstrap: false,
					autoGossipSync: true,
					// The stored network map comes back in slices after create,
					// so the app's only JavaScript thread is not held for seconds
					// as the wallet opens; route finding finishes it first.
					deferGraphRestore: true,
					recoveryMode: 'peer-storage',
					recoveryAutoApply: recoveryImport.autoApply,
					autoReconnect: true,
					forwardingEnabled: false,
					newChannelsRefused: () => drain.blocksWallet()
						? 'New funding is paused while this wallet is being emptied'
						: options.nodeOptions?.newChannelsRefused?.() ?? null,
					// Silent by default; a caller that wants the engine's own log
					// (a test harness, a debug build) supplies one.
					logger: options.nodeOptions?.logger ?? {
						debug() {},
						info() {},
						warn() {},
						error() {}
					},
					onError(error) {
						if (error.code === 'PERSISTENCE_ERROR') durabilityFailed = true;
					}
				}));
				if (appBackgrounded) node.getNode().getPeerManager()?.setAppBackgrounded(true);
				// How the stored network map came back inside create().
				enginePerf.graphRestored(node);
				// On mainnet create() starts the boot Rapid Gossip Sync in the
				// background; it reports when its download and import are done.
				enginePerf.watchGossip(node);
				// Native restore flags are durable before the swap finishes. They
				// cover a crash between installing channels and our completion event.
				if (importPending() && hasInstalledRecovery(node)) completeRecoveryImport();
				const recoveryNode = node;
				node.on('recovery:restored', () => {
					try {
						if (closed || node !== recoveryNode) return;
						completeRecoveryImport();
						if (stopPromise) return;
						if (appBackgrounded) recoveryNode.getNode().getPeerManager()?.setAppBackgrounded(true);
						// The native wrapper rebuilt its node and policy in process.
						const pending = setTimeout(() => {
							pendingTimers.delete(pending);
							void setupAfterRestore(recoveryNode).catch(() => {});
						}, 0);
						pendingTimers.add(pending);
					} catch {
						// persist() already fenced this runtime on a storage failure.
					}
				});
				// Engine errors and peer changes are the only way to see why a
				// peer went away or a funding did not broadcast; the client's
				// diagnostic hook gets them. Registered before the primary is
				// dialled, so the first connection is reported like every later
				// one. BeignetNode emits each as one object; a disconnect names
				// who closed it and why (peer-diagnostics.cjs). Since Beignet
				// 0.37.0 a peer's BOLT 1 warning and a refused forward arrive as
				// peer:warning and htlc:forward-refused instead of node:error.
				const peerKey = (first: any): string =>
					typeof first === 'string' ? first : String(first?.pubkey ?? '');
				for (const event of [
					'node:error',
					'peer:error',
					'peer:warning',
					'peer:connect',
					'peer:disconnect',
					'htlc:forward-refused'
				]) {
					node.on(event, (first: any, second: any) => {
						options.onDiagnostic?.(peerDiagnostic(event, first, second));
					});
				}
				// A broadcast the network refused is the one outcome a splice-out
				// row cannot learn from the chain. The engine names the
				// transaction, its channel and whether it still re-sends it on
				// every block (beignet #1062); the row carries that reason and
				// stays pending, never failed on the error alone (fork #7).
				watchBroadcastErrors({
					node,
					activity,
					save: () => save('/wallet/activity.json', activity)
				});
				const connectedNode = node;
				const watchdog = reestablishWatchdog({
					node,
					pendingTimers,
					canRedial: (pubkey: string) =>
						!closed && !stopPromise && node === connectedNode &&
						!recoveryHold() && peerConnected(pubkey),
					redial: (pubkey: string, message: string) => {
						options.onDiagnostic?.({ phase: 'primary-redial', message });
						void redialPrimary(entryOf(pubkey), { force: true });
					}
				});
				activeWatchdog = watchdog;
				watchdog.setAppBackgrounded(appBackgrounded);
				node.on('peer:disconnect', (peer: any) => watchdog.disconnected(peerKey(peer)));
				node.on('peer:connect', (first: any) => {
					if (closed || stopPromise || node !== connectedNode) return;
					const pubkey = peerKey(first);
					const entry = entryOf(pubkey);
					if (!entry) return;
					// A primary that connects is set up, whichever dial got it
					// there. The first dial of a node added while Tor was still
					// starting fails on the engine's fixed budget and marks the
					// entry failed; the engine's own redial then connects it, and
					// without this the record kept the stale failure under a
					// connected peer until a later setup pass.
					if (entry.setup !== 'ready' || entry.setupError) {
						entry.setup = 'ready';
						entry.setupError = null;
						entry.setupAt = Date.now();
						Object.assign(
							record.lfbw,
							rules.primariesMirror(primaries()),
							rules.aggregateSetup(primaries())
						);
						persist();
					}
					probeOfflineReceive(pubkey);
					watchdog.connected(pubkey);
				});
				// A transport error on a primary's connection is followed by a
				// redial after a short pause, rather than waiting for the poll.
				node.on('peer:error', (first: any) => {
					if (closed || stopPromise || node !== connectedNode) return;
					const pubkey = peerKey(first);
					if (!entryOf(pubkey)) return;
					const pending = setTimeout(() => {
						pendingTimers.delete(pending);
						void redialPrimary(entryOf(pubkey));
					}, 2000);
					pendingTimers.add(pending);
				});
				await enginePerf.time('initial-sync', () => node!.waitForInitialSync());
				if (!node.getHealth().electrumConnected)
					failure(
						'ELECTRUM_UNAVAILABLE',
						'The wallet could not connect to Electrum. Check its transport and retry setup.',
						503
					);
				record.nodeId = node.getInfo().nodeId;
				persist();
				offlineReceive = new OfflineReceive(
					node,
					(jobs) => save(`/wallet/offline-receive-${record.id}.json`, jobs),
					load(`/wallet/offline-receive-${record.id}.json`, [])
				);
				// The engine's list and the record's mirror agree before any
				// primary is dialled: a legacy record seeds the engine with its
				// one primary, a record edited while stopped is applied, and an
				// engine list the record never saw is taken as read.
				convergePrimaries();
				const setupNode = node;
				let ready!: () => void;
				const firstReady = new Promise<void>((resolve) => { ready = resolve; });
				// Finish startup after the first usable primary. The full setup keeps
				// running and owns the retry for any peer whose dial later fails.
				const allSettled = setup(ready).then(() => {
					if (!closed && !stopPromise && node === setupNode && anySetupFailed())
						retrySetupSoon();
				});
				await Promise.race([firstReady, allSettled]);
				if (closed || stopPromise) return publicRecord();
				// The engine's own reconnect can bring a primary up before the
				// coordinator exists, and setup() joins a dial already in flight,
				// so a primary that is connected but unasked by now is asked here.
				probeOfflineReceive();
				receiveTimer = setInterval(() => {
					if (!closed && !durabilityFailed && !recoveryHold()) void offlineReceive?.sync().catch(() => {});
					void syncDrain().catch(() => {});
				}, 2000);
				void syncDrain().catch(() => {});
				if (!recoveryHold()) void offlineReceive.sync().catch(() => {});
				lastSplice = null;
				unpairedFunding = null;
				lastOffer = null;
				channelizeRetryAt = 0;
				// A stranger's direct funding arrives as a splice that waits for
				// confirmations; a coin spent elsewhere first is reverted with the
				// primary. One record each, so the wallet can say what is going on.
				const offerState =
					(state: 'accepted' | 'declined' | 'failed' | 'completed') =>
					(data: any) => {
						lastOffer = {
							state,
							reason:
								typeof data?.reason === 'string'
									? data.reason.slice(0, 200)
									: null,
							at: Date.now()
						};
					};
				node.on('direct-funding:offer:accepted', (data: any) => {
					if (data && data.paired === false)
						unpairedFunding = { at: Date.now() };
					offerState('accepted')(data);
				});
				node.on('direct-funding:offer:declined', offerState('declined'));
				node.on('direct-funding:offer:failed', offerState('failed'));
				node.on('direct-funding:offer:completed', offerState('completed'));
				node.on('splice:conflicted', (data: any) => {
					lastSplice = {
						state: 'conflicted',
						spliceTxid: data?.spliceTxid ?? null,
						conflictTxid: data?.conflictTxid ?? null,
						at: Date.now()
					};
				});
				node.on('splice:reverted', (data: any) => {
					lastSplice = {
						state: 'reverted',
						spliceTxid: data?.spliceTxid ?? null,
						conflictTxid: data?.conflictTxid ?? null,
						at: Date.now()
					};
					unpairedFunding = null;
				});
				node.on('splice:aborted', () => {
					unpairedFunding = null;
				});
				node.on('splice:complete', () => {
					unpairedFunding = null;
					lastSplice = null;
				});
				// The poll is also where a failed setup tries again, so a primary
				// that was unreachable at start is picked up without a restart.
				timer = setInterval(() => {
					if (closed || !node) return;
					if (recoveryHold()) return;
					// A list the engine could not persist is written again.
					if (record.lfbw.primariesSyncedAt == null && primaries().length > 0)
						convergePrimaries();
					if (anySetupFailed() && !startPromise) {
						void setup().then(() => channelize());
						return;
					}
					// A phone that has lost a primary has lost receiving through it,
					// direct funding and every move toward it; the engine's own
					// reconnect does not cover a peer it dropped for a transport
					// error, so the poll dials again. connectPeer is idempotent for
					// a live connection. Funds keep moving while the primary they
					// move toward is up.
					const lost = primaries().filter(
						(e) => e.setup === 'ready' && !peerConnected(e.pubkey)
					);
					if (lost.length > 0) {
						void redialPrimaries();
						if (lost.some((e) => e.pubkey === receiveTargetEntry()?.pubkey))
							return;
					}
					void channelize();
				}, rules.CHANNELIZE_POLL_MS);
				for (const event of rules.CHANNELIZE_EVENTS)
					node.on(event, () => {
						const pending = setTimeout(() => {
							pendingTimers.delete(pending);
							void channelize();
						}, rules.CHANNELIZE_DEBOUNCE_MS);
						pendingTimers.add(pending);
					});
				return publicRecord();
			} catch (error) {
				if (receiveTimer) clearInterval(receiveTimer);
				offlineReceive?.stop();
				// Cleared before the destroy, so no request waiting for the
				// network map resumes onto the node being torn down.
				const old = node;
				node = undefined;
				endWaits();
				if (old) await old.destroy().catch(() => {});
				throw error;
			}
		})();
		try {
			return await startPromise;
		} finally {
			startPromise = undefined;
		}
	};
	const stop = async () => {
		if (stopPromise) return stopPromise;
		drainGeneration++;
		endWaits();
		stopPromise = (async () => {
			const deadline = Date.now() + STOP_DEADLINE_MS;
			// A start in flight may be waiting on a cold Tor bootstrap, which is
			// bounded in minutes rather than seconds. Waiting it out is right;
			// waiting for it without a limit is how a close never returns and the
			// caller keeps the wallet's storage lease forever.
			if (startPromise)
				await Promise.race([
					startPromise.catch(() => {}),
					sleep(STOP_DEADLINE_MS)
				]);
			clearInterval(timer);
			clearInterval(receiveTimer);
			if (drainSync) await Promise.race([drainSync.catch(() => {}), sleep(STOP_DEADLINE_MS)]);
			offlineReceive?.stop();
			for (const pending of pendingTimers) clearTimeout(pending);
			pendingTimers.clear();
			while (busy && Date.now() < deadline) await sleep(20);
			if (node) {
				const old = node;
				// A graceful shutdown talks to a peer and to Electrum, either of
				// which may be gone. Falling back to destroy keeps the close
				// bounded rather than leaving the node half stopped.
				await old
					.gracefulShutdown(5000)
					.catch(() => old.destroy().catch(() => {}));
				node = undefined;
			}
			return publicRecord();
		})();
		try {
			return await stopPromise;
		} finally {
			stopPromise = undefined;
		}
	};
	const durableInvoice = (value: any) => {
		if (
			!node
				?.getStorage()
				.loadAllInvoices()
				.some((row) => row.paymentHashHex === value.paymentHash)
		) {
			durabilityFailed = true;
			failure(
				'DURABILITY_FAILED',
				'Invoice state did not reach durable storage. Close and reopen the wallet.',
				503
			);
		}
		return value;
	};
	let reconciling = false;
	/**
	 * What the chain says about each channel's funding transaction.
	 *
	 * Answered from cache so the ordinary channel poll stays a local read; a
	 * stale or missing entry refreshes in the background. A confirmed funding
	 * never needs asking again.
	 */
	const fundingSeen = new Map<string, boolean>();
	const fundingAsked = new Map<string, number>();
	// A confirmed funding is cached for good. Recheck an unconfirmed one often
	// so the wallet's funding status follows the chain as confirmations arrive.
	const FUNDING_RECHECK_MS = 5000;
	const refreshFunding = (txid: string, outputIndex: number) => {
		if (fundingSeen.get(txid)) return;
		const asked = fundingAsked.get(txid) ?? 0;
		if (Date.now() - asked < FUNDING_RECHECK_MS) return;
		fundingAsked.set(txid, Date.now());
		fundingConfirmed(
			options.socketFactory,
			options.electrum ?? record?.electrum,
			txid,
			outputIndex
		)
			.then((value) => {
				if (value !== null) fundingSeen.set(txid, value);
			})
			.catch(() => {});
	};
	/** Channels, each annotated with what is known about its funding on chain. */
	const channelsWithFunding = (list: any[]) =>
		list.map((channel) => {
			if (offlineReceive?.reservedIds().has(channel.channelId) && channel.ffor?.concurrent !== true)
				channel = { ...channel, htlcUsable: false };
			if (typeof channel?.fundingTxid !== 'string') return channel;
			const index = channel.fundingOutputIndex ?? 0;
			refreshFunding(channel.fundingTxid, index);
			const known = fundingSeen.get(channel.fundingTxid);
			// Absent means not yet known, which is not the same as unconfirmed.
			return known === undefined
				? channel
				: { ...channel, fundingConfirmed: known };
		});

	/**
	 * The engine's payer state, read the way the umbrel app reads it: a witness
	 * that left is a payment out of our hands until the chain settles it, and
	 * only a pre-witness state or a refusal leaves nothing spent.
	 */
	const directFundingStatus = (status: string) =>
		status === 'CONFIRMED'
			? 'completed'
			: status === 'SIGNED_PENDING' || status === 'MEMPOOL_SEEN'
				? 'pending'
				: status === 'FAILED' ||
					  status === 'ABORTED' ||
					  status === 'CREATED' ||
					  status === 'OFFERED'
					? 'failed'
					: null;
	const reconcileActivity = async () => {
		if (!node || reconciling || durabilityFailed || recoveryHold()) return;
		reconciling = true;
		try {
			let changed = false;
			const channels = node.listChannels();
			let fundings: any[] | undefined;
			for (const row of activity) {
				if (!['pending', 'uncertain'].includes(row.status)) continue;
				if (row.method === 'direct-funding') {
					// A direct funding pays into the recipient's channel, so there
					// is no output at an address to look for. The engine keeps its
					// own durable record of the attempt; its state is the truth.
					fundings ??= node.listDirectFundingPayments();
					const rec = fundings.find((f) => f.offerId === row.offerId);
					if (!rec) continue;
					const next = directFundingStatus(rec.status);
					if (rec.fundingTxid && !row.txid) {
						row.txid = rec.fundingTxid;
						row.reference = rec.fundingTxid;
						changed = true;
					}
					if (next && next !== row.status) {
						row.status = next;
						row.statusNote =
							next === 'completed'
								? 'Direct funding confirmed.'
								: next === 'failed'
									? rec.reason || 'The direct funding did not complete.'
									: row.statusNote;
						changed = true;
					}
					continue;
				}
				// A splice-out: what the channel and the chain say about it, and
				// the reason the engine gave when the network refused it, are
				// read in portable/splice-status.cjs (fork issue #7).
				const channel = channels.find((c) => c.channelId === row.channelId);
				if (
					await reconcileSpliceRow({
						row,
						channel,
						verify: (candidate: string) =>
							verifySubmission(
								options.socketFactory,
								options.electrum ?? record.electrum,
								row,
								candidate,
								record.network
							)
					})
				)
					changed = true;
			}
			if (changed) save('/wallet/activity.json', activity);
		} finally {
			reconciling = false;
		}
	};

	const requireNode = () => {
		if (!node) failure('WALLET_STOPPED', 'Start your wallet first', 409);
		return node!;
	};
	async function daemon(method: string, path: string, body: any) {
		const url = new URL(path, 'https://wallet.local');
		const route = `${method} ${url.pathname}`;
		if (route === 'GET /mnemonic') {
			if (!storedMnemonic)
				failure('NO_WALLET', 'Create or restore a wallet first', 404);
			return { mnemonic: storedMnemonic };
		}
		if (route === 'GET /receive/requests')
			return { requests: receiveRequests().list() };
		const n = requireNode();
		if (route === 'GET /recovery/status')
			return {
				...n.getRecoverySurfaceStatus(),
				importPending: importPending(),
				importComplete: recoveryImport.complete
			};
		if (method !== 'GET' || nodeUnavailable()) requireRecoveryReady();
		// Finding a route needs the whole network map: while the deferred
		// restore of it runs, these wait for it instead of having the engine
		// finish it at once on the app's only thread.
		if (ROUTE_FINDING.has(route) && n.isGraphRestoring?.()) {
			// A stop already under way has ended the waits it found.
			if (stopPromise) failure('WALLET_STOPPED', 'Start your wallet first', 409);
			await waitWhileRunning(n.whenGraphRestored());
			// The wallet may have closed, stopped or been held for recovery
			// while this waited, and its node with it.
			if (closed) failure('WALLET_CLOSED', 'Wallet runtime closed', 409);
			if (stopPromise || node !== n)
				failure('WALLET_STOPPED', 'Start your wallet first', 409);
			requireRecoveryReady();
		}
		if (route === 'POST /receive/requests')
			return {
				request: await receiveRequests().register(
					{
						...body?.request,
						offlineReceive:
							offlineReceive?.ownsInvoice(body?.request?.paymentHash) === true
					},
					{
						getInvoice: (hash) => n.getInvoice(hash),
						ownsAddress: (_address, scriptHash) =>
							!!n.getWallet().getAddressFromScriptHash(scriptHash)
					}
				)
			};
		const b = body ?? {};
		const q = url.searchParams;
		const sendRoute = sendRoutes({ node: n, channelsWithFunding, failure })[route];
		if (sendRoute) return sendRoute(b, q);
		const primariesRoute = primariesRoutes({
			node: n,
			failure,
			beforeWrite: beforePrimariesWrite,
			onWrite: afterPrimariesWrite
		})[route];
		if (primariesRoute) return primariesRoute(b, q);
		switch (route) {
			case 'POST /drain/quote':
				return drain.quote(b);
			case 'POST /drain/send':
				return drain.send(b.requestId);
			case 'POST /drain/cancel':
				return drain.cancel(b.requestId);
			case 'GET /drain':
				await syncDrain();
				return q.has('requestId') ? drain.get(q.get('requestId')) : drain.list();
			case 'GET /channelize/status':
				return channelizeHold.status();
			case 'POST /channelize/pause':
				return channelizeHold.set(b);
			case 'GET /info':
				return n.getInfo();
			case 'GET /health':
				return n.getHealth();
			case 'GET /balance':
				return n.getBalance();
			case 'GET /peers':
				return n.listPeers();
			case 'GET /invoices':
				return n.listInvoices();
			case 'GET /receive/offline': {
				// Capacity is the channel's side of the answer; whether the primary
				// settles at all is the probed side, repeated here beside it. The
				// legacy keys speak for the receive target (or the one primary
				// named by ?peer=); `peers` says the same for every ranked
				// primary, in the order a receive tries them.
				const target = q.get('peer') || receiveTargetEntry()?.pubkey;
				const probed = availabilityOf(target);
				const forPeer = (pubkey: unknown) =>
					offlineReceive && typeof pubkey === 'string'
						? {
								...offlineReceive.capacity(pubkey),
								...offlineReceive.availability(pubkey)
						  }
						: { maxSats: 0 };
				const order: string[] = ((enginePrimaries()?.primaries ?? []) as any[])
					.slice()
					.sort((a, b) => a.selectionOrder - b.selectionOrder)
					.map((p) => p.pubkey);
				return {
					...forPeer(target),
					...offlineReceive?.status(),
					available: probed.offlineReceiveAvailable,
					reason: probed.offlineReceiveReason,
					peers: (order.length > 0 ? order : primaries().map((e) => e.pubkey)).map(
						(pubkey) => ({ pubkey, ...forPeer(pubkey) })
					)
				};
			}
			case 'GET /receive/quote':
				// A named peer is quoted as before; with none the coordinator
				// steers through the engine's ranked list, and while that list is
				// empty (a seed the engine has not taken yet) rank 1 serves.
				return offlineReceive!.quote(
					q.get('peer') ||
						(enginePrimaries()?.primaries?.length > 0
							? undefined
							: rank1()?.pubkey),
					Number(q.get('amountSats')),
					q.get('requestId') ?? undefined
				);
			case 'POST /receive/invoice':
				return durableInvoice(
					await offlineReceive!.create(
						b,
						b.peer ?? b.quote?.peer ?? rank1()?.pubkey
					)
				);
			case 'GET /ffor/epochs':
				return n.fforEpochs('R');
			case 'GET /ffor/epoch':
				return n.fforEpoch(q.get('channelId') ?? '');
			case 'POST /ffor/epoch/start':
				return n.fforStartEpoch(b);
			case 'POST /ffor/invoice':
				return durableInvoice(n.fforCreateInvoice(b));
			case 'POST /ffor/sync':
				return n.fforSync(b.channelId);
			case 'POST /ffor/epoch/close':
				return n.fforCloseEpoch(b.channelId);
			case 'POST /ffor/recover':
				return n.fforRecover({ channelId: b.channelId });
			case 'GET /graph/info':
				// The size of the network map routes are found on: the Rapid
				// Gossip Sync snapshot plus what the primary gossips.
				return n.getGraphInfo();
			case 'GET /transactions':
				return n.listOnchainTransactions();
			case 'GET /receive/onchain':
				return lookupOnchainReceipts({
					address: q.get('address') ?? '',
					network: record.network,
					query: (method, params) =>
						queryElectrum(
							options.socketFactory,
							options.electrum ?? record.electrum,
							method,
							params
						)
				});
			case 'GET /utxos':
				return n.listUtxos();
			case 'GET /fees/estimates':
				return n.getFeeEstimates();
			case 'GET /direct-funding/payments':
				return n.listDirectFundingPayments();
			// What this wallet received by direct funding: a payment funds the
			// home channel, so it settles no invoice and pays no address, and this
			// record is how the client tells which request it paid (issue #49).
			case 'GET /direct-funding/received':
				return n.listDirectFundingReceived();
			case 'GET /direct-funding/config':
				return n.getDirectFundingConfig();
			case 'POST /wallet/refresh':
				await n.waitForInitialSync();
				await n.refreshWallet();
				// An explicit refresh is the owner asking again, so the backoff
				// after a failed pass does not apply to it.
				channelizeRetryAt = 0;
				await channelize();
				return { refreshed: true };
			case 'POST /address/new': {
				await n.waitForInitialSync();
				const address = await allocateWatchedReceiveAddress({
					store: receiveRequests(),
					wallet: n.getWallet(),
					current: () => n.getNewAddress(),
					network: record.network
				});
				return { address };
			}
			case 'POST /invoice/decode':
				return n.decodeInvoice(b.bolt11);
			case 'POST /invoice/create':
				return durableInvoice(
					n.createInvoice(b.amountSats, b.description, b.expirySecs)
				);
			case 'POST /direct-funding/request':
				return n.createDirectFundingRequest(b);
			case 'POST /jit/invoice':
				return durableInvoice(await n.createJitInvoice(b));
			case 'GET /jit/quote':
				return n.getJitQuote({
					// Absent means "the ranked primaries choose" (beignet #1932);
					// a null here would be refused as a malformed pubkey.
					lspPubkey: q.get('lspPubkey') || undefined,
					amountSats: q.has('amountSats')
						? Number(q.get('amountSats'))
						: undefined,
					targetRemainingInboundSat: q.has('targetRemainingInboundSat')
						? Number(q.get('targetRemainingInboundSat'))
						: undefined
				});
			case 'POST /payment/estimate': {
				const value = n.estimatePayment(b.bolt11, b.amountSats);
				if (!value) {
					// The router answers only null. Say which fact stopped it.
					let decoded: any = null;
					try {
						decoded = n.decodeInvoice(b.bolt11);
					} catch {
						decoded = null;
					}
					const peers = n.listPeers();
					const why = explainNoRoute({
						amountSats:
							decoded?.amountSats ??
							(Number.isSafeInteger(b.amountSats) ? b.amountSats : null),
						destination: decoded?.payeeNodeKey ?? null,
						hasRoutingHints: !!decoded?.routingHints?.length,
						primaries: primaries().map((e) => ({
							pubkey: e.pubkey,
							connected: peers.some(
								(p: any) =>
									p.pubkey === e.pubkey &&
									(p.connected === true ||
										p.state === 'ready' ||
										p.state === 'connected')
							)
						})),
						channels: n.listChannels(),
						sendableSats: Number(n.getLiquiditySnapshot().sendableSats) || 0,
						graphChannelCount: (pubkey) =>
							n.getGraphNode(pubkey)?.channelCount ?? null
					});
					failure(why.code, why.message);
				}
				return value;
			}
			case 'POST /invoice/pay-safe':
				// cltvLimit is deliberately not forwarded (PATCHES.md). maxFeeMsat is
				// the exact cap 0.23.0 accepts beside maxFeeSats; the node refuses
				// both at once and applies its default cap when neither is given.
				return n.payInvoiceSafe(
					b.bolt11,
					b.timeoutMs,
					b.maxFeeSats,
					b.amountSats,
					b.metadata,
					undefined,
					b.maxFeeMsat
				);
			case 'POST /channel/splice-out': {
				if (!/^[a-zA-Z0-9_-]{8,128}$/.test(b.requestId ?? ''))
					failure(
						'REQUEST_ID_REQUIRED',
						'A stable payment request ID is required'
					);
				const existing = activity.find((x) => x.requestId === b.requestId);
				if (existing) {
					if (
						existing.address !== b.address ||
						existing.amountSats !== b.amountSats ||
						existing.channelId !== b.channelId ||
						existing.feeratePerkw !== b.feeratePerkw
					)
						failure(
							'REQUEST_ID_CONFLICT',
							'Payment request ID already used',
							409
						);
					return {
						ok: true,
						operationId: existing.id,
						status: existing.status
					};
				}
				const channel = n
					.listChannels()
					.find((c) => c.channelId === b.channelId);
				const row = {
					id: 'submission:' + b.requestId,
					requestId: b.requestId,
					kind: 'sent',
					title: 'Sent',
					reference: b.requestId,
					timestamp: Date.now(),
					status: 'uncertain',
					amountSats: b.amountSats,
					feeSats: b.quotedFeeSats ?? 0,
					feeKnown:
						Number.isSafeInteger(b.quotedFeeSats) && b.quotedFeeSats >= 0,
					feeEstimated: true,
					createdAt: Date.now(),
					address: b.address,
					channelId: b.channelId,
					previousFundingTxid: channel?.fundingTxid ?? null,
					previousFundingOutputIndex: channel?.fundingOutputIndex ?? null,
					feeratePerkw: b.feeratePerkw,
					description: String(b.description ?? '').slice(0, 300),
					statusNote:
						'Payment submitted. Confirmation has not yet been verified.'
				};
				activity.push(row);
				try {
					save('/wallet/activity.json', activity);
				} catch (error) {
					activity.pop();
					throw error;
				}
				try {
					const result = n.spliceOut(
						b.channelId,
						b.amountSats,
						b.feeratePerkw,
						b.address
					);
					if (!result.ok) {
						row.status = 'failed';
						row.statusNote = result.error ?? 'Payment refused';
						save('/wallet/activity.json', activity);
						failure(result.code ?? 'SPLICE_REFUSED', row.statusNote, 409);
					}
					row.status = 'pending';
					save('/wallet/activity.json', activity);
					return { ...result, operationId: row.id, status: row.status };
				} catch (error) {
					save('/wallet/activity.json', activity);
					throw error;
				}
			}
			case 'POST /direct-funding/send': {
				if (!/^[a-zA-Z0-9_-]{8,128}$/.test(b.requestId ?? ''))
					failure(
						'REQUEST_ID_REQUIRED',
						'A stable payment request ID is required'
					);
				if (typeof b.request !== 'string' || !b.request)
					failure('INVALID_PARAMS', 'A direct-funding request is required');
				const existing = activity.find((x) => x.requestId === b.requestId);
				if (existing) {
					if (
						existing.method !== 'direct-funding' ||
						existing.amountSats !== b.amountSats ||
						existing.envelope !== b.request
					)
						failure(
							'REQUEST_ID_CONFLICT',
							'Payment request ID already used',
							409
						);
					return {
						operationId: existing.id,
						status: existing.status,
						offerId: existing.offerId,
						fundingTxid: existing.txid
					};
				}
				const headroom = Number.isSafeInteger(b.feeHeadroomSats)
					? b.feeHeadroomSats
					: 1000;
				const row: any = {
					id: 'submission:' + b.requestId,
					requestId: b.requestId,
					kind: 'sent',
					method: 'direct-funding',
					title: 'Sent',
					reference: b.requestId,
					timestamp: Date.now(),
					status: 'uncertain',
					amountSats: b.amountSats,
					// The ceiling is what is reviewed and what the engine charges
					// against its limits; the exact fee is only known once the
					// recipient has built the transaction.
					feeSats: headroom,
					feeKnown: true,
					feeEstimated: true,
					createdAt: Date.now(),
					address: typeof b.address === 'string' ? b.address : undefined,
					envelope: b.request,
					description: String(b.description ?? '').slice(0, 300),
					statusNote: 'Direct funding submitted.'
				};
				activity.push(row);
				try {
					save('/wallet/activity.json', activity);
				} catch (error) {
					activity.pop();
					throw error;
				}
				directFundingInFlight += 1;
				try {
					const result = await n.sendDirectFunding({
						request: b.request,
						...(b.amountSats !== undefined ? { amountSats: b.amountSats } : {}),
						feeHeadroomSats: headroom
					});
					row.offerId = result.offerId;
					if (result.fundingTxid) {
						row.txid = result.fundingTxid;
						row.reference = result.fundingTxid;
					}
					row.status = directFundingStatus(result.status) ?? 'uncertain';
					row.statusNote =
						row.status === 'completed'
							? 'Direct funding confirmed.'
							: row.status === 'pending'
								? 'Direct funding signed. Waiting for confirmation.'
								: row.status === 'failed'
									? result.caveat ||
										'The recipient did not take the direct funding. Nothing was sent.'
									: result.caveat || row.statusNote;
					save('/wallet/activity.json', activity);
					return { ...result, operationId: row.id, status: row.status };
				} catch (error: any) {
					// The engine rejects only before the witness leaves, so a throw
					// means nothing of ours was spent. Say so and pass the refusal
					// on with its code intact.
					row.status = 'failed';
					row.statusNote = String(error?.message ?? 'Direct funding refused');
					save('/wallet/activity.json', activity);
					throw error;
				} finally {
					directFundingInFlight -= 1;
				}
			}
			default:
				failure(
					'NOT_FOUND',
					`Unsupported embedded wallet operation: ${route}`,
					404
				);
		}
	}
	async function execute({ method = 'GET', path, body = {} }: any) {
		if (closed) failure('WALLET_CLOSED', 'Wallet runtime closed', 409);
		if (durabilityFailed)
			failure(
				'DURABILITY_FAILED',
				'Wallet storage failed. Close and reopen before continuing.',
				503
			);
		method = method.toUpperCase();
		if (path === '/api/config' && method === 'GET')
			return {
				lfbwAvailable: true,
				defaultPrimaryNode: DEFAULT_PRIMARY,
				defaultNetwork: record?.network ?? 'mainnet',
				defaultElectrum: options.electrum ?? record?.electrum ?? null,
				hasDefaultElectrum: !!(options.electrum ?? record?.electrum),
				supportedNetworks: [...SUPPORTED_NETWORKS],
				electrumPresets: [],
				torAvailable: false,
				irohAvailable: !!options.iroh,
				jitQuoteAvailable: true,
				// The engine implements offline receiving. Whether this wallet's
				// primary serves it is the probed pair on the wallet record.
				offlineReceiveAvailable: true,
				concurrentOfflineReceiveAvailable: true,
				recoveryAvailable: true,
				recoveryAutoApplyAvailable: true,
				drainAvailable: ['closeQuote', 'prepareOnchainSweep', 'submitOnchainSweep']
					.every((name) => typeof (BeignetNode.prototype as any)?.[name] === 'function'),
				// An address can be paid out of one channel or several channels in
				// one transaction through /channel-send (beignet #1922).
				channelSendAvailable: ['quoteChannelSend', 'executeChannelSend', 'getChannelSend']
					.every((name) => typeof (BeignetNode.prototype as any)?.[name] === 'function'),
				// The runtime keeps the engine's ranked list, dials every primary
				// and steers receives by it (coreyphillips/beignet#1924).
				primariesAvailable: true,
				engineVersion: ENGINE_VERSION,
				embedded: true
			};
		if (path === '/api/wallets' && method === 'GET')
			return record ? [publicRecord()] : [];
		if (
			(path === '/api/wallets' || path === '/api/wallets/import') &&
			method === 'POST'
		) {
			validateRecoveryImport(body);
			if (record)
				failure(
					'WALLET_EXISTS',
					'This device vault already contains a wallet',
					409
				);
			const network = body.network ?? 'mainnet';
			if (!SUPPORTED_NETWORKS.includes(network))
				failure('INVALID_NETWORK', 'Unsupported Bitcoin network');
			const electrum = options.electrum ?? body.electrum;
			if (!electrum)
				failure(
					'ELECTRUM_REQUIRED',
					'Configure an Electrum transport for this network'
				);
			if (
				typeof electrum.host !== 'string' ||
				!electrum.host ||
				!Number.isInteger(electrum.port) ||
				electrum.port < 1 ||
				electrum.port > 65535 ||
				typeof electrum.tls !== 'boolean'
			)
				failure(
					'INVALID_ELECTRUM',
					'Electrum requires a hostname, port and TLS setting'
				);
			const mnemonic = body.mnemonic === undefined ? generateMnemonic() : body.mnemonic;
			if (typeof mnemonic !== 'string' || !validateMnemonic(mnemonic))
				failure('INVALID_MNEMONIC', 'Recovery phrase is invalid');
			const uri =
				body.lfbw?.primaryUri ??
				body.primaryNodeUri ??
				body.lfbwPrimaryNode ??
				(network === 'mainnet' ? DEFAULT_PRIMARY : null);
			const lf = rules.normalizeLfbw(
				{
					enabled: true,
					primaryUri: uri,
					primaryFallbackUri: body.lfbw?.primaryFallbackUri,
					trusted: body.lfbw?.trusted ?? true,
					...(Array.isArray(body.lfbw?.primaries)
						? { primaries: body.lfbw.primaries }
						: {}),
					...(body.lfbw?.primariesThresholdSat !== undefined
						? { primariesThresholdSat: body.lfbw.primariesThresholdSat }
						: {})
				},
				{ network, available: true }
			);
			if (anyIroh(lf.primaries) && !options.iroh)
				failure('IROH_UNSUPPORTED', 'This host does not support Iroh.');
			if (options.socketFactory?.fixedUpstream === true && lf.primaries.length > 1)
				failure('TRANSPORT_SINGLE_PEER', SINGLE_PEER_RELAY, 409);
			record = {
				electrum,
				id: randomBytes(16).toString('hex'),
				name: body.name ?? 'My wallet',
				network,
				createdAt: Date.now(),
				// Unsynced: the first start writes the list to the engine.
				lfbw: { ...lf, primariesSyncedAt: null },
				onchainOnly: false
			};
			storedMnemonic = mnemonic;
			recoveryImport.autoApply = body.recoveryAutoApply === true;
			recoveryImport.complete = false;
			persist();
			try {
				await start();
			} catch (error: any) {
				record.lfbw.setup = 'failed';
				record.lfbw.setupError = error.message;
				persist();
			}
			return { record: publicRecord(), mnemonic };
		}
		const manager = path.match(/^\/api\/wallets\/([^/]+)(.*)$/);
		if (manager) {
			if (!record || manager[1] !== record.id)
				failure('NOT_FOUND', 'Wallet not found', 404);
			const action = manager[2];
			if (!action && method === 'GET') return publicRecord();
			if (action === '/activity' && method === 'GET') {
				await reconcileActivity();
				await syncDrain().catch(() => {});
				return clone(
					[...drainActivity(), ...activity.map((row) => ({
						...row,
						title:
							row.status === 'completed'
								? row.method === 'direct-funding'
									? 'Direct funding sent'
									: 'Bitcoin sent'
								: row.status === 'failed'
									? 'Payment declined'
									: row.status === 'uncertain'
										? 'Payment result unknown'
										: row.method === 'direct-funding'
											? 'Direct funding pending'
											: 'Bitcoin payment pending',
						description: row.description || row.statusNote
					}))]
				);
			}
			if (action === '/start' && method === 'POST') return start();
			if (action === '/stop' && method === 'POST') return stop();
			if (method !== 'GET') requireRecoveryReady();
			if (
				(action === '/lfbw/retry' || action === '/lfbw/setup') &&
				method === 'POST'
			) {
				if (!node) return start();
				await setup();
				return publicRecord();
			}
			if (action === '/lfbw/channelize' && method === 'POST')
				return channelize(!!body.force);
			if (!action && method === 'PATCH') {
				const input = body.lfbw ?? {
					enabled: true,
					primaryUri: body.primaryNodeUri ?? body.primaryUri
				};
				const before = primaries();
				const replaced = before[0];
				const beforeIroh = anyIroh(before);
				const nextLfbw = rules.normalizeLfbw(input, {
					network: record.network,
					available: true,
					existing: record.lfbw
				});
				// A client that names one primary replaces rank 1 and keeps the
				// rest of the list; one that sends the list replaces the list.
				const entries =
					Array.isArray(input.primaries) && input.primaries.length > 0
						? nextLfbw.primaries
						: [
								nextLfbw.primaries[0],
								...before
									.slice(1)
									.filter((e) => e.pubkey !== nextLfbw.primaries[0].pubkey)
						  ];
				if (anyIroh(entries) && !options.iroh)
					failure('IROH_UNSUPPORTED', 'This host does not support Iroh.');
				if (options.socketFactory?.fixedUpstream === true && entries.length > 1)
					failure('TRANSPORT_SINGLE_PEER', SINGLE_PEER_RELAY, 409);
				// The record is written first and marked unsynced, then the engine
				// is brought to it: a crash between the two leaves a record the
				// next start applies, never a list the user did not ask for.
				record.lfbw = {
					...nextLfbw,
					primaries: entries,
					...rules.primariesMirror(entries),
					primariesSyncedAt: null
				};
				if (body.name) record.name = body.name;
				persist();
				if (node) convergePrimaries();
				const next = primaries()[0];
				if (anyIroh(primaries()) !== beforeIroh) {
					await stop();
				} else if (
					node &&
					replaced &&
					next &&
					replaced.pubkey === next.pubkey &&
					(replaced.uri !== next.uri ||
						replaced.fallbackUri !== next.fallbackUri)
				) {
					node.disconnectPeer(replaced.pubkey);
				}
				if (!node) return start();
				if (setupRunning) await setupRunning;
				await setup();
				return publicRecord();
			}
			failure('NOT_FOUND', 'Unsupported embedded manager operation', 404);
		}
		const wallet = path.match(/^\/wallets\/([^/]+)\/api(\/.*)$/);
		if (wallet) {
			if (!record || wallet[1] !== record.id)
				failure('NOT_FOUND', 'Wallet not found', 404);
			return clone(await daemon(method, wallet[2], body));
		}
		failure('NOT_FOUND', 'Unknown embedded wallet operation', 404);
	}
	function request(input: any) {
		const pending = mutations.run(input, execute);
		inFlight.add(pending);
		pending.then(
			() => inFlight.delete(pending),
			() => inFlight.delete(pending)
		);
		return pending;
	}
	return {
		request,
		setAppBackgrounded(backgrounded: boolean) {
			if (closed || appBackgrounded === backgrounded) return;
			appBackgrounded = backgrounded;
			activeWatchdog?.setAppBackgrounded(backgrounded);
			node?.getNode().getPeerManager()?.setAppBackgrounded(backgrounded);
		},
		async close() {
			if (released) return;
			if (closing) return closing;
			closed = true;
			drainGeneration++;
			endWaits();
			closing = (async () => {
				try {
					await Promise.allSettled(Array.from(inFlight));
					await stop();
				} finally {
					// The realm claim is this runtime's alone. A stop that throws
					// must not keep it, or every later runtime in this process is
					// refused for a wallet that is already gone.
					release();
					released = true;
				}
			})();
			try {
				await closing;
			} finally {
				closing = undefined;
			}
		}
	};
}
