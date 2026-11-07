'use strict';
/**
 * Live regtest for ranked primaries on a phone (coreyphillips/beignet#1924):
 * a device on Native networking ranks two disposable upstream primaries and
 *
 * 1. mirrors the engine's list on its record and reports both connected;
 * 2. is steered by the fill threshold: with every primary above it the
 *    receive goes to the one with the lowest balance, for a JIT quote and an
 *    offline receive quote alike, naming nothing skipped;
 * 3. pays an address out of both channels in one transaction (a composite
 *    channel send), and out of one when the amount fits one;
 * 4. fails over: with the receive target stopped the next JIT quote goes to
 *    the other primary and names the stopped one as skipped at the connect
 *    stage;
 * 5. keeps the list across a restart, mirror and engine identical;
 * 6. behind the byte relay refuses a second primary (run first: one
 *    runtime owns a process);
 * 7. keeps the channel at a primary it removes, listing it as retained.
 *
 * Needs the Docker `bitcoin` and `electrum` containers, the upstream checkout
 * built (BEIGNET_SOURCE_DIR), wallet-core (BEIGNET_WALLET_CORE_DIR) and the
 * relay (BEIGNET_RELAY_DIR).
 */
const assert = require('node:assert/strict');
const { btc, wait, delay, miner, createHarness } = require('./regtest-harness.cjs');

const short = (pk) => String(pk).slice(0, 8);
let dev = null;
/**
 * Give the device a balance on its channel with `node`: a dual-funded open
 * carries no push, so the primary pays an invoice of the device's once the
 * (zero-conf) channel is usable.
 */
async function fund(node, sats, label) {
	const invoice = await dev.rpc('/invoice/create', 'POST', { amountSats: sats, description: label });
	await node.payInvoice(invoice.bolt11);
	const pubkey = node.getInfo().nodeId;
	await wait(`${label}: ${sats} sats paid over the channel`, async () =>
		(await dev.rpc('/channels')).some((c) => c.peerPubkey === pubkey && c.localBalanceSats >= sats)
	);
}
async function dump(label) {
	if (!dev) return;
	try {
		const rec = await dev.record();
		console.log(
			`DIAG ${label}`,
			JSON.stringify(
				{
					setup: rec.lfbw.setup,
					setupError: rec.lfbw.setupError,
					primaries: rec.lfbw.primaries.map((p) => ({
						pubkey: short(p.pubkey),
						setup: p.setup,
						setupError: p.setupError,
						connected: p.connected,
						balanceSat: p.balanceSat,
						isReceiveTarget: p.isReceiveTarget
					})),
					receiveTarget: short(rec.lfbw.receiveTarget),
					retainedPeers: rec.lfbw.retainedPeers,
					lastChannelize: rec.lfbw.lastChannelize,
					peers: (await dev.rpc('/peers')).map((p) => ({ pubkey: short(p.pubkey), state: p.state })),
					channels: (await dev.rpc('/channels')).map((c) => ({
						peer: short(c.peerPubkey),
						state: c.state,
						htlcUsable: c.htlcUsable,
						localBalanceSats: c.localBalanceSats,
						remoteBalanceSats: c.remoteBalanceSats
					}))
				},
				null,
				1
			)
		);
	} catch (e) {
		console.log(`DIAG ${label} failed: ${e.message}`);
	}
}

(async () => {
	const harness = await createHarness({ prefix: 'beignet-primaries-', ffor: true });
	const { primary: A } = harness;
	const aKey = A.getInfo().nodeId;
	try {
		const B = await harness.secondPrimary('second');

		// ── 6. the relay keeps one primary ─────────────────────────────────
		// One runtime owns a process, so the relayed device runs first and is
		// closed before the native one is created.
		const relayed = await harness.device('relayed');
		await wait('the relayed wallet is set up', async () => (await relayed.record()).lfbw.setup === 'ready');
		await assert.rejects(
			relayed.rpc('/primaries/add', 'POST', { pubkey: B.pubkey, host: '127.0.0.1', port: B.port }),
			(e) => e.code === 'TRANSPORT_SINGLE_PEER'
		);
		assert.equal((await relayed.rpc('/primaries')).primaries.length, 1);
		await relayed.runtime.close();
		console.log('PASS behind the relay a second primary is refused before the engine is touched');

		dev = await harness.device('ranked', { socketFactory: harness.nativeSocketFactory() });
		const info = await dev.rpc('/info');
		await wait('the one-primary wallet is set up on A', async () => {
			const rec = await dev.record();
			return rec.lfbw.setup === 'ready' && rec.lfbw.primaries.length === 1 && rec.lfbw.primaries[0].connected;
		});
		// A legacy-shaped record migrated at creation: the engine holds the one
		// primary and the record says it is synced.
		let policy = await dev.rpc('/primaries');
		assert.deepEqual(policy.primaries.map((p) => p.pubkey), [aKey]);
		assert.equal(policy.receiveTarget, aKey);
		assert.equal(policy.fillThresholdSat, null);
		let rec = await dev.record();
		assert.equal(rec.lfbw.primaryPubkey, aKey);
		assert.equal(rec.lfbw.receiveTarget, aKey);
		console.log('PASS the engine list and the record mirror hold the one primary');

		// A opens a channel to the device and pushes it a balance.
		A.addTrustedPeer(info.nodeId);
		A.openChannel(info.nodeId, 400000, 0, 2, false, true);
		await wait('channel with A usable', async () =>
			(await dev.rpc('/channels')).some((c) => c.peerPubkey === aKey && c.htlcUsable)
		);
		btc('-generate', '1');
		await fund(A, 100000, 'balance from A');

		// ── 1. add B ────────────────────────────────────────────────────────
		const added = await dev.rpc('/primaries/add', 'POST', { pubkey: B.pubkey, host: '127.0.0.1', port: B.port });
		assert.deepEqual(added.primaries.map((p) => p.pubkey), [aKey, B.pubkey]);
		await wait('B is set up and connected on the record', async () => {
			const r = await dev.record();
			const b = r.lfbw.primaries.find((p) => p.pubkey === B.pubkey);
			return b && b.setup === 'ready' && b.connected && r.lfbw.primariesSyncedAt > 0;
		});
		rec = await dev.record();
		assert.deepEqual(rec.lfbw.primaries.map((p) => p.pubkey), [aKey, B.pubkey]);
		assert.equal(rec.lfbw.primaryPubkey, aKey, 'the scalar mirror is rank 1');
		assert.equal(rec.lfbw.setup, 'ready');
		B.node.addTrustedPeer(info.nodeId);
		B.node.openChannel(info.nodeId, 400000, 0, 2, false, true);
		await wait('channel with B usable', async () =>
			(await dev.rpc('/channels')).some((c) => c.peerPubkey === B.pubkey && c.htlcUsable)
		);
		btc('-generate', '1');
		await fund(B.node, 150000, 'balance from B');
		await dev.client.refreshWallet();
		console.log('PASS the second primary is listed, trusted, connected and holds a channel');

		// ── 2. threshold steering ───────────────────────────────────────────
		policy = await dev.rpc('/primaries/threshold', 'POST', { fillThresholdSat: 1000 });
		assert.equal(policy.fillThresholdSat, 1000);
		// Both above the target: the lowest local balance (A's channel holds
		// 100,000 against B's 150,000) is the receive target.
		await wait('A is the receive target by lowest balance', async () => (await dev.rpc('/primaries')).receiveTarget === aKey);
		const jit = await dev.rpc('/jit/quote?amountSats=50000');
		assert.equal(jit.lspPubkey, aKey);
		assert.equal(jit.skipped, undefined, 'nothing was passed over');
		const offline = await dev.rpc('/receive/quote?amountSats=20000');
		assert.equal(offline.peer, aKey);
		assert.equal(offline.skipped, undefined);
		const summary = await dev.rpc('/receive/offline');
		assert.deepEqual(summary.peers.map((p) => p.pubkey), [aKey, B.pubkey], 'peers in selection order');
		assert.equal(summary.available, true);
		console.log('PASS a JIT quote and an offline quote that name no peer go to the receive target');

		// ── 3. channel send out of both channels in one transaction ────────
		const address = btc('getnewaddress');
		// A zero-conf channel joins a channel send once its funding has
		// confirmed as the engine sees it, so blocks are mined until the
		// composite quote names both channels.
		const mine = miner(2000);
		const composite = await wait('both channels confirmed enough for a channel send', async () => {
			mine();
			await dev.client.refreshWallet().catch(() => {});
			const quote = await dev.rpc('/channel-send/quote', 'POST', { address, amountSats: 200000, feeratePerkw: 1000 });
			return quote.kind === 'composite' && quote.channels.length === 2 ? quote : null;
		}, 180000);
		const single = await dev.rpc('/channel-send/quote', 'POST', { address, amountSats: 50000, feeratePerkw: 1000 });
		assert.equal(single.kind, 'single');
		const started = await dev.rpc('/channel-send/execute', 'POST', { quoteId: composite.quoteId });
		assert.equal(started.kind, 'composite');
		const locked = await wait('the composite send locks on both channels', async () => {
			mine();
			await dev.client.refreshWallet().catch(() => {});
			const status = await dev.rpc(`/channel-send/status?id=${composite.quoteId}`);
			if (['ABORTED', 'CONFLICTED'].includes(status.stage)) throw new Error(`composite ${status.stage}: ${status.reason}`);
			return status.stage === 'LOCKED' ? status : null;
		}, 180000);
		assert.ok(locked.txid);
		const tx = JSON.parse(btc('getrawtransaction', locked.txid, 'true'));
		assert.ok(tx.vout.some((o) => o.scriptPubKey.address === address && Math.round(o.value * 1e8) === 200000), 'one output pays the address');
		await wait('both channels are NORMAL again', async () =>
			(await dev.rpc('/channels')).filter((c) => [aKey, B.pubkey].includes(c.peerPubkey) && c.state !== 'CLOSED').every((c) => c.state === 'NORMAL' && c.htlcUsable)
		);
		console.log('PASS one transaction paid the address out of both channels');

		// ── 4. failover when the receive target is down ─────────────────────
		const target = (await dev.rpc('/primaries')).receiveTarget;
		const other = target === aKey ? B.pubkey : aKey;
		if (target === aKey) await A.gracefulShutdown(5000);
		else await B.node.gracefulShutdown(5000);
		await wait('the stopped primary is no longer connected', async () => {
			const r = await dev.record();
			return r.lfbw.primaries.find((p) => p.pubkey === target).connected === false;
		});
		const steered = await dev.rpc('/jit/quote?amountSats=50000');
		assert.equal(steered.lspPubkey, other);
		assert.equal(steered.skipped[0].pubkey, target);
		assert.equal(steered.skipped[0].stage, 'connect');
		rec = await dev.record();
		assert.equal(rec.lfbw.setup, 'ready', 'the list is ready while one primary answers');
		console.log(`PASS with ${short(target)} down the JIT quote went to ${short(other)} and named the skip`);

		// ── 5. restart keeps the list ──────────────────────────────────────
		const beforeRestart = await dev.rpc('/primaries');
		await dev.restart();
		await wait('the restarted wallet lists the same primaries', async () => {
			const r = await dev.record();
			return r.status === 'running' && r.lfbw.primaries.length === 2 && r.lfbw.primariesSyncedAt > 0;
		});
		const afterRestart = await dev.rpc('/primaries');
		assert.deepEqual(afterRestart.primaries.map((p) => p.pubkey), beforeRestart.primaries.map((p) => p.pubkey));
		assert.equal(afterRestart.fillThresholdSat, 1000);
		rec = await dev.record();
		assert.deepEqual(rec.lfbw.primaries.map((p) => p.pubkey), afterRestart.primaries.map((p) => p.pubkey));
		console.log('PASS the list and its threshold survive a restart, mirror and engine alike');

		// ── 7. removing a primary keeps its channel ────────────────────────
		const removed = await dev.rpc('/primaries/remove', 'POST', { pubkey: target });
		assert.deepEqual(removed.primaries.map((p) => p.pubkey), [other]);
		rec = await dev.record();
		assert.deepEqual(rec.lfbw.primaries.map((p) => p.pubkey), [other]);
		assert.equal(rec.lfbw.primaryPubkey, other);
		assert.ok((await dev.rpc('/channels')).some((c) => c.peerPubkey === target && c.state !== 'CLOSED'), 'the channel with the removed primary is still listed');
		assert.equal(rec.lfbw.retainedPeers[0].pubkey, target);
		assert.equal(rec.lfbw.previousPrimary.pubkey, target);
		assert.equal(rec.lfbw.receiveTarget, other);
		console.log('PASS a removed primary keeps its channel and is listed as retained');
		console.log('ALL PASS');
	} catch (error) {
		await dump('failure');
		throw error;
	} finally {
		await harness.close();
	}
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
