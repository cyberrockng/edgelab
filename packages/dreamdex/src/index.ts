import {
  SOMNIA_TESTNET_ADDRESSES,
  SomniaMarkets,
  type BinaryMarket,
  type BinaryOrderBook
} from "@somnia-chain/markets-sdk";
import {
  DREAMDEX_MARKETS_SDK_VERSION,
  SOMNIA_MAINNET_CHAIN_ID,
  SOMNIA_SHANNON_CHAIN_ID,
  type EvidenceClass
} from "@edgelab/domain";
import { defineChain } from "viem";

export interface DreamDexReadConfig {
  readonly rpcUrl: string;
  readonly wsRpcUrl: string;
  readonly indexerUrl: string;
  readonly chainId: number;
  readonly sdkVersion: string;
}

export interface MainnetHistoricalDreamDexConfig {
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly chainId: number;
  readonly sdkVersion: string;
}

export interface DreamDexBookLevel {
  readonly priceRaw: string;
  readonly quantityRaw: string;
}

export type HistoricalBookReconstructionCapability = "UNVERIFIED_FAIL_CLOSED" | "VERIFIED_BLOCK_LEVEL";

export const DREAMDEX_MAINNET_INDEXER_URL = "https://prd.smk.somnia.host/v1/graphql" as const;
export const SOMNIA_MAINNET_RPC_URL = "https://api.infra.mainnet.somnia.network" as const;
export const HISTORICAL_GRAPHQL_QUERY_VERSION = "edgelab-mainnet-history-v1" as const;
export const HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY =
  "UNVERIFIED_FAIL_CLOSED" satisfies HistoricalBookReconstructionCapability;
export const HISTORICAL_CANDLE_INTERVAL_SECONDS = [
  60,
  300,
  900,
  3600,
  14400,
  86400
] as const;

export const HISTORICAL_MARKET_ORDERS_QUERY = `query EdgeLabHistoricalOrders($marketId: String!, $limit: Int!, $offset: Int!) {
  Order(
    where: { market_id: { _eq: $marketId } }
    order_by: [{ placedAtBlock: asc }, { lastUpdatedAtBlock: asc }, { id: asc }]
    limit: $limit
    offset: $offset
  ) {
    id
    orderId
    market_id
    side
    isBid
    price
    fullQuantity
    filledQuantity
    quantityRemaining
    status
    rested
    expireTimestampNs
    placedAtBlock
    placedAtTimestamp
    lastUpdatedAtBlock
    lastUpdatedAtTimestamp
    placedTxHash
  }
}`;

export const HISTORICAL_MARKET_FILLS_QUERY = `query EdgeLabHistoricalFills($marketId: String!, $limit: Int!, $offset: Int!) {
  Fill(
    where: { market_id: { _eq: $marketId } }
    order_by: [{ blockNumber: asc }, { logIndex: asc }, { id: asc }]
    limit: $limit
    offset: $offset
  ) {
    id
    market_id
    pool
    fillPrice
    quantity
    quoteQuantity
    kind
    makerOrderId
    makerRemainingQuantity
    makerSide
    takerOrderId
    takerRemainingQuantity
    takerSide
    takerIsBid
    timestamp
    blockNumber
    logIndex
    txHash
  }
}`;

export const historicalDreamDexSourceContract = {
  version: HISTORICAL_GRAPHQL_QUERY_VERSION,
  network: {
    label: "Somnia Mainnet historical research",
    chainId: SOMNIA_MAINNET_CHAIN_ID,
    rpcUrl: SOMNIA_MAINNET_RPC_URL,
    indexerUrl: DREAMDEX_MAINNET_INDEXER_URL,
    writePolicy: "read-only-no-mainnet-signer"
  },
  sdk: {
    packageName: "@somnia-chain/markets-sdk",
    requiredVersion: DREAMDEX_MARKETS_SDK_VERSION,
    requiredMethods: [
      "countBinaryMarkets",
      "listPastBinaryMarkets",
      "getMarketResolution",
      "getMarketStatusHistory",
      "getOpeningPrices",
      "getCandles",
      "getFills",
      "getOrders",
      "getBinaryPositionPnL"
    ]
  },
  indexerFields: {
    order: [
      "side",
      "price",
      "fullQuantity",
      "filledQuantity",
      "quantityRemaining",
      "placedAtBlock",
      "lastUpdatedAtBlock"
    ],
    fill: [
      "fillPrice",
      "quantity",
      "kind",
      "txHash",
      "blockNumber",
      "logIndex",
      "makerOrderId",
      "takerOrderId",
      "makerRemainingQuantity",
      "takerRemainingQuantity"
    ],
    candle: [
      "openPrice",
      "high",
      "low",
      "closePrice",
      "baseVolume",
      "quoteVolume",
      "tradeCount"
    ]
  },
  candleIntervals: HISTORICAL_CANDLE_INTERVAL_SECONDS,
  bookReconstructionCapability: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
} as const;

export interface DreamDexMarketEvidence {
  readonly stableMarketId: string;
  readonly marketAddress: string;
  readonly poolAddress: string;
  readonly nonce: string | null;
  readonly asset: "BTC" | "ETH";
  readonly question: string;
  readonly status: string;
  readonly intervalSeconds: number | null;
  readonly tradingStartSeconds: number;
  readonly expirySeconds: number;
  readonly collateral: string;
  readonly quoteDecimals: number;
  readonly source: {
    readonly sdkVersion: typeof DREAMDEX_MARKETS_SDK_VERSION;
    readonly chainId: typeof SOMNIA_SHANNON_CHAIN_ID;
    readonly rpcUrl: string;
    readonly indexerUrl: string;
    readonly evidenceClass: EvidenceClass;
    readonly retrievedAt: string;
  };
}

export interface DreamDexSnapshotEvidence {
  readonly market: DreamDexMarketEvidence;
  readonly book: {
    readonly yesBids: readonly DreamDexBookLevel[];
    readonly yesAsks: readonly DreamDexBookLevel[];
    readonly noBids: readonly DreamDexBookLevel[];
    readonly noAsks: readonly DreamDexBookLevel[];
  };
}

export type DreamDexReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reasonCode:
        | "DREAMDEX_CONFIG_INVALID"
        | "DREAMDEX_READ_FAILED"
        | "DREAMDEX_NO_ELIGIBLE_MARKET"
        | "DREAMDEX_MALFORMED_MARKET";
      readonly message: string;
    };

export interface DreamDexSdkClient {
  listLiveBinaryMarkets(filter?: {
    readonly asset?: string;
    readonly intervalSec?: number;
    readonly status?: string;
  }): Promise<BinaryMarket[]>;
  getBinaryBookParams(pool: string): Promise<{
    readonly tickSize: bigint;
    readonly lotSize: bigint;
    readonly minQuantity: bigint;
  }>;
  getLiveBinaryOrderBookByMarket(marketId: string, opts?: { readonly depth?: number }): BinaryOrderBook;
  getBinaryMarket(id: string): Promise<BinaryMarket | null>;
}

export const somniaShannonTestnet = defineChain({
  id: SOMNIA_SHANNON_CHAIN_ID,
  name: "Somnia Shannon Testnet",
  nativeCurrency: {
    name: "Somnia Test Token",
    symbol: "STT",
    decimals: 18
  },
  rpcUrls: {
    default: {
      http: ["https://api.infra.testnet.somnia.network/"],
      webSocket: ["wss://api.infra.testnet.somnia.network/ws"]
    }
  },
  blockExplorers: {
    default: {
      name: "Somnia Shannon Explorer",
      url: "https://shannon-explorer.somnia.network/"
    }
  },
  testnet: true
});

export const somniaMainnetReadOnly = defineChain({
  id: SOMNIA_MAINNET_CHAIN_ID,
  name: "Somnia Mainnet",
  nativeCurrency: {
    name: "Somnia",
    symbol: "SOMI",
    decimals: 18
  },
  rpcUrls: {
    default: {
      http: [SOMNIA_MAINNET_RPC_URL]
    }
  },
  testnet: false
});

export function validateDreamDexReadConfig(config: DreamDexReadConfig): DreamDexReadConfig {
  if (config.chainId !== SOMNIA_SHANNON_CHAIN_ID) {
    throw new Error(`DreamDEX reads must target Somnia Shannon chain ${String(SOMNIA_SHANNON_CHAIN_ID)}`);
  }
  if (config.sdkVersion !== DREAMDEX_MARKETS_SDK_VERSION) {
    throw new Error(`DreamDEX SDK must be pinned to ${DREAMDEX_MARKETS_SDK_VERSION}`);
  }
  return config;
}

export function validateMainnetHistoricalDreamDexConfig(
  config: MainnetHistoricalDreamDexConfig
): MainnetHistoricalDreamDexConfig {
  if (config.chainId !== SOMNIA_MAINNET_CHAIN_ID) {
    throw new Error(`DreamDEX historical reads must target Somnia mainnet chain ${String(SOMNIA_MAINNET_CHAIN_ID)}`);
  }
  if (config.sdkVersion !== DREAMDEX_MARKETS_SDK_VERSION) {
    throw new Error(`DreamDEX SDK must be pinned to ${DREAMDEX_MARKETS_SDK_VERSION}`);
  }
  return config;
}

export function createDreamDexSdkClient(config: DreamDexReadConfig): DreamDexSdkClient {
  const validated = validateDreamDexReadConfig(config);
  return new SomniaMarkets({
    chain: {
      ...somniaShannonTestnet,
      rpcUrls: {
        default: {
          http: [validated.rpcUrl],
          webSocket: [validated.wsRpcUrl]
        }
      }
    },
    wsRpcUrl: validated.wsRpcUrl,
    indexerUrl: validated.indexerUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES
  }).client;
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toBookLevels(levels: readonly { readonly price: bigint; readonly quantity: bigint }[]): DreamDexBookLevel[] {
  return levels.map((level) => ({
    priceRaw: level.price.toString(),
    quantityRaw: level.quantity.toString()
  }));
}

export function normalizeBinaryMarket(
  market: BinaryMarket,
  config: DreamDexReadConfig,
  retrievedAt: string,
  evidenceClass: EvidenceClass
): DreamDexReadResult<DreamDexMarketEvidence> {
  const tradingStartSeconds = parsePositiveInteger(market.tradingStart);
  const expirySeconds = parsePositiveInteger(market.expiry);
  const intervalSeconds =
    parsePositiveInteger(market.intervalSec ?? null) ??
    (tradingStartSeconds !== null && expirySeconds !== null
      ? expirySeconds - tradingStartSeconds
      : null);
  if (
    !["BTC", "ETH"].includes(market.asset) ||
    tradingStartSeconds === null ||
    expirySeconds === null ||
    expirySeconds <= tradingStartSeconds
  ) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_MALFORMED_MARKET",
      message: "Binary market row failed EdgeLab validation"
    };
  }
  const asset = market.asset as "BTC" | "ETH";

  return {
    ok: true,
    value: {
      stableMarketId: market.marketId.toLowerCase(),
      marketAddress: market.marketAddress.toLowerCase(),
      poolAddress: market.poolAddress.toLowerCase(),
      nonce: market.nonce ?? null,
      asset,
      question: market.question,
      status: market.status,
      intervalSeconds,
      tradingStartSeconds,
      expirySeconds,
      collateral: market.collateral.toLowerCase(),
      quoteDecimals: market.quoteDecimals,
      source: {
        sdkVersion: DREAMDEX_MARKETS_SDK_VERSION,
        chainId: SOMNIA_SHANNON_CHAIN_ID,
        rpcUrl: config.rpcUrl,
        indexerUrl: config.indexerUrl,
        evidenceClass,
        retrievedAt
      }
    }
  };
}

export async function discoverSuccessorMarkets(
  client: DreamDexSdkClient,
  config: DreamDexReadConfig,
  options: { readonly assets?: readonly ("BTC" | "ETH")[]; readonly intervals?: readonly number[] } = {}
): Promise<DreamDexReadResult<DreamDexMarketEvidence[]>> {
  try {
    validateDreamDexReadConfig(config);
    const rows = await client.listLiveBinaryMarkets({ status: "Trading" });
    const assets = new Set(options.assets ?? ["BTC", "ETH"]);
    const intervals = new Set(options.intervals ?? [900, 3600]);
    const retrievedAt = new Date().toISOString();
    const normalized = rows
      .map((row) => normalizeBinaryMarket(row, config, retrievedAt, "LIVE"))
      .filter((result): result is { readonly ok: true; readonly value: DreamDexMarketEvidence } => result.ok)
      .map((result) => result.value)
      .filter(
        (market) =>
          assets.has(market.asset) &&
          (market.intervalSeconds === null || intervals.has(market.intervalSeconds))
      )
      .sort((a, b) => a.expirySeconds - b.expirySeconds);

    if (normalized.length === 0) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_NO_ELIGIBLE_MARKET",
        message: "No BTC/ETH Trading successor market matched the requested intervals"
      };
    }
    return { ok: true, value: normalized };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX read failed"
    };
  }
}

export async function captureMarketSnapshot(
  client: DreamDexSdkClient,
  config: DreamDexReadConfig,
  marketId: string,
  depth = 10
): Promise<DreamDexReadResult<DreamDexSnapshotEvidence>> {
  try {
    validateDreamDexReadConfig(config);
    const market = await client.getBinaryMarket(marketId);
    if (market === null) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_NO_ELIGIBLE_MARKET",
        message: `Market ${marketId} was not found`
      };
    }
    const retrievedAt = new Date().toISOString();
    const normalized = normalizeBinaryMarket(market, config, retrievedAt, "LIVE");
    if (!normalized.ok) {
      return normalized;
    }
    await client.getBinaryBookParams(market.poolAddress);
    const book = client.getLiveBinaryOrderBookByMarket(market.marketId, { depth });
    return {
      ok: true,
      value: {
        market: normalized.value,
        book: {
          yesBids: toBookLevels(book.yesBids),
          yesAsks: toBookLevels(book.yesAsks),
          noBids: toBookLevels(book.noBids),
          noAsks: toBookLevels(book.noAsks)
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX snapshot read failed"
    };
  }
}

export const dreamDexBoundaries = {
  writes: "browser-wallet-human-gated-only",
  mainnetHistoricalWrites: "forbidden",
  historicalReplay: "allowed-only-from-authentic-provenance-labeled-history",
  fabricatedFills: "forbidden",
  bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
} as const;
