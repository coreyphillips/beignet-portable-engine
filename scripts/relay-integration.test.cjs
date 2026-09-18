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

