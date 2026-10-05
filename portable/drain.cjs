'use strict';

const PHASES = new Set([
	'review',
	'preparing',
	'closing',
	'sweeping',
	'pending',
	'cancelling',
	'cancelled',
	'completed'
]);
const ACTIVE = new Set([
	'preparing',
	'closing',
	'sweeping',
	'pending',
	'cancelling'
]);
const needsHold = (row) => ACTIVE.has(row.phase) && row.fundsCommitted !== true;
const idValid = (id) =>
	typeof id === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(id);
const sats = (value) => Number.isSafeInteger(value) && value >= 0;
const copy = (value) => JSON.parse(JSON.stringify(value));
const identity = (coins) =>
	coins
		.map((coin) => `${coin.txid}:${coin.vout}:${coin.valueSats}`)
		.sort()
		.join('|');
const channelIdentity = (channel) =>
	channel
		? [
				channel.channelId,
				channel.fundingTxid,
				channel.fundingOutputIndex,
				channel.localBalanceSats
		  ].join(':')
		: null;

/**
 * Durable orchestration only. Signing, input ownership and broadcast retries
 * belong to the engine. The private journal never enters activity or API output.
 */
function drainCoordinator({
	read,
	write,
	node,
	primary,
	ready,
	busy,
	offline,
	activityPending,
	pause,
	disableReceive,
	restoreReceive,
	observe,
	closeNotStarted,
	sweepDepth = () => 0,
	lifecycle = () => 0,
	operational = () => true,
	failure,
	now = Date.now
}) {
	let serial = Promise.resolve();
	let runningEpoch = null;
	const checkLifecycle = () => {
		if (
			!operational() ||
			(runningEpoch !== null && runningEpoch !== lifecycle())
		)
			failure(
				'WALLET_CLOSED',
				'This wallet operation stopped with its runtime',
				409
			);
	};
	const locked = (operation) => {
		const epoch = lifecycle();
		const next = serial.then(async () => {
			runningEpoch = epoch;
			try {
				checkLifecycle();
				return await operation();
			} finally {
				runningEpoch = null;
			}
		});
		serial = next.catch(() => {});
		return next;
	};
	const records = () => {
		const journal = read();
		if (journal === null) return [];
		if (
			journal?.version !== 1 ||
			!Array.isArray(journal.records) ||
			journal.records.length > 1000
		)
			failure(
				'DRAIN_JOURNAL_INVALID',
				'The saved wallet drain could not be read',
				503
			);
		const ids = new Set();
		for (const row of journal.records) {
			if (
				!idValid(row?.requestId) ||
				ids.has(row.requestId) ||
				!PHASES.has(row.phase) ||
				typeof row.address !== 'string' ||
				!row.address ||
				typeof row.primary !== 'string' ||
				!Number.isFinite(row.createdAt) ||
				!Number.isFinite(row.expiresAt) ||
				!sats(row.amountSats) ||
				!sats(row.feeSats) ||
				!sats(row.debitSats) ||
				(row.fundsCommitted !== undefined &&
					(typeof row.fundsCommitted !== 'boolean' ||
						(row.fundsCommitted &&
							(!['sweeping', 'pending', 'completed'].includes(row.phase) ||
								(row.channelId && !row.close?.txid) ||
								(row.coins?.length && !row.sweep?.txid))))) ||
				!Array.isArray(row.coins) ||
				row.coins.some(
					(coin) =>
						!/^[a-f0-9]{64}$/.test(coin?.txid) ||
						!Number.isInteger(coin.vout) ||
						coin.vout < 0 ||
						!sats(coin.valueSats)
				)
			)
				failure(
					'DRAIN_JOURNAL_INVALID',
					'The saved wallet drain could not be read',
					503
				);
			ids.add(row.requestId);
		}
		return copy(journal.records);
	};
	const save = (row) => {
		checkLifecycle();
		const rows = records();
		const index = rows.findIndex((entry) => entry.requestId === row.requestId);
		row.revision = (index < 0 ? 0 : rows[index].revision ?? 0) + 1;
		if (index < 0) {
			if (rows.length >= 1000)
				failure('DRAIN_HISTORY_FULL', 'The wallet drain history is full', 409);
			rows.push(copy(row));
		} else rows[index] = copy(row);
		write({ version: 1, records: rows });
	};
	const find = (requestId) => {
		if (!idValid(requestId))
			failure('INVALID_PARAMS', 'A stable drain requestId is required');
		const row = records().find((entry) => entry.requestId === requestId);
		if (!row) failure('NOT_FOUND', 'Wallet drain not found', 404);
		return row;
	};
	const active = () => {
		const rows = records().filter((row) => ACTIVE.has(row.phase));
		const held = rows.filter(needsHold);
		return (
			held.find((row) => row.requestId === pause.status().requestId) ??
			held[0] ??
			rows[0] ??
			null
		);
	};
	const available = () => {
		const engine = node();
		return (
			!!engine &&
			[
				'closeQuote',
				'closeChannel',
				'prepareOnchainSweep',
				'submitOnchainSweep',
				'getOnchainSweep',
				'cancelOnchainSweep'
			].every((name) => typeof engine[name] === 'function')
		);
	};
	const publicInfo = (row) => ({
		requestId: row.requestId,
		revision: row.revision ?? 0,
		address: row.address,
		phase: row.phase,
		amountSats: row.amountSats,
		feeSats: row.feeSats,
		debitSats: row.debitSats,
		reviewedDebitSats: row.reviewedDebitSats,
		feeEstimated: !['completed', 'pending'].includes(row.phase),
		closeAmountSats: row.close?.amountSats ?? 0,
		closeFeeSats: row.close?.feeSats ?? 0,
		sweepAmountSats: row.sweep?.amountSats ?? 0,
		sweepFeeSats: row.sweep?.feeSats ?? 0,
		txids: [row.close?.txid, row.sweep?.txid].filter(Boolean),
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
		...(row.error ? { error: row.error } : {}),
		...(row.residualSats !== undefined
			? { residualSats: row.residualSats }
			: {})
	});
	const otherActive = (id) => {
		if (records().some((row) => ACTIVE.has(row.phase) && row.requestId !== id))
			failure(
				'DRAIN_IN_PROGRESS',
				'Finish the current wallet drain first',
				409
			);
	};
	const snapshot = (owner) => {
		checkLifecycle();
		if (!available())
			failure(
				'DRAIN_UNAVAILABLE',
				'This engine does not support wallet draining',
				409
			);
		ready();
		if (busy() || activityPending())
			failure(
				'DRAIN_BUSY',
				'Wait for the current wallet operation to finish',
				409
			);
		const engine = node();
		const peer = primary();
		if (
			!engine
				.listPeers()
				.some(
					(entry) =>
						entry.pubkey === peer &&
						(entry.connected === true ||
							['ready', 'connected'].includes(entry.state))
				)
		)
			failure(
				'PRIMARY_OFFLINE',
				'Connect to your primary before emptying the wallet',
				409
			);
		if (
			engine.listPayments().some((entry) => {
				const status = String(entry.status).toLowerCase();
				// Creating an unpaid invoice already records a pending incoming
				// payment. Actual incoming HTLCs and unsettled commitments are
				// guarded by the channel checks and closeQuote below.
				if (
					status === 'pending' &&
					String(entry.direction).toLowerCase() === 'incoming'
				)
					return false;
				return ['pending', 'in_flight', 'inflight'].includes(status);
			})
		)
			failure('DRAIN_BUSY', 'Wait for the pending payment to finish', 409);
		const held = offline();
		if (
			held.reservedChannelIds?.length ||
			held.requests?.some(
				(entry) =>
					entry.unresolvedSlots > 0 ||
					['ACTIVE', 'DRAINING', 'PROPOSED', 'ACCEPTED'].includes(entry.state)
			)
		)
			failure(
				'DRAIN_BUSY',
				'Resolve offline receive reservations before emptying the wallet',
				409
			);
		const channels = engine
			.listChannels()
			.filter(
				(entry) =>
					!(
						entry.state === 'CLOSED' &&
						entry.closeStatus?.resolution === 'resolved'
					)
			);
		if (
			channels.length > 1 ||
			channels.some((entry) => entry.peerPubkey !== peer)
		)
			failure(
				'DRAIN_UNAVAILABLE',
				'Only the home channel can be emptied from this wallet',
				409
			);
		const channel = channels[0] ?? null;
		if (
			channel &&
			(channel.state !== 'NORMAL' ||
				channel.htlcUsable !== true ||
				channel.htlcCount > 0 ||
				channel.pendingSpliceTxid ||
				channel.payThroughSplice !== undefined ||
				channel.restoreRecencyUnproven ||
				channel.reestablishRecencyUnproven ||
				channel.reestablishSecretMissing ||
				channel.restoreRevokedRisk ||
				channel.fundingUnaccounted ||
				(channel.ffor &&
					(channel.ffor.unresolvedSlots > 0 ||
						!['CLOSED', 'RESOLVED', 'ABORTED'].includes(channel.ffor.state))))
		)
			failure(
				'DRAIN_BUSY',
				'The home channel is not ready for a cooperative close',
				409
			);
		const coins = engine.listUtxos();
		const ownSweep = owner && engine.getOnchainSweep(owner.requestId);
		if (
			coins.some(
				(coin) =>
					coin.frozen &&
					!(
						ownSweep &&
						owner.coins.some(
							(old) => old.txid === coin.txid && old.vout === coin.vout
						)
					)
			)
		)
			failure(
				'DRAIN_BUSY',
				'Resolve reserved or frozen coins before emptying the wallet',
				409
			);
		return {
			engine,
			peer,
			channel,
			coins: coins.map(({ txid, vout, valueSats }) => ({
				txid,
				vout,
				valueSats
			}))
		};
	};
	const unchanged = (row, current, allowLaterCoins = false) => {
		if (
			current.peer !== row.primary ||
			channelIdentity(current.channel) !== row.channelIdentity
		)
			failure(
				'DRAIN_REVIEW_EXPIRED',
				'The channel changed. Review the wallet drain again',
				409
			);
		const coins = allowLaterCoins
			? current.coins.filter((coin) =>
					row.coins.some(
						(old) => old.txid === coin.txid && old.vout === coin.vout
					)
			  )
			: current.coins;
		if (identity(coins) !== identity(row.coins))
			failure(
				'DRAIN_REVIEW_EXPIRED',
				'The available coins changed. Review the wallet drain again',
				409
			);
	};
	const recalculate = (row) => {
		row.amountSats =
			(row.close?.amountSats ?? 0) + (row.sweep?.amountSats ?? 0);
		row.feeSats = (row.close?.feeSats ?? 0) + (row.sweep?.feeSats ?? 0);
		row.debitSats = row.amountSats + row.feeSats;
	};
	const finishHold = async (row) => {
		checkLifecycle();
		if (records().some(needsHold)) return;
		const held = pause.status();
		if (held.paused && held.requestId !== row.requestId) return;
		await restoreReceive();
		checkLifecycle();
		await pause.set({ paused: false, requestId: row.requestId });
	};
	const acquireHold = async (row) => {
		checkLifecycle();
		if (!needsHold(row)) {
			await finishHold(row);
			return true;
		}
		const held = pause.status();
		if (held.paused && held.requestId !== row.requestId) {
			const owner = records().find(
				(entry) => entry.requestId === held.requestId
			);
			if (!owner || needsHold(owner)) return false;
			await pause.set({ paused: false, requestId: held.requestId });
			checkLifecycle();
		}
		await pause.set({ paused: true, requestId: row.requestId });
		checkLifecycle();
		await disableReceive();
		checkLifecycle();
		return true;
	};
	const reconcile = async (row) => {
		checkLifecycle();
		if (
			(!ACTIVE.has(row.phase) && row.phase !== 'completed') ||
			['preparing', 'cancelling'].includes(row.phase)
		)
			return row;
		const engine = node();
		let sweepSubmitted = !row.coins.length;
		if (row.channelId) {
			const payout = engine
				.listOnchainTransactions()
				.find(
					(entry) =>
						entry.source === 'cooperative-close' &&
						entry.channelId === row.channelId &&
						entry.address === row.address
				);
			const seen = payout ? await observe(payout, row) : null;
			checkLifecycle();
			if (!seen?.exists) {
				if (row.close?.txid) {
					row.close.confirmed = false;
					row.phase = 'pending';
					save(row);
					await acquireHold(row);
				}
				return row;
			}
			row.close = {
				txid: payout.txid,
				amountSats: payout.valueSats,
				feeSats: payout.feeSats,
				confirmed: Number.isFinite(seen.height) && seen.height > 0,
				depth: seen.depth ?? 0
			};
			row.phase = row.coins.length ? 'sweeping' : 'pending';
			recalculate(row);
			save(row);
		}
		if (row.coins.length) {
			row.phase = 'sweeping';
			save(row);
			const sweep = await engine.submitOnchainSweep(row.requestId);
			if (
				sweep.requestId !== row.requestId ||
				!row.sweep?.txid ||
				sweep.txid !== row.sweep.txid
			)
				failure(
					'DRAIN_SWEEP_MISMATCH',
					'The saved sweep does not match this wallet drain',
					503
				);
			sweepSubmitted = ['submitted', 'confirmed'].includes(sweep.status);
			row.sweep = {
				txid: sweep.txid,
				amountSats: sweep.amountSats,
				feeSats: sweep.feeSats,
				confirmed: sweep.status === 'confirmed'
			};
			if (sweep.error) row.error = sweep.error;
			else delete row.error;
		}
		row.phase = 'pending';
		// The close has been verified at its destination and the sweep now owns
		// durable signed bytes and permanently reserved inputs. New funds cannot
		// enter either payout. Keep tracking confirmations without holding the
		// whole wallet, including after a restart or a payout reorg.
		if ((!row.channelId || row.close?.txid) && sweepSubmitted)
			row.fundsCommitted = true;
		recalculate(row);
		if (
			(!row.channelId || row.close?.confirmed) &&
			(!row.coins.length || row.sweep?.confirmed)
		) {
			row.phase = 'completed';
			// Confirmed payouts supersede earlier transport or rebroadcast warnings.
			delete row.error;
			row.finalized =
				(!row.channelId || row.close.depth >= 100) &&
				(!row.coins.length || sweepDepth(row.sweep.txid) >= 100);
			row.residualSats = engine
				.listUtxos()
				.filter((coin) => !coin.frozen)
				.reduce((sum, coin) => sum + coin.valueSats, 0);
		}
		save(row);
		if (!needsHold(row)) await finishHold(row);
		else await acquireHold(row);
		return row;
	};
	const resume = async (row) => {
		try {
			if (!(await acquireHold(row))) return publicInfo(row);
			if (row.phase === 'preparing') {
				unchanged(row, snapshot(row), true);
				if (row.coins.length) {
					const prepared = await node().prepareOnchainSweep({
						requestId: row.requestId,
						address: row.address,
						satsPerVbyte: row.satsPerVbyte,
						inputOutpoints: row.coins.map(({ txid, vout }) => ({ txid, vout })),
						debitSats: row.coins.reduce((sum, coin) => sum + coin.valueSats, 0),
						maxFeeSats: row.sweepFeeCapSats
					});
					row.sweep = {
						amountSats: prepared.amountSats,
						feeSats: prepared.feeSats,
						txid: prepared.txid
					};
				}
				recalculate(row);
				unchanged(row, snapshot(row), true);
				row.phase = row.channelId ? 'closing' : 'sweeping';
				save(row);
			}
			if (row.phase === 'closing') {
				if (closeNotStarted(row.channelId) === true) {
					unchanged(row, snapshot(row), true);
					const result = await node().closeChannel(
						row.channelId,
						false,
						row.address
					);
					if (!result.ok)
						failure(
							'CLOSE_UNAVAILABLE',
							result.error || 'The cooperative close could not start',
							409
						);
				}
			}
			return publicInfo(await reconcile(row));
		} catch (error) {
			// An exception or missing txid cannot prove that shutdown was unsent.
			// Only the engine's authoritative channel state can release this phase.
			if (row.phase === 'closing' && closeNotStarted(row.channelId) === true)
				row.phase = 'preparing';
			row.error = String(error.message ?? error).slice(0, 300);
			save(row);
			throw error;
		}
	};
	const cancel = async (row) => {
		if (row.phase === 'cancelled') {
			await finishHold(row);
			return publicInfo(row);
		}
		if (!['review', 'preparing', 'cancelling'].includes(row.phase))
			failure(
				'DRAIN_ALREADY_COMMITTED',
				'The cooperative close may have started. Keep waiting for its outcome',
				409
			);
		row.phase = 'cancelling';
		save(row);
		if (node().getOnchainSweep(row.requestId))
			await node().cancelOnchainSweep(row.requestId);
		row.phase = 'cancelled';
		delete row.error;
		save(row);
		await finishHold(row);
		return publicInfo(row);
	};

	return {
		available,
		blocksWallet: () => records().some(needsHold),
		active: () => {
			const row = active();
			return row ? publicInfo(row) : null;
		},
		get: (id) => publicInfo(find(id)),
		list: () => records().map(publicInfo),
		quote: (input = {}) =>
			locked(async () => {
				if (
					!idValid(input.requestId) ||
					typeof input.address !== 'string' ||
					!input.address
				)
					failure(
						'INVALID_PARAMS',
						'A destination and stable drain requestId are required'
					);
				otherActive(input.requestId);
				const existing = records().find(
					(entry) => entry.requestId === input.requestId
				);
				if (existing) {
					if (existing.address !== input.address)
						failure(
							'REQUEST_ID_CONFLICT',
							'This drain requestId already names another destination',
							409
						);
					return publicInfo(existing);
				}
				const initial = snapshot();
				const fees = await initial.engine.getFeeEstimates();
				const rate = fees.normal;
				if (!Number.isFinite(rate) || rate <= 0)
					failure(
						'DRAIN_UNAVAILABLE',
						'A current network fee estimate is required',
						409
					);
				const close = initial.channel
					? await initial.engine.closeQuote(
							initial.channel.channelId,
							input.address,
							false
					  )
					: null;
				const sweep = initial.coins.length
					? await initial.engine.quoteOnchain({
							address: input.address,
							max: true,
							satsPerVbyte: rate
					  })
					: null;
				if (!close && !sweep)
					failure(
						'INSUFFICIENT_BALANCE',
						'There is nothing available to send',
						409
					);
				const coinSats = initial.coins.reduce(
					(sum, coin) => sum + coin.valueSats,
					0
				);
				if (
					sweep &&
					(!sats(sweep.maxSendSats) ||
						!sats(sweep.feeSats) ||
						sweep.maxSendSats + sweep.feeSats !== coinSats)
				)
					failure(
						'DRAIN_REVIEW_EXPIRED',
						'The sweep quote does not cover the available coins',
						409
					);
				const row = {
					requestId: input.requestId,
					address: input.address,
					phase: 'review',
					primary: initial.peer,
					channelId: initial.channel?.channelId ?? null,
					channelIdentity: channelIdentity(initial.channel),
					fundingTxid: initial.channel?.fundingTxid ?? null,
					fundingOutputIndex: initial.channel?.fundingOutputIndex ?? null,
					coins: initial.coins,
					close: close
						? { amountSats: close.amountSats, feeSats: close.feeSats }
						: null,
					sweep: sweep
						? { amountSats: sweep.maxSendSats, feeSats: sweep.feeSats }
						: null,
					satsPerVbyte: rate,
					sweepFeeCapSats: sweep?.feeSats ?? 0,
					debitSats: coinSats + (close ? close.amountSats + close.feeSats : 0),
					reviewedDebitSats:
						coinSats + (close ? close.amountSats + close.feeSats : 0),
					amountSats: 0,
					feeSats: 0,
					createdAt: now(),
					expiresAt: now() + 120_000
				};
				unchanged(row, snapshot());
				recalculate(row);
				save(row);
				return publicInfo(row);
			}),
		send: (id) =>
			locked(async () => {
				const row = find(id);
				if (row.phase === 'completed') return publicInfo(await reconcile(row));
				if (row.phase === 'cancelled') return publicInfo(row);
				otherActive(id);
				if (row.phase === 'review') {
					if (now() > row.expiresAt)
						failure(
							'DRAIN_REVIEW_EXPIRED',
							'The wallet drain review expired',
							409
						);
					unchanged(row, snapshot(), true);
					row.phase = 'preparing';
					row.startedAt = now();
					save(row);
				}
				return resume(row);
			}),
		cancel: (id) => locked(() => cancel(find(id))),
		sync: () =>
			locked(async () => {
				const row = active();
				const result = row
					? await (row.phase === 'cancelling' ? cancel(row) : resume(row))
					: null;
				// Prioritize a drain still submitting, but keep tracking every older
				// payout if a reorg has returned several completed drains to pending.
				for (const tracked of records().filter(
					(entry) =>
						entry.requestId !== row?.requestId &&
						((entry.phase === 'completed' && !entry.finalized) ||
							(ACTIVE.has(entry.phase) && entry.fundsCommitted === true))
				))
					await resume(tracked);
				// A crash after the terminal record but before releasing the hold
				// leaves the owner visible in the persisted pause.
				const held = pause.status();
				const terminal =
					held.paused &&
					records().find(
						(entry) =>
							entry.requestId === held.requestId &&
							['completed', 'cancelled'].includes(entry.phase)
					);
				if (terminal) await finishHold(terminal);
				const pending = active();
				return result ?? (pending ? publicInfo(pending) : null);
			})
	};
}

module.exports = { drainCoordinator };
