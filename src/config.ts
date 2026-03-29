let _chainValidated = false;

export async function validateChainId(provider: any): Promise<void> {
  if (_chainValidated) return;
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(CONFIG.CHAIN_ID)) {
    throw new Error(`RPC provider is on chain ${network.chainId}, expected Base (${CONFIG.CHAIN_ID})`);
  }
  _chainValidated = true;
}

export const CONFIG = {
  RPC_URL: process.env.RPC_URL || "https://mainnet.base.org",
  CHAIN_ID: 8453,
  EXECUTION_FEE_FALLBACK: 60_000_000_000_000n,
  MARKET_DATA_URL: "https://app-data-base.s3.ap-southeast-1.amazonaws.com/market-data.json",
  CONTRACTS: {
    POSITION_MANAGER: "0x83B04701B227B045CBBAF921377137fF595a54af",
    SETTLE_MANAGER: "0x81A58c7F737a18a8964F62A2C165675C1819E77C",
    ROUTER: "0xfc61ba50AE7B9C4260C9f04631Ff28D5A2Fa4EB2",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
    WETH: "0x4200000000000000000000000000000000000006",
    OPTIONS_TOKEN_BTC: "0xc399D89bd99B7b68026703482bb6A2B9c69cE444",
    OPTIONS_TOKEN_ETH: "0x648DE615abD9339F5C85ed00cfD946C69BF858fA"
  },
  ASSETS: {
    BTC: { index: 1, decimals: 8 },
    ETH: { index: 2, decimals: 18 },
    USDC: { decimals: 6 }
  }
} as const;

export const POSITION_MANAGER_ABI = [
  "function createOpenPosition(uint16 _underlyingAssetIndex, uint8 _length, bool[4] memory _isBuys, bytes32[4] memory _optionIds, bool[4] memory _isCalls, uint256 _minSize, address[] memory _path, uint256 _amountIn, uint256 _minOutWhenSwap, address _leadTrader) external payable returns (bytes32)",
  "function createClosePosition(uint16 _underlyingAssetIndex, uint256 _optionTokenId, uint256 _size, address[] memory _path, uint256 _minAmountOut, uint256 _minOutWhenSwap, bool _withdrawNAT) external payable returns (bytes32)",
  "function executionFee() view returns (uint256)",
  "function openPositionRequests(bytes32 key) view returns (address account, uint16 underlyingAssetIndex, uint40 expiry, uint256 optionTokenId, uint256 minSize, uint256 amountIn, uint256 minOutWhenSwap, bool isDepositedInNAT, uint40 blockTime, uint8 status, uint256 sizeOut, uint256 executionPrice, uint40 processBlockTime, uint256 amountOut)",
  "function closePositionRequests(bytes32 key) view returns (address account, uint16 underlyingAssetIndex, uint40 expiry, uint256 optionTokenId, uint256 size, uint256 minAmountOut, uint256 minOutWhenSwap, bool withdrawNAT, uint40 blockTime, uint8 status, uint256 amountOut, uint256 executionPrice, uint40 processBlockTime)",
  "event GenerateRequestKey(address indexed account, bytes32 indexed key, bool indexed isOpen)"
];

export const SETTLE_MANAGER_ABI = [
  "function settlePosition(address[] memory _path, uint16 _underlyingAssetIndex, uint256 _optionTokenId, uint256 _minOutWhenSwap, bool _withdrawNAT) external payable",
  "event SettlePosition(address indexed account, uint16 indexed underlyingAssetIndex, uint40 indexed expiry, uint256 optionTokenId, uint256 size, address[] path, uint256 amountOut, uint256 settlePrice)"
];

export const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)"
];

export const OPTIONS_TOKEN_ABI = [
  "function tokensByAccount(address account) view returns (uint256[] memory)",
  "function balanceOfBatch(address[] memory accounts, uint256[] memory ids) view returns (uint256[] memory)"
];
