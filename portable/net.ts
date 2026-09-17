import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import { environment } from './state';
// The injected platform transport owns routing, including any relay-side Tor.
// Protocol code must not layer a second SOCKS conversation over its byte stream.
export const handlesDestinationRouting = true;
export class Socket extends EventEmitter {
	inner: any;
	destroyed = false;
	connecting = false;
	writable = true;
	readable = true;
	encrypted = false;
	private encoding?: string;
	private timeoutMs = 0;
	private timeout: any;
	constructor(..._args: any[]) {
		super();
	}
	connect(...args: any[]) {
		const opts =
			typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
		const callback = args.find((v: any) => typeof v === 'function');
		if (callback) this.once('connect', callback);
		this.connecting = true;
		try {
			this.inner = environment().socketFactory({
				host: opts.host,
				port: opts.port,
				tls: this.encrypted
			});
			for (const event of [
				'connect',
				'secureConnect',
				'data',
				'error',
				'close',
				'end',
				'timeout',
				'drain'
			])
				this.inner.on(event, (...values: any[]) => {
					if (event === 'connect') {
						this.connecting = false;
						this.arm();
					}
					if (event === 'close') {
						this.destroyed = true;
						clearTimeout(this.timeout);
					}
					if (event === 'data') {
						this.arm();
						values[0] = this.encoding
							? Buffer.from(values[0]).toString(this.encoding as any)
							: Buffer.from(values[0]);
					}
					this.emit(event, ...values);
				});
		} catch (error) {
			queueMicrotask(() => this.emit('error', error));
		}
		return this;
	}
	private arm() {
		clearTimeout(this.timeout);
		if (this.timeoutMs > 0)
			this.timeout = setTimeout(() => this.emit('timeout'), this.timeoutMs);
	}
	write(data: any, encodingOrCallback?: any, cb?: any) {
		const callback =
			typeof encodingOrCallback === 'function' ? encodingOrCallback : cb;
		return this.inner.write(
			typeof data === 'string'
				? Buffer.from(
						data,
						typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8'
				  )
				: data,
			callback
		);
	}
	end(...args: any[]) {
		this.inner?.end(...args);
		return this;
	}
	destroy(error?: any) {
		clearTimeout(this.timeout);
		this.destroyed = true;
		this.inner?.destroy(error);
		return this;
	}
	setTimeout(ms: number, cb?: any) {
		this.timeoutMs = ms;
		if (cb) this.once('timeout', cb);
		this.arm();
		return this;
	}
	setEncoding(s: string) {
		this.encoding = s;
		return this;
	}
	setKeepAlive() {
		return this;
	}
	setNoDelay() {
		return this;
	}
	ref() {
		return this;
	}
	unref() {
		return this;
	}
	pause() {
		this.inner?.pause?.();
		return this;
	}
	resume() {
		this.inner?.resume?.();
		return this;
	}
}
export function connect(...args: any[]) {
	return new Socket().connect(...args);
}
export const createConnection = connect;
export function createServer() {
	throw new Error('Embedded wallets do not listen on TCP ports');
}
export function isIP(host: string) {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? 4 : host.includes(':') ? 6 : 0;
}
export default { Socket, connect, createConnection, createServer, isIP, handlesDestinationRouting };
