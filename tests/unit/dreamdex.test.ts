import { describe, expect, it } from "vitest";
import {
  captureMarketSnapshot,
  countHistoricalBinaryMarkets,
  discoverSuccessorMarkets,
  executeBoundedHistoricalRead,
  getHistoricalMarketResolution,
  getHistoricalReconstructedBookCapability,
  HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
  HISTORICAL_CANDLE_INTERVAL_SECONDS,
  HISTORICAL_MARKET_FILLS_QUERY,
  HISTORICAL_MARKET_ORDERS_QUERY,
  historicalDreamDexSourceContract,
  listHistoricalBinaryMarkets,
  listHistoricalCandles,
  listHistoricalFillsByMarket,
  listHistoricalOrdersByMarket,
  normalizeHistoricalPagination,
  normalizeBinaryMarket,
  resolveHistoricalCutoffBlock,
  validateMainnetHistoricalDreamDexConfig,
  validateDreamDexReadConfig,
  type DreamDexReadConfig,
  type HistoricalDreamDexSdkClient,
  type HistoricalRpcFetch,
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
const historicalMarketId = `0x${"1".repeat(61)}bbb`;

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

const historicalMarket: BinaryMarket = {
  ...market,
  id: "0xhistorical",
  poolAddress: "0x0000000000000000000000000000000000000c11",
  marketId: historicalMarketId,
  marketAddress: "0x0000000000000000000000000000000000000d11",
  status: "Finalized",
  tradingStart: "1787566400",
  expiry: "1787570000",
  winningOutcome: 0,
  tradeCount: "12",
  nonce: "144",
  finalized: true
};

function historicalClientWith(rows: BinaryMarket[]): {
  readonly client: HistoricalDreamDexSdkClient;
  readonly calls: {
    listPast?: unknown;
    count?: unknown;
    candles?: unknown;
    resolution?: string;
  };
} {
  const calls: {
    listPast?: unknown;
    count?: unknown;
    candles?: unknown;
    resolution?: string;
  } = {};
  return {
    calls,
    client: {
      countBinaryMarkets(opts) {
        calls.count = opts;
        return Promise.resolve(rows.length);
      },
      listPastBinaryMarkets(opts) {
        calls.listPast = opts;
        return Promise.resolve(rows);
      },
      getBinaryMarket(id) {
        return Promise.resolve(rows.find((row) => row.marketId === id) ?? null);
      },
      getMarketResolution(id) {
        calls.resolution = id;
        return Promise.resolve({
          events: [{ status: "Resolved" }],
          reference: { questionId: "ref-1" },
          openingAnswer: { numericValue: "100" },
          closingAnswer: { numericValue: "101" }
        });
      },
      getMarketStatusHistory() {
        return Promise.resolve([
          {
            oldStatus: "Trading",
            newStatus: "Resolved",
            blockNumber: "100",
            timestamp: "1787570001",
            txHash: "0xresolved"
          }
        ]);
      },
      getOpeningPrices(ids) {
        return Promise.resolve(Object.fromEntries(ids.map((id) => [id, "100000"])));
      },
      getCandles(poolAddress, intervalSeconds, opts) {
        calls.candles = { poolAddress, intervalSeconds, opts };
        return Promise.resolve([
          {
            bucketStart: "1787566400",
            openPrice: "100",
            high: "110",
            low: "90",
            closePrice: "105",
            baseVolume: "25",
            quoteVolume: "2500",
            tradeCount: 2
          }
        ]);
      },
      getFills() {
        return Promise.resolve([]);
      }
    }
  };
}

function mockIndexerFetch(payload: unknown): Parameters<typeof listHistoricalOrdersByMarket>[3] {
  return () =>
    Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload)
  });
}

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
    expect(HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY).toBe("SOURCE_INCOMPLETE");
    expect(historicalDreamDexSourceContract.bookReconstructionCapability).toBe("SOURCE_INCOMPLETE");
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

  it("resolves the greatest finalized block strictly before T across T-1, T, and T+1", async () => {
    const rpcFetch: HistoricalRpcFetch = (_input, init) => {
      const request = JSON.parse(init.body) as {
        readonly id: number;
        readonly params: readonly [string, boolean];
      };
      const tag = request.params[0];
      const blockNumber = tag === "finalized" ? 10 : Number(BigInt(tag));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              number: `0x${blockNumber.toString(16)}`,
              hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
              timestamp: `0x${(100 + blockNumber).toString(16)}`
            }
          })
      });
    };

    const beforeT = await resolveHistoricalCutoffBlock(mainnetHistoricalConfig, 105, rpcFetch);
    const atNextT = await resolveHistoricalCutoffBlock(mainnetHistoricalConfig, 106, rpcFetch);
    const afterT = await resolveHistoricalCutoffBlock(mainnetHistoricalConfig, 107, rpcFetch);

    expect(beforeT).toMatchObject({ ok: true, value: { blockNumber: "4", timestampSeconds: 104 } });
    expect(atNextT).toMatchObject({ ok: true, value: { blockNumber: "5", timestampSeconds: 105 } });
    expect(afterT).toMatchObject({ ok: true, value: { blockNumber: "6", timestampSeconds: 106 } });
  });
});

describe("HIST-002 read-only historical adapter", () => {
  it("bounds historical pagination before indexer reads", () => {
    expect(normalizeHistoricalPagination({ limit: 50, offset: 10 })).toEqual({ limit: 50, offset: 10 });
    expect(() => normalizeHistoricalPagination({ limit: 101 })).toThrow(/between 1 and 100/);
    expect(() => normalizeHistoricalPagination({ offset: 10_001 })).toThrow(/between 0 and 10000/);
  });

  it("lists finalized historical markets with mainnet provenance and opening prices", async () => {
    const { client, calls } = historicalClientWith([historicalMarket, { ...historicalMarket, marketId: `0x${"2".repeat(61)}bbb` }]);
    const result = await listHistoricalBinaryMarkets(client, mainnetHistoricalConfig, {
      asset: "BTC",
      intervalSec: 3600,
      status: "Finalized",
      limit: 1,
      offset: 2
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(calls.listPast).toMatchObject({
      asset: "BTC",
      intervalSec: 3600,
      status: "Finalized",
      limit: 2,
      offset: 2
    });
    expect(result.value.rows).toHaveLength(1);
    expect(result.value.hasMore).toBe(true);
    expect(result.value.rows[0]?.stableMarketId).toBe(historicalMarketId.toLowerCase());
    expect(result.value.rows[0]?.openingPriceRaw).toBe("100000");
    expect(result.value.rows[0]?.source).toMatchObject({
      plane: "MAINNET_HISTORICAL",
      chainId: 5031,
      writePolicy: "read-only-no-mainnet-signer"
    });
  });

  it("counts historical markets without fetching rows", async () => {
    const { client, calls } = historicalClientWith([historicalMarket]);
    const result = await countHistoricalBinaryMarkets(client, mainnetHistoricalConfig, { asset: "BTC" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(calls.count).toMatchObject({ phase: "past", asset: "BTC" });
    expect(result.value.count).toBe(1);
  });

  it("fetches historical resolution without hiding source plane", async () => {
    const { client, calls } = historicalClientWith([historicalMarket]);
    const result = await getHistoricalMarketResolution(client, mainnetHistoricalConfig, historicalMarketId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(calls.resolution).toBe(historicalMarketId);
    expect(result.value.marketId).toBe(historicalMarketId.toLowerCase());
    expect(result.value.source.plane).toBe("MAINNET_HISTORICAL");
  });

  it("maps historical candles and rejects unsupported intervals", async () => {
    const { client, calls } = historicalClientWith([historicalMarket]);
    const result = await listHistoricalCandles(client, mainnetHistoricalConfig, historicalMarket.poolAddress, 3600, {
      limit: 10,
      fromSec: 1787566400,
      toSec: 1787570000
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(calls.candles).toMatchObject({
      poolAddress: historicalMarket.poolAddress,
      intervalSeconds: 3600,
      opts: { limit: 10, from: 1787566400, to: 1787570000 }
    });
    expect(result.value[0]?.closePriceRaw).toBe("105");
    expect(result.value[0]?.source.plane).toBe("MAINNET_HISTORICAL");

    const invalid = await listHistoricalCandles(client, mainnetHistoricalConfig, historicalMarket.poolAddress, 120, {
      limit: 10
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) {
      throw new Error("expected unsupported candle interval to fail");
    }
    expect(invalid.reasonCode).toBe("DREAMDEX_HISTORICAL_BOUNDS_INVALID");
  });

  it("filters recycled-pool candle rows to the immutable market window", async () => {
    const { client } = historicalClientWith([historicalMarket]);
    const boundedClient: HistoricalDreamDexSdkClient = {
      ...client,
      getCandles() {
        return Promise.resolve([
          {
            bucketStart: "1787306400",
            openPrice: "1",
            high: "1",
            low: "1",
            closePrice: "1",
            baseVolume: "1",
            quoteVolume: "1",
            tradeCount: 1
          },
          {
            bucketStart: "1787566400",
            openPrice: "100",
            high: "110",
            low: "90",
            closePrice: "105",
            baseVolume: "25",
            quoteVolume: "2500",
            tradeCount: 2
          },
          {
            bucketStart: "1787652000",
            openPrice: "2",
            high: "2",
            low: "2",
            closePrice: "2",
            baseVolume: "2",
            quoteVolume: "2",
            tradeCount: 1
          }
        ]);
      }
    };
    const result = await listHistoricalCandles(
      boundedClient,
      mainnetHistoricalConfig,
      historicalMarket.poolAddress,
      3600,
      { fromSec: 1787566400, toSec: 1787570000, limit: 10 }
    );

    expect(result).toMatchObject({ ok: true, value: [{ bucketStartSeconds: 1787566400 }] });
  });

  it("bounds and retries historical reads inside one deterministic deadline", async () => {
    let attempts = 0;
    const retried = await executeBoundedHistoricalRead(
      () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("temporary upstream failure")) : Promise.resolve("ok");
      },
      { deadlineMs: 100, retryDelaysMs: [1] }
    );
    const startedAt = Date.now();
    await expect(
      executeBoundedHistoricalRead(() => new Promise<never>(() => undefined), {
        deadlineMs: 20,
        retryDelaysMs: []
      })
    ).rejects.toThrow(/deadline exceeded/);

    expect(retried).toBe("ok");
    expect(attempts).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it("parses bounded market-wide historical order pages through raw GraphQL", async () => {
    const calls: unknown[] = [];
    const fetchImpl: Parameters<typeof listHistoricalOrdersByMarket>[3] = (url, init) => {
      calls.push({ url, body: init.body });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
          data: {
            Order: [
              {
                id: "order-1",
                orderId: "101",
                market_id: historicalMarketId,
                side: "BUY_YES",
                isBid: true,
                price: "10000",
                fullQuantity: "1000000",
                filledQuantity: "250000",
                quantityRemaining: "750000",
                status: "Cancelled",
                rested: true,
                expireTimestampNs: "1787570100000000000",
                placedAtBlock: "44",
                placedAtTimestamp: "1787566500",
                lastUpdatedAtBlock: "55",
                lastUpdatedAtTimestamp: "1787566600",
                placedTxHash: "0xplaced"
              },
              {
                id: "order-2",
                orderId: "102",
                market_id: historicalMarketId,
                side: "SELL_YES",
                isBid: false,
                price: "11000",
                fullQuantity: "1000000",
                filledQuantity: "0",
                quantityRemaining: "1000000",
                status: "Open",
                rested: true,
                expireTimestampNs: "1787570200000000000",
                placedAtBlock: "45",
                placedAtTimestamp: "1787566510",
                lastUpdatedAtBlock: "45",
                lastUpdatedAtTimestamp: "1787566510",
                placedTxHash: "0xplaced2"
              }
            ]
          }
        })
      });
    };

    const result = await listHistoricalOrdersByMarket(mainnetHistoricalConfig, historicalMarketId, { limit: 1 }, fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(calls[0]).toMatchObject({
      url: mainnetHistoricalConfig.indexerUrl,
      body: JSON.stringify({
        query: HISTORICAL_MARKET_ORDERS_QUERY,
        variables: { marketId: historicalMarketId.toLowerCase(), limit: 2, offset: 0 }
      })
    });
    expect(result.value.rows).toHaveLength(1);
    expect(result.value.hasMore).toBe(true);
    expect(result.value.rows[0]?.remainingQuantityRaw).toBe("750000");
    expect(result.value.rows[0]?.source.writePolicy).toBe("read-only-no-mainnet-signer");
  });

  it("parses bounded market-wide historical fill pages through raw GraphQL", async () => {
    const result = await listHistoricalFillsByMarket(
      mainnetHistoricalConfig,
      historicalMarketId,
      { limit: 1, offset: 3 },
      mockIndexerFetch({
        data: {
          Fill: [
            {
              id: "fill-1",
              market_id: historicalMarketId,
              pool: historicalMarket.poolAddress,
              fillPrice: "10100",
              quantity: "500000",
              quoteQuantity: "5050",
              kind: "DIRECT_YES",
              makerOrderId: "101",
              makerRemainingQuantity: "500000",
              makerSide: "SELL_YES",
              takerOrderId: "201",
              takerRemainingQuantity: "0",
              takerSide: "BUY_YES",
              takerIsBid: true,
              timestamp: "1787566520",
              blockNumber: "46",
              logIndex: "3",
              txHash: "0xfill"
            }
          ]
        }
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.value.rows[0]?.fillPriceRaw).toBe("10100");
    expect(result.value.rows[0]?.poolAddress).toBe(historicalMarket.poolAddress.toLowerCase());
    expect(result.value.rows[0]?.source.plane).toBe("MAINNET_HISTORICAL");
  });

  it("fails raw historical indexer reads closed on GraphQL errors", async () => {
    const result = await listHistoricalOrdersByMarket(
      mainnetHistoricalConfig,
      historicalMarketId,
      { limit: 1 },
      mockIndexerFetch({ errors: [{ message: "permission denied" }] })
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected GraphQL error to fail");
    }
    expect(result.reasonCode).toBe("DREAMDEX_HISTORICAL_READ_FAILED");
    expect(result.message).toContain("permission denied");
  });

  it("keeps reconstructed book reads fail-closed until verified", () => {
    const result = getHistoricalReconstructedBookCapability();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected book reconstruction to remain unavailable");
    }
    expect(result.reasonCode).toBe("DREAMDEX_HISTORICAL_CAPABILITY_UNVERIFIED");
    expect(result.message).toContain("could not prove");
  });
});
