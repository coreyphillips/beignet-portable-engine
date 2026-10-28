// Real-signing wire fixture adapted from upstream splice-external-inputs.test.ts.
import assert from 'node:assert/strict';
import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';

bitcoin.initEccLib(ecc);

import {
	Channel,
	ISpliceWalletInput
} from '../../src/lightning/channel/channel';
import {
	createOpenerState,
	createAcceptorState,
	ISpliceInFlight
} from '../../src/lightning/channel/channel-state';
import {
	ChannelState,
	DEFAULT_CHANNEL_CONFIG
} from '../../src/lightning/channel/types';
import { ChannelActionType } from '../../src/lightning/channel/channel-actions';
import { MessageType } from '../../src/lightning/message/types';
import { IChannelBasepoints } from '../../src/lightning/keys/derivation';
import { getPublicKey } from '../../src/lightning/crypto/ecdh';
import {
	decodeOpenChannelMessage,
	decodeAcceptChannelMessage
} from '../../src/lightning/message/channel-open';
import {
	decodeFundingCreatedMessage,
	decodeFundingSignedMessage,
	decodeChannelReadyMessage
} from '../../src/lightning/message/channel-funding';
import {
	decodeSpliceMessage,
	decodeSpliceAckMessage,
	decodeSpliceLockedMessage
} from '../../src/lightning/message/splice';
import { decodeStfuMessage } from '../../src/lightning/message/stfu';
import {
	decodeTxAddInputMessage,
	decodeTxAddOutputMessage,
	decodeTxSignaturesMessage,
	encodeTxSignaturesMessage
} from '../../src/lightning/message/interactive-tx';
import { decodeCommitmentSignedMessage } from '../../src/lightning/message/channel-commitment';
import { decodeChannelReestablishMessage } from '../../src/lightning/message/channel-reestablish';
import {
	serializeChannelState,
	deserializeChannelState,
	serializeSpliceInFlight,
	deserializeSpliceInFlight
} from '../../src/lightning/storage/serialization';
import {
	signerFromSeed,
	realInitialCommitmentSig
} from './real-signing';
import { taprootTweakPrivateKey } from '../../src/lightning/wallet/wallet-funding-provider';
import { createFundingScript } from '../../src/lightning/script/funding';

const FUNDING_SATOSHIS = 1_000_000n;
const SPLICE_AMOUNT = 300_000n;
const OWN_UTXO_SATS = SPLICE_AMOUNT + 100_000n;
const EXT_UTXO_SATS = 60_000n;

const openerSeed = Buffer.alloc(32, 0x11);
const acceptorSeed = Buffer.alloc(32, 0x22);
const openerCommitmentSeed = crypto
	.createHash('sha256')
	.update('splice-external-opener')
	.digest();
const acceptorCommitmentSeed = crypto
	.createHash('sha256')
	.update('splice-external-acceptor')
	.digest();

function makeBasepoints(seed: Buffer): IChannelBasepoints {
	const keys: Buffer[] = [];
	for (let i = 0; i < 5; i++) {
		keys.push(
			crypto
				.createHash('sha256')
				.update(seed)
				.update(Buffer.from([i]))
				.digest()
		);
	}
	return {
		fundingPubkey: getPublicKey(keys[0]),
		revocationBasepoint: getPublicKey(keys[1]),
		paymentBasepoint: getPublicKey(keys[2]),
		delayedPaymentBasepoint: getPublicKey(keys[3]),
		htlcBasepoint: getPublicKey(keys[4]),
		firstPerCommitmentPoint: Buffer.alloc(33)
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findSendAction(actions: any[], msgType: MessageType): any {
	return actions.find(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(a: any) =>
			a.type === ChannelActionType.SEND_MESSAGE && a.messageType === msgType
	);
}

/** An opener/acceptor pair of live channels in NORMAL. */
function makeNormalChannel(): { opener: Channel; acceptor: Channel } {
	const openerBp = makeBasepoints(openerSeed);
	const acceptorBp = makeBasepoints(acceptorSeed);
	const tempId = Buffer.alloc(32, 0xbb);

	const opener = new Channel(
		createOpenerState({
			temporaryChannelId: tempId,
			fundingSatoshis: FUNDING_SATOSHIS,
			pushMsat: 0n,
			localConfig: { ...DEFAULT_CHANNEL_CONFIG },
			localBasepoints: openerBp,
			localPerCommitmentSeed: openerCommitmentSeed
		})
	);
	const acceptor = new Channel(
		createAcceptorState({
			temporaryChannelId: tempId,
			fundingSatoshis: 0n,
			pushMsat: 0n,
			localConfig: { ...DEFAULT_CHANNEL_CONFIG },
			localBasepoints: acceptorBp,
			localPerCommitmentSeed: acceptorCommitmentSeed,
			remoteBasepoints: openerBp,
			remoteConfig: { ...DEFAULT_CHANNEL_CONFIG }
		})
	);
	opener.setSigner(signerFromSeed(openerSeed));
	acceptor.setSigner(signerFromSeed(acceptorSeed));

	const openMsg = findSendAction(
		opener.initiateOpen(),
		MessageType.OPEN_CHANNEL
	);
	const acceptActions = acceptor.handleOpenChannel(
		decodeOpenChannelMessage(openMsg.payload)
	);
	opener.handleAcceptChannel(
		decodeAcceptChannelMessage(
			findSendAction(acceptActions, MessageType.ACCEPT_CHANNEL).payload
		)
	);

	const fundingTxid = crypto.randomBytes(32);
	const fcMsg = findSendAction(
		opener.createFundingCreated(
			fundingTxid,
			0,
			realInitialCommitmentSig(opener, fundingTxid, 0)
		),
		MessageType.FUNDING_CREATED
	);
	const decodedFc = decodeFundingCreatedMessage(fcMsg.payload);
	const fsMsg = findSendAction(
		acceptor.handleFundingCreated(
			decodedFc,
			realInitialCommitmentSig(
				acceptor,
				decodedFc.fundingTxid,
				decodedFc.fundingOutputIndex
			)
		),
		MessageType.FUNDING_SIGNED
	);
	opener.handleFundingSigned(decodeFundingSignedMessage(fsMsg.payload));

	const openerReady = opener.fundingConfirmed();
	const acceptorReady = acceptor.fundingConfirmed();
	opener.handleChannelReady(
		decodeChannelReadyMessage(
			findSendAction(acceptorReady, MessageType.CHANNEL_READY).payload
		)
	);
	acceptor.handleChannelReady(
		decodeChannelReadyMessage(
			findSendAction(openerReady, MessageType.CHANNEL_READY).payload
		)
	);
	assert.equal(opener.getState(), ChannelState.NORMAL);
	assert.equal(acceptor.getState(), ChannelState.NORMAL);
	return { opener, acceptor };
}

interface ISignalSeen {
	channelId: Buffer;
	spliceTxid: Buffer;
	newFundingOutputIndex: number;
	externalInputIndices: number[];
}

interface IWirePair {
	opener: Channel;
	acceptor: Channel;
	broadcasts: Buffer[];
	errors: string[];
	/** Errors tagged with the channel that produced them. */
	errorsFrom: Array<{ from: Channel; message: string }>;
	signals: ISignalSeen[];
	/** Every message that actually left, tagged with its sender. */
	sent: Array<{ from: Channel; msgType: MessageType; payload: Buffer }>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	enqueue: (to: Channel, from: Channel, actions: any[]) => void;
	pump: () => void;
	/** Withhold this message type from delivery (it stays queued for later). */
	hold: (msgType: MessageType) => void;
	/** Deliver everything previously held, then pump. */
	releaseHeld: () => void;
	/** Transform every outbound payload of this type (adversarial peer). */
	intercept: (msgType: MessageType, fn: (payload: Buffer) => Buffer) => void;
	clearIntercepts: () => void;
	/** Swap in a restored channel object for one side. */
	replace: (old: Channel, next: Channel) => void;
}

function makeWirePair(): IWirePair {
	const { opener, acceptor } = makeNormalChannel();
	const deliver = (
		ch: Channel,
		msgType: MessageType,
		payload: Buffer
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	): any[] => {
		switch (msgType) {
			case MessageType.STFU:
				return ch.handleStfuMessage(decodeStfuMessage(payload));
			case MessageType.SPLICE:
				return ch.handleSplice(decodeSpliceMessage(payload));
			case MessageType.SPLICE_ACK:
				return ch.handleSpliceAck(decodeSpliceAckMessage(payload));
			case MessageType.TX_ADD_INPUT:
				return ch.handleTxAddInput(decodeTxAddInputMessage(payload));
			case MessageType.TX_ADD_OUTPUT:
				return ch.handleTxAddOutput(decodeTxAddOutputMessage(payload));
			case MessageType.TX_COMPLETE:
				return ch.handleTxComplete();
			case MessageType.TX_SIGNATURES:
				return ch.handleTxSignatures(decodeTxSignaturesMessage(payload));
			case MessageType.TX_ABORT:
				return ch.handleTxAbort();
			case MessageType.COMMITMENT_SIGNED:
				return ch.handleCommitmentSigned(
					decodeCommitmentSignedMessage(payload)
				);
			case MessageType.SPLICE_LOCKED:
				return ch.handleSpliceLocked(decodeSpliceLockedMessage(payload));
			case MessageType.CHANNEL_REESTABLISH:
				return ch.handleReestablish(decodeChannelReestablishMessage(payload));
			default:
				return [];
		}
	};

	interface IFrame {
		to: Channel;
		from: Channel;
		msgType: MessageType;
		payload: Buffer;
	}
	const queue: IFrame[] = [];
	const held: IFrame[] = [];
	const holdTypes = new Set<MessageType>();
	const interceptRules = new Map<MessageType, (payload: Buffer) => Buffer>();
	const broadcasts: Buffer[] = [];
	const errors: string[] = [];
	const errorsFrom: IWirePair['errorsFrom'] = [];
	const signals: ISignalSeen[] = [];
	const sent: IWirePair['sent'] = [];
	const replacements = new Map<Channel, Channel>();
	const current = (ch: Channel): Channel => replacements.get(ch) ?? ch;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const enqueue = (to: Channel, from: Channel, actions: any[]): void => {
		for (const a of actions) {
			if (a.type === ChannelActionType.ERROR) {
				errors.push(a.message);
				errorsFrom.push({ from, message: a.message });
			}
			if (a.type === ChannelActionType.BROADCAST_TX) broadcasts.push(a.tx);
			if (a.type === ChannelActionType.SPLICE_TX_SIGNATURES_NEEDED) {
				signals.push({
					channelId: a.channelId,
					spliceTxid: a.spliceTxid,
					newFundingOutputIndex: a.newFundingOutputIndex,
					externalInputIndices: a.externalInputIndices
				});
			}
			if (a.type !== ChannelActionType.SEND_MESSAGE) continue;
			const transform = interceptRules.get(a.messageType);
			const payload = transform ? transform(a.payload) : a.payload;
			sent.push({ from, msgType: a.messageType, payload });
			const frame = { to, from, msgType: a.messageType, payload };
			if (holdTypes.has(a.messageType)) held.push(frame);
			else queue.push(frame);
		}
	};

	const pump = (): void => {
		let steps = 0;
		while (queue.length > 0) {
			if (steps++ > 400) throw new Error('message pump did not settle');
			const { to, from, msgType, payload } = queue.shift()!;
			const target = current(to);
			enqueue(current(from), target, deliver(target, msgType, payload));
		}
	};

	return {
		opener,
		acceptor,
		broadcasts,
		errors,
		errorsFrom,
		signals,
		sent,
		enqueue,
		pump,
		hold: (msgType): void => {
			holdTypes.add(msgType);
		},
		releaseHeld: (): void => {
			holdTypes.clear();
			queue.push(...held.splice(0, held.length));
			pump();
		},
		intercept: (msgType, fn): void => {
			interceptRules.set(msgType, fn);
		},
		clearIntercepts: (): void => {
			interceptRules.clear();
		},
		replace: (old, next): void => {
			replacements.set(old, next);
		}
	};
}

interface IExternalWallet {
	inputs: ISpliceWalletInput[];
	changeScript: Buffer;
	ownPrevTx: bitcoin.Transaction;
	extPrevTx: bitcoin.Transaction;
	extPriv: Buffer;
	extPub: Buffer;
}

/**
 * A splice-in contribution of one OWN P2WPKH input (real signing closure) plus
 * one input owned by a THIRD PARTY, whose closure throws: the machinery must
 * never call it.
 */
function makeExternalSpliceWallet(
	kind: 'p2wpkh' | 'p2tr' | 'p2wsh' = 'p2wpkh'
): IExternalWallet {
	const ownPriv = crypto.createHash('sha256').update('splice-own-key').digest();
	const ownPub = Buffer.from(ecc.pointFromScalar(ownPriv, true)!);
	const ownScriptCode = bitcoin.payments.p2pkh({ pubkey: ownPub }).output!;
	const ownPrevTx = new bitcoin.Transaction();
	ownPrevTx.version = 2;
	ownPrevTx.addInput(crypto.randomBytes(32), 0);
	ownPrevTx.addOutput(
		bitcoin.payments.p2wpkh({ pubkey: ownPub }).output!,
		Number(OWN_UTXO_SATS)
	);

	const extPriv = crypto.randomBytes(32);
	const extPub = Buffer.from(ecc.pointFromScalar(extPriv, true)!);
	let extScript: Buffer;
	if (kind === 'p2wpkh') {
		extScript = bitcoin.payments.p2wpkh({ pubkey: extPub }).output!;
	} else if (kind === 'p2tr') {
		extScript = bitcoin.payments.p2tr({
			internalPubkey: extPub.subarray(1, 33)
		}).output!;
	} else {
		// Native segwit (so the tx_add_input receive checks pass) but a script
		// kind whose witness no generic validator can judge.
		extScript = Buffer.concat([
			Buffer.from([0x00, 0x20]),
			crypto.randomBytes(32)
		]);
	}
	const extPrevTx = new bitcoin.Transaction();
	extPrevTx.version = 2;
	extPrevTx.addInput(crypto.randomBytes(32), 0);
	extPrevTx.addOutput(extScript, Number(EXT_UTXO_SATS));

	return {
		ownPrevTx,
		extPrevTx,
		extPriv,
		extPub,
		changeScript: bitcoin.payments.p2wpkh({ pubkey: ownPub }).output!,
		inputs: [
			{
				prevTx: ownPrevTx.toBuffer(),
				prevOutputIndex: 0,
				value: OWN_UTXO_SATS,
				sequence: 0xfffffffd,
				signWitness: (
					tx: bitcoin.Transaction,
					inputIndex: number,
					value: bigint
				): Buffer[] => {
					const sighash = tx.hashForWitnessV0(
						inputIndex,
						ownScriptCode,
						Number(value),
						bitcoin.Transaction.SIGHASH_ALL
					);
					return [
						bitcoin.script.signature.encode(
							Buffer.from(ecc.sign(sighash, ownPriv)),
							bitcoin.Transaction.SIGHASH_ALL
						),
						ownPub
					];
				}
			},
			{
				prevTx: extPrevTx.toBuffer(),
				prevOutputIndex: 0,
				value: EXT_UTXO_SATS,
				sequence: 0xfffffffd,
				confirmed: true,
				external: true,
				signWitness: (): Buffer[] => {
					throw new Error('external input: the witness comes from its owner');
				}
			}
		]
	};
}

/** Start the opener's splice-in and pump the negotiation to a standstill. */
function startSpliceIn(pair: IWirePair, wallet: IExternalWallet): void {
	pair.opener.setSpliceInInputs(wallet.inputs, wallet.changeScript);
	pair.enqueue(
		pair.acceptor,
		pair.opener,
		pair.opener.initiateSplice(SPLICE_AMOUNT, 253)
	);
	pair.pump();
}


export { makeWirePair, makeExternalSpliceWallet, startSpliceIn, openerSeed, acceptorSeed, SPLICE_AMOUNT };
