'use strict';
/**
 * Live regtest for a Porch link as a primary (coreyphillips/beignet#1980).
 *
 * An upstream node with no TCP listener waits at a local Porch relay started
 * from the same upstream build. The only way to reach it is its link,
 * `pubkey@ws://127.0.0.1:<port>/v1/p/<route>`. A device
 *
 * 1. behind the byte relay is refused the link before the engine is touched
 *    (run first: one runtime owns a process);
 * 2. on Native networking is created with the link as its only primary,
 *    connects through the relay, and names no TCP address for the node in
 *    its direct-funding policy;
 * 3. takes a channel from the node and pays both ways over it;
 * 4. reconnects by itself after the relay restarts, and pays again;
 * 5. reconnects after its own restart, and pays again;
 * 6. as a second device, adds the link to a wallet whose first primary is an
 *    ordinary TCP one, and holds both.
 *
 * The device's dials go through the portable net adapter to the harness's
 * socket factory, as they do on a phone. That factory refuses TLS, so wss://
 * is not run here: portable-tests/peer-route.test.cjs pins what the adapter
 * is asked for.
 *
 * Needs the Docker `bitcoin` and `electrum` containers, an upstream build
 * that has the Porch relay (BEIGNET_SOURCE_DIR, Beignet 0.39.0 or later),
 * wallet-core with the Porch parser (BEIGNET_WALLET_CORE_DIR) and the byte
 * relay (BEIGNET_RELAY_DIR).
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { btc, wait, delay, freePort, createHarness } = require('./regtest-harness.cjs');

const short = (pk) => String(pk).slice(0, 8);
let dev = null;
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
					primaries: (rec.lfbw.primaries || []).map((p) => ({
						pubkey: short(p.pubkey),
						uri: String(p.uri).slice(67),
						setup: p.setup,
						setupError: p.setupError,
						connected: p.connected
					})),
					peers: (await dev.rpc('/peers')).map((p) => ({
						pubkey: short(p.pubkey),
						state: p.state,
						transport: p.transport,
						host: p.host
					})),
					channels: (await dev.rpc('/channels')).map((c) => ({
						peer: short(c.peerPubkey),
						state: c.state,
						htlcUsable: c.htlcUsable,
						localBalanceSats: c.localBalanceSats
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
	const harness = await createHarness({ prefix: 'beignet-porch-' });
	const { primary: tcpPrimary, BeignetNode, sourceDir, temp } = harness;
	const { PorchRelay } = require(path.join(sourceDir, 'dist/cli/porch-relay.js'));
	const relayPort = await freePort();
	const authority = `127.0.0.1:${relayPort}`;
	const startRelay = async () => {
		const relay = new PorchRelay({ authorities: [authority] });
		relay.on('error', () => {});
		await relay.listen(relayPort, '127.0.0.1');
		return relay;
	};
	let relay = await startRelay();
	let hosted = null;
	try {
		// The hosted node: no listenPort, so nothing can dial it. It dials out
		// to the relay and waits there.
		hosted = await BeignetNode.create({
			network: 'regtest',
			dataDir: path.join(temp, 'hosted'),
			allowMultipleInstances: true,
			electrumHost: '127.0.0.1',
			electrumPort: 60001,
			electrumTls: false,
			autoBootstrap: false,
			autoGossipSync: false,
			forwardingEnabled: true,
			jitReceive: { enabled: true, flatFeeSat: 0, feePpm: 0 },
			dfRelay: true,
			porchRelays: [`ws://${authority}`],
			logger: {
				debug() {},
				info() {},
				warn: (...args) =>
					process.env.HARNESS_ENGINE_LOG && console.log('[hosted warn]', ...args),
				error: (...args) =>
					process.env.HARNESS_ENGINE_LOG && console.log('[hosted error]', ...args)
			}
		});
		const hostedKey = hosted.getInfo().nodeId;
		assert.equal(hosted.getInfo().listenPort, undefined, 'the hosted node has no TCP listener');
		await hosted.refreshWallet();
		btc('sendtoaddress', await hosted.getNewAddress(), '0.05000000');
		btc('-generate', '1');
		await delay(2000);
		await hosted.refreshWallet();
		await wait('the hosted node is funded with regtest coins', () => hosted.getBalance().onchain >= 5000000);
		const link = await wait('the hosted node waits at the relay and has a link', () => {
			const links = hosted.getPorchLinks();
			return links.listening && relay.stats().standbys > 0 ? links.links[0]?.uris[0] : null;
		});
		assert.match(link, new RegExp(`^${hostedKey}@ws://127\\.0\\.0\\.1:${relayPort}/v1/p/[a-z2-7]{32}$`));

		// ── 1. the byte relay cannot dial another relay ─────────────────────
		const relayed = await harness.device('relayed');
		await wait('the relayed wallet is set up', async () => (await relayed.record()).lfbw.setup === 'ready');
		assert.equal((await relayed.runtime.request({ path: '/api/config' })).porchPrimaryAvailable, false);
		await assert.rejects(
			relayed.rpc('/primaries/add', 'POST', { pubkey: hostedKey, uri: link }),
			(e) => e.code === 'PORCH_UNSUPPORTED'
		);
		assert.equal((await relayed.rpc('/primaries')).primaries.length, 1);
		await relayed.runtime.close();
		console.log('PASS behind the byte relay a Porch link is refused before the engine is touched');

		// ── 2. a wallet whose only primary is the link ─────────────────────
		const pairedBefore = relay.stats().paired;
		dev = await harness.device('porch', {
			socketFactory: harness.nativeSocketFactory(),
			primaryUri: link
		});
		assert.equal((await dev.runtime.request({ path: '/api/config' })).porchPrimaryAvailable, true);
		const info = await dev.rpc('/info');
		await wait('the wallet is set up on the hosted node through the relay', async () => {
			const rec = await dev.record();
			return rec.lfbw.setup === 'ready' && rec.lfbw.primaries.length === 1 && rec.lfbw.primaries[0].connected;
		});
		let rec = await dev.record();
		assert.equal(rec.lfbw.primaryUri, link);
		assert.equal(rec.lfbw.primaryPubkey, hostedKey);
		const peer = (await dev.rpc('/peers')).find((p) => p.pubkey === hostedKey);
		assert.equal(peer.transport, 'ws');
		assert.ok(relay.stats().paired > pairedBefore, 'the relay paired the device with a standby');
		const seen = hosted.listPeers().find((p) => p.pubkey === info.nodeId);
		assert.ok(seen, 'the hosted node sees the device');
		assert.ok(seen.porch, 'and names the relay it came through');
		assert.deepEqual((await dev.rpc('/primaries')).primaries.map((p) => [p.pubkey, p.uri]), [[hostedKey, link]]);
		const diagnostics = await dev.client.diagnostics();
		assert.equal(diagnostics.primaryTransport, 'ws');
		assert.equal(diagnostics.primaryConnected, true);
		const funding = await dev.rpc('/direct-funding/config');
		assert.equal(funding.lspPubkey, hostedKey);
		assert.equal(funding.lspHost ?? null, null, "the relay is not the node's TCP address");
		assert.equal(funding.lspPort ?? null, null);
		console.log('PASS a wallet created with a Porch link connects through the relay and signs no TCP address for the node');

		// ── 3. a channel and payments both ways ────────────────────────────
		hosted.addTrustedPeer(info.nodeId);
		hosted.openChannel(info.nodeId, 400000, 0, 2, false, true);
		await wait('channel with the hosted node usable', async () =>
			(await dev.rpc('/channels')).some((c) => c.peerPubkey === hostedKey && c.htlcUsable)
		);
		btc('-generate', '1');
		const receive = async (sats, label) => {
			const invoice = await dev.rpc('/invoice/create', 'POST', { amountSats: sats, description: label });
			const before = (await dev.rpc('/channels')).find((c) => c.peerPubkey === hostedKey).localBalanceSats;
			await hosted.payInvoice(invoice.bolt11);
			await wait(`${label}: ${sats} sats received`, async () =>
				(await dev.rpc('/channels')).some((c) => c.peerPubkey === hostedKey && c.localBalanceSats >= before + sats)
			);
		};
		const send = async (sats, label) => {
			const invoice = hosted.createInvoice(sats, label, 300);
			const review = await wait(`${label}: a route`, () => dev.client.prepareSend({ request: invoice.bolt11 }), 45000);
			const sent = await dev.client.send(review);
			assert.equal(sent.status, 'completed', sent.message);
			await wait(`${label}: ${sats} sats sent`, async () =>
				(await dev.client.snapshot()).activity.some(
					(x) => x.paymentHash === invoice.paymentHash && x.kind === 'sent' && x.status === 'completed'
				)
			);
		};
		await receive(100000, 'first receive');
		await send(20000, 'first send');
		console.log('PASS the device received and sent over a channel with the hosted node');

		// ── 4. the relay restarts ──────────────────────────────────────────
		await relay.close();
		await wait('the device sees the hosted node gone', async () =>
			(await dev.record()).lfbw.primaries[0].connected === false
		);
		relay = await startRelay();
		await wait('the hosted node waits at the new relay', () => relay.stats().standbys > 0, 180000);
		await wait('the device is back through the relay by itself', async () => {
			const c = (await dev.rpc('/channels')).find((ch) => ch.peerPubkey === hostedKey);
			return (await dev.record()).lfbw.primaries[0].connected && c && c.htlcUsable;
		}, 180000);
		await receive(5000, 'receive after the relay restart');
		await send(3000, 'send after the relay restart');
		console.log('PASS after a relay restart the device reconnected by its link and paid both ways');

		// ── 5. the device restarts ─────────────────────────────────────────
		await dev.restart();
		await wait('the restarted device is back through the relay', async () => {
			const r = await dev.record();
			const c = (await dev.rpc('/channels').catch(() => [])).find((ch) => ch.peerPubkey === hostedKey);
			return r.status === 'running' && r.lfbw.primaries[0].connected && c && c.htlcUsable;
		}, 180000);
		rec = await dev.record();
		assert.equal(rec.lfbw.primaryUri, link, 'the link is kept with its route');
		await receive(5000, 'receive after the device restart');
		await send(3000, 'send after the device restart');
		console.log('PASS after its own restart the device reconnected by its link and paid both ways');
		await dev.runtime.close();

		// ── 6. the link as a second primary ────────────────────────────────
		dev = await harness.device('ranked', { socketFactory: harness.nativeSocketFactory() });
		const tcpKey = tcpPrimary.getInfo().nodeId;
		await wait('the one-primary wallet is set up on the TCP primary', async () => {
			const r = await dev.record();
			return r.lfbw.setup === 'ready' && r.lfbw.primaries.length === 1 && r.lfbw.primaries[0].connected;
		});
		const added = await dev.client.addPrimary({ uri: link });
		assert.deepEqual(added.primaries.map((p) => p.pubkey), [tcpKey, hostedKey]);
		await wait('the Porch primary is set up and connected beside the TCP one', async () => {
			const r = await dev.record();
			const p = r.lfbw.primaries.find((e) => e.pubkey === hostedKey);
			return p && p.setup === 'ready' && p.connected && r.lfbw.primaries[0].connected && r.lfbw.primariesSyncedAt > 0;
		});
		rec = await dev.record();
		assert.deepEqual(rec.lfbw.primaries.map((p) => p.uri), [harness.primaryUri, link]);
		const policy = await dev.rpc('/primaries');
		assert.equal(policy.primaries[1].uri, link, 'the engine holds the link with its route');
		const peers = await dev.rpc('/peers');
		assert.equal(peers.find((p) => p.pubkey === hostedKey).transport, 'ws');
		const ranked = await dev.client.diagnostics();
		assert.deepEqual(ranked.primaries.map((p) => [p.pubkey, p.connected, p.transport]), [
			[tcpKey, true, 'tcp'],
			[hostedKey, true, 'ws']
		]);
		// Rank 1 is the TCP primary, so the funding policy still names it.
		assert.equal((await dev.rpc('/direct-funding/config')).lspPubkey, tcpKey);
		console.log('PASS a Porch link added as a second primary connects beside a TCP one');
		console.log('ALL PASS');
	} catch (error) {
		await dump('failure');
		throw error;
	} finally {
		await harness.close();
		if (hosted) await hosted.gracefulShutdown(5000).catch(() => {});
		await relay.close().catch(() => {});
	}
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
