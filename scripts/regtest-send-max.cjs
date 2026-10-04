'use strict';
/** Live send-max and drain qualification. Use the unpacked published npm release
 * as BEIGNET_SOURCE_DIR. Each wallet gets its own child process and durable volume.
 * Requires the bitcoin/electrum containers, and CLN on 19846 for the plain peer.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const bitcoin = require('bitcoinjs-lib');
bitcoin.initEccLib(require('@bitcoinerlab/secp256k1'));
const {
	btc,
	wait,
	delay,
	miner,
	createHarness
} = require('./regtest-harness.cjs');

const cases = [
	'jit',
	'address-bech32',
	'address-bech32m',
	'address-p2wsh',
	'phone',
	'cln'
];
const home = async (dev) =>
	(await dev.rpc('/channels')).find(
		(c) => c.state !== 'CLOSED' && c.htlcUsable
	);
const pass = (label, value) =>
	console.log(
		'PASS ' + label,
		value === undefined ? '' : JSON.stringify(value)
	);
function destination(kind = 'bech32m') {
	return kind === 'p2wsh'
		? bitcoin.payments.p2wsh({
				redeem: { output: Buffer.from([bitcoin.opcodes.OP_TRUE]) },
				network: bitcoin.networks.regtest
		  }).address
		: btc('getnewaddress', '', kind);
}
async function settledHome(
	dev,
	label = 'home channel ready',
	previousFundingTxid
) {
	const mine = miner();
	return wait(
		label,
		async () => {
			mine();
			await dev.client.refreshWallet();
			const channel = await home(dev);
			return channel?.state === 'NORMAL' &&
				channel.fundingConfirmed &&
				(!previousFundingTxid || channel.fundingTxid !== previousFundingTxid)
				? channel
				: false;
		},
		180000
	);
}
function verifySplicePayout(before, after, address, amountSats) {
	assert.notEqual(after.fundingTxid, before.fundingTxid);
	const tx = JSON.parse(btc('getrawtransaction', after.fundingTxid, 'true'));
	assert.ok(tx.confirmations > 0, 'splice transaction is confirmed');
	const script = bitcoin.address
		.toOutputScript(address, bitcoin.networks.regtest)
		.toString('hex');
	const paidSats = tx.vout
		.filter((output) => output.scriptPubKey.hex === script)
		.reduce((total, output) => total + Math.round(output.value * 1e8), 0);
	assert.equal(
		paidSats,
		amountSats,
		'exact reviewed payout reaches the requested script'
	);
}
async function payer(h) {
	const node = await h.BeignetNode.create({
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
	try {
		btc('sendtoaddress', await node.getNewAddress(), '0.02000000');
		btc('-generate', '1');
		await wait('payer coins confirmed', async () => {
			await node.refreshWallet();
			return node.getBalance().onchain >= 2000000;
		});
		await node.connectPeer(h.primary.getInfo().nodeId, '127.0.0.1', h.peerPort);
		node.openChannel(h.primary.getInfo().nodeId, 1000000, 0, 2, false);
		const mine = miner();
		await wait(
			'payer channel to primary ready',
			() => {
				mine();
				return node
					.listChannels()
					.some((c) => c.htlcUsable && c.state === 'NORMAL');
			},
			180000
		);
		return node;
	} catch (error) {
		await node.gracefulShutdown(5000);
		throw error;
	}
}
async function receive(dev, sender, amountSats) {
	const quote = await dev.client.quoteReceive({
		amountSats,
		description: 'Send max qualification'
	});
	const request = await dev.client.receive(quote);
	const paid = await sender.payInvoiceSafe(request.bolt11, 120000, 1000);
	assert.equal(paid.status, 'COMPLETED', JSON.stringify(paid));
	await wait('received payment committed', async () => {
		const invoice = (await dev.rpc('/invoices')).find(
			(i) => i.paymentHash === request.paymentHash
		);
		return invoice?.status === 'PAID';
	});
	await settledHome(dev);
	return request;
}
async function exactPayment(dev, primary, laterReceive) {
	const invoice = primary.createInvoice(undefined, 'Exact reviewed debit');
	const max = await dev.client.quoteMax({ request: invoice.bolt11 });
	const review = await dev.client.prepareSend({
		request: invoice.bolt11,
		max: true
	});
	assert.equal(review.max, true);
	assert.equal(review.amountSats, max.amountSats);
	if (laterReceive) await laterReceive();
	const sent = await dev.client.send(review);
	assert.ok(
		['completed', 'pending'].includes(sent.status),
		JSON.stringify(sent)
	);
	const record = await wait(
		'pay-all settled with exact durable figures',
		async () => {
			const record = await dev.rpc(
				'/payment?paymentHash=' + invoice.paymentHash
			);
			return record.status === 'COMPLETED' ? record : false;
		}
	);
	assert.equal(record.payAll.debitMsat, review.debitMsat);
	assert.equal(record.payAll.maxFeeMsat, review.maxFeeMsat);
	assert.equal(record.payAll.remainderMsat, '0');
	assert.equal(
		BigInt(record.payAll.deliveredMsat) + BigInt(record.payAll.feeMsat),
		BigInt(review.debitMsat)
	);
	return { review, record, sent };
}
async function drain(dev) {
	const coinAddress = (await dev.rpc('/address/new', 'POST', {})).address;
	const deposit = btc('sendtoaddress', coinAddress, '0.00020000');
	btc('-generate', '1');
	await wait('loose coin below channelize floor confirmed', async () => {
		await dev.client.refreshWallet();
		return (await dev.rpc('/utxos')).some(
			(u) => u.txid === deposit && u.height > 0
		);
	});
	const address = destination();
	const review = await dev.client.prepareDrain({ address });
	assert.ok(
		review.drain.closeAmountSats > 0 && review.drain.sweepAmountSats > 0
	);
	const sent = await dev.client.send(review);
	assert.ok(
		['pending', 'completed'].includes(sent.status),
		JSON.stringify(sent)
	);
	assert.equal((await dev.rpc('/channelize/status')).paused, true);
	const later = btc('sendtoaddress', coinAddress, '0.00001000');
	await dev.restart();
	assert.equal((await dev.rpc('/channelize/status')).paused, true);
	const mine = miner();
	const progress = await wait(
		'both drain legs complete after restart',
		async () => {
			mine();
			await dev.client.refreshWallet();
			const state = await dev.client.getDrain(review.id);
			return state.phase === 'completed' ? state : false;
		},
		180000
	);
	assert.equal(new Set(progress.txids).size, 2);
	assert.equal((await dev.rpc('/channelize/status')).paused, false);
	const utxos = await dev.rpc('/utxos');
	assert.ok(
		utxos.some((u) => u.txid === later && u.valueSats === 1000),
		'later receipt stays in the wallet'
	);
	assert.ok(
		!utxos.some((u) => u.txid === deposit),
		'the reviewed loose coin was spent'
	);
	const snapshot = await dev.client.snapshot();
	const rows = snapshot.activity.filter(
		(row) =>
			row.drain?.requestId === review.id || progress.txids.includes(row.txid)
	);
	assert.equal(rows.length, 1, 'one durable Activity includes both legs');
	assert.deepEqual(rows[0].drain.txids, progress.txids);
	for (const txid of progress.txids) {
		const tx = JSON.parse(btc('getrawtransaction', txid, 'true'));
		assert.ok(
			tx.vout.some((output) => output.scriptPubKey.address === address)
		);
		assert.ok(!tx.vin.some((input) => input.txid === later));
	}
	pass(
		'drain holds channelize, survives restart and retains one Activity with both txids',
		progress
	);
}
async function runCase(name) {
	const h = await createHarness({
		prefix: 'beignet-send-max-',
		waiveClientReserve: true
	});
	let sender;
	let dev;
	try {
		if (name === 'cln') {
			const info = JSON.parse(
				execFileSync(
					'docker',
					[
						'exec',
						process.env.BEIGNET_REGTEST_CLN || 'cln',
						'lightning-cli',
						'--network=regtest',
						'getinfo'
					],
					{ encoding: 'utf8', timeout: 20000 }
				)
			);
			dev = await h.device(name, {
				primaryUri: `${info.id}@127.0.0.1:19846`,
				socketFactory: await h.freshTransport({
					host: '127.0.0.1',
					port: 19846
				})
			});
		} else {
			if (name !== 'phone') sender = await payer(h);
			dev = await h.device(name);
		}
		await wait(
			'wallet setup ready',
			async () => (await dev.record()).lfbw.setup === 'ready'
		);
		if (name === 'phone' || name === 'cln') {
			const address = (await dev.rpc('/address/new', 'POST', {})).address;
			btc('sendtoaddress', address, '0.00100000');
			btc('-generate', '1');
			const channel = await settledHome(dev, 'phone-funded channel ready');
			assert.equal(channel.isOpener, true);
			assert.equal(channel.isPrivate, true);
			assert.equal(channel.fundingConfirmed, true);
			assert.equal(channel.localReserveWaived, name !== 'cln');
			assert.equal(channel.remoteReserveWaived, false);
			const target = destination('bech32');
			const review = await dev.client.prepareSend({
				request: target,
				max: true
			});
			assert.ok(
				review.keptSats > 0,
				'opener cost or ordinary reserve is retained'
			);
			if (name === 'cln') assert.ok(channel.localReserveSats > 0);
			else {
				const sent = await dev.client.send(review);
				assert.ok(
					['pending', 'completed'].includes(sent.status),
					JSON.stringify(sent)
				);
				const after = await settledHome(
					dev,
					'phone-funded max splice locked',
					channel.fundingTxid
				);
				verifySplicePayout(channel, after, target, review.amountSats);
				assert.equal(after.localBalanceSats, review.keptSats);
			}
			pass(name + ' retained balance explained', {
				keptSats: review.keptSats,
				keptReason: review.keptReason
			});
		} else {
			assert.equal(
				(await dev.rpc('/channels')).length,
				0,
				'receive begins without a channel'
			);
			await receive(dev, sender, 100000);
			const channel = await home(dev);
			assert.equal(channel.isOpener, false);
			assert.equal(channel.localReserveWaived, true);
			assert.equal(channel.remoteReserveWaived, false);
			if (name === 'jit') {
				const first = await exactPayment(dev, h.primary);
				assert.equal(first.review.keptSats, 0);
				assert.equal((await home(dev)).localBalanceSats, 0);
				await receive(dev, sender, 50000);
				const frozen = await exactPayment(dev, h.primary, () =>
					receive(dev, sender, 5000)
				);
				assert.equal(
					(await home(dev)).localBalanceSats,
					5000,
					'review never sweeps later Lightning receipts'
				);
				await dev.restart();
				await settledHome(dev, 'waived channel restored');
				const saved = await dev.rpc(
					'/payment?paymentHash=' + frozen.record.paymentHash
				);
				assert.deepEqual(saved.payAll, frozen.record.payAll);
				const snapshot = await dev.client.snapshot();
				assert.ok(
					snapshot.activity.some(
						(row) => row.payAll?.debitMsat === frozen.review.debitMsat
					)
				);
				pass(
					'pay-all empties a JIT balance and freezes later receipts across restart'
				);
				await drain(dev);
			} else {
				const target = destination(name.slice('address-'.length));
				const before = await home(dev);
				const max = await dev.client.quoteMax({ request: target });
				const review = await dev.client.prepareSend({
					request: target,
					max: true
				});
				assert.equal(max.amountSats, review.amountSats);
				assert.equal(review.keptSats, 0);
				const sent = await dev.client.send(review);
				assert.ok(
					['pending', 'completed'].includes(sent.status),
					JSON.stringify(sent)
				);
				const after = await settledHome(
					dev,
					name + ' max splice locked',
					before.fundingTxid
				);
				verifySplicePayout(before, after, target, review.amountSats);
				assert.equal(after.localBalanceSats, 0);
				assert.equal(after.localReserveWaived, true);
				pass(
					name + ' sends every whole sat and keeps the home channel open',
					review.amountSats
				);
			}
		}
	} catch (error) {
		if (dev)
			console.error(
				'DIAG',
				JSON.stringify({
					record: await dev.record().catch(() => null),
					channels: await dev.rpc('/channels').catch(() => null),
					balance: await dev.rpc('/balance').catch(() => null)
				})
			);
		throw error;
	} finally {
		await sender?.gracefulShutdown(5000).catch(() => {});
		await h.close();
	}
}
async function main() {
	if (process.argv[2] === '--case') {
		assert.ok(cases.includes(process.argv[3]));
		await runCase(process.argv[3]);
		return;
	}
	assert.ok(
		process.env.BEIGNET_SOURCE_DIR,
		'point BEIGNET_SOURCE_DIR at the unpacked npm release'
	);
	for (const name of process.env.SEND_MAX_CASES?.split(',') || cases) {
		await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [__filename, '--case', name], {
				stdio: 'inherit',
				env: process.env
			});
			let timedOut = false;
			let killTimer;
			const deadline = setTimeout(
				() => {
					timedOut = true;
					child.kill('SIGTERM');
					killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
				},
				15 * 60 * 1000
			);
			const clearDeadline = () => {
				clearTimeout(deadline);
				clearTimeout(killTimer);
			};
			child.once('error', (error) => {
				clearDeadline();
				reject(error);
			});
			child.once('exit', (code) => {
				clearDeadline();
				if (timedOut)
					reject(new Error(name + ' exceeded its 15 minute deadline'));
				else if (code === 0) resolve();
				else reject(new Error(name + ' exited ' + code));
			});
		});
	}
	pass('regtest-send-max: all requested cases passed');
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
