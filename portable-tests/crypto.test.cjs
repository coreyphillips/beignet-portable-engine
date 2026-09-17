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
