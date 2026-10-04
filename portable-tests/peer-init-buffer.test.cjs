'use strict';
// Exercise the real peer with valid encrypted frames and synchronous host chunks.
const path = require('node:path');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const { build } = require('esbuild');

function nativeSender(key) {
	let counter = 0n;
	const encrypt = (plain) => {
		const nonce = Buffer.alloc(12);
		nonce.writeBigUInt64LE(counter++, 4);
		const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, {
			authTagLength: 16
		});
		cipher.setAAD(Buffer.alloc(0));
		return Buffer.concat([
			cipher.update(plain),
			cipher.final(),
			cipher.getAuthTag()
		]);
	};
	return (plain) => {
		const size = Buffer.alloc(2);
		size.writeUInt16BE(plain.length);
		return Buffer.concat([encrypt(size), encrypt(plain)]);
	};
}

test('portable peer retains a large storage frame across the init listener handoff', async () => {
	const compiled = await build({
		stdin: {
			resolveDir: root,
			contents: `
      export { Peer } from './src/lightning/transport/peer';
      export { TransportCipher } from './src/lightning/transport/cipher';
      export { Socket } from './portable/net';
      export { configure, release } from './portable/state';
      export { Buffer } from 'buffer';`
		},
		bundle: true,
		platform: 'browser',
		format: 'cjs',
		target: 'es2020',
		write: false,
		alias: {
			crypto: path.join(root, 'portable/crypto.ts'),
			net: path.join(root, 'portable/net.ts')
		},
		inject: [path.join(root, 'portable/globals.ts')]
	});
	const mod = { exports: {} };
	new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(
		mod,
		mod.exports,
		require
	);
	const {
		Peer,
		TransportCipher,
		Socket,
		configure,
		release,
		Buffer: B
	} = mod.exports;
	{
		const inner = new EventEmitter();
		inner.destroy = () => {};
		configure({ socketFactory: () => inner });
		const socket = new Socket().connect({ host: 'unused.invalid', port: 1 });
		try {
			const key = Buffer.alloc(32, 3),
				reverse = Buffer.alloc(32, 4),
				chain = Buffer.alloc(32, 5);
			const packet = nativeSender(key);
			const peer = new Peer({
				localPrivateKey: B.alloc(32, 1),
				remotePublicKey: B.alloc(33, 2),
				host: 'unused.invalid',
				port: 1
			});
			peer.socket = socket;
			peer.transport = new TransportCipher(
				B.from(reverse),
				B.from(key),
				B.from(chain)
			);
			peer.state = 'init';
			const errors = [],
				messages = [];
			peer.on('error', (error) => errors.push(error.message));
			peer.on('message', (type, payload) =>
				messages.push([type, payload.length])
			);
			const init = packet(Buffer.from([0, 16, 0, 0, 0, 0]));
			const large = Buffer.alloc(65535);
			large.writeUInt16BE(7);
			large.writeUInt16BE(65531, 2);
			const storage = packet(large);
			const later = packet(
				Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.alloc(100)])
			);
			const reading = peer.readEncryptedMessage();
			// A valid init and most of peer_storage arrive together. The next host
			// event arrives synchronously before the init await can install a listener.
			inner.emit(
				'data',
				B.from(Buffer.concat([init, storage.subarray(0, -33)]))
			);
			inner.emit('data', B.from(storage.subarray(-33)));
			await reading;
			peer.state = 'ready';
			peer.setupMessageLoop();
			await Promise.resolve();
			inner.emit('data', B.from(later));
			assert.deepEqual(errors, []);
			assert.deepEqual(messages, [
				[7, 65533],
				[65535, 100]
			]);
		} finally {
			socket.destroy();
			release();
		}
	}
});
