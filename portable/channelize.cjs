'use strict';
/**
 * One channelize pass: move a lightning-first wallet's confirmed on-chain
 * funds into its home channel, or open one when there is none.
 *
 * The decision rules live in lfbw.cjs, shared with the host manager. This
 * module is the I/O shell around them, kept apart from the runtime so it can
 * be run against a fake node: the manager's version has the same shape
 * (wallet-manager.js `_lfbwChannelize`) and the same three obligations that
 * the runtime used to miss.
 *
 * 1. A failed pass waits CHANNELIZE_RETRY_MS before the next automatic try,
 *    so a peer that refuses is not asked again every event.
 * 2. A dual-funded open the primary refuses falls back to the plain open the
 *    rules already prepared, instead of failing the pass.
 * 3. What was decided is recorded in one small shape the client can read:
 *    a wait with its reason, a move with its amount, or a failure with the
 *    error and code. Request bodies never enter the record.
 */

function decided(now, order) {
	return { at: now, ...order };
}

/**
 * @param {object} deps
 * @param {object} deps.node the running BeignetNode
 * @param {object} deps.record the wallet record (reads lfbw.primaryPubkey, lfbw.trusted)
 * @param {() => object} deps.primary parsed primary with connectHost/connectPort
 * @param {object} deps.rules the lfbw.cjs module
 * @param {boolean} [deps.force] skip the fee wait and the retry backoff
 * @param {number} [deps.now]
 * @param {number} [deps.retryAt] when the next automatic pass may run
 * @param {(event: object) => void} [deps.onDiagnostic]
 * @returns {Promise<{ last: object | null, retryAt: number }>}
 */
async function runChannelize({
	node,
	record,
	primary,
	rules,
	force = false,
	now = Date.now(),
	retryAt = 0,
	onDiagnostic
}) {
	if (!force && now < retryAt) return { last: null, retryAt };
	try {
		const balance = node.getBalance();
		const target = rules.channelizeTarget({
			onchainSats: balance.onchain,
			utxos: node.listUtxos(),
			channels: node.listChannels(),
			primaryPubkey: record.lfbw.primaryPubkey
		});
		if (target.action === 'wait') {
			return { last: decided(now, target), retryAt };
		}
		const fees = await node.getFeeEstimates();
		const feeNormal = fees.normal || 2;
		let order;
		if (target.action === 'splice-in') {
			order = rules.channelizeOrder(target, {
				spliceQuote: node.spliceQuote(
					target.channelId,
					'in',
					rules.perkwFromSatVb(feeNormal)
				),
				feeNormal,
				force
			});
		} else {
			const txQuote = await node.quoteOnchain({
				max: true,
				channelFunding: true,
				satsPerVbyte: feeNormal
			});
			order = rules.channelizeOrder(target, {
				txQuote,
				feeNormal,
				force,
				mode: 'external',
				trusted: record.lfbw.trusted,
				blockHeight: node.getInfo().blockHeight,
				primary: primary(),
				// The primary provides inbound by JIT; see channelizeOrder.
				buyInbound: false
			});
		}
		if (order.action === 'wait') {
			const { action, reason, feeSats, amountSats } = order;
			return {
				last: decided(now, {
					action,
					reason,
					...(feeSats !== undefined ? { feeSats } : {}),
					...(amountSats !== undefined ? { amountSats } : {})
				}),
				retryAt
			};
		}
		if (order.action === 'splice-in') {
			const b = order.body;
			const r = node.spliceIn(b.channelId, b.amountSats, b.feeratePerkw);
			if (!r.ok) {
				const error = Object.assign(new Error(r.error || 'splice refused'), {
					code: r.code
				});
				throw error;
			}
			return {
				last: decided(now, { action: 'splice-in', amountSats: b.amountSats }),
				retryAt
			};
		}
		let fallbackFrom;
		let reason;
		if (order.action === 'open-v2') {
			const b = order.body;
			try {
				node.openChannelV2(b.pubkey, b);
				return {
					last: decided(now, { action: 'open-v2', amountSats: b.amountSats }),
					retryAt
				};
			} catch (error) {
				// The primary would not sell inbound in a dual-funded open. The
				// rules prepared the plain open for exactly this; a refusal here
				// is a reason to run it, not to fail the pass.
				onDiagnostic?.({
					phase: 'channelize-open-v2',
					message: error.message
				});
				fallbackFrom = 'open-v2';
				reason = error.message;
				order = order.fallback;
			}
		}
		const b = order.body;
		await node.connectAndOpenChannel(
			b.pubkey,
			b.host,
			b.port,
			b.amountSats,
			b
		);
		return {
			last: decided(now, {
				action: 'open',
				amountSats: b.amountSats,
				...(fallbackFrom ? { fallbackFrom, reason } : {})
			}),
			retryAt
		};
	} catch (error) {
		const next = now + rules.CHANNELIZE_RETRY_MS;
		onDiagnostic?.({ phase: 'channelize', message: error.message });
		return {
			last: decided(now, {
				action: 'failed',
				error: String(error.message || error),
				...(error.code ? { code: String(error.code) } : {}),
				retryAt: next
			}),
			retryAt: next
		};
	}
}

module.exports = { runChannelize };
