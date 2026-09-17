/** Only public gossip cache writes may use this queue. Channel, key, payment,
 * invoice and recovery transitions must always use synchronous transactions. */
export class ReconstructableBatch {
	private pending = new Map<string, () => void>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(
		private transaction: (fn: () => void) => void,
		private onError: (error: unknown) => void,
		private delayMs = 100,
		private maximum = 500
	) {}
	enqueue(key: string, write: () => void) {
		this.pending.set(key, write);
		if (this.pending.size >= this.maximum) {
			this.flush();
			return;
		}
		if (!this.timer)
			this.timer = setTimeout(() => {
				this.timer = undefined;
				try {
					this.flush();
				} catch (error) {
					this.onError(error);
				}
			}, this.delayMs);
	}
	flush() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.pending.size) return;
		const pending = this.pending;
		this.transaction(() => {
			for (const write of pending.values()) write();
		});
		this.pending = new Map();
	}
}
