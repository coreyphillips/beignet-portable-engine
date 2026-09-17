const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const compiled = buildSync({
	entryPoints: [path.join(__dirname, '../portable/globals.ts')],
	bundle: true,
	platform: 'browser',
	format: 'cjs',
	write: false
}).outputFiles[0].text;

test('Hermes-style typed-array subarrays retain Buffer readers and zero-copy semantics', () => {
	const context = vm.createContext({ setTimeout, clearTimeout, queueMicrotask });
	vm.runInContext(`
		// Model Hermes returning a plain typed-array view, regardless of Buffer's
		// prototype/species. Keep this change within this isolated JS realm.
		const originalSubarray = Uint8Array.prototype.subarray;
		Uint8Array.prototype.subarray = function(start, end) {
			const view = originalSubarray.call(this, start, end);
			Object.setPrototypeOf(view, Uint8Array.prototype);
			return view;
		};
		var module = { exports: {} };
		var exports = module.exports;
	`, context);
	vm.runInContext(compiled, context);
	const result = vm.runInContext(`(() => {
		const Buffer = module.exports.Buffer;
		const original = Buffer.from([0, 16, 0x12, 0x34, 0xab, 0xcd]);
		const payload = original.subarray(2);
		const nested = payload.subarray(-2);
		const read = payload.readUInt16BE(0);
		nested.writeUInt16BE(0x4567, 0);
		return {
			buffer: Buffer.isBuffer(payload) && Buffer.isBuffer(nested),
			read,
			shared: payload.buffer === original.buffer && nested.buffer === original.buffer,
			mutated: original.toString('hex'),
			empty: Buffer.isBuffer(payload.subarray(20)) && payload.subarray(20).length === 0
		};
	})()`, context);
	assert.equal(result.buffer, true);
	assert.equal(result.read, 0x1234);
	assert.equal(result.shared, true);
	assert.equal(result.mutated, '001012344567');
	assert.equal(result.empty, true);
});

test('base64url encodes and decodes exactly as Node does, so the direct-funding envelope mints', () => {
	const context = vm.createContext({ setTimeout, clearTimeout, queueMicrotask });
	vm.runInContext('var module = { exports: {} }; var exports = module.exports;', context);
	vm.runInContext(compiled, context);
	const Portable = vm.runInContext('module.exports.Buffer', context);
	// Bytes chosen so the base64 alphabet needs both url-unsafe characters
	// and padding: 0xfb 0xff -> "+/8=" in base64, "-_8" in base64url.
	const samples = [
		Buffer.from([0xfb, 0xff]),
		Buffer.from([0xfb, 0xff, 0xbf]),
		Buffer.from([0xfb, 0xff, 0xbf, 0x00, 0x7e]),
		Buffer.alloc(0)
	];
	for (const sample of samples) {
		const expected = sample.toString('base64url');
		const portable = Portable.from(sample);
		assert.equal(portable.toString('base64url'), expected);
		assert.equal(Buffer.from(Portable.from(expected, 'base64url')).toString('hex'), sample.toString('hex'));
		assert.equal(Portable.byteLength(expected, 'base64url'), Buffer.byteLength(expected, 'base64url'));
		const written = Portable.alloc(sample.length);
		assert.equal(written.write(expected, 'base64url'), sample.length);
		assert.equal(Buffer.from(written).toString('hex'), sample.toString('hex'));
	}
	assert.equal(Portable.isEncoding('base64url'), true);
	assert.equal(Portable.isEncoding('BASE64URL'), true);
	// The plain spellings are untouched.
	assert.equal(Portable.from('+/8=', 'base64').toString('hex'), 'fbff');
	assert.equal(Portable.from([0xfb, 0xff]).toString('base64'), '+/8=');
	assert.equal(Portable.from('hi').toString(), 'hi');
});
