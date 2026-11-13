# Ajocircle

Ajocircle is a NEAR testnet prototype for small rotating savings circles. Members contribute the agreed amount each round; a second member approves release of the pot to the recipient fixed by the circle's slot order.

## Run the frontend

From this directory:

```powershell
npm install
npm run dev
```

Vite serves the app at `http://localhost:5181/`.

## Testnet contracts

- Circle contract: `ajopool.testnet`
- Test token: `ajusd.ajopool.testnet` (`AJUSD`, 6 decimal places)
- The token has a test faucet and no real value or redemption.
- Circle 7 completed a two member, two round contribution and payout cycle on testnet. The executed flow and checks are in `scripts/exercise-nep141-round.mjs` at the repository root.

All token balances and transactions in this prototype are testnet only. There is no naira on-ramp or off-ramp.

## Current implementation boundary

The Rust circle contract accepts NEP-141 contributions, records each member's payment, requires a request and a second member's approval, and pays only the recipient fixed by the round slot. It advances the round only after the token transfer succeeds. Existing native-NEAR circles remain supported for compatibility.

The create form now submits `create_token_circle` and then `join` for the organizer's first slot through the Privy-linked NEAR account. This flow compiles but still needs a live signed-transaction run. Other members cannot yet join through the UI; contribution and payout remain unconnected. The home and circle screens still contain sample content, and there is no member-filtered on-chain circle view or working invite link. Privy account preparation, onboarding/storage funding, and per-circle DAO creation still need end-to-end integration. Do not present the current frontend as a fully working app.

Each circle's Sputnik DAO is a separate governance layer for member removal and continue/end decisions. The completed token payout-cycle test did not create a DAO; DAO role synchronization was verified separately on testnet and is recorded in `PROJECT_SOURCE_OF_TRUTH.md` at the repository root.

## Contract checks

```powershell
cd ..\contracts\circle
cargo test
cargo check --target wasm32-unknown-unknown
```

The test-token contract is in `contracts/test-token/` and uses NEAR's `near-contract-standards` NEP-141 implementation.
