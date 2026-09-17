'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
	createPortableRuntime,
	createRelaySocketFactory
} = require('../dist/portable.cjs');
const { createSqlJsDatabaseFactory } = require('../dist/sqljs.cjs');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const btc = (...args) =>
	execFileSync(
		'docker',
		[
			'exec',
			process.env.BEIGNET_REGTEST_BITCOIN || 'bitcoin',
			'bitcoin-cli',
			'-rpcport=43782',
			'-rpcuser=polaruser',
			'-rpcpassword=polarpass',
			'-rpcwallet=default',
			...args
		],
		{ encoding: 'utf8', timeout: 20000 }
	).trim();
async function wait(label, fn, timeout = 120000) {
	const until = Date.now() + timeout;
	let last;
	while (Date.now() < until) {
		try {
			const value = await fn();
			if (value) {
				console.log('PASS ' + label);
				return value;
			}
		} catch (e) {
			last = e;
		}
		await delay(500);
	}
	throw Error(`${label} timed out${last ? ': ' + last.message : ''}`);
}
(async () => {
	assert.equal(JSON.parse(btc('getblockchaininfo')).chain, 'regtest');
	const { BeignetNode } = require(path.join(
		process.env.BEIGNET_SOURCE_DIR ||
			'/Users/coreyphillips/Documents/synonym/beignet',
		'dist/cli/beignet-node.js'
	));
	const { EmbeddedWalletClient } = await import('../../shared/src/index.js');
	const { createRelay } = await import('../../beignet-relay/relay.js');
	const WebSocket = require('../../beignet-relay/node_modules/ws');
	const temp = fs.mkdtempSync(
		path.join(os.tmpdir(), 'beignet-portable-funded-')
	);
	const file = (p) =>
		path.join(temp, 'device-' + Buffer.from(p).toString('hex'));
	const volume = {
		read: (p) => (fs.existsSync(file(p)) ? fs.readFileSync(file(p)) : null),
		write(p, bytes) {
			const dest = file(p);
			const fd = fs.openSync(dest + '.tmp', 'w', 0o600);
			try {
				fs.writeFileSync(fd, bytes);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(dest + '.tmp', dest);
		},
		remove: (p) => fs.rmSync(file(p), { force: true }),
		rename: (a, b) => fs.renameSync(file(a), file(b))
	};
	const databaseFactory = await createSqlJsDatabaseFactory({
		load: volume.read,
		save: volume.write
	});
	let primary, relay, runtime, stranger;
	try {
		const probe = net.createServer();
		await new Promise((r) => probe.listen(0, '127.0.0.1', r));
		const peerPort = probe.address().port;
		await new Promise((r) => probe.close(r));
		primary = await BeignetNode.create({
			network: 'regtest',
			dataDir: path.join(temp, 'primary'),
			allowMultipleInstances: true,
			electrumHost: '127.0.0.1',
			electrumPort: 60001,
			electrumTls: false,
			listenPort: peerPort,
			autoBootstrap: false,
			autoGossipSync: false,
			forwardingEnabled: true,
			jitReceive: { enabled: true, flatFeeSat: 0, feePpm: 0 },
			dfRelay: true,
			logger: { debug() {}, info() {}, warn() {}, error() {} }
		});
		await primary.refreshWallet();
		const deposit = await primary.getNewAddress();
		btc('sendtoaddress', deposit, '0.05000000');
		btc('-generate', '1');
		await delay(2000);
		await primary.refreshWallet();
		await wait(
			'disposable primary funded with regtest coins',
			() => primary.getBalance().onchain >= 5000000
		);
		const token = crypto.randomBytes(32).toString('base64url');
		const electrum = { host: 'electrum.relay', port: 50001, tls: false };
		relay = createRelay({
			token,
			origins: ['http://127.0.0.1'],
			allowNoOrigin: true,
			electrum: { host: '127.0.0.1', port: 60001, tls: false },
			peer: { host: '127.0.0.1', port: peerPort }
		});
		const relayAddress = await relay.listen(0);
		const socketFactory = createRelaySocketFactory({
			electrumUrl: `ws://127.0.0.1:${relayAddress.port}/electrum`,
			peerUrl: `ws://127.0.0.1:${relayAddress.port}/peer`,
			token,
			WebSocket,
			electrum
		});
		const options = { volume, databaseFactory, socketFactory, electrum };
		runtime = await createPortableRuntime(options);
		let client = new EmbeddedWalletClient({ runtime });
		const created = await client.createWallet({
			name: 'Embedded funded regtest',
			network: 'regtest',
			primaryUri: `${primary.getInfo().nodeId}@127.0.0.1:${peerPort}`,
			electrum
		});
		const id = created.id;
		const rpc = (route, method = 'GET', body) =>
			runtime.request({ method, path: `/wallets/${id}/api${route}`, body });
		const info = await rpc('/info');
		primary.addTrustedPeer(info.nodeId);
		primary.openChannel(info.nodeId, 200000, 0, 2, false, true);
		await wait(
			'real portable engine channel ready over BOLT8 relay',
			async () => (await rpc('/channels')).some((c) => c.htlcUsable)
		);
		btc('-generate', '1');
		await client.refreshWallet();
		const quote = await client.quoteReceive({
			amountSats: 12000,
			description: 'Embedded receive integration'
		});
		const receive = await client.receive(quote);
		assert.ok(receive.uri.startsWith('bitcoin:bcrt1'));
		const paid = await primary.payInvoiceSafe(receive.bolt11, 60000, 100);
		assert.equal(paid.status, 'COMPLETED');
		await wait('portable unified receive settles', async () =>
			(await client.snapshot()).activity.some(
				(x) => x.paymentHash === receive.paymentHash && x.status === 'completed'
			)
		);
		const invoice = primary.createInvoice(
			3000,
			'Embedded send integration',
			300
		);
		const review = await wait(
			'portable outbound route after settlement',
			() => client.prepareSend({ request: invoice.bolt11 }),
			45000
		).catch(async (error) => {
			console.log(
				'route diagnostics',
				JSON.stringify({
					balance: await rpc('/balance'),
					channels: await rpc('/channels'),
					peers: await rpc('/peers')
				})
			);
			throw error;
		});
		const sent = await client.send(review);
		assert.equal(sent.status, 'completed', sent.message);
		await wait('portable capped Lightning send settles', async () =>
			(await client.snapshot()).activity.some(
				(x) =>
					x.paymentHash === invoice.paymentHash &&
					x.kind === 'sent' &&
					x.status === 'completed'
			)
		);
		await delay(1500);
		const external = btc('getnewaddress', 'portable-regtest', 'bech32');
		const addressReview = await client.prepareSend({
			request: external,
			amountSats: 2000
		});
		const addressSend = await client.send(addressReview);
		if (addressSend.status !== 'pending') {
			console.log(
				'splice diagnostics',
				JSON.stringify({
					send: addressSend,
					activity: await runtime.request({
						path: `/api/wallets/${id}/activity`
					}),
					channels: await rpc('/channels')
				})
			);
		}
		assert.equal(addressSend.status, 'pending');
		await wait('durable external splice submission visible', async () =>
			(await client.snapshot()).activity.some(
				(x) =>
					x.address === external && ['pending', 'completed'].includes(x.status)
			)
		);
		await wait('external splice transaction verified before restart',async()=> (await client.snapshot()).activity.some(x=>x.address===external&&x.txid),180000);
await client.close();
		runtime = await createPortableRuntime(options);
		client = new EmbeddedWalletClient({ runtime, walletId: id });
		await client.startWallet();
		await wait('channel state restored after engine restart', async () =>
			(await rpc('/channels')).some((c) => c.htlcUsable)
		);
		let mined = 0;
		await wait(
			'external splice payment has exact chain proof',
			async () => {
				if (Date.now() - mined > 3000) {
					btc('-generate', '1');
					mined = Date.now();
				}
				const snapshot = await client.snapshot();
				return snapshot.activity.some(
					(x) => x.address === external && x.status === 'completed' && x.txid
				);
			},
			180000
		);
		assert.ok(
			(await client.snapshot()).activity.some(
				(x) => x.paymentHash === receive.paymentHash && x.status === 'completed'
			)
		);
		console.log(
			'PASS committed channel state, payment history and durable journal survive full embedded restart'
		);
		// A payer this wallet has never paired with pays the unified request by
		// direct funding. With allowUnpairedSplice on (beignet #760) that grows
		// the one home channel, locking after the engine's depth, instead of
		// opening a second channel the way it did through 0.17.0.
		stranger = await BeignetNode.create({
			network: 'regtest',
			dataDir: path.join(temp, 'stranger'),
			allowMultipleInstances: true,
			electrumHost: '127.0.0.1',
			electrumPort: 60001,
			electrumTls: false,
			autoBootstrap: false,
			autoGossipSync: false,
			logger: { debug() {}, info() {}, warn() {}, error() {} }
		});
		await stranger.refreshWallet();
		btc('sendtoaddress', await stranger.getNewAddress(), '0.01000000');
		btc('-generate', '1');
		await delay(2000);
		await stranger.refreshWallet();
		await wait(
			'stranger funded with a confirmed regtest coin',
			() => stranger.getBalance().onchain >= 1000000
		);
		const before = (await rpc('/channels')).filter((c) => c.htlcUsable);
		assert.equal(before.length, 1, 'one home channel before the stranger pays');
		const fundingQuote = await client.quoteReceive({
			amountSats: 40000,
			description: 'Stranger direct funding'
		});
		const fundingRequest = await client.receive(fundingQuote);
		const envelope = new URL(fundingRequest.uri).searchParams.get('bgnq');
		if (!envelope)
			console.log(
				'direct-funding request diagnostics',
				JSON.stringify({
					warnings: fundingRequest.warnings,
					uri: fundingRequest.uri,
					config: await rpc('/direct-funding/config').catch((e) => e.message),
					request: await rpc('/direct-funding/request', 'POST', {
						amountSats: 40000
					}).catch((e) => ({ error: e.message, code: e.code }))
				})
			);
		assert.ok(envelope, 'the unified request carries a direct-funding envelope');
		const funded = await stranger.sendDirectFunding({
			request: envelope,
			amountSats: 40000,
			feeHeadroomSats: 2000
		});
		console.log('stranger direct funding', JSON.stringify(funded));
		await wait(
			"stranger's direct funding accepted as an unpaired splice of the home channel",
			async () => {
				const rec = await runtime.request({ path: `/api/wallets/${id}` });
				const channels = await rpc('/channels');
				return (
					!!rec.lfbw.unpairedFunding &&
					channels.filter((c) => c.peerPubkey === before[0].peerPubkey).length === 1
				);
			},
			120000
		);
		let minedAt = 0;
		await wait(
			'unpaired splice locks at depth and the single home channel is larger',
			async () => {
				if (Date.now() - minedAt > 3000) {
					btc('-generate', '1');
					minedAt = Date.now();
				}
				await client.refreshWallet().catch(() => {});
				const channels = await rpc('/channels');
				const withPrimary = channels.filter(
					(c) => c.peerPubkey === before[0].peerPubkey && c.state !== 'CLOSED'
				);
				const home = withPrimary.find((c) => c.htlcUsable);
				const rec = await runtime.request({ path: `/api/wallets/${id}` });
				return (
					withPrimary.length === 1 &&
					!!home &&
					home.state === 'NORMAL' &&
					home.capacitySats > before[0].capacitySats &&
					home.localBalanceSats > before[0].localBalanceSats &&
					!rec.lfbw.unpairedFunding
				);
			},
			240000
		);
		assert.equal((await rpc('/channels')).filter((c) => c.htlcUsable).length, 1);
	} finally {
		await runtime?.close();
		await relay?.close();
		await stranger?.gracefulShutdown(5000).catch(() => {});
		await primary?.gracefulShutdown(5000);
		fs.rmSync(temp, { recursive: true, force: true });
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
