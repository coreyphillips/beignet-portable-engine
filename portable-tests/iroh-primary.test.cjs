const test = require('node:test');
const assert = require('node:assert/strict');
const {
	parsePrimaryUri,
	parsePrimaryFallback
} = require('../portable/primary-uri.cjs');
const rules = require('../portable/lfbw.cjs');
const key = '02' + 'a'.repeat(64);
const uri = `${key}@iroh:${'b'.repeat(
	64
)}?relay=https%3A%2F%2Frelay.example%2F`;
const onion = `${key}@${'a'.repeat(56)}.onion:9735`;
test('an Iroh primary retains its endpoint, relay and optional same-key Tor fallback', () => {
	const parsed = parsePrimaryUri(uri);
	assert.equal(parsed.transport.endpointId, 'b'.repeat(64));
	assert.equal(parsed.transport.relayUrl, 'https://relay.example/');
	assert.equal(parsed.port, 0);
	assert.equal(
		parsePrimaryUri(`${key}@iroh:${'a'.repeat(52)}`).host,
		'0'.repeat(64)
	);
	assert.equal(parsePrimaryFallback(parsed, onion).port, 9735);
	const lf = rules.normalizeLfbw(
		{ enabled: true, primaryUri: uri, primaryFallbackUri: onion },
		{ available: true, network: 'regtest' }
	);
	assert.equal(lf.primaryFallbackUri, onion);
	assert.equal(
		rules.normalizeLfbw(
			{ enabled: true, primaryUri: uri, primaryFallbackUri: null },
			{ available: true, network: 'regtest', existing: lf }
		).primaryFallbackUri,
		undefined
	);
	assert.throws(() =>
		parsePrimaryFallback(parsed, onion.replace(key, '03' + 'c'.repeat(64)))
	);
	assert.throws(() => parsePrimaryFallback(parsed, `${key}@example.com:9735`));
	for (const bad of [
		`${key}@iroh:bad`,
		`${uri}&relay=https://other.example`,
		`${key}@iroh:${'a'.repeat(51)}b`,
		`${key}@iroh:${'b'.repeat(64)}?relay=file%3A%2F%2F%2Ftmp`
	])
		assert.throws(() => parsePrimaryUri(bad));
});
test('direct-funding descriptors never treat an Iroh endpoint as a TCP address', () => {
	const parsed = parsePrimaryUri(uri);
	const config = rules.directFundingConfig(
		{ mode: 'external', trusted: true },
		{ ...parsed, relayHost: parsed.host, relayPort: parsed.port }
	);
	assert.equal(config.lspHost, undefined);
	assert.equal(config.lspPort, undefined);
	assert.equal(config.lspPubkey, key);
});
test('the portable bundle exposes the stream adapter without loading a Node binding', () => {
	const bundle = require('../dist/portable.cjs');
	assert.equal(bundle.IROH_ALPN, 'beignet/bolt8/1');
	assert.equal(typeof bundle.IrohTransport, 'function');
	const fs = require('node:fs');
	const meta = JSON.parse(
		fs.readFileSync(require('node:path').join(__dirname, '../dist/meta.json'))
	);
	assert.ok(
		!Object.keys(meta.inputs).some(
			(p) => p.includes('@number0') || p.endsWith('transport/iroh-node.ts')
		)
	);
});
