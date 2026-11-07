'use strict';

/**
 * The stored ranked-primaries list against the engine's (coreyphillips/beignet#1924).
 *
 * The engine owns the list, its order and the fill threshold; the wallet
 * record keeps a mirror of it with the facts the engine does not hold (trust,
 * setup state, an onion fallback for an Iroh primary). These pure helpers
 * translate one shape into the other and plan the engine writes that make
 * its list equal the record's, so the runtime can seed an empty engine from a
 * migrated or edited record and otherwise take the engine's list as read.
 */
const { parsePrimaryUri } = require('./primary-uri.cjs');

/**
 * The engine's add body for a stored entry: host and port for a TCP or onion
 * address (the engine reads those back as the relay address it signs into
 * direct-funding requests), the canonical URI for an Iroh one.
 */
function entryToEngine(entry, rank) {
	const parsed = parsePrimaryUri(entry.uri);
	const body = parsed.transport
		? { pubkey: parsed.pubkey, uri: parsed.uri }
		: { pubkey: parsed.pubkey, host: parsed.host, port: parsed.port };
	return rank === undefined ? body : { ...body, rank };
}

/**
 * A stored entry from the engine's row, carrying over the metadata the prior
 * entry for the same node held. A changed address drops the onion fallback,
 * which named the old one. An address this fork cannot read (the engine
 * accepts peer URI forms the phone has no transport for) is kept as the
 * engine gave it and marked failed, so the list still shows the node.
 */
function engineToEntry(info, prior) {
	const raw =
		info.uri ??
		(info.host && info.port ? `${info.pubkey}@${info.host}:${info.port}` : null);
	let uri = raw;
	let unsupported = null;
	if (raw === null) unsupported = 'The engine holds no address for this primary node';
	else {
		try {
			uri = parsePrimaryUri(raw).uri;
		} catch (err) {
			unsupported = `Unsupported primary address: ${err.message}`;
		}
	}
	const carry = prior && prior.pubkey === info.pubkey ? prior : null;
	const sameAddress = !!carry && carry.uri === uri;
	return {
		pubkey: info.pubkey,
		uri,
		fallbackUri: sameAddress ? carry.fallbackUri : undefined,
		trusted: carry ? carry.trusted !== false : true,
		initialChannelOpened: carry ? !!carry.initialChannelOpened : false,
		setup: unsupported ? 'failed' : carry ? carry.setup || 'pending' : 'pending',
		setupError: unsupported ?? (carry ? carry.setupError || null : null),
		setupAt: carry ? carry.setupAt || null : null
	};
}

/** The engine's whole list as stored entries, in rank order. */
function engineToEntries(info, prior) {
	const by = new Map((prior || []).map((e) => [e.pubkey, e]));
	return rankOrder(info).map((row) => engineToEntry(row, by.get(row.pubkey)));
}

function rankOrder(info) {
	return ((info && info.primaries) || [])
		.slice()
		.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
}

/** Whether the engine's row reaches the node at the address the entry names. */
function sameAddress(row, entry) {
	let expected;
	try {
		expected = entryToEngine(entry);
	} catch {
		// An address this fork cannot read is left where the engine has it.
		return true;
	}
	if (expected.uri !== undefined) return row.uri === expected.uri;
	return (
		(row.uri ?? null) === null &&
		row.host === expected.host &&
		row.port === expected.port
	);
}

/**
 * The engine writes, in order, that make its list equal `entries` at
 * `thresholdSat`: the removes (a node whose address moved is removed and
 * added again, since the engine changes no address in place), the adds
 * (appended; the engine ranks a new entry last), one reorder when the order
 * then differs, and the threshold when it differs. Empty when the engine
 * already agrees.
 */
function planPrimariesSync(info, entries, thresholdSat) {
	const rows = rankOrder(info);
	const byPubkey = new Map(rows.map((row) => [row.pubkey, row]));
	const want = (entries || []).map((e) => e.pubkey);
	const have = rows.map((p) => p.pubkey);
	const moved = new Set(
		(entries || [])
			.filter((e) => byPubkey.has(e.pubkey) && !sameAddress(byPubkey.get(e.pubkey), e))
			.map((e) => e.pubkey)
	);
	const ops = [];
	for (const pubkey of have)
		if (!want.includes(pubkey) || moved.has(pubkey))
			ops.push({ op: 'remove', pubkey });
	const added = [];
	for (const entry of entries || [])
		if (!have.includes(entry.pubkey) || moved.has(entry.pubkey)) {
			ops.push({ op: 'add', entry });
			added.push(entry.pubkey);
		}
	const after = [
		...have.filter((pubkey) => want.includes(pubkey) && !moved.has(pubkey)),
		...added
	];
	if (want.length > 1 && after.join(',') !== want.join(','))
		ops.push({ op: 'reorder', order: want });
	const threshold =
		Number.isSafeInteger(thresholdSat) && thresholdSat >= 0 ? thresholdSat : null;
	if (((info && info.fillThresholdSat) ?? null) !== threshold)
		ops.push({ op: 'threshold', fillThresholdSat: threshold });
	return ops;
}

/** Whether any entry names an Iroh primary; an unreadable address counts as not. */
function anyIroh(entries) {
	return (entries || []).some((e) => {
		try {
			return parsePrimaryUri(e.uri).transport?.type === 'iroh';
		} catch {
			return false;
		}
	});
}

module.exports = {
	entryToEngine,
	engineToEntry,
	engineToEntries,
	planPrimariesSync,
	anyIroh
};
