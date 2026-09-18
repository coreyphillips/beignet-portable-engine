'use strict';
// Disposable regtest funds only. Exercise the same runtime and client used by
// the phone and browser, including durable close/reopen and Activity mapping.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPortableRuntime } = require('../dist/portable.cjs');
const { createSqlJsDatabaseFactory } = require('../dist/sqljs.cjs');
const { btc, wait, delay, createHarness } = require('./regtest-harness.cjs');
(async () => {
	const h = await createHarness({ prefix: 'beignet-ffor-', ffor: true });
	let payer;
	let reopened;
	try {
		const dev = await h.device('receiver');
		const nodeId = (await dev.rpc('/info')).nodeId;
		h.primary.addTrustedPeer(nodeId);
		h.primary.openChannel(nodeId, 300000, 0, 2, false, true);
		await wait('receiver channel ready', async () =>
			(await dev.rpc('/channels')).some((c) => c.htlcUsable)
		);
		btc('-generate', '6');
		await delay(2000);
		await dev.client.refreshWallet();
		const channel = (await dev.rpc('/channels')).find((c) => c.htlcUsable);
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
		btc('sendtoaddress', await payer.getNewAddress(), '0.02000000');
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
		payer.openChannel(h.primary.getInfo().nodeId, 300000, 0, 2, false, true);
		await wait('payer channel ready', () =>
			payer.listChannels().some((c) => c.htlcUsable)
		);
		btc('-generate', '6');
		await delay(2000);
		const ordinary = await dev.client.receive(
			await dev.client.quoteReceive({
				amountSats: 10000,
				description: 'App receive baseline'
			})
		);
		assert.equal((await dev.rpc('/ffor/epochs')).length, 0);
		console.log('CONFIRMED normal app Receive creates no offline reservation');
		const tip = (await dev.rpc('/info')).blockHeight;
		await dev.rpc('/ffor/epoch/start', 'POST', {
			channelId: channel.channelId,
			voucherAmountsMsat: ['20000000'],
			settlementDeadline: tip + 144,
			voucherExpiry: tip + 144 + 1152,
			feeBaseMsat: 0,
			feeProportionalMillionths: 0
		});
		await wait(
			'receiver reservation ACTIVE',
			async () =>
				(await dev.rpc('/ffor/epoch?channelId=' + channel.channelId)).state ===
				'ACTIVE'
		);
		const invoice = await dev.rpc('/ffor/invoice', 'POST', {
			channelId: channel.channelId,
			k: 1,
			description: 'Offline receipt'
		});
		assert.equal(invoice.amountMsat, '20000000');
		assert.ok(
			(await dev.rpc('/invoices')).some(
				(i) => i.paymentHash === invoice.paymentHash
			)
		);
		const before = (await dev.rpc('/channels')).find(
			(c) => c.channelId === channel.channelId
		).localBalanceSats;
		await dev.runtime.close();
		console.log(
			'PASS receiver runtime stopped and storage released before payment'
		);
		const paid = await payer.payInvoiceSafe(invoice.bolt11, 30000, 100);
		assert.equal(paid.status, 'COMPLETED', JSON.stringify(paid));
		console.log('PASS payer completed payment with receiver stopped');
		const databaseFactory = await createSqlJsDatabaseFactory({
			load: dev.options.volume.read,
			save: dev.options.volume.write
		});
		reopened = await createPortableRuntime({ ...dev.options, databaseFactory });
		const { EmbeddedWalletClient } = await import('../../shared/src/index.js');
		const client = new EmbeddedWalletClient({
			runtime: reopened,
			walletId: dev.id
		});
		const rpc = (route, method = 'GET', body) =>
			reopened.request({
				method,
				path: `/wallets/${dev.id}/api${route}`,
				body
			});
		await reopened.request({
			method: 'POST',
			path: `/api/wallets/${dev.id}/start`
		});
		await wait('receiver channel reestablished', async () =>
			(await rpc('/channels')).some((c) => c.state === 'NORMAL')
		);
		const pending = (await rpc('/invoices')).find(
			(i) => i.paymentHash === invoice.paymentHash
		);
		assert.notEqual(pending.status, 'PAID');
		console.log('CONFIRMED reopening alone does not reconcile offline receipt');
		await rpc('/ffor/recover', 'POST', { channelId: channel.channelId });
		await wait(
			'reservation CLOSED',
			async () =>
				(await rpc('/ffor/epoch?channelId=' + channel.channelId)).state ===
				'CLOSED'
		);
		assert.equal(
			(await rpc('/channels')).find((c) => c.channelId === channel.channelId)
				.localBalanceSats,
			before + 20000
		);
		assert.equal(
			(await rpc('/invoices')).find(
				(i) => i.paymentHash === invoice.paymentHash
			).status,
			'PAID'
		);
		const snapshot = await client.snapshot();
		const received = snapshot.activity.filter(
			(r) => r.paymentHash === invoice.paymentHash
		);
		assert.equal(received.length, 1);
		assert.equal(received[0].kind, 'received');
		assert.equal(received[0].status, 'completed');
		assert.equal(received[0].amountSats, 20000);
		console.log(
			'PASS manual reconciliation credits 20,000 sats and one completed Activity row'
		);
		await reopened.close();
		const coldDatabase = await createSqlJsDatabaseFactory({
			load: dev.options.volume.read,
			save: dev.options.volume.write
		});
		reopened = await createPortableRuntime({
			...dev.options,
			databaseFactory: coldDatabase
		});
		await reopened.request({
			method: 'POST',
			path: `/api/wallets/${dev.id}/start`
		});
		await wait(
			'credited receiver reestablished after a second cold reopen',
			async () => (await rpc('/channels')).some((c) => c.state === 'NORMAL')
		);
		const coldClient = new EmbeddedWalletClient({
			runtime: reopened,
			walletId: dev.id
		});
		const coldSnapshot = await coldClient.snapshot();
		assert.equal(
			(await rpc('/invoices')).find(
				(i) => i.paymentHash === invoice.paymentHash
			).status,
			'PAID'
		);
		assert.equal(
			coldSnapshot.activity.filter(
				(r) => r.paymentHash === invoice.paymentHash && r.status === 'completed'
			).length,
			1
		);
		assert.equal(
			(await rpc('/channels')).find((c) => c.channelId === channel.channelId)
				.localBalanceSats,
			before + 20000
		);
		console.log(
			'PASS credited balance and single completed Activity row survive another cold reopen'
		);
		const tip2 = (await rpc('/info')).blockHeight;
		await rpc('/ffor/epoch/start', 'POST', {
			channelId: channel.channelId,
			voucherAmountsMsat: ['15000000'],
			settlementDeadline: tip2 + 144,
			voucherExpiry: tip2 + 1296,
			feeBaseMsat: 0,
			feeProportionalMillionths: 0
		});
		await wait(
			'unpaid reservation ACTIVE',
			async () =>
				(await rpc('/ffor/epoch?channelId=' + channel.channelId)).state ===
				'ACTIVE'
		);
		const unpaid = await rpc('/ffor/invoice', 'POST', {
			channelId: channel.channelId,
			k: 1,
			description: 'Unpaid return'
		});
		await rpc('/ffor/recover', 'POST', { channelId: channel.channelId });
		await wait(
			'unpaid reservation CLOSED',
			async () =>
				(await rpc('/ffor/epoch?channelId=' + channel.channelId)).state ===
				'CLOSED'
		);
		const refused = await payer.payInvoiceSafe(unpaid.bolt11, 10000, 100);
		assert.equal(refused.status, 'FAILED', JSON.stringify(refused));
		console.log(
			'CONFIRMED recovery invalidates an unpaid invoice before its encoded expiry'
		);
		const after = await coldClient.snapshot();
		assert.equal(
			after.activity.filter(
				(r) => r.paymentHash === invoice.paymentHash && r.status === 'completed'
			).length,
			1
		);
		assert.ok(ordinary.bolt11);
	} finally {
		if (reopened) await reopened.close().catch(() => {});
		if (payer) await payer.gracefulShutdown(5000).catch(() => {});
		await h.close();
	}
})().then(
	() => process.exit(0),
	(e) => {
		console.error(e);
		process.exit(1);
	}
);
