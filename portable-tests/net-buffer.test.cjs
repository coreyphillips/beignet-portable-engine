const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { buildSync } = require('esbuild');
const source = buildSync({
	stdin: {
		contents:
			"export {Socket} from './portable/net'; export {configure,release} from './portable/state';",
		resolveDir: path.join(__dirname, '..')
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false
}).outputFiles[0].text;
const fixture = { exports: {} };
new Function('module', 'exports', 'require', source)(
	fixture,
	fixture.exports,
	require
);
const { Socket, configure, release } = fixture.exports;
function setup() {
	const inner = new EventEmitter();
	inner.destroy = (error) => {
		if (error) inner.emit('error', error);
		inner.emit('close');
	};
	configure({ socketFactory: () => inner });
	const socket = new Socket().connect({ host: 'test.invalid', port: 1 });
	return {
		inner,
		socket,
		close() {
			socket.destroy();
			release();
		}
	};
}
const tick = () => new Promise((resolve) => queueMicrotask(resolve));

test('synchronous host chunks survive listener replacement between handshake reads', async () => {
	const f = setup();
	try {
		const seen = [];
		f.socket.once('data', (data) => seen.push(data.toString()));
		f.inner.emit('data', Buffer.from('init'));
		f.inner.emit('data', Buffer.from('large-frame-first'));
		f.inner.emit('data', Buffer.from('large-frame-last'));
		await tick();
		assert.deepEqual(seen, ['init']);
		f.socket.once('data', (data) => seen.push(data.toString()));
		await tick();
		assert.deepEqual(seen, ['init', 'large-frame-first']);
		f.socket.on('data', (data) => seen.push(data.toString()));
		f.inner.emit('data', Buffer.from('later-quote'));
		await tick();
		assert.deepEqual(seen, [
			'init',
			'large-frame-first',
			'large-frame-last',
			'later-quote'
		]);
	} finally {
		f.close();
	}
});

test('paused data stays ordered before end and listener-triggered flush respects a pause', async () => {
	const f = setup();
	try {
		const seen = [];
		f.socket.pause();
		f.inner.emit('data', Buffer.from('one'));
		f.inner.emit('end');
		f.socket.on('data', (data) => seen.push(data.toString()));
		f.socket.on('end', () => seen.push('end'));
		await tick();
		assert.deepEqual(seen, []);
		f.socket.resume();
		assert.deepEqual(seen, ['one', 'end']);
	} finally {
		f.close();
	}
});

test('destroy drops pending data and the queue is bounded', async () => {
	const f = setup();
	try {
		const errors = [];
		const seen = [];
		f.socket.on('error', (error) => errors.push(error.message));
		f.inner.emit('data', Buffer.alloc(2 * 1024 * 1024));
		f.inner.emit('data', Buffer.from([1]));
		assert.equal(f.socket.destroyed, true);
		assert.deepEqual(errors, ['Portable socket read buffer exceeded']);
		f.socket.on('data', (data) => seen.push(data));
		f.inner.emit('data', Buffer.from('late'));
		await tick();
		assert.deepEqual(seen, []);
	} finally {
		f.close();
	}
});
