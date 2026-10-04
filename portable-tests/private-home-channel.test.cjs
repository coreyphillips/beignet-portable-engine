const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const source = buildSync({
	stdin: {
		contents: `
		export { ChannelManager } from './src/lightning/channel/channel-manager';
		export { Feature, FeatureFlags } from './src/lightning/features/flags';
		export { MessageType } from './src/lightning/message/types';
		export { decodeOpenChannelMessage, decodeAcceptChannelMessage } from './src/lightning/message/channel-open';
		export { decodeOpenChannel2Message, decodeAcceptChannel2Message } from './src/lightning/message/dual-funding';
		export { serializeChannelState, deserializeChannelState } from './src/lightning/storage/serialization';
		export { getPublicKey } from './src/lightning/crypto/ecdh';`,
		resolveDir: require('node:path').join(__dirname, '..'),
		loader: 'ts'
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	packages: 'external',
	write: false
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', source)(mod, mod.exports, require);
const {
	ChannelManager,
	Feature,
	FeatureFlags,
	MessageType,
	getPublicKey,
	decodeOpenChannelMessage,
	decodeAcceptChannelMessage,
	decodeOpenChannel2Message,
	decodeAcceptChannel2Message,
	serializeChannelState,
	deserializeChannelState
} = mod.exports;

function config(id, role, advertise) {
	const point = (offset) => getPublicKey(Buffer.alloc(32, id + offset));
	const localFeatures = FeatureFlags.empty();
	for (const feature of [
		Feature.STATIC_REMOTE_KEY,
		Feature.ANCHOR_ZERO_FEE_HTLC,
		Feature.DUAL_FUND
	])
		localFeatures.setOptional(feature);
	if (advertise) localFeatures.setOptional(Feature.OPTION_ZERO_RESERVE);
	return {
		localFundingPrivkey: Buffer.alloc(32, id),
		localPerCommitmentSeed: Buffer.alloc(32, id + 5),
		localBasepoints: {
			fundingPubkey: point(0),
			revocationBasepoint: point(1),
			paymentBasepoint: point(2),
			delayedPaymentBasepoint: point(3),
			htlcBasepoint: point(4),
			firstPerCommitmentPoint: point(5)
		},
		localFeatures,
		preferAnchors: true,
		zeroReserve: { role, advertise, waiveClientReserve: role === 'primary' }
	};
}

for (const version of [1, 2])
	for (const role of ['wallet', 'primary', undefined]) {
		for (const advertise of [false, true]) {
			test(`v${version} ${
				role || 'default'
			} open with waiver support ${advertise} preserves privacy and confirmation policy`, () => {
				const a = config(1, role, advertise),
					b = config(11, 'primary', advertise);
				const opener = new ChannelManager(a),
					acceptor = new ChannelManager(b);
				const openerKey = a.localBasepoints.fundingPubkey.toString('hex');
				const peerKey = b.localBasepoints.fundingPubkey.toString('hex');
				const outgoing = [],
					incoming = [],
					errors = [];
				for (const [manager, remote, messages] of [
					[opener, b, outgoing],
					[acceptor, a, incoming]
				]) {
					manager.on('error', (error) => errors.push(error));
					manager.peerManager = {
						getPeer: () => ({
							getRemoteInit: () => ({ features: remote.localFeatures })
						}),
						sendToPeer: (pubkey, type, payload) =>
							messages.push({ type, payload })
					};
				}
				const channel =
					version === 1
						? opener.openChannel(peerKey, 100000n)
						: opener.createDualFundedChannel(peerKey, {
								fundingSatoshis: 100000n,
								fundingFeeratePerkw: 253,
								commitmentFeeratePerkw: 253,
								dustLimitSatoshis: 546n,
								maxHtlcValueInFlightMsat: 100000000n,
								htlcMinimumMsat: 0n,
								toSelfDelay: 144,
								maxAcceptedHtlcs: 483,
								locktime: 0,
								localBasepoints: a.localBasepoints,
								localPerCommitmentSeed: a.localPerCommitmentSeed,
								secondPerCommitmentPoint: getPublicKey(Buffer.alloc(32, 7)),
								channelFlags: 1
						  });
				const openType =
					version === 1 ? MessageType.OPEN_CHANNEL : MessageType.OPEN_CHANNEL2;
				const acceptType =
					version === 1
						? MessageType.ACCEPT_CHANNEL
						: MessageType.ACCEPT_CHANNEL2;
				const wire = outgoing.find((message) => message.type === openType);
				assert.ok(wire, JSON.stringify(errors));
				const decoded = (
					version === 1 ? decodeOpenChannelMessage : decodeOpenChannel2Message
				)(wire.payload);
				assert.equal(decoded.channelFlags & 1, role === 'wallet' ? 0 : 1);
				const type = FeatureFlags.fromBuffer(decoded.channelType);
				assert.equal(type.hasFeature(Feature.ZERO_CONF), false);
				assert.equal(type.hasFeature(Feature.SCID_ALIAS), false);
				acceptor.handleMessage(openerKey, openType, wire.payload);
				const accepted = incoming.find(
					(message) => message.type === acceptType
				);
				assert.ok(accepted, JSON.stringify(errors));
				const response = (
					version === 1
						? decodeAcceptChannelMessage
						: decodeAcceptChannel2Message
				)(accepted.payload);
				assert.ok(response.minimumDepth > 0);
				opener.handleMessage(peerKey, acceptType, accepted.payload);
				const state = channel.getFullState();
				assert.equal(state.minimumDepth, response.minimumDepth);
				assert.equal(state.zeroConfEnabled, false);
				assert.equal(state.trustedPeer, false);
				assert.equal(state.announceChannel, role !== 'wallet');
				assert.equal(state.localReserveWaived, role === 'wallet' && advertise);
				assert.equal(state.remoteReserveWaived, false);
				const restored = deserializeChannelState(serializeChannelState(state));
				assert.equal(restored.announceChannel, role !== 'wallet');
				assert.equal(restored.localReserveWaived, state.localReserveWaived);
				assert.deepEqual(errors, []);
			});
		}
	}
