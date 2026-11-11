const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const compiled = buildSync({
	stdin: {
		contents: [
			"export { Peer } from './src/lightning/transport/peer';",
			"export { Socket } from './portable/net';",
			"export { configure, release } from './portable/state';"
		].join('\n'),
		resolveDir: path.join(__dirname, '..')
	},
	bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text;
const fixture = { exports: {} };
new Function('module', 'exports', 'require', compiled)(fixture, fixture.exports, require);

function livePeer(t, options = {}) {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1 });
	const peer = new fixture.exports.Peer({
		localPrivateKey: Buffer.alloc(32, 1), remotePublicKey: Buffer.alloc(33, 2),
		host: 'localhost', port: 9735, ...options
	});
	const sent = [], errors = [];
	peer.state = 'ready';
	peer.sendMessage = (type) => { assert.equal(type, 18); sent.push(Date.now()); };
	peer.on('error', (error) => errors.push(error.message));
	peer.startPingTimer();
	return { peer, sent, errors, tick: ms => t.mock.timers.tick(ms),
		pong: () => peer.handleMessage(19, Buffer.from([0, 1, 0])) };
}

test('an overdue foreground timer cannot close a live socket before its delayed pong', t => {
	const { peer, tick, pong, sent, errors } = livePeer(t);
	tick(30000); // The ping is already on the wire when Android pauses.
	peer.setAppBackgrounded(true);
	tick(65000); // Timers dispatched before the active event must be harmless too.
	peer.setAppBackgrounded(false);
	assert.equal(sent.length, 2);
	tick(250);
	pong();
	tick(5000);
	assert.equal(peer.getState(), 'ready');
	assert.deepEqual(errors, []);
});

test('a buffered pong processed just before active proves the existing link', t => {
	const { peer, tick, pong, sent } = livePeer(t);
	tick(30000);
	peer.setAppBackgrounded(true);
	tick(65000);
	pong();
	tick(25);
	peer.setAppBackgrounded(false);
	peer.setAppBackgrounded(false);
	tick(5000);
	assert.equal(sent.length, 1);
	assert.equal(peer.getState(), 'ready');
});

test('a long return probes an idle connection and closes a silent peer after five seconds', t => {
	const { peer, tick, sent, errors } = livePeer(t);
	peer.setAppBackgrounded(true);
	tick(30000);
	peer.setAppBackgrounded(true);
	peer.setAppBackgrounded(false);
	assert.equal(sent.length, 1);
	tick(4999);
	assert.equal(peer.getState(), 'ready');
	tick(1);
	assert.deepEqual(errors, ['Pong timeout']);
	assert.equal(peer.getState(), 'disconnected');
});

test('a pong early in a long absence cannot vouch for a socket that later died', t => {
	const { peer, tick, pong, errors } = livePeer(t);
	tick(30000);
	peer.setAppBackgrounded(true);
	tick(50);
	pong();
	tick(65000);
	peer.setAppBackgrounded(false);
	tick(5000);
	assert.deepEqual(errors, ['Pong timeout']);
});

test('a short absence with an outstanding ping preserves its original deadline', t => {
	const { peer, tick, errors } = livePeer(t);
	tick(30000);
	tick(20000);
	peer.setAppBackgrounded(true);
	tick(5000);
	peer.setAppBackgrounded(false);
	tick(34999);
	assert.equal(peer.getState(), 'ready');
	tick(1);
	assert.deepEqual(errors, ['Pong timeout']);
});

test('a short absence without an outstanding ping leaves the peer idle', t => {
	const { peer, tick, sent } = livePeer(t);
	peer.setAppBackgrounded(true);
	tick(3000);
	peer.setAppBackgrounded(false);
	assert.equal(sent.length, 0);
	tick(30000);
	assert.equal(sent.length, 1);
});

test('foreground pings still expire sixty seconds after the oldest unanswered ping', t => {
	const { peer, tick, errors } = livePeer(t);
	tick(30000);
	tick(30000);
	tick(29999);
	assert.equal(peer.getState(), 'ready');
	tick(1);
	assert.deepEqual(errors, ['Pong timeout']);
});

test('repeated short visits keep the first ping and its original deadline', t => {
	const { peer, tick, sent, errors } = livePeer(t);
	for (let visit = 0; visit < 4; visit++) {
		for (let second = 0; second < 24; second++) tick(1000);
		peer.setAppBackgrounded(true);
		tick(1000);
		peer.setAppBackgrounded(false);
	}
	assert.equal(sent[0], 30001);
	assert.deepEqual(errors, ['Pong timeout']);
	assert.equal(peer.getState(), 'disconnected');
});

test('a short return sends a ping whose interval fired before the active event', t => {
	const { peer, tick, sent } = livePeer(t);
	tick(29500);
	peer.setAppBackgrounded(true);
	tick(1000);
	assert.equal(sent.length, 0);
	peer.setAppBackgrounded(false);
	assert.equal(sent.length, 1);
});

test('one-second app switches consume a single grace period for an overdue ping', t => {
	const { peer, tick, errors } = livePeer(t);
	tick(30000);
	tick(59000);
	peer.setAppBackgrounded(true);
	tick(1000);
	peer.setAppBackgrounded(false);
	for (let visit = 0; visit < 4; visit++) {
		tick(1000);
		peer.setAppBackgrounded(true);
		tick(1000);
		peer.setAppBackgrounded(false);
	}
	tick(999);
	assert.equal(peer.getState(), 'ready');
	tick(1);
	assert.deepEqual(errors, ['Pong timeout']);
});

test('a queued pong in the remaining grace period keeps the peer connected', t => {
	const { peer, tick, pong, errors } = livePeer(t);
	peer.setAppBackgrounded(true);
	tick(65000);
	peer.setAppBackgrounded(false);
	tick(3000);
	peer.setAppBackgrounded(true);
	tick(1000);
	peer.setAppBackgrounded(false);
	tick(1900);
	pong();
	tick(1000);
	assert.deepEqual(errors, []);
	assert.equal(peer.getState(), 'ready');
});

function connectPlatformSocket(t, peer, host, viaTor = false) {
	const native = Object.assign(new EventEmitter(), { viaTor, destroy() {} });
	fixture.exports.configure({ socketFactory: () => native });
	t.after(() => fixture.exports.release());
	peer.socket = new fixture.exports.Socket().connect(9735, host);
}

test('a platform onion stays ready when a live circuit returns its pong after 15 seconds', t => {
	const { peer, tick, pong, sent, errors } = livePeer(t);
	connectPlatformSocket(t, peer, 'a'.repeat(56) + '.onion');
	peer.setAppBackgrounded(true);
	tick(65000);
	peer.setAppBackgrounded(false);
	assert.equal(sent.length, 1);
	tick(15000);
	pong();
	tick(20000);
	assert.deepEqual(errors, []);
	assert.equal(peer.getState(), 'ready');
});

test('a silent platform-proxied socket closes at its configured pong timeout', t => {
	const { peer, tick, sent, errors } = livePeer(t, { pongTimeout: 12000 });
	connectPlatformSocket(t, peer, 'peer.example', true);
	peer.setAppBackgrounded(true);
	tick(30000);
	peer.setAppBackgrounded(false);
	assert.equal(sent.length, 1);
	tick(11999);
	assert.equal(peer.getState(), 'ready');
	tick(1);
	assert.deepEqual(errors, ['Pong timeout']);
	assert.equal(peer.getState(), 'disconnected');
});

test('a direct platform socket keeps the five-second probe', t => {
	const { peer, tick, sent, errors } = livePeer(t);
	connectPlatformSocket(t, peer, 'peer.example');
	peer.setAppBackgrounded(true);
	tick(30000);
	peer.setAppBackgrounded(false);
	assert.equal(sent.length, 1);
	tick(5000);
	assert.deepEqual(errors, ['Pong timeout']);
});
