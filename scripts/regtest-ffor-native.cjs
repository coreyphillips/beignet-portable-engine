// Disposable simulator harness. Build native-tests/OfflineReceive.tsx in Chicory first.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { btc, wait, delay, createHarness } = require('./regtest-harness.cjs');
(async () => {
	const simulator = process.env.FFOR_SIMULATOR_ID;
	assert.ok(simulator, 'Set FFOR_SIMULATOR_ID to an isolated simulator');
	const h = await createHarness({ prefix: 'beignet-ffor-native-', ffor: true });
	let payer,
		server,
		invoice,
		verified = false,
		failed;
	let phase = 'create';
	try {
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
		let payerAddress;
		await wait('payer Electrum ready', async () => {
			try {
				payerAddress = await payer.getNewAddress();
				return true;
			} catch {
				return false;
			}
		});
		btc('sendtoaddress', payerAddress, '0.02000000');
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

		const settings = {
			network: 'regtest',
			primaryUri: `${h.primary.getInfo().nodeId}@127.0.0.1:${h.peerPort}`,
			electrum: { host: '127.0.0.1', port: 60001, tls: false },
			transport: 'native',
			relayUrl: '',
			relayToken: ''
		};
		server = http.createServer(async (req, res) => {
			let body = '';
			for await (const chunk of req) body += chunk;
			res.setHeader('Content-Type', 'application/json');
			if (req.url === '/config')
				return res.end(
					JSON.stringify({ settings, phase, paymentHash: invoice?.paymentHash })
				);
			if (req.url === '/created') invoice = JSON.parse(body);
			if (req.url === '/verified') verified = true;
			if (req.url === '/failed') failed = JSON.parse(body).message;
			res.end('{}');
		});
		await new Promise((resolve) => server.listen(31078, '127.0.0.1', resolve));
		console.log('READY simulator test server on 127.0.0.1:31078');
		const end = Date.now() + 600000;
		while (!invoice && !failed && Date.now() < end) await delay(500);
		assert.ok(!failed, failed);
		assert.ok(invoice, 'Simulator did not create an invoice');
		assert.match(invoice.bolt11, /^lnbcrt/);
		execFileSync('xcrun', [
			'simctl',
			'terminate',
			simulator,
			'com.chicory.ffor-test'
		]);
		console.log('PASS simulator app process terminated before payment');
		const paid = await payer.payInvoiceSafe(invoice.bolt11, 30000, 100);
		assert.equal(paid.status, 'COMPLETED', JSON.stringify(paid));
		console.log('PASS payer completed payment with simulator app terminated');
		phase = 'verify';
		execFileSync('xcrun', [
			'simctl',
			'launch',
			simulator,
			'com.chicory.ffor-test'
		]);
		await wait(
			'native cold-launch recovery',
			() => {
				if (failed) throw Error(failed);
				return verified;
			},
			120000
		);
		verified = false;
		execFileSync('xcrun', [
			'simctl',
			'terminate',
			simulator,
			'com.chicory.ffor-test'
		]);
		execFileSync('xcrun', [
			'simctl',
			'launch',
			simulator,
			'com.chicory.ffor-test'
		]);
		await wait(
			'native second cold launch without duplicate Activity',
			() => {
				if (failed) throw Error(failed);
				return verified;
			},
			120000
		);
	} finally {
		if (server) server.close();
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
