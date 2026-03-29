---
name: callput-lite-trader
description: Spread-only on-chain options trading skill for Base. MCP builds unsigned transactions; agent signs via Bankr /agent/sign and broadcasts via /agent/submit. Supports ETH/BTC spreads with full position lifecycle.
version: 1.0.0
homepage: https://callput.app
license: MIT
mcp:
  required:
    - name: callput-lite-agent-mcp
      setup: See references/SETUP.md
---

# Callput Lite Trader

Trade Callput spreads autonomously on Base using the MCP. The MCP builds unsigned transactions; Bankr agent handles signing and broadcasting.

---

## Integration Pattern (Bankr)

Bankr provides `/agent/sign` and `/agent/submit` endpoints for secure external signing:

```bash
# Step 1: MCP builds unsigned tx calldata
POST https://api.bankr.bot/callput/execute_spread
{
  "address": "0x...",
  "asset": "ETH",
  "bias": "bullish"
}
→ { "unsigned_tx": {...}, "calldata": "0x..." }

# Step 2: Agent signs with Bankr
POST https://api.bankr.bot/agent/sign
{
  "tx": { ...unsigned_tx... },
  "from": "0x..."
}
→ { "signature": "0x...", "v": 27, "r": "0x...", "s": "0x..." }

# Step 3: Agent submits signed tx
POST https://api.bankr.bot/agent/submit
{
  "tx": { ...unsigned_tx... },
  "signature": { "v": 27, "r": "0x...", "s": "0x..." }
}
→ { "tx_hash": "0x..." }

# Step 4: Poll tx status and extract request_key
GET https://api.bankr.bot/callput/get_request_key_from_tx?tx_hash=0x...
→ { "request_key": "0x..." }
```

---

## Preferred Flow

```
1. callput_portfolio_summary(address)
   ↓ check positions + USDC balance
2. callput_scan_spreads(asset, bias)
   ↓ get ranked candidates + atm_iv
3. callput_execute_spread(address, strategy)
   ↓ return unsigned_tx + calldata
4. POST /agent/sign → sign externally
5. POST /agent/submit → broadcast
6. callput_get_request_key_from_tx(tx_hash)
   ↓ extract request_key from receipt
7. persist request_key for P&L tracking
8. callput_check_request_status(request_key)
   ↓ poll every 30s until executed/cancelled
```

---

## Hard Rules

1. Spread-only. No single-leg execution ever.
2. Always check `callput_portfolio_summary` before opening a new position.
3. Use `callput_scan_spreads` as the primary market entry point.
4. Call spread ordering: long lower strike, short higher strike.
5. Put spread ordering: long higher strike, short lower strike.
6. **MCP never holds CALLPUT_PRIVATE_KEY — Bankr /agent/sign handles signing.**
7. If `usdc_approval.sufficient == false`, send approve_tx before the main tx.
8. **Save every `request_key` from `get_request_key_from_tx`** — required for P&L.
9. If `request_keys` are lost, call `callput_list_positions_by_wallet` to recover them.
10. Check `atm_iv` from scan output: high IV (>80% ETH, >70% BTC) favors sell spreads.

---

## Bias → Strategy Mapping

| Bias             | Strategy        | Option type | Direction          | Rank metric           |
|------------------|-----------------|-------------|--------------------|-----------------------|
| bullish          | BuyCallSpread   | Call        | Pay premium        | cost_pct_of_max ↓     |
| bearish          | BuyPutSpread    | Put         | Pay premium        | cost_pct_of_max ↓     |
| neutral-bearish  | SellCallSpread  | Call        | Collect premium    | credit_pct_of_max ↑   |
| neutral-bullish  | SellPutSpread   | Put         | Collect premium    | credit_pct_of_max ↑   |

Sell spreads post `strikeDiff × size` USDC as collateral. Best used in high-IV environments.

---

## Strike Selection

`callput_scan_spreads` handles this automatically:
- Long leg = ATM strike (nearest to spot price)
- Width variations: 1, 2, 3 strikes apart → narrow / medium / wide
- Ranked by `cost_pct_of_max` ascending (lower % = better value)
- **Prefer rank 1 unless days_to_expiry < 1**

Manual guidance (if using raw chains):
- ETH: target spread width of 100–200 USDC strike range
- BTC: target spread width of 1000–3000 USDC strike range
- Avoid spreads with `cost_pct_of_max > 40%`

---

## When to Skip a Trade

Skip and wait if any of these are true:
- `usdc_balance` < 2× estimated spread cost
- `cost_pct_of_max > 40%` (poor risk/reward)
- `days_to_expiry < 0.25` (< 6 hours)
- `urgent_count > 0` — manage expiring positions first

---

## Position Management

- **Poll keeper**: after broadcast, poll `check_request_status` every 30s, max 3 minutes
- **Pre-expiry**: use `callput_close_position` when `days_to_expiry < 1`
- **Post-expiry**: use `callput_settle_position` for expired positions
- **Profit taking**: close when `close_pnl_est_pct > 50` (50% gain)

---

## P&L Tracking Pattern

```javascript
// After broadcast + receipt:
const { request_key } = await callput_get_request_key_from_tx({ tx_hash })
agent_state.request_keys.push(request_key)

// To check P&L at any time:
callput_portfolio_summary({ address, request_keys: agent_state.request_keys })
```

### Per-position P&L fields

| Field | Description |
|---|---|
| `entry_cost_usd` | On-chain cost basis from `openPositionRequests(key).amountIn` |
| `current_value_usd` | Current mark-price spread value (mid fair value) |
| `unrealized_pnl_usd` | `current_value_usd − entry_cost_usd` |
| `unrealized_pnl_pct` | Unrealized P&L as % of entry cost |
| `close_bid_value_usd` | Bid-based close estimate (conservative) |
| `close_pnl_est_usd` | `close_bid_value_usd − entry_cost_usd` |
| `close_pnl_est_pct` | Close P&L as % of entry cost |

**Use `close_pnl_est_usd` for profit-taking decisions.**

---

## Tool Reference

| Tool | Purpose |
|---|---|
| `callput_scan_spreads` | Primary market scan — ranked spread candidates + ATM IV |
| `callput_execute_spread` | Build unsigned open-position tx + USDC allowance check |
| `callput_get_request_key_from_tx` | Parse request_key from tx receipt after broadcast |
| `callput_check_request_status` | Poll keeper until executed/cancelled |
| `callput_portfolio_summary` | USDC balance + positions + P&L (pass request_keys) |
| `callput_close_position` | Build unsigned close-position tx |
| `callput_settle_position` | Build unsigned settle tx for expired positions |
| `callput_list_positions_by_wallet` | Recover request_keys from on-chain events |
| `callput_get_settled_pnl` | Realized payout history from SettlePosition events |
| `callput_get_option_chains` | Raw chain data + IV (use scan_spreads first) |

---

## One-Line Command Examples

- `Scan ETH bullish spreads and build rank 1 via Bankr.`
- `Check portfolio P&L for address 0x... with saved request_keys.`
- `Close all positions expiring within 24 hours.`
- `Settle expired positions and report realized P&L.`
- `Execute a neutral-bearish BTC call spread with Bankr signing.`
