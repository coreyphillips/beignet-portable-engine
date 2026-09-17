const { test } = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const vm = require('node:vm');
const compiled = esbuild.buildSync({
	entryPoints: ['src/lightning/storage/reconstructable-batch.ts'],
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'node'
}).outputFiles[0].text;
const moduleObject = { exports: {} };
vm.runInNewContext(compiled, {
	exports: moduleObject.exports,
	module: moduleObject,
	setTimeout,
	clearTimeout
});
const { ReconstructableBatch } = moduleObject.exports;
test('500 reconstructable gossip writes share one durable transaction; last update wins', () => {
	let commits = 0;
	const rows = new Map();
	const batch = new ReconstructableBatch(
		(fn) => {
			fn();
			commits++;
		},
		(e) => {
			throw e;
		}
	);
	for (let i = 0; i < 499; i++)
		batch.enqueue('node:' + i, () => rows.set(i, 'old'));
	batch.enqueue('node:0', () => rows.set(0, 'new'));
	assert.equal(commits, 0);
	batch.enqueue('node:499', () => rows.set(499, 'old'));
	assert.equal(commits, 1);
	assert.equal(rows.size, 500);
	assert.equal(rows.get(0), 'new');
	batch.flush();
	assert.equal(commits, 1);
});
test('failed gossip flush retains pending cache for explicit retry and never swallows barrier failure', () => {
	let fail = true,
		applied = 0;
	const batch = new ReconstructableBatch(
		(fn) => {
			if (fail) throw Error('disk full');
			fn();
		},
		() => {}
	);
	batch.enqueue('gossip', () => applied++);
	assert.throws(() => batch.flush(), /disk full/);
	assert.equal(applied, 0);
	fail = false;
	batch.flush();
	assert.equal(applied, 1);
});
