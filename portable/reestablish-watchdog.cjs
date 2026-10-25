'use strict';

// HTLC admission is independent of reestablishment. In particular, a valid
// splice or offline activation may temporarily refuse adds after reconnect.
function awaitingReestablishment(channels, primary) {
  return channels.some(channel => channel.peerPubkey === primary &&
    channel.state === 'AWAITING_REESTABLISH');
}

function watchReestablishment({ node, primaryPubkey, peerKey, primaryConnected,
  recoveryHold, isClosed, onConnect, redial, onDiagnostic, pendingTimers,
  schedule = setTimeout, cancel = clearTimeout, timeoutMs = 8000, maxRedials = 3 }) {
  let generation = 0;
  let pending;
  let redials = 0;
  const clear = () => {
    generation++;
    if (pending !== undefined) {
      cancel(pending); pendingTimers.delete(pending); pending = undefined;
    }
  };
  const connected = peer => {
    const primary = primaryPubkey();
    if (peerKey(peer) !== primary) return;
    clear();
    const current = generation;
    onConnect?.();
    if (current !== generation || isClosed()) return;
    const timer = schedule(() => {
      pendingTimers.delete(timer);
      if (pending === timer) pending = undefined;
      if (current !== generation || primary !== primaryPubkey() || isClosed() || recoveryHold() || !primaryConnected()) return;
      if (!awaitingReestablishment(node.listChannels(), primaryPubkey())) {
        redials = 0;
        return;
      }
      if (redials >= maxRedials) return;
      redials++;
      onDiagnostic?.({ phase: 'primary-redial',
        message: `channel reestablishment incomplete ${timeoutMs / 1000}s after connecting, dialling again (${redials}/${maxRedials})` });
      // The runtime coordinator reports failures and owns subsequent retries.
      Promise.resolve().then(() => {
        if (current === generation && primary === primaryPubkey() && !isClosed() && !recoveryHold() && primaryConnected()) return redial();
      }).catch(() => {});
    }, timeoutMs);
    pending = timer;
    pendingTimers.add(timer);
  };
  const disconnected = peer => { if (peerKey(peer) === primaryPubkey()) clear(); };
  node.on('peer:connect', connected);
  node.on('peer:disconnect', disconnected);
  return () => {
    clear();
    node.off('peer:connect', connected);
    node.off('peer:disconnect', disconnected);
  };
}

module.exports = { awaitingReestablishment, watchReestablishment };
