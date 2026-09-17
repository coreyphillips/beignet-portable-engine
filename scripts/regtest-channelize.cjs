'use strict';
/**
 * Live regtest for the two paths a phone's on-chain money takes into its
 * channel, and for paying another Beignet wallet's request by direct funding.
 *
 * 1. A confirmed deposit into a wallet that already has a home channel is
 *    spliced in: the channel grows, locks, and the sendable balance rises.
 * 2. A confirmed deposit into a wallet with no channel opens one (dual-funded
 *    or the plain fallback) that becomes usable after confirmations.
 * 3. A wallet holding one confirmed coin below the channelize floor pays a
 *    unified request that carries a direct-funding envelope, and the
 *    recipient's single home channel grows by one transaction.
 *
 * Needs the Docker `bitcoin` and `electrum` containers and the upstream
 * checkout built (BEIGNET_SOURCE_DIR).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { btc, wait, delay, miner, createHarness } = require('./regtest-harness.cjs');
const CHANNELIZE_FLOOR_SATS = 25000;

/** Everything worth reading when a wait times out. */
async function dump(label, dev) {
	try {
		const rec = await dev.record();
		console.log(
			`DIAG ${label}`,
			JSON.stringify(
				{
					setup: rec.lfbw.setup,
					setupError: rec.lfbw.setupError,
					lastChannelize: rec.lfbw.lastChannelize,
					lastOffer: rec.lfbw.lastOffer,
					unpairedFunding: rec.lfbw.unpairedFunding,
					info: { blockHeight: (await dev.rpc('/info')).blockHeight },
					balance: await dev.rpc('/balance'),
					liquidity: await dev.rpc('/liquidity'),
					utxos: await dev.rpc('/utxos'),
					peers: (await dev.rpc('/peers')).map((p) => ({ pubkey: p.pubkey.slice(0, 8), state: p.state })),
					channels: (await dev.rpc('/channels')).map((c) => ({
						state: c.state,
						htlcUsable: c.htlcUsable,
						fundingConfirmed: c.fundingConfirmed,
						capacitySats: c.capacitySats,
						localBalanceSats: c.localBalanceSats,
						pendingSpliceLocalBalanceSats: c.pendingSpliceLocalBalanceSats,
						payThroughSplice: c.payThroughSplice,
						fundingTxid: c.fundingTxid
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
let current = null;
/** Run the payer in a child process and collect its step lines. */
function runPayerChild(env) {
	return new Promise((resolve, reject) => {
		const out = {};
		const proc = spawn(process.execPath, [path.join(__dirname, 'regtest-payer-child.cjs')], {
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let buffer = '';
		proc.stdout.on('data', (d) => {
			buffer += String(d);
			let nl;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				const m = /^CHILD (\w+) (.*)$/.exec(line);
				if (m) {
					const value = JSON.parse(m[2]);
					if (m[1] === 'diag') console.log('payer diag', JSON.stringify(value));
					else out[m[1]] = value;
				}
			}
		});
		proc.stderr.on('data', (d) => {
			const t = String(d);
			if (!/^\s+at |close connect/.test(t)) process.stderr.write('payer: ' + t);
		});
		proc.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`payer exited ${code}: ${JSON.stringify(out)}`))));
	});
}
(async () => {
	const harness = await createHarness({ prefix: 'beignet-channelize-' });
	const { primary } = harness;
		try {
		// ── 1. splice-in with a home channel ────────────────────────────────
		const a = await harness.device('splice-in');
		current = a;
		const aInfo = await a.rpc('/info');
		primary.addTrustedPeer(aInfo.nodeId);
		primary.openChannel(aInfo.nodeId, 200000, 0, 2, false, true);
		await wait('home channel usable before any deposit', async () =>
			(await a.rpc('/channels')).some((c) => c.htlcUsable)
		);
		btc('-generate', '1');
		await a.client.refreshWallet();
		await wait('setup ready on the splice-in wallet', async () =>
			(await a.record()).lfbw.setup === 'ready'
		);
		const before = (await a.rpc('/channels')).find((c) => c.htlcUsable);
		const sendableBefore = (await a.rpc('/liquidity')).sendableSats;
		const { address } = await a.rpc('/address/new', 'POST', {});
		btc('sendtoaddress', address, '0.00030000');
		await wait('deposit seen unconfirmed and left alone', async () => {
			await a.client.refreshWallet();
			const utxos = await a.rpc('/utxos');
			const last = (await a.record()).lfbw.lastChannelize;
			return (
				utxos.some((u) => u.valueSats === 30000 && !(u.height > 0)) &&
				(!last || last.action === 'wait')
			);
		});
		btc('-generate', '1');
		await delay(1500);
		await a.client.refreshWallet();
		// The record holds the LAST decision: a splice that has already locked
		// is followed by a below-floor wait, so the outcome counts as well.
		await wait('the confirmed deposit is spliced into the home channel', async () => {
			await a.client.refreshWallet();
			const last = (await a.record()).lfbw.lastChannelize;
			if (last && last.action === 'failed')
				throw new Error(`channelize failed: ${last.error} (${last.code})`);
			const home = (await a.rpc('/channels')).find((c) => c.peerPubkey === before.peerPubkey && c.state !== 'CLOSED');
			return (
				(last && last.action === 'splice-in' && last.amountSats > 0) ||
				(home && (home.state === 'SPLICING' || home.capacitySats > before.capacitySats))
			);
		});
		console.log('notes after the deposit:', JSON.stringify((await a.client.snapshot()).notes));
		const mine = miner();
		await wait(
			'the splice locks: one larger home channel and a higher sendable balance',
			async () => {
				mine();
				await a.client.refreshWallet().catch(() => {});
				const channels = (await a.rpc('/channels')).filter(
					(c) => c.peerPubkey === before.peerPubkey && c.state !== 'CLOSED'
				);
				const home = channels.find((c) => c.htlcUsable);
				const liquidity = await a.rpc('/liquidity');
				const balance = await a.rpc('/balance');
				return (
					channels.length === 1 &&
					home &&
					home.state === 'NORMAL' &&
					home.capacitySats >= before.capacitySats + CHANNELIZE_FLOOR_SATS &&
					liquidity.sendableSats > sendableBefore &&
					balance.onchain < CHANNELIZE_FLOOR_SATS
				);
			},
			240000
		);
		const snapshotA = await a.client.snapshot();
		assert.ok(snapshotA.balance.availableSats > sendableBefore, 'ready to send rose');
		console.log('PASS splice-in: ready to send', sendableBefore, '->', snapshotA.balance.availableSats);

		// ── 3. another phone pays this wallet's request by direct funding ───
		// The payer is a second portable runtime in its own process (one
		// process owns one runtime), holding one confirmed coin below the
		// channelize floor so it has something to fund with.
		const homeBefore = (await a.rpc('/channels')).find((c) => c.htlcUsable);
		const quote = await a.client.quoteReceive({ amountSats: 15000, description: 'Direct funding' });
		const request = await a.client.receive(quote);
		assert.ok(new URL(request.uri).searchParams.get('bgnq'), 'the request carries an envelope');
		const child = await runPayerChild({
			RELAY_PORT: String(harness.relayPort),
			TOKEN: harness.token,
			PRIMARY_URI: harness.primaryUri,
			VOLUME: path.join(harness.temp, 'payer'),
			REQUEST_URI: request.uri
		});
		assert.ok(child.review, 'the payer produced a review');
		assert.equal(child.review.route, 'bitcoin');
		assert.equal(child.review.method, 'direct-funding', JSON.stringify(child.review.warnings));
		assert.equal(child.review.feeSats, 1000);
		console.log('PASS the payer reviews the request as a direct funding');
		assert.ok(child.sent, 'the payer sent');
		assert.ok(['pending', 'completed'].includes(child.sent.status), child.sent.message);
		assert.ok(child.sent.txid, 'the funding transaction id is reported');
		console.log('PASS the payer sent it as a direct funding', child.sent.txid);
		await wait('the wallet accepted the offer as an unpaired splice', async () => {
			const rec = await a.record();
			const channels = (await a.rpc('/channels')).filter(
				(ch) => ch.peerPubkey === homeBefore.peerPubkey && ch.state !== 'CLOSED'
			);
			// The offer record moves on from accepted to completed as soon as the
			// splice locks, which on regtest can be before this reads it.
			return (
				rec.lfbw.lastOffer &&
				['accepted', 'completed'].includes(rec.lfbw.lastOffer.state) &&
				channels.length === 1
			);
		});
		const mineC = miner();
		await wait(
			'one transaction grows the home channel by the payment',
			async () => {
				mineC();
				await a.client.refreshWallet().catch(() => {});
				const channels = (await a.rpc('/channels')).filter(
					(ch) => ch.peerPubkey === homeBefore.peerPubkey && ch.state !== 'CLOSED'
				);
				const home = channels.find((ch) => ch.htlcUsable);
				return (
					channels.length === 1 &&
					home &&
					home.state === 'NORMAL' &&
					home.capacitySats >= homeBefore.capacitySats + 15000 &&
					home.localBalanceSats >= homeBefore.localBalanceSats + 15000
				);
			},
			240000
		);
		const tx = JSON.parse(btc('getrawtransaction', child.sent.txid, 'true'));
		assert.ok(tx.confirmations >= 1, 'the funding transaction confirmed');
		assert.ok(
			tx.vin.some((input) => input.txid === child.coin.depositTxid),
			'the funding spends the payer coin directly'
		);
		console.log('PASS one transaction, from the payer coin to the recipient channel');
		assert.ok(child.row && child.row.status === 'completed' && child.row.txid === child.sent.txid, 'payer row completed');
		assert.equal((child.utxos || []).some((u) => u.valueSats === 20000), false, 'the payer coin is spent');
		console.log('PASS the payer history settles to completed');
		// One portable runtime may own the process at a time.
		await a.runtime.close();

		// ── 2. open with no channel ─────────────────────────────────────────
		const b = await harness.device('open');
		current = b;
		await wait('setup ready on the fresh wallet', async () =>
			(await b.record()).lfbw.setup === 'ready'
		);
		assert.equal((await b.rpc('/channels')).length, 0, 'no channel yet');
		const bAddress = (await b.rpc('/address/new', 'POST', {})).address;
		btc('sendtoaddress', bAddress, '0.00050000');
		btc('-generate', '1');
		await delay(1500);
		await b.client.refreshWallet();
		const opened = await wait('the confirmed deposit opens a channel', async () => {
			await b.client.refreshWallet();
			const last = (await b.record()).lfbw.lastChannelize;
			if (last && last.action === 'failed')
				throw new Error(`channelize failed: ${last.error} (${last.code})`);
			if (last && ['open-v2', 'open'].includes(last.action)) return last;
			const channels = await b.rpc('/channels');
			return channels.length > 0 ? { action: 'observed', channels: channels.map((c) => c.state) } : null;
		});
		console.log('open decision:', JSON.stringify(opened));
		const mineB = miner();
		await wait(
			'the new channel becomes usable with its funding confirmed',
			async () => {
				mineB();
				await b.client.refreshWallet().catch(() => {});
				const home = (await b.rpc('/channels')).find((c) => c.htlcUsable);
				const liquidity = await b.rpc('/liquidity');
				const balance = await b.rpc('/balance');
				return (
					home &&
					home.fundingConfirmed === true &&
					liquidity.sendableSats > 0 &&
					balance.onchain < CHANNELIZE_FLOOR_SATS
				);
			},
			240000
		);
		assert.equal((await b.rpc('/channels')).filter((c) => c.htlcUsable).length, 1);
		console.log('PASS open: ready to send', (await b.client.snapshot()).balance.availableSats);
		await b.runtime.close();

		console.log('PASS regtest-channelize: all checks passed');
	} catch (error) {
		if (current) await dump(current.name, current);
		throw error;
	} finally {
		await harness.close();
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
