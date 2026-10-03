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
	concurrent?: boolean;
	concurrentVersion?: 1 | 2;
	previousEpochId?: string;
	expiresAt?: number;
	invoice?: any;
	done?: boolean;
};
/**
 * What the primary answered the last time it was asked for its receive
 * terms: true when it settles offline receives, false with the refusal when
 * it does not, null before it has been asked.
 */
export type OfflineReceiveAvailability = {
	available: boolean | null;
	reason: string | null;
	probedAt: number | null;
	concurrentVersion?: 1 | 2;
};
const UNPROBED: OfflineReceiveAvailability = Object.freeze({
	available: null,
	reason: null,
	probedAt: null
});
/** The bound on one receive-terms quote, a review's and a probe's alike. */
const QUOTE_TIMEOUT_MS = 15000;
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
	// The last receive-terms answer, and whose it was: a wallet that moves to
	// another primary starts over at unprobed rather than carrying the old
	// primary's answer across.
	private probed: OfflineReceiveAvailability & { peer: string | null } = {
		...UNPROBED,
		peer: null
	};
	private probing:
		| { peer: string; done: Promise<OfflineReceiveAvailability> }
		| undefined;
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
					(j.epochId !== undefined && !/^[a-f0-9]{64}$/.test(j.epochId)) ||
					(j.concurrent !== undefined && typeof j.concurrent !== 'boolean') ||
					(j.concurrent === true
						? j.concurrentVersion !== 1 && j.concurrentVersion !== 2
						: j.concurrentVersion !== undefined)
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
		try {
			this.save(this.jobs);
		} catch (error) {
			this.stopped = true;
			throw error;
		}
	}
	reservedIds(): Set<string> {
		return new Set([
			...this.jobs.filter((j) => !j.done && j.channelId).map((j) => j.channelId!),
			...this.node.fforEpochs('R').filter(live).map((e: any) => e.channelId)
		]);
	}
	status() {
		const channels = this.node.listChannels();
		return {
			reservedChannelIds: [...this.reservedIds()],
			requests: this.jobs.map((job) => {
				const epoch: any = this.node
					.fforEpochs('R')
					.find(
						(e) => e.channelId === job.channelId && e.epochId === job.epochId
					);
				const reservation = epoch
					? channels.find((c) => c.channelId === job.channelId)?.ffor
					: undefined;
				return {
					...job,
					...(epoch
						? {
								state: epoch.state,
								snapshotSeq: epoch.snapshotSeq,
								capabilityHold: epoch.capabilityHold,
								reservedInboundSats: reservation?.reservedInboundSats,
								unresolvedSlots: reservation?.unresolvedSlots
						  }
						: {})
				};
			})
		};
	}
	private negotiated(peer: string): boolean {
		return this.node.fforConcurrentNegotiated?.(peer) === true;
	}
	/** Funded channels qualify only with a negotiated concurrent profile. */
	private candidates(peer: string, concurrent = false): any[] {
		const reserved = this.reservedIds();
		const epochs = this.node.fforEpochs('R');
		return this.node
			.listChannels()
			.filter(
				(c) =>
					c.peerPubkey === peer &&
					c.state === 'NORMAL' &&
					c.htlcUsable &&
					(concurrent || c.localBalanceSats === 0) &&
					!reserved.has(c.channelId) &&
					!live(epochs.find((e: any) => e.channelId === c.channelId))
			);
	}
	private channelFor(
		peer: string,
		amountSats: number,
		concurrent = false
	): any {
		return this.candidates(peer, concurrent).find(
			(c) => c.remoteBalanceSats >= amountSats + INBOUND_HEADROOM_SATS
		);
	}
	/**
	 * The largest offline receive one channel can hold right now, or 0 when
	 * none can hold the minimum. The wallet offers "Receive offline" only
	 * above 0, so the refusals in quote and create only meet a race.
	 */
	capacity(peer: string): { maxSats: number } {
		const concurrent =
			this.negotiated(peer) &&
			this.availability(peer).concurrentVersion !== undefined;
		const most = this.candidates(peer, concurrent)
			.filter((c) => (c.htlcCount ?? 0) === 0)
			.reduce(
				(max, c) =>
					Math.max(
						max,
						(Number(c.remoteBalanceSats) || 0) - INBOUND_HEADROOM_SATS
					),
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
				: 'No channel can hold an offline receive right now. It needs remaining inbound capacity on an eligible channel with your primary node. Turn off Receive offline to create an ordinary payment request.'
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
	async quote(
		peer: string,
		amountSats: number,
		requestId?: string
	): Promise<any> {
		if (this.stopped)
			fail(
				'RECEIVE_UNAVAILABLE',
				'Reopen the wallet before creating another request.'
			);
		this.checkAmount(amountSats);
		if (
			requestId !== undefined &&
			(typeof requestId !== 'string' || !requestId || requestId.length > 160)
		)
			fail('INVALID_REVIEW', 'A valid request ID is required.');
		const job = this.jobs.find((j) => j.id === requestId);
		if (job && (job.peer !== peer || job.amountSats !== amountSats))
			fail('INVALID_REVIEW', 'This payment request changed.');
		if (
			!job?.channelId &&
			!this.channelFor(peer, amountSats, this.negotiated(peer))
		)
			this.unavailable(peer);
		const quote = await this.terms(peer, amountSats);
		if (job && job.concurrentVersion !== quote.terms.concurrentVersion)
			fail(
				'RECEIVE_UNAVAILABLE',
				'The receive profile for this request is not currently available.'
			);
		if (
			!job?.channelId &&
			!this.channelFor(
				peer,
				amountSats,
				quote.terms.concurrentVersion !== undefined
			)
		)
			this.unavailable(peer);
		return quote;
	}
	/**
	 * Whether this peer settles offline receives, as it last answered: true,
	 * false with the refusal, or null until it has been asked (the primary has
	 * not connected yet, or it is not the peer that answered). Advisory: quote
	 * and create still ask the primary themselves, so a primary that changed
	 * its mind is still refused before an invoice is shared.
	 */
	availability(peer: string): OfflineReceiveAvailability {
		const { peer: answered, ...state } = this.probed;
		return answered === peer ? state : { ...UNPROBED };
	}
	/**
	 * Ask the primary for its receive terms and keep the answer, so the wallet
	 * can say whether "Receive offline" is on offer before anyone types an
	 * amount. Bounded like a review's quote, never throws, and one probe at a
	 * time per peer: a call while one is in flight shares its answer.
	 */
	probe(peer: string): Promise<OfflineReceiveAvailability> {
		if (this.stopped) return Promise.resolve(this.availability(peer));
		if (this.probing?.peer === peer) return this.probing.done;
		const settled = () => this.availability(peer);
		const done = this.fetchTerms(peer)
			.then(settled, settled)
			.finally(() => {
				if (this.probing?.done === done) this.probing = undefined;
			});
		this.probing = { peer, done };
		return done;
	}
	private answered(
		peer: string,
		available: boolean,
		reason: string | null,
		concurrentVersion?: 1 | 2
	) {
		// A stop rejects every pending request with its own text; that is not
		// the primary's answer.
		if (this.stopped) return;
		this.probed = {
			peer,
			available,
			reason,
			probedAt: this.now(),
			...(concurrentVersion ? { concurrentVersion } : {})
		};
	}
	/**
	 * The primary's receive terms, or a RECEIVE_UNAVAILABLE refusal. Every
	 * outcome is recorded: an older primary never answers and the timeout is
	 * its answer, one with settlement off refuses, and a review that reaches
	 * the primary learns what a probe would have.
	 */
	private async fetchTerms(
		peer: string
	): Promise<{
		feeBaseMsat: number;
		feePpm: number;
		concurrentVersion?: 1 | 2;
	}> {
		let terms: any;
		try {
			terms = await this.node
				.getFforReceiveService()
				.request(peer, { op: 'quote' }, QUOTE_TIMEOUT_MS);
		} catch (error: any) {
			this.answered(peer, false, String(error?.message ?? error));
			throw error;
		}
		if (
			terms?.version !== 1 ||
			!Number.isSafeInteger(terms.feeBaseMsat) ||
			terms.feeBaseMsat < 0 ||
			terms.feeBaseMsat > 1000000 ||
			!Number.isSafeInteger(terms.feePpm) ||
			terms.feePpm < 0 ||
			terms.feePpm > 100000
		) {
			const reason = 'Your node returned unsupported receive terms.';
			this.answered(peer, false, reason);
			fail('RECEIVE_UNAVAILABLE', reason);
		}
		const concurrentVersion =
			terms.concurrent === true && this.negotiated(peer)
				? terms.concurrentVersion ?? 1
				: undefined;
		if (
			concurrentVersion !== undefined &&
			concurrentVersion !== 1 &&
			concurrentVersion !== 2
		) {
			const reason = 'Your node returned unsupported concurrent receive terms.';
			this.answered(peer, false, reason);
			fail('RECEIVE_UNAVAILABLE', reason);
		}
		this.answered(peer, true, null, concurrentVersion);
		return {
			feeBaseMsat: terms.feeBaseMsat,
			feePpm: terms.feePpm,
			...(concurrentVersion ? { concurrentVersion } : {})
		};
	}
	private async terms(peer: string, amountSats: number): Promise<any> {
		this.checkAmount(amountSats);
		const terms = await this.fetchTerms(peer);
		return {
			available: true,
			peer,
			amountSats,
			feeSats: 0,
			terms,
			...(terms.concurrentVersion
				? { concurrent: true, concurrentVersion: terms.concurrentVersion }
				: {}),
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
			this.stopped ||
			typeof body.requestId !== 'string' ||
			!body.requestId ||
			body.requestId.length > 160 ||
			!body.quote ||
			body.quote.peer !== peer ||
			body.quote.amountSats !== body.amountSats ||
			!Number.isFinite(body.quote.expiresAt)
		)
			fail('INVALID_REVIEW', 'Review this payment request again.');
		this.creating = true;
		try {
			let job = this.jobs.find((j) => j.id === body.requestId);
			if (job && (job.peer !== peer || job.amountSats !== body.amountSats))
				fail('INVALID_REVIEW', 'This payment request changed.');
			if (job?.invoice) {
				const epoch: any = this.node.fforEpoch(job.channelId!);
				if (
					epoch.epochId !== job.epochId ||
					epoch.state !== 'ACTIVE' ||
					epoch.closeSent
				)
					fail(
						'RECEIVE_UNAVAILABLE',
						'This receive reservation is no longer accepting payments.'
					);
				return job.invoice;
			}
			if (job?.done && job.epochId)
				fail(
					'RECEIVE_UNAVAILABLE',
					'The previous reservation has ended. Create a new payment request.'
				);
			if (job?.done) {
				job.done = false;
				this.persist();
			}
			if (body.quote.expiresAt <= this.now())
				fail('QUOTE_EXPIRED', 'Review this payment request again.');
			const requestedVersion = job
				? job.concurrentVersion
				: body.quote.terms?.concurrentVersion;
			if (job && requestedVersion !== body.quote.terms?.concurrentVersion)
				fail('INVALID_REVIEW', 'The receive profile for this request changed.');
			const concurrent = requestedVersion === 1 || requestedVersion === 2;
			if (concurrent && !this.negotiated(peer))
				fail(
					'RECEIVE_PENDING',
					'Reconnect your node before preparing this concurrent payment request.'
				);
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
					allocationId: Buffer.from(randomBytes(16)).toString('hex'),
					...(concurrent
						? { concurrent: true, concurrentVersion: requestedVersion }
						: {})
				};
				this.jobs.push(job);
				this.persist();
			}
			await this.wait(() => this.node.getInfo().blockHeight > 0);
			if (!job.channelId) {
				const channel = this.channelFor(peer, job.amountSats, concurrent);
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
			if (!concurrent && channel.localBalanceSats !== 0)
				fail(
					'RECEIVE_UNAVAILABLE',
					'The receive channel is no longer available.'
				);
			let epoch: any = this.node
				.fforEpochs('R')
				.find((e) => e.channelId === channelId);
			if (!live(epoch)) {
				if (job.epochId)
					fail(
						'RECEIVE_UNAVAILABLE',
						'The previous reservation has ended. Create a new payment request.'
					);
				if ((channel.htlcCount ?? 0) > 0 || !channel.htlcUsable)
					fail(
						'RECEIVE_PENDING',
						'Wait for the current channel payments to finish before preparing this request.'
					);
				if (channel.remoteBalanceSats < job.amountSats + INBOUND_HEADROOM_SATS)
					fail(
						'RECEIVE_UNAVAILABLE',
						'The receive channel no longer has enough inbound capacity.'
					);
				job.previousEpochId = epoch?.epochId;
				this.persist();
				const height = this.node.getInfo().blockHeight;
				epoch = this.node.fforStartEpoch({
					channelId,
					voucherAmountsMsat: [String(BigInt(job.amountSats) * 1000n)],
					settlementDeadline: height + 144,
					voucherExpiry: height + 144 + 1152,
					feeBaseMsat: body.quote.terms.feeBaseMsat,
					feeProportionalMillionths: body.quote.terms.feePpm,
					...(concurrent
						? { concurrent: true, concurrentVersion: requestedVersion }
						: {})
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
				if (
					e.state === 'ABORTED' ||
					e.state === 'DRAINING' ||
					e.state === 'CLOSED'
				)
					fail(
						'RECEIVE_UNAVAILABLE',
						'Your node could not prepare this payment request.'
					);
				return e.state === 'ACTIVE' ? e : null;
			});
			if ((epoch.concurrentVersion ?? undefined) !== job.concurrentVersion)
				fail('RECEIVE_UNAVAILABLE', 'The receive profile changed.');
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
			job.invoice = {
				...invoice,
				offlineReceive: true,
				requestId: job.id,
				...(job.concurrent
					? { concurrent: true, concurrentVersion: job.concurrentVersion }
					: {})
			};
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
				if (job.epochId && job.epochId !== epoch.epochId) {
					// The engine permits replacement only after the previous book is terminal.
					// Keep the current book reserved through its authoritative epoch below.
					job.done = true;
					this.persist();
					continue;
				}
				if (!job.epochId) {
					if (
						(epoch.concurrentVersion ?? undefined) !== job.concurrentVersion ||
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
				if (job.concurrentVersion !== epoch.concurrentVersion) continue;
				if (
					epoch.state !== 'ACTIVE' &&
					!(epoch.concurrentVersion && epoch.state === 'DRAINING')
				)
					continue;
				// Recover an invoice saved by the engine immediately before a crash in
				// our metadata write. No new invoice or replacement hash is created.
				if (!job.expiresAt && epoch.slots[0]?.bolt11) {
					const d = this.node.decodeInvoice(epoch.slots[0].bolt11);
					job.expiresAt = (Number(d.timestamp) + Number(d.expiry)) * 1000;
					this.persist();
				}
				try {
					if (epoch.concurrentVersion) this.node.fforSync(job.channelId);
					else await this.node.getFforReceiveService().receipts(job.channelId);
				} catch {
					continue;
				}
				if (this.stopped) return;
				const current: any = this.node.fforEpoch(job.channelId);
				const paid = current.slots.every((s: any) =>
					current.concurrentVersion
						? s.state === 'redeemed' || s.state === 'cancelled'
						: s.state === 'settled'
				);
				const expired =
					job.expiresAt != null && this.now() >= job.expiresAt + 120000;
				const unused =
					!job.expiresAt &&
					current.slots.every((s: any) => s.state === 'unissued');
				if (
					current.epochId === epoch.epochId &&
					current.state === 'ACTIVE' &&
					(paid || expired || unused)
				) {
					if (current.concurrentVersion)
						this.node.fforCloseEpoch(job.channelId);
					else await this.node.fforRecover({ channelId: job.channelId });
				}
			}
		} finally {
			this.syncing = false;
		}
	}
}
