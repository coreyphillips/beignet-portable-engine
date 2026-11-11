const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Socket } = require('node:net');
const { buildSync } = require('esbuild');

const compiled = buildSync({
	entryPoints: [require.resolve('../src/lightning/transport/peer-manager.ts')],
	bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text;
const peerKey = '02' + 'ab'.repeat(32);
const onion = { host: 'a'.repeat(56) + '.onion', port: 9735 };
const iroh = { type: 'iroh', endpointId: 'b'.repeat(64), fallbackOnion: onion };

function fixture(t, { mobileRouting = true, irohOnline = true } = {}) {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const routes = [];
	const dialled = [];
	const inspected = new Error('observed socket before Noise handshake');
	function socket(route) {
		const result = new Socket();
		// Peer enables keepalive on the winning socket before it sends any
		// handshake bytes. Stop there so the test never needs a live peer.
		result.setKeepAlive = () => {
			routes.push({ route, viaTor: result.viaTor });
			throw inspected;
		};
		return result;
	}
	const net = {
		handlesDestinationRouting: mobileRouting,
		connect(destination) {
			dialled.push(destination);
			const result = socket('platform TCP');
			queueMicrotask(() => result.emit('connect'));
			return result;
		}
	};
	const socks = { SocksClient: { async createConnection({ destination }) {
		dialled.push(destination);
		return { socket: socket('SOCKS5') };
	} } };
	const bundle = { exports: {} };
	new Function('module', 'exports', 'require', compiled)(bundle, bundle.exports, id => {
		if (id === 'net') return net;
		if (id === 'socks') return socks;
		return require(id);
	});
	const manager = new bundle.exports.PeerManager({
		localPrivateKey: Buffer.alloc(32, 1),
		socks5Proxy: { host: '127.0.0.1', port: 9050 },
		iroh: { secretKey: Buffer.alloc(32, 2), factory: async () => ({
			async connect() {
				if (!irohOnline) throw new Error('Iroh unavailable');
				return socket('Iroh');
			}
		}) }
	});
	return {
		routes, dialled,
		dial: (host, port, transport) => assert.rejects(
			manager.connectPeer(peerKey, host, port, transport), error => error === inspected
		)
	};
}

test('a winning Iroh connection with an onion fallback keeps its direct route', async t => {
	const f = fixture(t);
	await f.dial(iroh.endpointId, 0, iroh);
	assert.deepEqual(f.routes, [{ route: 'Iroh', viaTor: undefined }]);
	assert.deepEqual(f.dialled, []);
});

test('a winning onion fallback through the mobile adapter marks the selected socket', async t => {
	const f = fixture(t, { irohOnline: false });
	await f.dial(iroh.endpointId, 0, iroh);
	assert.deepEqual(f.routes, [{ route: 'platform TCP', viaTor: true }]);
	assert.deepEqual(f.dialled, [onion]);
});

test('a clearnet peer reached through a configured SOCKS5 proxy is a proxied socket', async t => {
	const f = fixture(t, { mobileRouting: false });
	await f.dial('peer.example', 9735);
	assert.deepEqual(f.routes, [{ route: 'SOCKS5', viaTor: true }]);
	assert.deepEqual(f.dialled, [{ host: 'peer.example', port: 9735 }]);
});
