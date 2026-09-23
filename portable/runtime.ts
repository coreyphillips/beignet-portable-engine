import { OfflineReceive } from './offline-receive';
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
import { readRecoveryImport, validateRecoveryImport, recoveryRefusal, hasInstalledRecovery } from './recovery';
export { createRelaySocketFactory } from './relay';
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
	configure(options);
	const persist = () =>
		save('/wallet/registry.json', { record, mnemonic: storedMnemonic, recoveryImport });
	const recoveryHold = () => node ? recoveryRefusal(node, importPending()) : null;
	const requireRecoveryReady = () => {
		const held = recoveryHold();
		if (held) failure(held.code, held.message, 503);
	};
	const nodeUnavailable = () => !!node && (
		node.resuming || node.restorePending || node.restartRequired
	);
	const healthy = () => !!node && !nodeUnavailable() && node.getHealth().electrumConnected;
	const completeRecoveryImport = () => {
		if (!importPending()) return;
		recoveryImport.complete = true;
		persist();
	};
	const publicRecord = () =>
		record
			? clone({
					...record,
					lfbw: {
						...record.lfbw,
						lastChannelize: record.lfbwLast ?? null,
						lastSplice,
						unpairedFunding,
						lastOffer
					},
					status: node ? 'running' : 'stopped',
					healthy: healthy(),
					runtime: {
						status: node ? 'running' : 'stopped',
						healthy: healthy(),
						lfbwLast: record.lfbwLast ?? null
					}
				})
			: null;
	const primary = () => {
		const p = rules.parseNodeUri(record.lfbw.primaryUri);
		return {
			...p,
			connectHost: p.host,
			connectPort: p.port,
			relayHost: p.host,
			relayPort: p.port
		};
	};
	/** Whether the primary is a connected peer right now. */
	const primaryConnected = () =>
		!!node &&
		!nodeUnavailable() &&
		node
			.listPeers()
			.some(
				(peer) =>
					peer.pubkey === record?.lfbw?.primaryPubkey &&
					(peer.state === 'connected' || peer.state === 'ready')
			);
	/**
	 * Dial the primary again after it was lost. The engine drops a peer for a
	 * transport error without telling its peer manager, which then keeps a
	 * disconnected entry, schedules no reconnect and lets connectPeer return
	 * early on the entry it holds; disconnecting first clears it.
	 */
	let redialing = false;
	const redialPrimary = async (opts: { force?: boolean } = {}) => {
		if (redialing || closed || !node || record?.lfbw?.setup !== 'ready') return;
		if (recoveryHold()) return;
		if (!opts.force && primaryConnected()) return;
		redialing = true;
		try {
			const p = primary();
			try {
				node.disconnectPeer(p.pubkey);
			} catch {}
			await node.connectPeer(p.pubkey, p.host, p.port);
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
			redialing = false;
		}
	};
	let setupRunning = false;
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
			if (closed || !node || !record || record.lfbw.setup !== 'failed') return;
			if (recoveryHold()) return;
			if (startPromise) return;
			void setup().then(async () => {
				if (closed) return;
				if (record.lfbw.setup === 'ready') await channelize();
				else retrySetupSoon(attempt + 1);
			});
		}, SETUP_RETRY_MS[attempt]);
		pendingTimers.add(pending);
	};
	const setup = async () => {
		if (!node || !record || setupRunning) return;
		setupRunning = true;
		try {
			await runSetup();
		} finally {
			setupRunning = false;
		}
	};
	const runSetup = async () => {
		if (!node || !record) return;
		const held = recoveryHold();
		// The initial recovery connection retrieves storage only. Leave direct
		// funding disabled until the existing channel state has been installed.
		if (held && (held.code !== 'NODE_RESTORE_PENDING' || nodeUnavailable())) return;
		record.lfbw.setup = 'pending';
		persist();
		try {
			const p = primary();
			if (!held) {
				if (record.lfbw.trusted) node.addTrustedPeer(p.pubkey);
				else node.removeTrustedPeer(p.pubkey);
			}
			// The policy names the liquidity peer every offer is negotiated with
			// and signs its address into every request. It goes on before the
			// connection is attempted: a primary that is down at start used to
			// leave the policy unset, every offer declined with "no liquidity
			// peer", and every request minted with no way to reach this wallet,
			// until the next restart.
			if (!held) node.configureDirectFunding(rules.directFundingConfig(record.lfbw, p));
			try {
				await node.connectPeer(p.pubkey, p.host, p.port);
			} catch (error) {
				if (nodeUnavailable()) return;
				if (
					!node
						.listPeers()
						.some(
							(peer) => peer.pubkey === p.pubkey && peer.state === 'connected'
						)
				)
					throw error;
			}
			record.lfbw.setup = 'ready';
			record.lfbw.setupError = null;
			record.lfbw.setupAt = Date.now();
		} catch (error: any) {
			options.onDiagnostic?.({
				phase: 'primary-connect',
				message: error.message,
				stack: error.cause?.stack ?? error.stack
			});
			record.lfbw.setup = 'failed';
			record.lfbw.setupError = error.message;
		}
		persist();
	};
	const channelize = async (force = false) => {
		if (
			closed ||
			durabilityFailed ||
			!node ||
			recoveryHold() ||
			busy ||
			directFundingInFlight > 0 ||
			record.lfbw.setup !== 'ready'
		)
			return null;
		busy = true;
		try {
			const { last, retryAt } = await runChannelize({
				node,
				excludeChannelIds: offlineReceive?.reservedIds(),
				record,
				primary,
				rules,
				force,
				retryAt: channelizeRetryAt,
				mayMutate: () => !closed && !durabilityFailed && !recoveryHold(),
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
				node = await BeignetNode.create({
					...options.nodeOptions,
					mnemonic,
					network: record.network,
					dataDir: '/wallet',
					allowMultipleInstances: true,
					electrumHost: e.host,
					electrumPort: e.port,
					electrumTls: e.tls,
					feeEstimationSource: 'electrum',
					autoBootstrap: false,
					autoGossipSync: true,
					recoveryMode: 'peer-storage',
					recoveryAutoApply: recoveryImport.autoApply,
					autoReconnect: true,
					forwardingEnabled: false,
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
				});
				// Native restore flags are durable before the swap finishes. They
				// cover a crash between installing channels and our completion event.
				if (importPending() && hasInstalledRecovery(node)) completeRecoveryImport();
				node.on('recovery:restored', () => {
					try {
						completeRecoveryImport();
						// The native wrapper rebuilt its node and policy in process.
						const pending = setTimeout(() => {
							pendingTimers.delete(pending);
							if (!closed && !durabilityFailed) void setup().catch(() => {});
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
				// one. The peer events carry (pubkey, error) as two arguments;
				// node:error carries one object.
				const peerKey = (first: any): string =>
					typeof first === 'string' ? first : String(first?.pubkey ?? '');
				for (const event of [
					'node:error',
					'peer:error',
					'peer:connect',
					'peer:disconnect'
				]) {
					node.on(event, (first: any, second: any) => {
						const detail =
							second instanceof Error
								? second.message
								: typeof second?.message === 'string'
									? second.message
									: undefined;
						const message =
							detail !== undefined
								? `${detail} (peer ${peerKey(first).slice(0, 16)})`
								: String(
										first?.message ??
											first?.error ??
											(typeof first === 'string' ? first : first?.pubkey) ??
											event
									);
						const code = second?.code ?? first?.code;
						options.onDiagnostic?.({
							phase: event,
							message,
							code: typeof code === 'string' ? code : undefined
						});
					});
				}
				// A first connection after a cold start has been seen to come up
				// dead: the handshake completes, the primary never answers
				// channel_reestablish, and nothing notices until the first ping
				// fails thirty seconds later. Reestablishment gets
				// REESTABLISH_WATCHDOG_MS after a connect; a home channel still not
				// usable by then, with the peer still listed as connected, is
				// dialled again rather than waited on. Bounded per start so a
				// primary that genuinely cannot reestablish is not hammered.
				const REESTABLISH_WATCHDOG_MS = 8000;
				const REESTABLISH_REDIALS_MAX = 3;
				let reestablishRedials = 0;
				const homeChannelUsable = (): boolean => {
					const primaryPubkey = record?.lfbw?.primaryPubkey;
					const mine = node!
						.listChannels()
						.filter(
							(c: any) =>
								c.peerPubkey === primaryPubkey &&
								c.state !== 'CLOSED' &&
								c.state !== 'FORCE_CLOSED'
						);
					return (
						mine.length === 0 ||
						mine.some((c: any) => c.htlcUsable ?? c.state === 'NORMAL')
					);
				};
				node.on('peer:connect', (first: any) => {
					if (peerKey(first) !== record?.lfbw?.primaryPubkey) return;
					const pending = setTimeout(() => {
						pendingTimers.delete(pending);
						if (closed || !node) return;
						if (recoveryHold()) return;
						if (homeChannelUsable()) {
							reestablishRedials = 0;
							return;
						}
						if (
							!primaryConnected() ||
							reestablishRedials >= REESTABLISH_REDIALS_MAX
						)
							return;
						reestablishRedials += 1;
						options.onDiagnostic?.({
							phase: 'primary-redial',
							message: `channel not usable ${REESTABLISH_WATCHDOG_MS / 1000}s after connecting, dialling again (${reestablishRedials}/${REESTABLISH_REDIALS_MAX})`
						});
						void redialPrimary({ force: true });
					}, REESTABLISH_WATCHDOG_MS);
					pendingTimers.add(pending);
				});
				// A transport error on the primary's connection is followed by a
				// redial after a short pause, rather than waiting for the poll.
				node.on('peer:error', (first: any) => {
					if (peerKey(first) !== record?.lfbw?.primaryPubkey) return;
					const pending = setTimeout(() => {
						pendingTimers.delete(pending);
						void redialPrimary();
					}, 2000);
					pendingTimers.add(pending);
				});
				await node.waitForInitialSync();
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
				await setup();
				receiveTimer = setInterval(() => {
					if (!closed && !durabilityFailed && !recoveryHold()) void offlineReceive?.sync().catch(() => {});
				}, 2000);
				if (!recoveryHold()) void offlineReceive.sync().catch(() => {});
				if (record.lfbw.setup === 'failed') retrySetupSoon();
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
					if (record.lfbw.setup === 'failed' && !startPromise) {
						void setup().then(() => channelize());
						return;
					}
					// A phone that has lost its primary has lost receiving, direct
					// funding and every move; the engine's own reconnect does not
					// cover a peer it dropped for a transport error, so the poll
					// dials again. connectPeer is idempotent for a live connection.
					if (record.lfbw.setup === 'ready' && !primaryConnected()) {
						void redialPrimary();
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
				if (node) await node.destroy().catch(() => {});
				node = undefined;
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
	// A confirmed funding is cached for good. An unconfirmed one is rechecked
	// often, because that answer gates sending to a Bitcoin address and a stale
	// "not yet" would hold up a payment that has become perfectly safe.
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
			if (offlineReceive?.reservedIds().has(channel.channelId))
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
	 * How long a splice submission may show no chain effect before the wallet
	 * stops calling it "pending". Long enough to cover a slow negotiation and a
	 * reconnect, short enough that nobody is left watching a spinner for a
	 * payment that was never broadcast.
	 */
	const STALLED_SUBMISSION_MS = 600000;
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
	/**
	 * Whether the engine is still working on a splice for this channel. Absence
	 * of both markers is not proof that nothing happened, which is why a stalled
	 * row becomes uncertain rather than failed.
	 */
	const spliceInFlight = (channel: any) =>
		!!channel &&
		(channel.payThroughSplice !== undefined ||
			channel.pendingSpliceLocalBalanceSats !== undefined);
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
				const channel = channels.find((c) => c.channelId === row.channelId);
				const candidate = row.txid ?? channel?.fundingTxid;
				if (
					!candidate ||
					candidate === row.previousFundingTxid ||
					!row.previousFundingTxid ||
					row.previousFundingOutputIndex == null
				) {
					// A splice replaces the channel's funding, so an unchanged
					// funding txid means this submission never took effect on
					// chain. Reconciliation can only ever promote a row to
					// completed, so without this a submission that was never
					// broadcast stays "pending" for the life of the wallet: no
					// transaction to look up, nothing arriving at the
					// destination, and no amount of waiting or mining changes
					// it. Say so instead, once it has clearly stopped
					// progressing.
					if (
						row.status === 'pending' &&
						!row.txid &&
						row.previousFundingTxid &&
						Date.now() - (row.createdAt ?? 0) > STALLED_SUBMISSION_MS &&
						!spliceInFlight(channel)
					) {
						row.status = 'uncertain';
						row.statusNote =
							'This payment has not appeared on the Bitcoin network and your wallet is no longer working on it. Check this address and your balance before sending again.';
						changed = true;
					}
					continue;
				}
				try {
					const proof = await verifySubmission(
						options.socketFactory,
						options.electrum ?? record.electrum,
						row,
						candidate,
						record.network
					);
					if (!proof?.matched) continue;
					row.txid = candidate;
					row.reference = candidate;
					row.status = proof.confirmed ? 'completed' : 'pending';
					row.title = proof.confirmed
						? 'Bitcoin sent'
						: 'Bitcoin payment pending';
					row.statusNote = proof.confirmed
						? 'Transaction confirmed.'
						: 'Transaction verified. Waiting for confirmation.';
					changed = true;
				} catch {}
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
		switch (route) {
			case 'GET /info':
				return n.getInfo();
			case 'GET /health':
				return n.getHealth();
			case 'GET /balance':
				return n.getBalance();
			case 'GET /channels':
				return channelsWithFunding(n.listChannels());
			case 'GET /peers':
				return n.listPeers();
			case 'GET /payments':
				return n.listPayments();
			case 'GET /invoices':
				return n.listInvoices();
			case 'GET /receive/offline':
				return (
					offlineReceive?.capacity(record.lfbw.primaryPubkey) ?? { maxSats: 0 }
				);
			case 'GET /receive/quote':
				return offlineReceive!.quote(
					record.lfbw.primaryPubkey,
					Number(q.get('amountSats'))
				);
			case 'POST /receive/invoice':
				return durableInvoice(
					await offlineReceive!.create(b, record.lfbw.primaryPubkey)
				);
			case 'GET /ffor/epochs':
				return n.fforEpochs('R');
			case 'GET /ffor/epoch':
				return n.fforEpoch(q.get('channelId') ?? '');
			case 'POST /ffor/epoch/start':
				return n.fforStartEpoch(b);
			case 'POST /ffor/invoice':
				return durableInvoice(n.fforCreateInvoice(b));
			case 'POST /ffor/recover':
				return n.fforRecover({ channelId: b.channelId });
			case 'GET /liquidity':
				return n.getLiquiditySnapshot();
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
					lspPubkey: q.get('lspPubkey')!,
					amountSats: q.has('amountSats')
						? Number(q.get('amountSats'))
						: undefined,
					targetRemainingInboundSat: q.has('targetRemainingInboundSat')
						? Number(q.get('targetRemainingInboundSat'))
						: undefined
				});
			case 'POST /payment/estimate': {
				const value = n.estimatePayment(b.bolt11, b.amountSats);
				if (!value) failure('NO_ROUTE', 'Unable to estimate payment');
				return value;
			}
			case 'POST /invoice/pay-safe':
				return n.payInvoiceSafe(
					b.bolt11,
					b.timeoutMs,
					b.maxFeeSats,
					b.amountSats,
					b.metadata
				);
			case 'POST /channel/splice-quote':
				return n.spliceQuote(b.channelId, b.direction, b.feeratePerkw);
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
				supportedNetworks: ['mainnet', 'testnet', 'regtest'],
				electrumPresets: [],
				torAvailable: false,
				jitQuoteAvailable: true,
				offlineReceiveAvailable: true,
				recoveryAvailable: true,
				recoveryAutoApplyAvailable: true,
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
			if (!['mainnet', 'testnet', 'signet', 'regtest'].includes(network))
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
				{ enabled: true, primaryUri: uri, trusted: body.lfbw?.trusted ?? true },
				{ network, available: true }
			);
			record = {
				electrum,
				id: randomBytes(16).toString('hex'),
				name: body.name ?? 'My wallet',
				network,
				createdAt: Date.now(),
				lfbw: lf,
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
				return clone(
					activity.map((row) => ({
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
					}))
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
				record.lfbw = rules.normalizeLfbw(input, {
					network: record.network,
					available: true,
					existing: record.lfbw
				});
				if (body.name) record.name = body.name;
				persist();
				if (!node) return start();
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
		const pending = execute(input);
		inFlight.add(pending);
		pending.then(
			() => inFlight.delete(pending),
			() => inFlight.delete(pending)
		);
		return pending;
	}
	return {
		request,
		async close() {
			if (released) return;
			if (closing) return closing;
			closed = true;
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
