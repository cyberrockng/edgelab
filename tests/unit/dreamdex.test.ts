import { describe, expect, it } from "vitest";
import {
  captureMarketSnapshot,
  discoverSuccessorMarkets,
  HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
  HISTORICAL_CANDLE_INTERVAL_SECONDS,
  HISTORICAL_MARKET_FILLS_QUERY,
  HISTORICAL_MARKET_ORDERS_QUERY,
  historicalDreamDexSourceContract,
  normalizeBinaryMarket,
  validateMainnetHistoricalDreamDexConfig,
  validateDreamDexReadConfig,
  type DreamDexReadConfig,
  type MainnetHistoricalDreamDexConfig,
  type DreamDexSdkClient
} from "@edgelab/dreamdex";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const config: DreamDexReadConfig = {
  rpcUrl: "https://api.infra.testnet.somnia.network/",
  wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
  chainId: 50312,
  sdkVersion: "0.28.1"
};

const mainnetHistoricalConfig: MainnetHistoricalDreamDexConfig = {
  rpcUrl: "https://api.infra.mainnet.somnia.network",
  indexerUrl: "https://prd.smk.somnia.host/v1/graphql",
  chainId: 5031,
  sdkVersion: "0.28.1"
};

const capturedMarketId = `0x${"0".repeat(61)}abc`;

const market: BinaryMarket = {
  id: "0xmarket",
  marketType: "BINARY",
  poolAddress: "0x0000000000000000000000000000000000000a11",
  lastPrice: null,
  lastTradeAt: null,
  cumulativeBaseVolume: "0",
  cumulativeQuoteVolume: "0",
  tradeCount: "0",
  baseDecimals: 6,
  quoteDecimals: 6,
  createdAtTimestamp: "1787570000",
  marketId: capturedMarketId,
  marketAddress: "0x0000000000000000000000000000000000000b11",
  yesTokenId: "1",
  noTokenId: "2",
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  asset: "BTC",
  question: "Will BTC close up?",
  status: "Trading",
  oracleQuestion: "BTC up?",
  oracleQuestionId: "1",
  strike: "100000",
  tradingStart: "1787570000",
  expiry: "1787570900",
  winningOutcome: null,
  payoutNumerators: null,
  payoutDenominator: null,
  resolvedAtBlock: null,
  resolvedAtTimestamp: null,
  createdByTx: null,
  creator: null,
  voided: false,
  backing: "0",
  nonce: "58",
  finalized: false,
  netBacking: null,
  context: "0x",
  intervalSec: "900",
  interval: "15m",
  operatorId: 1,
  venueId: "0x4d41494e"
};

function clientWith(rows: BinaryMarket[]): DreamDexSdkClient {
  return {
    listLiveBinaryMarkets() {
      return Promise.resolve(rows);
    },
    getBinaryBookParams() {
      return Promise.resolve({
        tickSize: 1000n,
        lotSize: 1000n,
        minQuantity: 1000n
      });
    },
    getLiveBinaryOrderBookByMarket() {
      return {
        yesBids: [{ price: 1000n, quantity: 2000n }],
        yesAsks: [],
        noBids: [],
        noAsks: []
      };
    },
    getBinaryMarket() {
      return Promise.resolve(rows[0] ?? null);
    }
  };
}

describe("DEX-001 DreamDEX read adapter", () => {
  it("enforces exact SDK and Somnia chain configuration", () => {
    expect(validateDreamDexReadConfig(config)).toEqual(config);
    expect(() => validateDreamDexReadConfig({ ...config, chainId: 1 })).toThrow(/50312/);
    expect(() => validateDreamDexReadConfig({ ...config, sdkVersion: "0.28.0" })).toThrow(/0.28.1/);
  });

  it("normalizes binary market rows with stable marketId rather than pool identity", () => {
    const result = normalizeBinaryMarket(market, config, "2026-08-24T14:10:00.000Z", "MOCK");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.value.stableMarketId).toBe(market.marketId.toLowerCase());
    expect(result.value.poolAddress).toBe(market.poolAddress.toLowerCase());
    expect(result.value.intervalSeconds).toBe(900);
  });

  it("discovers preferred BTC/ETH successor markets without hardcoding pool availability", async () => {
    const result = await discoverSuccessorMarkets(clientWith([market]), config);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.value[0]?.asset).toBe("BTC");
  });

  it("captures empty sides explicitly instead of fabricating liquidity", async () => {
    const result = await captureMarketSnapshot(clientWith([market]), config, market.marketId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.value.book.yesBids).toEqual([{ priceRaw: "1000", quantityRaw: "2000" }]);
    expect(result.value.book.yesAsks).toEqual([]);
  });

  it("returns degraded state for malformed market rows", () => {
    const malformed = { ...market, expiry: "bad" };
    const result = normalizeBinaryMarket(
      malformed,
      config,
      "2026-08-24T14:10:00.000Z",
      "MOCK"
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected malformed market to fail");
    }
    expect(result.reasonCode).toBe("DREAMDEX_MALFORMED_MARKET");
  });
});

describe("HIST-001 DreamDEX historical source contract", () => {
  it("enforces read-only Somnia mainnet historical configuration", () => {
    expect(validateMainnetHistoricalDreamDexConfig(mainnetHistoricalConfig)).toEqual(mainnetHistoricalConfig);
    expect(() => validateMainnetHistoricalDreamDexConfig({ ...mainnetHistoricalConfig, chainId: 50312 })).toThrow(
      /5031/
    );
    expect(() => validateMainnetHistoricalDreamDexConfig({ ...mainnetHistoricalConfig, sdkVersion: "0.28.0" })).toThrow(
      /0.28.1/
    );
    expect(historicalDreamDexSourceContract.network.writePolicy).toBe("read-only-no-mainnet-signer");
  });

  it("locks the verified historical SDK and indexer surface", () => {
    expect(historicalDreamDexSourceContract.sdk.requiredMethods).toEqual(
      expect.arrayContaining([
        "countBinaryMarkets",
        "listPastBinaryMarkets",
        "getMarketResolution",
        "getMarketStatusHistory",
        "getOpeningPrices",
        "getCandles",
        "getFills",
        "getOrders",
        "getBinaryPositionPnL"
      ])
    );
    expect(HISTORICAL_CANDLE_INTERVAL_SECONDS).toEqual([60, 300, 900, 3600, 14400, 86400]);
  });

  it("keeps historical book reconstruction unavailable until BOOK-001 verifies semantics", () => {
    expect(HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY).toBe("UNVERIFIED_FAIL_CLOSED");
    expect(historicalDreamDexSourceContract.bookReconstructionCapability).toBe("UNVERIFIED_FAIL_CLOSED");
  });

  it("uses bounded raw indexer queries for market-wide historical orders and fills", () => {
    expect(HISTORICAL_MARKET_ORDERS_QUERY).toContain("query EdgeLabHistoricalOrders");
    expect(HISTORICAL_MARKET_ORDERS_QUERY).toContain("$marketId: String!");
    expect(HISTORICAL_MARKET_ORDERS_QUERY).toContain("$limit: Int!");
    expect(HISTORICAL_MARKET_ORDERS_QUERY).toContain("$offset: Int!");
    expect(HISTORICAL_MARKET_ORDERS_QUERY).toContain("placedAtBlock");
    expect(HISTORICAL_MARKET_ORDERS_QUERY).toContain("lastUpdatedAtBlock");
    expect(HISTORICAL_MARKET_ORDERS_QUERY).not.toMatch(/\bowner\b/);

    expect(HISTORICAL_MARKET_FILLS_QUERY).toContain("query EdgeLabHistoricalFills");
    expect(HISTORICAL_MARKET_FILLS_QUERY).toContain("$marketId: String!");
    expect(HISTORICAL_MARKET_FILLS_QUERY).toContain("$limit: Int!");
    expect(HISTORICAL_MARKET_FILLS_QUERY).toContain("$offset: Int!");
    expect(HISTORICAL_MARKET_FILLS_QUERY).toContain("blockNumber");
    expect(HISTORICAL_MARKET_FILLS_QUERY).toContain("logIndex");
    expect(HISTORICAL_MARKET_FILLS_QUERY).not.toMatch(/\bowner\b/);
  });
});
