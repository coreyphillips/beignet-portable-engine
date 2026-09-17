import initSqlJs from 'sql.js';
import { Buffer } from 'buffer';
export async function createSqlJsDatabaseFactory(options: {
	load(path: string): Uint8Array | null;
	save(path: string, bytes: Uint8Array): void;
	locateFile?: (name: string) => string;
	wasmBinary?: Uint8Array;
}) {
	const SQL = await initSqlJs({
		locateFile: options.locateFile,
		wasmBinary: options.wasmBinary
	});
	return (path: string) => {
		let db = new SQL.Database(options.load(path) ?? undefined);
		let depth = 0;
		let closed = false;
		let poisoned = false;
		const assert = () => {
			if (closed || poisoned)
				throw new Error(
					poisoned
						? 'Durable database failed; close wallet and reopen before continuing'
						: 'Database closed'
				);
		};
		const durable = () => {
			try {
				options.save(path, db.export());
			} catch (error) {
				poisoned = true;
				throw error;
			}
		};
		const values = (params: any[]) =>
			params.length === 1 &&
			(Array.isArray(params[0]) ||
				(params[0] &&
					typeof params[0] === 'object' &&
					!(params[0] instanceof Uint8Array)))
				? params[0]
				: params;
		const result = {
			portableGossipBatch: true,
			prepare(sql: string) {
				return {
					run(...params: any[]) {
						assert();
						db.run(sql, values(params));
						const changes = db.getRowsModified();
						const row = db.exec('SELECT last_insert_rowid() AS id')[0];
						const lastInsertRowid = row?.values[0][0] ?? 0;
						if (depth === 0) durable();
						return { changes, lastInsertRowid };
					},
					get(...params: any[]) {
						return this.all(...params)[0];
					},
					all(...params: any[]) {
						assert();
						const statement = db.prepare(sql);
						try {
							statement.bind(values(params));
							const rows = [];
							while (statement.step())
								rows.push(
									Object.fromEntries(
										Object.entries(statement.getAsObject()).map(
											([key, value]) => [
												key,
												value instanceof Uint8Array ? Buffer.from(value) : value
											]
										)
									)
								);
							return rows;
						} finally {
							statement.free();
						}
					},
					iterate(...params: any[]) {
						return this.all(...params)[Symbol.iterator]();
					}
				};
			},
			exec(sql: string) {
				assert();
				db.exec(sql);
				if (depth === 0) durable();
				return result;
			},
			pragma(sql: string) {
				assert();
				if (/^(journal_mode|synchronous|busy_timeout)\s*=/i.test(sql))
					return [];
				const response = db.exec(`PRAGMA ${sql}`);
				return response.flatMap((r: any) =>
					r.values.map((v: any[]) =>
						Object.fromEntries(
							r.columns.map((k: string, i: number) => [k, v[i]])
						)
					)
				);
			},
			transaction(fn: any) {
				return (...args: any[]) => {
					assert();
					const name = `beignet_${depth}`;
					db.run(`SAVEPOINT ${name}`);
					depth++;
					try {
						const value = fn(...args);
						if (value?.then)
							throw new Error(
								'SQLite transaction callbacks must be synchronous'
							);
						db.run(`RELEASE SAVEPOINT ${name}`);
						depth--;
						if (depth === 0) durable();
						return value;
					} catch (error) {
						depth--;
						if (!poisoned) {
							try {
								db.run(`ROLLBACK TO SAVEPOINT ${name}`);
								db.run(`RELEASE SAVEPOINT ${name}`);
							} catch {
								poisoned = true;
							}
						}
						throw error;
					}
				};
			},
			close() {
				if (!closed) {
					closed = true;
					db.close();
				}
			},
			async backup(destination: string) {
				assert();
				options.save(destination, db.export());
			}
		};
		return result;
	};
}
