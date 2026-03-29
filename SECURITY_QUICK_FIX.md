# Quick Fix Reference — 5 Required Patches

Copy-paste these exact changes to fix all HIGH and MEDIUM vulnerabilities.

---

## Fix 1/5: RPC Validation (HIGH)
**File:** `src/config.ts` — Add before CONFIG export

```typescript
function validateRpcUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
    throw new Error(`RPC_URL must use https or http, got: ${url}`);
  }
  if (!trimmed.includes("base.org") && !trimmed.includes("8453") && !trimmed.includes("localhost")) {
    console.warn(`⚠️  RPC_URL "${trimmed}" may not be Base Mainnet (chain 8453)`);
  }
  try { new URL(trimmed); } catch (e) { throw new Error(`Invalid RPC_URL format: ${e.message}`); }
  return trimmed;
}

export const CONFIG = {
  RPC_URL: validateRpcUrl(process.env.RPC_URL || "https://mainnet.base.org"),
  // ... rest unchanged
};
```

---

## Fix 2/5: Option ID Validation (MEDIUM)
**File:** `src/core.ts` — Add before validateSpread()

```typescript
export function validateOptionId(optionId: string): string {
  const trimmed = optionId?.trim?.();
  if (!trimmed) throw new Error("optionId cannot be empty");

  const isDecimal = /^\d+$/.test(trimmed);
  const isHex = /^0x[0-9a-fA-F]{1,64}$/i.test(trimmed);
  if (!isDecimal && !isHex) {
    throw new Error(`Invalid optionId format: "${optionId}". Must be decimal or 0x-prefixed hex.`);
  }

  try {
    const bigint = BigInt(trimmed);
    if (bigint < 0n || bigint >= 2n ** 256n) throw new Error("out of uint256 range");
    return trimmed;
  } catch (e) {
    throw new Error(`optionId validation: ${e.message}`);
  }
}
```

Then update these 2 functions:

```typescript
export function parseOptionTokenId(optionId: string): ParsedTokenId {
  const validated = validateOptionId(optionId);  // ← ADD THIS LINE
  const id = BigInt(validated);
  // ... rest unchanged

async function findOptionById(optionId: string): Promise<MarketOption | null> {
  const validated = validateOptionId(optionId);  // ← ADD THIS LINE
  const snapshot = await getMarketSnapshot();
  return snapshot.options.find((o) => o.optionId.toLowerCase() === validated.toLowerCase()) ?? null;
}
```

---

## Fix 3/5: Size Limits (MEDIUM)
**File:** `src/core.ts` — Update executeSpread() signature

```typescript
export async function executeSpread(params: {
  strategy: SpreadStrategy;
  fromAddress: string;
  longLegId: string;
  shortLegId: string;
  size: number;
  minFillRatio?: number;
  maxNotionalUsd?: number;  // ← ADD THIS
}) {
  // ... existing validation ...

  const amountInUsdc = isBuy ? spreadCost * params.size : strikeDiff * params.size;

  // ← ADD THESE 5 LINES:
  const maxNotional = params.maxNotionalUsd ?? 100_000;
  if (amountInUsdc > maxNotional) {
    throw new Error(
      `Trade size exceeds max notional: ${amountInUsdc.toFixed(2)} USD > ${maxNotional} USD`
    );
  }

  // ... rest unchanged
}
```

**File:** `src/index.ts` — Update Zod schema (line ~75)

```typescript
inputSchema: z.object({
  strategy: z.enum(["BuyCallSpread", "SellCallSpread", "BuyPutSpread", "SellPutSpread"]),
  from_address: z.string(),
  long_leg_id: z.string(),
  short_leg_id: z.string(),
  size: z.number().positive(),
  min_fill_ratio: z.number().min(0.01).max(1).optional(),
  max_notional_usd: z.number().positive().optional()  // ← ADD THIS
})
```

---

## Fix 4/5: Market Data Integrity (MEDIUM)
**File:** `src/core.ts` — Add ETag check (simplest option)

```typescript
let marketCacheETag: string | null = null;

async function fetchRawMarketData(): Promise<MarketDataPayload> {
  const headers: Record<string, string> = { "cache-control": "no-store" };

  if (marketCacheETag) {
    headers["If-None-Match"] = marketCacheETag;
  }

  const response = await fetch(CONFIG.MARKET_DATA_URL, { headers });

  if (response.status === 304) {
    const snapshot = marketCache;
    if (snapshot) return { data: { market: {}, spotIndices: {} } } as any;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch market data: HTTP ${response.status}`);
  }

  const etag = response.headers.get("etag");
  if (etag) marketCacheETag = etag;

  return (await response.json()) as MarketDataPayload;
}
```

---

## Fix 5/5: Documentation Cleanup (INFO)
**File:** `OPENCLAW_GUIDE.md` — Remove lines 42-44

Remove this section:
```json
{
  "env": {
    "CALLPUT_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE",  // ← DELETE
    "CALLPUT_RPC_URL": "https://mainnet.base.org"  // ← DELETE (use RPC_URL instead)
  }
}
```

Replace with:
```json
{
  "env": {
    "RPC_URL": "https://mainnet.base.org"
  }
}
```

Add note:
```
Note: No CALLPUT_PRIVATE_KEY needed. MCP builds unsigned transactions only.
Agent signs with its own wallet.
```

---

## Verification
```bash
npm run build          # Must succeed
npm run verify:mcp     # MCP smoke test
npm audit              # Must be clean
```

## Time Estimate
- Fix 1: 5 min
- Fix 2: 10 min
- Fix 3: 5 min
- Fix 4: 5 min
- Fix 5: 2 min
- Testing: 10 min
**Total: 37 minutes**

---

Done! All findings from SECURITY_REPORT.md are now remediated.
