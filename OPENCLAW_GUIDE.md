# OpenClaw Integration Guide — Callput Lite MCP

Copy-paste setup guide for connecting `callput-lite-agent-mcp` to OpenClaw (or any MCP-compatible agent runtime).

---

## Prerequisites

- Node.js 18+
- A USDC-funded wallet on **Base Mainnet** (chain 8453)
- The wallet's private key (stays in your MCP env — never leaves the server)

---

## Step 1 — Clone & Build

```bash
git clone <repo-url> callput-lite-mcp-skill-standalone
cd callput-lite-mcp-skill-standalone
npm install
npm run build
```

Verify:
```bash
node build/index.js --help   # should not error (stdio MCP server — connect via MCP client)
```

---

## Step 2 — MCP Server Configuration

Add this block to your MCP config file (`~/.config/mcp/config.json`, Claude Desktop `claude_desktop_config.json`, or your OpenClaw server config):

```json
{
  "mcpServers": {
    "callput": {
      "command": "node",
      "args": ["/absolute/path/to/callput-lite-mcp-skill-standalone/build/index.js"],
      "env": {
        "CALLPUT_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE",
        "RPC_URL": "https://mainnet.base.org"
      }
    }
  }
}
```

> **Important**: Replace `/absolute/path/to/...` with the real path. `CALLPUT_PRIVATE_KEY` is only used for live execution — dry-run mode works without it.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CALLPUT_PRIVATE_KEY` | Yes (live mode) | — | Wallet private key (hex, with `0x`) |
| `RPC_URL` | No | `https://mainnet.base.org` | Base Mainnet RPC endpoint |

---

## Step 3 — Agent System Prompt

Inject the contents of `EXTERNAL_AGENT_PROMPT.md` as your agent's system prompt (or prepend it to the conversation context). This file encodes all 14 safety rules and the full trading workflow the agent must follow.

**Copy-paste block** (inline into your agent config):

```
You are a spread-only Callput trading agent on Base.

## Safety rules (non-negotiable)
1. Always call callput_scan_spreads to find candidates (replaces validate_spread).
2. Never trade single-leg options.
3. Keep dry_run=true unless the user has explicitly authorized real execution in this session.
4. Call spread ordering: long lower strike, short higher strike.
5. Put spread ordering: long higher strike, short lower strike.
6. After broadcast, poll callput_check_request_status until executed or cancelled.
7. Use callput_close_position for pre-expiry exits only.
8. Use callput_settle_position for expired positions only.
9. Never expose CALLPUT_PRIVATE_KEY in any output, log, or message.

## Trading frequency rules
10. Call callput_portfolio_summary before every new position — skip if usdc_balance < 2× estimated spread cost.
11. Skip buy spreads where cost_pct_of_max > 40% — poor risk/reward.
12. Never open positions with days_to_expiry < 0.25 (< 6 hours).
13. If urgent_count > 0 in portfolio summary, manage expiring positions before opening new ones.
14. Save every request_key from execute_spread into your session state — required for P&L tracking.
15. If request_keys are lost, call callput_list_positions_by_wallet to recover from on-chain events.
16. Check atm_iv in scan output: high IV (>80% ETH, >70% BTC) favors neutral-bearish/neutral-bullish sell spreads.

## bias options
bullish → BuyCallSpread | bearish → BuyPutSpread | neutral-bearish → SellCallSpread | neutral-bullish → SellPutSpread

## Workflow
portfolio_summary [→ list_positions_by_wallet if keys lost] → scan_spreads (with atm_iv) → execute_spread (dry_run) → execute_spread (live) → check_request_status → save request_key → portfolio_summary + request_keys → [on expiry: settle_position → get_settled_pnl]
```

Or reference `EXTERNAL_AGENT_PROMPT.md` directly if your agent runtime supports file injection.

---

## Step 4 — SKILL.md (Optional, Recommended)

If your agent runtime supports skill/persona files, register `SKILL.md` as the agent's skill document. It provides:
- Preferred fast-path workflow
- Strike selection guidance
- Bias → strategy mapping table
- Full P&L tracking pattern with per-position field descriptions

---

## Step 5 — First Session Checklist

Run these commands in order at the start of every agent session:

```
1. "Run a portfolio summary."
   → callput_portfolio_summary({ address: "0x...", request_keys: [] })
   → Check: usdc_balance, urgent_count, open positions

2. "Scan ETH bullish spreads."
   → callput_scan_spreads({ underlying_asset: "ETH", bias: "bullish" })
   → Review: candidates, cost_pct_of_max, days_to_expiry, atm_iv

3. "Dry-run rank 1 spread with size 1."
   → callput_execute_spread({ strategy: "BuyCallSpread", from_address: "0x...", long_leg_id: "...", short_leg_id: "...", size: 1 })
   → Inspect: unsigned_tx payload, estimated_cost_usd, usdc_approval

5. [Only after explicit user authorization:]
   "I authorize live execution. Execute the rank 1 ETH bullish spread with size 1."
   → callput_execute_spread({ ...rank1, size: 1, dry_run: false })
   → Save: request_key immediately

6. "Poll status until executed."
   → callput_check_request_status({ request_key: "0x...", is_open: true })
   → Repeat every 30s, max 6 attempts
```

---

## P&L Tracking

Pass all saved `request_keys` to `callput_portfolio_summary` to unlock per-position P&L:

```
callput_portfolio_summary({ request_keys: ["0xabc...", "0xdef..."] })
```

### Per-position P&L fields returned

| Field | Description |
|---|---|
| `entry_cost_usd` | On-chain cost basis from `openPositionRequests(key).amountIn` |
| `current_value_usd` | Live mark-price spread value (fair mid) |
| `unrealized_pnl_usd` | `current_value_usd − entry_cost_usd` (mark-based, not tradeable) |
| `unrealized_pnl_pct` | Unrealized P&L as % of entry cost |
| `close_bid_value_usd` | Bid-based close estimate: what you'd actually receive if closing now |
| `close_pnl_est_usd` | `close_bid_value_usd − entry_cost_usd` (realistic exit P&L) |
| `close_pnl_est_pct` | Close P&L as % of entry cost |

**Key distinction**:
- `unrealized_pnl_usd` — mark/mid price (fair value, theoretical)
- `close_pnl_est_usd` — bid-based (what you'd actually get on close right now)

**Profit-taking rule**: consider closing when `close_pnl_est_pct > 50` (50% gain on tradeable close).

### How request_key → position is bridged

`openPositionRequests(key).optionTokenId` maps each `request_key` to the ERC-1155 token that represents your position. This is resolved automatically inside `callput_portfolio_summary` — you only need to pass the saved `request_keys` array.

---

## Example Agent Commands

| Intent | Command |
|---|---|
| Session start | `"Bootstrap the agent, check rules, then run a portfolio summary."` |
| Market scan | `"Scan ETH bearish spreads and show me the top 3 candidates."` |
| Dry run | `"Execute rank 1 BTC bullish spread with size 1 — dry run only."` |
| Live execution | `"I authorize live execution. Execute rank 1 ETH bearish spread with size 1."` |
| Portfolio + P&L | `"Check my full portfolio summary and show current P&L on all positions."` |
| Profit taking | `"Show close_pnl_est_pct for all positions and close any above 50%."` |
| Pre-expiry exit | `"Close all positions expiring within 24 hours."` |
| Settlement | `"Settle all expired ETH and BTC positions."` |

---

## Recovering Lost request_keys (Session Recovery)

If your agent session dies and `request_keys` are lost, use the wallet lookup tool to recover them:

```
callput_list_positions_by_wallet({})
→ returns open_request_keys[]
→ pass to callput_portfolio_summary({ request_keys: [...] })
```

Default lookback is ~50k blocks (~1 day on Base). For older positions:
```
callput_list_positions_by_wallet({ from_block: latestBlock - 500000 })
```

---

## Realized P&L (Post-Settlement)

After `callput_settle_position` is called, query realized payouts:

```
callput_get_settled_pnl({})
→ returns settlements[] with amount_out_usd per position
→ subtract entry_cost_usd to get realized P&L
```

---

## Sell Spread Strategy (High IV Environments)

When `atm_iv` from `scan_spreads` is elevated, sell spreads collect premium:

```
callput_scan_spreads({ underlying_asset: "ETH", bias: "neutral-bearish" })
→ SellCallSpread candidates ranked by credit_pct_of_max (higher = better)
→ fields: spread_credit, max_risk, credit_pct_of_max, risk_reward, atm_iv

callput_execute_spread({
  strategy: "SellCallSpread",
  long_leg_id: "...",
  short_leg_id: "...",
  size: 1,
  dry_run: true
})
```

Note: Sell spreads post `strikeDiff × size` USDC as collateral. `amountIn = strikeDiff × size`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `execute_spread failed: CALLPUT_PRIVATE_KEY not set` | Add key to MCP env config |
| `scan_spreads failed: no candidates` | Try a different expiry or check market hours |
| `check_request_status` returns `pending` indefinitely | Wait up to 3 min; if still pending after 6 polls, the order may have been dropped — check the keeper status |
| Position shows no P&L fields | You forgot to pass `request_keys` to `portfolio_summary` |
| `validate_spread failed: wrong leg order` | Call spreads: long < short strike. Put spreads: long > short strike. |

---

## Session State to Maintain

```json
{
  "asset": "ETH",
  "bias": "bullish",
  "request_keys": ["0x...", "0x..."]
}
```

`request_keys` must persist across the entire session — losing them means losing per-position P&L lookup.
