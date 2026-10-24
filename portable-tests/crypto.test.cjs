const { test } = require('node:test');
const assert = require('node:assert/strict');
const node = require('node:crypto');
const portable = require('../dist/crypto-test.cjs');
for (const algorithm of ['aes-256-gcm', 'chacha20-poly1305'])
	test(`${algorithm} ciphertext and authentication match Node`, () => {
		const key = Buffer.alloc(32, 3),
			iv = Buffer.alloc(12, 7),
			aad = Buffer.from('Bolt8 header'),
			plain = Buffer.from('durable before wire');
		const encrypt = (impl) => {
			const c = impl.createCipheriv(algorithm, key, iv);
			c.setAAD(aad);
			return {
				body: Buffer.concat([c.update(plain), c.final()]),
				tag: c.getAuthTag()
			};
		};
		const actual = encrypt(portable),
			expected = encrypt(node);
		assert.deepEqual(Buffer.from(actual.body), expected.body);
		assert.deepEqual(Buffer.from(actual.tag), expected.tag);
		const dec = portable.createDecipheriv(algorithm, key, iv);
		dec.setAAD(aad);
		dec.setAuthTag(actual.tag);
		assert.deepEqual(
			Buffer.from(Buffer.concat([dec.update(actual.body), dec.final()])),
			plain
		);
		const tampered = Buffer.from(actual.tag);
		tampered[0] ^= 1;
		const bad = portable.createDecipheriv(algorithm, key, iv);
		bad.setAAD(aad);
		bad.setAuthTag(tampered);
		bad.update(actual.body);
		assert.throws(() => bad.final());
	});
test('ChaCha20 onion stream, HKDF, hash and HMAC match Node', () => {
	const key = Buffer.alloc(32, 4),
		iv = Buffer.alloc(16),
		plain = Buffer.alloc(1300);
	assert.deepEqual(
		Buffer.from(portable.createCipheriv('chacha20', key, iv).update(plain)),
		node.createCipheriv('chacha20', key, iv).update(plain)
	);
	// Node finishes a stream cipher with an empty final(), which the engine's
	// crypto provider calls after update() (Beignet 0.32.0, #1803).
	const stream = portable.createCipheriv('chacha20', key, iv);
	const finished = Buffer.concat([stream.update(plain), stream.final()]);
	const reference = node.createCipheriv('chacha20', key, iv);
	assert.deepEqual(
		finished,
		Buffer.concat([reference.update(plain), reference.final()])
	);
	assert.throws(() => stream.final(), /already finalized/);
	assert.throws(() => stream.update(plain), /already finalized/);
	for (const name of ['sha256', 'sha512', 'ripemd160'])
		assert.equal(
			portable.createHash(name).update('beignet').digest('hex'),
			node.createHash(name).update('beignet').digest('hex')
		);
	assert.deepEqual(
		Buffer.from(portable.hkdfSync('sha256', key, plain, 'storage', 32)),
		Buffer.from(node.hkdfSync('sha256', key, plain, 'storage', 32))
	);
	assert.equal(
		portable.createHmac('sha256', key).update(plain).digest('hex'),
		node.createHmac('sha256', key).update(plain).digest('hex')
	);
});

// Beignet 0.32.0 (#1803) takes the Lightning layer's crypto from a provider
// that checks each primitive against a known-answer vector before its first
// use, and refuses a primitive that fails for the life of the process. Its
// default wraps 'crypto', which the bundle maps to portable/crypto.ts, so
// every vector has to pass here or onions, transport and storage keys fail.
test('the engine crypto provider passes its self-test on the portable crypto', async () => {
	const path = require('node:path');
	const { build } = require('esbuild');
	const root = path.join(__dirname, '..');
	const result = await build({
		stdin: {
			resolveDir: root,
			contents: "export * from './src/lightning/crypto/provider';"
		},
		bundle: true, platform: 'browser', format: 'cjs', target: 'es2020',
		write: false, alias: { crypto: path.join(root, 'portable/crypto.ts') },
		inject: [path.join(root, 'portable/globals.ts')]
	});
	const mod = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(
		mod, mod.exports, require
	);
	const engine = mod.exports;
	// The bundle's Buffer is the polyfill, so compare bytes as Node Buffers.
	const bytes = (value) => Buffer.from(value);
	const key = Buffer.alloc(32, 4),
		nonce = Buffer.alloc(12, 1),
		aad = Buffer.from('aad'),
		data = Buffer.alloc(1300, 9);
	const stream = node.createCipheriv(
		'chacha20', key, Buffer.concat([Buffer.alloc(4), nonce])
	);
	assert.deepEqual(bytes(engine.chacha20(key, nonce, data)), stream.update(data));
	assert.deepEqual(
		bytes(engine.sha256(data)),
		node.createHash('sha256').update(data).digest()
	);
	assert.deepEqual(
		bytes(engine.hmacSha256(key, data)),
		node.createHmac('sha256', key).update(data).digest()
	);
	assert.deepEqual(
		bytes(engine.hkdfSha256(key, Buffer.alloc(0), aad, 32)),
		Buffer.from(node.hkdfSync('sha256', key, Buffer.alloc(0), aad, 32))
	);
	const gcm = engine.aes256GcmEncrypt(key, nonce, data, aad);
	assert.deepEqual(bytes(engine.aes256GcmDecrypt(key, nonce, gcm, aad)), data);
	const poly = engine.chacha20Poly1305Encrypt(key, nonce, data, aad);
	assert.deepEqual(
		bytes(engine.chacha20Poly1305Decrypt(key, nonce, poly, aad)),
		data
	);
	assert.equal(engine.randomBytes(32).length, 32);
});
