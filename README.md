# Ajocircle

Ajocircle is a NEAR testnet prototype for rotating savings circles. Members contribute the same amount each round, and the circle contract sends the pot to the member assigned to that round. The prototype uses AJUSD test tokens; it has no real money, naira on-ramp, or redemption.

## Repository map

- `frontend/` — React and TypeScript web app.
- `contracts/circle/` — Rust NEAR contract for circles, contributions, payout approvals, and DAO-related contract methods.
- `contracts/test-token/` — Rust NEP-141 AJUSD test token and faucet.
- `scripts/` — testnet inspection, deployment, funding, and transaction-flow scripts.
- `AJOCIRCLE_PROJECT_BRIEF.md`, `AJOPOOL_SPUTNIK_BRIEF.md`, `PROJECT_SOURCE_OF_TRUTH.md` — product and protocol decisions and project notes.

`clean-app/` is a separate starter/reference project, not the Ajocircle app. `edge-debug-profile/` is local browser data. Neither is part of the application source.

## Run the web app

Requirements: Node.js and npm.

```powershell
cd frontend
npm install
npm run dev
```

Vite serves the app at `http://localhost:5181/`. The production bundle can be built with `npm run build` from `frontend/`.

## Contracts

Both contracts are NEAR Rust projects. To run local checks/builds, use a Rust toolchain with the NEAR Wasm target installed:

```powershell
cd contracts/circle
cargo test
cargo check --target wasm32-unknown-unknown
```

The test-token contract is in `contracts/test-token/` and uses `near-contract-standards`. Testnet deployment and verification scripts are in `scripts/` and `frontend/scripts/`. They require testnet configuration and signing keys in ignored local environment files; never commit those keys.

## Prototype boundary

The frontend connects to NEAR testnet and includes signed flows for creating and joining circles, getting AJUSD test tokens, contributing, and requesting/confirming payouts. The contract enforces contribution and payout rules. Circle DAO creation and removal governance are not yet part of the regular frontend flow; contract-level DAO behavior has separate testnet notes in `PROJECT_SOURCE_OF_TRUTH.md`.

Activity and round status are read from contract views; there is no event indexer or complete historical activity ledger. Display names are saved in the current browser and are not written to the contract. Review money-related actions on testnet only.

## Testnet deployments

- Circle contract: `ajopool.testnet`
- Test token: `ajusd.ajopool.testnet` (`AJUSD`, six decimal places)
- Network: NEAR testnet

The on-chain account names retain the original `ajopool` identifier; the product brand is Ajocircle.
