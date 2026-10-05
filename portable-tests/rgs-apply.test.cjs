const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');

// The bundle exports no gossip internals, so the importer is compiled here
// with the bundle's own settings: browser platform, the portable aliases and
// portable/globals.ts injected, whose setImmediate is a setTimeout of 0. It
// runs with a setTimeout that records its calls and a realm setImmediate that
// must never be reached.
const root = path.join(__dirname, '..');
const aliases = {
	crypto: 'crypto', fs: 'fs', net: 'net', tls: 'tls', dns: 'unsupported',
	http: 'unsupported', https: 'rgs-https', os: 'unsupported', zlib: 'zlib',
	'better-sqlite3': 'sqlite'
};
for (const name in aliases) aliases[name] = path.join(root, 'portable', aliases[name] + '.ts');
aliases.path = require.resolve('path-browserify');
aliases.stream = require.resolve('stream-browserify');
const compiled = buildSync({
	stdin: {
		resolveDir: root,
		contents: `
		export { applyRapidGossipSnapshot, applyRapidGossipSnapshotAsync, RapidGossipCancelledError } from './src/lightning/gossip/rapid-sync';
		export { NetworkGraph } from './src/lightning/gossip/network-graph';
		export { BITCOIN_CHAIN_HASH } from './src/lightning/channel/types';
		export { Buffer } from 'buffer';`
	},
	bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', write: false,
	alias: aliases, inject: [path.join(root, 'portable/globals.ts')],
	define: { 'process.env.NODE_ENV': '"production"' }
}).outputFiles[0].text;
const timeouts = [];
let realmImmediates = 0;
const recordedSetTimeout = (fn, delay, ...args) => {
	timeouts.push(delay);
	return setTimeout(fn, delay, ...args);
};
const realmSetImmediate = (fn, ...args) => {
	realmImmediates++;
	return setImmediate(fn, ...args);
};
const mod = { exports: {} };
new Function('module', 'exports', 'require', 'setTimeout', 'setImmediate', compiled)(
	mod, mod.exports, require, recordedSetTimeout, realmSetImmediate
);
const api = mod.exports;

const bigSize = (value) => {
	if (value < 0xfdn) return Buffer.from([Number(value)]);
	const width = value < 0x10000n ? 2 : value < 0x100000000n ? 4 : 8;
	const out = Buffer.alloc(1 + width);
	out[0] = { 2: 0xfd, 4: 0xfe, 8: 0xff }[width];
	if (width === 8) out.writeBigUInt64BE(value, 1);
	else out.writeUIntBE(Number(value), 1, width);
	return out;
};
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };

// A small RGS v1 snapshot: 8 nodes, 120 channels, both directions updated,
// direction 1 with its own CLTV delta and base fee.
const CHANNELS = 120;
function snapshot() {
	const parts = [Buffer.from('LDK'), Buffer.from([1]), Buffer.from(api.BITCOIN_CHAIN_HASH)];
	parts.push(u32(Math.floor(Date.now() / 1000) - 3600), u32(8));
	for (let i = 0; i < 8; i++) parts.push(Buffer.concat([Buffer.from([2]), Buffer.alloc(32, i + 1)]));
	const scids = [];
	parts.push(u32(CHANNELS));
	let previous = 0n;
	for (let i = 0; i < CHANNELS; i++) {
		const scid = (BigInt(800000 + i) << 40n) | (BigInt(i % 7) << 16n) | BigInt(i % 2);
		const n1 = i % 8;
		const n2 = (n1 + 1 + (i % 7)) % 8;
		parts.push(u16(0), bigSize(scid - previous), bigSize(BigInt(n1)), bigSize(BigInt(n2)));
		scids.push(scid);
		previous = scid;
	}
	parts.push(u32(2 * CHANNELS), u16(144), u64(1000n), u32(1000), u32(100), u64(990000000n));
	previous = 0n;
	scids.forEach((scid, i) => {
		parts.push(bigSize(scid - previous), Buffer.from([0x00]));
		parts.push(bigSize(0n), Buffer.from([0x01 | 0x40 | 0x10]), u16(40 + i), u32(2000 + i));
		previous = scid;
	});
	return api.Buffer.from(Buffer.concat(parts));
}
const policies = (graph) =>
	graph.getAllChannels().map((c) => [
		c.shortChannelId.toString('hex'), c.nodeId1.toString('hex'), c.nodeId2.toString('hex'),
		...[c.update1, c.update2].map((u) => u && [u.channelFlags, u.cltvExpiryDelta, u.feeBaseMsat,
			u.feeProportionalMillionths, String(u.htlcMinimumMsat), String(u.htlcMaximumMsat)].join('/'))
	].join(' ')).sort();

test('the snapshot import yields through setTimeout(0) and leaves the synchronous graph', async () => {
	const data = snapshot();
	const once = new api.NetworkGraph();
	const expected = api.applyRapidGossipSnapshot(once, data);
	assert.equal(expected.channelsAdded, CHANNELS);
	assert.equal(expected.updatesApplied, 2 * CHANNELS);
	assert.equal(expected.nodeCount, 8);

	const sliced = new api.NetworkGraph();
	const order = [];
	setTimeout(() => order.push('timer'), 0);
	timeouts.length = 0;
	realmImmediates = 0;
	const result = await api.applyRapidGossipSnapshotAsync(sliced, data, {
		sliceMs: 0,
		onSlice: () => order.push('slice')
	});
	const slices = order.filter((entry) => entry === 'slice').length;
	assert.ok(slices > 1, `${slices} slices`);
	// One macrotask between consecutive slices, each a setTimeout of 0, and
	// a timer that was already due ran between two of them.
	assert.deepEqual(timeouts, Array(slices - 1).fill(0));
	assert.equal(realmImmediates, 0);
	assert.ok(order.indexOf('timer') > 0 && order.indexOf('timer') < order.length - 1, order.join());

	assert.deepEqual(result, expected);
	assert.equal(sliced.getChannelCount(), once.getChannelCount());
	assert.equal(sliced.getNodeCount(), once.getNodeCount());
	assert.equal(once.getChannelCount(), CHANNELS);
	assert.equal(once.getNodeCount(), 8);
	assert.deepEqual(policies(sliced), policies(once));
});

test('a cancelled import stops at its next yield and keeps what it applied', async () => {
	const graph = new api.NetworkGraph();
	let slices = 0;
	await assert.rejects(
		api.applyRapidGossipSnapshotAsync(graph, snapshot(), {
			sliceMs: 0,
			onSlice: () => slices++,
			cancelled: () => slices >= 2
		}),
		(error) => error instanceof api.RapidGossipCancelledError
	);
	assert.equal(slices, 2);
	assert.ok(graph.getChannelCount() > 0 && graph.getChannelCount() < CHANNELS);
});

test('the shipped bundle builds the importer with the injected portable globals', () => {
	const meta = JSON.parse(fs.readFileSync(path.join(root, 'dist/meta.json'), 'utf8'));
	const imports = meta.inputs['src/lightning/gossip/rapid-sync.ts'].imports.map((i) => i.path);
	assert.ok(imports.some((p) => p.endsWith('portable/globals.ts')), imports.join());
	assert.ok(imports.includes('portable/rgs-https.ts'));
});
