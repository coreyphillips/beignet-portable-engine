export interface DurableVolume {
	read(path: string): Uint8Array | null;
	write(path: string, bytes: Uint8Array): void;
	remove(path: string): void;
	rename(from: string, to: string): void;
	list?(prefix?: string): string[];
}
export interface SQLiteStatement {
	run(...parameters: any[]): {
		changes: number;
		lastInsertRowid: number | bigint;
	};
	get(...parameters: any[]): any;
	all(...parameters: any[]): any[];
	iterate(...parameters: any[]): IterableIterator<any>;
}
export interface SQLiteCompatDatabase {
	prepare(sql: string): SQLiteStatement;
	exec(sql: string): unknown;
	pragma(sql: string): unknown;
	transaction<T extends (...args: any[]) => any>(fn: T): T;
	close(): void;
	backup?(destination: string): Promise<void>;
}
export interface TransportTarget {
	host: string;
	port: number;
	tls: boolean;
}
export interface SocketLike {
	on(event: string, listener: (...args: any[]) => void): any;
	write(data: Uint8Array | string, callback?: () => void): boolean;
	end(...args: any[]): any;
	destroy(error?: Error): any;
	setTimeout?(ms: number): any;
	setEncoding?(encoding: string): any;
	setKeepAlive?(enabled?: boolean): any;
	setNoDelay?(enabled?: boolean): any;
}
/** Returns an already connecting socket, emitting connect/data/error/close asynchronously. */
export type SocketFactory = (target: TransportTarget) => SocketLike;
export interface PortableRuntimeOptions {
/** Optional local development diagnostics; never persisted or sent to the relay. */
onDiagnostic?(error:{phase:string;message:string;stack?:string}):void;
	databaseFactory(path: string): SQLiteCompatDatabase;
	volume: DurableVolume;
	socketFactory: SocketFactory;
	electrum?: TransportTarget;
}
export interface PortableRuntime {
	request(input: {
		method?: string;
		path: string;
		body?: any;
		readOnly?: boolean;
	}): Promise<any>;
	close(): Promise<void>;
}
export declare const DEFAULT_PRIMARY: string;
export declare function createPortableRuntime(
	options: PortableRuntimeOptions
): Promise<PortableRuntime>;
export declare function createRelaySocketFactory(config: {
	electrumUrl: string;
	peerUrl: string;
	token: string;
	electrum: TransportTarget;
	WebSocket?: any;
}): SocketFactory;
