const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const bitcoin = require('bitcoinjs-lib');
const source = buildSync({
	entryPoints: ['portable/proof.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false
}).outputFiles[0].text;
const fixture = { exports: {} };
new Function('module', 'exports', 'require', source)(
	fixture,
	fixture.exports,
	require
);
const { matchTransaction } = fixture.exports;
test('splice proof requires exact original funding input, destination and amount', () => {
	const previous = '11'.repeat(32);
	const destination = bitcoin.payments.p2wpkh({
		hash: Buffer.alloc(20, 3),
		network: bitcoin.networks.regtest
	});
	const tx = new bitcoin.Transaction();
	tx.addInput(Buffer.from(previous, 'hex').reverse(), 1);
	tx.addOutput(destination.output, 2000);
	const entry = {
		previousFundingTxid: previous,
		previousFundingOutputIndex: 1,
		address: destination.address,
		amountSats: 2000
	};
	const raw = tx.toHex(),
		id = tx.getId();
	assert.equal(typeof matchTransaction(entry, id, raw, 'regtest'), 'string');
	assert.equal(
		matchTransaction({ ...entry, amountSats: 2001 }, id, raw, 'regtest'),
		null
	);
	assert.equal(
		matchTransaction(
			{ ...entry, previousFundingOutputIndex: 0 },
			id,
			raw,
			'regtest'
		),
		null
	);
	assert.equal(
		matchTransaction(
			{ ...entry, previousFundingTxid: '22'.repeat(32) },
			id,
			raw,
			'regtest'
		),
		null
	);
	assert.equal(matchTransaction(entry, '33'.repeat(32), raw, 'regtest'), null);
	const other = bitcoin.payments.p2wpkh({
		hash: Buffer.alloc(20, 4),
		network: bitcoin.networks.regtest
	});
	assert.equal(
		matchTransaction({ ...entry, address: other.address }, id, raw, 'regtest'),
		null
	);
});
