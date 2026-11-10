const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reestablishWatchdog } = require('../portable/reestablish-watchdog.cjs');

function fixture(t, states) {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const channels = states.map(state => ({ peerPubkey: 'primary', state }));
	const redials = [];
	const pendingTimers = new Set();
	const watchdog = reestablishWatchdog({
		node: { listChannels: () => channels },
		pendingTimers,
		canRedial: () => true,
		redial: peer => redials.push(peer)
	});
	return { channels, redials, pendingTimers, watchdog };
}

test('a primary can stay connected through funding, close or a successful reestablishment', t => {
	const { channels, redials, watchdog } = fixture(t, ['AWAITING_REESTABLISH', 'SHUTTING_DOWN']);
	watchdog.connected('primary');
	t.mock.timers.tick(4000);
	channels[0].state = 'AWAITING_FUNDING_CONFIRMED';
	t.mock.timers.tick(4000);
	assert.deepEqual(redials, []);
});

test('an unanswered reestablishment on the current connection retries at most three times', t => {
	const { redials, watchdog, pendingTimers } = fixture(t, ['AWAITING_REESTABLISH']);
	watchdog.connected('primary');
	t.mock.timers.tick(7000);
	watchdog.disconnected('primary');
	assert.equal(pendingTimers.size, 0);
	watchdog.connected('primary');
	t.mock.timers.tick(1000);
	assert.deepEqual(redials, []);
	t.mock.timers.tick(7000);
	for (let i = 0; i < 4; i++) {
		watchdog.connected('primary');
		t.mock.timers.tick(8000);
	}
	assert.deepEqual(redials, ['primary', 'primary', 'primary']);
	assert.equal(pendingTimers.size, 0);
});

test('a usable sibling channel or a reestablished channel in FFOR keeps its live connection', t => {
	const { channels, redials, watchdog } = fixture(t, ['NORMAL', 'AWAITING_REESTABLISH']);
	watchdog.connected('primary');
	t.mock.timers.tick(8000);
	channels[0].htlcUsable = false;
	channels[1].state = 'SPLICING';
	watchdog.connected('primary');
	t.mock.timers.tick(8000);
	assert.deepEqual(redials, []);
});

test('a suspended reestablishment gets a new foreground deadline for its buffered reply', t => {
	const { channels, redials, watchdog, pendingTimers } = fixture(t, ['AWAITING_REESTABLISH']);
	watchdog.connected('primary');
	t.mock.timers.tick(7000);
	watchdog.setAppBackgrounded(true);
	assert.equal(pendingTimers.size, 0);
	t.mock.timers.tick(600000);
	watchdog.setAppBackgrounded(false);
	t.mock.timers.tick(7999);
	assert.deepEqual(redials, []);
	channels[0].state = 'NORMAL';
	t.mock.timers.tick(1);
	assert.deepEqual(redials, []);
	assert.equal(pendingTimers.size, 0);
});

test('only connections still awaiting a check on return are armed, and a close cancels them', t => {
	const { redials, watchdog, pendingTimers } = fixture(t, ['AWAITING_REESTABLISH']);
	watchdog.setAppBackgrounded(true);
	watchdog.connected('old');
	watchdog.disconnected('old');
	watchdog.connected('primary');
	t.mock.timers.tick(600000);
	assert.equal(pendingTimers.size, 0);
	watchdog.setAppBackgrounded(false);
	assert.equal(pendingTimers.size, 1);
	t.mock.timers.tick(7999);
	watchdog.setAppBackgrounded(false);
	t.mock.timers.tick(1);
	assert.deepEqual(redials, ['primary']);
	watchdog.connected('primary');
	watchdog.setAppBackgrounded(true);
	watchdog.close();
	watchdog.setAppBackgrounded(false);
	watchdog.connected('primary');
	assert.equal(pendingTimers.size, 0);
});
