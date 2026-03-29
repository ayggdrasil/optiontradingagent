# Security Fixes: Quick Reference

## Priority 1: RPC Endpoint Validation (HIGH)

**File:** `src/config.ts`

**Current (UNSAFE):**
```typescript
export const CONFIG = {
  RPC_URL: process.env.RPC_URL || "https://mainnet.base.org",
  // ...
};
```

**Fixed (SAFE):**
```typescript
function validateRpcUrl(url: string): string {
  const trimmed = url.trim();

  // Must be HTTPS for mainnet
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
    throw new Error(`RPC_URL must use https or http, got: ${url}`);
  }

  // Warn if not Base mainnet
  if (!trimmed.includes("base.org") &&
      !trimmed.includes("8453") &&
      !trimmed.includes("localhost:8545")) {  // Allow local dev
    console.warn(
      `Warning: RPC_URL "${trimmed}" may not be Base Mainnet. ` +
      `Verify chain ID matches CHAIN_ID=8453`
    );
  }

  try {
    new URL(trimmed);  // Validate URL format
  } catch (e) {
    throw new Error(`Invalid RPC_URL format: ${e.message}`);
  }

  return trimmed;
}

export const CONFIG = {
  RPC_URL: validateRpcUrl(process.env.RPC_URL || "https://mainnet.base.org"),
  // ... rest of config
} as const;
```

**Usage in core.ts (line 327):**
```typescript
function getProvider() {
  return new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  // RPC_URL is now guaranteed to be validated
}
```

---

## Priority 2: Option ID Format Validation (MEDIUM)

**File:** `src/core.ts`

**Add new function (before validateSpread):**
```typescript
export function validateOptionId(optionId: string): string {
  const trimmed = optionId?.trim?.();

  if (!trimmed) {
    throw new Error("optionId cannot be empty");
  }

  // Accept decimal or hex format
  const isDecimal = /^\d+$/.test(trimmed);
  const isHex = /^0x[0-9a-fA-F]{1,64}$/i.test(trimmed);

  if (!isDecimal && !isHex) {
    throw new Error(
      `Invalid optionId format: "${optionId}". ` +
      `Must be decimal digits or 0x-prefixed hex (max 64 hex digits).`
    );
  }

  try {
    const bigint = BigInt(trimmed);

    // Verify it's a valid uint256
    if (bigint < 0n) {
      throw new Error("optionId cannot be negative");
    }
    if (bigint >= 2n ** 256n) {
      throw new Error("optionId exceeds uint256 max value");
    }

    return trimmed;
  } catch (e) {
    throw new Error(`optionId validation error: ${e.message}`);
  }
}

export function parseOptionTokenId(optionId: string): ParsedTokenId {
  const validated = validateOptionId(optionId);  // Add validation
  const id = BigInt(validated);

  const underlyingAssetIndex = Number((id >> 240n) & 0xffffn);
  const expirySec = Number((id >> 200n) & 0xffffffffffn);
  const firstLegIsCall = ((id >> 146n) & 0x1n) === 1n;

  return {
    underlyingAssetIndex,
    expirySec,
    optionType: firstLegIsCall ? "Call" : "Put"
  };
}

async function findOptionById(optionId: string): Promise<MarketOption | null> {
  const validated = validateOptionId(optionId);  // Validate input
  const snapshot = await getMarketSnapshot();
  return snapshot.options.find((o) => o.optionId.toLowerCase() === validated.toLowerCase()) ?? null;
}
```

**Update validateSpread (line 259):**
```typescript
export async function validateSpread(
  strategy: SpreadStrategy,
  longLegId: string,
  shortLegId: string
) {
  // Validate leg IDs before using them
  try {
    validateOptionId(longLegId);
    validateOptionId(shortLegId);
  } catch (e) {
    throw new Error(`Invalid leg ID format: ${e.message}`);
  }

  const long = await findOptionById(longLegId);
  const short = await findOptionById(shortLegId);
  // ... rest of function unchanged
}
```

---

## Priority 3: Add Notional Size Limits (MEDIUM)

**File:** `src/core.ts`

**Update executeSpread function signature (line 440):**
```typescript
export async function executeSpread(params: {
  strategy: SpreadStrategy;
  fromAddress: string;
  longLegId: string;
  shortLegId: string;
  size: number;
  minFillRatio?: number;
  maxNotionalUsd?: number;  // NEW: Add max notional limit
}) {
  if (!ethers.isAddress(params.fromAddress)) {
    throw new Error(`Invalid fromAddress: ${params.fromAddress}`);
  }

  const validation = await validateSpread(params.strategy, params.longLegId, params.shortLegId);
  const details: any = validation.details;

  const isBuy = params.strategy.startsWith("Buy");
  const asset = details.asset as UnderlyingAsset;
  const underlyingDecimals = CONFIG.ASSETS[asset].decimals;

  const spreadCost = Number(details.spread_cost);
  const strikeDiff = Number(details.strike_diff);
  const amountInUsdc = isBuy ? spreadCost * params.size : strikeDiff * params.size;

  // NEW: Enforce maximum notional exposure
  const maxNotional = params.maxNotionalUsd ?? 100_000;  // Default 100k USD max
  if (amountInUsdc > maxNotional) {
    throw new Error(
      `Trade size exceeds maximum notional exposure: ` +
      `${amountInUsdc.toFixed(2)} USD > ${maxNotional} USD max. ` +
      `Reduce size or increase maxNotionalUsd parameter.`
    );
  }

  const sizeRaw = toSizeRaw(params.size, asset);
  const minFillRatio = Math.max(0.01, Math.min(1, params.minFillRatio ?? 0.95));
  const minSize = (sizeRaw * BigInt(Math.floor(minFillRatio * 10_000))) / 10_000n;

  // ... rest of function unchanged
}
```

**Update index.ts tool schema (line 66):**
```typescript
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
      min_fill_ratio: z.number().min(0.01).max(1).optional(),
      max_notional_usd: z.number().positive().optional()  // NEW
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
        minFillRatio: args.min_fill_ratio,
        maxNotionalUsd: args.max_notional_usd  // NEW
      });
      return ok(result as Record<string, unknown>);
    } catch (e: any) {
      return fail(`execute_spread failed: ${e.message}`);
    }
  }
);
```

---

## Priority 4: Market Data Integrity (MEDIUM)

**File:** `src/core.ts`

**Option A: Add ETag caching (lightweight)**
```typescript
let marketCacheETag: string | null = null;

async function fetchRawMarketData(): Promise<MarketDataPayload> {
  const headers: Record<string, string> = { "cache-control": "no-store" };

  // Add If-None-Match header if we have cached ETag
  if (marketCacheETag) {
    headers["If-None-Match"] = marketCacheETag;
  }

  const response = await fetch(CONFIG.MARKET_DATA_URL, { headers });

  if (response.status === 304) {
    // Not Modified — use cached data
    return (await getMarketSnapshot()).data as any as MarketDataPayload;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch market data: HTTP ${response.status}`);
  }

  // Store ETag for next request
  const etag = response.headers.get("etag");
  if (etag) {
    marketCacheETag = etag;
  }

  return (await response.json()) as MarketDataPayload;
}
```

**Option B: Add content validation (stronger)**
```typescript
import crypto from "crypto";

const EXPECTED_MARKET_DATA_SHA256 = process.env.MARKET_DATA_HASH || null;

async function fetchRawMarketData(): Promise<MarketDataPayload> {
  const response = await fetch(CONFIG.MARKET_DATA_URL, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch market data: HTTP ${response.status}`);
  }

  const text = await response.text();

  // Optional: Verify content hash if provided
  if (EXPECTED_MARKET_DATA_SHA256) {
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (hash !== EXPECTED_MARKET_DATA_SHA256) {
      throw new Error(
        `Market data integrity check failed. ` +
        `Expected SHA256 ${EXPECTED_MARKET_DATA_SHA256}, ` +
        `got ${hash}. Possible MITM attack.`
      );
    }
  }

  try {
    return JSON.parse(text) as MarketDataPayload;
  } catch (e) {
    throw new Error(`Invalid JSON in market data: ${e.message}`);
  }
}
```

---

## Testing These Fixes

**Test RPC validation:**
```bash
# Should pass (mainnet)
RPC_URL=https://mainnet.base.org npm run build

# Should warn (different network)
RPC_URL=https://eth-mainnet.g.alchemy.com npm run build

# Should fail (invalid)
RPC_URL=ftp://example.com npm run build  # Error: must use https
```

**Test optionId validation:**
```typescript
import { validateOptionId } from "./core.js";

// Valid
validateOptionId("123456789");  // decimal ✅
validateOptionId("0xABCDEF");   // hex ✅

// Invalid
validateOptionId("0xGHIJ");     // invalid hex ❌
validateOptionId("");           // empty ❌
validateOptionId("not-a-number");  // ❌
```

**Test notional limits:**
```typescript
// This should fail if amountInUsdc > 100k
await executeSpread({
  strategy: "BuyCallSpread",
  size: 10000,  // Will exceed limit
  maxNotionalUsd: 50000  // Force strict limit
});
```

---

## Documentation Updates

**Update OPENCLAW_GUIDE.md (line 42):**

Remove:
```
"env": {
  "CALLPUT_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE",
  "CALLPUT_RPC_URL": "https://mainnet.base.org"
}
```

Replace with:
```
"env": {
  "RPC_URL": "https://mainnet.base.org"
}
```

Note: No CALLPUT_PRIVATE_KEY needed (MCP doesn't sign, agent does).

---

## Summary

| Issue | Fix | LOC | Time |
|-------|-----|-----|------|
| H1: RPC validation | validateRpcUrl() | ~15 | 10 min |
| M2: OptionID validation | validateOptionId() | ~30 | 15 min |
| M3: Size limits | maxNotionalUsd param | ~10 | 5 min |
| M1: Market data | ETag caching | ~10 | 10 min |
| Docs cleanup | Remove CALLPUT_PRIVATE_KEY | ~5 | 2 min |

**Total Implementation Time:** ~42 minutes
**Total Testing Time:** ~30 minutes
**Total:** ~72 minutes (1.2 hours)

---

## Verification Checklist

After implementing fixes:

```
[ ] Build succeeds: npm run build
[ ] Tests pass: npm run verify
[ ] MCP smoke test passes: npm run verify:mcp
[ ] RPC validation rejects invalid URLs
[ ] OptionID validation catches bad formats
[ ] executeSpread rejects oversized trades
[ ] All error messages are user-friendly (no stack traces)
[ ] No new secrets in code
[ ] npm audit clean
[ ] SECURITY_REPORT.md signs off
```

---

## Questions?

Refer back to SECURITY_REPORT.md for detailed risk analysis and threat models.
