const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createRelaySocketFactory } = require('../dist/portable.cjs');

const token = 'test-relay-credential-not-for-public-errors-1234';
const electrum = { host: 'electrum.example', port: 50002, tls: true };
const primary = { host: 'mint.local', port: 9103, tls: false };
const config = {
	electrumUrl: 'ws://127.0.0.1:8787/transport/electrum',
	peerUrl: 'ws://127.0.0.1:8787/transport/peer',
	token,
	electrum
};
class TestWebSocket {
	static latest;
	constructor() { TestWebSocket.latest = this; this.readyState = 1; }
	close() {}
}
function fixture(target = primary) {
	const socket = createRelaySocketFactory({ ...config, WebSocket: TestWebSocket })(target);
	const events = [];
	socket.on('error', error => events.push(error));
	socket.on('close', () => events.push('close'));
	return { socket, ws: TestWebSocket.latest, events };
}

test('portable relay preserves safe upstream categories before close, with local endpoint context', () => {
	for (const [suffix, phrase] of [
		['REFUSED', 'refused connection'], ['DNS', 'hostname could not be resolved'],
		['TIMEOUT', 'connection timed out'], ['TLS', 'TLS certificate could not be verified'],
		['UNREACHABLE', 'is unreachable'], ['UNAVAILABLE', 'connection is unavailable']
	]) {
		const { ws, events } = fixture();
		ws.onclose({ code: 1011, reason: `BEIGNET_UPSTREAM_${suffix}` });
		assert.equal(events.length, 2);
		assert.equal(events[0].code, `BEIGNET_UPSTREAM_${suffix}`);
		assert.ok(events[0].message.startsWith('Primary node '));
		assert.ok(events[0].message.includes(phrase));
		assert.ok(events[0].message.includes('mint.local'));
		assert.ok(!events[0].message.includes(token));
		assert.equal(events[1], 'close');
	}
	const { ws, events } = fixture(electrum);
	ws.onclose({ code: 1011, reason: 'BEIGNET_UPSTREAM_REFUSED' });
	assert.match(events[0].message, /^Electrum server refused connection at electrum.example:50002/);
});

test('arbitrary close payloads and invalid target strings never become error text', () => {
	for (const reason of [token, 'constructor', '__proto__', { private: token }]) {
		const { ws, events } = fixture({ host: `https://user:${token}@host`, port: 9103, tls: false });
		ws.onclose({ code: 1011, reason });
		assert.equal(events[0].code, 'BEIGNET_UPSTREAM_UNAVAILABLE');
		assert.match(events[0].message, /configured host:9103/);
		assert.ok(!events[0].message.includes(token));
		assert.ok(!events[0].message.includes('user:'));
	}
});

test('explicit shutdown, normal close and relay failures do not duplicate error events', () => {
	for (const method of ['end', 'destroy']) {
		const { socket, ws, events } = fixture();
		socket[method]();
		ws.onclose({ code: 1011, reason: 'BEIGNET_UPSTREAM_REFUSED' });
		assert.deepEqual(events, ['close']);
	}
	for (const code of [1000, 1001]) {
		const { ws, events } = fixture();
		ws.onclose({ code, reason: token });
		assert.deepEqual(events, ['close']);
	}
	const { ws, events } = fixture();
	ws.onerror({ message: token });
	ws.onclose({ code: 1006, reason: token });
	assert.equal(events.length, 2);
	assert.equal(events[0].message, 'Unable to connect to transport relay');
	assert.equal(events[1], 'close');
});

test('actual attached relay TCP refusal reaches the production portable socket promptly', async t => {
	const http = require('node:http');
	const { attachRelay } = await import(pathToFileURL(path.join(__dirname, '../../beignet-relay/relay.js')).href);
	const { WebSocket } = require('../../beignet-relay/node_modules/ws');
	const reserved = net.createServer();
	reserved.listen(0, '127.0.0.1');
	await once(reserved, 'listening');
	const port = reserved.address().port;
	await new Promise(resolve => reserved.close(resolve));
	const server = http.createServer();
	const relay = attachRelay(server, {
		electrum, peer: { host: '127.0.0.1', port }
	}, { authorizeUpgrade: (_request, credential) => credential === token });
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(async () => {
		await relay.close();
		await new Promise(resolve => server.close(resolve));
	});
	const origin = `ws://127.0.0.1:${server.address().port}`;
	const socket = createRelaySocketFactory({
		...config, WebSocket,
		peerUrl: `${origin}/transport/peer`,
		electrumUrl: `${origin}/transport/electrum`
	})(primary);
	const closed = new Promise(resolve => socket.once('close', resolve));
	const [error] = await once(socket, 'error');
	await closed;
	assert.equal(error.code, 'BEIGNET_UPSTREAM_REFUSED');
	assert.match(error.message, /Primary node refused connection at mint.local:9103/);
	assert.ok(!error.message.includes(token));
});

test('a local destroy reports close at once, even when the relay never acknowledges it', async () => {
	for (const method of ['end', 'destroy']) {
		const { socket, ws, events } = fixture();
		socket[method]();
		assert.deepEqual(events, [], 'close is reported asynchronously, like a Node socket');
		await Promise.resolve();
		assert.deepEqual(events, ['close']);
		// A late acknowledgement from the relay must not report a second close.
		ws.onclose({ code: 1000, reason: 'late' });
		assert.deepEqual(events, ['close']);
	}
});
