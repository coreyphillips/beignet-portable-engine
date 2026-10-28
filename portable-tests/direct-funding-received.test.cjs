const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');

// Exercise the selectively backported upstream store and channel methods.
// The build remains portable; these fixtures need neither a chain nor a peer.
const source = buildSync({
  stdin: {
    contents: `
      export * from './src/lightning/direct-funding/requests';
      export { DirectFundingReceiver } from './src/lightning/direct-funding/receiver/engine';
      export { Channel } from './src/lightning/channel/channel';
      export { createOpenerState } from './src/lightning/channel/channel-state';
      export { ChannelState, DEFAULT_CHANNEL_CONFIG } from './src/lightning/channel/types';
      export { serializeChannelState, deserializeChannelState } from './src/lightning/storage/serialization';
      export { getPublicKey } from './src/lightning/crypto/ecdh';
      export { BeignetNode } from './src/cli/beignet-node';`,
    resolveDir: require('node:path').join(__dirname, '..'), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', source)(mod, mod.exports, name =>
  name === 'better-sqlite3' ? class UnusedDatabase {} : require(name));
const {
  DirectFundingRequestStore, DirectFundingReceiver, DF_REQUESTS_STORAGE_KEY,
  DF_RECEIVED_STORAGE_KEY, DF_RECEIVED_RETENTION_MS, DF_MAX_RECEIVED_RECORDS,
  Channel, ChannelState, DEFAULT_CHANNEL_CONFIG, createOpenerState,
  serializeChannelState, deserializeChannelState, getPublicKey, BeignetNode,
} = mod.exports;

const OFFER = '11'.repeat(16);
const FUNDING = '22'.repeat(32);
const CHANNEL = '33'.repeat(32);
function fixture(rows = new Map(), clock = { now: 1700000000000 }) {
  const f = { rows, clock, failReceived: false };
  f.store = new DirectFundingRequestStore({
    now: () => clock.now,
    storage: {
      loadWalletData: key => rows.get(key) ?? null,
      saveWalletData(key, value) {
        if (f.failReceived && key === DF_RECEIVED_STORAGE_KEY) throw Error('disk unavailable');
        rows.set(key, value);
      },
    },
  }, { requestTtlMs: 1000 });
  return f;
}
function bind(f, record, amount = '15000') {
  assert.equal(f.store.beginAttempt(record.receiptHash, OFFER, f.clock.now + 1000), true);
  assert.equal(f.store.markAttemptFunding(record.receiptHash, OFFER, {
    outpoint: '44'.repeat(32) + ':1', channelId: CHANNEL, splice: true,
    contentHash: '55'.repeat(32), payerEphemeralKey: getPublicKey(Buffer.alloc(32, 6)).toString('hex'),
    fundingTxid: FUNDING, amountSat: amount,
  }, f.clock.now + 1000), true);
}
function pay(f, record, amount = '15000') {
  bind(f, record, amount);
  f.store.markReceiptRevealed(record.receiptHash, {
    offerIdHex: OFFER, fundingTxidHex: FUNDING, amountSat: amount,
  });
  return f.store.receivedFor(record.receiptHash);
}

test('a signed funding records exact amount and identity without exposing request secrets', () => {
  const f = fixture(), record = f.store.mint();
  bind(f, record);
  assert.deepEqual(f.store.received(), [], 'Negotiation alone cannot report receipt');
  f.store.markReceiptRevealed(record.receiptHash, { offerIdHex: OFFER, fundingTxidHex: FUNDING });
  const receipt = f.store.receivedFor(record.receiptHash);
  assert.deepEqual(receipt, {
    receiptHash: record.receiptHash, requestId: record.requestId, offerId: OFFER,
    fundingTxid: FUNDING, channelId: CHANNEL, splice: true, amountSat: '15000',
    status: 'PAID', paidAt: f.clock.now, updatedAt: f.clock.now,
  });
  for (const secret of [record.preimageHex, record.encryptionPrivateKeyHex, record.onionPathSecretHex]) {
    assert.equal(JSON.stringify(receipt).includes(secret), false);
  }
  receipt.amountSat = '1';
  assert.equal(f.store.receivedFor(record.receiptHash).amountSat, '15000');
  const api = Object.create(BeignetNode.prototype);
  api.node = { getDirectFundingRequests: () => f.store };
  assert.equal(api.listDirectFundingReceived()[0].amountSat, '15000');
});

test('receiver receipt and lock survive request expiry and restart without duplicate credit', () => {
  const f = fixture(), record = f.store.mint({ amountSat: 15000n });
  pay(f, record);
  assert.equal(f.store.markReceivedLocked(FUNDING), true);
  const receipt = f.store.receivedFor(record.receiptHash);
  f.clock.now += 2000;
  assert.equal(f.store.sweep(), 1);
  assert.equal(f.store.byRequestId(record.requestId), null);
  const restarted = fixture(f.rows, f.clock);
  assert.equal(restarted.store.restore(), 0);
  assert.deepEqual(restarted.store.received(), [receipt]);
  assert.equal(restarted.store.markReceivedLocked(FUNDING), false);
  assert.equal(restarted.store.markReceivedLocked('66'.repeat(32)), false);
  assert.deepEqual(restarted.store.received(), [receipt]);
});

test('a failed archive write retains its tombstone until a durable retry or restart backfill', () => {
  const f = fixture(), record = f.store.mint();
  bind(f, record);
  f.failReceived = true;
  assert.throws(() => f.store.markReceiptRevealed(record.receiptHash, {
    offerIdHex: OFFER, fundingTxidHex: FUNDING, amountSat: '17000',
  }));
  f.clock.now += 2000;
  assert.equal(f.store.sweep(), 0);
  assert.equal(JSON.parse(f.rows.get(DF_REQUESTS_STORAGE_KEY)).length, 1);
  const restarted = fixture(f.rows, f.clock);
  restarted.store.restore();
  const received = restarted.store.received();
  assert.equal(received.length, 1);
  assert.equal(received[0].amountSat, '17000');
  assert.equal(received[0].channelId, CHANNEL);
  assert.deepEqual(JSON.parse(f.rows.get(DF_RECEIVED_STORAGE_KEY)), received);
});

test('a proven conflict remains reverted across restart even when the receipt had locked', () => {
  const f = fixture(), record = f.store.mint();
  pay(f, record);
  f.store.markReceivedLocked(FUNDING);
  const lockedAt = f.store.receivedFor(record.receiptHash).lockedAt;
  f.clock.now++;
  assert.equal(f.store.markReceivedReverted(FUNDING), 1);
  assert.equal(f.store.markReceivedLocked(FUNDING), false);
  const restarted = fixture(f.rows, f.clock);
  restarted.store.restore();
  assert.equal(restarted.store.receivedFor(record.receiptHash).status, 'REVERTED');
  assert.equal(restarted.store.receivedFor(record.receiptHash).lockedAt, lockedAt);
  assert.equal(restarted.store.markReceivedReverted(FUNDING), 0);
});

test('receiver startup recovers a lock event missed before receipt tracking or restart', () => {
  const f = fixture(), record = f.store.mint();
  pay(f, record);
  let hasLock = false;
  const receiver = new DirectFundingReceiver({
    requests: f.store, now: () => f.clock.now,
    hasLockedFunding: (channel, txid) => hasLock && channel === CHANNEL && txid === FUNDING,
    onTxSigsNeeded: () => () => {}, onSpliceTxSigsNeeded: () => () => {},
  });
  receiver.start();
  assert.equal(f.store.receivedFor(record.receiptHash).lockedAt, undefined);
  receiver.stop();
  hasLock = true;
  receiver.start();
  receiver.stop();
  assert.equal(f.store.receivedFor(record.receiptHash).lockedAt, f.clock.now);
});

test('received archive is bounded and rejects malformed restored values', () => {
  const f = fixture(), record = f.store.mint();
  const receipt = pay(f, record);
  f.rows.delete(DF_REQUESTS_STORAGE_KEY);
  f.rows.set(DF_RECEIVED_STORAGE_KEY, JSON.stringify([
    receipt, { ...receipt, receiptHash: '77'.repeat(32), lockedAt: '1' },
    { ...receipt, receiptHash: '88'.repeat(32), amountSat: '-1' },
  ]));
  const restarted = fixture(f.rows, f.clock);
  restarted.store.restore();
  assert.deepEqual(restarted.store.received(), [receipt]);
  f.rows.set(DF_RECEIVED_STORAGE_KEY, JSON.stringify(Array.from({ length: DF_MAX_RECEIVED_RECORDS }, (_, i) => ({
    ...receipt, receiptHash: i.toString(16).padStart(64, '0'), paidAt: f.clock.now - 512 + i,
    updatedAt: f.clock.now - 512 + i,
  }))));
  restarted.store.restore();
  const next = restarted.store.mint();
  pay(restarted, next);
  assert.equal(restarted.store.received().length, DF_MAX_RECEIVED_RECORDS);
  assert.equal(restarted.store.receivedFor('0'.repeat(64)), null);
  f.clock.now += DF_RECEIVED_RETENTION_MS + 1;
  restarted.store.sweep();
  assert.deepEqual(restarted.store.received(), []);
});

function channelFixture(overrides) {
  const pubkey = getPublicKey(Buffer.alloc(32, 7));
  const state = createOpenerState({
    temporaryChannelId: Buffer.alloc(32, 8), fundingSatoshis: 50000n, pushMsat: 0n,
    localConfig: { ...DEFAULT_CHANNEL_CONFIG }, localPerCommitmentSeed: Buffer.alloc(32, 9),
    localBasepoints: Object.fromEntries(['fundingPubkey', 'revocationBasepoint', 'paymentBasepoint',
      'delayedPaymentBasepoint', 'htlcBasepoint', 'firstPerCommitmentPoint'].map(key => [key, pubkey])),
  });
  Object.assign(state, { fundingTxid: Buffer.from(FUNDING, 'hex').reverse(), ...overrides });
  return new Channel(state);
}

test('durable funding locks survive serialization and close without inventing an unready lock', () => {
  for (const state of [ChannelState.AWAITING_FUNDING_CONFIRMED, ChannelState.AWAITING_CHANNEL_READY, ChannelState.CLOSED]) {
    const channel = channelFixture({ state, localChannelReady: false, remoteChannelReady: false });
    assert.equal(channel.backfillLockedFundingTxids(), false);
    assert.equal(channel.hasLockedFunding(FUNDING), false);
  }
  const channel = channelFixture({
    state: ChannelState.AWAITING_REESTABLISH, preReestablishState: ChannelState.NORMAL,
    localChannelReady: true, remoteChannelReady: true,
  });
  assert.equal(channel.backfillLockedFundingTxids(), true);
  assert.equal(channel.backfillLockedFundingTxids(), false);
  const state = deserializeChannelState(serializeChannelState(channel.getFullState()));
  state.state = ChannelState.CLOSED;
  const restored = new Channel(state);
  assert.equal(restored.hasLockedFunding(FUNDING), true);
  assert.equal(restored.hasLockedFunding('99'.repeat(32)), false);
  assert.equal(restored.getFullState().lockedFundingTxids.length, 1);
});
