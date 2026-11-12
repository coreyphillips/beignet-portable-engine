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

// A WebSocket peer (a Porch link is one). The dial is watched up to the
// upgrade request, then the stream is failed so no live relay is needed.
const { EventEmitter } = require('node:events');
const route = 'k3vq' + 'a'.repeat(28);
function webSocketFixture(t, { mobileRouting, nodeRuntime }) {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const opened = [];
	const requests = [];
	const platform = [];
	const stream = (kind, target) => {
		const socket = new EventEmitter();
		Object.assign(socket, {
			writable: true,
			destroyed: false,
			setNoDelay() {},
			end() {},
			destroy() {
				if (socket.destroyed) return;
				socket.destroyed = true;
				queueMicrotask(() => socket.emit('close'));
			},
			write(data) {
				requests.push(String(data));
				queueMicrotask(() => socket.emit('error', new Error('observed the upgrade request')));
				return true;
			}
		});
		opened.push({ kind, host: target.host, port: target.port });
		return socket;
	};
	const connect = (kind) => (target, onConnect) => {
		const socket = stream(kind, target);
		queueMicrotask(onConnect);
		return socket;
	};
	const net = { handlesDestinationRouting: mobileRouting, connect: connect('tcp') };
	const tls = { connect: connect('tls') };
	const bundle = { exports: {} };
	new Function('module', 'exports', 'require', compiled)(bundle, bundle.exports, id => {
		if (id === 'net') return net;
		if (id === 'tls') return tls;
		return require(id);
	});
	const manager = new bundle.exports.PeerManager({ localPrivateKey: Buffer.alloc(32, 1) });
	return {
		opened, requests, platform,
		async dial(url) {
			// The engine reads these two globals to tell Node from a host
			// that has only a platform WebSocket.
			const version = Object.getOwnPropertyDescriptor(process.versions, 'node');
			const platformSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
			if (!nodeRuntime) Object.defineProperty(process.versions, 'node', { value: undefined, configurable: true });
			globalThis.WebSocket = function (address) {
				platform.push(address);
				queueMicrotask(() => this.onerror?.(new Error('observed the platform WebSocket')));
			};
			try {
				await assert.rejects(manager.connectPeer(peerKey, undefined, undefined, { type: 'ws', url }));
			} finally {
				Object.defineProperty(process.versions, 'node', version);
				if (platformSocket) Object.defineProperty(globalThis, 'WebSocket', platformSocket);
				else delete globalThis.WebSocket;
			}
		}
	};
}

test('on a portable host a wss:// peer is dialed through the host adapter with TLS, and asks for its own path', async t => {
	const f = webSocketFixture(t, { mobileRouting: true, nodeRuntime: false });
	await f.dial(`wss://relay.example/v1/p/${route}`);
	assert.deepEqual(f.opened, [{ kind: 'tls', host: 'relay.example', port: 443 }]);
	assert.equal(f.requests.length, 1);
	assert.match(f.requests[0], new RegExp(`^GET /v1/p/${route} HTTP/1\\.1\\r\\nHost: relay\\.example:443\\r\\n`));
	assert.match(f.requests[0], /\r\nUpgrade: websocket\r\n/);
	assert.deepEqual(f.platform, [], "the platform's own WebSocket opens a socket the host never sees");
});

test('on a portable host a ws:// peer is dialed through the host adapter without TLS', async t => {
	const f = webSocketFixture(t, { mobileRouting: true, nodeRuntime: false });
	await f.dial(`ws://127.0.0.1:2114/v1/p/${route}`);
	assert.deepEqual(f.opened, [{ kind: 'tcp', host: '127.0.0.1', port: 2114 }]);
	assert.match(f.requests[0], new RegExp(`^GET /v1/p/${route} HTTP/1\\.1\\r\\n`));
	assert.deepEqual(f.platform, []);
});

test('a host with neither Node sockets nor the adapter keeps its platform WebSocket', async t => {
	const f = webSocketFixture(t, { mobileRouting: undefined, nodeRuntime: false });
	await f.dial(`wss://relay.example/v1/p/${route}`);
	assert.deepEqual(f.platform, [`wss://relay.example/v1/p/${route}`]);
	assert.deepEqual(f.opened, []);
});

test('under Node a WebSocket peer uses the in-repo client, as before', async t => {
	const f = webSocketFixture(t, { mobileRouting: undefined, nodeRuntime: true });
	await f.dial(`wss://relay.example:8443/v1/p/${route}`);
	assert.deepEqual(f.opened, [{ kind: 'tls', host: 'relay.example', port: 8443 }]);
	assert.deepEqual(f.platform, []);
});
