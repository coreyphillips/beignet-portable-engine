const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const output = buildSync({
	entryPoints: [path.join(__dirname, '../portable/rgs-https.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false
}).outputFiles[0].text;
const shim = { exports: {} };
new Function('module', 'exports', 'require', output)(shim, shim.exports, require);
const https = shim.exports;

// The same calls upstream's fetchRapidGossipSnapshot makes on Node's https.
function download(url, timeoutMs = 60000) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`Rapid gossip sync request failed: HTTP ${res.statusCode}`));
				return;
			}
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error('Rapid gossip sync request timed out'));
		});
	});
}
function withFetch(fake, run) {
	const original = globalThis.fetch;
	globalThis.fetch = fake;
	return run().finally(() => {
		globalThis.fetch = original;
	});
}

test('the snapshot body arrives whole, as a Buffer', () =>
	withFetch(
		async (url) => {
			assert.equal(url, 'https://rapidsync.lightningdevkit.org/snapshot/0');
			return new Response(new Uint8Array([76, 68, 75, 1, 2, 3]), { status: 200 });
		},
		async () => {
			const body = await download('https://rapidsync.lightningdevkit.org/snapshot/0');
			assert.ok(Buffer.isBuffer(body));
			assert.deepEqual([...body], [76, 68, 75, 1, 2, 3]);
		}
	));

test('a non-200 answer and a network failure both reject', async () => {
	await withFetch(
		async () => new Response('gone', { status: 404 }),
		() => assert.rejects(download('https://x/snapshot/0'), /HTTP 404/)
	);
	await withFetch(
		async () => {
			throw new TypeError('Network request failed');
		},
		() => assert.rejects(download('https://x/snapshot/0'), /Network request failed/)
	);
});

test('the timeout aborts the fetch and rejects once', () =>
	withFetch(
		(_url, { signal }) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')));
			}),
		// The aborted fetch rejects too; the request has settled by then and
		// stays quiet, so the caller sees the timeout and nothing after it.
		() => assert.rejects(download('https://x/snapshot/0', 20), /timed out/)
	));

test('only the snapshot download gets fetch; every other https import still fails', () => {
	const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '../dist/meta.json'), 'utf8'));
	const users = {};
	for (const [file, input] of Object.entries(meta.inputs))
		for (const imported of input.imports || [])
			if (/portable\/(rgs-https|unsupported)\.ts$/.test(imported.path))
				(users[imported.path] ||= new Set()).add(file);
	assert.deepEqual([...(users['portable/rgs-https.ts'] || [])], ['src/lightning/gossip/rapid-sync.ts']);
	assert.ok(users['portable/unsupported.ts'].has('src/lightning/recovery/guardian-client.ts'));
	assert.throws(() => https.request('https://x'), /unavailable in an embedded wallet/);
});
