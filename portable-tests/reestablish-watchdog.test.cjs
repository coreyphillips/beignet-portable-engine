const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { awaitingReestablishment, watchReestablishment } = require('../portable/reestablish-watchdog.cjs');

function fixture() {
  const node = new EventEmitter(); let serial = 0; const timers = new Map();
  const state = { channels: [], connected: true, closed: false, held: false, redials: 0, probes: 0 };
  node.listChannels = () => state.channels;
  const pendingTimers = new Set();
  const stop = watchReestablishment({ node, primaryPubkey: () => 'primary', peerKey: peer => peer,
    primaryConnected: () => state.connected, isClosed: () => state.closed, recoveryHold: () => state.held,
    onConnect: () => state.probes++, redial: () => state.redials++, pendingTimers,
    schedule: fn => { const id = ++serial; timers.set(id, fn); return id; }, cancel: id => timers.delete(id) });
  const fire = async () => { const jobs = [...timers.values()]; timers.clear(); for (const job of jobs) job(); await Promise.resolve(); };
  return { node, state, timers, pendingTimers, stop, fire };
}

test('a healthy channel never redials for quiescence, splice, offline custody or a funding wait', async () => {
  for (const state of ['NORMAL','SPLICING','AWAITING_FUNDING_LOCKED','SHUTTING_DOWN','CLOSED','FORCE_CLOSED']) {
    const f = fixture();
    f.state.channels = [{peerPubkey:'primary',state,htlcUsable:false,restoreRecencyUnproven:true}];
    f.node.emit('peer:connect','primary'); await f.fire();
    assert.equal(f.state.redials,0,state); assert.equal(f.state.probes,1); assert.equal(f.pendingTimers.size,0);
    f.stop();
  }
});

test('an actual incomplete reestablishment redials at most three times and resets after success', async () => {
  const f = fixture(); f.state.channels = [{peerPubkey:'primary',state:'AWAITING_REESTABLISH',htlcUsable:false}];
  for (let i=0;i<5;i++) { f.node.emit('peer:connect','primary'); await f.fire(); }
  assert.equal(f.state.redials,3);
  f.state.channels[0].state='NORMAL'; f.node.emit('peer:connect','primary'); await f.fire();
  f.state.channels[0].state='AWAITING_REESTABLISH'; f.node.emit('peer:connect','primary'); await f.fire();
  assert.equal(f.state.redials,4); f.stop();
});

test('a stale connection callback cannot tear down a newer connection', async () => {
  const f = fixture(); f.state.channels = [{peerPubkey:'primary',state:'AWAITING_REESTABLISH'}];
  f.node.emit('peer:connect','primary'); const old = [...f.timers.values()][0];
  f.node.emit('peer:disconnect','primary'); f.node.emit('peer:connect','primary');
  old(); await Promise.resolve(); assert.equal(f.state.redials,0); assert.equal(f.pendingTimers.size,1);
  await f.fire(); assert.equal(f.state.redials,1); f.stop();
});

test('disconnected, closed, recovery-held and unrelated peers cannot trigger a redial', async () => {
  for (const key of ['connected','closed','held']) {
    const f = fixture(); f.state.channels=[{peerPubkey:'primary',state:'AWAITING_REESTABLISH'}];
    f.state[key] = key !== 'connected';
    f.node.emit('peer:connect','primary'); await f.fire(); assert.equal(f.state.redials,0); f.stop();
  }
  const f = fixture(); f.node.emit('peer:connect','other'); assert.equal(f.pendingTimers.size,0);
  assert.equal(awaitingReestablishment([{peerPubkey:'other',state:'AWAITING_REESTABLISH'}],'primary'),false);
  f.node.emit('peer:connect','primary'); f.stop(); assert.equal(f.pendingTimers.size,0);
  assert.equal(f.node.listenerCount('peer:connect'),0);
});
