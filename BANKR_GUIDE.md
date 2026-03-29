# Bankr + Callput Integration Guide

## Overview

**Bankr** (@bankrbot) is a non-custodial AI trading agent deployed on X/Farcaster that executes crypto trading strategies on your behalf. Your USDC stays in your wallet, and Bankr manages your agent wallet's signing keys securely. You authorize Bankr to trade on your behalf — no key management burden on you.

This guide walks you through using Bankr to trade **Callput options spreads** on Base Mainnet, from market scanning to profit-taking and settlement.

### What This Guide Covers
- How to fund and authenticate with Bankr
- Understanding non-custodial transaction signing
- The full 8-step user journey for trading ETH/BTC spreads
- Advanced strategies (high IV environments)
- Recovering lost position data
- Safety rules and troubleshooting

---

## Prerequisites

Before you start trading with Bankr on Callput:

1. **USDC-funded wallet on Base Mainnet** (chain 8453)
   - Minimum: $500–$2000 USDC (depends on spread size preference)
   - Wallet type: Any EVM wallet (Metamask, Ledger, etc.)

2. **@bankrbot connection on X/Farcaster**
   - Follow @bankrbot on X or link your Farcaster account
   - Bankr will respond to mentions in tweets/casts

3. **Wallet address linked to Bankr agent**
   - You must register your wallet address with Bankr once (one-time setup)
   - Bankr learns which wallet holds your USDC and validates signatures
   - Command: `@bankrbot register wallet 0xYourAddress` (or via Farcaster cast)

4. **Stable internet connection**
   - Bankr monitors tweets/casts in real-time and responds within seconds to minutes

---

## How Bankr Signs and Broadcasts Transactions

Bankr uses a **4-step non-custodial pattern** to trade on your behalf:

```
┌─────────────────────────────────────────────────────────────┐
│ You (Bankr user) → @bankrbot command in X/Farcaster        │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 1: MCP builds unsigned_tx                              │
│ (Callput contract call, no signer yet)                      │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 2: Bankr calls /agent/sign → signs with your key      │
│ (Your key lives only in your wallet, never in Bankr's DB)   │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 3: Bankr calls /agent/submit → broadcasts signed_tx    │
│ (sent to Base Mainnet via RPC)                              │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 4: tx_hash returned to you in reply                    │
│ (you hold keys, Bankr acted as signing oracle)              │
└─────────────────────────────────────────────────────────────┘
```

**The key point**: Bankr manages your agent wallet's signing keys securely. You authorize Bankr to execute trades on your behalf — that's the core value. You don't manage private keys yourself. CALLPUT_PRIVATE_KEY is never needed or used in the Bankr integration.

---

## Full User Journey (8 Steps with X/Farcaster Commands)

Below is a realistic walkthrough of a complete ETH bearish put spread trade with Bankr.

### Step 1: Bootstrap & Portfolio Check

You tweet:
```
@bankrbot bootstrap and check my portfolio summary on Base
```

Bankr replies:
```
✅ Bankr bootstrap complete. Rules loaded.

📊 Portfolio Summary (wallet: 0x8f...9d2a)
├─ usdc_balance: $2,450.50
├─ open_positions: 0
├─ urgent_count: 0
└─ ready for trading

Next: scan spreads or review previous positions.
```

**Why this step**: Bankr confirms your wallet is connected, your USDC balance is sufficient, and there are no expiring positions to manage first.

---

### Step 2: Scan for Spreads

You tweet:
```
@bankrbot scan ETH bearish spreads on Callput
```

Bankr replies:
```
🔍 Scanning ETH bearish spreads (BuyPutSpread)
atm_iv: 62% | expiry: 2026-03-28 (5 days)

Rank | Strike Pair | Cost | Max Profit | RR | Cost %
──────────────────────────────────────────────────
  1  | 3200/3100   | $185 | $815       | 4.4x | 18.5%
  2  | 3100/3000   | $165 | $835       | 5.1x | 16.5%
  3  | 3000/2900   | $155 | $845       | 5.5x | 15.5%

Cost % = cost_pct_of_max (under 40% is good)
Max Profit = strike difference − cost

Ready to dry-run? Say: "dry-run rank 1"
```

**What you're seeing**:
- **Rank 1**: Best risk/reward (4.4x), 18.5% cost vs. max risk
- **Days to expiry**: 5 days (good — not too tight)
- **atm_iv**: 62% (moderate — not high enough to favor sell spreads)

---

### Step 3: Dry-Run

You tweet:
```
@bankrbot dry-run rank 1 ETH bearish spread size 1
```

Bankr replies:
```
🧪 DRY-RUN EXECUTION (no blockchain impact)

Strategy: BuyPutSpread
├─ Long: 3200 PUT
├─ Short: 3100 PUT
├─ Size: 1 contract
├─ Max Risk: $1,000
├─ Max Profit: $815
├─ Estimated Cost: $185 USDC
├─ Wallet balance after: $2,265.50
└─ request_key (unsigned): 0x7f3a...9c2b

TX payload confirmed. No gas spent.

Ready to execute? Say: "execute rank 1 ETH bearish spread size 1 — I authorize live execution"
```

**Why dry-run first**:
- You see the exact cost and payoff structure
- No real transaction is broadcast
- You confirm strike pairs and size before committing
- Bankr saves the unsigned `request_key` for reference

---

### Step 4: Live Execution (With Explicit Authorization)

You tweet:
```
@bankrbot execute rank 1 ETH bearish spread size 1 — I authorize live execution
```

Bankr replies:
```
✅ LIVE EXECUTION AUTHORIZED

Checking USDC approval...
```

**Step 4A: Standard Execution (If Approval Sufficient)**

If your USDC allowance is already sufficient, Bankr continues:
```
✅ USDC approval confirmed.

Signing and broadcasting...

🚀 Transaction submitted
├─ tx_hash: 0xa8b2c...3e1f
├─ From: 0x8f...9d2a
├─ Contract: 0xCallputAddr
├─ Strategy: BuyPutSpread
├─ Cost: $185 USDC
├─ Max Profit: $815 USDC
├─ Position request_key: 0x7f3a...9c2b
└─ Status: pending (polling...)

Wallet balance after: $2,265.50

Will monitor until execution completes. Sit tight!
```

**Step 4B (If Needed): Approve USDC First**

If your USDC approval is insufficient, Bankr will ask:
```
⚠️ USDC allowance insufficient (need $185, have $50)

Signing approval transaction first...

🔐 Approval tx submitted
├─ tx_hash: 0x5c7d9...2a4f
├─ Action: approve Callput to spend $185 USDC
└─ Status: pending (waiting for confirmation)

Approval confirmed. Now executing spread...

🚀 Main transaction submitted
├─ tx_hash: 0xa8b2c...3e1f
├─ Strategy: BuyPutSpread
├─ Cost: $185 USDC
└─ Status: pending (polling...)
```

**What happened behind the scenes**:
1. Bankr's MCP checked USDC allowance
2. If insufficient: Bankr signed and submitted approve tx, then waited for confirmation
3. Bankr's MCP built the unsigned spread transaction
4. Bankr called `/agent/sign` with your wallet's signing key
5. Bankr called `/agent/submit` to broadcast the signed tx
6. Base Mainnet received and indexed the transaction
7. Bankr saved your `request_key` for P&L tracking

---

### Step 5: Status Polling (Automatic, No User Action)

Bankr automatically polls every 30 seconds:

```
⏳ Checking position status (0x7f3a...9c2b)...

→ Poll 1/6: pending
→ Poll 2/6: pending
→ Poll 3/6: executed ✅

🎉 POSITION EXECUTED
├─ Block: 15,487,292
├─ Timestamp: 2026-03-23 14:32:15 UTC
├─ Entry cost: $185 USDC
├─ Spread: 3200/3100 PUT
└─ request_key saved to session

Next: portfolio check or close/adjust.
```

**Status meanings**:
- **pending**: Waiting for blockchain confirmation
- **executed**: Your spread is now open
- **cancelled**: Transaction was reverted (check P&L or try again)

---

### Step 6: Portfolio + P&L Check

You tweet:
```
@bankrbot show my portfolio and P&L
```

Bankr replies:
```
💼 Portfolio Summary
usdc_balance: $2,265.50

📈 Open Positions
Position #1 (0x7f3a...9c2b)
├─ Strategy: BuyPutSpread
├─ Underlying: ETH
├─ Strikes: 3200/3100 PUT
├─ Days to expiry: 4.8 days
├─ Entry cost: $185 USDC
├─ Current mark value: $192 USDC (slight slippage)
├─ Unrealized P&L: +$7 (+3.8%)
├─ Close bid estimate: $180 USDC
├─ Close P&L est: −$5 (−2.7%)
├─ Max profit: $815
├─ Max loss: $185
└─ Status: open

⚠️ Close P&L est is negative, but mark P&L is positive.
   (Mark = fair mid; Bid = what you'd actually get)

Tip: Close when close_pnl_est > 50% profit.
```

---

### Understanding Mark vs. Bid P&L

**Important distinction** — these two P&L figures tell different stories:

- **Unrealized P&L (mark-based)**: Based on mid/fair value. This is what your position is *theoretically worth* right now. Good for monitoring, but **NOT** what you'd actually receive if you close.

- **Close P&L Est (bid-based)**: Based on the actual bid price. This is what you'd **realistically receive** if you close the position right now. Use this for profit-taking decisions.

In the example above:
- Mark P&L shows +$7 (position looks good)
- Close P&L shows −$5 (you'd actually lose if you closed now due to bid/ask spread)

**Rule**: Always use `close_pnl_est` when deciding whether to close. Close when `close_pnl_est_pct > 50%` (50% gain on tradeable close).

---

**Key P&L Fields**:
- **entry_cost**: $185 — what you paid upfront
- **unrealized_pnl_usd**: Based on mark price (mid/fair value, theoretical — NOT what you'd actually receive)
- **close_bid_value**: What you'd realistically receive closing now
- **close_pnl_est_usd**: Based on bid price (what you'd actually receive if you close now) — use this for profit-taking decisions

---

### Step 7: Close Position (Profit Taking)

You tweet (when close P&L hits 50%+):
```
@bankrbot close my ETH position
```

Bankr replies:
```
📊 Checking close P&L...
Position #1 (0x7f3a...9c2b): close_pnl_est = 48%
(just shy of 50% threshold)

Close request submitted
├─ tx_hash: 0xd4e5f...7a2b
├─ Selling back spread at bid: $815 USDC
├─ Entry cost: $185 USDC
├─ Realized P&L: +$630 USDC (+340%)
└─ Status: pending

Execution confirmed. Funds returned to your wallet.
```

**Why $815 bid?** The put spread has only $1000 max risk. When the market moved in your favor, the short leg (3100 put) became less likely to be exercised, so you can sell the entire spread back for nearly max profit.

---

### Step 8: Settle Expired Positions

After the 2026-03-28 expiry passes, you tweet:
```
@bankrbot settle all expired positions
```

Bankr replies:
```
🔍 Scanning for expired positions...
Found 0 expired positions.

(Your closed position from Step 7 was already exited, so nothing to settle.)

💰 Settlement History
Position #1 (3200/3100 PUT) — CLOSED pre-expiry
├─ Entry: $185 USDC
├─ Close payout: $815 USDC
├─ Realized P&L: +$630 USDC
└─ Tax lot: CLOSED

Final wallet balance: $3,080.50 USDC
(Started: $2,450.50 + Gain: +$630)
```

**Note**: If you had *not* closed in Step 7, Bankr would auto-settle on expiry, calculating whether each leg finished ITM or OTM.

---

## High IV Strategy (Advanced)

When the implied volatility of ETH is very high (>80%), sell spreads collect premium instead of paying it. This is ideal for traders who want to benefit from volatility crush.

### Recognizing High IV Conditions

From your scan output, watch for:
```
atm_iv: 85% (elevated)
```

### Sell Spread Example

You tweet:
```
@bankrbot scan ETH neutral-bearish spreads when IV > 80
```

Bankr replies:
```
🔍 Scanning ETH sell-call spreads (neutral-bearish, high IV)
atm_iv: 85% (high!)

Rank | Strike Pair | Credit | Max Risk | RR    | Credit %
──────────────────────────────────────────────────────
  1  | 3500/3600   | $280  | $720     | 0.39x | 28%
  2  | 3400/3500   | $245  | $755     | 0.32x | 24.5%
  3  | 3300/3400   | $210  | $790     | 0.27x | 21%

Credit % = credit as % of max risk (higher = better margin)
Note: You POST collateral = max risk, not credit upfront.
```

You execute:
```
@bankrbot execute rank 1 ETH neutral-bearish spread size 1 — I authorize live execution
```

Result:
```
✅ SellCallSpread (neutral-bearish)
├─ Short: 3500 CALL (receive $280 credit)
├─ Long: 3600 CALL (protection)
├─ Size: 1 contract
├─ Collateral posted: $720 USDC (max risk)
├─ Net credit: +$280 USDC
├─ tx_hash: 0x...
└─ Status: executed

If ETH stays below $3500 by expiry, you keep all $280.
If ETH rises above $3600, you lose max $720.
```

**Key difference from buy spreads**:
- **Buy spread**: You pay cost upfront, profit is capped at (strike diff − cost)
- **Sell spread**: You receive credit upfront, risk is (strike diff − credit)

---

## Session State

Bankr maintains this state across all tweets/casts in a conversation:

```json
{
  "wallet_address": "0x8f...9d2a",
  "usdc_balance": 2450.50,
  "open_positions": [
    {
      "request_key": "0x7f3a...9c2b",
      "strategy": "BuyPutSpread",
      "underlying": "ETH",
      "entry_cost": 185,
      "entry_time": "2026-03-23T14:32:15Z",
      "long_strike": 3200,
      "short_strike": 3100,
      "size": 1
    }
  ],
  "last_scan": {
    "asset": "ETH",
    "bias": "bearish",
    "expiry": "2026-03-28",
    "candidates": [...]
  }
}
```

**Why this matters**: `request_keys` must persist across tweets. If Bankr loses them, you lose per-position P&L tracking. Save them yourself or use the recovery command.

---

## Recovering Lost request_keys

If your Bankr session crashes or resets, you can recover all open positions:

You tweet:
```
@bankrbot recover my positions and load request keys
```

Bankr replies:
```
🔍 Scanning wallet 0x8f...9d2a for open positions...

Lookback: last ~50k blocks (~1 day on Base)

Found 2 open positions:
├─ request_key: 0x7f3a...9c2b (BuyPutSpread, 3200/3100, $185)
├─ request_key: 0xabc1...2d3e (BuyCallSpread, 3400/3500, $220)

✅ Request keys recovered. Session state reloaded.

Portfolio summary with P&L:
Position #1: −$12 (−6.5%)
Position #2: +$45 (+20.5%)

Continuing...
```

**What Bankr does**:
1. Calls `callput_list_positions_by_wallet()` to read on-chain events
2. Extracts all `request_keys` from executed spreads
3. Reloads them into session state
4. Re-runs portfolio summary to show live P&L

For positions older than 1 day, you may need to specify:
```
@bankrbot recover positions from 7 days ago
```

---

## Safety Rules

Bankr enforces these 8 rules to protect your capital:

1. **No single-leg options**: Always spreads (buy or sell), never naked calls/puts.

2. **Dry-run by default**: Every trade is simulated first. Live execution requires explicit authorization ("I authorize").

3. **Balance checks**: If USDC balance < 2× estimated cost, Bankr stops the trade.

4. **Expiry protection**: Won't open positions with < 6 hours to expiry (prevents gamma blowups).

5. **Urgent position management**: If any position expires within 24 hours, Bankr forces you to close or roll before opening new trades.

6. **Cost quality filter**: Skips buy spreads where `cost_pct_of_max > 40%` (poor risk/reward).

7. **Persistent request_keys**: You must save `request_keys` from every executed trade. Losing them means losing P&L.

8. **Never share private keys**: Your agent wallet's private key is managed securely by Bankr. CALLPUT_PRIVATE_KEY is never needed or exposed.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| "USDC balance too low" | Not enough balance for spread cost. | Deposit more USDC to your Base wallet. |
| "Dry-run failed: wrong leg order" | Call spreads need long < short strike; put spreads need long > short strike. | Check your scan output and select a valid rank. |
| `check_request_status` returns "pending" for > 3 min | Network congestion or RPC lag. | Wait up to 6 more polls (3 min total). If still pending after 6 attempts, recheck tx_hash on [basescan.org](https://basescan.org). |
| "No spreads found in scan" | Wrong asset, no candidates at that expiry, or outside market hours. | Try a different expiry ("`scan ETH spreads for next Friday`") or check if the Callput market is live. |
| Position shows no P&L | `request_key` was not saved to session state. | Use the recovery command: `@bankrbot recover my positions`. |
| "I forgot my request_key for position X" | Session lost or wallet reset. | Tweet `@bankrbot recover positions from [timeframe]` to re-scan on-chain. |
| Bankr returns "signing failed" error | The unsigned_tx from MCP may be malformed or signer issue. | Verify: (1) All addresses are checksummed (use ethers.getAddress()), (2) Chain ID is 8453 (Base), (3) Amount values are positive. If persists, check your wallet's signing setup with Bankr. |
| "RPC timeout" or slow transaction | Bankr's MCP connection or Base RPC may be experiencing delays. | Wait a few seconds and retry the command. Check network status at [base.network](https://base.network). Use a smaller position size to test connectivity. |
| Transaction broadcast returns "code 32" | This is a consensus error from the Base network. | Likely causes: (1) Nonce conflict (try again after 1 block, ~12 seconds), (2) Insufficient USDC balance after accounting for gas fees, (3) Spread has expired or moved out of your price range. |

---

## Bankr API Reference

Bankr's backend calls these endpoints for every trade:

| Endpoint | Method | Purpose | Request | Response |
|----------|--------|---------|---------|----------|
| `/agent/sign` | POST | Sign unsigned transaction | `{ "unsigned_tx": { "to": "0x...", "data": "0x...", "value": "0", "chain_id": 8453 }, "wallet": "0x8f...9d2a" }` | `{ "signed_tx": "0x...", "signature": "0x..." }` |
| `/agent/submit` | POST | Broadcast signed transaction to Base Mainnet | `{ "signed_tx": "0x...", "chain": 8453 }` | `{ "tx_hash": "0xa8b2...3e1f", "status": "pending" }` |

**API Base**: `https://api.bankr.bot`

**Complete transaction flow**:
```
1. MCP (callput_execute_spread) builds unsigned_tx
   Returns: { unsigned_tx: { to, data, value, chain_id }, usdc_approval: {...} }

2. [If usdc_approval.sufficient == false]
   → Sign and broadcast approve_tx first

3. Bankr calls /agent/sign with unsigned_tx
   POST https://api.bankr.bot/agent/sign
   Body: { "unsigned_tx": { "to": "0xCallput", "data": "0xabc...", "value": "0", "chain_id": 8453 }, "wallet": "0x8f...9d2a" }
   Response: { "signed_tx": "0x123...", "signature": "0x..." }

4. Bankr calls /agent/submit
   POST https://api.bankr.bot/agent/submit
   Body: { "signed_tx": "0x123...", "chain": 8453 }
   Response: { "tx_hash": "0xa8b2...3e1f" }

5. Bankr calls callput_get_request_key_from_tx(tx_hash)
   Returns: { request_key: "0x7f3a...9c2b" }

6. Persist request_key for P&L tracking

7. Bankr calls callput_check_request_status(request_key)
   Poll every 30s until status = "executed" or "cancelled"
```

---

## Summary

You now know how to:
- ✅ Connect your wallet to Bankr
- ✅ Scan Callput spreads and understand cost vs. max profit
- ✅ Dry-run before live execution
- ✅ Execute ETH/BTC bullish and bearish spreads
- ✅ Monitor P&L and close positions for profit
- ✅ Settle expired spreads
- ✅ Trade high-IV sell spreads
- ✅ Recover lost position data

**Remember**: Your USDC stays in your wallet. Bankr manages your agent wallet securely and executes trades on your authorization. Every trade requires your approval. Happy trading!

For more help, tweet: `@bankrbot help` or check Bankr's latest documentation.
