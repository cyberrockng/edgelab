import { describe, expect, it } from "vitest";
import {
  buildControlledLiquidityEvidence,
  buildUnsignedBinaryOrderEvidence,
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
  SHANNON_LIVE_OPEN_ORDERS_QUERY,
  historicalDreamDexSourceContract,
  listHistoricalBinaryMarkets,
  listHistoricalCandles,
  listHistoricalFillsByMarket,
  listHistoricalOrdersByMarket,
  normalizeHistoricalPagination,
  normalizeBinaryMarket,
  planExecutableQuote,
  readBinaryBookParams,
  resolveHistoricalCutoffBlockAfter,
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
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";

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
const binaryPoolSetupAbi = parseAbi([
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function outcomeToken() view returns (address)",
  "function collateralToken() view returns (address)",
  "function marketNonce() view returns (uint64)"
]);
const erc20ApproveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

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
    expect(result.value.lastPriceRaw).toBeNull();
    expect(result.value.lastTradeAtSeconds).toBeNull();
  });

  it("captures paired last-trade evidence without inventing an incomplete pair", () => {
    const valid = normalizeBinaryMarket(
      { ...market, lastPrice: "610000", lastTradeAt: "1787570300" },
      config,
      "2026-08-24T14:10:00.000Z",
      "MOCK"
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) {
      throw new Error(valid.message);
    }
    expect(valid.value.lastPriceRaw).toBe("610000");
    expect(valid.value.lastTradeAtSeconds).toBe(1787570300);

    const incomplete = normalizeBinaryMarket(
      { ...market, lastPrice: "610000", lastTradeAt: null },
      config,
      "2026-08-24T14:10:00.000Z",
      "MOCK"
    );
    expect(incomplete.ok).toBe(true);
    if (!incomplete.ok) {
      throw new Error(incomplete.message);
    }
    expect(incomplete.value.lastPriceRaw).toBeNull();
    expect(incomplete.value.lastTradeAtSeconds).toBeNull();
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
    let parameterReadCount = 0;
    const observationClient: DreamDexSdkClient = {
      ...clientWith([market]),
      getBinaryBookParams() {
        parameterReadCount += 1;
        return Promise.reject(new Error("Observation must not depend on execution pool parameters"));
      }
    };
    const result = await captureMarketSnapshot(observationClient, config, market.marketId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.value.book.yesBids).toEqual([{ priceRaw: "1000", quantityRaw: "2000" }]);
    expect(result.value.book.yesAsks).toEqual([]);
    expect(parameterReadCount).toBe(0);
  });

  it("retries transient Shannon book reads before failing the snapshot", async () => {
    let bookAttempts = 0;
    const flakyClient: DreamDexSdkClient = {
      ...clientWith([market]),
      getLiveBinaryOrderBookByMarket() {
        bookAttempts += 1;
        if (bookAttempts < 3) {
          throw new Error("WebSocket request failed");
        }
        return {
          yesBids: [{ price: 1000n, quantity: 2000n }],
          yesAsks: [{ price: 2000n, quantity: 3000n }],
          noBids: [],
          noAsks: []
        };
      }
    };

    const result = await captureMarketSnapshot(flakyClient, config, market.marketId);

    expect(result.ok).toBe(true);
    expect(bookAttempts).toBe(3);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.value.book.yesAsks).toEqual([{ priceRaw: "2000", quantityRaw: "3000" }]);
  });

  it("falls back to Shannon indexer open orders when the SDK book is empty", async () => {
    const originalFetch = globalThis.fetch;
    const emptyBookClient: DreamDexSdkClient = {
      ...clientWith([market]),
      getLiveBinaryOrderBookByMarket() {
        return {
          yesBids: [],
          yesAsks: [],
          noBids: [],
          noAsks: []
        };
      }
    };
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe(config.indexerUrl);
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        readonly query?: string;
        readonly variables?: { readonly marketId?: string };
      };
      expect(body.query).toBe(SHANNON_LIVE_OPEN_ORDERS_QUERY);
      expect(body.variables?.marketId).toBe(market.marketId.toLowerCase());
      return Promise.resolve(new Response(
        JSON.stringify({
          data: {
            Order: [
              {
                side: "SELL_YES",
                isBid: false,
                price: "600000",
                quantityRemaining: "1000",
                status: "Open",
                rested: true
              },
              {
                side: "SELL_YES",
                isBid: false,
                price: "600000",
                quantityRemaining: "2000",
                status: "Open",
                rested: true
              },
              {
                side: "SELL_NO",
                isBid: false,
                price: "420000",
                quantityRemaining: "1000",
                status: "Cancelled",
                rested: true
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));
    };
    try {
      const result = await captureMarketSnapshot(emptyBookClient, config, market.marketId);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.message);
      }
      expect(result.value.book.yesAsks).toEqual([{ priceRaw: "600000", quantityRaw: "3000" }]);
      expect(result.value.book.noAsks).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries transient Shannon book parameter reads", async () => {
    let paramAttempts = 0;
    const flakyClient: DreamDexSdkClient = {
      ...clientWith([market]),
      getBinaryBookParams() {
        paramAttempts += 1;
        if (paramAttempts < 2) {
          return Promise.reject(new Error("WebSocket request failed"));
        }
        return Promise.resolve({
          tickSize: 1000n,
          lotSize: 1000n,
          minQuantity: 1000n
        });
      }
    };

    const result = await readBinaryBookParams(flakyClient, config, market.poolAddress);

    expect(result.ok).toBe(true);
    expect(paramAttempts).toBe(2);
  });

  it("falls back to direct pool RPC when SDK book parameter reads time out", async () => {
    const originalFetch = globalThis.fetch;
    const timeoutClient: DreamDexSdkClient = {
      ...clientWith([market]),
      getBinaryBookParams() {
        return Promise.reject(new Error("The request took too long to respond"));
      }
    };
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const request = JSON.parse(rawBody) as { readonly id?: number };
      return Promise.resolve(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id ?? 1,
          result: encodeFunctionResult({
            abi: binaryPoolSetupAbi,
            functionName: "getOrderBookParameters",
            result: [1000n, 1000n, 1000n]
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));
    };
    try {
      const result = await readBinaryBookParams(timeoutClient, config, market.poolAddress);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.message);
      }
      expect(result.value).toEqual({
        tickSize: 1000n,
        minQuantity: 1000n,
        lotSize: 1000n
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);

  it("builds controlled-liquidity setup calldata without signing", async () => {
    const originalFetch = globalThis.fetch;
    const outcomeToken = "0x0000000000000000000000000000000000000e11";
    const collateral = "0x0000000000000000000000000000000000000f11";
    let callIndex = 0;
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
      callIndex += 1;
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const request = JSON.parse(rawBody) as { readonly id?: number };
      const results = [
        encodeFunctionResult({ abi: binaryPoolSetupAbi, functionName: "outcomeToken", result: outcomeToken }),
        encodeFunctionResult({ abi: binaryPoolSetupAbi, functionName: "collateralToken", result: collateral }),
        encodeFunctionResult({ abi: binaryPoolSetupAbi, functionName: "marketNonce", result: 58n })
      ];
      return Promise.resolve(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id ?? callIndex,
          result: results[callIndex - 1] ?? "0x"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));
    };
    try {
      const result = await buildControlledLiquidityEvidence(config, {
        makerAddress: "0x0000000000000000000000000000000000000d11",
        poolAddress: market.poolAddress,
        side: "SELL_YES",
        priceRaw: "600000",
        quantityRaw: "1000",
        expireTimestampNs: "1787570900000000000"
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.message);
      }
      expect(result.value.calls.map((call) => call.description)).toEqual([
        "Approve exact tUSDC amount for controlled liquidity mint",
        "Mint equal YES and NO outcome tokens for controlled testnet liquidity",
        "Allow the pool to escrow the selected outcome token for the maker sell order",
        "Place controlled post-only SELL_YES liquidity"
      ]);
      expect(result.value.collateral).toBe(collateral);
      expect(result.value.outcomeToken).toBe(outcomeToken);
      expect(result.value.outcomeId).toMatch(/^[0-9]+$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses complementary collateral pricing for deterministic BUY_NO approval calldata", async () => {
    const originalFetch = globalThis.fetch;
    const collateral = "0x0000000000000000000000000000000000000f11";
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const request = JSON.parse(rawBody) as { readonly id?: number };
      return Promise.resolve(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id ?? 1,
          result: encodeFunctionResult({ abi: binaryPoolSetupAbi, functionName: "collateralToken", result: collateral })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));
    };
    try {
      const client = { ...clientWith([market]), createTrader: undefined };
      const result = await buildUnsignedBinaryOrderEvidence(client, config, {
        ownerAddress: "0x0000000000000000000000000000000000000d11",
        poolAddress: market.poolAddress,
        side: "BUY_NO",
        priceRaw: "600000",
        quantityRaw: "25000",
        expireTimestampNs: "1787570900000000000",
        orderType: 2,
        quoteDecimals: 6
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.value.approval === null) {
        throw new Error("BUY_NO unsigned approval was unavailable");
      }
      const decoded = decodeFunctionData({ abi: erc20ApproveAbi, data: result.value.approval.data as `0x${string}` });
      expect(decoded.args).toEqual([market.poolAddress, 10_000n]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("replaces the SDK max allowance with an exact bounded escrow approval", async () => {
    const client: DreamDexSdkClient = {
      ...clientWith([market]),
      createTrader() {
        return {
          buildPlaceOrder() {
            return Promise.resolve({
              approval: {
                to: market.collateral,
                data: `0x${"ff".repeat(68)}`,
                value: 0n,
                description: "SDK max allowance"
              },
              order: {
                to: market.poolAddress,
                data: "0x1234",
                value: 0n,
                description: "SDK order"
              }
            });
          }
        } as unknown as ReturnType<NonNullable<DreamDexSdkClient["createTrader"]>>;
      }
    };
    const result = await buildUnsignedBinaryOrderEvidence(client, config, {
      ownerAddress: "0x0000000000000000000000000000000000000d11",
      poolAddress: market.poolAddress,
      side: "BUY_YES",
      priceRaw: "600000",
      quantityRaw: "16000",
      expireTimestampNs: "1787570900000000000",
      orderType: 2,
      quoteDecimals: 6,
      collateralAddress: market.collateral
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.approval === null) {
      throw new Error("Exact approval was unavailable");
    }
    const decoded = decodeFunctionData({ abi: erc20ApproveAbi, data: result.value.approval.data as `0x${string}` });
    expect(decoded.args).toEqual([market.poolAddress, 9_600n]);
    expect(result.value.order.data).toBe("0x1234");
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

describe("DREAMDEX-QUOTE-004 executable depth planning", () => {
  const base = {
    requestedQuantityRaw: "1000000",
    lotSizeRaw: "100000",
    tickSizeRaw: "10000",
    payoutScaleRaw: "1000000",
    maxCollateralRaw: "1000000",
    worstPriceRaw: "650000",
    sideProbabilityPpm: 600000
  } as const;

  it("walks sorted levels, respects lots and reports partial depth", () => {
    const result = planExecutableQuote({ ...base, levels: [
      { priceRaw: "520000", quantityRaw: "250000" },
      { priceRaw: "500000", quantityRaw: "400000" }
    ] });
    expect(result.levelsConsumed).toEqual([
      { priceRaw: "500000", quantityRaw: "400000" },
      { priceRaw: "520000", quantityRaw: "200000" }
    ]);
    expect(result.fillableQuantityRaw).toBe("600000");
    expect(result.reasonCodes).toContain("PARTIAL_DEPTH_REQUIRES_REVIEW");
  });

  it("rejects p=.60 at .64 and allows the simplified .50 boundary case", () => {
    const expensive = planExecutableQuote({ ...base, levels: [{ priceRaw: "640000", quantityRaw: "1000000" }] });
    expect(expensive.passesConservativeEdge).toBe(false);
    expect(expensive.reasonCodes).toContain("CONSERVATIVE_EDGE_NOT_POSITIVE");
    const viable = planExecutableQuote({ ...base, worstPriceRaw: "500000", levels: [{ priceRaw: "500000", quantityRaw: "1000000" }] });
    expect(viable.passesConservativeEdge).toBe(true);
  });

  it("works with 18-decimal raw units without floating point token math", () => {
    const result = planExecutableQuote({
      ...base,
      levels: [{ priceRaw: "500000000000000000", quantityRaw: "2000000000000000000" }],
      requestedQuantityRaw: "2000000000000000000",
      lotSizeRaw: "100000000000000000",
      tickSizeRaw: "10000000000000000",
      payoutScaleRaw: "1000000000000000000",
      maxCollateralRaw: "1000000000000000000",
      worstPriceRaw: "500000000000000000"
    });
    expect(result.totalCollateralRaw).toBe("1000000000000000000");
    expect(result.fillableQuantityRaw).toBe("2000000000000000000");
  });

  it("stops at the reviewed price and collateral caps while preserving the lot grid", () => {
    const result = planExecutableQuote({
      ...base,
      maxCollateralRaw: "260000",
      worstPriceRaw: "520000",
      levels: [
        { priceRaw: "500000", quantityRaw: "300000" },
        { priceRaw: "520000", quantityRaw: "500000" },
        { priceRaw: "530000", quantityRaw: "500000" }
      ]
    });
    expect(result.levelsConsumed).toEqual([{ priceRaw: "500000", quantityRaw: "300000" }, { priceRaw: "520000", quantityRaw: "200000" }]);
    expect(result.fillableQuantityRaw).toBe("500000");
    expect(BigInt(result.totalCollateralRaw)).toBeLessThanOrEqual(260000n);
    expect(BigInt(result.fillableQuantityRaw) % 100000n).toBe(0n);
  });

  it("fails closed for off-tick source levels", () => {
    expect(() => planExecutableQuote({
      ...base,
      levels: [{ priceRaw: "500001", quantityRaw: "1000000" }]
    })).toThrow(/tick grid/);
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

  it("resolves later cutoff blocks from a previous chronological lower-bound hint", async () => {
    const requestedTags: string[] = [];
    const rpcFetch: HistoricalRpcFetch = (_input, init) => {
      const request = JSON.parse(init.body) as {
        readonly id: number;
        readonly params: readonly [string, boolean];
      };
      const tag = request.params[0];
      requestedTags.push(tag);
      const blockNumber = tag === "finalized" ? 100 : Number(BigInt(tag));
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
              timestamp: `0x${(1000 + blockNumber).toString(16)}`
            }
          })
      });
    };

    const first = await resolveHistoricalCutoffBlock(mainnetHistoricalConfig, 1050, rpcFetch);
    expect(first).toMatchObject({ ok: true, value: { blockNumber: "49", timestampSeconds: 1049 } });
    requestedTags.length = 0;

    if (!first.ok) {
      throw new Error("first cutoff did not resolve");
    }
    const hinted = await resolveHistoricalCutoffBlockAfter(mainnetHistoricalConfig, 1060, first.value, rpcFetch);

    expect(hinted).toMatchObject({ ok: true, value: { blockNumber: "59", timestampSeconds: 1059 } });
    expect(requestedTags).not.toContain("0x0");
    expect(requestedTags).toEqual(expect.arrayContaining(["finalized", "0x32", "0x3b"]));
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
