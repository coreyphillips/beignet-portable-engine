# Automatic offline receive validation

Validated on September 18, 2026, against Beignet 0.21.7 plus the accompanying automatic-receive protocol changes.

The ordinary fixed-amount Receive flow now prepares and saves a reservation before returning an invoice. Startup and background reconciliation discover settled receipts without invalidating unpaid requests. No FFOR screen, manual recovery button, or user-managed reservation is required.

## Verified behavior

- Funded portable regtest: normal Receive, restart while unpaid, payment with the receiver stopped, automatic credit of 20,000 sats, one completed Activity entry, and persistence through another cold reopen.
- A second invoice allocates a separate provider-funded channel while previously received funds remain usable, then automatically recovers another offline payment.
- Isolated iOS 26.2 simulator: actual Hermes, Keychain, SQLCipher and native TCP. The app process was terminated after invoice creation. A separate payer completed the payment while it was stopped. Two cold launches verified automatic recovery and no duplicate receipt.
- Production web worker: encrypted durable storage, worker shutdown before payment, automatic recovery on reopening, and a second restart without duplicate Activity. This exercises the production worker bundle in a browser-like realm, not browser UI compatibility.
- Protocol regression: 187 FFOR and receipt-service checks pass. Dedicated coordinator tests cover unpaid retention, expiry grace, interrupted creation, epoch changes, and shutdown. Shared client tests verify use of the new receive route and refusal to silently downgrade when the provider does not support it.

`npm run test:regtest:ffor` runs the funded portable regression. `scripts/regtest-ffor-native.cjs` drives the separate Chicory `native-tests/OfflineReceive.tsx` entry with `FFOR_SIMULATOR_ID` pointing to an isolated simulator and bundle id `com.chicory.ffor-test`. These use disposable local regtest wallets and never a mainnet wallet.

## Deployment requirements and limits

The primary must run the accompanying Beignet service changes with `fforSettle.enabled` and, when new receive channels are needed, an explicit `fforReceiveFunding` budget. Stock 0.21.7 and older providers do not implement the new receipt queries or allocation requests. An unsupported provider fails preparation before an invoice is shared.

The receiver uses an empty inbound channel or obtains a separately funded channel. It never freezes a channel holding spendable local funds. Provider funding limits are cumulative across restarts, including failed allocations. They do not automatically reset; repeated receiving can need additional channels until an empty suitable channel can be reused.

Invoices need an amount supported by the voucher book. Amountless and below-trim payments are not supported by this automatic path. Discovery depends on the settlement peer returning and does not replace independent witnesses or automatic enforcement against an unavailable or dishonest peer. No automatic force close is introduced.

See the Beignet `docs/AUTOMATIC-OFFLINE-RECEIVE.md` document for provider configuration, peer messages, and safety boundaries.
