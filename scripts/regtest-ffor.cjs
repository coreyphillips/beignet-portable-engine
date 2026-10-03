'use strict';
// Disposable regtest funds. The receiver runs in a separate process that is
// killed before payment, then cold-started twice against its durable volume.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { btc, wait, delay, createHarness } = require('./regtest-harness.cjs');
(async () => {
	const h = await createHarness({
		prefix: 'beignet-concurrent-portable-',
		ffor: true
	});
	const { EmbeddedWalletClient } = await import(
		path.join(
			process.env.BEIGNET_WALLET_CORE_DIR ||
				path.resolve(__dirname, '../../shared'),
			'src/index.js'
		)
	);
	let child,
		payer,
		client,
		walletId,
		rpc,
		adapter,
		next = 0;
	const evidence = {
		engine: require('../package.json').upstreamVersion,
		engineCommit: require('../package.json').upstreamCommit,
		node: process.version,
		processes: [],
		balances: []
	};
	const pending = new Map();
	function call(operation, body) {
		const id = ++next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(Error(`${operation} timed out`));
			}, 120000);
			pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			});
			child.send({ id, operation, body });
		});
	}
	async function start() {
		if (process.env.FFOR_RUNTIME_ADAPTER) {
			adapter = await require(path.resolve(
				process.env.FFOR_RUNTIME_ADAPTER
			)).start({ h, directory: path.join(h.temp, 'receiver') });
			evidence.processes.push(adapter.identity);
			client =
				adapter.client ||
				new EmbeddedWalletClient({
					runtime: { request: adapter.request },
					...(walletId ? { walletId } : {})
				});
			if (walletId) await client.startWallet();
			else
				walletId = (
					await client.createWallet({
						name: 'Concurrent receiver',
						network: 'regtest',
						primaryUri: h.primaryUri,
						electrum: h.electrum
					})
				).id;
			rpc = (route, method = 'GET', body) =>
				adapter.request({
					method,
					path: `/wallets/${walletId}/api${route}`,
					body
				});
			return;
		}
		child = fork(path.join(__dirname, 'regtest-ffor-receiver.cjs'), [], {
			stdio: ['ignore', 'inherit', 'inherit', 'ipc']
		});
		child.on('message', ({ id, value, error }) => {
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			error
				? entry.reject(Object.assign(Error(error.message), error))
				: entry.resolve(value);
		});
		child.on('exit', () => {
			for (const p of pending.values()) p.reject(Error('receiver stopped'));
			pending.clear();
		});
		const started = await call('start', {
			directory: path.join(h.temp, 'receiver'),
			electrum: h.electrum,
			transport: {
				electrumUrl: `ws://127.0.0.1:${h.relayPort}/electrum`,
				peerUrl: `ws://127.0.0.1:${h.relayPort}/peer`,
				token: h.token,
				electrum: h.electrum
			}
		});
		evidence.processes.push(started.pid);
		client = new EmbeddedWalletClient({
			runtime: {
				request: (body) => call('request', body),
				close: () => call('close')
			},
			...(walletId ? { walletId } : {})
		});
		if (walletId) await client.startWallet();
		else
			walletId = (
				await client.createWallet({
					name: 'Concurrent receiver',
					network: 'regtest',
					primaryUri: h.primaryUri,
					electrum: h.electrum
				})
			).id;
		rpc = (route, method = 'GET', body) =>
			call('request', {
				method,
				path: `/wallets/${walletId}/api${route}`,
				body
			});
	}
	async function stop() {
		if (adapter) {
			await adapter.stop();
			adapter = undefined;
			return;
		}
		if (!child) return;
		const old = child;
		const exited = once(old, 'exit');
		old.kill('SIGKILL');
		await exited;
		child = undefined;
	}
	async function balance(label) {
		const snapshot = await client.snapshot();
		const expected =
			label === 'active offline book'
				? [101000, 96000]
				: label.startsWith('cold start')
				? [121000, 116000]
				: [147000, 142000];
		assert.equal(snapshot.balance.totalSats, expected[0], label + ' total');
		assert.equal(
			snapshot.balance.availableSats,
			expected[1],
			label + ' available'
		);
		evidence.balances.push({ label, ...snapshot.balance });
		return snapshot;
	}
	async function ordinaryBothWays(label) {
		const before = (await rpc('/channels'))[0].localBalanceSats;
		const outgoing = h.primary.createInvoice(5000, label + ' outgoing');
		const sent = await rpc('/invoice/pay-safe', 'POST', {
			bolt11: outgoing.bolt11,
			timeoutMs: 30000,
			maxFeeSats: 100
		});
		assert.equal(sent.status, 'COMPLETED', JSON.stringify(sent));
		const incoming = await rpc('/invoice/create', 'POST', {
			amountSats: 6000,
			description: label + ' incoming'
		});
		const paid = await payer.payInvoiceSafe(incoming.bolt11, 30000, 100);
		assert.equal(paid.status, 'COMPLETED', JSON.stringify(paid));
		await wait(
			label + ' ordinary balances',
			async () => (await rpc('/channels'))[0].localBalanceSats === before + 1000
		);
		assert.equal((await rpc('/channels')).length, 1);
		await balance(label);
	}
	try {
		await start();
		assert.equal(
			(
				await (adapter
					? adapter.request({ path: '/api/config' })
					: call('request', { path: '/api/config' }))
			).engineVersion,
			adapter?.engineVersion || '0.25.0-portable'
		);
		const receiverId = (await rpc('/info')).nodeId;
		h.primary.addTrustedPeer(receiverId);
		h.primary.openChannel(receiverId, 500000, 0, 2, false, true);
		await wait('receiver home ready', async () =>
			(await rpc('/channels')).some((c) => c.htlcUsable)
		);
		const fundInvoice = await rpc('/invoice/create', 'POST', {
			amountSats: 100000,
			description: 'Fund receiver home'
		});
		assert.equal(
			(await h.primary.payInvoiceSafe(fundInvoice.bolt11, 30000, 100)).status,
			'COMPLETED'
		);
		await wait(
			'funded receiver home',
			async () => (await rpc('/channels'))[0].localBalanceSats === 100000
		);
		btc('-generate', '6');
		await delay(2000);
		payer = await h.BeignetNode.create({
			network: 'regtest',
			dataDir: path.join(h.temp, 'payer'),
			allowMultipleInstances: true,
			electrumHost: '127.0.0.1',
			electrumPort: 60001,
			electrumTls: false,
			autoBootstrap: false,
			autoGossipSync: false,
			logger: { debug() {}, info() {}, warn() {}, error() {} }
		});
		let address;
		await wait('payer wallet ready', async () => {
			address = await payer.getNewAddress();
			return !!address;
		});
		btc('sendtoaddress', address, '0.02000000');
		btc('-generate', '1');
		await wait('payer funded', async () => {
			await payer.refreshWallet();
			return payer.getBalance().onchain >= 2000000;
		});
		await payer.connectPeer(
			h.primary.getInfo().nodeId,
			'127.0.0.1',
			h.peerPort
		);
		h.primary.addTrustedPeer(payer.getInfo().nodeId);
		payer.addTrustedPeer(h.primary.getInfo().nodeId);
		payer.openChannel(h.primary.getInfo().nodeId, 500000, 0, 2, false, true);
		await wait('payer channel ready', () =>
			payer.listChannels().some((c) => c.htlcUsable)
		);
		btc('-generate', '6');
		await delay(2000);
		await client.refreshWallet();
		const request = await client.receive(
			await client.quoteReceive({
				amountSats: 20000,
				description: 'Concurrent offline receipt',
				mode: 'offline'
			})
		);
		const reservation = (await rpc('/ffor/epochs')).find(
			(e) => e.state === 'ACTIVE'
		);
		assert.equal(reservation.concurrentVersion, 2);
		evidence.channelId = reservation.channelId;
		evidence.paymentHash = request.paymentHash;
		await ordinaryBothWays('active offline book');
		const before = (await rpc('/channels'))[0].localBalanceSats;
		await stop();
		assert.equal(
			(await payer.payInvoiceSafe(request.bolt11, 30000, 100)).status,
			'COMPLETED'
		);
		for (let run = 1; run <= 2; run++) {
			await start();
			await wait(`cold start ${run} credit`, async () => {
				const snapshot = await client.snapshot();
				const entries = snapshot.activity.filter(
					(row) =>
						row.paymentHash === request.paymentHash &&
						row.status === 'completed'
				);
				return (
					entries.length === 1 &&
					(await rpc('/channels'))[0].localBalanceSats === before + 20000
				);
			});
			const snapshot = await balance(`cold start ${run}`);
			assert.equal(
				snapshot.activity.filter(
					(row) => row.paymentHash === request.paymentHash
				).length,
				1
			);
			if (run === 1) await stop();
		}
		await wait(
			'automatic book retired after redemption',
			async () =>
				(await rpc('/ffor/epoch?channelId=' + reservation.channelId)).state ===
					'CLOSED' &&
				(
					await rpc(adapter?.offlineStatusPath || '/receive/offline')
				).requests.every((j) => j.done)
		);
		const height = (await rpc('/info')).blockHeight;
		await rpc('/ffor/epoch/start', 'POST', {
			channelId: reservation.channelId,
			voucherAmountsMsat: ['12000000', '13000000'],
			feeBaseMsat: 0,
			feeProportionalMillionths: 0,
			settlementDeadline: height + 144,
			voucherExpiry: height + 1296,
			concurrent: true,
			concurrentVersion: 2
		});
		await wait(
			'manual two-voucher book active',
			async () =>
				(await rpc('/ffor/epoch?channelId=' + reservation.channelId)).state ===
				'ACTIVE'
		);
		const first = await rpc('/ffor/invoice', 'POST', {
			channelId: reservation.channelId,
			k: 1,
			description: 'partial first',
			expirySecs: 600
		});
		const second = await rpc('/ffor/invoice', 'POST', {
			channelId: reservation.channelId,
			k: 2,
			description: 'partial second',
			expirySecs: 600
		});
		assert.equal(
			(await payer.payInvoiceSafe(first.bolt11, 30000, 100)).status,
			'COMPLETED'
		);
		await wait('first voucher redeemed without retiring second', async () => {
			await rpc('/ffor/sync', 'POST', { channelId: reservation.channelId });
			const epoch = await rpc('/ffor/epoch?channelId=' + reservation.channelId);
			return (
				epoch.state === 'ACTIVE' &&
				epoch.slots[0].state === 'redeemed' &&
				epoch.slots[1].state === 'exposed'
			);
		});
		assert.equal(
			(await payer.payInvoiceSafe(second.bolt11, 30000, 100)).status,
			'COMPLETED'
		);
		await wait('second voucher redeemed', async () => {
			await rpc('/ffor/sync', 'POST', { channelId: reservation.channelId });
			return (
				await rpc('/ffor/epoch?channelId=' + reservation.channelId)
			).slots.every((s) => s.state === 'redeemed');
		});
		await rpc('/ffor/epoch/close', 'POST', {
			channelId: reservation.channelId
		});
		await wait(
			'manual book closed',
			async () =>
				(await rpc('/ffor/epoch?channelId=' + reservation.channelId)).state ===
				'CLOSED'
		);
		const unknown = await client.receive(
			await client.quoteReceive({
				amountSats: 17000,
				description: 'Retained unknown',
				mode: 'offline'
			})
		);
		assert.ok(unknown.offlineReceive);
		await rpc('/ffor/epoch/close', 'POST', {
			channelId: reservation.channelId
		});
		await wait('unknown reservation retained after early close', async () => {
			const ch = (await rpc('/channels'))[0];
			return (
				ch.ffor.state === 'DRAINING' &&
				ch.ffor.reservedInboundSats === 17000 &&
				ch.ffor.unresolvedSlots === 1 &&
				ch.htlcUsable
			);
		});
		await ordinaryBothWays('draining unknown reservation');
		const finalStatus = await rpc(
			adapter?.offlineStatusPath || '/receive/offline'
		);
		if (finalStatus.maxSats !== undefined) assert.equal(finalStatus.maxSats, 0);
		else
			assert.ok(finalStatus.reservedChannelIds.includes(reservation.channelId));
		evidence.result = 'passed';
		if (process.env.BEIGNET_EVIDENCE_FILE)
			fs.writeFileSync(
				process.env.BEIGNET_EVIDENCE_FILE,
				JSON.stringify(evidence, null, 2) + '\n'
			);
		console.log(
			'PASS concurrent portable receive, partial redemption, retained unknown reservation and two process cold starts'
		);
	} finally {
		await stop();
		if (payer) await payer.gracefulShutdown(5000).catch(() => {});
		await h.close();
	}
})().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	}
);
