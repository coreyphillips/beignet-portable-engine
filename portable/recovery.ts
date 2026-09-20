/** Import intent is vault metadata, separate from the public wallet record. */
export type RecoveryImport = { autoApply: boolean; complete: boolean };

export function readRecoveryImport(value: any): RecoveryImport {
	if (value === undefined) return { autoApply: false, complete: false };
	if (
		!value ||
		typeof value.autoApply !== 'boolean' ||
		typeof value.complete !== 'boolean' ||
		(value.complete && !value.autoApply)
	)
		throw new Error('Invalid recovery import metadata');
	return { autoApply: value.autoApply, complete: value.complete };
}

export function validateRecoveryImport(body: any): void {
	if (
		body.recoveryAutoApply !== undefined &&
		typeof body.recoveryAutoApply !== 'boolean'
	)
		throw Object.assign(new Error('recoveryAutoApply must be a boolean'), {
			code: 'INVALID_PARAMS', status: 400
		});
	if (body.recoveryAutoApply === true && typeof body.mnemonic !== 'string')
		throw Object.assign(new Error('Peer recovery requires an explicit recovery phrase'), {
			code: 'INVALID_MNEMONIC', status: 400
		});
}

/** These holds supplement the engine's channel recency and writer fences. */
export function recoveryRefusal(node: any, importPending: boolean) {
	const status = node.getRecoverySurfaceStatus();
	if (node.restartRequired || status.state === 'restart-required')
		return { code: 'NODE_RESTART_REQUIRED', message: 'Recovery installed wallet state. Close and reopen the wallet to continue.' };
	if (status.state === 'fenced' || status.node?.fenced || status.node?.gate === 'fenced')
		return { code: 'NODE_FENCED', message: 'This wallet was superseded by another recovery and cannot change channel state.' };
	if (node.resuming || node.restorePending || status.restore?.inProgress ||
		['restore-required', 'restoring'].includes(status.state))
		return { code: 'NODE_RESTORE_PENDING', message: 'Wallet recovery is in progress. Wait for recovery to finish.' };
	if (importPending) {
		if (status.autoApply?.phase === 'refused')
			return { code: 'RECOVERY_UNAVAILABLE', message: 'Peer recovery could not safely restore this wallet. Check recovery status before continuing.' };
		return { code: 'NODE_RESTORE_PENDING', message: 'Waiting for the primary node to return a wallet backup. Check recovery status.' };
	}
	return null;
}

/** A completed native install can outlive a crash before its completion event. */
export function hasInstalledRecovery(node: any): boolean {
	return node.getStorage().loadAllChannels().some((row: any) =>
		row.state.restoreRecencyUnproven === true || row.state.dataLossDetected === true
	);
}
