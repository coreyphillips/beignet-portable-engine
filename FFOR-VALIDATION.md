# Concurrent receive qualification

Target: published Beignet 0.25.0 at `db15cf581bf3f59a26280bdd955f1f08f2dbc182`.

The coordinator regression suite covers funded capacity, baseline and opt-out refusal, durable profile selection, busy retries, expired quote refresh, signed live sync, terminal outcomes, and retained unknown reservations through two coordinator reloads. Coordinator fixtures do not qualify actual mobile process death or wallet credit.

The funded runtime and encrypted worker passed the complete concurrent acceptance on Node 22.13.1. Wallet core was reviewed at commit `2a42a2c2a55195eb2e7854d5633f2ff6285d4552`. Portable tests: 108 passed. Public types passed.

One 500,000-sat home channel started with 100,000 sats owned by the receiver. With a 20,000-sat offline reservation live, ordinary payments of 5,000 sats out and 6,000 sats in completed. The receiver process or worker was terminated before the offline invoice was paid. Both cold starts reported 121,000 sats total, 116,000 sats available, and exactly one Activity entry for the offline payment. Redeeming the first voucher of a separate two-voucher book left its second invoice payable. Explicit early closure retained 17,000 sats and one unknown slot in DRAINING; ordinary payments still completed, leaving 147,000 sats total and 142,000 sats available.

The worker check bundles the production worker source from web commit `57449f6d7a148decab1d7f9a5d3a5cbc9336de10` against this engine. It uses the production encrypted vault and journal with durable OPFS handles in a browser-like realm that has no Node globals. Worker threads are terminated without graceful engine shutdown. This is storage and runtime qualification, not browser UI compatibility.

Run `npm run test:regtest:ffor`, `npm run test:regtest:ffor:worker`, and `npm run test:regtest:ffor:native`. The harness accepts explicit source locations through `BEIGNET_SOURCE_DIR`, `BEIGNET_WALLET_CORE_DIR`, `BEIGNET_RELAY_DIR`, and `BEIGNET_WEB_DIR`. Set `BEIGNET_EVIDENCE_FILE` to record balances and restart identities. Native runs require the isolated app from Chicory's qualification entry and `FFOR_MOBILE_PLATFORM`, `FFOR_MOBILE_DEVICE`, and `FFOR_MOBILE_APP`.

Packaged iOS and Android acceptance is still in progress. Mobile lifecycle support is not yet qualified.

The historical evidence below covers an older release and must not be used as evidence for concurrent receive. Its ordinary-receive and dedicated-channel behavior is superseded by explicit offline mode on one funded channel.

## Historical baseline evidence

# Automatic offline receive validation

Release baseline: Beignet 0.21.8, which includes the automatic-receive provider protocol. The published npm package was installed separately and passed the funded portable regression on September 18, 2026.

The ordinary fixed-amount Receive flow now prepares and saves a reservation before returning an invoice. Startup and background reconciliation discover settled receipts without invalidating unpaid requests. No FFOR screen, manual recovery button, or user-managed reservation is required.

## Verified behavior

- Funded portable regtest: normal Receive, restart while unpaid, payment with the receiver stopped, automatic credit of 20,000 sats, one completed Activity entry, and persistence through another cold reopen.
- A second invoice allocates a separate provider-funded channel while previously received funds remain usable, then automatically recovers another offline payment.
- Isolated iOS 26.2 simulator: actual Hermes, Keychain, SQLCipher and native TCP. The app process was terminated after invoice creation. A separate payer completed the payment while it was stopped. Two cold launches verified automatic recovery and no duplicate receipt.
- Production web worker: encrypted durable storage, worker shutdown before payment, automatic recovery on reopening, and a second restart without duplicate Activity. This exercises the production worker bundle in a browser-like realm, not browser UI compatibility.
- Protocol regression: 220 upstream 0.21.8 FFOR and receipt-service checks pass. Dedicated coordinator tests cover unpaid retention, expiry grace, interrupted creation, epoch changes, and shutdown. Shared client tests verify use of the new receive route and refusal to silently downgrade when the provider does not support it.

`npm run test:regtest:ffor` runs the funded portable regression. `scripts/regtest-ffor-native.cjs` drives the separate Chicory `native-tests/OfflineReceive.tsx` entry with `FFOR_SIMULATOR_ID` pointing to an isolated simulator and bundle id `com.chicory.ffor-test`. These use disposable local regtest wallets and never a mainnet wallet.

## Deployment requirements and limits

The primary must run Beignet 0.21.8 or newer with `fforSettle.enabled` and, when new receive channels are needed, an explicit `fforReceiveFunding` budget. Stock 0.21.7 and older providers do not implement the new receipt queries or allocation requests. An unsupported provider fails preparation before an invoice is shared.

The receiver uses an empty inbound channel or obtains a separately funded channel. It never freezes a channel holding spendable local funds. Provider funding limits are cumulative across restarts, including failed allocations. They do not automatically reset; repeated receiving can need additional channels until an empty suitable channel can be reused.

Invoices need an amount supported by the voucher book. Amountless and below-trim payments are not supported by this automatic path. Discovery depends on the settlement peer returning and does not replace independent witnesses or automatic enforcement against an unavailable or dishonest peer. No automatic force close is introduced.

See the Beignet `docs/AUTOMATIC-OFFLINE-RECEIVE.md` document for provider configuration, peer messages, and safety boundaries.
