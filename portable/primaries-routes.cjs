'use strict';

// The ranked receive primaries (coreyphillips/beignet#1922, #1924): the engine
// owns the list, its validation and its persistence, and every write answers
// with the whole list, balances and receive target included, the same shape
// `GET /primaries` reads. The bodies mirror the daemon's handlers key for key
// (`order` for a reorder, `fillThresholdSat` for the threshold, null meaning no
// cap). Admin calls are allowed here because the phone owns its engine.
//
// `onWrite(info, { kind, body })` runs after a successful engine write, before
// the answer is returned, so the runtime can mirror the list onto the wallet
// record. Engine refusals propagate untouched, as every other route's do.
function primariesRoutes({ node, failure, onWrite }) {
	const write = async (kind, body, apply) => {
		const info = apply();
		if (onWrite) await onWrite(info, { kind, body });
		return info;
	};
	return {
		'GET /primaries': () => node.listPrimaries(),
		'POST /primaries/add': (body) =>
			write('add', body, () =>
				node.addPrimary({
					pubkey: body.pubkey,
					...(body.host !== undefined ? { host: body.host } : {}),
					...(body.port !== undefined ? { port: body.port } : {}),
					...(body.uri !== undefined ? { uri: body.uri } : {}),
					...(body.rank !== undefined ? { rank: body.rank } : {})
				})
			),
		'POST /primaries/remove': (body) =>
			write('remove', body, () => node.removePrimary(body.pubkey)),
		'POST /primaries/reorder': (body) =>
			write('reorder', body, () => node.reorderPrimaries(body.order)),
		'POST /primaries/threshold': (body) => {
			if (body.fillThresholdSat === undefined)
				failure('INVALID_PARAMS', 'fillThresholdSat is required (null for no cap)');
			return write('threshold', body, () =>
				node.setPrimariesFillThreshold(body.fillThresholdSat)
			);
		}
	};
}

module.exports = { primariesRoutes };
