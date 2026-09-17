'use strict';
/**
 * A second phone, in its own process because one process may own one
 * portable runtime: it takes one confirmed coin below the channelize floor
 * and pays the request it is handed as a direct funding through the shared
 * client. Driven by regtest-channelize.cjs; prints one JSON line per step.
 */
const path = require('node:path');
const root = path.join(__dirname, '..');
const { createPortableRuntime, createRelaySocketFactory } = require(path.join(root, 'dist/portable.cjs'));
const { createSqlJsDatabaseFactory } = require(path.join(root, 'dist/sqljs.cjs'));
const { btc, delay, makeVolume } = require('./regtest-harness.cjs');
const WebSocket = require(path.join(root, '../beignet-relay/node_modules/ws'));
const say = (step, value) => console.log(`CHILD ${step} ${JSON.stringify(value)}`);
(async () => {
	const { EmbeddedWalletClient } = await import('../../shared/src/index.js');
	const electrum = { host: 'electrum.relay', port: 50001, tls: false };
	const socketFactory = createRelaySocketFactory({
		electrumUrl: `ws://127.0.0.1:${process.env.RELAY_PORT}/electrum`,
		peerUrl: `ws://127.0.0.1:${process.env.RELAY_PORT}/peer`,
		token: process.env.TOKEN,
		WebSocket,
		electrum
	});
	const volume = makeVolume(process.env.VOLUME);
	const databaseFactory = await createSqlJsDatabaseFactory({ load: volume.read, save: volume.write });
	const runtime = await createPortableRuntime({
		volume,
		databaseFactory,
		socketFactory,
		electrum,
		onDiagnostic: (e) => say('diag', e)
	});
	const client = new EmbeddedWalletClient({ runtime });
	try {
		const created = await client.createWallet({
			name: 'payer',
			network: 'regtest',
			primaryUri: process.env.PRIMARY_URI,
			electrum
		});
		const id = created.id;
		const rpc = (route, method = 'GET', body) => runtime.request({ method, path: `/wallets/${id}/api${route}`, body });
		const record = () => runtime.request({ path: `/api/wallets/${id}` });
		for (let i = 0; i < 120 && (await record()).lfbw.setup !== 'ready'; i++) await delay(500);
		say('setup', (await record()).lfbw.setup);
		const { address } = await rpc('/address/new', 'POST', {});
		const depositTxid = btc('sendtoaddress', address, '0.00020000');
		btc('-generate', '1');
		await delay(1500);
		for (let i = 0; i < 60; i++) {
			await client.refreshWallet();
			const utxos = await rpc('/utxos');
			if (utxos.some((u) => u.valueSats === 20000 && u.height > 0)) break;
			await delay(1000);
		}
		say('coin', { depositTxid, utxos: await rpc('/utxos'), last: (await record()).lfbw.lastChannelize });
		const review = await client.prepareSend({ request: process.env.REQUEST_URI });
		say('review', { route: review.route, method: review.method, feeSats: review.feeSats, warnings: review.warnings });
		const sent = await client.send(review);
		say('sent', sent);
		if (sent.status === 'pending' || sent.status === 'completed') {
			// Mine a block every few seconds until the wallet's own row settles.
			let minedAt = 0;
			for (let i = 0; i < 160; i++) {
				if (Date.now() - minedAt > 3000) {
					btc('-generate', '1');
					minedAt = Date.now();
				}
				const row = (await client.snapshot()).activity.find((x) => x.id === `submission:${review.id}`);
				if (row && row.status === 'completed') {
					say('row', row);
					break;
				}
				await delay(1000);
			}
		}
		say('utxos', await rpc('/utxos'));
	} finally {
		await runtime.close().catch(() => {});
	}
})().catch((e) => {
	console.error('CHILD error', e);
	process.exitCode = 1;
});
