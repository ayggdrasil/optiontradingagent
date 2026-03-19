#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  checkRequestStatus,
  closePosition,
  executeSpread,
  getOptionChains,
  getPortfolioSummary,
  getRequestKeyFromTx,
  getSettledPnl,
  listPositionsByWallet,
  scanSpreads,
  settlePosition
} from "./core.js";

const server = new McpServer({
  name: "callput-lite-agent-mcp",
  version: "0.2.0"
});

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  };
}

// ── 1. callput_scan_spreads ───────────────────────────────────────────────────
server.registerTool(
  "callput_scan_spreads",
  {
    description:
      "Primary market scan. Returns up to max_results pre-ranked, ready-to-execute spread candidates. ATM-anchored with narrow/medium/wide widths. Includes ATM implied volatility (atm_iv) for buy-vs-sell strategy decisions. bias: bullish=BuyCallSpread, bearish=BuyPutSpread, neutral-bearish=SellCallSpread (collect premium), neutral-bullish=SellPutSpread (collect premium). High IV favors sell spreads. Pass long_leg_id + short_leg_id directly to execute_spread.",
    inputSchema: z.object({
      underlying_asset: z.string(),
      bias: z.enum(["bullish", "bearish", "neutral-bearish", "neutral-bullish"]),
      max_results: z.number().int().min(1).max(5).optional()
    })
  },
  async (args) => {
    try {
      const result = await scanSpreads({
        underlyingAsset: args.underlying_asset,
        bias: args.bias,
        maxResults: args.max_results
      });
      return ok(result as Record<string, unknown>);
    } catch (e: any) {
      return fail(`scan_spreads failed: ${e.message}`);
    }
  }
);

// ── 2. callput_execute_spread ─────────────────────────────────────────────────
server.registerTool(
  "callput_execute_spread",
  {
    description:
      "Build an unsigned spread transaction. Returns unsigned_tx (to/data/value/chain_id) for the agent to sign and broadcast. Also returns usdc_approval: if sufficient=false, sign and send approve_tx first. After broadcast, call callput_get_request_key_from_tx with the tx hash.",
    inputSchema: z.object({
      strategy: z.enum(["BuyCallSpread", "SellCallSpread", "BuyPutSpread", "SellPutSpread"]),
      from_address: z.string(),
      long_leg_id: z.string(),
      short_leg_id: z.string(),
      size: z.number().positive(),
      min_fill_ratio: z.number().min(0.01).max(1).optional()
    })
  },
  async (args) => {
    try {
      const result = await executeSpread({
        strategy: args.strategy,
        fromAddress: args.from_address,
        longLegId: args.long_leg_id,
        shortLegId: args.short_leg_id,
        size: args.size,
        minFillRatio: args.min_fill_ratio
      });
      return ok(result as Record<string, unknown>);
    } catch (e: any) {
      return fail(`execute_spread failed: ${e.message}`);
    }
  }
);

// ── 3. callput_get_request_key_from_tx ───────────────────────────────────────
server.registerTool(
  "callput_get_request_key_from_tx",
  {
    description:
      "Extract request_key from a transaction receipt after broadcasting an execute_spread or close_position tx. Returns request_key and is_open flag. Persist the request_key for P&L tracking via portfolio_summary.",
    inputSchema: z.object({
      tx_hash: z.string()
    })
  },
  async (args) => {
    try {
      const result = await getRequestKeyFromTx(args.tx_hash);
      return ok(result as Record<string, unknown>);
    } catch (e: any) {
      return fail(`get_request_key_from_tx failed: ${e.message}`);
    }
  }
);

// ── 4. callput_check_request_status ──────────────────────────────────────────
server.registerTool(
  "callput_check_request_status",
  {
    description: "Poll keeper status by request_key. Call after broadcasting a tx until status is executed or cancelled.",
    inputSchema: z.object({
      request_key: z.string(),
      is_open: z.boolean()
    })
  },
  async (args) => {
    try {
      const status = await checkRequestStatus(args.request_key, args.is_open);
      return ok(status as Record<string, unknown>);
    } catch (e: any) {
      return fail(`check_request_status failed: ${e.message}`);
    }
  }
);

// ── 5. callput_portfolio_summary ──────────────────────────────────────────────
server.registerTool(
  "callput_portfolio_summary",
  {
    description:
      "Returns USDC balance, all active positions enriched with current spread mark value, and optional P&L. Pass request_keys (saved from prior execute_spread calls) to enable cost-basis lookup from on-chain openPositionRequests and compute actual P&L.",
    inputSchema: z.object({
      address: z.string(),
      request_keys: z.array(z.string()).optional()
    })
  },
  async (args) => {
    try {
      const result = await getPortfolioSummary({
        address: args.address,
        requestKeys: args.request_keys
      });
      return ok(result as Record<string, unknown>);
    } catch (e: any) {
      return fail(`portfolio_summary failed: ${e.message}`);
    }
  }
);

// ── 6. callput_close_position ─────────────────────────────────────────────────
server.registerTool(
  "callput_close_position",
  {
    description:
      "Build an unsigned close-position transaction. Returns unsigned_tx for the agent to sign and broadcast. Use when days_to_expiry < 1 or close_pnl_est_pct > 50.",
    inputSchema: z.object({
      underlying_asset: z.string(),
      from_address: z.string(),
      option_token_id: z.string(),
      size: z.number().positive()
    })
  },
  async (args) => {
    try {
      const out = await closePosition({
        underlyingAsset: args.underlying_asset,
        fromAddress: args.from_address,
        optionTokenId: args.option_token_id,
        size: args.size
      });
      return ok(out as Record<string, unknown>);
    } catch (e: any) {
      return fail(`close_position failed: ${e.message}`);
    }
  }
);

// ── 7. callput_settle_position ────────────────────────────────────────────────
server.registerTool(
  "callput_settle_position",
  {
    description:
      "Build an unsigned settle transaction for an expired position. Returns unsigned_tx for the agent to sign and broadcast.",
    inputSchema: z.object({
      underlying_asset: z.string(),
      option_token_id: z.string()
    })
  },
  async (args) => {
    try {
      const out = await settlePosition({
        underlyingAsset: args.underlying_asset,
        optionTokenId: args.option_token_id
      });
      return ok(out as Record<string, unknown>);
    } catch (e: any) {
      return fail(`settle_position failed: ${e.message}`);
    }
  }
);

// ── 8. callput_list_positions_by_wallet ───────────────────────────────────────
server.registerTool(
  "callput_list_positions_by_wallet",
  {
    description:
      "Recover all request_keys from on-chain GenerateRequestKey events for a wallet. Use after session loss to restore P&L tracking. Returns open_request_keys (pass to portfolio_summary) and close_request_keys. Default lookback: ~50k blocks (~1 day on Base). Set from_block lower for older positions.",
    inputSchema: z.object({
      address: z.string(),
      from_block: z.number().int().optional()
    })
  },
  async (args) => {
    try {
      const result = await listPositionsByWallet({
        address: args.address,
        fromBlock: args.from_block
      });
      return ok(result as Record<string, unknown>);
    } catch (e: any) {
      return fail(`list_positions_by_wallet failed: ${e.message}`);
    }
  }
);

// ── 9. callput_get_settled_pnl ────────────────────────────────────────────────
server.registerTool(
  "callput_get_settled_pnl",
  {
    description:
      "Query SettlePosition events to retrieve realized payout history. Returns amount_out_usd (gross USDC received at settlement) per position. Subtract entry_cost_usd from portfolio_summary to compute realized P&L. Default lookback: ~50k blocks (~1 day on Base).",
    inputSchema: z.object({
      address: z.string(),
      from_block: z.number().int().optional()
    })
  },
  async (args) => {
    try {
      const result = await getSettledPnl({
        address: args.address,
        fromBlock: args.from_block
      });
      return ok(result as Record<string, unknown>);
    } catch (e: any) {
      return fail(`get_settled_pnl failed: ${e.message}`);
    }
  }
);

// ── 10. callput_get_option_chains ─────────────────────────────────────────────
server.registerTool(
  "callput_get_option_chains",
  {
    description: "Fetch raw tradable options from Callput market feed. Prefer callput_scan_spreads for normal use; use this only when you need raw chain data or IV inspection.",
    inputSchema: z.object({
      underlying_asset: z.string(),
      option_type: z.enum(["Call", "Put"]).optional(),
      expiry_date: z.string().optional(),
      max_expiries: z.number().int().min(1).max(5).optional(),
      max_strikes: z.number().int().min(2).max(30).optional()
    })
  },
  async (args) => {
    try {
      const chains = await getOptionChains({
        underlyingAsset: args.underlying_asset,
        optionType: args.option_type,
        expiryDate: args.expiry_date,
        maxExpiries: args.max_expiries,
        maxStrikes: args.max_strikes
      });
      return ok(chains as Record<string, unknown>);
    } catch (e: any) {
      return fail(`get_option_chains failed: ${e.message}`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
