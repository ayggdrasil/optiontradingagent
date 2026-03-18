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
  getPositions,
  scanSpreads,
  settlePosition,
  validateSpread
} from "./core.js";

const server = new McpServer({
  name: "callput-lite-agent-mcp",
  version: "0.1.0"
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

server.registerTool(
  "callput_bootstrap",
  {
    description: "Return minimal workflow and strict rules for external agents.",
    inputSchema: z.object({})
  },
  async () => {
    return ok({
      objective: "Trade Callput spreads safely on Base with minimal context.",
      flow: [
        "market_scan",
        "direction_decision",
        "validate_spread",
        "execute_spread_or_adjust",
        "close_or_settle"
      ],
      rules: [
        "Spread-only execution.",
        "Always validate spread before execute.",
        "Call spread: long lower strike, short higher strike.",
        "Put spread: long higher strike, short lower strike.",
        "If execute mode is used, CALLPUT_PRIVATE_KEY must be set in MCP env.",
        "Use check_request_status after tx broadcast until executed/cancelled."
      ],
      tools: [
        "callput_scan_spreads — primary entry point for market scan (bias-driven, returns ≤5 ranked spreads)",
        "callput_portfolio_summary — positions + mark value + P&L (pass request_keys for cost basis)",
        "callput_validate_spread — pre-execution check",
        "callput_execute_spread — execute or dry-run",
        "callput_check_request_status — poll keeper after broadcast",
        "callput_close_position — pre-expiry exit",
        "callput_settle_position — post-expiry settlement",
        "callput_get_option_chains — raw chain data (use scan_spreads first)"
      ],
      minimal_state: [
        "asset",
        "bias",
        "expiry_code",
        "long_leg_id",
        "short_leg_id",
        "request_key",
        "request_status",
        "request_keys[]  ← persist ALL executed request_keys for P&L tracking"
      ]
    });
  }
);

server.registerTool(
  "callput_get_option_chains",
  {
    description: "Fetch compact tradable options from Callput market feed.",
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

server.registerTool(
  "callput_validate_spread",
  {
    description: "Validate spread legs before execution.",
    inputSchema: z.object({
      strategy: z.enum(["BuyCallSpread", "SellCallSpread", "BuyPutSpread", "SellPutSpread"]),
      long_leg_id: z.string(),
      short_leg_id: z.string()
    })
  },
  async (args) => {
    try {
      const validation = await validateSpread(args.strategy, args.long_leg_id, args.short_leg_id);
      return ok(validation as Record<string, unknown>);
    } catch (e: any) {
      return fail(`validate_spread failed: ${e.message}`);
    }
  }
);

server.registerTool(
  "callput_execute_spread",
  {
    description: "Execute spread trade (or dry-run tx payload). Auto-approves USDC when needed in execute mode.",
    inputSchema: z.object({
      strategy: z.enum(["BuyCallSpread", "SellCallSpread", "BuyPutSpread", "SellPutSpread"]),
      long_leg_id: z.string(),
      short_leg_id: z.string(),
      size: z.number().positive(),
      min_fill_ratio: z.number().min(0.01).max(1).optional(),
      wait_for_keeper: z.boolean().optional().default(true),
      dry_run: z.boolean().optional().default(true),
      auto_approve: z.boolean().optional().default(true)
    })
  },
  async (args) => {
    try {
      const result = await executeSpread({
        strategy: args.strategy,
        longLegId: args.long_leg_id,
        shortLegId: args.short_leg_id,
        size: args.size,
        minFillRatio: args.min_fill_ratio,
        waitForKeeper: args.wait_for_keeper,
        dryRun: args.dry_run,
        autoApprove: args.auto_approve
      });
      return ok(result as Record<string, unknown>);
    } catch (e: any) {
      return fail(`execute_spread failed: ${e.message}`);
    }
  }
);

server.registerTool(
  "callput_check_request_status",
  {
    description: "Check keeper status by request key.",
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

server.registerTool(
  "callput_get_positions",
  {
    description: "Get active option positions for an address.",
    inputSchema: z.object({
      address: z.string().optional()
    })
  },
  async (args) => {
    try {
      const positions = await getPositions(args.address);
      return ok(positions as Record<string, unknown>);
    } catch (e: any) {
      return fail(`get_positions failed: ${e.message}`);
    }
  }
);

server.registerTool(
  "callput_close_position",
  {
    description: "Close an open position (or dry-run tx payload).",
    inputSchema: z.object({
      underlying_asset: z.string(),
      option_token_id: z.string(),
      size: z.number().positive(),
      wait_for_keeper: z.boolean().optional().default(true),
      dry_run: z.boolean().optional().default(true)
    })
  },
  async (args) => {
    try {
      const out = await closePosition({
        underlyingAsset: args.underlying_asset,
        optionTokenId: args.option_token_id,
        size: args.size,
        waitForKeeper: args.wait_for_keeper,
        dryRun: args.dry_run
      });
      return ok(out as Record<string, unknown>);
    } catch (e: any) {
      return fail(`close_position failed: ${e.message}`);
    }
  }
);

server.registerTool(
  "callput_settle_position",
  {
    description: "Settle an expired position (or dry-run tx payload).",
    inputSchema: z.object({
      underlying_asset: z.string(),
      option_token_id: z.string(),
      dry_run: z.boolean().optional().default(true)
    })
  },
  async (args) => {
    try {
      const out = await settlePosition({
        underlyingAsset: args.underlying_asset,
        optionTokenId: args.option_token_id,
        dryRun: args.dry_run
      });
      return ok(out as Record<string, unknown>);
    } catch (e: any) {
      return fail(`settle_position failed: ${e.message}`);
    }
  }
);

server.registerTool(
  "callput_scan_spreads",
  {
    description:
      "Primary market scan. Returns up to max_results pre-ranked, ready-to-execute spread candidates for a given asset and directional bias. ATM-anchored: generates narrow/medium/wide widths automatically. Eliminates manual chain parsing — pass long_leg_id + short_leg_id directly to execute_spread.",
    inputSchema: z.object({
      underlying_asset: z.string(),
      bias: z.enum(["bullish", "bearish"]),
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

server.registerTool(
  "callput_portfolio_summary",
  {
    description:
      "Returns USDC balance, all active positions enriched with current spread mark value, and optional P&L. Pass request_keys (saved from prior execute_spread calls) to enable cost-basis lookup from on-chain openPositionRequests and compute actual P&L.",
    inputSchema: z.object({
      address: z.string().optional(),
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

const transport = new StdioServerTransport();
await server.connect(transport);
