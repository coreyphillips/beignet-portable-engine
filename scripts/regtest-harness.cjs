'use strict';
/**
 * Shared setup for the live regtest scripts: the regtest bitcoind in Docker,
 * a disposable upstream Beignet primary with the direct-funding relay on, a
 * byte relay in front of the local Electrum and that primary, and portable
 * runtimes on their own durable volumes. regtest.cjs predates this file and
 * still carries its own copy of the same setup.
 */
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
/** Mine one block every few seconds while a condition is awaited. */
function miner(everyMs = 3000) {
	let minedAt = 0;
	return () => {
		if (Date.now() - minedAt > everyMs) {
			btc('-generate', '1');
			minedAt = Date.now();
		}
	};
}
async function freePort() {
	const probe = net.createServer();
	await new Promise((r) => probe.listen(0, '127.0.0.1', r));
	const port = probe.address().port;
	await new Promise((r) => probe.close(r));
	return port;
}
/** A durable volume in a fresh directory, fsynced and renamed like the apps do. */
function makeVolume(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const file = (p) => path.join(dir, 'device-' + Buffer.from(p).toString('hex'));
	return {
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
}

/**
 * Bring up the shared pieces once. Returns the primary, the relay socket
 * factory settings, and `device(name)` which creates a portable runtime and
 * embedded client on its own volume. `close()` tears everything down.
 */
async function createHarness({ prefix = 'beignet-portable-', ffor = false } = {}) {
	if (JSON.parse(btc('getblockchaininfo')).chain !== 'regtest')
		throw new Error('the bitcoin container is not on regtest');
	const { BeignetNode } = require(path.join(
		process.env.BEIGNET_SOURCE_DIR ||
			'/Users/coreyphillips/Documents/synonym/beignet',
		'dist/cli/beignet-node.js'
	));
	const { EmbeddedWalletClient } = await import('../../shared/src/index.js');
	const { createRelay } = await import('../../beignet-relay/relay.js');
	const WebSocket = require('../../beignet-relay/node_modules/ws');
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const peerPort = await freePort();
	const primary = await BeignetNode.create({
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
		fforSettle: { enabled: ffor },
		logger: { debug() {}, info() {}, warn() {}, error() {} }
	});
	await primary.refreshWallet();
	btc('sendtoaddress', await primary.getNewAddress(), '0.05000000');
	btc('-generate', '1');
	await delay(2000);
	await primary.refreshWallet();
	await wait(
		'disposable primary funded with regtest coins',
		() => primary.getBalance().onchain >= 5000000
	);
	const token = crypto.randomBytes(32).toString('base64url');
	const electrum = { host: 'electrum.relay', port: 50001, tls: false };
	const relay = createRelay({
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
	/** A second relay and socket factory, for tests that must rule the relay in or out. */
	const freshTransport = async () => {
		const other = createRelay({
			token,
			origins: ['http://127.0.0.1'],
			allowNoOrigin: true,
			electrum: { host: '127.0.0.1', port: 60001, tls: false },
			peer: { host: '127.0.0.1', port: peerPort }
		});
		const address = await other.listen(0);
		extraRelays.push(other);
		return createRelaySocketFactory({
			electrumUrl: `ws://127.0.0.1:${address.port}/electrum`,
			peerUrl: `ws://127.0.0.1:${address.port}/peer`,
			token,
			WebSocket,
			electrum
		});
	};
	const extraRelays = [];
	const primaryUri = `${primary.getInfo().nodeId}@127.0.0.1:${peerPort}`;
	const devices = [];
	/** A portable runtime on its own volume, with a wallet created on the primary. */
	const device = async (name, { onDiagnostic, socketFactory: factory } = {}) => {
		const volume = makeVolume(path.join(temp, name));
		const databaseFactory = await createSqlJsDatabaseFactory({
			load: volume.read,
			save: volume.write
		});
		const options = {
			volume,
			databaseFactory,
			socketFactory: factory ?? socketFactory,
			electrum,
			...(onDiagnostic ? { onDiagnostic } : {}),
			...(process.env.HARNESS_ENGINE_LOG
				? {
						nodeOptions: {
							logger: {
								debug: (...a) => process.env.HARNESS_ENGINE_LOG === '2' && console.log(`[${name} debug]`, ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).slice(0, 4)),
								info: (...a) => process.env.HARNESS_ENGINE_LOG === '2' && console.log(`[${name} info]`, ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).slice(0, 4)),
								warn: (...a) => console.log(`[${name} warn]`, ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).slice(0, 4)),
								error: (...a) => console.log(`[${name} error]`, ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).slice(0, 4))
							}
						}
				  }
				: {})
		};
		const runtime = await createPortableRuntime(options);
		const client = new EmbeddedWalletClient({ runtime });
		const created = await client.createWallet({
			name,
			network: 'regtest',
			primaryUri,
			electrum
		});
		const id = created.id;
		const rpc = (route, method = 'GET', body) =>
			runtime.request({ method, path: `/wallets/${id}/api${route}`, body });
		const record = () => runtime.request({ path: `/api/wallets/${id}` });
		const dev = { name, id, runtime, client, rpc, record, options };
		devices.push(dev);
		return dev;
	};
	const close = async () => {
		for (const dev of devices.reverse())
			await dev.runtime.close().catch(() => {});
		for (const other of extraRelays) await other.close().catch(() => {});
		await relay.close().catch(() => {});
		await primary.gracefulShutdown(5000).catch(() => {});
		fs.rmSync(temp, { recursive: true, force: true });
	};
	return {
		primary,
		primaryUri,
		peerPort,
		relayPort: relayAddress.port,
		freshTransport,
		token,
		electrum,
		device,
		close,
		BeignetNode,
		temp
	};
}

module.exports = { btc, wait, delay, miner, createHarness, makeVolume };
