import { address as bitcoinAddress, networks } from 'bitcoinjs-lib';
import { decode } from '../src/lightning/invoice/decode';
import { createHash } from './crypto';

const LIMIT = 2_100_000_000_000_000;
const clone = (value: any) => JSON.parse(JSON.stringify(value));
function fail(code = 'INVALID_RECEIVE_REQUEST', message = 'This is not the original payment request for this wallet.', status = 400): never {
	throw Object.assign(new Error(message), {code, status});
}
export function receiveAddressScriptHash(address: string, network: string) {
	const net = network === 'mainnet' ? networks.bitcoin : network === 'regtest' ? networks.regtest
		: ['testnet', 'signet'].includes(network) ? networks.testnet : null;
	try {
		if (!net || typeof address !== 'string' || address.length > 128) fail();
		const script = bitcoinAddress.toOutputScript(address, net);
		return createHash('sha256').update(script).digest().reverse().toString('hex');
	} catch { fail(); }
}
function normalize(input: any, network: string) {
	if (!input || typeof input !== 'object' || Array.isArray(input) || input.demo === true) fail();
	if (typeof input.id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(input.id)) fail();
	if (typeof input.uri !== 'string' || input.uri.length > 16384 || /[\s\u0000-\u001f]/.test(input.uri)) fail();
	if (typeof input.bolt11 !== 'string' || input.bolt11.length > 12000 || typeof input.paymentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.paymentHash)) fail();
	const address = input.address == null ? null : input.address;
	const scriptHash = address === null ? null : receiveAddressScriptHash(address, network);
	const amount = input.amountSats == null ? null : input.amountSats;
	if (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0 || amount > LIMIT)) fail();
	if (!Number.isSafeInteger(input.feeSats) || input.feeSats < 0 || input.feeSats > LIMIT
		|| typeof input.description !== 'string' || input.description.length > 256
		|| !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0
		|| !Array.isArray(input.warnings) || input.warnings.length > 20
		|| input.warnings.some((w: any) => typeof w !== 'string' || w.length > 1000)) fail();
	let parsed: any;
	try {
		if (address === null) {
			const direct = input.uri.replace(/^lightning:/i, '');
			if (direct.toLowerCase() !== input.bolt11.toLowerCase()) fail();
		} else {
			if (!/^bitcoin:/i.test(input.uri) || input.uri.includes('#')) fail();
			const raw = input.uri.slice(8);
			const split = raw.indexOf('?');
			const uriAddress = split < 0 ? raw : raw.slice(0, split);
			if (uriAddress !== input.address) fail();
			// Reject malformed encoding and duplicated fields instead of accepting a different interpretation.
			const query = new URLSearchParams(split < 0 ? '' : raw.slice(split + 1));
			const seen = new Set();
			for (const field of (split < 0 ? [] : raw.slice(split + 1).split('&'))) decodeURIComponent(field.replace(/\+/g, ' '));
			for (const [key] of query) {
				if (seen.has(key) || !['amount', 'message', 'label', 'lightning', 'bgnq'].includes(key)) fail();
				seen.add(key);
			}
			if (query.get('lightning')?.toLowerCase() !== input.bolt11.toLowerCase()) fail();
			const btc = query.get('amount');
			let uriAmount: bigint | null = null;
			if (btc !== null) {
				if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(btc)) fail();
				const [whole, fraction = ''] = btc.split('.');
				uriAmount = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
			}
			if (uriAmount !== (amount === null ? null : BigInt(amount))) fail();
		}
		parsed = decode(input.bolt11);
		const chain = ({mainnet:'bc', testnet:'tb', regtest:'bcrt', signet:'tbs'} as any)[network];
		if (parsed.network !== chain || parsed.paymentHash.toString('hex') !== input.paymentHash
			|| (parsed.amountMsat ?? null) !== (amount === null ? null : BigInt(amount) * 1000n)) fail();
		if (input.expiresAt > (parsed.timestamp + (parsed.expiry ?? 3600)) * 1000) fail();
	} catch { fail(); }
	const request = {id:input.id, uri:input.uri, address, bolt11:input.bolt11,
		paymentHash:input.paymentHash, amountSats:amount, description:input.description,
		feeSats:input.feeSats, expiresAt:input.expiresAt, warnings:[...input.warnings], demo:false,
		createdAt:parsed.timestamp * 1000, network};
	return {request, scriptHash};
}
function binding(row: any) {
	return JSON.stringify([row.paymentHash, row.uri, row.address, row.bolt11.toLowerCase(), row.amountSats]);
}
/** Public request metadata only. Durable writes finish before any registration is acknowledged. */
export class ReceiveRequestStore {
	private state: any;
	private queue: Promise<any> = Promise.resolve();
	constructor(private options: {walletId:string; network:string; load:()=>any; save:(value:any)=>void}) {}
	private load() {
		if (this.state) return;
		try {
			const data = this.options.load();
			if (data == null) { this.state={version:1,walletId:this.options.walletId,network:this.options.network,requests:[],issuedAddresses:[]}; return; }
			if (data.version !== 1 || data.walletId !== this.options.walletId || data.network !== this.options.network
				|| !Array.isArray(data.requests) || data.requests.length > 5000 || !Array.isArray(data.issuedAddresses)
				|| data.issuedAddresses.length > 10000) fail();
			const hashes = new Set(), ids = new Set();
			const requests:any[]=[];
			for (const row of data.requests) {
				const normalized = normalize(row, this.options.network).request;
				if (row.network !== this.options.network || row.createdAt !== normalized.createdAt || hashes.has(row.paymentHash) || ids.has(row.id)) fail();
				hashes.add(row.paymentHash); ids.add(row.id); requests.push(normalized);
			}
			for (const addr of data.issuedAddresses) receiveAddressScriptHash(addr,this.options.network);
			this.state = {version:1,walletId:this.options.walletId,network:this.options.network,requests,issuedAddresses:[...new Set(data.issuedAddresses)]};
		} catch { fail('RECEIVE_REQUESTS_UNAVAILABLE','Saved payment request links are unreadable. Restore this metadata before saving new links.',503); }
	}
	private commit(next: any) {
		if (JSON.stringify(next).length > 16 * 1024 * 1024) fail('RECEIVE_REQUESTS_FULL','The saved payment request history is full.',503);
		try { this.options.save(next); } catch { fail('RECEIVE_REQUESTS_UNAVAILABLE','The request was created, but its original payment details could not be saved. Keep the original payment request and retry saving it.',503); }
		this.state=next;
	}
	private addressCounts() {
		const counts=new Map<string,number>();
		for(const row of this.state.requests){if(row.address===null)continue;const hash=receiveAddressScriptHash(row.address,this.options.network);counts.set(hash,(counts.get(hash)??0)+1);}
		return counts;
	}
	private project(row:any,counts=this.addressCounts()) {
		if(row.address===null)return {...clone(row),bitcoinTracking:'lightning-only'};
		const hash=receiveAddressScriptHash(row.address,this.options.network);
		return {...clone(row),bitcoinTracking:(counts.get(hash)??0)>1?'ambiguous':'unique'};
	}
	list() { this.load(); const counts=this.addressCounts();return this.state.requests.map((row:any)=>this.project(row,counts)); }
	allocateAddress(current:()=>Promise<string>,next:()=>Promise<string>) {
		const pending=this.queue.then(async()=>{
			this.load();
			const used=new Set([...this.state.issuedAddresses,...this.state.requests.filter((row:any)=>row.address!==null).map((row:any)=>row.address)]
				.map((address:string)=>receiveAddressScriptHash(address,this.options.network)));
			// Always advance once: an upgraded wallet may have handed its current
			// address to an older, unregistered request. Never reuse that address.
			let previous=await current();
			let address=await next();
			for(let count=0;count<128;count++) {
				if(address===previous) break;
				const hash=receiveAddressScriptHash(address,this.options.network);
				if(!used.has(hash)){this.rememberAddress(address);return address;}
				previous=address;address=await next();
			}
			fail('RECEIVE_ADDRESS_LIMIT','The wallet has reached its unused receive address limit. A Lightning-only request can still be created.',409);
		});
		this.queue=pending.catch(()=>{});
		return pending;
	}
	rememberAddress(address: string) {
		this.load(); receiveAddressScriptHash(address,this.options.network);
		if (this.state.issuedAddresses.includes(address)) return;
		if (this.state.issuedAddresses.length >= 10000) fail('RECEIVE_REQUESTS_FULL','The receive address history is full.',503);
		this.commit({...this.state, issuedAddresses:[...this.state.issuedAddresses,address]});
	}
	async register(input: any, checks: {getInvoice:(hash:string)=>any; ownsAddress:(address:string,scriptHash:string)=>any}) {
		const pending = this.queue.then(async () => {
			const {request,scriptHash}=normalize(input,this.options.network);
			this.load();
			const old = this.state.requests.find((row:any)=>row.paymentHash===request.paymentHash);
			if (old) {
				if (binding(old)!==binding(request)) fail('RECEIVE_REQUEST_CONFLICT','This invoice is already linked to a different original request.',409);
				return this.project(old);
			}
			if (this.state.requests.some((row:any)=>row.id===request.id)) fail('RECEIVE_REQUEST_CONFLICT','This request ID is already linked to another invoice.',409);
			const invoice=await checks.getInvoice(request.paymentHash);
			if (!invoice || typeof invoice.bolt11!=='string' || invoice.bolt11.toLowerCase()!==request.bolt11.toLowerCase()
				|| invoice.paymentHash!==request.paymentHash) fail('RECEIVE_REQUEST_NOT_OWNED','This invoice does not belong to this wallet.',400);
			if (request.address !== null && !this.state.issuedAddresses.includes(request.address) && !await checks.ownsAddress(request.address,scriptHash!))
				fail('RECEIVE_ADDRESS_NOT_OWNED','This Bitcoin address is not recorded as belonging to this wallet. Keep the original request; do not guess another address.',400);
			if (this.state.requests.length>=5000) fail('RECEIVE_REQUESTS_FULL','The saved payment request history is full.',503);
			this.commit({...this.state,requests:[...this.state.requests,request]});
			return this.project(request);
		});
		this.queue=pending.catch(()=>{});
		return pending;
	}
}

/** Reserve first, then acknowledge only after this exact address is watched. */
export async function allocateWatchedReceiveAddress({store,wallet,current,network}: {
 store:ReceiveRequestStore; wallet:any; current:()=>Promise<string>; network:string;
}) {
 const address=await store.allocateAddress(current,async()=>{
  const generated=await wallet.generateNewReceiveAddress();
  if(generated.isErr()) fail('ADDRESS_FAILED','A new receive address could not be prepared.',503);
  return generated.value.address;
 });
 const watched=await wallet.electrum.subscribeToAddresses({scriptHashes:[receiveAddressScriptHash(address,network)]});
 if(watched.isErr()) fail('ADDRESS_FAILED','The receive address was reserved, but its payment notifications could not be connected. Reconnect the wallet and retry.',503);
 return address;
}
