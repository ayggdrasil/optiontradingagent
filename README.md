# Callput Lite MCP + Skill

Minimal documentation package for external agents (OpenClaw, Bankr, others) to trade on Callput.app on Base.

This package is designed for:
- minimal setup
- minimal context usage
- spread-only safe workflow
- no Python SDK dependency on the external agent side

## What You Get
- Minimal MCP server (`stdio`) with core tools only
- Ready-to-use `SKILL.md`
- OpenClaw/Bankr MCP config templates
- First-trade prompt templates
- Safe defaults (`dry_run=true`)
- Frontend V1 guidance console (`frontend-v1/`)

## Folder Contents
- `src/` : MCP server implementation
- `SKILL.md` : external agent skill policy
- `MCP_SETUP.md` : setup instructions
- `EXTERNAL_AGENT_PROMPT.md` : system prompt block
- `OPENCLAW_MCP_CONFIG.template.json` : OpenClaw config template
- `BANKR_MCP_CONFIG.template.json` : Bankr config template
- `FIRST_TRADE_PROMPTS.md` : copy-paste trading prompts
- `FRONTEND_V1_SPEC.md` : V1 product scope and boundaries
- `MCP_UI_CONTRACT.md` : tool-to-component 1:1 contract
- `ARCHITECTURE_V1.md` : frontend vs agent runtime responsibilities
- `FAQ.md` : operator FAQ
- `frontend-v1/` : static responsive UI for V1 guidance

## MCP Tool Set (10 tools)
- `callput_scan_spreads` — Market scan with ranked spread candidates
- `callput_execute_spread` — Build unsigned spread transaction
- `callput_get_request_key_from_tx` — Extract request_key from receipt
- `callput_check_request_status` — Poll keeper status by request_key
- `callput_portfolio_summary` — USDC balance + positions + P&L
- `callput_close_position` — Build unsigned close transaction
- `callput_settle_position` — Build unsigned settle transaction
- `callput_list_positions_by_wallet` — Recover request_keys from events
- `callput_get_settled_pnl` — Realized payout history
- `callput_get_option_chains` — Raw option chains from market feed

## Quick Start

```bash
cd <repo_root>
npm install
npm run build
npm run verify
npm run verify:mcp
```

## Runtime Environment
- `RPC_URL` (optional)
  - default: `https://mainnet.base.org`
- `CALLPUT_PRIVATE_KEY` (required only for real execution mode)

## Connect OpenClaw / Bankr
1. Copy template:
   - `OPENCLAW_MCP_CONFIG.template.json` or `BANKR_MCP_CONFIG.template.json`
2. Replace placeholders:
   - `<repo_root>`
   - `CALLPUT_PRIVATE_KEY`
3. Restart agent runtime.
4. Run first prompts from `FIRST_TRADE_PROMPTS.md`.

## Frontend V1 (Guidance UI)

Open the static UI:

```bash
cd <repo_root>/frontend-v1
python3 -m http.server 4173
```

Then visit `http://localhost:4173`.

V1 flow in UI:
1. Direction setup
2. Option lookup
3. Execute spread
4. Position adjustment (status/close/settle)

V1 note:
- Market analysis template is deferred to V2.

## Execution Modes
- Dry-run (default):
  - `callput_execute_spread(dry_run=true)`
  - `callput_close_position(dry_run=true)`
  - `callput_settle_position(dry_run=true)`
- Real execution:
  - set `dry_run=false`
  - ensure `CALLPUT_PRIVATE_KEY` is set in MCP env

## Mandatory Trading Rules
1. Spread-only execution.
2. Validate before execute.
3. Call spread: long lower strike, short higher strike.
4. Put spread: long higher strike, short lower strike.
5. Poll request status after broadcast.
6. Close pre-expiry, settle post-expiry.

## Notes
- The server fetches live market data from Callput S3 feed.
- Keep private keys out of logs and chat output.
- For production use, add your own notional/risk limits at orchestrator layer.
- Frontend does not store or process private keys. Key ownership remains in each external agent runtime.
