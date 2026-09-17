import type { SQLiteCompatDatabase } from './types';
export declare function createSqlJsDatabaseFactory(options: {
	load(path: string): Uint8Array | null;
	save(path: string, bytes: Uint8Array): void;
	locateFile?: (name: string) => string;
	wasmBinary?: Uint8Array;
}): Promise<(path: string) => SQLiteCompatDatabase>;
