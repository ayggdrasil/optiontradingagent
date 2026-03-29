# MCP UI Contract (1:1 Tool Mapping)

This document defines one UI component per MCP tool.

## Mapping Rules
- One tool => one action card.
- UI shows required inputs before run.
- UI renders normalized outputs in a fixed layout.
- No hidden transformations.

## Tool to Component

### 1. `callput_scan_spreads`
- Component: `MarketScanCard`
- Inputs: `asset` (ETH/BTC), `bias` (bullish/bearish/neutral-bearish/neutral-bullish)
- Outputs: ranked spread candidates, ATM IV, cost/credit, max profit/loss
- Trigger: user selects direction
- Note: Replaces old bootstrap + validate_spread workflow

### 2. `callput_execute_spread`
- Component: `ExecutionCard`
- Inputs: `strategy`, `from_address`, `long_leg_id`, `short_leg_id`, `size`
- Outputs: `unsigned_tx`, `usdc_approval` check, estimated costs
- Trigger: explicit operator authorization
- Note: Builds transaction; agent signs externally

### 3. `callput_check_request_status`
- Component: `RequestStatusCard`
- Inputs: `request_key`, `is_open`
- Outputs: status (pending/executed/cancelled), fill ratio
- Trigger: post-broadcast polling (every 30s)

### 4. `callput_portfolio_summary`
- Component: `PortfolioCard`
- Inputs: `address`, optional `request_keys`
- Outputs: USDC balance, open positions, P&L (unrealized + close estimates)
- Trigger: pre-trade check, dashboard refresh
- Note: Replaces old get_positions

### 5. `callput_get_request_key_from_tx`
- Component: `TxReceiptCard`
- Inputs: `tx_hash`
- Outputs: `request_key`, `is_open` flag
- Trigger: after broadcast confirmation
- Note: Parses GenerateRequestKey event

### 6. `callput_close_position`
- Component: `PreExpiryCloseCard`
- Inputs: `underlying_asset`, `from_address`, `option_token_id`, `size`
- Outputs: `unsigned_tx`, close estimate
- Trigger: when close_pnl_est > 50% or days_to_expiry < 1

### 7. `callput_settle_position`
- Component: `PostExpirySettleCard`
- Inputs: `underlying_asset`, `option_token_id`
- Outputs: `unsigned_tx`, settlement estimate
- Trigger: after expiry date

### 8. `callput_list_positions_by_wallet`
- Component: `RecoveryCard`
- Inputs: `address`, optional `from_block`
- Outputs: recovered `open_request_keys`, `close_request_keys`
- Trigger: session recovery (after loss)

### 9. `callput_get_settled_pnl`
- Component: `PnLHistoryCard`
- Inputs: `address`, optional `from_block`
- Outputs: settled position history with payout amounts
- Trigger: post-settlement analysis

### 10. `callput_get_option_chains`
- Component: `RawChainCard`
- Inputs: `underlying_asset`, optional filters
- Outputs: raw option chain data (strikes, IVs, bid/ask)
- Trigger: advanced users needing raw inspection
- Note: Use scan_spreads for normal workflow

## UX Guardrails
- Disable execution buttons until validation passes.
- Always default `dry_run=true` in UI examples.
- Show explicit warning: private key is not handled by this frontend.
