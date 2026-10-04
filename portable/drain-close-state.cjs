'use strict';

const hex = (value) => Buffer.isBuffer(value) ? value.toString('hex') : value;

/** Missing closeStatus is not evidence that shutdown never left the node. */
function closeNotStarted({ channelId, live, saved, monitor, held }) {
	if (held || !live || !saved || monitor?.commitmentBroadcast) return false;
	const normal = (state) => state.state === 'NORMAL' ||
		(state.state === 'AWAITING_REESTABLISH' && state.preReestablishState === 'NORMAL');
	const untouched = (state) => normal(state) &&
		!state.externalClose && !state.localShutdownScript && !state.remoteShutdownScript &&
		!state.lastCooperativeCloseTxHex && !state.closeSpendsSpliceTxid &&
		!state.restoreRecencyUnproven && !state.reestablishRecencyUnproven &&
		!state.reestablishSecretMissing && !state.restoreRevokedRisk && !state.fundingUnaccounted;
	return untouched(live) && untouched(saved) &&
		hex(live.channelId) === channelId && hex(saved.channelId) === channelId &&
		typeof hex(live.fundingTxid) === 'string' &&
		hex(live.fundingTxid) === hex(saved.fundingTxid) &&
		Number.isInteger(live.fundingOutputIndex) &&
		live.fundingOutputIndex === saved.fundingOutputIndex;
}

module.exports = { closeNotStarted };
