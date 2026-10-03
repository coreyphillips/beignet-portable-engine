const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const { directFundingConfig } = require('../portable/lfbw.cjs');

// Compile the actual engine API and policy persistence methods. The native
// database constructor stays external because this test supplies a small store.
const source = buildSync({
	stdin: {
		contents: `export { BeignetNode } from './src/cli/beignet-node'; export { LightningNode } from './src/lightning/node/lightning-node';`,
		resolveDir: require('node:path').join(__dirname, '..'),
		loader: 'ts'
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	packages: 'external',
	write: false
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', source)(mod, mod.exports, (name) =>
	name === 'better-sqlite3' ? class UnusedDatabase {} : require(name)
);
const { BeignetNode, LightningNode } = mod.exports;

function fixture(rows) {
	const node = Object.create(LightningNode.prototype);
	node.directFunding = { policy: {}, receiver: { setConfig() {} } };
	node.storage = {
		saveWalletData: (key, value) => rows.set(key, value),
		loadWalletData: (key) => rows.get(key) ?? null
	};
	const api = Object.create(BeignetNode.prototype);
	api.node = node;
	return { node, api };
}
test('switching to Iroh-only and clearing fallback removes the stored address across restart', () => {
	const rows = new Map();
	let { node, api } = fixture(rows);
	const oldKey = '02' + 'a'.repeat(64),
		nextKey = '03' + 'b'.repeat(64);
	api.configureDirectFunding({
		lspPubkey: oldKey,
		lspHost: 'old.onion',
		lspPort: 9735,
		minAmountSat: 12000
	});
	const next = directFundingConfig(
		{ mode: 'external', trusted: true },
		{ pubkey: nextKey, relayPort: 0 }
	);
	api.configureDirectFunding(next);
	assert.equal(api.getDirectFundingConfig().lspHost, null);
	assert.equal(api.getDirectFundingConfig().lspPort, null);
	assert.equal(api.getDirectFundingConfig().lspPubkey, nextKey);
	assert.equal(api.getDirectFundingConfig().minAmountSat, 12000);
	({ node, api } = fixture(rows));
	node.restoreDirectFundingPolicy();
	assert.equal(api.getDirectFundingConfig().lspHost, null);
	assert.equal(api.getDirectFundingConfig().lspPort, null);
	api.configureDirectFunding({ lspHost: 'fallback.onion', lspPort: 9101 });
	api.configureDirectFunding(next);
	({ node, api } = fixture(rows));
	node.restoreDirectFundingPolicy();
	assert.equal(api.getDirectFundingConfig().lspHost, null);
	assert.equal(api.getDirectFundingConfig().lspPort, null);
});
