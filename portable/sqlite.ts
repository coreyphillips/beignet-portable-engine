import { environment } from './state';
import type { SQLiteCompatDatabase, SQLiteStatement } from './types';

// Beignet 0.31.0 storage reads two parts of better-sqlite3 that adapters
// written for an earlier engine lack: Statement.pluck() (listInvoices) and
// Database.inTransaction (revoked HTLC snapshots are only marked saved
// outside a transaction that may still roll back). Supply them here, so a
// client's adapter keeps working unchanged. An adapter that has its own is
// left alone.
function plucking(statement: SQLiteStatement): SQLiteStatement {
	let plucked = false;
	const first = (row: any) =>
		row === undefined || !plucked ? row : Object.values(row)[0];
	return {
		run: (...parameters) => statement.run(...parameters),
		get: (...parameters) => first(statement.get(...parameters)),
		all: (...parameters) => statement.all(...parameters).map(first),
		iterate: (...parameters) =>
			plucked
				? statement.all(...parameters).map(first)[Symbol.iterator]()
				: statement.iterate(...parameters),
		pluck(toggle = true) {
			plucked = toggle;
			return this;
		}
	};
}

function completeSurface(db: SQLiteCompatDatabase): SQLiteCompatDatabase {
	if (typeof db.inTransaction !== 'boolean') {
		let depth = 0;
		const transaction = db.transaction.bind(db);
		db.transaction = ((fn: (...args: any[]) => any) => {
			const run = transaction(fn);
			return (...args: any[]) => {
				depth++;
				try {
					return run(...args);
				} finally {
					depth--;
				}
			};
		}) as SQLiteCompatDatabase['transaction'];
		Object.defineProperty(db, 'inTransaction', {
			configurable: true,
			get: () => depth > 0
		});
	}
	const prepare = db.prepare.bind(db);
	db.prepare = (sql: string) => {
		const statement = prepare(sql);
		return typeof statement.pluck === 'function'
			? statement
			: plucking(statement);
	};
	return db;
}

export default class Database {
	constructor(path: string) {
		return completeSurface(environment().databaseFactory(path));
	}
}
