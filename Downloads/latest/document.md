# Payment-Collector Developer Handoff

Last updated: 2026-02-17

## 1) Project summary

Payment-Collector is a full-stack crypto recurring payment app:

- Receiver creates a plan (token, amount, interval, wallet, network).
- App generates a pay link and QR code.
- Payer opens pay page, connects wallet, approves/permits, and activates subscription.
- After successful activation, pay page redirects user back to wallet app (Trust/MetaMask deep link).
- Backend scheduler executes recurring charges on-chain and dashboard shows live status/history.

This repo supports wallet-specific pay UI:

- Trust Wallet style UI
- MetaMask style UI

UI brand selection happens from detected wallet provider and/or `?wallet=trust|metamask`.

## 2) Tech stack

- Client: React + Vite + Tailwind + wouter (`client/`)
- Server: Express + sessions (`server/`)
- DB: Postgres + Drizzle (`shared/schema.ts`, `server/db.ts`)
- Contracts: Solidity + Hardhat (`contracts/`, `test/`)
- EVM integration: ethers v6

Build outputs:

- Client bundle: `dist/public`
- Server bundle: `dist/index.cjs`

## 3) Repository map

- `client/src/pages/pay.tsx`: main payment flow (Trust and MetaMask UIs)
- `client/src/pages/open-pay.tsx`: QR/mobile helper page ("Open in wallet")
- `client/src/components/qr-code-dialog.tsx`: QR rendering and modal
- `server/routes.ts`: API routes
- `server/scheduler.ts`: recurring execution tick
- `server/storage.ts`: DB data access layer
- `server/crypto.ts`: executor key encryption/decryption
- `shared/schema.ts`: Drizzle schema
- `shared/contracts.ts`: token registry + contract ABI + network contract mapping
- `contracts/CryptoPaySubscription.sol`: subscription smart contract
- `test/CryptoPaySubscription.test.cts`: contract tests

## 4) Runbook (local)

Prerequisites:

- Node.js 20+
- Postgres DB

Steps:

1. Install dependencies:
   `npm install`
2. Create `.env` from `.env.example`
3. Push schema:
   `npm run db:push`
4. Start dev server:
   `npm run dev`
5. Open:
   `http://localhost:5000`

## 5) Commands

- Dev: `npm run dev`
- Build: `npm run build`
- Start production bundle: `npm start`
- Typecheck: `npm run check`
- Push DB schema: `npm run db:push`
- Contract tests: `npm test`
- Hardhat compile: `npm run hardhat:compile`

## 6) Environment variables

Required:

- `DATABASE_URL`
- `SESSION_SECRET`

Recommended:

- `CRON_SECRET` (protects `/api/cron/scheduler`)
- `EXECUTOR_PRIVATE_KEY` (fallback executor)
- `ENCRYPTION_MASTER_KEY` (recommended, and required in production for new key encryption)
- `SEPOLIA_RPC_URL`
- `RPC_TIMEOUT_MS` (default `8000`)
- `TX_CONFIRMATIONS` (default `3`)
- `SCHEDULER_CHECK_INTERVAL_MS` (default `15000`, minimum `5000`)

Deployment/verification only:

- `DEPLOYER_PRIVATE_KEY`
- `ETHERSCAN_API_KEY`
- `POLYGONSCAN_API_KEY`
- `BSCSCAN_API_KEY`
- `ARBISCAN_API_KEY`

## 7) Main flows

### Receiver flow

1. Register/login
2. Add wallet(s)
3. Create plan
4. Share pay link / QR
5. Track stats, subscribers, and transactions in dashboard

### Payer activation flow

1. Open `/pay/:code` (or `/open/pay/:code` from QR)
2. Connect wallet
3. Enter amount (first payment)
4. Approve or sign permit
5. Confirm activation tx
6. On success, payment page exits flow and deep-links back to wallet app

### Session page behavior

- Internal session page route is disabled in router (`/session/:subscriptionId` removed).
- Subscription tracking happens in receiver dashboard (`Subscribers` + `Transactions`) with live refresh.

### Recurring execution flow

1. Scheduler tick runs 15s by default (`server/scheduler.ts`)
2. Interval is configurable with `SCHEDULER_CHECK_INTERVAL_MS` (minimum 5000 ms)
3. Finds due subscriptions
4. Executes on-chain `executeSubscription`
5. Waits confirmations (`TX_CONFIRMATIONS`)
6. Updates DB execution state + logs

## 8) Wallet-specific UI behavior

Payment page (`client/src/pages/pay.tsx`) has two branches:

- MetaMask branch: `isMetaMaskUi && uiStage === "send"/"confirm"`
- Trust branch: default branch (`uiStage === "send"/"confirm"`)

Wallet brand comes from:

- Provider detection (`wallet.walletBrand`)
- URL hint (`?wallet=trust|metamask`)

Open-pay helper (`client/src/pages/open-pay.tsx`) offers:

- Open Trust Wallet
- Open MetaMask
- Copy link
- Continue in browser

Post-activation behavior (`client/src/pages/pay.tsx`):

- Attempts to close current page (best effort)
- Opens wallet app deep link:
  - MetaMask: `metamask.app.link`
  - Trust Wallet: `link.trustwallet.com/open_url`
- Uses fallback browser redirect if app switch is blocked

## 9) API overview

Auth:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/wallet`
- `POST /api/auth/executor-key`
- `GET /api/auth/executor-key`
- `DELETE /api/auth/executor-key`

Dashboard:

- `GET /api/dashboard/stats`
- `GET /api/dashboard/subscribers`
- `GET /api/dashboard/transactions`

Wallets:

- `GET /api/wallets`
- `POST /api/wallets`
- `DELETE /api/wallets/:id`
- `PATCH /api/wallets/:id/default`

Plans:

- `GET /api/plans`
- `POST /api/plans`
- `DELETE /api/plans/:id`
- `PATCH /api/plans/:id/wallet`
- `PATCH /api/plans/:id/recurring-amount`
- `GET /api/plans/code/:code`
- `GET /api/plans/:id/subscriptions`

Subscriptions:

- `GET /api/subscriptions/check/:planId/:payerAddress`
- `POST /api/subscriptions`
- `PATCH /api/subscriptions/:id/approval`
- `POST /api/subscriptions/:id/tx`
- `PATCH /api/subscriptions/:id/cancel`
- `PATCH /api/subscriptions/:id/cancel-onchain`
- `GET /api/subscriptions/:id`
- `GET /api/subscriptions/:id/logs`

Ops:

- `GET /api/quote`
- `GET /api/cron/scheduler` (Bearer `CRON_SECRET`)

## 10) Database tables

Defined in `shared/schema.ts`:

- `users`
- `wallets`
- `plans`
- `subscriptions`
- `scheduler_logs`
- `scheduler_state`
- `session` (session store)

## 11) Contract notes

Main contract: `contracts/CryptoPaySubscription.sol`

Key functions used by app:

- `activate`
- `activateWithPermit`
- `executeSubscription`
- `cancelSubscription`
- `updateSubscription`
- `updateReceiver`
- `getSubscription`

Contract registry and ABI:

- `shared/contracts.ts`

## 12) Deployment notes

Node service deployment:

- Build: `npm run build`
- Start: `npm start`
- Ensure env vars are set

Server port:

- `PORT` env, default `5000`

Important:

- In always-on deployment, scheduler starts automatically from `server/index.ts`
- In serverless setups, use `/api/cron/scheduler` externally on a schedule

## 13) Production checklist

Before go-live:

1. Set strong secrets (`SESSION_SECRET`, `CRON_SECRET`, `ENCRYPTION_MASTER_KEY`)
2. Set stable RPC provider(s), especially Sepolia if used
3. Fund executor wallet for gas
4. Confirm scheduler endpoint is protected
5. Run checks:
   - `npm run check`
   - `npm run build`
   - `npm test`
6. Validate wallet UX on real mobile devices:
   - Trust Wallet in-app browser
   - MetaMask in-app browser
7. Verify recurring execution end-to-end on testnet

## 14) Troubleshooting quick notes

- Wallet not detected:
  open via `/open/pay/:code` and then launch inside wallet app.
- Wrong network:
  switch wallet chain to plan network before confirm.
- `insufficient funds for intrinsic transaction cost`:
  native gas coin is too low (ETH/BNB/MATIC etc.), not token balance. Fund sender and executor wallet native coin.
- Scheduler not executing:
  check executor key, native gas balance, RPC connectivity, and `scheduler_logs`.
- Build warnings about chunk size:
  expected currently; app still builds successfully.

## 15) Suggested first tasks for next developer

1. Add full integration tests for pay flow (Trust + MetaMask UI branches).
2. Add API integration tests around subscription auth/cancel/update behavior.
3. Improve observability (metrics + alerts) around scheduler failures.
4. Add explicit runbooks for incident response and reconciliation.

## 16) Keys + command guide

- See `KEYS_AND_COMMANDS.md` for a detailed key-generation, environment, and command reference.
