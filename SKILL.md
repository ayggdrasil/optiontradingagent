---
name: callput-lite-trader
description: Spread-only Callput trading skill for external agents on Base. Unsigned-tx pattern — MCP builds calldata, agent signs and broadcasts with its own key.
license: MIT
---

# Callput Lite Trader Skill

## Goal
Trade Callput spreads autonomously. MCP builds unsigned transactions; the agent signs and broadcasts using its own wallet.

---

## Preferred flow (fast path)

```
1. callput_portfolio_summary(address)       ← check positions + USDC balance
   [if request_keys lost]
   callput_list_positions_by_wallet(address) ← recover request_keys from on-chain events
2. callput_scan_spreads                     ← pick asset + bias, get ranked candidates + atm_iv
3. callput_execute_spread(from_address)     ← returns unsigned_tx + usdc_approval check
   [if usdc_approval.sufficient == false]
   → sign + broadcast approve_tx first
4. sign + broadcast unsigned_tx            ← agent signs with its own key
5. callput_get_request_key_from_tx(txHash) ← parse GenerateRequestKey from receipt
6. persist request_key                     ← REQUIRED for P&L tracking
7. callput_check_request_status            ← poll every 30s until executed/cancelled
   [after settlement]
   callput_get_settled_pnl                 ← realized payout history
```

---

## Hard rules

1. Spread-only. No single-leg execution ever.
2. Always check `callput_portfolio_summary` before opening a new position.
3. Use `callput_scan_spreads` as the primary market entry point.
4. Call spread ordering: long lower strike, short higher strike.
5. Put spread ordering: long higher strike, short lower strike.
6. MCP never holds or requires a private key — agent signs externally.
7. If `usdc_approval.sufficient == false`, send approve_tx before the main tx.
8. **Save every `request_key` from `get_request_key_from_tx`** — required for P&L.
9. If `request_keys` are lost, call `callput_list_positions_by_wallet` to recover them.
10. Check `atm_iv` from scan output: high IV (>80% ETH, >70% BTC) favors sell spreads.

---

## Bias → strategy mapping

| Bias             | Strategy        | Option type | Direction          | Rank metric           |
|------------------|-----------------|-------------|--------------------|-----------------------|
| bullish          | BuyCallSpread   | Call        | Pay premium        | cost_pct_of_max ↓     |
| bearish          | BuyPutSpread    | Put         | Pay premium        | cost_pct_of_max ↓     |
| neutral-bearish  | SellCallSpread  | Call        | Collect premium    | credit_pct_of_max ↑   |
| neutral-bullish  | SellPutSpread   | Put         | Collect premium    | credit_pct_of_max ↑   |

Sell spreads post `strikeDiff × size` USDC as collateral. Best used in high-IV environments.

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

- **Poll keeper**: after every broadcast, poll `check_request_status` every 30s, max 3 minutes
- **Pre-expiry**: use `callput_close_position` when `days_to_expiry < 1`
- **Post-expiry**: use `callput_settle_position` for expired positions
- **Profit taking**: consider closing when `close_pnl_est_pct > 50` (50% gain on tradeable close)

---

## P&L tracking pattern

```
# After broadcast + receipt:
const { request_key } = await callput_get_request_key_from_tx({ tx_hash })
agent_state.request_keys.push(request_key)

# To check P&L at any time:
callput_portfolio_summary({ address, request_keys: agent_state.request_keys })
```

### Per-position P&L fields (returned when `request_keys` are passed)

| Field | Description |
|---|---|
| `entry_cost_usd` | On-chain cost basis from `openPositionRequests(key).amountIn` |
| `current_value_usd` | Current mark-price spread value (mid fair value) |
| `unrealized_pnl_usd` | `current_value_usd − entry_cost_usd` (mark-based, not tradeable) |
| `unrealized_pnl_pct` | Unrealized P&L as % of entry cost |
| `close_bid_value_usd` | Bid-based close estimate: `naked.bid − pair.ask` (conservative) |
| `close_pnl_est_usd` | `close_bid_value_usd − entry_cost_usd` (realistic exit P&L) |
| `close_pnl_est_pct` | Close P&L as % of entry cost |

**Use `close_pnl_est_usd` for profit-taking decisions.**

---

## Tool reference (10 tools)

| Tool | Purpose |
|---|---|
| `callput_scan_spreads` | Primary market scan — ranked spread candidates + ATM IV |
| `callput_execute_spread` | Build unsigned open-position tx + USDC allowance check |
| `callput_get_request_key_from_tx` | Parse request_key from tx receipt after broadcast |
| `callput_check_request_status` | Poll keeper until executed/cancelled |
| `callput_portfolio_summary` | USDC balance + positions + P&L (pass request_keys) |
| `callput_close_position` | Build unsigned close-position tx |
| `callput_settle_position` | Build unsigned settle tx for expired positions |
| `callput_list_positions_by_wallet` | Recover request_keys from on-chain events (after session loss) |
| `callput_get_settled_pnl` | Realized payout history from SettlePosition events |
| `callput_get_option_chains` | Raw chain data + IV (use scan_spreads first) |

---

## One-line command examples

- `Scan ETH bearish and build the rank 1 spread tx.`
- `Check my portfolio summary and P&L for address 0x...`
- `Close all positions expiring within 24 hours.`
- `Settle all expired ETH/BTC positions.`
