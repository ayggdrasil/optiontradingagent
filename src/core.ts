import { ethers } from "ethers";
import { CONFIG, ERC20_ABI, OPTIONS_TOKEN_ABI, POSITION_MANAGER_ABI, SETTLE_MANAGER_ABI } from "./config.js";

export type UnderlyingAsset = "BTC" | "ETH";
export type OptionSide = "Call" | "Put";
export type SpreadStrategy = "BuyCallSpread" | "SellCallSpread" | "BuyPutSpread" | "SellPutSpread";

type MarketOption = {
  instrument: string;
  optionId: string;
  strikePrice: number;
  markPrice: number;
  bid: number;
  ask: number;
  underlying: UnderlyingAsset;
  optionType: OptionSide;
  expirySec: number;
  expiryCode: string;
  isAvailable: boolean;
};

type MarketDataPayload = {
  lastUpdatedAt?: number;
  data?: {
    market?: Record<UnderlyingAsset, {
      expiries?: string[];
      options?: Record<string, { call?: any[]; put?: any[] }>;
    }>;
    spotIndices?: Record<string, number>;
  };
};

type ParsedTokenId = {
  underlyingAssetIndex: number;
  expirySec: number;
  optionType: OptionSide;
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

let marketCache: { tsMs: number; options: MarketOption[]; spot: Record<UnderlyingAsset, number> } | null = null;

export function normalizeAsset(asset: string): UnderlyingAsset | null {
  const s = asset.trim().toUpperCase();
  if (s === "BTC" || s === "WBTC") return "BTC";
  if (s === "ETH" || s === "WETH") return "ETH";
  return null;
}

function normalizeOptionSide(optionType?: string): OptionSide | null {
  if (!optionType) return null;
  const s = optionType.trim().toLowerCase();
  if (s === "call" || s === "c") return "Call";
  if (s === "put" || s === "p") return "Put";
  return null;
}

export function formatExpiry(expirySec: number): string {
  const dt = new Date(expirySec * 1000);
  const day = String(dt.getUTCDate()).padStart(2, "0");
  const mon = MONTHS[dt.getUTCMonth()];
  const yy = String(dt.getUTCFullYear()).slice(-2);
  return `${day}${mon}${yy}`;
}

export function parseOptionTokenId(optionId: string): ParsedTokenId {
  const id = BigInt(optionId);
  const underlyingAssetIndex = Number((id >> 240n) & 0xffffn);
  const expirySec = Number((id >> 200n) & 0xffffffffffn);
  const firstLegIsCall = ((id >> 146n) & 0x1n) === 1n;
  return {
    underlyingAssetIndex,
    expirySec,
    optionType: firstLegIsCall ? "Call" : "Put"
  };
}

export function decodeSpreadTokenId(tokenIdInput: string): {
  underlying: UnderlyingAsset | null;
  expirySec: number;
  expiryCode: string;
  isLong: boolean;
  nakedStrike: number;
  pairStrike: number;
  optionType: OptionSide;
} {
  const tokenId = BigInt(tokenIdInput);
  const hex = tokenId.toString(16).padStart(64, "0");
  const assetIndex = Number.parseInt(hex.slice(0, 4), 16);
  const expirySec = Number.parseInt(hex.slice(4, 14), 16);
  const flagByte = Number.parseInt(hex.slice(14, 16), 16);
  const nakedEncoded = Number.parseInt(hex.slice(16, 28), 16);
  const pairEncoded = Number.parseInt(hex.slice(28, 40), 16);
  const isLong = flagByte === 0x56;
  const nakedStrike = Math.floor(nakedEncoded / 8);
  const pairStrike = pairEncoded > 0 ? Math.floor(pairEncoded / 8) : 0;
  const optionType: OptionSide = (nakedEncoded % 8 & 4) !== 0 ? "Call" : "Put";

  const underlying: UnderlyingAsset | null = assetIndex === 1 ? "BTC" : assetIndex === 2 ? "ETH" : null;
  return {
    underlying,
    expirySec,
    expiryCode: formatExpiry(expirySec),
    isLong,
    nakedStrike,
    pairStrike,
    optionType
  };
}

function optionSuffix(optionType: OptionSide): "C" | "P" {
  return optionType === "Call" ? "C" : "P";
}

export function buildInstrument(
  underlying: UnderlyingAsset,
  expiryCode: string,
  strike: number,
  optionType: OptionSide
): string {
  return `${underlying}-${expiryCode.toUpperCase()}-${Math.trunc(strike)}-${optionSuffix(optionType)}`;
}

async function fetchRawMarketData(): Promise<MarketDataPayload> {
  const response = await fetch(CONFIG.MARKET_DATA_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch market data: HTTP ${response.status}`);
  }
  return (await response.json()) as MarketDataPayload;
}

export async function getMarketSnapshot(force = false): Promise<{ options: MarketOption[]; spot: Record<UnderlyingAsset, number> }> {
  const now = Date.now();
  if (!force && marketCache && now - marketCache.tsMs < 5_000) {
    return { options: marketCache.options, spot: marketCache.spot };
  }

  const payload = await fetchRawMarketData();
  const market = payload.data?.market;
  if (!market) {
    throw new Error("Market data payload missing data.market");
  }

  const options: MarketOption[] = [];
  const spot: Record<UnderlyingAsset, number> = {
    BTC: Number(payload.data?.spotIndices?.BTC ?? 0),
    ETH: Number(payload.data?.spotIndices?.ETH ?? 0)
  };

  for (const asset of ["BTC", "ETH"] as const) {
    const assetData = market[asset];
    const optionByExpiry = assetData?.options ?? {};
    for (const [expirySecStr, byType] of Object.entries(optionByExpiry)) {
      const expirySec = Number(expirySecStr);
      const expiryCode = formatExpiry(expirySec);
      for (const optionType of ["Call", "Put"] as const) {
        const arr = optionType === "Call" ? byType.call ?? [] : byType.put ?? [];
        for (const row of arr) {
          const mark = Number(row.markPrice ?? 0);
          const rpBuy = Number(row.riskPremiumRateForBuy ?? 0);
          const rpSell = Number(row.riskPremiumRateForSell ?? 0);
          const strike = Number(row.strikePrice ?? 0);
          const optionId = String(row.optionId ?? "");
          const isAvailable = Boolean(row.isOptionAvailable);
          if (!optionId || !Number.isFinite(strike) || !Number.isFinite(mark)) continue;

          options.push({
            instrument: buildInstrument(asset, expiryCode, strike, optionType),
            optionId,
            strikePrice: strike,
            markPrice: mark,
            bid: mark * (1 - rpSell),
            ask: mark * (1 + rpBuy),
            underlying: asset,
            optionType,
            expirySec,
            expiryCode,
            isAvailable
          });
        }
      }
    }
  }

  marketCache = { tsMs: now, options, spot };
  return { options, spot };
}

export async function getOptionChains(params: {
  underlyingAsset: string;
  optionType?: string;
  expiryDate?: string;
  maxExpiries?: number;
  maxStrikes?: number;
}) {
  const underlying = normalizeAsset(params.underlyingAsset);
  if (!underlying) {
    throw new Error(`Unsupported asset: ${params.underlyingAsset}`);
  }
  const optType = normalizeOptionSide(params.optionType);
  const expiryFilter = params.expiryDate?.trim().toUpperCase();
  const maxExpiries = Math.max(1, Math.min(5, params.maxExpiries ?? 1));
  const maxStrikes = Math.max(2, Math.min(30, params.maxStrikes ?? 8));

  const snapshot = await getMarketSnapshot();
  const filtered = snapshot.options.filter((o) =>
    o.underlying === underlying &&
    o.isAvailable &&
    (!optType || o.optionType === optType) &&
    (!expiryFilter || o.expiryCode === expiryFilter)
  );

  const expiryCodes = [...new Set(filtered.map((o) => o.expiryCode))]
    .sort((a, b) => {
      const aSec = filtered.find((o) => o.expiryCode === a)?.expirySec ?? 0;
      const bSec = filtered.find((o) => o.expiryCode === b)?.expirySec ?? 0;
      return aSec - bSec;
    })
    .slice(0, maxExpiries);

  const output: Record<string, { call: any[]; put: any[] }> = {};
  for (const code of expiryCodes) {
    const items = filtered.filter((o) => o.expiryCode === code);
    const calls = items.filter((o) => o.optionType === "Call").sort((a, b) => a.strikePrice - b.strikePrice).slice(0, maxStrikes);
    const puts = items.filter((o) => o.optionType === "Put").sort((a, b) => a.strikePrice - b.strikePrice).slice(0, maxStrikes);
    output[code] = {
      call: calls.map((o) => [o.strikePrice, o.markPrice, o.bid, o.ask, o.optionId, o.instrument]),
      put: puts.map((o) => [o.strikePrice, o.markPrice, o.bid, o.ask, o.optionId, o.instrument])
    };
  }

  if (expiryFilter && !output[expiryFilter]) {
    const available = [...new Set(filtered.map((o) => o.expiryCode))].sort();
    throw new Error(`Expiry ${expiryFilter} not found. Available: ${available.join(", ")}`);
  }

  return {
    asset: underlying,
    spot_price: snapshot.spot[underlying],
    expiries: output
  };
}

function mapAssetIndexToUnderlying(index: number): UnderlyingAsset | null {
  if (index === 1) return "BTC";
  if (index === 2) return "ETH";
  return null;
}

async function findOptionById(optionId: string): Promise<MarketOption | null> {
  const snapshot = await getMarketSnapshot();
  return snapshot.options.find((o) => o.optionId.toLowerCase() === optionId.toLowerCase()) ?? null;
}

export async function validateSpread(strategy: SpreadStrategy, longLegId: string, shortLegId: string) {
  const long = await findOptionById(longLegId);
  const short = await findOptionById(shortLegId);

  if (!long || !short) {
    throw new Error("One or both leg IDs are not found in current market data.");
  }

  if (!long.isAvailable || !short.isAvailable) {
    throw new Error("One or both legs are currently unavailable.");
  }

  const longParsed = parseOptionTokenId(long.optionId);
  const shortParsed = parseOptionTokenId(short.optionId);

  if (longParsed.underlyingAssetIndex !== shortParsed.underlyingAssetIndex) {
    throw new Error("Legs must have the same underlying asset.");
  }
  if (longParsed.expirySec !== shortParsed.expirySec) {
    throw new Error("Legs must have the same expiry.");
  }

  const underlying = mapAssetIndexToUnderlying(longParsed.underlyingAssetIndex);
  if (!underlying) throw new Error("Unsupported underlying asset index.");

  const strategyOptionType: OptionSide = strategy.includes("Call") ? "Call" : "Put";
  if (long.optionType !== strategyOptionType || short.optionType !== strategyOptionType) {
    throw new Error(`Both legs must be ${strategyOptionType} options for ${strategy}.`);
  }

  if (strategyOptionType === "Call" && long.strikePrice >= short.strikePrice) {
    throw new Error("Call spread requires long strike < short strike.");
  }
  if (strategyOptionType === "Put" && long.strikePrice <= short.strikePrice) {
    throw new Error("Put spread requires long strike > short strike.");
  }

  const spreadCost = long.markPrice - short.markPrice;
  const minSpread = underlying === "BTC" ? 60 : 3;
  if (spreadCost < minSpread) {
    throw new Error(`Spread cost too low: ${spreadCost.toFixed(2)} < ${minSpread}`);
  }

  return {
    status: "Valid",
    details: {
      asset: underlying,
      option_type: strategyOptionType,
      expiry_code: long.expiryCode,
      long_leg: {
        option_id: long.optionId,
        instrument: long.instrument,
        strike: long.strikePrice,
        mark_price: long.markPrice
      },
      short_leg: {
        option_id: short.optionId,
        instrument: short.instrument,
        strike: short.strikePrice,
        mark_price: short.markPrice
      },
      spread_cost: spreadCost,
      strike_diff: Math.abs(long.strikePrice - short.strikePrice)
    }
  };
}

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL || CONFIG.RPC_URL);
}

function getSigner(provider: ethers.JsonRpcProvider): ethers.Wallet {
  const pk = process.env.CALLPUT_PRIVATE_KEY;
  if (!pk) throw new Error("CALLPUT_PRIVATE_KEY is required for execute mode.");
  return new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
}

function statusFromRaw(raw: number): "pending" | "cancelled" | "executed" {
  if (raw === 2) return "executed";
  if (raw === 1) return "cancelled";
  return "pending";
}

async function getExecutionFee(contract: ethers.Contract): Promise<bigint> {
  try {
    return (await contract.executionFee()) as bigint;
  } catch {
    return CONFIG.EXECUTION_FEE_FALLBACK;
  }
}

function toSizeRaw(size: number, asset: UnderlyingAsset): bigint {
  if (!Number.isFinite(size) || size <= 0) throw new Error("size must be > 0");
  const decimals = CONFIG.ASSETS[asset].decimals;
  const scaled = Math.floor(size * 10 ** decimals);
  if (scaled <= 0) throw new Error("size too small after decimal scaling");
  return BigInt(scaled);
}

function toUsdcRaw(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error("amount_in must be > 0");
  const scaled = Math.floor(value * 10 ** CONFIG.ASSETS.USDC.decimals);
  if (scaled <= 0) throw new Error("USDC amount too small after decimal scaling");
  return BigInt(scaled);
}

async function ensureAllowance(
  provider: ethers.JsonRpcProvider,
  signer: ethers.Wallet,
  amountIn: bigint,
  autoApprove: boolean
): Promise<{ approved: boolean; approval_tx_hash?: string; allowance: string }> {
  const usdc = new ethers.Contract(CONFIG.CONTRACTS.USDC, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const allowance = (await usdc.allowance(owner, CONFIG.CONTRACTS.ROUTER)) as bigint;
  if (allowance >= amountIn) {
    return { approved: false, allowance: allowance.toString() };
  }

  if (!autoApprove) {
    throw new Error(`Insufficient USDC allowance. required=${amountIn} current=${allowance}`);
  }

  const approveAmount = amountIn * 2n;
  const tx = await usdc.approve(CONFIG.CONTRACTS.ROUTER, approveAmount);
  await tx.wait();
  const updated = (await usdc.allowance(owner, CONFIG.CONTRACTS.ROUTER)) as bigint;
  return {
    approved: true,
    approval_tx_hash: tx.hash,
    allowance: updated.toString()
  };
}

function extractRequestKey(receipt: ethers.TransactionReceipt): { request_key: string; is_open: boolean } | null {
  const iface = new ethers.Interface(POSITION_MANAGER_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "GenerateRequestKey") {
        return {
          request_key: String(parsed.args.key),
          is_open: Boolean(parsed.args.isOpen)
        };
      }
    } catch {
      // ignore non-matching logs
    }
  }
  return null;
}

export async function checkRequestStatus(requestKey: string, isOpen: boolean) {
  const provider = getProvider();
  const pm = new ethers.Contract(CONFIG.CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
  const req: any = isOpen
    ? await pm.openPositionRequests(requestKey)
    : await pm.closePositionRequests(requestKey);

  const account: string = String(req.account ?? req[0]);
  if (account.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    return {
      status: "not_found",
      request_key: requestKey
    };
  }

  const statusRaw = Number(req.status ?? req[9] ?? 0);
  const status = statusFromRaw(statusRaw);
  const result: Record<string, unknown> = {
    request_key: requestKey,
    status,
    account
  };

  if (isOpen) {
    result.size_out = String(req.sizeOut ?? req[10] ?? "0");
    result.execution_price = String(req.executionPrice ?? req[11] ?? "0");
  } else {
    result.amount_out = String(req.amountOut ?? req[10] ?? "0");
    result.execution_price = String(req.executionPrice ?? req[11] ?? "0");
  }
  return result;
}

async function waitKeeper(requestKey: string, isOpen: boolean, timeoutSec: number): Promise<Record<string, unknown>> {
  const start = Date.now();
  let intervalMs = 1000;
  while (Date.now() - start < timeoutSec * 1000) {
    const status = await checkRequestStatus(requestKey, isOpen);
    if (status.status === "executed" || status.status === "cancelled") return status;
    await new Promise((r) => setTimeout(r, intervalMs));
    intervalMs = Math.min(5000, Math.floor(intervalMs * 1.5));
  }
  return {
    request_key: requestKey,
    status: "pending",
    timed_out: true,
    timeout_sec: timeoutSec
  };
}

export async function executeSpread(params: {
  strategy: SpreadStrategy;
  longLegId: string;
  shortLegId: string;
  size: number;
  minFillRatio?: number;
  waitForKeeper?: boolean;
  dryRun?: boolean;
  autoApprove?: boolean;
}) {
  const validation = await validateSpread(params.strategy, params.longLegId, params.shortLegId);
  const details: any = validation.details;

  const isBuy = params.strategy.startsWith("Buy");
  const asset = details.asset as UnderlyingAsset;
  const underlyingDecimals = CONFIG.ASSETS[asset].decimals;

  const spreadCost = Number(details.spread_cost);
  const strikeDiff = Number(details.strike_diff);
  const amountInUsdc = isBuy ? spreadCost * params.size : strikeDiff * params.size;
  const amountIn = toUsdcRaw(amountInUsdc);

  const sizeRaw = toSizeRaw(params.size, asset);
  const minFillRatio = Math.max(0.01, Math.min(1, params.minFillRatio ?? 0.95));
  const minSize = (sizeRaw * BigInt(Math.floor(minFillRatio * 10_000))) / 10_000n;

  const isCall = params.strategy.includes("Call");
  const isBuys: [boolean, boolean, boolean, boolean] = [isBuy, !isBuy, false, false];
  const isCalls: [boolean, boolean, boolean, boolean] = [isCall, isCall, false, false];
  const optionIds: [string, string, string, string] = [
    ethers.zeroPadValue(ethers.toBeHex(BigInt(params.longLegId)), 32),
    ethers.zeroPadValue(ethers.toBeHex(BigInt(params.shortLegId)), 32),
    ethers.ZeroHash,
    ethers.ZeroHash
  ];

  const underlyingIndex = CONFIG.ASSETS[asset].index;
  const path = [CONFIG.CONTRACTS.USDC];
  const length = 2;

  const iface = new ethers.Interface(POSITION_MANAGER_ABI);
  const data = iface.encodeFunctionData("createOpenPosition", [
    underlyingIndex,
    length,
    isBuys,
    optionIds,
    isCalls,
    minSize,
    path,
    amountIn,
    0,
    ethers.ZeroAddress
  ]);

  const provider = getProvider();
  const pmRead = new ethers.Contract(CONFIG.CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
  const executionFee = await getExecutionFee(pmRead);

  if (params.dryRun ?? false) {
    return {
      mode: "dry_run",
      validation,
      tx: {
        to: CONFIG.CONTRACTS.POSITION_MANAGER,
        data,
        value: executionFee.toString(),
        chain_id: CONFIG.CHAIN_ID
      },
      quote: {
        strategy: params.strategy,
        size: params.size,
        size_raw: sizeRaw.toString(),
        min_size_raw: minSize.toString(),
        amount_in_usdc: amountInUsdc,
        amount_in_raw: amountIn.toString(),
        underlying_decimals: underlyingDecimals
      }
    };
  }

  const signer = getSigner(provider);
  const allowanceInfo = await ensureAllowance(provider, signer, amountIn, params.autoApprove ?? true);

  const pm = new ethers.Contract(CONFIG.CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
  const tx = await pm.createOpenPosition(
    underlyingIndex,
    length,
    isBuys,
    optionIds,
    isCalls,
    minSize,
    path,
    amountIn,
    0,
    ethers.ZeroAddress,
    { value: executionFee }
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("No transaction receipt returned.");

  const requestKeyData = extractRequestKey(receipt);
  if (!requestKeyData) {
    throw new Error("GenerateRequestKey event not found in receipt logs.");
  }

  const out: Record<string, unknown> = {
    mode: "executed",
    approval: allowanceInfo,
    tx_hash: tx.hash,
    request_key: requestKeyData.request_key,
    request_is_open: requestKeyData.is_open,
    quote: {
      strategy: params.strategy,
      amount_in_usdc: amountInUsdc,
      amount_in_raw: amountIn.toString()
    }
  };

  if (params.waitForKeeper ?? true) {
    out.keeper = await waitKeeper(requestKeyData.request_key, true, 120);
  }
  return out;
}

export async function closePosition(params: {
  underlyingAsset: string;
  optionTokenId: string;
  size: number;
  waitForKeeper?: boolean;
  dryRun?: boolean;
}) {
  const asset = normalizeAsset(params.underlyingAsset);
  if (!asset) throw new Error(`Unsupported asset: ${params.underlyingAsset}`);

  const sizeRaw = toSizeRaw(params.size, asset);
  const path = [CONFIG.CONTRACTS.USDC];
  const underlyingIndex = CONFIG.ASSETS[asset].index;

  const iface = new ethers.Interface(POSITION_MANAGER_ABI);
  const data = iface.encodeFunctionData("createClosePosition", [
    underlyingIndex,
    BigInt(params.optionTokenId),
    sizeRaw,
    path,
    0,
    0,
    false
  ]);

  const provider = getProvider();
  const pmRead = new ethers.Contract(CONFIG.CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
  const executionFee = await getExecutionFee(pmRead);

  if (params.dryRun ?? false) {
    return {
      mode: "dry_run",
      tx: {
        to: CONFIG.CONTRACTS.POSITION_MANAGER,
        data,
        value: executionFee.toString(),
        chain_id: CONFIG.CHAIN_ID
      },
      close: {
        asset,
        option_token_id: params.optionTokenId,
        size: params.size,
        size_raw: sizeRaw.toString()
      }
    };
  }

  const signer = getSigner(provider);
  const pm = new ethers.Contract(CONFIG.CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
  const tx = await pm.createClosePosition(
    underlyingIndex,
    BigInt(params.optionTokenId),
    sizeRaw,
    path,
    0,
    0,
    false,
    { value: executionFee }
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("No transaction receipt returned.");

  const requestKeyData = extractRequestKey(receipt);
  if (!requestKeyData) throw new Error("GenerateRequestKey event not found in receipt logs.");

  const out: Record<string, unknown> = {
    mode: "executed",
    tx_hash: tx.hash,
    request_key: requestKeyData.request_key,
    request_is_open: requestKeyData.is_open
  };

  if (params.waitForKeeper ?? true) {
    out.keeper = await waitKeeper(requestKeyData.request_key, false, 120);
  }
  return out;
}

export async function settlePosition(params: {
  underlyingAsset: string;
  optionTokenId: string;
  dryRun?: boolean;
}) {
  const asset = normalizeAsset(params.underlyingAsset);
  if (!asset) throw new Error(`Unsupported asset: ${params.underlyingAsset}`);
  const underlyingIndex = CONFIG.ASSETS[asset].index;
  const path = [CONFIG.CONTRACTS.USDC];

  const iface = new ethers.Interface(SETTLE_MANAGER_ABI);
  const data = iface.encodeFunctionData("settlePosition", [
    path,
    underlyingIndex,
    BigInt(params.optionTokenId),
    0,
    false
  ]);

  if (params.dryRun ?? false) {
    return {
      mode: "dry_run",
      tx: {
        to: CONFIG.CONTRACTS.SETTLE_MANAGER,
        data,
        value: "0",
        chain_id: CONFIG.CHAIN_ID
      }
    };
  }

  const provider = getProvider();
  const signer = getSigner(provider);
  const settle = new ethers.Contract(CONFIG.CONTRACTS.SETTLE_MANAGER, SETTLE_MANAGER_ABI, signer);
  const tx = await settle.settlePosition(path, underlyingIndex, BigInt(params.optionTokenId), 0, false, { value: 0 });
  const receipt = await tx.wait();
  if (!receipt) throw new Error("No settlement receipt returned.");

  return {
    mode: "executed",
    tx_hash: tx.hash,
    receipt_status: receipt.status
  };
}

export async function getPositions(addressInput?: string) {
  const provider = getProvider();
  let address = addressInput;
  if (!address) {
    const pk = process.env.CALLPUT_PRIVATE_KEY;
    if (!pk) throw new Error("address is required when CALLPUT_PRIVATE_KEY is not set.");
    const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
    address = wallet.address;
  }

  if (!ethers.isAddress(address)) throw new Error(`Invalid address: ${address}`);
  const account = ethers.getAddress(address);

  const snapshot = await getMarketSnapshot();

  const out: any[] = [];
  for (const asset of ["BTC", "ETH"] as const) {
    const tokenAddress = asset === "BTC" ? CONFIG.CONTRACTS.OPTIONS_TOKEN_BTC : CONFIG.CONTRACTS.OPTIONS_TOKEN_ETH;
    const token = new ethers.Contract(tokenAddress, OPTIONS_TOKEN_ABI, provider);
    const tokenIds: bigint[] = (await token.tokensByAccount(account)) as bigint[];
    if (!tokenIds.length) continue;

    const accounts = tokenIds.map(() => account);
    const balances: bigint[] = (await token.balanceOfBatch(accounts, tokenIds)) as bigint[];

    for (let i = 0; i < tokenIds.length; i++) {
      const bal = balances[i];
      if (bal === 0n) continue;

      const decoded = decodeSpreadTokenId(tokenIds[i].toString());
      const signed = decoded.isLong ? bal : -bal;
      const size = Number(signed) / 10 ** CONFIG.ASSETS[asset].decimals;
      const matched = snapshot.options.find((o) =>
        o.underlying === asset &&
        o.expirySec === decoded.expirySec &&
        Math.trunc(o.strikePrice) === Math.trunc(decoded.nakedStrike) &&
        o.optionType === decoded.optionType
      );

      out.push({
        underlying: asset,
        token_id: tokenIds[i].toString(),
        side: decoded.isLong ? "long" : "short",
        size,
        raw_balance: bal.toString(),
        instrument: matched?.instrument ?? null,
        strike: decoded.nakedStrike,
        pair_strike: decoded.pairStrike || null,
        expiry_code: decoded.expiryCode,
        option_type: decoded.optionType,
        mark_price: matched?.markPrice ?? null
      });
    }
  }

  return { account, positions: out, total_active_count: out.length };
}

// ─── scanSpreads ─────────────────────────────────────────────────────────────
// Returns at most max_results pre-ranked, ready-to-execute spread candidates.
// bias drives option type selection; ATM anchoring eliminates combinatorial explosion.

export async function scanSpreads(params: {
  underlyingAsset: string;
  bias: "bullish" | "bearish";
  maxResults?: number;
}) {
  const underlying = normalizeAsset(params.underlyingAsset);
  if (!underlying) throw new Error(`Unsupported asset: ${params.underlyingAsset}`);

  const maxResults = Math.max(1, Math.min(5, params.maxResults ?? 3));
  const snapshot = await getMarketSnapshot();
  const spot = snapshot.spot[underlying];
  const now = Date.now() / 1000;
  const minSpreadCost = underlying === "BTC" ? 60 : 3;

  const isBullish = params.bias === "bullish";
  const optionType: OptionSide = isBullish ? "Call" : "Put";
  const strategy: SpreadStrategy = isBullish ? "BuyCallSpread" : "BuyPutSpread";

  const available = snapshot.options.filter(
    (o) =>
      o.underlying === underlying &&
      o.isAvailable &&
      o.optionType === optionType &&
      o.expirySec > now + 6 * 3600
  );

  if (available.length === 0) throw new Error("No available options with >6h to expiry.");

  const expiryCodes = [...new Set(available.map((o) => o.expiryCode))]
    .sort((a, b) => {
      const aSec = available.find((o) => o.expiryCode === a)!.expirySec;
      const bSec = available.find((o) => o.expiryCode === b)!.expirySec;
      return aSec - bSec;
    })
    .slice(0, 2);

  const candidates: any[] = [];

  for (const expiryCode of expiryCodes) {
    const legs = available
      .filter((o) => o.expiryCode === expiryCode)
      .sort((a, b) => a.strikePrice - b.strikePrice);

    if (legs.length < 2) continue;

    const expirySec = legs[0].expirySec;
    const daysToExpiry = Math.round(((expirySec - now) / 86400) * 10) / 10;

    const atmIdx = legs.reduce(
      (best, o, i) =>
        Math.abs(o.strikePrice - spot) < Math.abs(legs[best].strikePrice - spot) ? i : best,
      0
    );

    for (let width = 1; width <= 3; width++) {
      let longLeg: MarketOption;
      let shortLeg: MarketOption;

      if (isBullish) {
        // BuyCallSpread: long ATM call, short higher call
        const shortIdx = atmIdx + width;
        if (shortIdx >= legs.length) continue;
        longLeg = legs[atmIdx];
        shortLeg = legs[shortIdx];
      } else {
        // BuyPutSpread: long ATM put (higher strike), short lower-strike put
        const shortIdx = atmIdx - width;
        if (shortIdx < 0) continue;
        longLeg = legs[atmIdx];
        shortLeg = legs[shortIdx];
      }

      const spreadCost = longLeg.markPrice - shortLeg.markPrice;
      const strikeDiff = Math.abs(longLeg.strikePrice - shortLeg.strikePrice);

      if (spreadCost < minSpreadCost || strikeDiff <= 0) continue;

      candidates.push({
        strategy,
        long_leg_id: longLeg.optionId,
        short_leg_id: shortLeg.optionId,
        long_strike: longLeg.strikePrice,
        short_strike: shortLeg.strikePrice,
        spread_cost: Math.round(spreadCost * 100) / 100,
        max_payout: strikeDiff,
        cost_pct_of_max: Math.round((spreadCost / strikeDiff) * 10000) / 100,
        expiry_code: expiryCode,
        days_to_expiry: daysToExpiry
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error("No valid spread candidates found. Try a different asset or bias.");
  }

  const ranked = candidates
    .sort((a, b) => a.cost_pct_of_max - b.cost_pct_of_max)
    .slice(0, maxResults)
    .map((c, i) => ({ rank: i + 1, ...c }));

  return {
    asset: underlying,
    spot_price: spot,
    bias: params.bias,
    tip: "Use rank 1 for best value. cost_pct_of_max < 30 is preferred. Pass long_leg_id + short_leg_id directly to callput_execute_spread.",
    candidates: ranked
  };
}

// ─── getPortfolioSummary ──────────────────────────────────────────────────────
// Returns USDC balance, enriched positions with current spread mark value,
// and optional P&L if request_keys from prior executions are provided.

export async function getPortfolioSummary(params: {
  address?: string;
  requestKeys?: string[];
}) {
  const provider = getProvider();

  let address = params.address;
  if (!address) {
    const pk = process.env.CALLPUT_PRIVATE_KEY;
    if (!pk) throw new Error("address is required when CALLPUT_PRIVATE_KEY is not set.");
    const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
    address = wallet.address;
  }
  if (!ethers.isAddress(address)) throw new Error(`Invalid address: ${address}`);
  const account = ethers.getAddress(address);

  const usdc = new ethers.Contract(CONFIG.CONTRACTS.USDC, ERC20_ABI, provider);
  const [snapshot, positionData, usdcBalanceRaw] = await Promise.all([
    getMarketSnapshot(),
    getPositions(address),
    usdc.balanceOf(account) as Promise<bigint>
  ]);

  const usdcBalance = Number(usdcBalanceRaw) / 10 ** CONFIG.ASSETS.USDC.decimals;
  const now = Date.now() / 1000;

  // Build tokenId → entry cost map from on-chain openPositionRequests.
  // openPositionRequests(key) returns optionTokenId (index [3]) which is the
  // ERC-1155 token the position settled into — this is the bridge between
  // request_key and a live position for per-position P&L.
  const hasRequestKeys = Boolean(params.requestKeys?.length);
  const tokenIdToEntryUsd = new Map<string, number>();

  if (hasRequestKeys) {
    const pm = new ethers.Contract(CONFIG.CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    const results = await Promise.allSettled(
      params.requestKeys!.map((key) => pm.openPositionRequests(key))
    );
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const req = r.value as any;
      const acct = String(req.account ?? req[0]);
      if (acct.toLowerCase() === ethers.ZeroAddress.toLowerCase()) continue;
      const tokenId = String(req.optionTokenId ?? req[3] ?? "0");
      const amountIn = Number(req.amountIn ?? req[5] ?? 0) / 10 ** CONFIG.ASSETS.USDC.decimals;
      if (tokenId && tokenId !== "0" && amountIn > 0) {
        // accumulate in case the same token was entered in multiple batches
        tokenIdToEntryUsd.set(tokenId, (tokenIdToEntryUsd.get(tokenId) ?? 0) + amountIn);
      }
    }
  }

  // Enrich each position with:
  //   current_spread_mark   — mark-to-market spread value (fair mid)
  //   close_bid_value_usd   — conservative close estimate using bid/ask (tradeable price)
  //   entry_cost_usd        — from on-chain amountIn (requires matching request_key)
  //   unrealized_pnl_*      — mark-based (vs entry cost)
  //   close_pnl_est_*       — bid-based estimate (what you'd actually receive on close)
  let totalMarkValueUsd = 0;
  let totalEntryUsd = 0;
  const enrichedPositions: any[] = [];

  for (const pos of positionData.positions) {
    const asset = pos.underlying as UnderlyingAsset;
    const absSize = Math.abs(pos.size);

    const expiryOpt = snapshot.options.find(
      (o) => o.expiryCode === pos.expiry_code && o.underlying === asset
    );
    const expirySec = expiryOpt?.expirySec ?? 0;
    const secsToExpiry = expirySec > 0 ? expirySec - now : 0;
    const daysToExpiry = expirySec > 0 ? Math.round((secsToExpiry / 86400) * 10) / 10 : null;
    const urgent = expirySec > 0 && secsToExpiry > 0 && secsToExpiry < 86400;

    // Resolve both legs from market snapshot
    const nakedOpt = snapshot.options.find(
      (o) =>
        o.underlying === asset &&
        o.expirySec === expirySec &&
        Math.trunc(o.strikePrice) === Math.trunc(pos.strike) &&
        o.optionType === pos.option_type
    );
    const pairOpt = (pos.pair_strike && expirySec)
      ? snapshot.options.find(
          (o) =>
            o.underlying === asset &&
            o.expirySec === expirySec &&
            Math.trunc(o.strikePrice) === Math.trunc(pos.pair_strike) &&
            o.optionType === pos.option_type
        )
      : undefined;

    // ── Mark-to-market spread value (fair mid) ─────────────────────────────
    let currentSpreadMark: number | null = null;
    let currentValueUsd: number | null = null;
    if (nakedOpt && pairOpt) {
      currentSpreadMark = Math.round(Math.abs(nakedOpt.markPrice - pairOpt.markPrice) * 100) / 100;
      currentValueUsd   = Math.round(currentSpreadMark * absSize * 100) / 100;
      totalMarkValueUsd += currentValueUsd;
    }

    // ── Tradeable close price (bid-based, conservative) ────────────────────
    // Long spread  → sell naked at bid, cover pair at ask  → receive bid − ask
    // Short spread → buy naked at ask, sell pair at bid    → pay ask − bid
    // This is what the keeper would realistically fill on a close order.
    let closeBidValueUsd: number | null = null;
    if (nakedOpt && pairOpt) {
      const spreadClose = pos.side === "long"
        ? nakedOpt.bid - pairOpt.ask   // conservative: spread bid side
        : nakedOpt.ask - pairOpt.bid;  // cost to close short spread
      closeBidValueUsd = Math.round(Math.max(0, spreadClose) * absSize * 100) / 100;
    }

    // ── Per-position P&L via tokenId → entry cost bridge ──────────────────
    const entryUsd = hasRequestKeys ? (tokenIdToEntryUsd.get(pos.token_id) ?? null) : null;
    let unrealizedPnlUsd: number | null = null;
    let unrealizedPnlPct: number | null = null;
    let closePnlEstUsd:   number | null = null;
    let closePnlEstPct:   number | null = null;

    if (entryUsd !== null && entryUsd > 0) {
      totalEntryUsd += entryUsd;
      if (currentValueUsd !== null) {
        unrealizedPnlUsd = Math.round((currentValueUsd - entryUsd) * 100) / 100;
        unrealizedPnlPct = Math.round((unrealizedPnlUsd / entryUsd) * 10000) / 100;
      }
      if (closeBidValueUsd !== null) {
        closePnlEstUsd = Math.round((closeBidValueUsd - entryUsd) * 100) / 100;
        closePnlEstPct = Math.round((closePnlEstUsd / entryUsd) * 10000) / 100;
      }
    }

    enrichedPositions.push({
      underlying: pos.underlying,
      option_type: pos.option_type,
      side: pos.side,
      naked_strike: pos.strike,
      pair_strike: pos.pair_strike,
      expiry_code: pos.expiry_code,
      days_to_expiry: daysToExpiry,
      size: absSize,
      // Mark-to-market (fair mid price)
      current_spread_mark: currentSpreadMark,
      current_value_usd: currentValueUsd,
      // Tradeable close estimate (bid side — conservative)
      close_bid_value_usd: closeBidValueUsd,
      // Per-position P&L (populated when request_keys resolve this token_id)
      entry_cost_usd: entryUsd,
      unrealized_pnl_usd: unrealizedPnlUsd,
      unrealized_pnl_pct: unrealizedPnlPct,
      // Close P&L estimate — what you'd realize if you close right now
      close_pnl_est_usd: closePnlEstUsd,
      close_pnl_est_pct: closePnlEstPct,
      urgent,
      token_id: pos.token_id
    });
  }

  const urgentCount = enrichedPositions.filter((p) => p.urgent).length;
  const totalMarkRounded  = Math.round(totalMarkValueUsd * 100) / 100;
  const totalEntryRounded = Math.round(totalEntryUsd * 100) / 100;

  const result: Record<string, any> = {
    account,
    usdc_balance: Math.round(usdcBalance * 100) / 100,
    total_positions: enrichedPositions.length,
    total_mark_value_usd: totalMarkRounded,
    urgent_count: urgentCount,
    positions: enrichedPositions
  };

  if (hasRequestKeys) {
    const pnlUsd = Math.round((totalMarkValueUsd - totalEntryUsd) * 100) / 100;
    const pnlPct = totalEntryRounded > 0
      ? Math.round((pnlUsd / totalEntryRounded) * 10000) / 100
      : null;

    result.total_entry_cost_usd = totalEntryRounded;
    result.total_pnl_usd        = pnlUsd;
    result.total_pnl_pct        = pnlPct;
    result.tracked_request_keys = params.requestKeys!.length;
    result.pnl_note = [
      "unrealized_pnl = current mark value vs on-chain amountIn (fair mid, not tradeable).",
      "close_pnl_est  = bid-based spread value vs entry cost (conservative, tradeable estimate).",
      "entry_cost_usd per position requires request_key → optionTokenId match from openPositionRequests."
    ].join(" ");
  }

  return result;
}
