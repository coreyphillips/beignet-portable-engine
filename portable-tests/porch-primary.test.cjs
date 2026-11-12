const test = require('node:test');
const assert = require('node:assert/strict');
const {
	parsePrimaryUri,
	parsePrimaryFallback
} = require('../portable/primary-uri.cjs');
const rules = require('../portable/lfbw.cjs');
const {
	anyIroh,
	anyPorch,
	engineToEntry,
	entryToEngine
} = require('../portable/primaries-record.cjs');

const key = '02' + 'a'.repeat(64);
const route = 'k3vq' + 'a'.repeat(28);
const url = `wss://relay.example/v1/p/${route}`;
const link = `${key}@${url}`;

test("a Porch link parses to the relay's WebSocket URL, with the route kept and no TCP address", () => {
	assert.deepEqual(parsePrimaryUri(` ${link} `), {
		pubkey: key,
		host: 'relay.example',
		port: 0,
		transport: { type: 'ws', url },
		uri: link
	});
});

test('a Porch link has one written form: lower case scheme, host and key, and no default port', () => {
	assert.equal(
		parsePrimaryUri(`${key.toUpperCase()}@WSS://Relay.Example:443/v1/p/${route}`).uri,
		link
	);
	assert.equal(
		parsePrimaryUri(`${key}@wss://relay.example:8443/v1/p/${route}`).uri,
		`${key}@wss://relay.example:8443/v1/p/${route}`
	);
	assert.equal(
		parsePrimaryUri(`${key}@ws://127.0.0.1:80/v1/p/${route}`).uri,
		`${key}@ws://127.0.0.1/v1/p/${route}`
	);
	assert.equal(
		parsePrimaryUri(`${key}@wss://[2001:db8::1]:2114/v1/p/${route}`).host,
		'2001:db8::1'
	);
});

test('a relay is reached without TLS only on this device or its own network', () => {
	for (const host of [
		'127.0.0.1:2114',
		'localhost:2114',
		'[::1]:2114',
		'10.0.2.2:2114',
		'192.168.1.20:2114',
		'172.16.0.5:2114',
		'172.31.255.1:2114'
	])
		assert.equal(
			parsePrimaryUri(`${key}@ws://${host}/v1/p/${route}`).uri,
			`${key}@ws://${host}/v1/p/${route}`
		);
	for (const host of [
		'relay.example',
		'relay.example:2114',
		'8.8.8.8:2114',
		'172.32.0.1:2114',
		'172.15.0.1:2114',
		'192.169.1.1:2114',
		'11.0.0.1',
		'127.0.0.256',
		'10.example.com'
	])
		assert.throws(
			() => parsePrimaryUri(`${key}@ws://${host}/v1/p/${route}`),
			/must use wss:\/\//,
			host
		);
});

test('any other WebSocket address is refused, as is an onion relay', () => {
	for (const address of [
		'wss://relay.example',
		'wss://relay.example/',
		'wss://relay.example/v1/p/',
		`wss://relay.example/v1/p/${route.slice(1)}`,
		`wss://relay.example/v1/p/${route}a`,
		`wss://relay.example/v1/p/${route.toUpperCase()}`,
		`wss://relay.example/v1/p/${route.replace('k', '1')}`,
		`wss://relay.example/v1/p/${route}/`,
		`wss://relay.example/v1/p/${route}?token=1`,
		`wss://relay.example/v1/p/${route}#x`,
		`wss://relay.example/v2/p/${route}`,
		`wss://relay.example/v1/h/${route}`,
		`wss://user:pass@relay.example/v1/p/${route}`,
		`wss://relay.example:0/v1/p/${route}`,
		`wss://relay.example:65536/v1/p/${route}`,
		`wss://relay.example:/v1/p/${route}`,
		`wss:///v1/p/${route}`,
		`wss://relay example/v1/p/${route}`,
		`https://relay.example/v1/p/${route}`,
		'ws://relay.example:1'
	])
		assert.throws(() => parsePrimaryUri(`${key}@${address}`), Error, address);
	for (const scheme of ['ws', 'wss'])
		assert.throws(
			() =>
				parsePrimaryUri(
					`${key}@${scheme}://${'a'.repeat(56)}.onion/v1/p/${route}`
				),
			/onion relay/
		);
});

test('a Porch primary takes no onion fallback', () => {
	const primary = parsePrimaryUri(link);
	const onion = `${key}@${'a'.repeat(56)}.onion:9735`;
	assert.throws(() => parsePrimaryFallback(primary, onion));
	assert.equal(parsePrimaryFallback(primary, ''), undefined);
	const lf = rules.normalizeLfbw(
		{ enabled: true, primaryUri: link },
		{ available: true, network: 'regtest' }
	);
	assert.equal(lf.primaryUri, link);
	assert.equal(lf.primaryPubkey, key);
	assert.deepEqual(
		lf.primaries.map((e) => e.uri),
		[link]
	);
	assert.throws(
		() =>
			rules.normalizeLfbw(
				{ enabled: true, primaryUri: link, primaryFallbackUri: onion },
				{ available: true, network: 'regtest' }
			),
		(error) => error.code === 'BAD_LFBW_PEER'
	);
});

test("direct-funding descriptors never treat a Porch relay as the node's TCP address", () => {
	for (const address of [url, `wss://relay.example:8443/v1/p/${route}`]) {
		const parsed = parsePrimaryUri(`${key}@${address}`);
		const config = rules.directFundingConfig(
			{ mode: 'external', trusted: true },
			{ ...parsed, relayHost: parsed.host, relayPort: parsed.port }
		);
		assert.equal(config.lspHost, null);
		assert.equal(config.lspPort, null);
		assert.equal(config.lspPubkey, key);
	}
});

test("a Porch entry goes to the engine as its URI and comes back from the engine's row as a usable primary", () => {
	assert.deepEqual(entryToEngine({ uri: link }), { pubkey: key, uri: link });
	assert.deepEqual(entryToEngine({ uri: link }, 2), {
		pubkey: key,
		uri: link,
		rank: 2
	});
	const fresh = engineToEntry(
		{ pubkey: key, host: null, port: null, uri: link },
		undefined
	);
	assert.deepEqual(fresh, {
		pubkey: key,
		uri: link,
		fallbackUri: undefined,
		trusted: true,
		initialChannelOpened: false,
		setup: 'pending',
		setupError: null,
		setupAt: null
	});
	// The engine keeps the URI as it was written. The record keeps one form.
	const written = `${key}@WSS://Relay.Example:443/v1/p/${route}`;
	const prior = { ...fresh, setup: 'ready', setupAt: 9, trusted: false };
	assert.deepEqual(
		engineToEntry({ pubkey: key, host: null, port: null, uri: written }, prior),
		prior
	);
	assert.equal(anyPorch([{ uri: `${key}@a.example:9735` }, { uri: link }]), true);
	assert.equal(anyPorch([{ uri: `${key}@a.example:9735` }, { uri: 'garbage' }]), false);
	assert.equal(anyPorch([{ uri: `${key}@iroh:${'b'.repeat(64)}` }]), false);
	assert.equal(anyIroh([{ uri: link }]), false);
	assert.equal(anyPorch(undefined), false);
});
