const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../portable/lfbw.cjs');
const {
	entryToEngine,
	engineToEntry,
	engineToEntries,
	planPrimariesSync,
	anyIroh
} = require('../portable/primaries-record.cjs');

const A = '02' + 'aa'.repeat(32);
const B = '03' + 'bb'.repeat(32);
const C = '02' + 'cc'.repeat(32);
const uriA = `${A}@a.example:9735`;
const uriB = `${B}@b.example:9736`;
const irohC = `${C}@iroh:${'c'.repeat(64)}`;
const onionC = `${C}@${'c'.repeat(56)}.onion:9735`;
const opts = { available: true, network: 'regtest' };
const engine = (rows, fillThresholdSat = null) => ({
	fillThresholdSat,
	primaries: rows.map((row, i) => ({ rank: i + 1, host: null, port: null, uri: null, ...row })),
	receiveTarget: rows[0]?.pubkey ?? null
});

test('a legacy one-primary input becomes a one-entry list whose mirrors are the old scalar fields, byte for byte', () => {
	const lf = rules.normalizeLfbw({ enabled: true, primaryUri: uriA, trusted: false }, opts);
	assert.equal(lf.primaries.length, 1);
	const [entry] = lf.primaries;
	assert.deepEqual(entry, {
		pubkey: A, uri: uriA, fallbackUri: undefined, trusted: false,
		initialChannelOpened: false, setup: 'pending', setupError: null, setupAt: null
	});
	assert.equal(lf.primaryUri, uriA);
	assert.equal(lf.primaryPubkey, A);
	assert.equal(lf.trusted, false);
	assert.equal(lf.setup, 'pending');
	assert.equal(lf.setupError, null);
	assert.equal(lf.setupAt, null);
	assert.equal(lf.initialChannelOpened, false);
	assert.equal(lf.initialChannelSats, 0);
	assert.equal(lf.primariesThresholdSat, null);
	assert.equal('previousPrimary' in lf, false);
	assert.equal('primaryFallbackUri' in lf, true);
	assert.equal(lf.primaryFallbackUri, undefined);
});

test('a list input ranks every entry, keeps per-entry state for an unchanged address and refuses duplicates and the cap', () => {
	const first = rules.normalizeLfbw(
		{ enabled: true, primaries: [{ uri: uriA }, { uri: uriB, trusted: false }], primariesThresholdSat: 250000 },
		opts
	);
	assert.deepEqual(first.primaries.map((e) => [e.pubkey, e.trusted]), [[A, true], [B, false]]);
	assert.equal(first.primariesThresholdSat, 250000);
	assert.equal(first.primaryPubkey, A);
	first.primaries[1].setup = 'ready';
	first.primaries[1].setupAt = 7;
	first.primaries[1].initialChannelOpened = true;
	const reordered = rules.normalizeLfbw(
		{ enabled: true, primaries: [{ uri: uriB }, { uri: uriA }] },
		{ ...opts, existing: first }
	);
	assert.deepEqual(reordered.primaries.map((e) => e.pubkey), [B, A]);
	assert.equal(reordered.primaries[0].setup, 'ready');
	assert.equal(reordered.primaries[0].setupAt, 7);
	assert.equal(reordered.primaries[0].initialChannelOpened, true);
	assert.equal(reordered.primaries[0].trusted, true, 'an unnamed trust is the default, not the old entry\'s');
	assert.equal(reordered.primariesThresholdSat, 250000, 'an unnamed threshold keeps the existing one');
	assert.equal(reordered.primaryPubkey, B);
	const moved = rules.normalizeLfbw(
		{ enabled: true, primaries: [{ uri: `${B}@elsewhere.example:1` }] },
		{ ...opts, existing: first }
	);
	assert.equal(moved.primaries[0].setup, 'pending', 'a changed address starts over');
	assert.throws(
		() => rules.normalizeLfbw({ enabled: true, primaries: [{ uri: uriA }, { uri: uriA }] }, opts),
		(e) => e.code === 'BAD_LFBW_PEER' && /twice/.test(e.message)
	);
	assert.throws(
		() => rules.normalizeLfbw({ enabled: true, primaries: Array.from({ length: 33 }, (_, i) => ({ uri: `${'02' + i.toString(16).padStart(2, '0').repeat(32)}@h:1` })) }, opts),
		(e) => e.code === 'BAD_LFBW_PEER' && /32/.test(e.message)
	);
	assert.throws(
		() => rules.normalizeLfbw({ enabled: true, primaryUri: uriA, primariesThresholdSat: 1.5 }, opts),
		(e) => e.code === 'INVALID_PARAMS'
	);
	assert.equal(rules.normalizeLfbw({ enabled: true, primaryUri: uriA, primariesThresholdSat: null }, opts).primariesThresholdSat, null);
});

test('an Iroh entry keeps its same-key onion fallback across a re-normalize and drops it when the address changes', () => {
	const lf = rules.normalizeLfbw({ enabled: true, primaries: [{ uri: irohC, fallbackUri: onionC }, { uri: uriA }] }, opts);
	assert.equal(lf.primaries[0].fallbackUri, onionC);
	assert.equal(lf.primaryFallbackUri, onionC);
	const again = rules.normalizeLfbw({ enabled: true, primaries: [{ uri: irohC }, { uri: uriA }] }, { ...opts, existing: lf });
	assert.equal(again.primaries[0].fallbackUri, onionC, 'an unnamed fallback is carried for the same address');
	const cleared = rules.normalizeLfbw({ enabled: true, primaries: [{ uri: irohC, fallbackUri: null }] }, { ...opts, existing: lf });
	assert.equal(cleared.primaries[0].fallbackUri, undefined);
	assert.throws(() => rules.normalizeLfbw({ enabled: true, primaries: [{ uri: uriA, fallbackUri: onionC }] }, opts), (e) => e.code === 'BAD_LFBW_PEER');
	assert.equal(anyIroh(lf.primaries), true);
	assert.equal(anyIroh([{ uri: uriA }, { uri: 'garbage' }]), false);
});

test('normalizing is idempotent: a normalized block normalized again is deep-equal', () => {
	const lf = rules.normalizeLfbw({ enabled: true, primaries: [{ uri: uriA }, { uri: irohC, fallbackUri: onionC, trusted: false }], primariesThresholdSat: 1000 }, opts);
	const again = rules.normalizeLfbw({ enabled: true, primaries: lf.primaries, primariesThresholdSat: lf.primariesThresholdSat }, { ...opts, existing: lf });
	assert.deepEqual(again, lf);
});

test('a stored block from before the list migrates to one entry with identical mirrors, drops the stored previous primary, and is lenient about an unreadable scalar', () => {
	const legacy = {
		enabled: true, mode: 'external', primaryWalletId: null, primaryUri: uriA, primaryPubkey: A,
		trusted: true, initialChannelSats: 0, initialChannelOpened: true, setup: 'failed',
		setupError: 'dial failed', setupAt: 123, previousPrimary: { pubkey: B, walletId: null, at: 1 }
	};
	const migrated = rules.migrateLfbw(legacy);
	assert.deepEqual(migrated.primaries, [{
		pubkey: A, uri: uriA, fallbackUri: undefined, trusted: true,
		initialChannelOpened: true, setup: 'failed', setupError: 'dial failed', setupAt: 123
	}]);
	for (const key of ['primaryUri', 'primaryPubkey', 'trusted', 'initialChannelOpened', 'setup', 'setupError', 'setupAt', 'mode', 'enabled'])
		assert.equal(migrated[key], legacy[key], key);
	assert.equal('previousPrimary' in migrated, false);
	assert.equal(migrated.primariesThresholdSat, null);
	assert.equal(rules.migrateLfbw(migrated), migrated, 'idempotent: an already migrated block is returned as is');
	assert.deepEqual(rules.migrateLfbw({ enabled: true }), { enabled: true, primaries: [], primariesThresholdSat: null });
	const stopped = rules.migrateLfbw({ enabled: true, mode: 'external', primaryPubkey: A, setup: 'ready' });
	assert.deepEqual(stopped.primaries, []);
	assert.equal(stopped.primaryPubkey, A, 'an unreadable scalar is left as it was');
	assert.equal(rules.migrateLfbw(null), null);
	assert.deepEqual(rules.existingPrimaries(legacy).map((e) => e.pubkey), [A]);
	assert.deepEqual(rules.existingPrimaries(undefined), []);
});

test('the setup aggregate is ready when any entry is, failed when all are, pending otherwise, and one entry\'s own fields', () => {
	const ready = { setup: 'ready', setupError: null, setupAt: 5 };
	const failed = { setup: 'failed', setupError: 'down', setupAt: null };
	const pending = { setup: 'pending', setupError: null, setupAt: null };
	assert.deepEqual(rules.aggregateSetup([failed]), { setup: 'failed', setupError: 'down', setupAt: null });
	assert.deepEqual(rules.aggregateSetup([]), { setup: 'pending', setupError: null, setupAt: null });
	assert.deepEqual(rules.aggregateSetup([failed, ready]), { setup: 'ready', setupError: 'down', setupAt: 5 });
	assert.deepEqual(rules.aggregateSetup([ready, { ...failed }]), { setup: 'ready', setupError: 'down', setupAt: 5 });
	assert.deepEqual(rules.aggregateSetup([failed, { ...failed, setupError: 'also down' }]), { setup: 'failed', setupError: 'down', setupAt: null });
	assert.deepEqual(rules.aggregateSetup([pending, failed]), { setup: 'pending', setupError: 'down', setupAt: null });
	const mirror = rules.primariesMirror([{ pubkey: B, uri: uriB, fallbackUri: undefined, trusted: false, initialChannelOpened: true, ...ready }, { pubkey: A, uri: uriA, trusted: true, ...failed }]);
	assert.deepEqual(mirror, { primaryUri: uriB, primaryFallbackUri: undefined, primaryPubkey: B, trusted: false, initialChannelOpened: true, setup: 'ready', setupError: 'down', setupAt: 5 });
	assert.deepEqual(rules.primariesMirror([]), { primaryUri: null, primaryFallbackUri: undefined, primaryPubkey: null, trusted: true, initialChannelOpened: false, setup: 'pending', setupError: null, setupAt: null });
});

test('retained peers are the live channels at nodes no longer ranked, largest balance first, and the derived previous primary is the first of them', () => {
	const entries = [{ pubkey: A }, { pubkey: B }];
	const channels = [
		{ peerPubkey: A, state: 'NORMAL', localBalanceSats: 500 },
		{ peerPubkey: C, state: 'NORMAL', localBalanceSats: 300 },
		{ peerPubkey: C, state: 'AWAITING_REESTABLISH', localBalanceSats: 200 },
		{ peerPubkey: C, state: 'CLOSED', localBalanceSats: 9000 },
		{ peerPubkey: '02' + 'dd'.repeat(32), state: 'NORMAL', localBalanceSats: 700 },
		{ peerPubkey: '02' + 'ee'.repeat(32), state: 'FORCE_CLOSED', localBalanceSats: 1 }
	];
	const retained = rules.retainedPeers(entries, channels);
	assert.deepEqual(retained, [
		{ pubkey: '02' + 'dd'.repeat(32), channelCount: 1, balanceSat: 700 },
		{ pubkey: C, channelCount: 2, balanceSat: 500 }
	]);
	assert.deepEqual(rules.derivedPreviousPrimary(retained), { pubkey: '02' + 'dd'.repeat(32), walletId: null, at: null });
	assert.equal(rules.derivedPreviousPrimary([]), null);
	assert.deepEqual(rules.retainedPeers([], []), []);
});

test('an entry becomes the engine\'s host and port body, or its URI for Iroh, and comes back carrying its metadata', () => {
	assert.deepEqual(entryToEngine({ uri: uriA }), { pubkey: A, host: 'a.example', port: 9735 });
	assert.deepEqual(entryToEngine({ uri: uriA }, 2), { pubkey: A, host: 'a.example', port: 9735, rank: 2 });
	assert.deepEqual(entryToEngine({ uri: irohC }), { pubkey: C, uri: irohC });
	assert.throws(() => entryToEngine({ uri: 'garbage' }));
	const prior = { pubkey: A, uri: uriA, fallbackUri: undefined, trusted: false, initialChannelOpened: true, setup: 'ready', setupError: null, setupAt: 9 };
	assert.deepEqual(engineToEntry({ pubkey: A, host: 'a.example', port: 9735, uri: null }, prior), prior);
	const moved = engineToEntry({ pubkey: A, host: 'moved.example', port: 1, uri: null }, { ...prior, uri: irohC, fallbackUri: onionC });
	assert.equal(moved.uri, `${A}@moved.example:1`);
	assert.equal(moved.fallbackUri, undefined, 'a changed address drops the fallback that named the old one');
	assert.equal(moved.trusted, false);
	assert.equal(moved.setup, 'ready');
	const fresh = engineToEntry({ pubkey: B, host: 'b.example', port: 9736, uri: null }, undefined);
	assert.deepEqual(fresh, { pubkey: B, uri: uriB, fallbackUri: undefined, trusted: true, initialChannelOpened: false, setup: 'pending', setupError: null, setupAt: null });
	const unsupported = engineToEntry({ pubkey: B, host: null, port: null, uri: `${B}@ws://relay.example:1` }, undefined);
	assert.equal(unsupported.setup, 'failed');
	assert.match(unsupported.setupError, /Unsupported primary address/);
	assert.equal(unsupported.uri, `${B}@ws://relay.example:1`);
	const none = engineToEntry({ pubkey: B, host: null, port: null, uri: null }, undefined);
	assert.equal(none.setup, 'failed');
	assert.equal(none.uri, null);
	const list = engineToEntries(engine([{ pubkey: B, host: 'b.example', port: 9736, rank: 2 }, { pubkey: A, host: 'a.example', port: 9735, rank: 1 }]), [prior]);
	assert.deepEqual(list.map((e) => e.pubkey), [A, B], 'rank order, not row order');
	assert.equal(list[0].setupAt, 9);
});

test('the sync plan seeds an empty engine, removes, re-adds a moved address, reorders once and sets the threshold, and is empty when the engine agrees', () => {
	const entries = [{ pubkey: A, uri: uriA }, { pubkey: B, uri: uriB }];
	assert.deepEqual(planPrimariesSync(engine([]), entries, 1000), [
		{ op: 'add', entry: entries[0] },
		{ op: 'add', entry: entries[1] },
		{ op: 'threshold', fillThresholdSat: 1000 }
	]);
	const agreed = engine([{ pubkey: A, host: 'a.example', port: 9735 }, { pubkey: B, host: 'b.example', port: 9736 }], 1000);
	assert.deepEqual(planPrimariesSync(agreed, entries, 1000), []);
	assert.deepEqual(planPrimariesSync(agreed, [entries[1], entries[0]], 1000), [{ op: 'reorder', order: [B, A] }]);
	assert.deepEqual(planPrimariesSync(agreed, [entries[0]], null), [
		{ op: 'remove', pubkey: B },
		{ op: 'threshold', fillThresholdSat: null }
	]);
	const movedB = { pubkey: B, uri: `${B}@moved.example:2` };
	assert.deepEqual(planPrimariesSync(agreed, [movedB, entries[0]], 1000), [
		{ op: 'remove', pubkey: B },
		{ op: 'add', entry: movedB },
		{ op: 'reorder', order: [B, A] }
	]);
	// A crash after the first add left the engine with a prefix of the list.
	assert.deepEqual(planPrimariesSync(engine([{ pubkey: A, host: 'a.example', port: 9735 }]), entries, null), [{ op: 'add', entry: entries[1] }]);
	// An Iroh entry is compared by URI.
	const irohEntry = { pubkey: C, uri: irohC };
	assert.deepEqual(planPrimariesSync(engine([{ pubkey: C, uri: irohC }]), [irohEntry], null), []);
	assert.deepEqual(planPrimariesSync(engine([{ pubkey: C, uri: `${C}@iroh:${'d'.repeat(64)}` }]), [irohEntry], null), [
		{ op: 'remove', pubkey: C },
		{ op: 'add', entry: irohEntry }
	]);
	// An entry whose address cannot be read is left where the engine has it.
	assert.deepEqual(planPrimariesSync(engine([{ pubkey: A, host: 'a.example', port: 9735 }]), [{ pubkey: A, uri: 'garbage' }], null), []);
});
