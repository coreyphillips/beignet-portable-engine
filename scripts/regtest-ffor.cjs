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

		const { EmbeddedWalletClient } = await import('../../shared/src/index.js');
		let active = dev.runtime;
		let client = dev.client;
		const rpc = (route, method = 'GET', body) =>
			active.request({ method, path: `/wallets/${dev.id}/api${route}`, body });
		async function reopen() {
			await active.close();
			const databaseFactory = await createSqlJsDatabaseFactory({
				load: dev.options.volume.read,
				save: dev.options.volume.write
			});
			reopened = active = await createPortableRuntime({
				...dev.options,
				databaseFactory
			});
			client = new EmbeddedWalletClient({ runtime: active, walletId: dev.id });
			await active.request({
				method: 'POST',
				path: `/api/wallets/${dev.id}/start`
			});
			await wait('receiver reconnected', async () =>
				(await rpc('/channels')).some((c) => c.state === 'NORMAL')
			);
		}
		const invoice = await client.receive(
			await client.quoteReceive({
				amountSats: 20000,
				description: 'Offline receipt'
			})
		);
		const reservation = (await rpc('/ffor/epochs')).find(
			(e) => e.state === 'ACTIVE'
		);
		assert.ok(reservation);
		assert.equal(reservation.slots[0].paymentHash, invoice.paymentHash);
		console.log('PASS ordinary app receive creates an offline reservation');
		await reopen();
		await delay(5000);
		assert.equal(
			(await rpc('/ffor/epoch?channelId=' + reservation.channelId)).state,
			'ACTIVE'
		);
		assert.notEqual(
			(await rpc('/invoices')).find(
				(i) => i.paymentHash === invoice.paymentHash
			).status,
			'PAID'
		);
		console.log('PASS reopening an unpaid invoice keeps it payable');
		await active.close();
		const paid = await payer.payInvoiceSafe(invoice.bolt11, 30000, 100);
		assert.equal(paid.status, 'COMPLETED', JSON.stringify(paid));
		console.log('PASS payment completes with the receiver stopped');
		await reopen();
		await wait(
			'automatic receipt reconciliation',
			async () =>
				(await rpc('/invoices')).find(
					(i) => i.paymentHash === invoice.paymentHash
				).status === 'PAID'
		);
		assert.equal(
			(await rpc('/channels')).find(
				(c) => c.channelId === reservation.channelId
			).localBalanceSats,
			20000
		);
		const snapshot = await client.snapshot();
		const rows = snapshot.activity.filter(
			(r) => r.paymentHash === invoice.paymentHash
		);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].status, 'completed');
		assert.equal(rows[0].amountSats, 20000);
		console.log(
			'PASS automatic recovery credits 20,000 sats and one Activity row'
		);
		await reopen();
		const again = await client.snapshot();
		assert.equal(
			again.activity.filter(
				(r) => r.paymentHash === invoice.paymentHash && r.status === 'completed'
			).length,
			1
		);
		assert.equal(
			(await rpc('/channels')).find(
				(c) => c.channelId === reservation.channelId
			).localBalanceSats,
			20000
		);
		console.log(
			'PASS a second restart preserves balance without duplicate receipts'
		);
		const second = await client.receive(
			await client.quoteReceive({
				amountSats: 15000,
				description: 'Second offline receipt'
			})
		);
		const reservations = (await rpc('/ffor/epochs')).filter(
			(e) => e.state === 'ACTIVE'
		);
		assert.equal(reservations.length, 1);
		assert.notEqual(reservations[0].channelId, reservation.channelId);
		assert.equal(
			(await rpc('/channels')).find(
				(c) => c.channelId === reservation.channelId
			).htlcUsable,
			true
		);
		console.log(
			'PASS another invoice gets a dedicated channel while existing funds remain usable'
		);
        const outgoing = h.primary.createInvoice(5000, 'Send while receiving');
        const sent = await client.send(await client.prepareSend({request:outgoing.bolt11}));
        assert.equal(sent.status, 'completed', JSON.stringify(sent));
        assert.equal((await rpc('/ffor/epoch?channelId='+reservations[0].channelId)).state,'ACTIVE');
        console.log('PASS ordinary payment succeeds while another receive reservation is active');
		await active.close();
		const paidSecond = await payer.payInvoiceSafe(second.bolt11, 30000, 100);
		assert.equal(paidSecond.status, 'COMPLETED', JSON.stringify(paidSecond));
		await reopen();
		await wait(
			'second automatic recovery',
			async () =>
				(await rpc('/invoices')).find(
					(i) => i.paymentHash === second.paymentHash
				).status === 'PAID'
		);
		assert.equal(
			(await client.snapshot()).activity.filter(
				(r) => r.paymentHash === second.paymentHash && r.status === 'completed'
			).length,
			1
		);
		console.log('PASS provider-funded reservation also recovers automatically');
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
