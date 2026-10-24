const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');

// The keyed open's plaintext scrub (upstream #1516) runs VACUUM, which SQLite
// refuses inside a transaction, and swallows that error. The fork wraps
// open()'s schema and encryption passes in one transaction, so the scrub has
// to stay outside it or it silently never runs. Drive it through the same
// SQL.js adapter the shipped engine uses.
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
	` },
	bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', write: false,
	alias: aliases, inject: [path.join(root, 'portable/globals.ts')],
	external: ['sql.js'], define: { 'process.env.NODE_ENV': '"production"' }
}).then(result => {
	const mod = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require);
	return mod.exports;
});

async function fixture(t) {
	const api = await compiled;
	const files = new Map();
	const volume = {
		read: key => files.get(key) ?? null,
		write: (key, bytes) => files.set(key, new Uint8Array(bytes)),
		remove: key => files.delete(key),
		rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
		list: () => [...files.keys()]
	};
	const databaseFactory = await api.createSqlJsDatabaseFactory({ load: volume.read, save: volume.write });
	api.configure({ volume, databaseFactory, socketFactory: () => { throw Error('network forbidden in fixture'); } });
	t.after(() => api.release());
	const key = api.Buffer.alloc(32, 7);
	const pending = file => {
		const db = databaseFactory(file);
		try {
			return db.prepare('SELECT count(*) AS n FROM encryption_scrub_pending').get().n;
		} finally {
			db.close();
		}
	};
	const mark = file => {
		const db = databaseFactory(file);
		db.exec('INSERT OR IGNORE INTO encryption_scrub_pending (id) VALUES (1)');
		db.close();
	};
	return { api, databaseFactory, key, pending, mark };
}

test('the SQL.js adapter refuses VACUUM inside a transaction', async t => {
	const { databaseFactory } = await fixture(t);
	const db = databaseFactory('wallet.db');
	db.exec('CREATE TABLE t (id INTEGER)');
	assert.throws(() => db.transaction(() => db.exec('VACUUM'))(), /VACUUM/i);
	db.exec('VACUUM');
	db.close();
});

test('a keyed open runs a pending scrub to completion and clears its marker', async t => {
	const { api, key, pending, mark } = await fixture(t);
	const first = new api.SqliteStorage('wallet.db', undefined, { encryptionKey: key });
	first.open();
	first.close();
	assert.equal(pending('wallet.db'), 0);

	mark('wallet.db');
	assert.equal(pending('wallet.db'), 1);
	const reopened = new api.SqliteStorage('wallet.db', undefined, { encryptionKey: key });
	reopened.open();
	reopened.close();
	assert.equal(pending('wallet.db'), 0);
});

test('an open without a key leaves a pending scrub for the first keyed open', async t => {
	const { api, key, pending, mark } = await fixture(t);
	const plain = new api.SqliteStorage('wallet.db');
	plain.open();
	plain.close();
	mark('wallet.db');
	const again = new api.SqliteStorage('wallet.db');
	again.open();
	again.close();
	assert.equal(pending('wallet.db'), 1);
	const keyed = new api.SqliteStorage('wallet.db', undefined, { encryptionKey: key });
	keyed.open();
	keyed.close();
	assert.equal(pending('wallet.db'), 0);
});
