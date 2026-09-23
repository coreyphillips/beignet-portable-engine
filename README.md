# Beignet portable engine

This local fork runs the real Beignet Bitcoin and Lightning engine inside a browser worker or React Native Hermes. Keys, signatures, BOLT 8 transport encryption, channel state and payment state stay in the device runtime. The optional sibling `beignet-relay` forwards encrypted Lightning bytes and Electrum JSON; it is not a wallet daemon and never receives a seed or signing key.

Source baseline: upstream Beignet `0.21.12`, commit `79bfc46` (full source commit recorded in `package.json`). The baseline is recorded in `package.json` (`upstreamVersion`, `upstreamCommit`) and substituted into the bundle at build time, so `GET /api/config` reports `0.21.12-portable` rather than a hand-maintained string. Upstream documentation is preserved in [README.upstream.md](README.upstream.md); the original CLI/package exports described there are **not** this package's exports. MIT license retained.

## Build and validation

```sh
npm install
npm run build
npm test
npm run test:regtest
```

`test:regtest` is explicit and creates only disposable regtest wallets, mines local test coins, runs funded Lightning receives/sends and an external splice through the actual portable bundle and byte relay, then checks restart persistence. It needs the existing local Docker `bitcoin` and `electrum` services, sibling shared/relay dependencies, and a built original Beignet primary. Override `BEIGNET_SOURCE_DIR` to relocate that original source path and `BEIGNET_REGTEST_BITCOIN` to change the Bitcoin container name. It never selects mainnet. `npm run test:smoke` exercises an unfunded disposable wallet against the existing local CLN at port 19846.

## Package entry points

```ts
import {
  createPortableRuntime,
  createRelaySocketFactory,
  DEFAULT_PRIMARY,
} from '@beignet/portable-engine';
import { createSqlJsDatabaseFactory } from '@beignet/portable-engine/sqljs';
```

The root is a self-contained browser ESM (`dist/portable.mjs`) or Hermes-compatible CommonJS bundle (`dist/portable.cjs`) with no Node builtin imports. The SQLite WASM adapter is separate, so React Native does not import WASM. The browser serves `node_modules/sql.js/dist/sql-wasm.wasm` and supplies `locateFile`.

```ts
const databaseFactory = await createSqlJsDatabaseFactory({
  load: path => volume.read(path),
  save: (path, bytes) => volume.write(path, bytes),
  locateFile: name => `/engine/${name}`,
});
const socketFactory = createRelaySocketFactory({
  electrumUrl: 'wss://relay.example/electrum',
  peerUrl: 'wss://relay.example/peer',
  token: relayToken,
  electrum: { host: 'electrum.relay', port: 50001, tls: false },
});
const runtime = await createPortableRuntime({
  databaseFactory,
  volume,
  socketFactory,
  electrum: { host: 'electrum.relay', port: 50001, tls: false },
});
// Shared EmbeddedWalletClient calls runtime.request directly, without HTTP.
const wallets = await runtime.request({ method: 'GET', path: '/api/wallets' });
await runtime.close();
```

The logical Electrum host selects the relay's fixed `/electrum` target; upstream TLS and certificate verification belong to the relay. A startup genesis-header check verifies the selected Bitcoin network before constructing the node or permitting channel activity. Native TCP adapters instead use an actual Electrum target. A changed platform connection is used on the next runtime startup and verified again.

The relay handshake sends protocols `beignet.v1` and `auth.<raw-base64url-token>`. Use WSS outside explicit loopback/development emulator transport. The peer's real public key remains in the configured primary URI, and BOLT 8 authenticates it inside the wallet. Each connection token must be provisioned for that primary's corresponding fixed upstream target. The injected transport owns destination routing, including relay-side Tor; the portable peer manager does not add a second SOCKS handshake. Native direct TCP rejects onion destinations.

## Persistence and lifecycle contract

- `volume.read(path)` returns bytes or null. `write`, `remove`, and `rename` are synchronous, durable operations. The platform must encrypt **the whole volume**, including registry/seed, database, activity and backups. The engine additionally preserves upstream encrypted SQLite rows. Browser uses the sibling encrypted OPFS two-slot vault; RN uses encrypted SQLCipher plus a Keychain-held random key.
- SQLite methods are better-sqlite3 compatible: `prepare().run/get/all/iterate`, `exec`, `pragma`, synchronous `transaction`, `close`, and optional `backup`. BLOB columns must return the `buffer` package's Buffer values. SQL.js exports and persists on every outer transaction and standalone mutation; any failed save poisons the driver, preventing subsequent channel writes.
- Schema creation/migration runs in one transaction. Only reconstructable public gossip rows are coalesced, for at most 100 ms or 500 distinct rows. Channel, key, invoice, payment, outbox and recovery commits remain synchronous. A crash can lose a small portion of the public gossip cache, which is fetched again. Gossip loads, checkpoints, backups and close flush the cache.
- Acquire a platform-wide exclusive wallet lease **before** creating a runtime, and release it only after `close()` succeeds. The engine enforces one runtime per JS realm; the platform must also prevent multiple tabs/workers/processes using the same vault. Do not copy an active channel database between devices.
- Registry and mnemonic are one atomic volume entry. Creation returns the recovery phrase even when later network startup fails, along with a stopped/failed setup record. `/lfbw/setup` can retry startup. `close()` rejects new requests and drains active operations before shutdown; failed shutdown must not be treated as safe to delete or lock storage.

`runtime.request({method,path,body})` returns raw manager/daemon-shaped results, with `Error.code` and `Error.status` failures. It implements the shared LFBW client's lifecycle, balance, activity, send/receive, primary settings, and explicit recovery-phrase routes. It does not run an HTTP server. One wallet lives in each vault. Recovery phrase retrieval is explicit; record/config/activity queries never include it.

Address sends durably record a request ID before dispatch. Retrying the same ID does not resubmit. Accepted splices remain pending until chain evidence proves the transaction spends the recorded prior funding outpoint and pays the requested destination and amount. A positive matching Electrum history height marks completion. Missing evidence remains pending/uncertain; a channel balance change alone never proves a payment.

## Fork changes and limits

- `portable/*`: real noble hash/AES-GCM/ChaCha20-Poly1305 compatibility, injected filesystem/SQLite/TCP interfaces, WebSocket transport adapter, local lifecycle/API, durable activity proof, network verification and globals. The globals give the bundled `buffer` polyfill the `base64url` encoding Node has had since v15: the direct-funding envelope in every unified receive request is minted in that encoding, and without it the mint threw and every request on the phone and in the browser silently degraded to a plain address and invoice, so no payer could ever fund by splice.
- `src/lightning/storage/sqlite-storage.ts` and `reconstructable-batch.ts`: atomic initialization and optional gossip cache batching for snapshot drivers.
- Guarded optional timer `unref()` calls in Beignet node, transport and channel modules support browser/native numeric timer handles. The CLI wrapper also retains a connection-error cause for optional local diagnostics, and the peer manager honors injected transport routing. Core channel negotiation, key derivation, signing and recovery transitions are upstream code.
- The swap providers, reverse (Lightning to on-chain) added in 0.15.0 and submarine (on-chain to Lightning) added in 0.16.0, under `src/lightning/swaps/` with `GET /swaps/status`, `GET /swaps` and `POST /swaps/cancel`, are **not** exposed and are never enabled. Serving a swap in either direction locks this node's own coins in contracts for peers; both are provider roles, off by default upstream, and neither is a wallet feature. Every swap path is gated behind `config.swaps.enabled`, which this runtime never sets, so no provider is constructed; the modules are still bundled because `lightning-node.ts` imports them statically. The engine ships no wallet-side swap client.
- `GET /channels` annotates each channel with `fundingConfirmed`, from a cached Electrum lookup of its funding transaction. A trusted (zero-conf) channel reaches `NORMAL` at depth 0 and upstream reports no confirmation depth, so without this a wallet cannot tell a settled channel from one whose funding is still only a mempool promise. The field is absent when the answer is not known, and absent means unknown rather than unconfirmed. This matters because a splice spends the funding output. Through 0.16.0 the engine cleared `spliceInFlight`, the only home of the signed splice hex, when the peer said a zero-conf splice was locked, which is before any chain evidence, so a first broadcast the network refused was never retried. 0.17.0 fixes that upstream: a zero-conf channel now keeps each splice transaction in a durable `unconfirmedSpliceTxs` list until the chain has it, both rebroadcast drivers read that list, and a permanently failed broadcast surfaces as a `BROADCAST_PERMANENT_FAILURE` node error. The annotation stays because upstream still reports no confirmation depth for a zero-conf channel, and the shared client still uses it to refuse a Bitcoin-address send until the funding confirms. 0.18.0 and 0.19.0 harden the splice path further: a stranger's direct-funding splice locks at a confirmation depth rather than at broadcast and is reverted by agreement with the peer if one of its inputs is spent elsewhere (`splice:conflicted`, `splice:reverted`, node error `SPLICE_INPUT_CONFLICT`), a force close can no longer adopt a splice that is confirmed but below its lock depth, the HTLC backstops no longer force-close a splicing channel, a retracted splice sighting no longer suppresses a later valid conflict, and a funding spend mined below `minimumDepth` is detected when the depth arrives. None of these add a route, a config flag or a storage migration; the new channel-state fields are optional on read. The portable rules now arm `allowUnpairedSplice` alongside `allowSplice`, as the host manager does, so a payer this wallet has never paired with grows the one home channel instead of opening a second; its splice locks at the engine's default depth of three confirmations. The runtime records an unpaired funding in flight and the channel's last splice conflict or revert on the wallet record (`lfbw.unpairedFunding`, `lfbw.lastSplice`), which is how the shared client narrates them without an event stream.
- A splice submission that shows no chain effect, has no splice in flight and has stopped progressing is reported as `uncertain` rather than staying `pending` for the life of the wallet. Reconciliation could previously only promote a row to `completed`, so a submission that never reached the chain had no other outcome.
- The JIT opening fee is collected as a `skim` (deducted from the delivery). 0.15.0 added `hop` mode, where the sender pays the fee as a routing fee named in the invoice hint; `POST /jit/invoice` now echoes the agreed `feeMode`. The shared client asks for `skim` explicitly and refuses any other mode, because the receive quote shown to the user priced a deduction.
- Listening TCP/HTTP/WebSocket servers, Node DNS bootstrapping, guardian HTTP service, automatic remote HTTPS gossip downloads and wire-capture streams are not exposed by the embedded API. Unsupported server services fail explicitly. Outbound peer gossip remains enabled so multi-hop routes can be discovered.
- SQLite WASM snapshotting is less efficient than native SQLite. A full mainnet gossip graph still carries CPU, memory and disk costs; the automated funded integration uses a small regtest graph. Large-graph production performance is not established by those tests.
- Browser engines must stay open to participate in Lightning. Mobile operating systems may suspend Hermes in the background; native push/wake/background execution is not implemented here. Peer-storage recovery is enabled, but loss of current channel state cannot be repaired from the seed alone in every situation. Retain the encrypted vault and test backups.
- This is a working local prototype fork with live regtest validation, not a production security audit or a mainnet funded test. Host mode remains available where worker storage or native adapters are unavailable.

## Bitcoin receive tracking

`GET /wallets/:id/api/receive/onchain?address=…` reads the wallet’s configured Electrum server and returns `{ address, receivedSats, confirmedSats, transactions }`. Each transaction contains `{ txid, amountSats, height, confirmed }`. Amounts count only raw transaction outputs matching the exact network/address script after verifying the transaction ID. Spending inputs, wallet-wide net balances, other recipients and duplicate history entries do not count. Each lookup uses current history so dropped/replaced transactions and reported reorgs are reflected.

Confirmation means the configured server reports a positive history height; this endpoint does not perform an additional SPV proof. Lookups fail visibly on malformed evidence, more than 64 history entries, or unavailable responses, with up to four transaction reads at once, five seconds per read and a twelve-second overall deadline. The standalone host uses the same parser from the generated `dist/receipts.cjs`; `npm run build` produces that file along with the portable bundle.

## Durable unified receive requests

The shared client saves the exact original BIP21 request through `POST /wallets/:id/api/receive/requests` with `{request}` before displaying it. `GET` on the same route returns `{requests}`, including expired invoices, even while the node is stopped. The stored row preserves its original public request fields and adds invoice-derived `createdAt`, `network`, and `bitcoinTracking: "unique" | "ambiguous" | "lightning-only"`. POST returns `{request}`. Neither route returns a preimage, payment secret or mnemonic.

Registration verifies the signed BOLT11 network, hash and amount; exact BIP21 invoice/address/amount agreement; ownership of the invoice and Bitcoin address; and immutable hash/ID bindings. Repeating the same original URI returns the canonical saved row even if the invoice was later pruned. Altering its address, amount or URI is refused. Records live in encrypted-volume `/wallet/receive-requests.json`; a failed write is never acknowledged. Bounds are 5,000 request records, 10,000 reserved addresses and a 16 MiB envelope.

Portable `/address/new` reserves a fresh derived address before returning and requires successful notification subscription for its exact script. It always advances past the old current address, because an upgraded wallet may have shared that address in a request predating the metadata store. Concurrent calls and restarts preserve reservations. Failed subscriptions leave the address reserved; retry advances again. The existing wallet gap limit is respected. At `RECEIVE_ADDRESS_LIMIT`, the shared client creates a Lightning-only request with a visible explanation, so Lightning-only use does not eventually block receiving. It catches only that typed limit; address/network/storage failures remain errors. No untracked address derivation, address reuse or gap-limit override is used.

Old invoices do not contain their original unified Bitcoin address. There is no amount/date-based migration. Importing an original saved BIP21 URI can add a verified link; missing originals remain Lightning-only invoice history. When importing multiple requests that share an address, every matching row reports `bitcoinTracking: "ambiguous"`; clients must track their Lightning hashes but never assign a Bitcoin receipt to either request automatically. Read the current registry when tracking, because a later import can reveal ambiguity.

`npm run test:smoke` also checks two concurrent unpaid requests through the real engine, signed invoice registration, shared-client consumption, canonical replay, and registry/address reservation persistence across a complete engine restart. It creates no payments or channels.

Lightning-only metadata uses `address: null` (an omitted address is normalized to null), `uri` equal to the exact BOLT11 or `lightning:` followed by it, and backend-derived `bitcoinTracking: "lightning-only"`. The signed invoice, wallet ownership, network, hash, amount and expiry are still verified. No Bitcoin address lookup or attribution occurs. The nullable address is part of the immutable binding, so an existing Lightning-only request cannot later be rebound to a Bitcoin address. Both request forms survive restart in the same store.

## Offline receiving

Receiving offline is an opt-in on the receive screen, never the default. A fixed-amount request prepares a durable reservation, and the wallet can close after sharing it. Reopening discovers settled receipts and updates the ordinary balance and Activity. Unpaid requests remain payable until expiry.

An offline receive only uses a channel that already exists with the primary: usable, holding none of this wallet's balance, and with inbound of at least the amount plus 50,000 sats. It never asks the primary to open one. With no such channel, the ordinary request (a JIT invoice or a direct-funding envelope) is how the wallet receives.

`GET /receive/offline` answers `{ maxSats }`: the largest amount one channel can hold offline right now, or 0 when none can hold the 354 sat minimum. The apps offer "Receive offline" only above 0. `GET /receive/quote` refuses with `RECEIVE_UNAVAILABLE` before contacting the primary when no channel can hold the amount.

This requires a Beignet 0.21.8 or newer primary with settlement enabled. The app reports unsupported preparation without silently issuing an online-only invoice.

See [FFOR validation](FFOR-VALIDATION.md) for simulator and funded regtest evidence, commands, and deployment limits.

## Continuous integration

The portable fork builds and runs its own tests, checks public TypeScript declarations, checks JavaScript syntax, and audits dependencies. The upstream CLI and recovery suites remain in Beignet. `npm run test:relay:integration` additionally exercises the unpublished sibling `beignet-relay` checkout; the default tests use a local WebSocket server and need no sibling repositories.
