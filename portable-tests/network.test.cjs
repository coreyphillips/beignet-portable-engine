const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { buildSync } = require('esbuild');

// Compile this small boundary independently; no running wallet, stored seed,
// network listener or production bundle mutation is needed for these checks.
const compiled = buildSync({
	entryPoints: [path.join(__dirname, '../portable/network.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false
}).outputFiles[0].text;
const moduleFixture = { exports: {} };
new Function('module', 'exports', 'require', compiled)(
	moduleFixture,
	moduleFixture.exports,
	require
);
const { verifyElectrumNetwork } = moduleFixture.exports;

// Header fields published in Bitcoin Core src/kernel/chainparams.cpp:
// https://github.com/bitcoin/bitcoin/blob/master/src/kernel/chainparams.cpp
const parameters = {
	mainnet: [1231006505, 2083236893, 0x1d00ffff],
	testnet: [1296688602, 414098458, 0x1d00ffff],
	signet: [1598918400, 52613770, 0x1e0377ae],
	regtest: [1296688602, 2, 0x207fffff]
};
const headers = Object.fromEntries(
	Object.entries(parameters).map(([network, [time, nonce, bits]]) => {
		const header = Buffer.alloc(80);
		header.writeUInt32LE(1, 0);
		Buffer.from(
			'4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
			'hex'
		)
			.reverse()
			.copy(header, 36);
		header.writeUInt32LE(time, 68);
		header.writeUInt32LE(bits, 72);
		header.writeUInt32LE(nonce, 76);
		return [network, header.toString('hex')];
	})
);
const electrum = { host: 'fixed-electrum.example', port: 50002, tls: true };

function fixture(result, { error, chunked = false, close = false } = {}) {
	const state = { dials: 0, writes: [], destroys: 0 };
	const socketFactory = (target) => {
		state.dials++;
		assert.deepEqual(target, electrum);
		const socket = new EventEmitter();
		socket.destroy = () => {
			state.destroys++;
		};
		socket.write = (bytes) => {
			state.writes.push(JSON.parse(Buffer.from(bytes).toString('utf8')));
			queueMicrotask(() => {
				if (close) return socket.emit('close');
				if (error instanceof Error) return socket.emit('error', error);
				const response =
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						result,
						...(error ? { error } : {})
					}) + '\n';
				if (chunked) {
					socket.emit('data', Buffer.from(response.slice(0, 25)));
					socket.emit('data', Buffer.from(response.slice(25)));
				} else socket.emit('data', Buffer.from(response));
			});
		};
		queueMicrotask(() => socket.emit('connect'));
		return socket;
	};
	return { socketFactory, state };
}

test('known genesis headers verify each supported network, using only a height-zero header query', async () => {
	for (const [network, header] of Object.entries(headers)) {
		const { socketFactory, state } = fixture(header, { chunked: true });
		await verifyElectrumNetwork({ network, electrum, socketFactory });
		assert.equal(state.dials, 1);
		assert.equal(state.destroys, 1);
		assert.deepEqual(state.writes, [
			{ jsonrpc: '2.0', id: 1, method: 'blockchain.block.header', params: [0] }
		]);
	}
});

test('every differently configured Bitcoin network fails closed', async () => {
	for (const network of Object.keys(headers)) {
		for (const [other, header] of Object.entries(headers)) {
			if (other === network) continue;
			const { socketFactory, state } = fixture(header);
			await assert.rejects(
				verifyElectrumNetwork({ network, electrum, socketFactory }),
				{ code: 'NETWORK_MISMATCH', status: 409 }
			);
			assert.equal(state.destroys, 1);
		}
	}
});

test('malformed, missing and tampered genesis evidence never verifies', async () => {
	for (const header of [
		null,
		{},
		'',
		headers.mainnet.slice(2),
		headers.mainnet + '00',
		'z'.repeat(160)
	]) {
		const { socketFactory } = fixture(header);
		await assert.rejects(
			verifyElectrumNetwork({ network: 'mainnet', electrum, socketFactory }),
			{ code: 'NETWORK_UNVERIFIED', status: 503 }
		);
	}
	const { socketFactory } = fixture('00' + headers.mainnet.slice(2));
	await assert.rejects(
		verifyElectrumNetwork({ network: 'mainnet', electrum, socketFactory }),
		{ code: 'NETWORK_MISMATCH' }
	);
});

test('unsupported names fail before transport; disconnected and refused servers do not trigger fallback', async () => {
	const neverDial = fixture(headers.mainnet);
	for (const network of ['bitcoin', 'testnet4', '__proto__', 'toString'])
		await assert.rejects(
			verifyElectrumNetwork({
				network,
				electrum,
				socketFactory: neverDial.socketFactory
			}),
			{ code: 'INVALID_NETWORK' }
		);
	assert.equal(neverDial.state.dials, 0);
	for (const options of [
		{ error: new Error('offline') },
		{ error: { code: -1, message: 'refused' } },
		{ close: true }
	]) {
		const { socketFactory, state } = fixture(undefined, options);
		await assert.rejects(
			verifyElectrumNetwork({ network: 'mainnet', electrum, socketFactory }),
			{ code: 'NETWORK_UNVERIFIED', status: 503 }
		);
		assert.equal(state.dials, 1);
		assert.equal(state.destroys, 1);
	}
});

test('actual runtime refuses a mismatched server before opening its database or contacting a peer', async () => {
	const {
		createPortableRuntime,
		DEFAULT_PRIMARY
	} = require('../dist/portable.cjs');
	const files = new Map();
	let databaseOpens = 0;
	const { socketFactory, state } = fixture(headers.mainnet);
	const runtime = await createPortableRuntime({
		volume: {
			read: (name) => files.get(name) ?? null,
			write: (name, bytes) => files.set(name, Uint8Array.from(bytes)),
			remove: (name) => files.delete(name),
			rename: (from, to) => {
				files.set(to, files.get(from));
				files.delete(from);
			}
		},
		databaseFactory() {
			databaseOpens++;
			throw new Error('The engine must not open before network verification');
		},
		electrum,
		socketFactory
	});
	try {
		const created = await runtime.request({
			method: 'POST',
			path: '/api/wallets',
			body: {
				name: 'Network guard fixture',
				network: 'regtest',
				lfbw: { enabled: true, primaryUri: DEFAULT_PRIMARY }
			}
		});
		assert.equal(created.record.status, 'stopped');
		assert.equal(created.record.lfbw.setup, 'failed');
		assert.match(created.record.lfbw.setupError, /does not serve regtest/);
		assert.equal(databaseOpens, 0);
		await assert.rejects(
			runtime.request({
				method: 'POST',
				path: `/api/wallets/${created.record.id}/start`
			}),
			{ code: 'NETWORK_MISMATCH' }
		);
		assert.equal(databaseOpens, 0);
		assert.equal(state.dials, 2);
		assert.ok(
			state.writes.every(
				(request) => request.method === 'blockchain.block.header'
			)
		);
	} finally {
		await runtime.close();
	}
});
