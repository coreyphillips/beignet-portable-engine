const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const path = require('node:path');

const compiled = buildSync({
	entryPoints: [path.join(__dirname, '../src/lightning/transport/peer.ts')],
	bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text;
const fixture = { exports: {} };
new Function('module', 'exports', 'require', compiled)(fixture, fixture.exports, require);

function livePeer(t) {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1 });
	const peer = new fixture.exports.Peer({
		localPrivateKey: Buffer.alloc(32, 1), remotePublicKey: Buffer.alloc(33, 2),
		host: 'localhost', port: 9735
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
