import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({ command: "node", args: ["build/index.js"] });
  const client = new Client({ name: "callput-lite-mcp-smoke", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));

    // Verify all 10 current tools are registered
    const expectedTools = [
      "callput_scan_spreads",
      "callput_execute_spread",
      "callput_get_request_key_from_tx",
      "callput_check_request_status",
      "callput_portfolio_summary",
      "callput_close_position",
      "callput_settle_position",
      "callput_list_positions_by_wallet",
      "callput_get_settled_pnl",
      "callput_get_option_chains"
    ];

    expectedTools.forEach((name) => {
      if (!names.has(name)) {
        throw new Error(`Missing MCP tool: ${name}`);
      }
    });

    console.log(`✓ All ${expectedTools.length} tools registered`);

    // Smoke test: scan spreads (read-only, no signing needed)
    const scan = await client.callTool({
      name: "callput_scan_spreads",
      arguments: {
        underlying_asset: "ETH",
        bias: "bearish",
        max_results: 1
      }
    });

    if ((scan as any).isError) {
      throw new Error(`callput_scan_spreads failed: ${(scan as any).content?.[0]?.text}`);
    }

    console.log("✓ callput_scan_spreads responded");

    // Smoke test: get option chains (read-only)
    const chains = await client.callTool({
      name: "callput_get_option_chains",
      arguments: {
        underlying_asset: "ETH"
      }
    });

    if ((chains as any).isError) {
      throw new Error(`callput_get_option_chains failed: ${(chains as any).content?.[0]?.text}`);
    }

    console.log("✓ callput_get_option_chains responded");
    console.log("MCP smoke test passed.");
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("MCP smoke test failed:", e);
  process.exit(1);
});
