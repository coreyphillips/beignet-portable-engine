const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const assert = require('node:assert/strict');
const {
	createPortableRuntime,
	createRelaySocketFactory
} = require('../dist/portable.cjs');
const { createSqlJsDatabaseFactory } = require('../dist/sqljs.cjs');
(async () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-embedded-'));
	const file = (p) => path.join(temp, Buffer.from(p).toString('hex'));
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
		rename(a, b) {
			fs.renameSync(file(a), file(b));
		}
	};
	const databaseFactory = await createSqlJsDatabaseFactory({
		load: volume.read,
		save: volume.write
	});
	const { createRelay } = await import('../../beignet-relay/relay.js');
	const { EmbeddedWalletClient } = await import('../../shared/src/index.js');
	const WebSocket = require('../../beignet-relay/node_modules/ws');
	const token = require('node:crypto').randomBytes(32).toString('base64url');
	const relay = createRelay({
		token,
		origins: ['http://127.0.0.1'],
		allowNoOrigin: true,
		electrum: { host: '127.0.0.1', port: 60001, tls: false },
		peer: { host: '127.0.0.1', port: 19846 }
	});
	const relayAddress = await relay.listen(0);
	const socketFactory = createRelaySocketFactory({
		electrumUrl: `ws://127.0.0.1:${relayAddress.port}/electrum`,
		peerUrl: `ws://127.0.0.1:${relayAddress.port}/peer`,
		token,
		WebSocket,
		electrum: { host: '127.0.0.1', port: 60001, tls: false }
	});
	let runtime;
	try {
		runtime = await createPortableRuntime({
			nodeOptions: {
				logger: {
					debug() {},
					info() {},
					warn(m, d) {
						console.error(m, d);
					},
					error(m, d) {
						console.error(m, d);
					}
				}
			},
			volume,
			databaseFactory,
			electrum: { host: '127.0.0.1', port: 60001, tls: false },
			socketFactory
		});
		const created = await runtime.request({
			method: 'POST',
			path: '/api/wallets',
			body: {
				name: 'Embedded regtest smoke',
				network: 'regtest',
				lfbw: {
					enabled: true,
					primaryUri:
						'028c6651b7759f24585df5864b4f1eaa2fc32acd17eecfef316199bf9a7606ba67@cln-transport-fixture.onion:19846'
				}
			}
		});
		// The relay targets real local CLN. This logical onion destination must
		// carry BOLT8 directly, with no duplicate SOCKS greeting inside the tunnel.
		assert.equal(created.record.lfbw.setup, 'ready', created.record.lfbw.setupError);
		const id = created.record.id;
		const rpc = (path, method = 'GET', body) =>
			runtime.request({ method, path: `/wallets/${id}/api${path}`, body });
		const client = new EmbeddedWalletClient({ runtime, walletId: id });
		const snapshot = await client.snapshot();
		assert.equal(snapshot.wallet.id, id);
		const info = await rpc('/info');
		assert.equal(info.network, 'regtest');
		await rpc('/wallet/refresh', 'POST', {});
		const address = await rpc('/address/new', 'POST', {});
		assert.match(address.address, /^bcrt1/);
		const invoice = await rpc('/invoice/create', 'POST', {
			amountSats: 1000,
			description: 'Embedded engine test',
			expirySecs: 3600
		});
		assert.match(invoice.bolt11, /^lnbcrt/);
		const decoded = await rpc('/invoice/decode', 'POST', {
			bolt11: invoice.bolt11
		});
		assert.ok(decoded);
		const reserved = await Promise.all([rpc('/address/new','POST',{}),rpc('/address/new','POST',{})]);
		assert.equal(new Set([address.address,...reserved.map(x=>x.address)]).size,3);
		const storedRequests=[];
		for(const [index,entry] of reserved.entries()) {
			const signed=await rpc('/invoice/create','POST',{amountSats:1000,description:'Durable unpaid receive '+index,expirySecs:3600});
			const fields=await rpc('/invoice/decode','POST',{bolt11:signed.bolt11});
			const request={id:'durable-smoke-'+index,uri:'bitcoin:'+entry.address+'?amount=0.00001&lightning='+signed.bolt11,
				address:entry.address,bolt11:signed.bolt11,paymentHash:signed.paymentHash,amountSats:1000,
				description:'Durable unpaid receive '+index,feeSats:0,expiresAt:(fields.timestamp+(fields.expiry??3600))*1000,warnings:[],demo:false};
			const saved=await rpc('/receive/requests','POST',{request});
			assert.equal(saved.request.bitcoinTracking,'unique');storedRequests.push(saved.request);
			const waiting=await client.getReceiveStatus(saved.request);assert.equal(waiting.phase,'waiting');
		}
		assert.deepEqual((await rpc('/receive/requests')).requests,storedRequests);
		assert.ok((await client.snapshot()).activity.filter(x=>storedRequests.some(r=>r.paymentHash===x.reference)).length===2);
		console.log('PASS concurrent distinct unpaid receive addresses and exact request metadata');
		const peers = await rpc('/peers');
		assert.ok(peers.length);
		const record = await runtime.request({ path: `/api/wallets/${id}` });
		console.log(
			JSON.stringify({
				created: true,
				nodeId: info.nodeId ?? info.pubkey,
				network: info.network,
				peers: peers.length,
				setup: record.lfbw.setup,
				setupError: record.lfbw.setupError,
				invoice: true,
				address: true
			})
		);
		console.log('pre-close invoice count', (await rpc('/invoices')).length);
		await runtime.close();
		const inspect = databaseFactory('/wallet/regtest.db');
		console.log(
			'persisted invoice count',
			inspect.prepare('SELECT count(*) n FROM invoices').get().n
		);
		inspect.close();
		runtime = await createPortableRuntime({
			nodeOptions: {
				logger: {
					debug() {},
					info() {},
					warn(m, d) {
						console.error(m, d);
					},
					error(m, d) {
						console.error(m, d);
					}
				}
			},
			volume,
			databaseFactory,
			electrum: { host: '127.0.0.1', port: 60001, tls: false },
			socketFactory
		});
		await runtime.request({ method: 'POST', path: `/api/wallets/${id}/start` });
		assert.deepEqual((await rpc('/receive/requests')).requests,storedRequests);
		const afterRestart=await rpc('/address/new','POST',{});
		assert.ok(![address.address,...reserved.map(x=>x.address)].includes(afterRestart.address));
		for(const request of storedRequests){
			const replay=await rpc('/receive/requests','POST',{request:{...request,id:'reimport-'+request.id}});
			assert.deepEqual(replay.request,request);
		}
		console.log('PASS request registry and unique address reservations survive full engine restart');
		console.log('post-restart invoice count', (await rpc('/invoices')).length);
		assert.ok(
			(await rpc('/invoices')).some(
				(x) => x.paymentHash === invoice.paymentHash
			)
		);
		console.log(
			'Onion-routed embedded handshake, invoice and identity restored across full engine restart'
		);
	} finally {
		await runtime?.close();
		await relay.close();
		fs.rmSync(temp, { recursive: true, force: true });
	}
})().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
