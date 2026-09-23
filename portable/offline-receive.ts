import { Buffer } from 'buffer';
import { randomBytes } from './crypto';
import type { BeignetNode } from '../src/cli/beignet-node';
import { DEFAULT_CHANNEL_CONFIG } from '../src/lightning/channel/types';

type Job = {
	id: string;
	peer: string;
	amountSats: number;
	allocationId: string;
	channelId?: string;
	epochId?: string;
	previousEpochId?: string;
	expiresAt?: number;
	invoice?: any;
	done?: boolean;
};
const live = (e: any) => e && !['CLOSED', 'ABORTED'].includes(e.state);
const fail = (code: string, message: string): never => {
	throw Object.assign(new Error(message), { code, status: 409 });
};
const MINIMUM_SATS = Number(DEFAULT_CHANNEL_CONFIG.dustLimitSatoshis);
/** Inbound a receive channel keeps beyond the amount it holds offline. */
const INBOUND_HEADROOM_SATS = 50000;
export class OfflineReceive {
	private jobs: Job[];
	private creating = false;
	private syncing = false;
	private stopped = false;
	constructor(
		private node: BeignetNode,
		private save: (jobs: Job[]) => void,
		initial: Job[],
		private now = Date.now
	) {
		if (
			!Array.isArray(initial) ||
			initial.some(
				(j) =>
					!j ||
					typeof j.id !== 'string' ||
					!/^[a-f0-9]{66}$/.test(j.peer) ||
					!/^[a-f0-9]{32}$/.test(j.allocationId) ||
					!Number.isSafeInteger(j.amountSats) ||
					j.amountSats <= 0 ||
					(j.channelId !== undefined && !/^[a-f0-9]{64}$/.test(j.channelId)) ||
					(j.epochId !== undefined && !/^[a-f0-9]{64}$/.test(j.epochId))
			)
		)
			throw Error('Invalid receive journal');
		this.jobs = initial;
	}
	stop() {
		this.stopped = true;
	}
	ownsInvoice(hash: string): boolean {
		return this.jobs.some((j) => j.invoice?.paymentHash === hash);
	}
	private persist() {
		this.save(this.jobs);
	}
	reservedIds(): Set<string> {
		return new Set(
			this.jobs.filter((j) => !j.done && j.channelId).map((j) => j.channelId!)
		);
	}
	/**
	 * Channels that can hold an offline receive of some amount: usable, with
	 * the peer, unreserved, no live epoch, and holding none of this wallet's
	 * money. Never park spendable money on a receive lane. A channel with
	 * earned funds remains available to the normal send and channelize paths.
	 */
	private candidates(peer: string): any[] {
		const reserved = this.reservedIds();
		const epochs = this.node.fforEpochs('R');
		return this.node
			.listChannels()
			.filter(
				(c) =>
					c.peerPubkey === peer &&
					c.state === 'NORMAL' &&
					c.htlcUsable &&
					c.localBalanceSats === 0 &&
					!reserved.has(c.channelId) &&
					!live(epochs.find((e: any) => e.channelId === c.channelId))
			);
	}
	private channelFor(peer: string, amountSats: number): any {
		return this.candidates(peer).find(
			(c) => c.remoteBalanceSats >= amountSats + INBOUND_HEADROOM_SATS
		);
	}
	/**
	 * The largest offline receive one channel can hold right now, or 0 when
	 * none can hold the minimum. The wallet offers "Receive offline" only
	 * above 0, so the refusals in quote and create only meet a race.
	 */
	capacity(peer: string): { maxSats: number } {
		const most = this.candidates(peer).reduce(
			(max, c) =>
				Math.max(max, (Number(c.remoteBalanceSats) || 0) - INBOUND_HEADROOM_SATS),
			0
		);
		return { maxSats: most >= MINIMUM_SATS ? most : 0 };
	}
	private unavailable(peer: string): never {
		const { maxSats } = this.capacity(peer);
		return fail(
			'RECEIVE_UNAVAILABLE',
			maxSats > 0
				? `An offline receive can take up to ${maxSats} sats right now. Enter a smaller amount, or turn off Receive offline.`
				: 'No channel can hold an offline receive right now. It needs a channel with your primary node that holds none of your balance. Turn off Receive offline to create an ordinary payment request.'
		);
	}
	private checkAmount(amountSats: number) {
		if (!Number.isSafeInteger(amountSats) || amountSats <= 0)
			fail('AMOUNT_REQUIRED', 'Enter an amount for this payment request.');
		if (amountSats < MINIMUM_SATS)
			fail(
				'AMOUNT_TOO_SMALL',
				`Enter at least ${MINIMUM_SATS} sats for this payment request.`
			);
	}
	async quote(peer: string, amountSats: number): Promise<any> {
		this.checkAmount(amountSats);
		// Refuse before the review rather than after it: without a channel that
		// can hold the amount, create would only refuse later.
		if (!this.channelFor(peer, amountSats)) this.unavailable(peer);
		return this.terms(peer, amountSats);
	}
	private async terms(peer: string, amountSats: number): Promise<any> {
		this.checkAmount(amountSats);
		const terms = await this.node
			.getFforReceiveService()
			.request(peer, { op: 'quote' }, 15000);
		if (
			terms?.version !== 1 ||
			!Number.isSafeInteger(terms.feeBaseMsat) ||
			terms.feeBaseMsat < 0 ||
			terms.feeBaseMsat > 1000000 ||
			!Number.isSafeInteger(terms.feePpm) ||
			terms.feePpm < 0 ||
			terms.feePpm > 100000
		)
			fail(
				'RECEIVE_UNAVAILABLE',
				'Your node returned unsupported receive terms.'
			);
		return {
			available: true,
			peer,
			amountSats,
			feeSats: 0,
			terms: { feeBaseMsat: terms.feeBaseMsat, feePpm: terms.feePpm },
			expiresAt: this.now() + 60000
		};
	}
	private async wait(check: () => any, timeout = 60000): Promise<any> {
		const end = this.now() + timeout;
		while (!this.stopped && this.now() < end) {
			const value = check();
			if (value) return value;
			await new Promise((r) => setTimeout(r, 200));
		}
		fail(
			'RECEIVE_PENDING',
			'Your payment request is still being prepared. Check Activity before trying again.'
		);
	}
	async create(body: any, peer: string): Promise<any> {
		if (this.creating)
			fail('RECEIVE_BUSY', 'A payment request is already being prepared.');
		if (
			typeof body.requestId !== 'string' ||
			body.requestId.length > 160 ||
			!body.quote ||
			body.quote.peer !== peer ||
			body.quote.amountSats !== body.amountSats
		)
			fail('INVALID_REVIEW', 'Review this payment request again.');
		this.creating = true;
		try {
			let job = this.jobs.find((j) => j.id === body.requestId);
			if (job && (job.peer !== peer || job.amountSats !== body.amountSats))
				fail('INVALID_REVIEW', 'This payment request changed.');
			if (job?.invoice) return job.invoice;
			if (job?.done) {
				job.done = false;
				this.persist();
			}
			if (body.quote.expiresAt <= this.now())
				fail('QUOTE_EXPIRED', 'Review this payment request again.');
			// Recheck terms before changing a channel. A peer cannot increase the
			// authorized sender fee by returning a more expensive allocation reply.
			// The channel is chosen below, so a retry whose own reservation holds
			// the channel is not refused as if another request held it.
			const fresh = await this.terms(peer, body.amountSats);
			if (JSON.stringify(fresh.terms) !== JSON.stringify(body.quote.terms))
				fail(
					'FEE_CHANGED',
					'Receive terms changed. Review the payment request again.'
				);
			if (!job) {
				job = {
					id: body.requestId,
					peer,
					amountSats: body.amountSats,
					allocationId: Buffer.from(randomBytes(16)).toString('hex')
				};
				this.jobs.push(job);
				this.persist();
			}
			await this.wait(() => this.node.getInfo().blockHeight > 0);
			if (!job.channelId) {
				const channel = this.channelFor(peer, job.amountSats);
				// An offline receive is only for a channel that ALREADY exists with
				// the primary and whose inbound covers the amount. It never obtains
				// that capacity by having the primary open a channel: this used to
				// send `allocate`, which asked the primary to fund a brand-new
				// channel ahead of any payment, fee-free, and needed zero-conf
				// trust to be usable at once. With no channel the wallet's ordinary
				// request already carries the answers: a JIT invoice (the primary
				// funds on the first payment and takes its fee) and a direct
				// funding envelope (an on-chain payer's coin becomes the channel).
				// Mirrors upstream beignet #925.
				if (!channel) {
					job.done = true;
					this.persist();
					this.unavailable(peer);
				}
				job.channelId = channel.channelId;
				this.persist();
			}
			const channelId = job.channelId!;
			const channel = await this.wait(() =>
				this.node
					.listChannels()
					.find(
						(c) =>
							c.channelId === channelId &&
							c.peerPubkey === peer &&
							c.state === 'NORMAL'
					)
			);
			if (channel.localBalanceSats !== 0)
				fail(
					'RECEIVE_UNAVAILABLE',
					'The receive channel is no longer available.'
				);
			let epoch: any = this.node
				.fforEpochs('R')
				.find((e) => e.channelId === channelId);
			if (!live(epoch)) {
				job.previousEpochId = epoch?.epochId;
				this.persist();
				const height = this.node.getInfo().blockHeight;
				epoch = this.node.fforStartEpoch({
					channelId,
					voucherAmountsMsat: [String(BigInt(job.amountSats) * 1000n)],
					settlementDeadline: height + 144,
					voucherExpiry: height + 144 + 1152,
					feeBaseMsat: body.quote.terms.feeBaseMsat,
					feeProportionalMillionths: body.quote.terms.feePpm
				});
				job.epochId = epoch.epochId;
				this.persist();
			}
			if (job.epochId && job.epochId !== epoch.epochId)
				fail('RECEIVE_UNAVAILABLE', 'The receive reservation changed.');
			if (
				epoch.epochId === job.previousEpochId ||
				epoch.slots.length !== 1 ||
				epoch.slots[0].amountMsat !== String(BigInt(job.amountSats) * 1000n)
			)
				fail(
					'RECEIVE_UNAVAILABLE',
					'The receive reservation could not be verified.'
				);
			job.epochId = epoch.epochId;
			this.persist();
			epoch = await this.wait(() => {
				const e: any = this.node.fforEpoch(channelId);
				if (e.state === 'ABORTED')
					fail(
						'RECEIVE_UNAVAILABLE',
						'Your node could not prepare this payment request.'
					);
				return e.state === 'ACTIVE' ? e : null;
			});
			const invoice = epoch.slots[0].bolt11
				? {
						bolt11: epoch.slots[0].bolt11,
						paymentHash: epoch.slots[0].paymentHash
				  }
				: this.node.fforCreateInvoice({
						channelId,
						k: 1,
						description: body.description ?? '',
						expirySecs: 600
				  });
			if (
				!this.node
					.getStorage()
					.loadAllInvoices()
					.some((i) => i.paymentHashHex === invoice.paymentHash)
			)
				fail(
					'DURABILITY_FAILED',
					'Your payment request could not be saved. Reopen the wallet.'
				);
			const decoded = this.node.decodeInvoice(invoice.bolt11);
			job.expiresAt =
				(Number(decoded.timestamp) + Number(decoded.expiry)) * 1000;
			job.invoice = { ...invoice, offlineReceive: true };
			this.persist();
			return job.invoice;
		} finally {
			this.creating = false;
		}
	}
	async sync(): Promise<void> {
		if (this.syncing || this.creating || this.stopped) return;
		this.syncing = true;
		try {
			for (const job of this.jobs) {
				if (this.stopped) return;
				if (job.done || !job.channelId) continue;
				const channel = this.node
					.listChannels()
					.find((c) => c.channelId === job.channelId);
				if (!channel || channel.state !== 'NORMAL') continue;
				const epoch: any = this.node
					.fforEpochs('R')
					.find((e) => e.channelId === job.channelId);
				if (!epoch) continue;
				if (job.epochId && job.epochId !== epoch.epochId) continue;
				if (!job.epochId) {
					if (
						epoch.epochId === job.previousEpochId ||
						epoch.slots.length !== 1 ||
						epoch.slots[0].amountMsat !== String(BigInt(job.amountSats) * 1000n)
					)
						continue;
					job.epochId = epoch.epochId;
					this.persist();
				}
				if (['CLOSED', 'ABORTED'].includes(epoch.state)) {
					job.done = true;
					this.persist();
					continue;
				}
				if (epoch.state !== 'ACTIVE') continue;
				// Recover an invoice saved by the engine immediately before a crash in
				// our metadata write. No new invoice or replacement hash is created.
				if (!job.expiresAt && epoch.slots[0]?.bolt11) {
					const d = this.node.decodeInvoice(epoch.slots[0].bolt11);
					job.expiresAt = (Number(d.timestamp) + Number(d.expiry)) * 1000;
					this.persist();
				}
				try {
					await this.node.getFforReceiveService().receipts(job.channelId);
				} catch {
					continue;
				}
				if (this.stopped) return;
				const current: any = this.node.fforEpoch(job.channelId);
				const paid = current.slots.every((s: any) => s.state === 'settled');
				const expired =
					job.expiresAt != null && this.now() >= job.expiresAt + 120000;
				const unused =
					!job.expiresAt &&
					current.slots.every((s: any) => s.state === 'unissued');
				if (
					current.epochId === epoch.epochId &&
					current.state === 'ACTIVE' &&
					(paid || expired || unused)
				)
					await this.node.fforRecover({ channelId: job.channelId });
			}
		} finally {
			this.syncing = false;
		}
	}
}
