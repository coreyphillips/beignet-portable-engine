import { EventEmitter } from 'events';
import { Buffer } from 'buffer';

/**
 * The one HTTPS request an embedded wallet makes: the Rapid Gossip Sync
 * snapshot, which src/lightning/gossip/rapid-sync.ts downloads with
 * `https.get`. The build maps `https` to this module for that importer only
 * (scripts/build-portable.cjs); every other `https` import still resolves to
 * portable/unsupported.ts and fails explicitly.
 *
 * Without it a device had no map of the network: its only graph source was
 * gossip from the primary, which cannot serve the signatureless entries its
 * own snapshot gave it, so routes past the primary were not found.
 *
 * Implements the slice of Node's `https.get` that fetchRapidGossipSnapshot
 * uses, over fetch: the response's statusCode, resume() and its 'data',
 * 'end' and 'error' events, and the request's 'error' event, setTimeout and
 * destroy. The body arrives as one chunk.
 */
class Response extends EventEmitter {
	statusCode = 0;
	resume(): void {}
}

class Request extends EventEmitter {
	readonly controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private finished = false;
	setTimeout(ms: number, onTimeout: () => void): this {
		this.clearTimer();
		this.timer = setTimeout(onTimeout, ms);
		return this;
	}
	destroy(error?: Error): void {
		if (this.finished) return;
		this.finish();
		this.controller.abort();
		if (error) this.emit('error', error);
	}
	/** Settle once: no timer, and nothing more from a late fetch. */
	finish(): boolean {
		if (this.finished) return false;
		this.finished = true;
		this.clearTimer();
		return true;
	}
	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
}

export function get(url: string, onResponse: (res: Response) => void): Request {
	const req = new Request();
	// Node's https.get answers asynchronously, and the caller attaches its
	// 'error' listener and timeout after the call returns.
	Promise.resolve()
		.then(async () => {
			const answer = await fetch(url, { signal: req.controller.signal });
			const res = new Response();
			res.statusCode = answer.status;
			onResponse(res);
			if (answer.status !== 200) {
				req.finish();
				return;
			}
			const body = Buffer.from(await answer.arrayBuffer());
			if (!req.finish()) return;
			res.emit('data', body);
			res.emit('end');
		})
		.catch((error) => {
			if (!req.finish()) return;
			req.emit('error', error instanceof Error ? error : new Error(String(error)));
		});
	return req;
}

const unavailable = () => {
	throw new Error('This server-side service is unavailable in an embedded wallet');
};
export const request = unavailable;
export default { get, request };
