const { test } = require('node:test');
const assert = require('node:assert/strict');
const { peerDiagnostic } = require('../portable/peer-diagnostics.cjs');

const PEER = '02' + 'ab'.repeat(32);

test('a disconnect names who closed it, why, which side dialled and how long it was up', () => {
	assert.deepEqual(
		peerDiagnostic('peer:disconnect', {
			pubkey: PEER,
			closedBy: 'peer',
			reason: 'read ECONNRESET',
			direction: 'outbound',
			uptimeMs: 41200.4
		}),
		{
			phase: 'peer:disconnect',
			message: `${PEER} closed by peer: read ECONNRESET (outbound, up 41200ms)`,
			code: undefined
		}
	);
	assert.equal(
		peerDiagnostic('peer:disconnect', {
			pubkey: PEER,
			closedBy: 'us',
			direction: 'inbound'
		}).message,
		`${PEER} closed by us (inbound)`
	);
	assert.equal(
		peerDiagnostic('peer:disconnect', { pubkey: PEER, closedBy: 'peer' })
			.message,
		`${PEER} closed by peer`
	);
});

test('a zero uptime is a figure; odd fields are left out and never throw', () => {
	assert.equal(
		peerDiagnostic('peer:disconnect', {
			pubkey: PEER,
			closedBy: 'peer',
			reason: '',
			direction: 'outbound',
			uptimeMs: 0
		}).message,
		`${PEER} closed by peer (outbound, up 0ms)`
	);
	for (const odd of [
		{ reason: 42, direction: 'sideways', uptimeMs: Number.NaN },
		{ reason: null, uptimeMs: -4 },
		{ uptimeMs: '1200' },
		{ uptimeMs: 10n }
	]) {
		assert.equal(
			peerDiagnostic('peer:disconnect', { pubkey: PEER, closedBy: 'us', ...odd })
				.message,
			`${PEER} closed by us`
		);
	}
	// No pubkey: the cause alone, without a leading space.
	assert.equal(
		peerDiagnostic('peer:disconnect', { closedBy: 'peer' }).message,
		'closed by peer'
	);
	assert.equal(peerDiagnostic('peer:disconnect', null).message, 'peer:disconnect');
	assert.equal(peerDiagnostic('peer:disconnect', undefined).message, 'peer:disconnect');
});

test('a disconnect with no cause, as from an engine before 0.35.0, is the bare pubkey', () => {
	assert.equal(
		peerDiagnostic('peer:disconnect', { pubkey: PEER }).message,
		PEER
	);
	// Fields without closedBy are not a cause the engine named.
	assert.equal(
		peerDiagnostic('peer:disconnect', {
			pubkey: PEER,
			reason: 'read ECONNRESET'
		}).message,
		PEER
	);
});

test('connect, peer errors and node errors read as before', () => {
	// The client compares a connect message with its primary's pubkey.
	assert.deepEqual(peerDiagnostic('peer:connect', { pubkey: PEER }), {
		phase: 'peer:connect',
		message: PEER,
		code: undefined
	});
	assert.equal(
		peerDiagnostic('peer:error', { pubkey: PEER, message: 'Pong timeout' })
			.message,
		'Pong timeout'
	);
	assert.deepEqual(
		peerDiagnostic('node:error', {
			code: 'CHANNEL_OPEN_FAILED',
			message: 'Peer disconnected during channel open'
		}),
		{
			phase: 'node:error',
			message: 'Peer disconnected during channel open',
			code: 'CHANNEL_OPEN_FAILED'
		}
	);
	// The two-argument form names the error and a short peer id.
	assert.equal(
		peerDiagnostic('peer:error', PEER, new Error('Pong timeout')).message,
		`Pong timeout (peer ${PEER.slice(0, 16)})`
	);
	assert.equal(peerDiagnostic('peer:disconnect', PEER).message, PEER);
	assert.equal(peerDiagnostic('node:error', undefined).message, 'node:error');
});
