# Keys And Commands Guide

Last updated: 2026-02-17

## 1) Purpose

This guide covers:

- How to generate required keys/secrets
- Where each key is used
- Commands to run the project
- Commands to verify your environment
- Fix for common `500` key-save errors

## 2) Required vs Recommended Env Vars

Required:

- `DATABASE_URL`
- `SESSION_SECRET`

Strongly recommended / production critical:

- `ENCRYPTION_MASTER_KEY` (required in production for saving executor keys)
- `CRON_SECRET`
- `DEPLOYER_PRIVATE_KEY`
- `EXECUTOR_PRIVATE_KEY` (fallback executor)
- `SEPOLIA_RPC_URL` (or chain RPC URLs you use)
- `TX_CONFIRMATIONS` (default `3`)
- `RPC_TIMEOUT_MS` (default `8000`)

## 3) What Each Key Does

`SESSION_SECRET`

- Signs session cookies (`connect.sid`)
- Required for login/session handling

`ENCRYPTION_MASTER_KEY`

- Encrypts/decrypts user executor private keys (`/api/auth/executor-key`)
- In production, saving executor key fails without this
- Accepts:
  - 32-byte base64/base64url
  - 64-char hex (optionally with `0x`)

`CRON_SECRET`

- Protects `/api/cron/scheduler`

`DEPLOYER_PRIVATE_KEY`

- Used for contract-owner operations (e.g. some on-chain updates/cancel flows)

`EXECUTOR_PRIVATE_KEY`

- Fallback key if a user has not set per-user executor key in dashboard
- Used by scheduler for recurring execution

## 4) Key Generation Commands

## 4.1 PowerShell (Windows)

Generate `SESSION_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Generate `ENCRYPTION_MASTER_KEY` (base64, recommended):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Generate `ENCRYPTION_MASTER_KEY` (hex alternative):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate `CRON_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 4.2 Bash (Linux/macOS)

Generate `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Generate `ENCRYPTION_MASTER_KEY` (base64):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Generate `CRON_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 5) Local Setup Commands

Install deps:

```powershell
npm install
```

Create env file:

```powershell
Copy-Item .env.example .env
```

Push DB schema:

```powershell
npm run db:push
```

Run dev:

```powershell
npm run dev
```

Typecheck:

```powershell
npm run check
```

Workflow smoke test (API):

```powershell
npm run smoke:workflow
```

Tests:

```powershell
npm test
```

Build:

```powershell
npm run build
```

Start production bundle:

```powershell
npm start
```

## 6) Environment Verification Commands

Verify key is visible to runtime:

```powershell
node --input-type=module -e "import 'dotenv/config'; console.log('NODE_ENV=',process.env.NODE_ENV||'(unset)'); console.log('VERCEL=',process.env.VERCEL||'(unset)'); const k=process.env.ENCRYPTION_MASTER_KEY; console.log('HAS_ENCRYPTION_MASTER_KEY=',!!k,'LEN=',k?k.length:0);"
```

Verify encryption works in production mode:

```powershell
npx tsx -e "import 'dotenv/config'; process.env.NODE_ENV='production'; import('./server/crypto.ts').then((m)=>{try{const out=m.encrypt('test'); console.log('encrypt_ok', out.startsWith('v2:'));}catch(e){console.error('encrypt_err', e.message); process.exit(1);}});"
```

## 7) Fix: `500 Failed to save key`

Error example:

`ENCRYPTION_MASTER_KEY is required in production to encrypt executor private keys`

Checklist:

1. Set `ENCRYPTION_MASTER_KEY` in the actual runtime environment (not only local `.env`)
2. Ensure no extra whitespace/invalid formatting
3. Restart/redeploy backend after env changes
4. Retry saving executor key

If using managed hosting:

- Add env var in dashboard (Production + Preview/Development if needed)
- Redeploy app

## 8) Wallet Key Notes

Receiver wallets (A/B/C) and executor/deployer keys are different concepts:

- Receiver wallet address: where payments are sent
- Executor key: backend signer for recurring `executeSubscription`
- Deployer key: owner-level contract operations

You do **not** add a private key for each receiver wallet.

## 9) Security Rules

- Never commit `.env` to git
- Use separate keys per environment (dev/staging/prod)
- Rotate secrets if leaked
- Keep minimal funds in executor wallet (only enough for gas buffer)
- Restrict server access and logs containing sensitive values

## 10) Quick Command Reference

```powershell
# dev
npm run dev

# checks
npm run check
npm test

# build/start
npm run build
npm start

# db
npm run db:push
```
