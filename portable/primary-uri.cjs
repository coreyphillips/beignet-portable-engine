'use strict';

/** Parse the private phone link or a conventional Lightning address. */
function parsePrimaryUri(input) {
	const uri = String(input || '').trim();
	const match = /^(0[23][0-9a-f]{64})@(.+)$/i.exec(uri);
	if (!match)
		throw new Error(
			'Enter a node URI: public key@host:port or public key@iroh:endpoint-id.'
		);
	const pubkey = match[1].toLowerCase();
	const address = match[2];
	if (/^iroh:/i.test(address)) {
		const parts = /^iroh:([^?]+)(?:\?(.*))?$/i.exec(address);
		if (!parts) throw new Error('Invalid Iroh address.');
		let endpointId = parts[1].toLowerCase();
		if (/^[a-z2-7]{52}$/.test(endpointId)) {
			const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
			let bits = 0,
				value = 0,
				hex = '';
			for (const char of endpointId) {
				value = (value << 5) | alphabet.indexOf(char);
				bits += 5;
				if (bits >= 8) {
					bits -= 8;
					hex += ((value >> bits) & 255).toString(16).padStart(2, '0');
				}
			}
			if ((value & 15) !== 0) throw new Error('Invalid Iroh endpoint padding.');
			endpointId = hex;
		}
		if (!/^[0-9a-f]{64}$/.test(endpointId))
			throw new Error('Invalid Iroh endpoint ID.');
		let relayUrl;
		if (parts[2] !== undefined) {
			const params = new URLSearchParams(parts[2]);
			if (
				[...params.keys()].some((key) => key !== 'relay') ||
				params.getAll('relay').length !== 1
			)
				throw new Error('Use one relay parameter.');
			const raw = params.get('relay');
			if (!raw || /\s/.test(raw)) throw new Error('Invalid Iroh relay URL.');
			const relay = new URL(raw);
			if (
				!['http:', 'https:'].includes(relay.protocol) ||
				!relay.hostname ||
				relay.username ||
				relay.password ||
				relay.hash ||
				relay.search
			)
				throw new Error('Invalid Iroh relay URL.');
			relayUrl = relay.href;
		}
		return {
			pubkey,
			host: endpointId,
			port: 0,
			transport: {
				type: 'iroh',
				endpointId,
				...(relayUrl ? { relayUrl } : {})
			},
			uri: `${pubkey}@iroh:${endpointId}${
				relayUrl ? `?relay=${encodeURIComponent(relayUrl)}` : ''
			}`
		};
	}
	const tcp = /^(\[[0-9a-f:]+\]|[^\s:@/?#]+):(\d+)$/i.exec(address);
	if (!tcp || Number(tcp[2]) < 1 || Number(tcp[2]) > 65535)
		throw new Error('Enter a node host and port between 1 and 65535.');
	return {
		pubkey,
		host: tcp[1].replace(/^\[|\]$/g, ''),
		port: Number(tcp[2]),
		uri: `${pubkey}@${tcp[1]}:${Number(tcp[2])}`
	};
}

function parsePrimaryFallback(primary, input) {
	if (!input) return undefined;
	const fallback = parsePrimaryUri(input);
	if (
		primary.transport?.type !== 'iroh' ||
		fallback.transport ||
		!/^[a-z2-7]{56}\.onion$/i.test(fallback.host) ||
		fallback.pubkey !== primary.pubkey
	) {
		throw new Error(
			'The fallback must be an onion address for the same primary node key.'
		);
	}
	return fallback;
}
module.exports = { parsePrimaryUri, parsePrimaryFallback };
