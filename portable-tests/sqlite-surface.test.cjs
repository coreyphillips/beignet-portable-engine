const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');

// Beignet 0.31.0 storage reads two more parts of better-sqlite3: a statement's
// pluck() (listInvoices finds paid invoices by their plaintext columns,
// upstream #1765) and the database's inTransaction (a channel loaded or
// committed inside a transaction that may still roll back must not have its
// revoked HTLC snapshots marked saved, upstream #1771). The SQL.js adapter
// has both, and portable/sqlite.ts supplies them to a client adapter written
// for an older engine, such as a phone's native driver.
const root = path.join(__dirname, '..');
const aliases = {
	crypto: 'crypto', fs: 'fs', net: 'net', tls: 'tls', dns: 'unsupported',
	http: 'unsupported', https: 'unsupported', os: 'unsupported', zlib: 'zlib',
	'better-sqlite3': 'better-sqlite3'
};
for (const name in aliases) aliases[name] = path.join(root, 'portable', aliases[name] + '.ts');
aliases.path = require.resolve('path-browserify');
aliases.stream = require.resolve('stream-browserify');
const compiled = build({
	stdin: { resolveDir: root, contents: `
		export { Buffer } from 'buffer';
		export { configure, release } from './portable/state';
		export { createSqlJsDatabaseFactory } from './portable/sqljs';
		export { SqliteStorage } from './src/lightning/storage/sqlite-storage';
		export { PaymentStatus, PaymentDirection } from './src/lightning/node/types';
		export { createOpenerState } from './src/lightning/channel/channel-state';
		export { DEFAULT_CHANNEL_CONFIG, HtlcDirection } from './src/lightning/channel/types';
		export { recordRevokedHtlcSnapshot } from './src/lightning/channel/htlc-snapshots';
	` },
	bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', write: false,
	alias: aliases, inject: [path.join(root, 'portable/globals.ts')],
	external: ['sql.js'], define: { 'process.env.NODE_ENV': '"production"' }
}).then(result => {
	const mod = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require);
	return mod.exports;
});

// The surface an adapter written for Beignet 0.30 offers: no pluck(), no
// inTransaction. Built on the SQL.js adapter, with everything else passed on.
function olderAdapter(db) {
	return {
		portableGossipBatch: true,
		prepare(sql) {
			const statement = db.prepare(sql);
			return {
				run: (...args) => statement.run(...args),
				get: (...args) => statement.get(...args),
				all: (...args) => statement.all(...args),
				iterate: (...args) => statement.iterate(...args)
			};
		},
		exec(sql) { db.exec(sql); return this; },
		pragma: sql => db.pragma(sql),
		transaction: fn => db.transaction(fn),
		close: () => db.close()
	};
}

async function fixture(t, wrap) {
	const api = await compiled;
	const files = new Map();
	const volume = {
		read: key => files.get(key) ?? null,
		write: (key, bytes) => files.set(key, new Uint8Array(bytes)),
		remove: key => files.delete(key),
		rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
		list: () => [...files.keys()]
	};
	const sqljs = await api.createSqlJsDatabaseFactory({ load: volume.read, save: volume.write });
	const databaseFactory = wrap ? file => wrap(sqljs(file)) : sqljs;
	api.configure({ volume, databaseFactory, socketFactory: () => { throw Error('network forbidden in fixture'); } });
	t.after(() => api.release());
	const storage = new api.SqliteStorage('wallet.db', undefined, { encryptionKey: api.Buffer.alloc(32, 7) });
	storage.open();
	t.after(() => storage.close());
	return { api, sqljs, storage };
}

function payment(api, byte, status, direction) {
	return {
		paymentHash: api.Buffer.alloc(32, byte),
		amountMsat: 1000n,
		status,
		direction,
		createdAt: 1_700_000_000_000 + byte
	};
}

// A channel state with what saveChannel and loadChannel round-trip.
function channelState(api) {
	const point = byte => api.Buffer.alloc(33, byte);
	return api.createOpenerState({
		temporaryChannelId: api.Buffer.alloc(32, 0xdd),
		fundingSatoshis: 1_000_000n,
		pushMsat: 0n,
		localConfig: { ...api.DEFAULT_CHANNEL_CONFIG },
		localBasepoints: {
			fundingPubkey: point(2), revocationBasepoint: point(3), paymentBasepoint: point(4),
			delayedPaymentBasepoint: point(5), htlcBasepoint: point(6), firstPerCommitmentPoint: point(7)
		},
		localPerCommitmentSeed: api.Buffer.alloc(32, 8)
	});
}

function snapshot(api, byte) {
	return [{ paymentHash: api.Buffer.alloc(32, byte), amountMsat: 10_000_000n, cltvExpiry: 500, direction: api.HtlcDirection.OFFERED }];
}

// What the flag protects: a channel loaded inside a transaction that rolls
// back must write its revoked HTLC snapshots again on its next save. If they
// were marked saved, that save leaves out the rolled-back one, and a penalty
// for that commitment would miss its HTLC outputs. Answers the commitments
// storage holds after that save.
async function resaveAfterRollback(t, wrap) {
	const { api, storage } = await fixture(t, wrap);
	const id = 'aa'.repeat(32);
	const peer = '02' + '11'.repeat(32);
	const stored = () => [...(storage.loadChannel(id).state.revokedHtlcSnapshots?.keys() ?? [])];
	const state = channelState(api);
	api.recordRevokedHtlcSnapshot(state, '1', snapshot(api, 1));
	storage.saveChannel(id, state, peer);
	const loaded = storage.loadChannel(id).state;
	let loadedInside;
	assert.throws(() => storage.transaction(() => {
		api.recordRevokedHtlcSnapshot(loaded, '2', snapshot(api, 2));
		storage.saveChannel(id, loaded, peer);
		loadedInside = storage.loadChannel(id).state;
		throw new Error('rolled back');
	}), /rolled back/);
	assert.deepEqual(stored(), ['1']);
	storage.saveChannel(id, loadedInside, peer);
	return stored();
}

for (const [name, wrap] of [['the SQL.js adapter', undefined], ['an adapter without pluck or inTransaction', olderAdapter]]) {
	test(`${name}: paid invoice lookup reads plaintext columns`, async t => {
		const { api, storage } = await fixture(t, wrap);
		const { COMPLETED, PENDING } = api.PaymentStatus;
		const { INCOMING, OUTGOING } = api.PaymentDirection;
		for (const [byte, status, direction] of [[1, COMPLETED, INCOMING], [2, PENDING, INCOMING], [3, COMPLETED, OUTGOING], [4, COMPLETED, INCOMING]]) {
			const p = payment(api, byte, status, direction);
			storage.savePayment(p.paymentHash.toString('hex'), p);
		}
		const paid = storage.paymentHashesWith({ status: 'COMPLETED', direction: 'INCOMING' });
		assert.deepEqual([...paid].sort(), [api.Buffer.alloc(32, 1).toString('hex'), api.Buffer.alloc(32, 4).toString('hex')]);
	});

	test(`${name}: inTransaction holds only while a transaction runs`, async t => {
		const { storage } = await fixture(t, wrap);
		assert.equal(storage.inTransaction(), false);
		assert.equal(storage.transaction(() => storage.inTransaction()), true);
		assert.equal(storage.transaction(() => storage.transaction(() => storage.inTransaction())), true);
		assert.throws(() => storage.transaction(() => { throw new Error('rolled back'); }), /rolled back/);
		assert.equal(storage.inTransaction(), false);
	});

	test(`${name}: a channel loaded in a rolled-back transaction saves its snapshots again`, async t => {
		assert.deepEqual(await resaveAfterRollback(t, wrap), ['1', '2']);
	});
}

test('an adapter whose inTransaction is always false loses the snapshot, so the test above can tell', async t => {
	const lying = db => ({ ...olderAdapter(db), inTransaction: false });
	assert.deepEqual(await resaveAfterRollback(t, lying), ['1']);
});

test('the SQL.js adapter plucks the first column and can switch it off again', async t => {
	const { sqljs } = await fixture(t);
	const db = sqljs('pluck.db');
	t.after(() => db.close());
	db.exec('CREATE TABLE t (a TEXT, b INTEGER); INSERT INTO t VALUES (\'x\', 1), (\'y\', 2)');
	const statement = db.prepare('SELECT a, b FROM t ORDER BY b');
	assert.deepEqual(statement.pluck().all(), ['x', 'y']);
	assert.equal(statement.get(), 'x');
	assert.deepEqual([...statement.iterate()], ['x', 'y']);
	assert.deepEqual(statement.pluck(false).get(), { a: 'x', b: 1 });
	assert.equal(db.prepare('SELECT a FROM t WHERE b = 9').pluck().get(), undefined);
	assert.equal(db.inTransaction, false);
	db.transaction(() => assert.equal(db.inTransaction, true))();
	assert.equal(db.inTransaction, false);
});
