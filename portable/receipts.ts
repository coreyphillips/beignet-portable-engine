import { Buffer } from 'buffer';
import { address as bitcoinAddress, networks, Transaction } from 'bitcoinjs-lib';
import { createHash } from './crypto';
export { queryElectrum } from './proof';

type Query = (method: string, params: any[]) => Promise<any>;
const MAX_HISTORY = 64;
const MAX_SATS = 2_100_000_000_000_000;
function unavailable(): never {
	throw Object.assign(new Error('Bitcoin receipt details are unavailable. Try again.'), {
		code: 'RECEIVE_LOOKUP_UNAVAILABLE', status: 503
	});
}

/** Exact output amounts observed by the configured Electrum server. Positive
 * history heights are server-reported confirmations, not an SPV proof. Each
 * lookup rebuilds from current history so replaced/dropped transactions leave. */
export async function lookupOnchainReceipts(options: {
	address: string;
	network: string;
	query: Query;
}) {
	const network = options.network === 'mainnet' ? networks.bitcoin
		: options.network === 'regtest' ? networks.regtest
		: ['testnet', 'signet'].includes(options.network) ? networks.testnet : null;
	let script: Buffer;
	try {
		if (!network || typeof options.address !== 'string' || options.address.length > 128) throw new Error();
		script = bitcoinAddress.toOutputScript(options.address, network);
	} catch {
		throw Object.assign(new Error('Enter a Bitcoin address on this wallet’s network.'), {
			code: 'INVALID_ADDRESS', status: 400
		});
	}
	const scriptHash = createHash('sha256').update(script).digest().reverse().toString('hex');
	const deadline = Date.now() + 12000;
	let stopped = false;
	const query = async (method: string, params: any[]) => {
		if (stopped || Date.now() >= deadline) unavailable();
		let timer: ReturnType<typeof setTimeout>;
		try {
			return await Promise.race([
				Promise.resolve().then(() => options.query(method, params)),
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), Math.min(5000, deadline - Date.now())); })
			]);
		} catch { stopped = true; unavailable(); }
		finally { clearTimeout(timer!); }
	};
	const history = await query('blockchain.scripthash.get_history', [scriptHash]);
	if (!Array.isArray(history) || history.length > MAX_HISTORY) unavailable();
	const unique = new Map<string, number>();
	for (const row of history) {
		if (!row || typeof row.tx_hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(row.tx_hash)
			|| !Number.isSafeInteger(row.height) || row.height < -1) unavailable();
		const txid = row.tx_hash.toLowerCase();
		if (unique.has(txid) && unique.get(txid) !== row.height) unavailable();
		unique.set(txid, row.height);
	}
	const entries = [...unique];
	const transactions: Array<{ txid: string; amountSats: number; height: number; confirmed: boolean }> = [];
	let cursor = 0;
	await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
		while (cursor < entries.length) {
			const [txid, height] = entries[cursor++];
			const raw = await query('blockchain.transaction.get', [txid, false]);
			let tx: Transaction;
			try {
				if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024 || !/^(?:[a-fA-F0-9]{2})+$/.test(raw)) unavailable();
				tx = Transaction.fromHex(raw);
				if (tx.getId() !== txid) unavailable();
			} catch { stopped = true; unavailable(); }
			let amountSats = 0;
			for (const output of tx.outs) {
				if (!Number.isSafeInteger(output.value) || output.value < 0 || output.value > MAX_SATS) unavailable();
				if (output.script.equals(script)) amountSats += output.value;
			}
			if (!Number.isSafeInteger(amountSats) || amountSats > MAX_SATS) unavailable();
			if (amountSats > 0) transactions.push({ txid, amountSats, height, confirmed: height > 0 });
		}
	})).catch(() => { stopped = true; unavailable(); });
	transactions.sort((a, b) => a.txid.localeCompare(b.txid));
	const receivedSats = transactions.reduce((sum, tx) => sum + tx.amountSats, 0);
	const confirmedSats = transactions.filter(tx => tx.confirmed).reduce((sum, tx) => sum + tx.amountSats, 0);
	if (!Number.isSafeInteger(receivedSats) || receivedSats > MAX_SATS) unavailable();
	return { address: options.address, receivedSats, confirmedSats, transactions };
}
