# CryptoPay — Technical Documentation

> Recurring crypto subscription payments on EVM and TRON blockchains.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Tech Stack](#2-tech-stack)
3. [Setup Guide](#3-setup-guide)
   - [Prerequisites](#31-prerequisites)
   - [Environment Variables](#32-environment-variables)
   - [Local Development](#33-local-development)
   - [Production Deployment (Railway)](#34-production-deployment-railway)
   - [Smart Contract Deployment](#35-smart-contract-deployment)
4. [Architecture](#4-architecture)
5. [Features & Workflows](#5-features--workflows)
   - [Merchant Onboarding](#51-merchant-onboarding)
   - [Creating a Payment Plan](#52-creating-a-payment-plan)
   - [Subscriber Payment Flow — EVM](#53-subscriber-payment-flow--evm)
   - [Subscriber Payment Flow — TRON](#54-subscriber-payment-flow--tron)
   - [Recurring Payment Execution](#55-recurring-payment-execution)
   - [Billing Change Proposal Flow](#56-billing-change-proposal-flow)
   - [Webhook Notifications](#57-webhook-notifications)
   - [SDK Embedding](#58-sdk-embedding)
   - [Executor Key Management](#59-executor-key-management)
6. [API Reference](#6-api-reference)
7. [Database Schema](#7-database-schema)
8. [Smart Contracts](#8-smart-contracts)
9. [Multi-Chain Support](#9-multi-chain-support)
10. [Security](#10-security)

---

## 1. System Overview

CryptoPay is a full-stack platform that enables merchants to collect recurring crypto payments on-chain, similar to a Stripe Subscriptions product but for blockchain tokens. Merchants deploy their own subscription plans and a background scheduler automatically executes recurring charges on schedule — without requiring subscribers to sign a new transaction each cycle.

**Key capabilities:**

| Capability | Description |
|---|---|
| Recurring payments | Automated on-chain execution at any interval (seconds → months) |
| Multi-chain | EVM chains (Ethereum, Polygon, BSC, Avalanche, Arbitrum, Optimism, Base, Fantom) + TRON |
| Non-custodial | Funds go directly from subscriber wallet → merchant wallet via smart contract |
| Executor automation | Merchant's executor key triggers charges; subscribers approve once |
| Billing amendments | Merchants propose new terms; subscribers accept/reject from their wallet |
| Webhooks | Real-time HTTP callbacks on payment events |
| Embeddable SDK | Payment widget embeds on any website via `<script>` tag |
| QR payments | Signed, tamper-proof QR codes link directly to payment flows |

---

## 2. Tech Stack

### Frontend
| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Routing | Wouter |
| State/Data | TanStack React Query |
| UI Components | Radix UI + Tailwind CSS |
| EVM Wallets | Ethers.js v6 + MetaMask |
| TRON Wallets | TronWeb + TronLink |

### Backend
| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ (TypeScript via tsx) |
| Framework | Express 5 |
| Authentication | Passport.js + express-session |
| Database ORM | Drizzle ORM |
| Job Queue | BullMQ + Redis |
| EVM Interaction | Ethers.js v6 |
| TRON Interaction | TronWeb |
| Encryption | AES-256-GCM (optional AWS KMS) |

### Infrastructure
| Layer | Technology |
|---|---|
| Database | PostgreSQL (Neon / Railway) |
| Cache / Queue | Redis (Railway plugin) |
| Deployment | Railway (backend) / Vercel (alternative) |
| Smart Contracts | Hardhat (EVM), custom TRON deploy scripts |
| Contract Language | Solidity 0.8.20 (EVM), Solidity 0.8.0 (TRON/TVM) |

---

## 3. Setup Guide

### 3.1 Prerequisites

- Node.js 20+
- PostgreSQL database (Neon or Railway Postgres plugin)
- Redis instance (Railway Redis plugin)
- MetaMask and/or TronLink browser extensions (for testing)
- Deployed smart contracts (see §3.5)

### 3.2 Environment Variables

Create a `.env` file in the project root with the following variables:

#### Required — Core
```env
# PostgreSQL connection string
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Secret for signing sessions (long random string)
SESSION_SECRET=your_random_secret_here

# Redis for BullMQ job queues
REDIS_URL=redis://default:password@host:6379
```

#### Required — Encryption
```env
# 32-byte key for encrypting executor private keys in the database
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_MASTER_KEY=base64_encoded_32_bytes
```

#### Required — Executor Wallets
```env
# EVM chains: private key of the wallet that will execute recurring payments
EXECUTOR_PRIVATE_KEY=0x...

# TRON chain: private key of the TRON wallet that will execute recurring payments
TRON_EXECUTOR_PRIVATE_KEY=your_tron_private_key
```

#### Required — Smart Contracts
```env
# Used for deploying contracts (can be same as executor)
DEPLOYER_PRIVATE_KEY=0x...
```

#### Optional — RPC Endpoints
```env
# Override default public RPC nodes (recommended for production reliability)
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/...
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/...
BSC_RPC_URL=https://bsc-dataseed1.binance.org
AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
OPTIMISM_RPC_URL=https://mainnet.optimism.io
BASE_RPC_URL=https://mainnet.base.org
FANTOM_RPC_URL=https://rpc.ftm.tools

# Testnet
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/...
```

#### Optional — TRON Configuration
```env
# TRON Mainnet
TRON_MAINNET_FULL_NODE=https://api.trongrid.io
TRON_MAINNET_API_KEY=your_trongrid_api_key

# TRON Nile Testnet
TRON_NILE_FULL_NODE=https://nile.trongrid.io
TRON_NILE_API_KEY=your_nile_api_key

# Energy rental API (optional — rents TRON energy if executor is low)
TRON_RENTAL_API_KEY=your_rental_api_key

# Fee limit for TRON transactions (default: 100 TRX = 100000000 SUN)
TRON_FEE_LIMIT_SUN=100000000
```

#### Optional — Scheduler Tuning
```env
# How often the scheduler checks for due payments (milliseconds, default: 15000)
SCHEDULER_CHECK_INTERVAL_MS=15000

# Block confirmations before marking a payment as successful (EVM, default: 3)
TX_CONFIRMATIONS=3

# Time before abandoning a stuck pending transaction (ms, default: 1800000 = 30min)
PENDING_TX_MAX_AGE_MS=1800000

# Max gas price cap for EVM transactions in Gwei (default: 300)
MAX_GAS_PRICE_GWEI=300
```

#### Optional — QR Codes
```env
# HMAC secret for signing QR payloads (defaults to derivation from SESSION_SECRET)
QR_SIGNING_SECRET=your_qr_secret

# How many hours a signed QR link remains valid (default: 168 = 7 days)
QR_PAYLOAD_TTL_HOURS=168
```

#### Optional — AWS KMS (enterprise key encryption)
```env
AWS_REGION=us-east-1
AWS_KMS_KEY_ID=arn:aws:kms:...
```

---

### 3.3 Local Development

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in the environment file
cp .env.example .env
# Edit .env with your values

# 3. Push the database schema
npm run db:push

# 4. Start the development server (frontend + backend together)
npm run dev
```

The app will be available at `http://localhost:5000`.

---

### 3.4 Production Deployment (Railway)

1. **Create a Railway project** and add:
   - A **Postgres** plugin → copy `DATABASE_URL` to env vars
   - A **Redis** plugin → copy `REDIS_URL` to env vars

2. **Set all required environment variables** in Railway's Variables tab.

3. **Deploy from GitHub** — Railway auto-detects Node.js and runs:
   ```
   npm run build && npm start
   ```

4. **Database tables are created automatically** on first boot via `ensureDatabaseCompatibility()` — no manual migration step needed.

> **Important:** The executor wallet (`TRON_EXECUTOR_PRIVATE_KEY` / `EXECUTOR_PRIVATE_KEY`) must hold enough native token (TRX / ETH / MATIC etc.) to pay gas fees for executing subscriptions. It does **not** need to hold the payment token itself — funds flow directly from subscriber to merchant.

---

### 3.5 Smart Contract Deployment

#### EVM Chains
```bash
# Deploy to a specific network (add network config in hardhat.config.ts)
npx hardhat run scripts/deploy.ts --network polygon
npx hardhat run scripts/deploy.ts --network bsc
npx hardhat run scripts/deploy.ts --network sepolia   # testnet
```

After deployment, note the contract address and either:
- Set it as the `contractAddress` field when creating a plan in the dashboard, or
- Add it to the network defaults in `shared/networks.ts`.

#### TRON
```bash
# Deploy to Nile testnet
npm run tron:deploy:nile

# Deploy to TRON Mainnet
npm run tron:deploy:mainnet
```

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SUBSCRIBERS                             │
│         MetaMask / TronLink browser extension                   │
└────────────────────────────┬────────────────────────────────────┘
                             │  HTTPS (payment flow)
┌────────────────────────────▼────────────────────────────────────┐
│                       FRONTEND (React)                          │
│  /pay/:code (EVM)   /pay/:code (TRON)   /dashboard (merchant)  │
└────────────────────────────┬────────────────────────────────────┘
                             │  REST API
┌────────────────────────────▼────────────────────────────────────┐
│                    BACKEND (Express + Node.js)                  │
│                                                                 │
│  ┌───────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │ Auth/Session  │  │ Plans/Subs   │  │ Scheduler (BullMQ)  │  │
│  │ Routes        │  │ Routes       │  │ Executes due subs   │  │
│  └───────────────┘  └──────────────┘  └─────────────────────┘  │
│  ┌───────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │ Webhook       │  │ SDK Key      │  │ Blockchain Indexer  │  │
│  │ Delivery      │  │ System       │  │ (WebSocket events)  │  │
│  └───────────────┘  └──────────────┘  └─────────────────────┘  │
└──────┬───────────────────────┬─────────────────────────────────-┘
       │                       │
┌──────▼──────┐      ┌─────────▼──────────────────────────────────┐
│ PostgreSQL  │      │  Blockchain Networks                        │
│ (Neon /     │      │                                             │
│  Railway)   │      │  EVM: Ethereum, Polygon, BSC, Avalanche,   │
│             │      │       Arbitrum, Optimism, Base, Fantom     │
│ Redis       │      │                                             │
│ (BullMQ     │      │  TRON: Mainnet / Nile Testnet              │
│  queues)    │      └────────────────────────────────────────────┘
└─────────────┘
```

### Request flow for a recurring payment execution

```
[Scheduler tick every 15s]
       │
       ▼
  Query DB: subscriptions WHERE next_payment_due <= NOW
       │
       ▼
  For each subscription:
    1. Check executor has gas balance
    2. Call isDue() on smart contract (view, no gas)
    3. Check subscriber token balance (view, no gas)
    4. Check subscriber token allowance (view, no gas)
    5. Call executeSubscription() on smart contract ← actual tx
    6. Wait for confirmation (3 blocks / 60s TRON)
    7. Update next_payment_due in DB
    8. Fire webhook event (BullMQ job)
```

---

## 5. Features & Workflows

### 5.1 Merchant Onboarding

1. Navigate to the app URL and click **Register**.
2. Enter a username and password (min 8 chars, 1 uppercase, 1 number).
3. Connect a **receiving wallet** (MetaMask for EVM, TronLink for TRON) — this is where payments are deposited.
4. Go to **Settings** and add an **Executor Private Key**:
   - EVM key: private key of a wallet holding ETH/MATIC/BNB (for gas)
   - TRON key: private key of a TRX wallet (for energy/bandwidth)
   - Keys are encrypted with AES-256-GCM before storage.

---

### 5.2 Creating a Payment Plan

A **Plan** is a template that defines billing terms. Subscribers pay according to this plan.

**Steps:**
1. In the Dashboard → **Plans** tab, click **Create Plan**.
2. Fill in:
   | Field | Description |
   |---|---|
   | Plan Name | Display name shown to subscribers |
   | Network | Blockchain network (e.g., Polygon, TRON Mainnet) |
   | Token | ERC-20/TRC-20 token for payments (e.g., USDT, USDC) |
   | Initial Amount | Amount for the first transaction (activation) |
   | Recurring Amount | Amount charged every interval (optional, defaults to initial) |
   | Interval | How often to charge: e.g., `1 month`, `7 days`, `30 days` |
   | Contract Address | The deployed subscription contract address |

3. After creation, a unique **Plan Code** is generated (e.g., `ABC123`).
4. Share the payment link: `https://yourapp.com/pay/ABC123`
5. Optionally generate a **QR code** from the dashboard for physical/digital display.

---

### 5.3 Subscriber Payment Flow — EVM

```
Subscriber visits /pay/:code
        │
        ▼
  Plan details loaded (token, amount, interval)
        │
        ▼
  Connect MetaMask
        │
        ▼
  Approve token allowance on ERC-20 contract
  (one-time transaction, subscriber pays gas)
        │
        ▼
  Call activate() on CryptoPaySubscription contract
  (first payment deducted immediately)
        │
        ▼
  Backend verifies SubscriptionCreated event on-chain
        │
        ▼
  Subscription record created in DB
  next_payment_due = now + interval
        │
        ▼
  Confirmation shown (tx hash, subscription ID)
```

**Permit flow (EVM only):** If the token supports ERC-2612 `permit`, the approval and activation happen in a single transaction — no separate approval step needed.

---

### 5.4 Subscriber Payment Flow — TRON

```
Subscriber visits /pay/:code
        │
        ▼
  Plan details loaded
        │
        ▼
  Connect TronLink
  (network check: Mainnet vs Nile)
        │
        ▼
  Approve TRC-20 token allowance
  (separate transaction via TronLink)
        │
        ▼
  Call activate() on TronPaySubscription contract
        │
        ▼
  Backend polls TronGrid for SubscriptionCreated event
  (waits ~60s for transaction solidification)
        │
        ▼
  Subscription created in DB
        │
        ▼
  Confirmation shown
```

---

### 5.5 Recurring Payment Execution

Once a subscription is active, the **scheduler** runs continuously and executes payments automatically.

**Scheduler behaviour:**
- Runs every **15 seconds** (configurable).
- Queries all subscriptions with `next_payment_due <= NOW`.
- For each due subscription:
  1. Verifies executor wallet has gas.
  2. Calls `executeSubscription(subscriptionId)` on the contract.
  3. Contract transfers tokens from subscriber → merchant wallet.
  4. Updates `next_payment_due` to the next cycle.
  5. Logs the execution in `scheduler_logs` and `execution_logs`.

**Subscription status codes:**

| Status | Meaning |
|---|---|
| `active` | Payments executing normally |
| `suspended_balance` | Subscriber ran out of tokens |
| `suspended_allowance` | Subscriber revoked token approval |
| `pending` | Execution tx is in-flight |
| `error` | Execution failed (see logs for details) |

**TRON energy:**
If the TRON executor wallet has less than 80,000 Energy, the system can automatically rent energy from a marketplace API before executing — avoiding high TRX burns.

---

### 5.6 Billing Change Proposal Flow

When a merchant needs to change an existing plan's amount or interval for current subscribers, the **propose-accept** system ensures subscribers consent before the change takes effect.

```
Merchant clicks "Propose Change" in Dashboard
        │
        ▼
  Enters: new amount, new interval, optional note, optional deadline
        │
        ▼
  POST /api/plans/:planId/propose-billing
  ─ Creates a billingProposal row per active subscriber
        │
        ▼
  Subscriber visits payment page (/pay/:code)
  ─ Yellow banner appears: "Billing terms change proposed"
  ─ Shows: current terms vs proposed terms + merchant note
        │
      ┌─┴─────────────────────────┐
      │                           │
  [Accept]                   [Reject]
      │                           │
      ▼                           ▼
  Subscriber calls            Proposal marked rejected
  updateSubscription()        Current terms continue
  on smart contract
  (signs tx in TronLink/MetaMask)
      │
      ▼
  POST /api/subscriptions/:id/proposal/accept
  ─ Proposal marked accepted
  ─ acceptTxHash recorded
  ─ Scheduler uses new terms for next cycle
```

**Key point:** No contract changes are needed. The subscriber calls the existing `updateSubscription()` function that was already on the contract, signing it from their own wallet.

---

### 5.7 Webhook Notifications

Merchants can register webhook endpoints to receive real-time events for subscription activity.

**Setup:**
1. Dashboard → **Settings** → Webhooks → Add URL + Secret.

**Events delivered:**

| Event | Trigger |
|---|---|
| `subscription.created` | New subscriber activates |
| `subscription.activated` | First payment confirmed on-chain |
| `payment.executed` | Recurring payment confirmed |
| `subscription.proposal` | Merchant sends billing proposal |
| `subscription.cancelled` | Subscriber cancels on-chain |

**Payload format:**
```json
{
  "event": "payment.executed",
  "subscriptionId": "abc-123",
  "planId": "plan-456",
  "txHash": "0xabc...",
  "amount": "10.00",
  "token": "USDT",
  "timestamp": "2024-01-15T12:00:00Z"
}
```

**Signature verification:**
Every request includes an `x-cryptopay-signature` header (HMAC-SHA256 of the raw body using your webhook secret). Always verify this before processing.

```javascript
const crypto = require("crypto");

function verifyWebhook(rawBody, signature, secret) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

**Retry logic:** Failed deliveries are retried up to 5 times with exponential backoff (1m → 2m → 4m → 8m → 16m).

---

### 5.8 SDK Embedding

Embed a payment widget on any website without building your own UI.

**Setup:**
1. Dashboard → **Settings** → SDK Keys → Create Key → copy the key.
2. Add the script to your HTML:

```html
<script
  src="https://yourapp.com/sdk/v1.js"
  data-key="YOUR_SDK_KEY"
></script>
```

**What the SDK does:**
- Pings the server every 60 seconds to check key status.
- If the key is **suspended**: Displays a service unavailable overlay on your site.
- If the key requires **payment**: Displays a renewal prompt.
- Tracks which sites (origins) are using the key — visible in the Dashboard.

**SDK key statuses:**

| Status | Effect on embedded site |
|---|---|
| `active` | Normal operation |
| `suspended` | Overlay shown: "Service Unavailable" |
| `payment_required` | Overlay shown: "Renewal Required" |

---

### 5.9 Executor Key Management

The executor key is the private key that signs on-chain transactions to execute recurring payments. It **only** pays gas — payment tokens go directly from subscriber to merchant.

**EVM Executor Wallet requirements:**
- Must hold the **native token** of each chain (ETH on Ethereum, MATIC on Polygon, BNB on BSC, etc.)
- Minimum ~0.00005 ETH equivalent to pass the scheduler's balance check
- Recommended: Keep 0.05–0.1 ETH worth of native token per chain

**TRON Executor Wallet requirements:**
- Must hold **TRX** for bandwidth and energy
- Recommended minimum: 200 TRX
- Account `TFR6BXPAt4pS2uNdgXhPkJ6bd7Dw1HQi5Z` is the executor wallet — this is the wallet that needs the TRX balance, **not** the developer/deployer account

**Priority order for executor key selection:**
1. Per-user EVM/TRON key stored encrypted in database (set in Dashboard → Settings)
2. `EXECUTOR_PRIVATE_KEY` / `TRON_EXECUTOR_PRIVATE_KEY` environment variable
3. `DEPLOYER_PRIVATE_KEY` environment variable (last resort)

> **Best practice for production:** Set `TRON_EXECUTOR_PRIVATE_KEY` and `EXECUTOR_PRIVATE_KEY` as Railway environment variables. Do NOT store keys in the database per-user unless you need per-merchant isolation.

---

## 6. API Reference

All API endpoints are prefixed with `/api`. Authentication endpoints use session cookies.

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | — | Register new merchant account |
| POST | `/api/auth/login` | — | Login, creates session |
| POST | `/api/auth/logout` | ✓ | Destroy session |
| GET | `/api/auth/me` | ✓ | Get current user |
| POST | `/api/auth/wallet` | ✓ | Set receiving wallet address + network |
| POST | `/api/auth/executor-key` | ✓ | Set executor private key (encrypted before storage) |
| GET | `/api/auth/executor-key` | ✓ | Check if executor key is set `{hasEvmKey, hasTronKey}` |
| DELETE | `/api/auth/executor-key` | ✓ | Remove executor key |

### Plans

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/plans` | ✓ | List all merchant's plans |
| POST | `/api/plans` | ✓ | Create a new plan |
| GET | `/api/plans/:id` | ✓ | Get plan details |
| DELETE | `/api/plans/:id` | ✓ | Delete plan |
| GET | `/api/plans/code/:code` | — | Get plan by public code (used by payment page) |
| PATCH | `/api/plans/:id/wallet` | ✓ | Change receiver wallet (updates on-chain) |
| PATCH | `/api/plans/:id/billing` | ✓ | Update billing terms (bumps plan version) |
| PATCH | `/api/plans/:id/recurring-amount` | ✓ | Update only the recurring charge amount |
| GET | `/api/plans/:id/subscriptions` | ✓ | List all subscribers for this plan |
| GET | `/api/plans/:id/versions` | ✓ | Audit trail of billing changes |
| GET | `/api/plans/:id/signed-qr` | ✓ | Generate signed QR payload |

### Subscriptions

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/subscriptions` | — | Create subscription after on-chain activation |
| GET | `/api/subscriptions/:id` | — | Get subscription details |
| GET | `/api/subscriptions/:id/logs` | — | Get execution history |
| PATCH | `/api/subscriptions/:id/approval` | — | Record token approval tx hash |
| POST | `/api/subscriptions/:id/tx` | — | Record execution tx |
| PATCH | `/api/subscriptions/:id/cancel` | — | Cancel subscription |
| PATCH | `/api/subscriptions/:id/cancel-onchain` | — | Cancel and call contract |
| GET | `/api/subscriptions/check/:planId/:payerAddress` | — | Check if address has active subscription |

### Billing Proposals

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/plans/:planId/propose-billing` | ✓ | Propose new billing terms to subscribers |
| GET | `/api/subscriptions/:id/proposal` | — | Get pending proposal for subscription |
| POST | `/api/subscriptions/:id/proposal/accept` | — | Accept proposal (with on-chain tx hash) |
| POST | `/api/subscriptions/:id/proposal/reject` | — | Reject proposal |

### SDK

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/sdk/v1.js` | — | Embeddable SDK script |
| POST | `/api/sdk/heartbeat` | — | SDK ping (checks key status) |
| GET | `/api/sdk/keys` | ✓ | List SDK keys |
| POST | `/api/sdk/keys` | ✓ | Create SDK key |
| PATCH | `/api/sdk/keys/:id/status` | ✓ | Suspend or activate key |
| DELETE | `/api/sdk/keys/:id` | ✓ | Delete key |
| GET | `/api/sdk/installations` | ✓ | List all tracked installation origins |
| GET | `/api/sdk/installations/:keyId` | ✓ | Installations for a specific key |

### Dashboard & Analytics

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/dashboard/stats` | ✓ | Revenue totals, subscriber counts by token |
| GET | `/api/dashboard/subscribers` | ✓ | All subscribers across all plans |
| GET | `/api/dashboard/transactions` | ✓ | Full transaction history |
| GET | `/api/transactions/check` | ✓ | Check a specific tx hash status |

---

## 7. Database Schema

### `users`
Merchant accounts.

| Column | Type | Description |
|---|---|---|
| id | varchar PK | UUID |
| username | text UNIQUE | Login name |
| password | text | bcrypt hash |
| wallet_address | text | Receiving wallet (EVM or TRON) |
| wallet_network | text | Network ID of receiving wallet |
| executor_private_key | text | AES-256-GCM encrypted EVM key |
| tron_executor_private_key | text | AES-256-GCM encrypted TRON key |

### `plans`
Subscription plan templates created by merchants.

| Column | Type | Description |
|---|---|---|
| id | varchar PK | UUID |
| user_id | varchar FK | Owner merchant |
| plan_name | text | Display name |
| wallet_address | text | Receiving wallet for this plan |
| network_id | text | Chain ID (hex string) |
| network_name | text | Human-readable chain name |
| token_address | text | ERC-20 / TRC-20 contract |
| token_symbol | text | e.g., USDT, USDC |
| token_decimals | integer | e.g., 6, 18 |
| interval_amount | text | Amount per cycle |
| interval_value | integer | e.g., 1 |
| interval_unit | text | sec / min / hrs / days / months |
| plan_code | text UNIQUE | Public code for payment links |
| recurring_amount | text | Override for recurring charge |
| contract_address | text | Deployed contract address |
| chain_type | text | "evm" or "tron" |
| plan_version | integer | Incremented on billing changes |
| qr_nonce | text | Anti-replay nonce for QR codes |

### `subscriptions`
Active subscriber records.

| Column | Type | Description |
|---|---|---|
| id | varchar PK | UUID |
| plan_id | varchar FK | Parent plan |
| payer_address | text | Subscriber's wallet address |
| on_chain_subscription_id | text | ID assigned by smart contract |
| is_active | boolean | Whether subscription is active |
| subscription_status | text | active / suspended_balance / etc. |
| tx_count | integer | Total executions so far |
| last_tx_hash | text | Most recent execution tx |
| last_executed_at | timestamp | When last payment ran |
| next_payment_due | timestamp | When scheduler will charge next |
| approval_tx_hash | text | Token approval tx |
| first_payment_tx_hash | text | Activation tx |

### `billing_proposals`
Pending billing term changes awaiting subscriber consent.

| Column | Type | Description |
|---|---|---|
| id | varchar PK | UUID |
| subscription_id | varchar FK | Target subscription |
| plan_id | varchar | Parent plan |
| proposed_amount | text | New charge amount |
| proposed_interval_value | integer | New interval number |
| proposed_interval_unit | text | New interval unit |
| merchant_note | text | Optional message to subscriber |
| deadline | timestamp | Optional expiry for proposal |
| status | text | pending / accepted / rejected |
| accept_tx_hash | text | On-chain tx if accepted |
| responded_at | timestamp | When subscriber responded |

### `scheduler_logs`
Detailed per-execution logs.

| Column | Type | Description |
|---|---|---|
| id | varchar PK | UUID |
| subscription_id | varchar FK | |
| status | text | started / pending / success / error / etc. |
| tx_hash | text | Execution tx hash |
| error_message | text | Error details if failed |
| gas_used | text | Gas consumed (EVM) |
| energy_used | text | Energy consumed (TRON) |

### `webhooks`
Merchant webhook endpoint registrations.

| Column | Type | Description |
|---|---|---|
| id | serial PK | |
| user_id | varchar FK | |
| url | text | Delivery endpoint |
| secret | text | HMAC signing secret |
| active | boolean | |

### `sdk_keys`
API keys for SDK embedding.

| Column | Type | Description |
|---|---|---|
| id | varchar PK | UUID |
| user_id | varchar FK | |
| api_key | text UNIQUE | Public key embedded in `<script>` tag |
| label | text | Human name |
| status | text | active / suspended / payment_required |
| suspended_at | timestamp | |
| suspend_reason | text | |

---

## 8. Smart Contracts

### CryptoPaySubscription (EVM)

Deployed on each supported EVM chain.

**Key functions:**

```solidity
// Subscriber calls this to create a subscription
function activate(
    address receiver,
    address token,
    uint256 initialAmount,
    uint256 recurringAmount,
    uint256 intervalSeconds
) external returns (uint256 subscriptionId);

// Subscriber calls this to approve + activate in one tx (ERC-2612 tokens)
function activateWithPermit(
    address receiver,
    address token,
    uint256 initialAmount,
    uint256 recurringAmount,
    uint256 intervalSeconds,
    uint256 deadline,
    uint8 v, bytes32 r, bytes32 s
) external returns (uint256 subscriptionId);

// Executor calls this to charge subscriber (no user signature needed)
function executeSubscription(uint256 subscriptionId) external;

// Subscriber calls to cancel
function cancelSubscription(uint256 subscriptionId) external;

// Check if payment is due
function isDue(uint256 subscriptionId) external view returns (bool);

// Update billing terms (subscriber must sign)
function updateSubscription(
    uint256 subscriptionId,
    uint256 newAmount,
    uint256 newIntervalSeconds
) external;
```

**Events:**
```solidity
event SubscriptionCreated(uint256 indexed id, address indexed payer, address indexed receiver);
event PaymentExecuted(uint256 indexed id, uint256 amount, uint256 nextDue);
event SubscriptionCancelled(uint256 indexed id);
event SubscriptionUpdated(uint256 indexed id, uint256 newAmount, uint256 newInterval);
```

### TronPaySubscription (TRON)

Identical interface to the EVM contract, compiled for TVM (Solidity 0.8.0, no PUSH0 opcode). Deployed to TRON Mainnet and Nile Testnet.

Notable difference: No `activateWithPermit` (TRC-20 tokens do not support ERC-2612 permit).

---

## 9. Multi-Chain Support

### Supported Networks

| Chain | Network ID | Token Standard | Testnet |
|---|---|---|---|
| Ethereum | `0x1` | ERC-20 | Sepolia (`0xaa36a7`) |
| Polygon | `0x89` | ERC-20 | — |
| BNB Smart Chain | `0x38` | BEP-20 (ERC-20 compat.) | — |
| Avalanche C-Chain | `0xa86a` | ERC-20 | — |
| Arbitrum One | `0xa4b1` | ERC-20 | — |
| Optimism | `0xa` | ERC-20 | — |
| Base | `0x2105` | ERC-20 | — |
| Fantom | `0xfa` | ERC-20 | — |
| TRON Mainnet | `0x2b6653dc` | TRC-20 | — |
| TRON Nile | `0xcd8690dc` | TRC-20 | Nile Testnet |

### Chain Detection

The system detects TRON chains by their network ID and switches between:
- **EVM adapter**: ethers.js + MetaMask
- **TRON adapter**: TronWeb + TronLink

Address formats are handled separately — EVM uses `0x...` checksummed addresses; TRON uses Base58Check `T...` addresses.

---

## 10. Security

### Executor Key Security
- Private keys are **never stored in plaintext**.
- Encrypted with AES-256-GCM before writing to database.
- Decrypted only in memory at execution time.
- AWS KMS integration available for enterprise deployments.
- Keys can be revoked instantly via Dashboard or API.

### Session Security
- `HttpOnly` + `Secure` cookies (HTTPS only in production).
- PostgreSQL-backed session store (not in-memory).
- `SESSION_SECRET` must be a strong random value.

### Smart Contract Security
- Reentrancy guard on all state-changing functions (`nonReentrant` modifier).
- `SafeTransferFrom` pattern for token transfers (low-level call with return value check).
- Executor role is separate from merchant wallet — compromise of executor only exposes gas, not funds.
- Subscriber retains full custody — they can revoke the token allowance at any time to stop future charges.

### Webhook Security
- All deliveries signed with HMAC-SHA256.
- Merchants must verify `x-cryptopay-signature` before trusting payloads.

### QR Code Security
- Signed with HMAC-SHA256, include nonce + expiry.
- Used nonces tracked in database — replay attacks rejected.
- Default TTL: 7 days.

### Rate Limiting
- Auth endpoints limited to 5 requests/minute per IP.
- Auto-pruning of expired rate limit entries.

### Production Checklist

- [ ] `ENCRYPTION_MASTER_KEY` is a unique random 32 bytes
- [ ] `SESSION_SECRET` is a long random string
- [ ] `DATABASE_URL=mock` is NOT set
- [ ] Executor wallets hold enough native token for gas
- [ ] TRON executor wallet (`TFR6...` or equivalent) holds sufficient TRX
- [ ] Webhook secrets are unique per endpoint
- [ ] All private keys are stored in Railway env vars, not in source code
- [ ] `NODE_ENV=production` is set

---

*CryptoPay — Built on open blockchain standards. No custodians, no intermediaries.*
