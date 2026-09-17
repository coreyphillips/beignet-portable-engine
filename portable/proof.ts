import { Buffer } from 'buffer';
import { address, networks, Transaction } from 'bitcoinjs-lib';
import { createHash } from './crypto';
export function queryElectrum(
	socketFactory: any,
	target: any,
	method: string,
	params: any[]
): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = socketFactory(target);
		let data = '';
		let finished = false;
		const timer = setTimeout(
			() => finish(new Error('Chain evidence unavailable')),
			5000
		);
		function finish(error?: any, result?: any) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(result);
		}
		socket.on('connect', () => {
			try {
				socket.write(
					Buffer.from(
						JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'
					)
				);
			} catch (error) {
				finish(error);
			}
		});
		socket.on('error', (error: any) => finish(error));
		socket.on('close', () =>
			finish(new Error('Chain evidence connection closed'))
		);
		socket.on('data', (chunk: any) => {
			data += Buffer.from(chunk).toString('utf8');
			if (data.length > 4 * 1024 * 1024)
				return finish(new Error('Chain evidence exceeded size limit'));
			if (!data.includes('\n')) return;
			try {
				const result = JSON.parse(data.slice(0, data.indexOf('\n')));
				if (result.error) return finish(new Error('Chain evidence refused'));
				finish(undefined, result.result);
			} catch (error) {
				finish(error);
			}
		});
	});
}
export function matchTransaction(
	entry: any,
	txid: string,
	raw: string,
	networkName: string
) {
	const network =
		networkName === 'mainnet'
			? networks.bitcoin
			: networkName === 'regtest'
			? networks.regtest
			: networks.testnet;
	const script = address.toOutputScript(entry.address, network);
	const transaction = Transaction.fromHex(raw);
	if (transaction.getId() !== txid) return null;
	const spendsOriginal = transaction.ins.some(
		(input) =>
			Buffer.from(input.hash).reverse().toString('hex') ===
				entry.previousFundingTxid &&
			input.index === entry.previousFundingOutputIndex
	);
	const paysRequest = transaction.outs.some(
		(output) =>
			output.script.equals(script) && output.value === entry.amountSats
	);
	if (!spendsOriginal || !paysRequest) return null;
	return createHash('sha256').update(script).digest().reverse().toString('hex');
}
/**
 * Whether a channel's funding transaction has been mined.
 *
 * A trusted (zero-conf) channel reports NORMAL from the moment it opens, so its
 * state says nothing about the chain. Without this the wallet cannot tell a
 * settled channel from one whose funding is still only a mempool promise, and
 * it presents both as ordinary spendable balance.
 *
 * Returns null when the answer is not known — an unreachable server, a server
 * that has never seen the transaction, or a malformed reply. Null is treated as
 * "unknown" everywhere it is consumed, never as "unconfirmed": a chain lookup
 * that failed must not turn into a claim about someone's money.
 */
export async function fundingConfirmed(
	socketFactory: any,
	electrum: any,
	txid: string,
	outputIndex: number
): Promise<boolean | null> {
	if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) return null;
	if (!Number.isInteger(outputIndex) || outputIndex < 0) return null;
	try {
		const raw = await queryElectrum(
			socketFactory,
			electrum,
			'blockchain.transaction.get',
			[txid, false]
		);
		const transaction = Transaction.fromHex(raw);
		if (transaction.getId() !== txid) return null;
		const output = transaction.outs[outputIndex];
		if (!output) return null;
		const scriptHash = createHash('sha256')
			.update(output.script)
			.digest()
			.reverse()
			.toString('hex');
		const history = await queryElectrum(
			socketFactory,
			electrum,
			'blockchain.scripthash.get_history',
			[scriptHash]
		);
		if (!Array.isArray(history)) return null;
		return history.some((row) => row.tx_hash === txid && row.height > 0);
	} catch {
		return null;
	}
}

export async function verifySubmission(
	socketFactory: any,
	electrum: any,
	entry: any,
	txid: string,
	network: string
) {
	const raw = await queryElectrum(
		socketFactory,
		electrum,
		'blockchain.transaction.get',
		[txid, false]
	);
	const scriptHash = matchTransaction(entry, txid, raw, network);
	if (!scriptHash) return null;
	const history = await queryElectrum(
		socketFactory,
		electrum,
		'blockchain.scripthash.get_history',
		[scriptHash]
	);
	return {
		matched: true,
		confirmed:
			Array.isArray(history) &&
			history.some((row) => row.tx_hash === txid && row.height > 0)
	};
}
