const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {buildSync}=require('esbuild');
const bitcoin=require('bitcoinjs-lib');
const {ReceiveRequestStore,allocateWatchedReceiveAddress,receiveAddressScriptHash}=require('../dist/receive-requests.cjs');
const output=buildSync({entryPoints:[path.join(__dirname,'../src/lightning/invoice/encode.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const moduleFixture={exports:{}};
new Function('module','exports','require',output)(moduleFixture,moduleFixture.exports,require);
const {encode}=moduleFixture.exports;
const address=bitcoin.payments.p2wpkh({hash:Buffer.alloc(20,1),network:bitcoin.networks.regtest}).address;
const other=bitcoin.payments.p2wpkh({hash:Buffer.alloc(20,2),network:bitcoin.networks.regtest}).address;
function request(tag=3){
 const paymentHash=Buffer.alloc(32,tag);
 const key=Buffer.alloc(32);key[31]=1;
 const bolt11=encode({network:'bcrt',amountMsat:10000000n,description:'Invoice fixture',paymentHash,privateKey:key,timestamp:1777777700,expiry:600});
 return {id:'request-'+tag,address,bolt11,paymentHash:paymentHash.toString('hex'),amountSats:10000,description:'Invoice fixture',feeSats:0,expiresAt:1777778300000,warnings:[],demo:false,
 uri:'bitcoin:'+address+'?amount=0.0001&lightning='+bolt11};
}
function fixture(){let disk=null,fail=false,writes=0;const options={walletId:'wallet-one',network:'regtest',load:()=>disk&&JSON.parse(disk),save:data=>{if(fail)throw Error('disk failure');disk=JSON.stringify(data);writes++;}};
 return {open:()=>new ReceiveRequestStore(options), options, get disk(){return disk},set disk(v){disk=v},set fail(v){fail=v},get writes(){return writes}};}
const checks=row=>({getInvoice:hash=>hash===row.paymentHash?{paymentHash:hash,bolt11:row.bolt11}:null,ownsAddress:addr=>addr===address});
test('original unified request survives a new store without seed fields and replay returns canonical ID after invoice pruning',async()=>{
 const f=fixture(),row=request(),store=f.open();
 const saved=await store.register({...row,preimage:'SECRET',mnemonic:'SECRET'},checks(row));
 assert.equal(saved.createdAt,1777777700000);assert.equal(saved.network,'regtest');
 assert.equal(f.writes,1);assert.ok(!f.disk.includes('SECRET'));
 const reopened=f.open();assert.deepEqual(reopened.list(),[saved]);
 assert.deepEqual(await reopened.register({...row,id:'imported-id'}, {getInvoice:()=>assert.fail('stored replay needs no invoice'),ownsAddress:()=>false}),saved);
 assert.equal(f.writes,1);
});
test('different URI/address/hash/amount cannot rebind a saved request and simultaneous registration never loses rows',async()=>{
 const f=fixture(),store=f.open(),row=request();
 await store.register(row,checks(row));
 await assert.rejects(store.register({...row,address:other,uri:row.uri.replace(address,other)},checks(row)),{code:'RECEIVE_REQUEST_CONFLICT'});
 await assert.rejects(store.register({...row,amountSats:5000},checks(row)),{code:'INVALID_RECEIVE_REQUEST'});
 const second=request(4);second.id=row.id;
 await assert.rejects(store.register(second,checks(second)),{code:'RECEIVE_REQUEST_CONFLICT'});
 assert.equal(store.list().length,1);
});
test('network, original URI, signed invoice and ownership are checked before persisting',async()=>{
 const row=request();
 const variants=[{...row,uri:row.uri+'&amount=0.0001'},{...row,uri:row.uri.replace('amount=0.0001','amount=0.0002')},{...row,uri:row.uri.replace(address,other)},
 {...row,paymentHash:'ff'.repeat(32)},{...row,bolt11:row.bolt11.slice(0,-1)+'x'},{...row,expiresAt:row.expiresAt+1}];
 for(const input of variants){const f=fixture();await assert.rejects(f.open().register(input,checks(row)),{code:'INVALID_RECEIVE_REQUEST'});assert.equal(f.writes,0);}
 const f=fixture();await assert.rejects(new ReceiveRequestStore({...f.options,network:'mainnet'}).register(row,checks(row)),{code:'INVALID_RECEIVE_REQUEST'});
 await assert.rejects(f.open().register(row,{...checks(row),getInvoice:()=>null}),{code:'RECEIVE_REQUEST_NOT_OWNED'});
 await assert.rejects(f.open().register(row,{...checks(row),ownsAddress:()=>false}),{code:'RECEIVE_ADDRESS_NOT_OWNED'});
 assert.equal(f.writes,0);
});
test('failed persistence never acknowledges or changes in-memory history; retry preserves original invoice',async()=>{
 const f=fixture(),store=f.open(),row=request();f.fail=true;
 await assert.rejects(store.register(row,checks(row)),{code:'RECEIVE_REQUESTS_UNAVAILABLE'});
 assert.deepEqual(store.list(),[]);assert.equal(f.disk,null);
 f.fail=false;await store.register(row,checks(row));assert.equal(f.open().list().length,1);
});
test('wallet/network isolation and corrupt metadata fail closed; restored extra fields never escape',async()=>{
 const f=fixture(),row=request();await f.open().register(row,checks(row));
 for(const overrides of [{walletId:'wallet-other'},{network:'mainnet'}])assert.throws(()=>new ReceiveRequestStore({...f.options,...overrides}).list(),{code:'RECEIVE_REQUESTS_UNAVAILABLE'});
 const data=JSON.parse(f.disk);data.requests[0].mnemonic='SECRET';f.disk=JSON.stringify(data);
 assert.ok(!JSON.stringify(f.open().list()).includes('SECRET'));
 f.disk='{}';assert.throws(()=>f.open().list(),{code:'RECEIVE_REQUESTS_UNAVAILABLE'});
});
test('host-issued address evidence is durable and skips no invoice ownership checks',async()=>{
 const f=fixture(),store=f.open(),row=request();store.rememberAddress(address);
 const reopened=f.open();await reopened.register(row,{...checks(row),ownsAddress:()=>false});
 assert.equal(reopened.list().length,1);
});

test('shared host addresses retain both invoices but mark all Bitcoin links ambiguous, including after restart',async()=>{
 const f=fixture(),store=f.open(),a=request(10),b=request(11);
 const known={getInvoice:hash=>{const row=[a,b].find(r=>r.paymentHash===hash);return row?{bolt11:row.bolt11,paymentHash:hash}:null;},ownsAddress:()=>true};
 const [one,two]=await Promise.all([store.register(a,known),store.register(b,known)]);
 assert.equal(one.bitcoinTracking,'unique');assert.equal(two.bitcoinTracking,'ambiguous');
 assert.equal(store.list().length,2);assert.ok(store.list().every(row=>row.bitcoinTracking==='ambiguous'));
 assert.ok(f.open().list().every(row=>row.bitcoinTracking==='ambiguous'));
 assert.equal((await store.register(a,known)).bitcoinTracking,'ambiguous');
});
test('portable address reservation is durable, serialized and refuses gap-limit reuse before another invoice',async()=>{
 const f=fixture(),store=f.open();
 const addresses=[address,other,...[12,13].map(n=>bitcoin.payments.p2wpkh({hash:Buffer.alloc(20,n),network:bitcoin.networks.regtest}).address)];
 let index=0;
 const current=async()=>addresses[index],next=async()=>addresses[Math.min(++index,3)];
 assert.deepEqual(await Promise.all([store.allocateAddress(current,next),store.allocateAddress(current,next)]),addresses.slice(1,3));
 const reopened=f.open();assert.equal(await reopened.allocateAddress(current,next),addresses[3]);
 await assert.rejects(reopened.allocateAddress(async()=>addresses[3],async()=>addresses[3]),{code:'RECEIVE_ADDRESS_LIMIT'});
 assert.equal(f.open().list().length,0);
 assert.ok(!JSON.parse(f.disk).issuedAddresses.includes(address),'old unregistered current address is never assigned to a new request');
});

test('subscription Result failure rejects before returning the address but keeps its reservation after restart',async()=>{
 const f=fixture(),fresh=bitcoin.payments.p2wpkh({hash:Buffer.alloc(20,30),network:bitcoin.networks.regtest}).address;
 const subscriptions=[];let index=0;
 const addresses=[address,other,fresh];
 const wallet={generateNewReceiveAddress:async()=>({isErr:()=>false,value:{address:addresses[++index]}}),
 electrum:{subscribeToAddresses:async value=>{subscriptions.push(value);return{isErr:()=>index===1};}}};
 await assert.rejects(allocateWatchedReceiveAddress({store:f.open(),wallet,current:async()=>addresses[index],network:'regtest'}),{code:'ADDRESS_FAILED'});
 assert.deepEqual(JSON.parse(f.disk).issuedAddresses,[other]);
 assert.equal(await allocateWatchedReceiveAddress({store:f.open(),wallet,current:async()=>addresses[index],network:'regtest'}),fresh);
 assert.deepEqual(subscriptions,[{scriptHashes:[receiveAddressScriptHash(other,'regtest')]},{scriptHashes:[receiveAddressScriptHash(fresh,'regtest')]}]);
 assert.deepEqual(f.open().list(),[]);
});

function lightningOnly(tag=50){const row=request(tag);return{...row,address:null,uri:row.bolt11};}
test('Lightning-only requests persist, replay canonically and coexist with unchanged Bitcoin requests',async()=>{
 const f=fixture(),store=f.open(),bitcoinRequest=request(49),row=lightningOnly();
 const bitcoinSaved=await store.register(bitcoinRequest,checks(bitcoinRequest));
 const noAddressRead={getInvoice:hash=>hash===row.paymentHash?row:null,ownsAddress:()=>assert.fail('Lightning-only request has no Bitcoin address to prove')};
 const saved=await store.register(row,noAddressRead);
 assert.equal(saved.address,null);assert.equal(saved.uri,row.bolt11);assert.equal(saved.bitcoinTracking,'lightning-only');
 assert.deepEqual(f.open().list(),[bitcoinSaved,saved]);
 assert.deepEqual(await f.open().register({...row,id:'reimport-lightning'},{getInvoice:()=>assert.fail('canonical replay'),ownsAddress:()=>assert.fail('no address')}),saved);
 const another=lightningOnly(51);delete another.address;another.uri='lightning:'+another.bolt11;
 const third=await f.open().register(another,{getInvoice:()=>another,ownsAddress:()=>assert.fail('no address')});
 assert.equal(third.address,null);assert.equal(third.bitcoinTracking,'lightning-only');
 assert.equal(f.open().list()[0].bitcoinTracking,'unique');
});
test('Lightning-only registration still requires exact signed invoice, network, amount and owning wallet',async()=>{
 const row=lightningOnly(),f=fixture();
 await assert.rejects(f.open().register(row,{getInvoice:()=>null,ownsAddress:()=>true}),{code:'RECEIVE_REQUEST_NOT_OWNED'});
 const mismatches=[{...row,uri:row.uri+'?amount=1'},{...row,uri:request(99).bolt11},{...row,uri:request().uri},
 {...row,address},{...row,amountSats:5000},{...row,paymentHash:'00'.repeat(32)},{...row,expiresAt:row.expiresAt+1000}];
 for(const bad of mismatches)await assert.rejects(f.open().register(bad,{getInvoice:()=>row,ownsAddress:()=>true}),{code:'INVALID_RECEIVE_REQUEST'});
 await assert.rejects(new ReceiveRequestStore({...f.options,network:'mainnet'}).register(row,{getInvoice:()=>row,ownsAddress:()=>true}),{code:'INVALID_RECEIVE_REQUEST'});
 assert.equal(f.writes,0);
 const saved=await f.open().register(row,{getInvoice:()=>row,ownsAddress:()=>false});
 const upgraded={...row,address,uri:'bitcoin:'+address+'?amount=0.0001&lightning='+row.bolt11};
 await assert.rejects(f.open().register(upgraded,{getInvoice:()=>row,ownsAddress:()=>true}),{code:'RECEIVE_REQUEST_CONFLICT'});
 assert.deepEqual(f.open().list(),[saved]);
});
test('exhausted address gap does not prevent saving further Lightning-only invoices or corrupt address reservations',async()=>{
 const f=fixture(),store=f.open();store.rememberAddress(address);
 await assert.rejects(store.allocateAddress(async()=>address,async()=>address),{code:'RECEIVE_ADDRESS_LIMIT'});
 const reserved=JSON.parse(f.disk).issuedAddresses;
 for(const tag of[60,61]){
  const row=lightningOnly(tag);await store.register(row,{getInvoice:()=>row,ownsAddress:()=>assert.fail('no address')});
 }
 assert.deepEqual(JSON.parse(f.disk).issuedAddresses,reserved);
 const reopened=f.open();assert.ok(reopened.list().every(r=>r.bitcoinTracking==='lightning-only'));
 assert.equal(await reopened.allocateAddress(async()=>address,async()=>other),other);
});
