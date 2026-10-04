const { test } = require('node:test');
const assert = require('node:assert/strict');
const { closeNotStarted } = require('../portable/drain-close-state.cjs');
const channelId = 'ab'.repeat(32);
const state = () => ({ channelId: Buffer.from(channelId, 'hex'), fundingTxid: Buffer.alloc(32, 3), fundingOutputIndex: 0, state: 'NORMAL' });

test('both live and saved normal states must prove shutdown never started', () => {
	assert.equal(closeNotStarted({ channelId, live: state(), saved: state() }), true);
	for (const changed of [
		{ externalClose: { scriptHex: '0014' } },
		{ localShutdownScript: Buffer.alloc(1) },
		{ remoteShutdownScript: Buffer.alloc(1) },
		{ lastCooperativeCloseTxHex: '01' },
		{ state: 'SHUTTING_DOWN' },
		{ state: 'AWAITING_REESTABLISH', preReestablishState: 'SHUTTING_DOWN' },
		{ restoreRecencyUnproven: true },
		{ reestablishRecencyUnproven: true },
		{ reestablishSecretMissing: true },
		{ fundingTxid: Buffer.alloc(32, 4) },
		{ fundingOutputIndex: 1 }
	]) {
		for (const side of ['live', 'saved']) {
			const fixture = { channelId, live: state(), saved: state() };
			Object.assign(fixture[side], changed);
			assert.equal(closeNotStarted(fixture), false);
		}
	}
	assert.equal(closeNotStarted({ channelId, live: state() }), false);
	assert.equal(closeNotStarted({ channelId, live: state(), saved: state(), held: true }), false);
	assert.equal(closeNotStarted({ channelId, live: state(), saved: state(), monitor: { commitmentBroadcast: {} } }), false);
});

test('reestablishment from normal remains cancellable only without any durable close marker', () => {
	const live = { ...state(), state: 'AWAITING_REESTABLISH', preReestablishState: 'NORMAL' };
	assert.equal(closeNotStarted({ channelId, live, saved: state() }), true);
	live.localShutdownScript = Buffer.alloc(1);
	assert.equal(closeNotStarted({ channelId, live, saved: state() }), false);
});
