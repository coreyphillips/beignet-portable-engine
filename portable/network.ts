import { Block } from 'bitcoinjs-lib';
import type { SocketFactory } from './state';
import { queryElectrum } from './proof';

// Display-order IDs from Bitcoin Core src/kernel/chainparams.cpp. Testnet means
// testnet3, as in the existing Beignet network enum; it does not mean testnet4.
const GENESIS: Readonly<Record<string, string>> = Object.freeze({
	mainnet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
	testnet: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
	signet: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
	regtest: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
});

function fail(code: string, message: string, status = 409): never {
	throw Object.assign(new Error(message), { code, status });
}

/**
 * Check the configured server before opening the wallet or talking to its peer.
 * This detects a relay pointed at a different Bitcoin network. It is not SPV
 * validation or protection against a server deliberately lying about its chain.
 */
export async function verifyElectrumNetwork({
	network,
	electrum,
	socketFactory
}: {
	network: string;
	electrum: { host: string; port: number; tls: boolean };
	socketFactory: SocketFactory;
}): Promise<void> {
	const expected = GENESIS[network];
	if (!Object.prototype.hasOwnProperty.call(GENESIS, network))
		fail('INVALID_NETWORK', 'Unsupported Bitcoin network', 400);
	let header: unknown;
	try {
		header = await queryElectrum(
			socketFactory,
			electrum,
			'blockchain.block.header',
			[0]
		);
	} catch {
		fail(
			'NETWORK_UNVERIFIED',
			'Could not verify the Bitcoin network. Check the Electrum transport before starting the wallet.',
			503
		);
	}
	if (typeof header !== 'string' || !/^[0-9a-fA-F]{160}$/.test(header))
		fail(
			'NETWORK_UNVERIFIED',
			'The Electrum server did not return a valid genesis header.',
			503
		);
	const actual = Block.fromHex(header).getId();
	if (actual !== expected)
		fail(
			'NETWORK_MISMATCH',
			`The Electrum transport does not serve ${network}. Update the relay or server to match this wallet before starting it.`
		);
}
