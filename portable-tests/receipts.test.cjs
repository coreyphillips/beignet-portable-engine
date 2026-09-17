const { test } = require('node:test');
const assert = require('node:assert/strict');
const bitcoin = require('bitcoinjs-lib');
const crypto = require('node:crypto');
const { lookupOnchainReceipts } = require('../dist/receipts.cjs');
const payment = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 7), network: bitcoin.networks.regtest });
const other = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 8), network: bitcoin.networks.regtest });
function transaction(outputs) {
  const tx = new bitcoin.Transaction();
  tx.addInput(Buffer.alloc(32, 1), 0);
  for (const [script, value] of outputs) tx.addOutput(script, value);
  return tx;
}
function fixture(history, txs) {
  const calls = [];
  return { calls, query: async (method, params) => {
    calls.push([method, params]);
    if (method === 'blockchain.scripthash.get_history') return history;
    assert.equal(method, 'blockchain.transaction.get'); assert.equal(params[1], false);
    return txs.get(params[0]);
  }};
}
const lookup = query => lookupOnchainReceipts({ address: payment.address, network: 'regtest', query });

test('receipts count exact matching outputs, not net value, other recipients, zero outputs or duplicate history', async () => {
  const tx = transaction([[payment.output, 3000], [other.output, 200000], [payment.output, 7000], [payment.output, 0]]);
  const noReceipt = transaction([[other.output, 9000]]);
  const f = fixture([{tx_hash: tx.getId(), height: 0}, {tx_hash: tx.getId(), height: 0}, {tx_hash: noReceipt.getId(), height: -1}], new Map([[tx.getId(), tx.toHex()], [noReceipt.getId(), noReceipt.toHex()]]));
  const result = await lookup(f.query);
  assert.deepEqual(result, {address: payment.address, receivedSats: 10000, confirmedSats: 0, transactions: [{txid: tx.getId(), amountSats: 10000, height: 0, confirmed: false}]});
  assert.equal(f.calls.filter(([method]) => method === 'blockchain.transaction.get').length, 2);
  assert.equal(f.calls[0][1][0], crypto.createHash('sha256').update(payment.output).digest().reverse().toString('hex'));
});

test('fresh history recognizes confirmation, partial totals, reorgs and dropped replacements without stale cached receipts', async () => {
  const a = transaction([[payment.output, 3000]]), b = transaction([[payment.output, 7000]]);
  const raws = new Map([[a.getId(), a.toHex()], [b.getId(), b.toHex()]]);
  let history = [{tx_hash: a.getId(), height: 22}, {tx_hash: b.getId(), height: -1}];
  const query = (method, params) => Promise.resolve(method.endsWith('get_history') ? history : raws.get(params[0]));
  const first = await lookup(query); assert.equal(first.receivedSats, 10000); assert.equal(first.confirmedSats, 3000);
  history = [{tx_hash: a.getId(), height: 0}];
  const second = await lookup(query); assert.equal(second.receivedSats, 3000); assert.equal(second.confirmedSats, 0);
  history = []; assert.equal((await lookup(query)).receivedSats, 0);
});

test('invalid network/address and unsupported networks fail before any server request', async () => {
  for (const network of ['mainnet', 'testnet', 'unrecognized']) {
    await assert.rejects(lookupOnchainReceipts({address: payment.address, network, query: () => assert.fail('must not dial')}), {code:'INVALID_ADDRESS'});
  }
});

test('malformed, conflicting, oversized history and wrong raw transaction IDs fail closed', async () => {
  const tx = transaction([[payment.output, 10000]]), id = tx.getId();
  for (const history of [null, [{tx_hash:id,height:'1'}], [{tx_hash:id,height:-2}], [{tx_hash:id,height:0},{tx_hash:id,height:1}], Array.from({length:65},()=>({tx_hash:id,height:0}))]) {
    await assert.rejects(lookup(fixture(history,new Map()).query), {code:'RECEIVE_LOOKUP_UNAVAILABLE'});
  }
  for (const raw of ['00', transaction([[other.output,10000]]).toHex()]) {
    await assert.rejects(lookup(fixture([{tx_hash:id,height:0}],new Map([[id,raw]])).query), {code:'RECEIVE_LOOKUP_UNAVAILABLE'});
  }
});

test('server failures expose fixed diagnostics and a stalled response is bounded', async t => {
  await assert.rejects(lookup(async()=>{throw Error('secret upstream credentials');}), error => error.code === 'RECEIVE_LOOKUP_UNAVAILABLE' && !error.message.includes('secret'));
  t.mock.timers.enable({apis:['setTimeout']});
  const pending = assert.rejects(lookup(()=>new Promise(()=>{})), {code:'RECEIVE_LOOKUP_UNAVAILABLE'});
  t.mock.timers.tick(5000); await pending;
});
