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
	onDiagnostic?(error: {
		phase: string;
		message: string;
		stack?: string;
	}): void;
	databaseFactory(path: string): SQLiteCompatDatabase;
	volume: DurableVolume;
	socketFactory: SocketFactory;
	iroh?: {
		factory: IrohEndpointFactory;
		relays?: string[];
		discovery?: boolean;
	};
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

/** Remaining inbound held by an immutable offline book, separate from new-request capacity. */
export interface OfflineReservation {
	state: string;
	concurrent: boolean;
	concurrentVersion?: 1 | 2;
	reservedInboundSats: number;
	unresolvedSlots: number;
}
export interface OfflineReceiveStatus {
	maxSats: number;
	available: boolean | null;
	reason: string | null;
	probedAt: number | null;
	concurrentVersion?: 1 | 2;
	reservedChannelIds: string[];
	requests: Array<{
		id: string;
		peer: string;
		amountSats: number;
		channelId?: string;
		epochId?: string;
		concurrent?: boolean;
		concurrentVersion?: 1 | 2;
		state?: string;
		snapshotSeq?: string | null;
		capabilityHold?: boolean;
		reservedInboundSats?: number;
		unresolvedSlots?: number;
		done?: boolean;
	}>;
}

export interface IrohAddress {
	endpointId: string;
	relayUrl?: string;
	directAddresses?: string[];
}
export interface IrohDiagnostics {
	endpointId: string;
	path: 'direct' | 'relay' | 'unknown';
	rttMs?: number;
}
export interface IrohStream {
	read(limit: number): Promise<Uint8Array>;
	writeAll(data: Uint8Array): Promise<void>;
	close(): void;
	closed(): Promise<void>;
	diagnostics(): IrohDiagnostics;
}
export declare class IrohTransport {
	constructor(stream: IrohStream);
	readonly transportType: 'iroh';
	readonly writableLength: number;
	on(event: string, listener: (...args: any[]) => void): this;
	write(data: Uint8Array | string, callback?: (error?: Error) => void): boolean;
	setTimeout(ms: number, callback?: () => void): this;
	setKeepAlive(enabled?: boolean, delay?: number): this;
	destroy(error?: Error): this;
	getIrohDiagnostics(): IrohDiagnostics;
}
export interface IrohEndpoint {
	address(): IrohAddress;
	connect(address: IrohAddress, timeoutMs: number): Promise<IrohTransport>;
	listen(
		onConnection: (socket: IrohTransport) => void,
		onError: (error: Error) => void
	): void;
	stopListening(): void;
	close(): Promise<void>;
}
export type IrohEndpointFactory = (options: {
	secretKey: Uint8Array;
	relays?: string[];
	discovery?: boolean;
	maxPendingInbound?: number;
	handshakeTimeoutMs?: number;
}) => Promise<IrohEndpoint>;
export declare const IROH_ALPN: string;
export interface ParsedPrimary {
	pubkey: string;
	host: string;
	port: number;
	uri: string;
	transport?: {
		type: 'iroh';
		endpointId: string;
		relayUrl?: string;
		fallbackOnion?: { host: string; port: number };
	};
}
export declare function parsePrimaryUri(input: string): ParsedPrimary;
export declare function parsePrimaryFallback(
	primary: ParsedPrimary,
	input?: string
): ParsedPrimary | undefined;
