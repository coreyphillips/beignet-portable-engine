'use strict';

/** A host on this device or its own network, where a relay may be reached without TLS. */
function isLocalRelayHost(host) {
	if (host === 'localhost' || host === '[::1]') return true;
	const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!octets || octets.slice(1).some((part) => Number(part) > 255))
		return false;
	const [a, b] = [Number(octets[1]), Number(octets[2])];
	return (
		a === 127 ||
		a === 10 ||
		(a === 192 && b === 168) ||
		(a === 172 && b >= 16 && b <= 31)
	);
}

/**
 * A Porch link: the node waits at a relay, and the address is the relay's
 * WebSocket URL with the node's route id. Only that one shape of WebSocket
 * address is accepted. The port is 0, as for Iroh: the relay is not the node,
 * so its host and port are never a TCP address for it.
 */
function parsePorchAddress(pubkey, address) {
	const parts =
		/^(wss?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?\/v1\/p\/([^/?#]+)$/i.exec(
			address
		);
	if (!parts || !/^[a-z2-7]{32}$/.test(parts[4]))
		throw new Error(
			'Invalid Porch link. Expected wss://relay/v1/p/ and a route id.'
		);
	const scheme = parts[1].toLowerCase();
	const host = parts[2].toLowerCase();
	if (host.endsWith('.onion'))
		throw new Error('A Porch link cannot name an onion relay.');
	if (scheme === 'ws' && !isLocalRelayHost(host))
		throw new Error('A Porch link to a public relay must use wss://.');
	let port = '';
	if (parts[3] !== undefined) {
		const number = Number(parts[3]);
		if (number < 1 || number > 65535)
			throw new Error('Invalid Porch link: the port is out of range.');
		if (number !== (scheme === 'wss' ? 443 : 80)) port = `:${number}`;
	}
	const url = `${scheme}://${host}${port}/v1/p/${parts[4]}`;
	return {
		pubkey,
		host: host.replace(/^\[|\]$/g, ''),
		port: 0,
		transport: { type: 'ws', url },
		uri: `${pubkey}@${url}`
	};
}

/** Parse the private phone link, a Porch link or a conventional Lightning address. */
function parsePrimaryUri(input) {
	const uri = String(input || '').trim();
	const match = /^(0[23][0-9a-f]{64})@(.+)$/i.exec(uri);
	if (!match)
		throw new Error(
			'Enter a node URI: public key@host:port, public key@iroh:endpoint-id or a Porch link.'
		);
	const pubkey = match[1].toLowerCase();
	const address = match[2];
	if (/^wss?:\/\//i.test(address)) return parsePorchAddress(pubkey, address);
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
	const tcp = /^(\[[0-9a-f:]+\]|[a-zA-Z0-9.-]+):(\d+)$/i.exec(address);
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
	if (!input || !String(input).trim()) return undefined;
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
