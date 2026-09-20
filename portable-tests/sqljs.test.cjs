const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');
const compiled = buildSync({
	entryPoints: [path.join(__dirname, '../portable/sqljs.ts')],
	bundle: true, platform: 'browser', format: 'cjs', write: false,
	external: ['sql.js']
}).outputFiles[0].text;
const compiledModule = { exports: {} };
new Function('module', 'exports', 'require', compiled)(compiledModule, compiledModule.exports, require);
const { createSqlJsDatabaseFactory } = compiledModule.exports;
test('SQLite transactions persist across fresh engines and rollback exceptions', async () => {
	let persisted = null,
		writes = 0;
	const factory = await createSqlJsDatabaseFactory({
		load: () => persisted,
		save: (_, b) => {
			persisted = new Uint8Array(b);
			writes++;
		}
	});
	const db = factory('wallet');
	db.exec('CREATE TABLE commits (id INTEGER PRIMARY KEY, state TEXT)');
	const before = writes;
	db.transaction(() => {
		db.prepare('INSERT INTO commits VALUES (?,?)').run(1, 'signed');
		db.prepare('INSERT INTO commits VALUES (?,?)').run(2, 'acknowledged');
	})();
	assert.equal(writes, before + 1);
	assert.throws(() =>
		db.transaction(() => {
			db.prepare('INSERT INTO commits VALUES (?,?)').run(3, 'unsafe');
			throw Error('abort');
		})()
	);
	db.close();
	const reopened = factory('wallet');
	assert.deepEqual(reopened.prepare('SELECT * FROM commits').all(), [
		{ id: 1, state: 'signed' },
		{ id: 2, state: 'acknowledged' }
	]);
	reopened.close();
});
test('failed durability barrier poisons the connection before any subsequent operation', async () => {
	let fail = false;
	const factory = await createSqlJsDatabaseFactory({
		load: () => null,
		save: () => {
			if (fail) throw Error('disk full');
		}
	});
	const db = factory('wallet');
	db.exec('CREATE TABLE commits (id INTEGER)');
	fail = true;
	assert.throws(
		() =>
			db.transaction(() =>
				db.prepare('INSERT INTO commits VALUES (?)').run(1)
			)(),
		/disk full/
	);
	assert.throws(
		() => db.prepare('SELECT * FROM commits').all(),
		/Durable database failed/
	);
	db.close();
});

test('SQLite BLOB rows satisfy the engine Buffer contract', async () => {
	const { Buffer: PortableBuffer } = require('buffer/');
	const factory = await createSqlJsDatabaseFactory({
		load: () => null,
		save: () => {}
	});
	const db = factory('wallet');
	db.exec('CREATE TABLE frames (ciphertext BLOB)');
	db.prepare('INSERT INTO frames VALUES (?)').run(new Uint8Array([1, 2, 3]));
	const row = db.prepare('SELECT * FROM frames').get();
	assert.equal(PortableBuffer.isBuffer(row.ciphertext), true);
	assert.deepEqual(Array.from(row.ciphertext), [1, 2, 3]);
	db.close();
});

test('memory scratch databases are isolated and never read or persist the durable volume', async () => {
	let reads = 0, writes = 0;
	const factory = await createSqlJsDatabaseFactory({
		load: () => { reads++; throw Error('scratch read durable volume'); },
		save: () => { writes++; throw Error('scratch wrote durable volume'); }
	});
	const first = factory(':memory:');
	first.exec('CREATE TABLE scratch (id INTEGER)');
	first.transaction(() => first.prepare('INSERT INTO scratch VALUES (?)').run(1))();
	const second = factory(':memory:');
	assert.throws(() => second.prepare('SELECT * FROM scratch').all(), /no such table/);
	second.exec('CREATE TABLE scratch (id INTEGER)');
	assert.deepEqual(second.prepare('SELECT * FROM scratch').all(), []);
	assert.equal(first.prepare('SELECT * FROM scratch').all().length, 1);
	assert.equal(reads, 0);
	assert.equal(writes, 0);
	first.close(); second.close();
});
