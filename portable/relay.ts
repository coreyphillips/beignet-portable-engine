import { EventEmitter } from 'events';
import { Buffer } from 'buffer';

function upstreamError(
	target: { host: string; port: number; tls: boolean },
	isElectrum: boolean,
	reason: unknown
) {
	const label = isElectrum ? 'Electrum server' : 'Primary node';
	// Only display our locally configured endpoint, never a relay-provided
	// string. Invalid third-party socket inputs do not become UI content.
	const host =
		typeof target.host === 'string' &&
		target.host.length <= 253 &&
		/^[a-zA-Z0-9:._-]+$/.test(target.host)
			? target.host
			: 'configured host';
	const port =
		Number.isInteger(target.port) && target.port > 0 && target.port <= 65535
			? target.port
			: 'configured port';
	const endpoint = `${host.includes(':') ? `[${host}]` : host}:${port}`;
	const messages: Record<string, string> = {
		BEIGNET_UPSTREAM_REFUSED: `${label} refused connection at ${endpoint}. Check that it is running and listening on this port.`,
		BEIGNET_UPSTREAM_DNS: `${label} hostname could not be resolved: ${host}. Check the address and local network.`,
		BEIGNET_UPSTREAM_TIMEOUT: `${label} connection timed out at ${endpoint}. Check the address, port, and network.`,
		BEIGNET_UPSTREAM_TLS: `${label} TLS certificate could not be verified at ${endpoint}. Check the server and certificate.`,
		BEIGNET_UPSTREAM_UNREACHABLE: `${label} is unreachable at ${endpoint}. Check the network connection.`,
		BEIGNET_UPSTREAM_UNAVAILABLE: `${label} connection is unavailable at ${endpoint}. Check the address, port, and network.`
	};
	const code =
		typeof reason === 'string' && Object.hasOwn(messages, reason)
			? reason
			: 'BEIGNET_UPSTREAM_UNAVAILABLE';
	return Object.assign(new Error(messages[code]), { code });
}

export function createRelaySocketFactory(config: {
	electrumUrl: string;
	peerUrl: string;
	token: string;
	WebSocket?: any;
	electrum?: { host: string; port: number; tls: boolean };
}) {
	const W = config.WebSocket ?? globalThis.WebSocket;
	if (!W) throw new Error('WebSocket is required');
	for (const value of [config.electrumUrl, config.peerUrl]) {
		const u = new URL(value);
		if (
			u.protocol !== 'wss:' &&
			!(
				u.protocol === 'ws:' &&
				['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(u.hostname)
			)
		)
			throw new Error('Relay requires WSS (loopback WS is allowed)');
		if (u.username || u.password || u.search || u.hash)
			throw new Error('Relay URLs must not contain credentials/query/hash');
	}
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(config.token))
		throw new Error('Relay token must be base64url');
	return (target: { host: string; port: number; tls: boolean }) => {
		const emitter: any = new EventEmitter();
		const isElectrum = config.electrum
			? target.host === config.electrum.host &&
			  target.port === config.electrum.port
			: target.tls;
		const ws = new W(isElectrum ? config.electrumUrl : config.peerUrl, [
			'beignet.v1',
			`auth.${config.token}`
		]);
		ws.binaryType = 'arraybuffer';
		let destroyed = false;
		let errorEmitted = false;
		let closeEmitted = false;
		const emitError = (error: Error) => {
			if (errorEmitted) return;
			errorEmitted = true;
			emitter.emit('error', error);
		};
		// A Node socket reports 'close' as soon as it is destroyed locally. The
		// WebSocket close handshake waits for the far side to answer, and a
		// relay whose upstream has stalled may never answer, which left the
		// engine's peer manager holding a connection it had already dropped:
		// no disconnect, no reconnect, no redial, for as long as the wallet ran.
		const emitClose = () => {
			if (closeEmitted) return;
			closeEmitted = true;
			emitter.emit('close');
		};
		ws.onopen = () => {
			emitter.emit('connect');
			if (target.tls) emitter.emit('secureConnect');
		};
		ws.onmessage = (event: any) => {
			if (typeof event.data === 'string') {
				emitter.destroy(new Error('Relay sent nonbinary data'));
				return;
			}
			if (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data))
				emitter.emit('data', Buffer.from(event.data));
			else if (event.data?.arrayBuffer)
				event.data
					.arrayBuffer()
					.then((data: any) => emitter.emit('data', Buffer.from(data)))
					.catch((e: any) => emitter.destroy(e));
			else emitter.destroy(new Error('Unknown relay data format'));
		};
		ws.onerror = () =>
			emitError(new Error('Unable to connect to transport relay'));
		ws.onclose = (event: any) => {
			const locallyClosed = destroyed;
			destroyed = true;
			// The HTTP upgrade can succeed before its fixed upstream connects.
			// Preserve a refused/DNS/TLS failure for pending Lightning handshakes
			// instead of making them wait for a generic handshake timeout.
			if (!locallyClosed && event?.code !== 1000 && event?.code !== 1001)
				emitError(upstreamError(target, isElectrum, event?.reason));
			emitClose();
		};
		emitter.write = (bytes: any, callback?: any) => {
			if (destroyed || ws.readyState !== 1)
				throw new Error('Transport relay is not connected');
			ws.send(new Uint8Array(Buffer.from(bytes)));
			callback?.();
			return true;
		};
		emitter.end = () => {
			destroyed = true;
			ws.close();
			queueMicrotask(emitClose);
		};
		emitter.destroy = (error?: any) => {
			destroyed = true;
			if (error) emitError(error);
			ws.close();
			queueMicrotask(emitClose);
		};
		for (const method of [
			'setTimeout',
			'setEncoding',
			'setKeepAlive',
			'setNoDelay',
			'pause',
			'resume',
			'ref',
			'unref'
		])
			emitter[method] = () => emitter;
		return emitter;
	};
}
