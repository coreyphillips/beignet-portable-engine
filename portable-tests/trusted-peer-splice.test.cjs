const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const source = buildSync({
  stdin: { contents: `
    export * from './portable-tests/helpers/splice-wire';
    export { signerFromSeed } from './portable-tests/helpers/real-signing';
    export { Channel } from './src/lightning/channel/channel';
    export { ChannelManager } from './src/lightning/channel/channel-manager';
    export { ChannelActionType } from './src/lightning/channel/channel-actions';
    export { MessageType } from './src/lightning/message/types';
    export { ChannelState } from './src/lightning/channel/types';
    export { serializeChannelState, deserializeChannelState } from './src/lightning/storage/serialization';
    export { decodeSpliceMessage, encodeSpliceMessage } from './src/lightning/message/splice';
    export { decodeTxSignaturesMessage, encodeTxSignaturesMessage } from './src/lightning/message/interactive-tx';`,
    resolveDir: require('node:path').join(__dirname, '..'), loader: 'ts',
  }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', source)(mod, mod.exports, require);
const { makeWirePair, makeExternalSpliceWallet, startSpliceIn, openerSeed,
  acceptorSeed, SPLICE_AMOUNT, signerFromSeed, Channel, ChannelManager,
  ChannelActionType: A, MessageType: M, ChannelState,
  serializeChannelState, deserializeChannelState, decodeSpliceMessage, encodeSpliceMessage,
  decodeTxSignaturesMessage, encodeTxSignaturesMessage,
} = mod.exports;
const locked = (pair, channel) => pair.sent.filter(m => m.from === channel && m.msgType === M.SPLICE_LOCKED);

function begin({ trust = true, reverse = false, hold = false, lockDepth, peerSignsFirst = false } = {}) {
  const pair = makeWirePair();
  const sender = reverse ? pair.acceptor : pair.opener;
  const receiver = reverse ? pair.opener : pair.acceptor;
  const policy = { trusted: trust };
  receiver.setTrustedPeerSplicePolicy(() => policy.trusted);
  if (peerSignsFirst) receiver._maybeSendSpliceTxSigsOrdered = () => [];
  const wallet = makeExternalSpliceWallet();
  wallet.inputs = wallet.inputs.slice(0, 1);
  if (hold) pair.hold(M.TX_SIGNATURES);
  if (lockDepth !== undefined) pair.intercept(M.SPLICE, payload =>
    encodeSpliceMessage({ ...decodeSpliceMessage(payload), lockDepth }));
  sender.setSpliceInInputs(wallet.inputs, wallet.changeScript);
  pair.enqueue(receiver, sender, sender.initiateSplice(SPLICE_AMOUNT, 253));
  pair.pump();
  return { pair, sender, receiver, policy };
}

for (const reverse of [false, true]) test(`confirmed home accepts trusted peer-only candidate, original receiver opener=${reverse}`, () => {
  const { pair, sender, receiver } = begin({ reverse });
  assert.deepEqual(pair.errors, []);
  assert.equal(locked(pair, receiver).length, 1);
  assert.equal(locked(pair, sender).length, 0, 'Provider has a separate trust decision');
  const state = receiver.getFullState();
  assert.equal(state.spliceInFlight.trustedPeerFunding, true);
  assert.equal(state.spliceInFlight.fullySigned, true);
  assert.equal(state.spliceInFlight.confirmed, false);
  assert.equal(state.spliceInFlight.localSpliceLocked, true);
  assert.equal(state.zeroConfEnabled, false);
  assert.equal(state.trustedPeer, false);
  assert.ok(state.minimumDepth > 0);
  assert.equal(receiver._spliceWatchDepth(), state.minimumDepth);
  assert.equal(state.fundingSatoshis, 1000000n, 'Wait for the provider lock before adoption');
  pair.enqueue(receiver, sender, sender.sendSpliceLocked());
  pair.pump();
  assert.deepEqual(pair.errors, []);
  assert.equal(receiver.getFullState().fundingSatoshis, 1300000n);
  assert.equal(receiver.getState(), ChannelState.NORMAL);
  const retained = receiver.getFullState().unconfirmedSpliceTxs;
  assert.equal(retained.length, 1, 'Unconfirmed funding remains available for rebroadcast');
  const restarted = deserializeChannelState(serializeChannelState(receiver.getFullState()));
  assert.equal(restarted.unconfirmedSpliceTxs[0].txHex, retained[0].txHex);
  assert.equal(restarted.minimumDepth, state.minimumDepth);
});

for (const lockDepth of [1, 6]) test(`explicit lock depth ${lockDepth} excludes trusted override`, () => {
  const { pair, receiver } = begin({ lockDepth });
  assert.deepEqual(pair.errors, []);
  assert.equal(locked(pair, receiver).length, 0);
  assert.equal(receiver.getFullState().spliceInFlight.trustedPeerFunding, undefined);
});

test('absent or revoked current trust prevents fast lock', () => {
  const absent = begin({ trust: false });
  assert.deepEqual(absent.pair.errors, []);
  assert.equal(locked(absent.pair, absent.receiver).length, 0);
  assert.equal(absent.receiver.getFullState().spliceInFlight.trustedPeerFunding, undefined);
  const pending = begin({ hold: true });
  assert.equal(pending.receiver.getFullState().spliceInFlight.trustedPeerFunding, true);
  pending.policy.trusted = false;
  pending.pair.releaseHeld();
  assert.deepEqual(pending.pair.errors, []);
  assert.equal(locked(pending.pair, pending.receiver).length, 0);
});

test('candidate permission survives serialization and restart only with current trust', () => {
  for (const trusted of [true, false]) {
    const { pair, receiver, sender } = begin({ hold: true });
    const disk = serializeChannelState(receiver.getFullState());
    const restored = new Channel(deserializeChannelState(disk));
    restored.setSigner(signerFromSeed(acceptorSeed));
    restored.setTrustedPeerSplicePolicy(() => trusted);
    restored.restoreSpliceInFlight();
    pair.replace(receiver, restored);
    pair.releaseHeld();
    assert.deepEqual(pair.errors, []);
    assert.equal(locked(pair, restored).length, trusted ? 1 : 0);
    assert.equal(restored.getFullState().spliceInFlight.confirmed, false);
    assert.equal(restored.getFullState().zeroConfEnabled, false);
  }
});

test('old and malformed persisted permission cannot authorize a restored candidate', () => {
  for (const permission of [undefined, false, 'true', 1]) {
    const { pair, receiver } = begin({ hold: true });
    const disk = serializeChannelState(receiver.getFullState());
    disk.spliceInFlight.trustedPeerFunding = permission;
    const restored = new Channel(deserializeChannelState(disk));
    restored.setSigner(signerFromSeed(acceptorSeed));
    restored.setTrustedPeerSplicePolicy(() => true);
    restored.restoreSpliceInFlight();
    pair.replace(receiver, restored);
    pair.releaseHeld();
    assert.deepEqual(pair.errors, []);
    assert.equal(locked(pair, restored).length, 0);
    assert.equal(restored.getFullState().spliceInFlight.trustedPeerFunding, undefined);
  }
});

test('authorization checks the real input namespace, including hidden net-zero local inputs', () => {
  const { receiver } = begin({ hold: true });
  assert.equal(receiver._authorizeTrustedPeerSplice(), true);
  const session = receiver._spliceSession;
  const inputs = session.getTxBuilder().getInputs();
  const peerInput = inputs.find(input => input.prevTx?.length);
  const oldSerial = peerInput.serialId;
  peerInput.serialId = oldSerial + 1n;
  assert.equal(session.getLocalRelativeSatoshis(), 0n);
  assert.equal(receiver._authorizeTrustedPeerSplice(), false);
  peerInput.serialId = oldSerial;
  const outputs = session.getTxBuilder().getOutputs();
  const oldOutput = outputs[0].serialId;
  outputs[0].serialId = oldOutput + 1n;
  assert.equal(receiver._authorizeTrustedPeerSplice(), false);
  outputs[0].serialId = oldOutput;
  receiver._spliceTx.ourExternalInputIndices.push(1);
  assert.equal(receiver._authorizeTrustedPeerSplice(), false);
});

test('third-party input path with explicit depth never gets candidate authorization', () => {
  const pair = makeWirePair();
  pair.opener.setTrustedPeerSplicePolicy(() => true);
  pair.acceptor.setTrustedPeerSplicePolicy(() => true);
  pair.intercept(M.SPLICE, payload => encodeSpliceMessage({ ...decodeSpliceMessage(payload), lockDepth: 6 }));
  startSpliceIn(pair, makeExternalSpliceWallet());
  assert.deepEqual(pair.errors, []);
  assert.equal(pair.opener.getFullState().spliceInFlight.trustedPeerFunding, undefined);
  assert.equal(pair.acceptor.getFullState().spliceInFlight.trustedPeerFunding, undefined);
  assert.equal(locked(pair, pair.opener).length + locked(pair, pair.acceptor).length, 0);
});

test('fast lock requires exact persisted transaction, complete witnesses, and no external/local inputs', () => {
  const { receiver } = begin();
  const f = receiver.getFullState().spliceInFlight;
  assert.equal(receiver._canLockTrustedPeerSplice(), true);
  for (const [field, value] of [
    ['isInitiator', true], ['localRelativeSatoshis', 1n], ['remoteRelativeSatoshis', 0n],
    ['lockAtDepth', 0], ['fullySigned', false], ['sentTxSignatures', false],
    ['receivedTxSignatures', false], ['externalInputIndices', [1]], ['ourWalletInputIndices', [1]],
    ['newFundingSatoshis', 1300001n], ['newFundingOutputIndex', 99], ['spliceTxid', Buffer.alloc(32)],
  ]) {
    const previous = f[field];
    f[field] = value;
    assert.equal(receiver._canLockTrustedPeerSplice(), false, field);
    f[field] = previous;
  }
  const tx = require('bitcoinjs-lib').Transaction.fromHex(f.spliceTxHex);
  tx.ins[1].witness = [];
  f.spliceTxHex = tx.toHex();
  assert.equal(receiver._canLockTrustedPeerSplice(), false);
});

function managerFor(channel, { persist, policy = () => true } = {}) {
  const state = channel.getFullState();
  const manager = new ChannelManager({
    localFundingPrivkey: Buffer.alloc(32, 7),
    localPerCommitmentSeed: state.localPerCommitmentSeed,
    localBasepoints: state.localBasepoints,
    trustedPeerSplice: policy,
    persistence: { persist: persist ?? (() => ({ committed: true, outboxIds: [] })) },
  });
  const peer = state.remoteBasepoints.fundingPubkey.toString('hex');
  manager.channelPeers.set(state.channelId.toString('hex'), peer);
  manager.channels.set(state.channelId.toString('hex'), channel);
  manager.on('error', () => {});
  return { manager, peer };
}

test('manager needs both explicit trusted peer and current application authorization for the exact channel', () => {
  const { receiver } = begin({ hold: true });
  let allowed = true;
  const { manager, peer } = managerFor(receiver, { policy: () => allowed });
  manager.configureTrustedPeerSplice(receiver, peer);
  assert.equal(receiver._authorizeTrustedPeerSplice(), false);
  manager.setJitClients([peer]);
  assert.equal(receiver._authorizeTrustedPeerSplice(), false, 'A JIT client is not an explicitly trusted peer');
  manager.addTrustedPeer(peer);
  assert.equal(receiver._authorizeTrustedPeerSplice(), true);
  allowed = false;
  assert.equal(receiver._authorizeTrustedPeerSplice(), false);
  allowed = true;
  manager.channelPeers.set(receiver.getChannelId().toString('hex'), '02' + '11'.repeat(32));
  assert.equal(receiver._authorizeTrustedPeerSplice(), false);
});

for (const failure of ['uncommitted', 'throws']) test(`failed durable write (${failure}) suppresses candidate broadcast and splice_locked`, () => {
  const { pair, sender, receiver } = begin({ hold: true });
  // The responder signed first; finish the provider's signature in a separate
  // wire fixture and replay its exact completion actions through the manager.
  const batches = [];
  const original = receiver.handleTxSignatures.bind(receiver);
  receiver.handleTxSignatures = message => {
    const actions = original(message);
    batches.push(actions);
    return actions;
  };
  pair.releaseHeld();
  const actions = batches.find(batch => batch.some(a => a.type === A.SEND_MESSAGE && a.messageType === M.SPLICE_LOCKED));
  assert.ok(actions);
  assert.equal(actions[0].type, A.PERSIST_STATE);
  const writes = [];
  const { manager, peer } = managerFor(receiver, { persist(frame) {
    writes.push(frame);
    if (failure === 'throws') throw Error('disk offline');
    return { committed: false, outboxIds: [] };
  } });
  const sends = [], broadcasts = [];
  manager.peerManager = { sendToPeer: (...args) => sends.push(args) };
  manager.on('broadcast:tx', tx => broadcasts.push(tx));
  manager.processActions(peer, receiver, actions);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].channel.getFullState().spliceInFlight.trustedPeerFunding, true);
  assert.deepEqual(sends, []);
  assert.deepEqual(broadcasts, []);
});

test('peer-first signature ordering locks only after both real signatures are verified', () => {
  const { pair, sender, receiver } = begin({ peerSignsFirst: true });
  assert.deepEqual(pair.errors, []);
  assert.equal(pair.sent.filter(m => m.msgType === M.TX_SIGNATURES).length, 0);
  assert.equal(locked(pair, receiver).length, 0);
  pair.enqueue(receiver, sender, sender._maybeSendSpliceTxSigs());
  pair.pump();
  assert.deepEqual(pair.errors, []);
  const signatures = pair.sent.filter(m => m.msgType === M.TX_SIGNATURES);
  assert.equal(signatures.length, 2);
  assert.equal(signatures[0].from, sender);
  assert.equal(signatures[1].from, receiver);
  assert.equal(locked(pair, receiver).length, 1);
  assert.equal(receiver.getFullState().spliceInFlight.confirmed, false);
});

for (const invalid of ['witness', 'shared-signature']) test(`invalid peer ${invalid} cannot fast lock`, () => {
  const { pair, sender, receiver } = begin({ peerSignsFirst: true });
  pair.intercept(M.TX_SIGNATURES, payload => {
    const message = decodeTxSignaturesMessage(payload);
    if (invalid === 'shared-signature') message.sharedInputSignature = Buffer.alloc(64);
    else message.witnesses = message.witnesses.map(stack => stack.map((item, i) => i === 0 ? Buffer.alloc(item.length) : item));
    return encodeTxSignaturesMessage(message);
  });
  pair.enqueue(receiver, sender, sender._maybeSendSpliceTxSigs());
  pair.pump();
  assert.ok(pair.errors.length > 0);
  assert.equal(locked(pair, receiver).length, 0);
  assert.equal(pair.broadcasts.length, 0);
  assert.notEqual(receiver.getFullState().spliceInFlight?.fullySigned, true);
});
