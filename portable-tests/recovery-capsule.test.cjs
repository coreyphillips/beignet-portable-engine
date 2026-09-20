const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');

// Exercise the actual capsule protocol using the same browser adapters as the
// shipped engine. All keys, channels, files and balances here are synthetic.
const root = path.join(__dirname, '..');
const aliases = {
	crypto: 'crypto', fs: 'fs', net: 'net', tls: 'tls', dns: 'unsupported',
	http: 'unsupported', https: 'unsupported', os: 'unsupported', zlib: 'zlib',
	'better-sqlite3': 'sqlite'
};
for (const name in aliases) aliases[name] = path.join(root, 'portable', aliases[name] + '.ts');
aliases.path = require.resolve('path-browserify');
aliases.stream = require.resolve('stream-browserify');
const compiled = build({
	stdin: { resolveDir: root, contents: `
		export { Buffer } from 'buffer';
		export { configure, release } from './portable/state';
		export { renameSync } from './portable/fs';
		export { createSqlJsDatabaseFactory } from './portable/sqljs';
		export { SqliteStorage } from './src/lightning/storage/sqlite-storage';
		export { RecoveryJournal, deriveRecoveryMasterKey } from './src/lightning/recovery/journal';
		export { RecoveryManager } from './src/lightning/recovery/recovery-manager';
		export { RecoveryCriticality } from './src/lightning/recovery/types';
		export { deriveRecoveryRoot } from './src/lightning/recovery/guardian-wire';
		export { composeRecoveryCapsule, restoreBestRecoveryCapsule, decodeRecoveryCapsuleBlob } from './src/lightning/recovery/capsule';
		export { encodeScb } from './src/lightning/backup/scb';
		export { getPublicKey } from './src/lightning/crypto/ecdh';
		export { createOpenerState } from './src/lightning/channel/channel-state';
		export { DEFAULT_CHANNEL_CONFIG, ChannelState } from './src/lightning/channel/types';
		export { Channel } from './src/lightning/channel/channel';
	` },
	bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', write: false,
	alias: aliases, inject: [path.join(root, 'portable/globals.ts')],
	external: ['sql.js'], define: { 'process.env.NODE_ENV': '"production"' }
}).then(result => {
	const mod = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require);
	return mod.exports;
});

test('encrypted native capsule restores through portable SQL.js and keeps channel recency holds after durable reopen', async () => {
	const api = await compiled;
	const files = new Map();
	const volume = {
		read: key => files.get(key) ?? null,
		write: (key, bytes) => files.set(key, new Uint8Array(bytes)),
		remove: key => files.delete(key),
		rename: (from, to) => { assert.ok(files.has(from)); files.set(to, files.get(from)); files.delete(from); },
		list: () => [...files.keys()]
	};
	const databaseFactory = await api.createSqlJsDatabaseFactory({ load: volume.read, save: volume.write });
	api.configure({ volume, databaseFactory, socketFactory: () => { throw Error('network forbidden in fixture'); } });
	const opened = new Set();
	const open = file => {
		const storage = new api.SqliteStorage(file);
		storage.open(); opened.add(storage); return storage;
	};
	const close = storage => { storage.close(); opened.delete(storage); };
	try {
		const B = api.Buffer;
		const secret = B.alloc(32, 7);
		const source = open('/fixture/source.db');
		const journal = new api.RecoveryJournal(source, api.deriveRecoveryMasterKey(secret),
			api.getPublicKey(secret), api.deriveRecoveryRoot(secret).recoveryId);
		const manager = new api.RecoveryManager(source, { journal });
		const point = api.getPublicKey(B.alloc(32, 41));
		const state = api.createOpenerState({
			temporaryChannelId: B.alloc(32, 42), fundingSatoshis: 500000n, pushMsat: 0n,
			localConfig: { ...api.DEFAULT_CHANNEL_CONFIG },
			localBasepoints: {
				fundingPubkey: point, revocationBasepoint: point, paymentBasepoint: point,
				delayedPaymentBasepoint: point, htlcBasepoint: point, firstPerCommitmentPoint: point
			},
			localPerCommitmentSeed: B.alloc(32, 43)
		});
		const channelId = 'ab'.repeat(32);
		state.channelId = B.from(channelId, 'hex');
		state.state = api.ChannelState.NORMAL;
		assert.equal(manager.commit({
			criticality: api.RecoveryCriticality.SafetyCritical,
			mutations: [{ type: 'channel_state', channelId, state, peerPubkey: point.toString('hex') }],
			outboundMessages: []
		}).committed, true);
		const encryptedScb = api.encodeScb({ version: 1, network: 'regtest', createdAt: 1700000000000, channels: [] }, secret);
		const { blob, inline } = api.composeRecoveryCapsule({ storage: source, encryptedScb, nodeSecret: secret });
		assert.equal(inline, true);
		assert.equal(api.decodeRecoveryCapsuleBlob(blob, B.alloc(32, 8)), null);
		const tampered = B.from(blob); tampered[tampered.length - 1] ^= 1;
		assert.equal(api.decodeRecoveryCapsuleBlob(tampered, secret), null);
		const target = open('/fixture/restoring.db');
		assert.equal(target.loadAllChannels().length, 0);
		const result = api.restoreBestRecoveryCapsule([tampered, blob], target, secret, {
			scratchStorage: () => open(':memory:')
		});
		assert.equal(result.tier, 2);
		const restored = target.loadAllChannels();
		assert.equal(restored.length, 1);
		assert.equal(restored[0].channelId, channelId);
		assert.equal(restored[0].state.fundingSatoshis, state.fundingSatoshis);
		assert.equal(restored[0].state.localBalanceMsat, state.localBalanceMsat);
		assert.equal(restored[0].state.restoreRecencyUnproven, true);
		assert.notEqual(source.loadAllChannels()[0].state.restoreRecencyUnproven, true);
		assert.equal(files.has(':memory:'), false);
		assert.throws(() => api.restoreBestRecoveryCapsule([blob], target, secret, {
			scratchStorage: () => open(':memory:')
		}), /empty|populated|dirty/i);
		close(target);
		api.renameSync('/fixture/restoring.db', '/fixture/restored.db');
		const reopened = open('/fixture/restored.db');
		const durable = reopened.loadAllChannels()[0].state;
		assert.equal(durable.restoreRecencyUnproven, true);
		assert.equal(durable.channelId.toString('hex'), channelId);
		assert.equal(new api.Channel(durable).acceptsNewHtlcs(true, true), false);
	} finally {
		for (const storage of opened) storage.close();
		api.release();
	}
});
