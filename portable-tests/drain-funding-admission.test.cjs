const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const bitcoin = require('bitcoinjs-lib');
const source = buildSync({
	stdin: { contents: `
		export { DirectFundingReceiver } from './src/lightning/direct-funding/receiver/engine';
		export { deriveOfferId, ownershipDigest } from './src/lightning/direct-funding/messages';
		export { getPublicKey, sign } from './src/lightning/crypto/ecdh';`,
		resolveDir: require('node:path').join(__dirname, '..'), loader: 'ts' },
	bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', source)(mod, mod.exports, require);
const { DirectFundingReceiver, deriveOfferId, ownershipDigest, getPublicKey, sign } = mod.exports;

test('the construction-time funding fence refuses before any chain lookup', async () => {
	const receiver = new DirectFundingReceiver({ newFundingRefused: () => 'Wallet drain in progress' });
	let refusal;
	receiver.declineUnrecorded = (...args) => { refusal = args.at(-1); };
	await receiver.admitGuarded({}, {}, {}, {}, '', '', Buffer.alloc(33));
	assert.equal(refusal, 'Wallet drain in progress');
});

for (const delayed of ['transaction', 'unspent']) test(`a drain admitted during the ${delayed} lookup fences the new funding before mutation`, async () => {
	const secret = Buffer.alloc(32, 7), pubkey = getPublicKey(secret);
	const script = bitcoin.payments.p2wpkh({ pubkey }).output;
	const tx = new bitcoin.Transaction();
	tx.addInput(Buffer.alloc(32, 2), 0);
	tx.addOutput(script, 100000);
	const nodeId = getPublicKey(Buffer.alloc(32, 8));
	const offer = { txid: Buffer.from(tx.getId(), 'hex'), vout: 0, amountSat: 50000n,
		valueSat: 100000n, sequence: 0xfffffffd, changeScript: script, receiptHash: Buffer.alloc(32, 4) };
	offer.offerId = deriveOfferId(offer.txid, offer.vout, offer.amountSat);
	offer.ownership = { pubkey, signature: sign(ownershipDigest(offer.offerId, offer.txid, 0, offer.amountSat, offer.receiptHash, nodeId), secret) };
	let held = false, release, lookedUp = false;
	const wait = new Promise(resolve => { release = resolve; });
	const deps = {
		nodeId, newFundingRefused: () => held ? 'Wallet drain in progress' : null,
		liquidityPeer: () => 'primary',
		requests: { isTombstoned: () => false, attemptsFor: () => ({ attempts: 0 }),
			byReceiptHash: () => assert.fail('must refuse before final admission mutations') },
		chain: {
			getTransaction: async () => { lookedUp = true; if (delayed === 'transaction') await wait; return tx.toBuffer(); },
			listUnspent: async () => { lookedUp = true; if (delayed === 'unspent') await wait; return [{ txid: tx.getId(), outputIndex: 0, height: 1 }]; }
		}
	};
	const receiver = new DirectFundingReceiver(deps);
	receiver.started = true;
	let refusal;
	receiver.declineUnrecorded = (...args) => { refusal = args.at(-1); };
	const pending = receiver.admitGuarded({}, { receiptHash: offer.receiptHash.toString('hex') }, {}, offer, offer.offerId.toString('hex'), '', pubkey);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(lookedUp, true);
	held = true;
	release();
	await pending;
	assert.equal(refusal, 'Wallet drain in progress');
	assert.equal(receiver.inflightCount(), 0);
});
