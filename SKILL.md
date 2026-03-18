---
name: callput-lite-trader
description: Spread-only Callput trading skill for external agents on Base. Bias-driven scan, ATM-anchored execution, on-chain P&L tracking.
license: MIT
---

# Callput Lite Trader Skill

## Goal
Trade Callput spreads autonomously with minimal tool calls and minimal context.

---

## Preferred flow (fast path)

```
1. callput_portfolio_summary          ← check positions + USDC balance before every trade
2. callput_scan_spreads               ← pick asset + bias, get ranked candidates
3. callput_execute_spread (dry_run)   ← confirm tx payload with rank 1 candidate
4. callput_execute_spread (live)      ← real execution (explicit user auth required)
5. callput_check_request_status       ← poll until executed/cancelled
6. persist request_key                ← REQUIRED for P&L tracking
```

---

## Hard rules

1. Spread-only. No single-leg execution ever.
2. Always check `callput_portfolio_summary` before opening a new position.
3. Use `callput_scan_spreads` as the primary market entry point — not raw `get_option_chains`.
4. Validate before execute if not using scan path (`callput_validate_spread`).
5. Call spread ordering: long lower strike, short higher strike.
6. Put spread ordering: long higher strike, short lower strike.
7. Keep `dry_run=true` unless user explicitly authorizes real execution.
8. `CALLPUT_PRIVATE_KEY` must never appear in any output or log.
9. **Save every `request_key` returned by `execute_spread`** — required for P&L via `portfolio_summary`.

---

## Bias → strategy mapping

| Bias     | Strategy        | Option type | Long leg         | Short leg        |
|----------|-----------------|-------------|------------------|------------------|
| bullish  | BuyCallSpread   | Call        | ATM call         | OTM call (higher strike) |
| bearish  | BuyPutSpread    | Put         | ATM put          | OTM put (lower strike)   |

---

## Strike selection (when using scan_spreads)

`callput_scan_spreads` handles this automatically:
- Long leg = ATM strike (nearest to spot price)
- Width variations: 1, 2, 3 strikes apart → narrow / medium / wide
- Ranked by `cost_pct_of_max` ascending (lower % = better value)
- **Prefer rank 1 unless days_to_expiry < 1**

Manual guidance (if using raw chains):
- ETH: target spread width of 100–200 USDC strike range
- BTC: target spread width of 1000–3000 USDC strike range
- Avoid spreads with `cost_pct_of_max > 40%` (overpaying for max payout)

---

## When to skip a trade

Skip and wait if any of these are true:
- `usdc_balance` (from portfolio_summary) < 2× estimated spread cost
- `cost_pct_of_max > 40%` (poor risk/reward)
- `days_to_expiry < 0.25` (< 6 hours) — too close to expiry
- `urgent_count > 0` — manage expiring positions first

---

## Position management

- **Poll keeper**: after every execute, poll `check_request_status` every 30s, max 3 minutes
- **Pre-expiry**: use `callput_close_position` when `days_to_expiry < 1`
- **Post-expiry**: use `callput_settle_position` for expired positions
- **Profit taking**: consider closing when `close_pnl_est_pct > 50` (50% gain on tradeable close)

---

## P&L tracking pattern

```
# After execute_spread returns:
agent_state.request_keys.push(result.request_key)

# To check P&L at any time:
callput_portfolio_summary({ request_keys: agent_state.request_keys })
```

### Per-position P&L fields (returned when `request_keys` are passed)

| Field | Description |
|---|---|
| `entry_cost_usd` | On-chain cost basis from `openPositionRequests(key).amountIn` |
| `current_value_usd` | Current mark-price spread value (mid fair value) |
| `unrealized_pnl_usd` | `current_value_usd − entry_cost_usd` (mark-based, not tradeable) |
| `unrealized_pnl_pct` | Unrealized P&L as % of entry cost |
| `close_bid_value_usd` | Bid-based close estimate: `naked.bid − pair.ask` (conservative, what you'd actually receive) |
| `close_pnl_est_usd` | `close_bid_value_usd − entry_cost_usd` (realistic exit P&L) |
| `close_pnl_est_pct` | Close P&L as % of entry cost |

**Use `close_pnl_est_usd` for profit-taking decisions** — it reflects what you'd receive if you closed now, not the fair mid.

**Profit taking rule**: consider closing when `close_pnl_est_pct > 50` (50% gain on tradeable close).

### P&L bridging: how request_key → position

`openPositionRequests(key).optionTokenId` links each `request_key` to the ERC-1155 token that represents the position. This is resolved automatically inside `callput_portfolio_summary` — agents only need to pass the saved `request_keys` array.

---

## One-line command examples

- `Scan ETH bearish and execute rank 1 spread.`
- `Check my portfolio summary and P&L.`
- `Close all positions expiring within 24 hours.`
- `Settle all expired ETH/BTC positions.`
