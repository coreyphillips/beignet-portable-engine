const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSqlJsDatabaseFactory } = require('../dist/sqljs.cjs');
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
