# FFOR compatibility and application readiness

Validated against upstream beignet 0.21.7 on 2026-09-18. This is a compatibility update and a reproducible audit, not an implementation of automatic offline receiving.

## What works

The portable engine includes the 0.21.7 fixes while preserving its browser and native transport, storage, timer and batching adaptations. The native and browser clients share this engine and the wallet core.

`npm run test:regtest:ffor` uses disposable local regtest wallets and tests these boundaries:

1. Normal wallet-core Receive creates an ordinary invoice and no FFOR reservation.
2. An explicitly prepared FFOR reservation reaches ACTIVE, and its invoice reaches durable storage before it is returned.
3. The receiver runtime stops and releases its storage. A separate payer completes a 20,000 sat payment while the receiver is stopped.
4. Reopening the receiver does not itself recover the payment.
5. Explicit recovery closes the reservation, credits exactly 20,000 sats, changes the invoice to PAID, and produces one completed Activity row.
6. The credited balance, PAID invoice and single Activity row survive a second cold reopen.
7. Recovering an unpaid reservation closes it. Paying its already issued invoice fails, even before its encoded expiry.

The script requires the local Bitcoin and Electrum regtest containers, the built upstream checkout selected by `BEIGNET_SOURCE_DIR`, and the sibling wallet-core and relay development checkouts. It mines test blocks and uses temporary wallet directories. It never uses a mainnet wallet.

## Why automatic receiving is not enabled

The ordinary Receive flow in wallet-core chooses `/invoice/create` or `/jit/invoice`. Neither creates an offline reservation. Updating the engine does not change that choice.

FFOR reserves fixed amounts on an existing funded channel. A JIT request that has no channel yet and an amountless request cannot simply be changed into a voucher invoice. The settlement peer must explicitly offer the service and accept the reservation's fee and budget terms.

An ACTIVE reservation freezes ordinary channel updates, including outgoing HTLCs and splices. The current app uses its primary channel for both sending and automatic on-chain funding. Silently reserving that channel would affect both.

Without a configured receipt witness, recovery learns the settlement result by closing the reservation. Closing stops admission of payments to every unpaid voucher. Calling recovery on every startup or foreground event would invalidate requests that users have already shared. Polling it while the receive screen is visible has the same problem.

The integration needs receipt discovery and a channel/reservation lifecycle that preserves unpaid invoices while allowing normal wallet operations. Options to evaluate include the existing witness protocol plus a dedicated receive channel, or a reviewed protocol extension. No unsafe automatic close, force-close, or fallback to an ordinary invoice is introduced here.

## Portable API additions

The runtime now passes through receiver epoch listing, individual epoch reads, explicit setup, durable voucher invoice creation and cooperative recovery. Recovery does not forward a caller's `forceCloseIfUnreachable` flag. These are integration surfaces, not an automatic UI policy. No new FFOR screen or setting is exposed to the wallet user.

## Release gate

Do not claim that normal Receive survives powering off the phone or closing the browser yet. Before enabling it by default, test a paid and unpaid request across cold start and foreground resume, settlement-peer outages, expiry, multiple requests, concurrent sends, funding/splices, repeated recovery, and both native SQLCipher and browser OPFS persistence. A simulator or physical-device end-to-end FFOR test is still required; Node runtime tests do not replace it.
