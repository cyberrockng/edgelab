import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "@edgelab/server";
import { createPool, runMigrations } from "@edgelab/db";
import type { RuntimeConfig } from "@edgelab/config";
import { LoginChallengeSchema, type SignatureVerifier } from "@edgelab/auth";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import type {
  DreamDexSdkClient,
  HistoricalDreamDexSdkClient,
  HistoricalIndexerFetch,
  HistoricalRpcFetch
} from "@edgelab/dreamdex";
import { z } from "zod";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab";

const pool = createPool({ connectionString, max: 4, statementTimeoutMs: 5000 });
const account = `0x${"7".repeat(40)}`;

const config: RuntimeConfig = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: connectionString,
  PUBLIC_APP_URL: "http://localhost:3000",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  SOMNIA_CHAIN_ID: 50312,
  SOMNIA_RPC_URL: "https://api.infra.testnet.somnia.network/",
  SOMNIA_WS_RPC_URL: "wss://api.infra.testnet.somnia.network/ws",
  DREAMDEX_INDEXER_URL: "https://dev.smk.somnia.host/v1/graphql",
  SOMNIA_MAINNET_CHAIN_ID: 5031,
  SOMNIA_MAINNET_RPC_URL: "https://api.infra.mainnet.somnia.network",
  DREAMDEX_MAINNET_INDEXER_URL: "https://prd.smk.somnia.host/v1/graphql",
  MARKETS_SDK_VERSION: "0.28.1",
  WORKER_ENABLED: false,
  LOG_LEVEL: "error",
  BUILD_COMMIT: "api-test"
};

const verifier: SignatureVerifier = {
  verify(input) {
    expect(input.address).toBe(account);
    expect(input.message).toContain("Sign in to EdgeLab");
    return Promise.resolve(input.signature === "0xsigned");
  }
};
const ChallengeResponseSchema = z.object({
  ok: z.literal(true),
  challenge: LoginChallengeSchema
});
const V2CapabilitiesSchema = z.object({
  data: z.object({
    planes: z.array(
      z.object({
        id: z.string(),
        chainId: z.number(),
        writePolicy: z.string()
      })
    ),
    dreamDex: z.object({
      historicalBookReconstruction: z.string()
    })
  })
});
const V2PoliciesSchema = z.object({
  data: z.object({
    policies: z.array(
      z.object({
        policyId: z.string(),
        version: z.string(),
        label: z.string(),
        adapterName: z.string(),
        sourceHash: z.string(),
        implementationHash: z.string(),
        parameters: z.record(z.string(), z.unknown()),
        supportedPlanes: z.array(z.enum(["MAINNET_HISTORICAL", "SHANNON_FORWARD"])),
        description: z.string()
      })
    )
  })
});
const V2ProofSchema = z.object({
  data: z.object({
    proof: z.object({
      evidenceId: z.literal("EXG-003"),
      status: z.literal("VERIFIED"),
      network: z.object({ chainId: z.literal(50312) }),
      lifecycle: z.array(z.object({ state: z.string(), title: z.string(), detail: z.string() })),
      order: z.object({
        orderId: z.string(),
        fillStatus: z.literal("NO_FILL"),
        terminalEvent: z.literal("OrderExpired")
      }),
      reconciliation: z.object({
        fillObserved: z.literal(false),
        fillRequired: z.literal(false),
        collateralReconciled: z.literal(true),
        unexpectedOpenOrder: z.literal(false),
        selfTrade: z.literal(false),
        fakeVolume: z.literal(false),
        pnlStatus: z.literal("NOT_AVAILABLE")
      }),
      technical: z.array(z.object({ label: z.string(), value: z.string(), href: z.string().nullable() }))
    })
  }),
  meta: z.object({
    sourcePlane: z.literal("SHANNON_EXECUTION"),
    blockchainWrite: z.literal(false)
  })
});
const V2ProvenExperimentSchema = z.object({
  data: z.object({
    provenExperiment: z.object({
      slug: z.literal("proven-experiment"),
      status: z.literal("PUBLIC_PROVEN"),
      selectionDisclosure: z.string(),
      source: z.object({
        plane: z.literal("MAINNET_HISTORICAL"),
        chainId: z.literal(5031),
        writePolicy: z.literal("read-only-no-mainnet-signer")
      }),
      replay: z.object({
        status: z.enum(["COMPLETED", "SUCCEEDED"]),
        processedCount: z.number(),
        scoredCount: z.number(),
        excludedCount: z.number(),
        blockchainWrite: z.literal(false)
      }),
      decision: z.object({
        marketId: z.string(),
        action: z.string(),
        forecastPUp: z.number().nullable(),
        outcomeResult: z.string().nullable(),
        frameHash: z.string(),
        reasonCodes: z.array(z.string())
      }),
      assessment: z.object({
        verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
        sampleSize: z.number(),
        pnlStatus: z.literal("NOT_AVAILABLE")
      }),
      evidenceGate: z.object({
        serverAuthored: z.literal(true),
        decision: z.object({
          verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
          reason: z.string(),
          missingEvidence: z.array(z.string()),
          nextPermittedAction: z.string(),
          doesNotAuthorize: z.array(z.string()),
          promotionScope: z.string()
        }),
        progression: z.object({
          stages: z.array(z.object({ stage: z.string(), plane: z.string(), status: z.string(), detail: z.string() }))
        }),
        verdictReasons: z.array(z.string()),
        gateRows: z.array(z.object({ dimension: z.string(), status: z.string(), value: z.string() }))
      }),
      reproducibility: z.object({
        sourceArtifacts: z.array(z.string()),
        replayOutputHash: z.string(),
        inputHash: z.string(),
        assessmentHash: z.string(),
        exportPath: z.literal("evidence/proven/manifest.json")
      })
    })
  }),
  meta: z.object({
    publicProven: z.literal(true),
    blockchainWrite: z.literal(false)
  })
});
const V2HistoricalPageSchema = z.object({
  data: z.object({
    markets: z.array(z.object({ stableMarketId: z.string() }))
  }),
  meta: z.object({
    page: z.object({ limit: z.number(), offset: z.number() }),
    hasMore: z.boolean(),
    source: z.object({ plane: z.string() })
  })
});
const V2ExperimentReportSchema = z.object({
  data: z.object({
    report: z.object({
      title: z.string(),
      exportPolicy: z.object({
        sanitized: z.literal(true),
        blockchainWrite: z.literal(false),
        privateSecretsIncluded: z.literal(false)
      }),
      boundaries: z.object({
        mainnet: z.literal("READ_ONLY_HISTORICAL_RESEARCH"),
        shannonForward: z.literal("PRE_OUTCOME_LIVE_SHADOW_OBSERVATION"),
        shannonExecution: z.literal("HUMAN_AUTHORIZED_TESTNET_EXECUTION_ONLY")
      }),
      executionProofRelationship: z.object({
        plane: z.literal("SHANNON_EXECUTION"),
        proofRoute: z.literal("/proof")
      })
    })
  }),
  meta: z.object({
    reportType: z.literal("sanitized-experiment-report"),
    blockchainWrite: z.literal(false)
  })
});
const V2LiveMarketsSchema = z.object({
  data: z.object({
    markets: z.array(
      z.object({
        source: z.object({ chainId: z.number() })
      })
    )
  }),
  meta: z.object({ plane: z.string() })
});
const V2SessionSchema = z.object({
  data: z.object({
    session: z.object({
      id: z.string().uuid(),
      expiresAt: z.string(),
      csrfVersion: z.number()
    }),
    csrfToken: z.string().min(32)
  })
});
const V2ExperimentSchema = z.object({
  data: z.object({
    experiment: z.object({
      experimentId: z.string().uuid(),
      name: z.string(),
      configuration: z.object({
        mode: z.string(),
        assets: z.array(z.string()),
        intervals: z.array(z.number()),
        config: z.object({
          sourcePlane: z.string(),
          selectedMarketId: z.string().nullable().optional(),
          windowFrom: z.string().nullable().optional(),
          windowTo: z.string().nullable().optional(),
          decisionOffsetSec: z.number().optional(),
          decisionBoundaryRule: z.string().optional(),
          historicalBookReconstruction: z.string(),
          pnlStatus: z.string()
        })
      }),
      policies: z.array(z.object({ policyId: z.string(), version: z.string(), role: z.string() }))
    }),
    idempotentReplay: z.boolean().optional()
  })
});
const V2ReplaySchema = z.object({
  data: z.object({
    replay: z
      .object({
        id: z.string().uuid(),
        status: z.string(),
        selectedCount: z.number(),
        processedCount: z.number(),
        scoredCount: z.number(),
        excludedCount: z.number(),
        errorCode: z.string().nullable(),
        outputHash: z.string().nullable(),
        decisions: z
          .array(
            z.object({
              marketId: z.string(),
              action: z.string(),
              forecastPUp: z.number().nullable(),
              outcomeResult: z.string().nullable(),
              frameHash: z.string()
            })
          )
          .optional()
      })
      .nullable(),
    idempotentReplay: z.boolean().optional()
  })
});
const V2AssessmentSchema = z.object({
  data: z.object({
    assessment: z.object({
      verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
      reasonCodes: z.array(z.string()),
      sampleSize: z.number(),
      exclusionCount: z.number(),
      pnlStatus: z.enum(["NOT_AVAILABLE", "AVAILABLE"]),
      metricRunId: z.string().uuid(),
      assessmentId: z.string().uuid()
    })
  })
});
const V2LatestAssessmentSchema = z.object({
  data: z.object({
    assessment: V2AssessmentSchema.shape.data.shape.assessment.nullable()
  })
});
const V2EvidenceGateSchema = z.object({
  data: z.object({
    evidence: z
      .object({
        experimentId: z.string().uuid(),
        assessment: z.object({
          assessmentId: z.string().uuid(),
          verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
          sampleSize: z.number(),
          evidencePlane: z.string(),
          promotionScope: z.string(),
          pnlStatus: z.string()
        }),
        decision: z.object({
          verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
          reason: z.string(),
          supportingEvidence: z.array(z.string()),
          missingEvidence: z.array(z.string()),
          nextPermittedAction: z.string(),
          doesNotAuthorize: z.array(z.string()),
          sourcePlane: z.string(),
          promotionScope: z.string(),
          decidedAt: z.string()
        }),
        progression: z.object({
          candidateId: z.string(),
          currentStage: z.string(),
          stages: z.array(z.object({ stage: z.string(), plane: z.string(), status: z.string(), detail: z.string() }))
        }),
        gateRows: z.array(
          z.object({
            dimension: z.string(),
            status: z.string(),
            value: z.string(),
            detail: z.string()
          })
        ),
        missingEvidence: z.array(z.string()),
        verdictReasons: z.array(z.string()),
        nextPermittedAction: z.string(),
        serverAuthored: z.literal(true)
      })
      .nullable(),
    state: z.string(),
    message: z.string()
  })
});
const V2LiveShadowSchema = z.object({
  data: z.object({
    observation: z
      .object({
        leaseAcquired: z.boolean(),
        discoveredMarketCount: z.number(),
        observed: z.array(
          z.object({
            marketId: z.string(),
            insertedDecisionCount: z.number(),
            reusedDecisionCount: z.number(),
            skipped: z.boolean()
          })
        )
      })
      .optional(),
    liveShadow: z.object({
      episodeCount: z.number(),
      snapshotCount: z.number(),
      decisionCount: z.number(),
      sourcePlane: z.literal("SHANNON_FORWARD"),
      blockchainWrite: z.literal(false)
    })
  })
});
const V2AssessmentListSchema = z.object({
  data: z.object({
    assessments: z.array(
      z.object({
        assessmentId: z.string().uuid(),
        experimentName: z.string(),
        verdict: z.string(),
        sampleSize: z.number(),
        evidencePlane: z.string(),
        pnlStatus: z.string()
      })
    ),
    csrfToken: z.string().optional()
  })
});
const V2ComparisonSchema = z.object({
  data: z.object({
    comparison: z.object({
      comparisonId: z.string().uuid(),
      name: z.string(),
      items: z.array(
        z.object({
          assessmentId: z.string().uuid(),
          displayOrder: z.number(),
          verdict: z.string(),
          sampleSize: z.number(),
          evidencePlane: z.string(),
          pnlStatus: z.string()
        })
      )
    })
  })
});
const V2ComparisonListSchema = z.object({
  data: z.object({
    comparisons: z.array(
      z.object({
        comparisonId: z.string().uuid(),
        name: z.string(),
        itemCount: z.number()
      })
    ),
    csrfToken: z.string().optional()
  })
});
const apiMarketId = `0x${"9".repeat(61)}abc`;

const binaryMarket: BinaryMarket = {
  id: "0xapi-market",
  marketType: "BINARY",
  poolAddress: "0x0000000000000000000000000000000000000a99",
  lastPrice: null,
  lastTradeAt: null,
  cumulativeBaseVolume: "0",
  cumulativeQuoteVolume: "0",
  tradeCount: "4",
  baseDecimals: 6,
  quoteDecimals: 6,
  createdAtTimestamp: "1787570000",
  marketId: apiMarketId,
  marketAddress: "0x0000000000000000000000000000000000000b99",
  yesTokenId: "1",
  noTokenId: "2",
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  asset: "BTC",
  question: "Will BTC close up?",
  status: "Finalized",
  oracleQuestion: "BTC up?",
  oracleQuestionId: "1",
  strike: "100000",
  tradingStart: "1787566400",
  expiry: "1787570000",
  winningOutcome: 0,
  payoutNumerators: null,
  payoutDenominator: null,
  resolvedAtBlock: null,
  resolvedAtTimestamp: null,
  createdByTx: null,
  creator: null,
  voided: false,
  backing: "0",
  nonce: "58",
  finalized: true,
  netBacking: null,
  context: "0x",
  intervalSec: "3600",
  interval: "1h",
  operatorId: 1,
  venueId: "0x4d41494e"
};

function historicalClient(): HistoricalDreamDexSdkClient {
  return {
    countBinaryMarkets() {
      return Promise.resolve(4);
    },
    listPastBinaryMarkets(opts) {
      return Promise.resolve([
        binaryMarket,
        { ...binaryMarket, marketId: `0x${"8".repeat(61)}abc` }
      ].slice(0, opts?.limit ?? 25));
    },
    getBinaryMarket(id) {
      return Promise.resolve(id.toLowerCase() === apiMarketId.toLowerCase() ? binaryMarket : null);
    },
    getMarketResolution() {
      return Promise.resolve({
        events: [{ status: "Resolved" }],
        reference: null,
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
    getCandles() {
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
  };
}

function paginatedHistoricalClient(): HistoricalDreamDexSdkClient {
  const fillerMarkets = Array.from({ length: 101 }, (_, index): BinaryMarket => ({
    ...binaryMarket,
    marketId: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    id: `filler-${String(index)}`,
    tradingStart: "1787500000",
    expiry: "1787503600"
  }));
  return {
    ...historicalClient(),
    listPastBinaryMarkets(opts) {
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? 25;
      const rows = [...fillerMarkets, binaryMarket];
      return Promise.resolve(rows.slice(offset, offset + limit));
    }
  };
}

function duplicateHistoricalMarketClient(): HistoricalDreamDexSdkClient {
  return {
    ...historicalClient(),
    listPastBinaryMarkets() {
      return Promise.resolve([binaryMarket, binaryMarket]);
    }
  };
}

function liveClient(): DreamDexSdkClient {
  return {
    listLiveBinaryMarkets() {
      return Promise.resolve([{ ...binaryMarket, status: "Trading", finalized: false, winningOutcome: null }]);
    },
    getBinaryBookParams() {
      return Promise.resolve({ tickSize: 1000n, lotSize: 1000n, minQuantity: 1000n });
    },
    getLiveBinaryOrderBookByMarket() {
      return { yesBids: [], yesAsks: [], noBids: [], noAsks: [] };
    },
    getBinaryMarket() {
      return Promise.resolve(binaryMarket);
    }
  };
}

function futureLiveClient(): DreamDexSdkClient {
  const future = { ...binaryMarket, status: "Trading", finalized: false, winningOutcome: null, expiry: "4102444800" };
  return {
    listLiveBinaryMarkets() {
      return Promise.resolve([future]);
    },
    getBinaryBookParams() {
      return Promise.resolve({ tickSize: 1000n, lotSize: 1000n, minQuantity: 1000n });
    },
    getLiveBinaryOrderBookByMarket() {
      return { yesBids: [{ price: 1000n, quantity: 2000n }], yesAsks: [], noBids: [], noAsks: [] };
    },
    getBinaryMarket() {
      return Promise.resolve(future);
    }
  };
}

const historicalIndexerFetch: HistoricalIndexerFetch = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: {
          Order: [
            {
              id: "order-1",
              orderId: "101",
              market_id: apiMarketId,
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
            }
          ],
          Fill: [
            {
              id: "fill-1",
              market_id: apiMarketId,
              pool: binaryMarket.poolAddress,
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
              timestamp: "1787569500",
              blockNumber: "90",
              logIndex: 3,
              txHash: "0xfill"
            }
          ]
        }
      })
  });

const historicalRpcFetch: HistoricalRpcFetch = (_input, init) => {
  const request = JSON.parse(init.body) as { readonly id: number };
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          number: "0x64",
          hash: `0x${"a".repeat(64)}`,
          timestamp: `0x${(1787569940 - 1).toString(16)}`
        }
      })
  });
};

function v2Deps() {
  return {
    dreamDexClient: liveClient(),
    dreamDexConfig: {
      rpcUrl: config.SOMNIA_RPC_URL,
      wsRpcUrl: config.SOMNIA_WS_RPC_URL,
      indexerUrl: config.DREAMDEX_INDEXER_URL,
      chainId: config.SOMNIA_CHAIN_ID,
      sdkVersion: config.MARKETS_SDK_VERSION
    },
    historicalDreamDexClient: historicalClient(),
    historicalDreamDexConfig: {
      rpcUrl: config.SOMNIA_MAINNET_RPC_URL,
      indexerUrl: config.DREAMDEX_MAINNET_INDEXER_URL,
      chainId: config.SOMNIA_MAINNET_CHAIN_ID,
      sdkVersion: config.MARKETS_SDK_VERSION
    },
    historicalIndexerFetch,
    historicalRpcFetch
  };
}

function cookieHeader(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function resetPublicSchema(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

describe("API-001 server contracts", () => {
  beforeAll(async () => {
    await resetPublicSchema();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("exposes health, readiness, and product invariants", async () => {
    const app = buildApp(config, { pool });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    const invariants = await app.inject({ method: "GET", url: "/api/v1/invariants" });
    await app.close();

    expect(health.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, database: "ok", chainId: 50312 });
    expect(invariants.json()).toMatchObject({
      boundaries: {
        serviceSignsTransactions: false,
        fabricatedFills: false,
        pnlWithoutFillAndSettlement: false
      }
    });
  });

  it("creates wallet challenges and rejects nonce replay", async () => {
    const app = buildApp(config, { consumedNonces: new Set(), signatureVerifier: verifier });
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      payload: { purpose: "login", account }
    });
    const challengeBody = ChallengeResponseSchema.parse(challengeResponse.json());
    const firstVerify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { challenge: challengeBody.challenge, signature: "0xsigned", account }
    });
    const replayVerify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { challenge: challengeBody.challenge, signature: "0xsigned", account }
    });
    await app.close();

    expect(challengeResponse.statusCode).toBe(200);
    expect(challengeBody.challenge.statement).toBe("Sign in to EdgeLab. This does not authorize a transaction.");
    expect(firstVerify.statusCode).toBe(200);
    expect(replayVerify.statusCode).toBe(401);
    expect(replayVerify.json()).toMatchObject({ reasonCode: "NONCE_REPLAYED" });
  });

  it("disables the obsolete global settlement mutation", async () => {
    const app = buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/settlements/reconcile"
    });
    await app.close();

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      ok: false,
      reasonCode: "LEGACY_MUTATION_GONE"
    });
  });

  it("summarizes public evidence without exposing internal operational counts", async () => {
    const app = buildApp(config, { pool });
    const response = await app.inject({ method: "GET", url: "/api/v1/evidence/summary" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      summary: {
        publicProofAvailable: false,
        latestTerminalState: "UNAVAILABLE",
        fillCount: 0,
        evidenceScope: "judge-facing public proof only"
      },
      chain: {
        submittedOrderCount: 0,
        fillCount: 0,
        terminalOrderCount: 0,
        openOrderCount: 0,
        latestTerminalState: null,
        tradeabilityStatus: "NOT_EVALUATED"
      }
    });
  });

  it("exposes v2 capabilities and policy metadata without signer capability", async () => {
    const app = buildApp(config, v2Deps());
    const capabilities = await app.inject({ method: "GET", url: "/api/v2/capabilities" });
    const policies = await app.inject({ method: "GET", url: "/api/v2/policies" });
    await app.close();

    expect(capabilities.statusCode).toBe(200);
    const capabilitiesBody = V2CapabilitiesSchema.parse(capabilities.json());
    expect(capabilitiesBody.data.planes).toContainEqual(
      expect.objectContaining({
        id: "MAINNET_HISTORICAL",
        chainId: 5031,
        writePolicy: "read-only-no-mainnet-signer"
      })
    );
    expect(capabilitiesBody.data.dreamDex.historicalBookReconstruction).toBe("SOURCE_INCOMPLETE");
    expect(policies.statusCode).toBe(200);
    const policiesBody = V2PoliciesSchema.parse(policies.json());
    expect(policiesBody.data.policies).toContainEqual(
      expect.objectContaining({ policyId: "reference-neutral", version: "1.0.0" })
    );
    expect(policiesBody.data.policies).toContainEqual(
      expect.objectContaining({ policyId: "historical-last-trade", version: "1.0.0" })
    );
    expect(policiesBody.data.policies).toContainEqual(
      expect.objectContaining({ policyId: "historical-last-trade", version: "1.1.0" })
    );
  });

  it("serves EXG-003 proof as Shannon execution evidence without fill or cancelled/profit drift", async () => {
    const app = buildApp(config, v2Deps());
    const proof = await app.inject({ method: "GET", url: "/api/v2/proof/exg-003" });
    const body = V2ProofSchema.parse(proof.json());
    await app.close();

    expect(proof.statusCode).toBe(200);
    expect(body.data.proof.lifecycle.map((row) => row.state)).toEqual(
      expect.arrayContaining(["VERIFIED", "SUBMITTED", "NO FILL", "EXPIRED", "RECONCILED"])
    );
    expect(JSON.stringify(body.data.proof)).toContain("OrderExpired");
    expect(body.data.proof.order.terminalEvent).toBe("OrderExpired");
    expect(body.data.proof.lifecycle.find((row) => row.state === "EXPIRED")?.detail).toContain("not OrderCancelled");
    expect(body.data.proof.technical.map((row) => row.label)).toEqual(
      expect.arrayContaining(["Approval", "Order", "Terminal", "Order ID"])
    );
  });

  it("serves a reproducible public Proven Experiment from captured real replay evidence", async () => {
    const app = buildApp(config, v2Deps());
    const list = await app.inject({ method: "GET", url: "/api/v2/proven-experiments" });
    const detail = await app.inject({ method: "GET", url: "/api/v2/proven-experiments/proven-experiment" });
    const report = await app.inject({ method: "GET", url: "/api/v2/proven-experiments/proven-experiment/report" });
    const body = V2ProvenExperimentSchema.parse(detail.json());
    const reportBody = V2ExperimentReportSchema.parse(report.json());
    await app.close();

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      data: {
        provenExperiments: [
          expect.objectContaining({
            slug: "proven-experiment",
            verdict: "PROMOTE_TO_FORWARD_OBSERVATION",
            route: "/lab/proven-experiment"
          })
        ]
      }
    });
    expect(detail.statusCode).toBe(200);
    expect(report.statusCode).toBe(200);
    expect(reportBody.data.report.title).toBe("EdgeLab Proven Experiment Report");
    expect(reportBody.data.report.executionProofRelationship.proofRoute).toBe("/proof");
    expect(body.data.provenExperiment.selectionDisclosure).toContain("source completeness");
    expect(body.data.provenExperiment.selectionDisclosure).toContain("not for a favorable verdict");
    expect(body.data.provenExperiment.replay).toMatchObject({
      processedCount: 97,
      scoredCount: 36,
      excludedCount: 61,
      blockchainWrite: false
    });
    expect(body.data.provenExperiment.decision.forecastPUp).toBeGreaterThanOrEqual(0);
    expect(body.data.provenExperiment.decision.reasonCodes).toContain("DREAMDEX_YES_TERM_PRICE");
    expect(body.data.provenExperiment.assessment).toMatchObject({
      verdict: "PROMOTE_TO_FORWARD_OBSERVATION",
      sampleSize: 36,
      pnlStatus: "NOT_AVAILABLE"
    });
    expect(body.data.provenExperiment.evidenceGate.verdictReasons).toContain("PROMOTE_TO_FORWARD_OBSERVATION");
    expect(
      body.data.provenExperiment.evidenceGate.gateRows.find(
        (row) => row.dimension === "Tradeability / execution quality"
      )
    ).toMatchObject({
      status: "NOT_AVAILABLE",
      value: "NOT_AVAILABLE"
    });
    expect(body.data.provenExperiment.evidenceGate.decision.nextPermittedAction).toBe("START_FORWARD_OBSERVATION");
    expect(body.data.provenExperiment.evidenceGate.decision.promotionScope).toBe("PROMOTE_TO_FORWARD_OBSERVATION");
    expect(
      body.data.provenExperiment.evidenceGate.progression.stages.find((stage) => stage.stage === "Execution Proof")
    ).toMatchObject({ status: "UNLINKED_GLOBAL_PROOF_AVAILABLE" });
    expect(body.data.provenExperiment.reproducibility.sourceArtifacts).toEqual(
      expect.arrayContaining(["evidence/replay/replay-002-report.json", "evidence/evaluate/eval-002-report.json"])
    );
  });

  it("serves bounded historical market pages and count envelopes", async () => {
    const app = buildApp(config, v2Deps());
    const count = await app.inject({ method: "GET", url: "/api/v2/mainnet/history/markets/count?asset=BTC" });
    const page = await app.inject({
      method: "GET",
      url: "/api/v2/mainnet/history/markets?asset=BTC&status=Finalized&limit=1&offset=0"
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/v2/mainnet/history/markets?limit=101"
    });
    await app.close();

    expect(count.statusCode).toBe(200);
    expect(count.json()).toMatchObject({ data: { count: 4, countRelation: "EXACT" } });
    expect(page.statusCode).toBe(200);
    const pageBody = V2HistoricalPageSchema.parse(page.json());
    expect(pageBody.data.markets[0]?.stableMarketId).toBe(apiMarketId.toLowerCase());
    expect(pageBody.meta.page).toEqual({ limit: 1, offset: 0 });
    expect(pageBody.meta.hasMore).toBe(true);
    expect(pageBody.meta.source.plane).toBe("MAINNET_HISTORICAL");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "DREAMDEX_HISTORICAL_BOUNDS_INVALID", retryable: false }
    });
  });

  it("serves historical market detail, resolution, lifecycle, candles, orders, and fills", async () => {
    const app = buildApp(config, v2Deps());
    const detail = await app.inject({ method: "GET", url: `/api/v2/mainnet/history/markets/${apiMarketId}` });
    const resolution = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/resolution`
    });
    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/status-history`
    });
    const candles = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/candles?intervalSeconds=3600&limit=1`
    });
    const orders = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/orders?limit=1`
    });
    const fills = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/fills?limit=1`
    });
    await app.close();

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ data: { market: { stableMarketId: apiMarketId.toLowerCase() } } });
    expect(resolution.statusCode).toBe(200);
    expect(resolution.json()).toMatchObject({ meta: { usage: "display-only-not-policy-input" } });
    expect(lifecycle.statusCode).toBe(200);
    expect(lifecycle.json()).toMatchObject({ data: { statusHistory: [expect.objectContaining({ newStatus: "Resolved" })] } });
    expect(candles.statusCode).toBe(200);
    expect(candles.json()).toMatchObject({ data: { candles: [expect.objectContaining({ closePriceRaw: "105" })] } });
    expect(orders.statusCode).toBe(200);
    expect(orders.json()).toMatchObject({ data: { orders: [expect.objectContaining({ remainingQuantityRaw: "750000" })] } });
    expect(fills.statusCode).toBe(200);
    expect(fills.json()).toMatchObject({ data: { fills: [expect.objectContaining({ fillPriceRaw: "10100" })] } });
  });

  it("keeps reconstructed historical book endpoint fail-closed", async () => {
    const app = buildApp(config, v2Deps());
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/reconstructed-book?atBlock=100`
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "DREAMDEX_HISTORICAL_CAPABILITY_UNVERIFIED",
        retryable: false,
        details: {
          capability: "SOURCE_INCOMPLETE",
          nativeStoredSnapshots: false
        }
      }
    });
  });

  it("exposes v2 Shannon live markets with forward provenance", async () => {
    const app = buildApp(config, v2Deps());
    const response = await app.inject({ method: "GET", url: "/api/v2/shannon/markets/live" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const responseBody = V2LiveMarketsSchema.parse(response.json());
    expect(responseBody.data.markets[0]?.source.chainId).toBe(50312);
    expect(responseBody.meta.plane).toBe("SHANNON_FORWARD");
  });

  it("creates and reloads session-owned experiments without wallet access", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const payload = {
      name: "Judge BTC hourly replay",
      mode: "HISTORICAL_REPLAY",
      asset: "BTC",
      intervalSec: 3600,
      policyId: "historical-last-trade",
      policyVersion: "1.1.0",
      marketId: apiMarketId,
      riskEnvelopeId: "WATCH_ONLY_BOUNDED"
    };
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-judge-btc"
      },
      payload
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-judge-btc"
      },
      payload
    });
    const mismatch = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-judge-btc"
      },
      payload: { ...payload, name: "Changed body replay" }
    });
    const createBody = V2ExperimentSchema.parse(create.json());
    const duplicateBody = V2ExperimentSchema.parse(duplicate.json());
    const detail = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${createBody.data.experiment.experimentId}`,
      headers: { cookie: cookies }
    });
    const otherSession = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const denied = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${createBody.data.experiment.experimentId}`,
      headers: { cookie: cookieHeader(otherSession) }
    });
    await app.close();

    expect(session.statusCode).toBe(200);
    expect(create.statusCode).toBe(201);
    expect(createBody.data.experiment.name).toBe("Judge BTC hourly replay");
    expect(createBody.data.experiment.configuration.config.sourcePlane).toBe("MAINNET_HISTORICAL");
    expect(createBody.data.experiment.configuration.config.decisionOffsetSec).toBe(60);
    expect(createBody.data.experiment.configuration.config.decisionBoundaryRule).toContain("expiry - decisionOffsetSec");
    expect(createBody.data.experiment.configuration.config.historicalBookReconstruction).toBe("SOURCE_INCOMPLETE");
    expect(createBody.data.experiment.configuration.config.pnlStatus).toBe("NOT_AVAILABLE");
    expect(createBody.data.experiment.policies[0]).toMatchObject({
      policyId: "historical-last-trade",
      version: "1.1.0",
      role: "CANDIDATE"
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicateBody.data.idempotentReplay).toBe(true);
    expect(duplicateBody.data.experiment.experimentId).toBe(createBody.data.experiment.experimentId);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: { code: "IDEMPOTENCY_BODY_MISMATCH" } });
    expect(detail.statusCode).toBe(200);
    expect(V2ExperimentSchema.parse(detail.json()).data.experiment.experimentId).toBe(
      createBody.data.experiment.experimentId
    );
    expect(denied.statusCode).toBe(404);
  });

  it("rejects ambiguous or negative historical decision offsets", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const headers = {
      cookie: cookieHeader(session),
      "x-csrf-token": sessionBody.data.csrfToken
    };
    const basePayload = {
      name: "Offset validation replay",
      mode: "HISTORICAL_REPLAY",
      asset: "BTC",
      intervalSec: 3600,
      policyId: "historical-last-trade",
      policyVersion: "1.1.0",
      marketId: apiMarketId,
      riskEnvelopeId: "WATCH_ONLY_BOUNDED"
    };
    const zero = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: { ...headers, "idempotency-key": "api-offset-zero" },
      payload: { ...basePayload, decisionOffsetSec: 0 }
    });
    const negative = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: { ...headers, "idempotency-key": "api-offset-negative" },
      payload: { ...basePayload, decisionOffsetSec: -60 }
    });
    const positive = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: { ...headers, "idempotency-key": "api-offset-positive" },
      payload: { ...basePayload, decisionOffsetSec: 60 }
    });
    await app.close();

    expect(zero.statusCode).toBe(400);
    expect(negative.statusCode).toBe(400);
    expect(positive.statusCode).toBe(201);
    expect(V2ExperimentSchema.parse(positive.json()).data.experiment.configuration.config.decisionOffsetSec).toBe(60);
  });

  it("fails explicit historical replay when market overlaps but decision time is outside the configured window", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookieHeader(session),
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-explicit-outside-window-create"
      },
      payload: {
        name: "Explicit outside window",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        marketId: apiMarketId,
        windowFrom: "2026-08-24T10:00:00.000Z",
        windowTo: "2026-08-24T10:20:00.000Z",
        decisionOffsetSec: 60,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const created = V2ExperimentSchema.parse(create.json());
    const replay = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${created.data.experiment.experimentId}/replay`,
      headers: {
        cookie: cookieHeader(session),
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-explicit-outside-window-replay"
      }
    });
    let replayReload = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${created.data.experiment.experimentId}/replay`,
      headers: { cookie: cookieHeader(session) }
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = V2ReplaySchema.parse(replayReload.json()).data.replay;
      if (current?.status === "FAILED") {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      replayReload = await app.inject({
        method: "GET",
        url: `/api/v2/experiments/${created.data.experiment.experimentId}/replay`,
        headers: { cookie: cookieHeader(session) }
      });
    }
    await app.close();

    expect(create.statusCode).toBe(201);
    expect(replay.statusCode).toBe(202);
    const latest = V2ReplaySchema.parse(replayReload.json()).data.replay;
    expect(latest?.status).toBe("FAILED");
    expect(latest?.errorCode).toContain("EXPLICIT_MARKET_OUTSIDE_WINDOW");
  });

  it("paginates no-explicit-market replay selection until the historical window is complete", async () => {
    const app = buildApp(config, { ...v2Deps(), historicalDreamDexClient: paginatedHistoricalClient(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-paginated-selection-create"
      },
      payload: {
        name: "Paginated source replay",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        windowFrom: "2026-08-24T11:10:00.000Z",
        windowTo: "2026-08-24T11:15:00.000Z",
        decisionOffsetSec: 60,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const experimentId = V2ExperimentSchema.parse(create.json()).data.experiment.experimentId;
    const replay = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-paginated-selection-replay"
      }
    });
    let replayReload = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: { cookie: cookies }
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = V2ReplaySchema.parse(replayReload.json()).data.replay;
      if (current?.status === "COMPLETED") {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      replayReload = await app.inject({
        method: "GET",
        url: `/api/v2/experiments/${experimentId}/replay`,
        headers: { cookie: cookies }
      });
    }
    await app.close();

    expect(create.statusCode).toBe(201);
    expect(replay.statusCode, JSON.stringify(replay.json())).toBe(202);
    const completed = V2ReplaySchema.parse(replayReload.json()).data.replay;
    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.selectedCount).toBe(1);
    expect(completed?.processedCount).toBe(1);
    expect(completed?.decisions?.[0]?.marketId).toBe(apiMarketId.toLowerCase());
  });

  it("deduplicates repeated historical market source rows during replay selection", async () => {
    const app = buildApp(config, { ...v2Deps(), historicalDreamDexClient: duplicateHistoricalMarketClient(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-dedupe-selection-create"
      },
      payload: {
        name: "Duplicate source replay",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        windowFrom: "2026-08-24T11:10:00.000Z",
        windowTo: "2026-08-24T11:15:00.000Z",
        decisionOffsetSec: 60,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const experimentId = V2ExperimentSchema.parse(create.json()).data.experiment.experimentId;
    const replay = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-dedupe-selection-replay"
      }
    });
    let replayReload = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: { cookie: cookies }
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = V2ReplaySchema.parse(replayReload.json()).data.replay;
      if (current?.status === "COMPLETED") {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      replayReload = await app.inject({
        method: "GET",
        url: `/api/v2/experiments/${experimentId}/replay`,
        headers: { cookie: cookies }
      });
    }
    await app.close();

    expect(create.statusCode).toBe(201);
    expect(replay.statusCode, JSON.stringify(replay.json())).toBe(202);
    const completed = V2ReplaySchema.parse(replayReload.json()).data.replay;
    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.selectedCount).toBe(1);
    expect(completed?.processedCount).toBe(1);
    expect(completed?.decisions?.[0]?.marketId).toBe(apiMarketId.toLowerCase());
  });

  it("completes replay with excluded evidence when a market source read fails", async () => {
    const failingIndexerFetch: HistoricalIndexerFetch = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ errors: [{ message: "source unavailable" }] })
      });
    const app = buildApp(config, { ...v2Deps(), pool, historicalIndexerFetch: failingIndexerFetch });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-source-failure-create"
      },
      payload: {
        name: "Source failure replay",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        marketId: apiMarketId,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const experimentId = V2ExperimentSchema.parse(create.json()).data.experiment.experimentId;
    const replay = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-source-failure-replay"
      }
    });
    let replayReload = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: { cookie: cookies }
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = V2ReplaySchema.parse(replayReload.json()).data.replay;
      if (current?.status === "COMPLETED") {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      replayReload = await app.inject({
        method: "GET",
        url: `/api/v2/experiments/${experimentId}/replay`,
        headers: { cookie: cookies }
      });
    }
    await app.close();

    expect(create.statusCode).toBe(201);
    expect(replay.statusCode, JSON.stringify(replay.json())).toBe(202);
    const completed = V2ReplaySchema.parse(replayReload.json()).data.replay;
    expect(completed, JSON.stringify(completed)).toMatchObject({
      status: "COMPLETED",
      selectedCount: 1,
      processedCount: 1,
      scoredCount: 0,
      excludedCount: 1
    });
  }, 10_000);

  it("creates experiments when built-in policy rows already contain full immutable manifests", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const policies = await app.inject({ method: "GET", url: "/api/v2/policies" });
    const policyRow = V2PoliciesSchema.parse(policies.json()).data.policies.find(
      (entry) => entry.policyId === "historical-last-trade" && entry.version === "1.1.0"
    );
    if (policyRow === undefined) {
      throw new Error("historical-last-trade policy missing from test catalog");
    }
    const policyManifest = {
      policyId: policyRow.policyId,
      version: policyRow.version,
      label: policyRow.label,
      adapterName: policyRow.adapterName,
      sourceHash: policyRow.sourceHash,
      implementationHash: policyRow.implementationHash,
      parameters: policyRow.parameters,
      supportedPlanes: policyRow.supportedPlanes
    };
    await pool.query("DROP TRIGGER IF EXISTS policy_versions_append_only ON policy_versions");
    await pool.query(
      `
        INSERT INTO policy_versions(policy_id, version, label, adapter_name, source_hash, manifest)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (policy_id, version) DO UPDATE
        SET label = EXCLUDED.label,
            adapter_name = EXCLUDED.adapter_name,
            source_hash = EXCLUDED.source_hash,
            manifest = EXCLUDED.manifest
      `,
      [
        policyManifest.policyId,
        policyManifest.version,
        policyManifest.label,
        policyManifest.adapterName,
        policyManifest.sourceHash,
        JSON.stringify(policyManifest)
      ]
    );
    await pool.query(`
      CREATE TRIGGER policy_versions_append_only
      BEFORE UPDATE OR DELETE ON policy_versions
      FOR EACH ROW
      EXECUTE FUNCTION reject_policy_version_mutation()
    `);
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookieHeader(session),
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-full-policy-manifest-create"
      },
      payload: {
        name: "Full manifest policy create",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    expect(create.statusCode, JSON.stringify(create.json())).toBe(201);
    const created = V2ExperimentSchema.parse(create.json());
    const persisted = await pool.query<{ readonly source_hash: string }>(
      `
        SELECT policy_versions.source_hash
        FROM policy_versions
        JOIN experiment_policy_versions ON experiment_policy_versions.policy_version_id = policy_versions.id
        WHERE experiment_policy_versions.experiment_id = $1
      `,
      [created.data.experiment.experimentId]
    );
    await app.close();

    expect(created.data.experiment.policies[0]).toMatchObject({ policyId: "historical-last-trade" });
    expect(persisted.rows[0]?.source_hash).toBe(policyManifest.sourceHash);
  });

  it("runs historical replay, persists decisions, and evaluates from replay evidence", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-replay-002"
      },
      payload: {
        name: "Replay 002 historical last trade",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        marketId: apiMarketId,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const experimentId = V2ExperimentSchema.parse(create.json()).data.experiment.experimentId;
    const replay = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-run-replay-002"
      }
    });
    expect(replay.statusCode, JSON.stringify(replay.json())).toBe(202);
    const replayBody = V2ReplaySchema.parse(replay.json());
    let replayReload = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: { cookie: cookies }
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = V2ReplaySchema.parse(replayReload.json()).data.replay;
      if (current?.status === "COMPLETED") {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      replayReload = await app.inject({
        method: "GET",
        url: `/api/v2/experiments/${experimentId}/replay`,
        headers: { cookie: cookies }
      });
    }
    const completedReplayBody = V2ReplaySchema.parse(replayReload.json());
    expect(completedReplayBody.data.replay?.status).toBe("COMPLETED");
    const evaluate = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/evaluate`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-evaluate-replay-002"
      }
    });
    expect(evaluate.statusCode, JSON.stringify(evaluate.json())).toBe(200);
    const assessmentBody = V2AssessmentSchema.parse(evaluate.json());
    const latest = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/evaluation/latest`,
      headers: { cookie: cookies }
    });
    const evidence = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/evidence`,
      headers: { cookie: cookies }
    });
    const evidenceBody = V2EvidenceGateSchema.parse(evidence.json());
    const replayBarrier = await pool.query<{
      readonly decision_id: string;
      readonly decision_created_at: Date;
      readonly outcome_loaded_at: Date;
      readonly outcome_result: string;
      readonly legacy_outcome_loaded_at: Date | null;
      readonly legacy_outcome_result: string | null;
    }>(
      `
        SELECT rd.id AS decision_id, rd.created_at AS decision_created_at,
          ro.loaded_at AS outcome_loaded_at, ro.outcome_result,
          rd.outcome_loaded_at AS legacy_outcome_loaded_at,
          rd.outcome_result AS legacy_outcome_result
        FROM replay_decisions rd
        JOIN replay_outcomes ro ON ro.replay_decision_id = rd.id
        WHERE rd.replay_run_id = $1
      `,
      [completedReplayBody.data.replay?.id]
    );
    const barrierRow = replayBarrier.rows[0];
    await expect(
      pool.query("UPDATE replay_decisions SET frame_hash = $2 WHERE id = $1", [
        barrierRow?.decision_id,
        "f".repeat(64)
      ])
    ).rejects.toThrow(/append-only/);
    await app.close();

    expect(create.statusCode).toBe(201);
    expect(replay.statusCode).toBe(202);
    expect(replayBody.data.replay?.status).toBe("QUEUED");
    expect(completedReplayBody.data.replay).toMatchObject({
      status: "COMPLETED",
      selectedCount: 1,
      processedCount: 1,
      scoredCount: 1,
      excludedCount: 0
    });
    expect(completedReplayBody.data.replay?.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completedReplayBody.data.replay?.decisions?.[0]).toMatchObject({
      marketId: apiMarketId.toLowerCase(),
      action: "WATCH_ONLY",
      outcomeResult: "YES"
    });
    expect(completedReplayBody.data.replay?.decisions?.[0]?.frameHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completedReplayBody.data.replay?.decisions?.[0]?.forecastPUp).toBeGreaterThanOrEqual(0.05);
    expect(barrierRow?.legacy_outcome_loaded_at).toBeNull();
    expect(barrierRow?.legacy_outcome_result).toBeNull();
    expect(barrierRow?.outcome_result).toBe("YES");
    expect(barrierRow?.outcome_loaded_at.getTime()).toBeGreaterThanOrEqual(
      barrierRow?.decision_created_at.getTime() ?? Number.POSITIVE_INFINITY
    );
    expect(JSON.stringify(completedReplayBody)).not.toContain("closingAnswer");
    expect(replayReload.statusCode).toBe(200);
    expect(completedReplayBody.data.replay?.status).toBe("COMPLETED");
    expect(evaluate.statusCode).toBe(200);
    expect(assessmentBody.data.assessment.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(assessmentBody.data.assessment.reasonCodes).toContain("MIN_SAMPLE_NOT_MET");
    expect(assessmentBody.data.assessment.sampleSize).toBe(1);
    expect(assessmentBody.data.assessment.pnlStatus).toBe("NOT_AVAILABLE");
    expect(latest.statusCode).toBe(200);
    expect(V2LatestAssessmentSchema.parse(latest.json()).data.assessment?.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(evidence.statusCode).toBe(200);
    expect(evidenceBody.data.state).toBe("READY");
    expect(evidenceBody.data.evidence?.serverAuthored).toBe(true);
    expect(evidenceBody.data.evidence?.assessment.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(evidenceBody.data.evidence?.assessment.evidencePlane).toBe("MAINNET_HISTORICAL");
    expect(evidenceBody.data.evidence?.assessment.pnlStatus).toBe("NOT_AVAILABLE");
    expect(evidenceBody.data.evidence?.decision.nextPermittedAction).toBe("COLLECT_MORE_EVIDENCE");
    expect(evidenceBody.data.evidence?.decision.promotionScope).toBe("NOT_APPLICABLE");
    expect(evidenceBody.data.evidence?.decision.doesNotAuthorize).toContain("promotion to forward observation");
    expect(evidenceBody.data.evidence?.progression.stages.map((stage) => stage.stage)).toEqual(
      expect.arrayContaining(["Historical Replay", "Forward Observation", "Execution Proof"])
    );
    expect(evidenceBody.data.evidence?.verdictReasons).toContain("MIN_SAMPLE_NOT_MET");
    expect(evidenceBody.data.evidence?.gateRows.map((row) => row.dimension)).toEqual(
      expect.arrayContaining(["Forecast sample", "Forecast quality", "Forecast calibration", "Tradeability / execution quality", "PnL", "Provenance"])
    );
    expect(evidenceBody.data.evidence?.missingEvidence).toEqual(
      expect.arrayContaining(["Forecast sample", "Tradeability / execution quality", "PnL"])
    );
  });

  it("captures live-shadow observations for session-owned live experiments without wallet writes", async () => {
    const app = buildApp(config, { ...v2Deps(), dreamDexClient: futureLiveClient(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-live-002"
      },
      payload: {
        name: "Live 002 forward shadow",
        mode: "LIVE_SHADOW",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "reference-neutral",
        policyVersion: "1.0.0",
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const experimentId = V2ExperimentSchema.parse(create.json()).data.experiment.experimentId;
    const observed = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/live-shadow/observe`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-live-observe-002"
      }
    });
    const observedBody = V2LiveShadowSchema.parse(observed.json());
    const reloaded = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/live-shadow`,
      headers: { cookie: cookies }
    });
    await app.close();

    expect(create.statusCode).toBe(201);
    expect(observed.statusCode).toBe(200);
    expect(observedBody.data.observation).toMatchObject({
      leaseAcquired: true,
      discoveredMarketCount: 1,
      observed: [expect.objectContaining({ insertedDecisionCount: 1, skipped: false })]
    });
    expect(observedBody.data.liveShadow).toMatchObject({
      episodeCount: 1,
      snapshotCount: 1,
      decisionCount: 1,
      sourcePlane: "SHANNON_FORWARD",
      blockchainWrite: false
    });
    expect(reloaded.statusCode).toBe(200);
    expect(V2LiveShadowSchema.parse(reloaded.json()).data.liveShadow.decisionCount).toBe(1);
  });

  it("exports a sanitized experiment report for session-owned experiments", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-report-export"
      },
      payload: {
        name: "Report export smoke",
        mode: "LIVE_SHADOW",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "reference-neutral",
        policyVersion: "1.0.0",
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const experimentId = V2ExperimentSchema.parse(create.json()).data.experiment.experimentId;
    const report = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/report`,
      headers: { cookie: cookies }
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/v2/experiments/00000000-0000-0000-0000-000000000000/report",
      headers: { cookie: cookies }
    });
    const reportBody = V2ExperimentReportSchema.parse(report.json());
    await app.close();

    expect(create.statusCode).toBe(201);
    expect(report.statusCode).toBe(200);
    expect(reportBody.data.report.title).toBe("EdgeLab Experiment Report");
    expect(reportBody.data.report.exportPolicy.privateSecretsIncluded).toBe(false);
    expect(missing.statusCode).toBe(404);
  });

  it("saves and reloads ordered comparisons from immutable owned assessments", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);

    async function createEvaluated(name: string, key: string): Promise<string> {
      const create = await app.inject({
        method: "POST",
        url: "/api/v2/experiments",
        headers: {
          cookie: cookies,
          "x-csrf-token": sessionBody.data.csrfToken,
          "idempotency-key": `api-comparison-create-${key}`
        },
        payload: {
          name,
          mode: "HISTORICAL_REPLAY",
          asset: "BTC",
          intervalSec: 3600,
          policyId: "historical-last-trade",
          policyVersion: "1.1.0",
          marketId: apiMarketId,
          riskEnvelopeId: "WATCH_ONLY_BOUNDED"
        }
      });
      const experimentId = V2ExperimentSchema.parse(create.json()).data.experiment.experimentId;
      const replay = await app.inject({
        method: "POST",
        url: `/api/v2/experiments/${experimentId}/replay`,
        headers: {
          cookie: cookies,
          "x-csrf-token": sessionBody.data.csrfToken,
          "idempotency-key": `api-comparison-replay-${key}`
        }
      });
      expect(replay.statusCode, JSON.stringify(replay.json())).toBe(202);
      const replayRunId = V2ReplaySchema.parse(replay.json()).data.replay?.id;
      expect(replayRunId).toBeTypeOf("string");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const current = await app.inject({
          method: "GET",
          url: `/api/v2/replay-runs/${String(replayRunId)}`,
          headers: { cookie: cookies }
        });
        const status = V2ReplaySchema.parse(current.json()).data.replay?.status;
        if (status === "COMPLETED") {
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      const evaluate = await app.inject({
        method: "POST",
        url: `/api/v2/experiments/${experimentId}/evaluate`,
        headers: {
          cookie: cookies,
          "x-csrf-token": sessionBody.data.csrfToken,
          "idempotency-key": `api-comparison-evaluate-${key}`
        }
      });
      expect(evaluate.statusCode, JSON.stringify(evaluate.json())).toBe(200);
      return V2AssessmentSchema.parse(evaluate.json()).data.assessment.assessmentId;
    }

    const firstAssessmentId = await createEvaluated("Comparison replay A", "a");
    const secondAssessmentId = await createEvaluated("Comparison replay B", "b");
    const list = await app.inject({
      method: "GET",
      url: "/api/v2/assessments",
      headers: { cookie: cookies }
    });
    const listBody = V2AssessmentListSchema.parse(list.json());
    const compare = await app.inject({
      method: "POST",
      url: "/api/v2/comparisons",
      headers: {
        cookie: cookies,
        "x-csrf-token": listBody.data.csrfToken ?? sessionBody.data.csrfToken,
        "idempotency-key": "api-save-comparison-001"
      },
      payload: {
        name: "API comparison",
        assessmentIds: [firstAssessmentId, secondAssessmentId]
      }
    });
    const compareDuplicate = await app.inject({
      method: "POST",
      url: "/api/v2/comparisons",
      headers: {
        cookie: cookies,
        "x-csrf-token": listBody.data.csrfToken ?? sessionBody.data.csrfToken,
        "idempotency-key": "api-save-comparison-001"
      },
      payload: {
        name: "API comparison",
        assessmentIds: [firstAssessmentId, secondAssessmentId]
      }
    });
    const compareMismatch = await app.inject({
      method: "POST",
      url: "/api/v2/comparisons",
      headers: {
        cookie: cookies,
        "x-csrf-token": listBody.data.csrfToken ?? sessionBody.data.csrfToken,
        "idempotency-key": "api-save-comparison-001"
      },
      payload: {
        name: "API comparison changed",
        assessmentIds: [firstAssessmentId, secondAssessmentId]
      }
    });
    const comparisonBody = V2ComparisonSchema.parse(compare.json());
    const comparisonList = await app.inject({
      method: "GET",
      url: "/api/v2/comparisons",
      headers: { cookie: cookies }
    });
    const reload = await app.inject({
      method: "GET",
      url: `/api/v2/comparisons/${comparisonBody.data.comparison.comparisonId}`,
      headers: { cookie: cookies }
    });
    await app.close();

    expect(list.statusCode).toBe(200);
    expect(listBody.data.assessments.map((item) => item.assessmentId)).toEqual(
      expect.arrayContaining([firstAssessmentId, secondAssessmentId])
    );
    expect(compare.statusCode).toBe(200);
    expect(compareDuplicate.statusCode).toBe(200);
    expect(V2ComparisonSchema.parse(compareDuplicate.json()).data.comparison.comparisonId).toBe(
      comparisonBody.data.comparison.comparisonId
    );
    expect(compareMismatch.statusCode).toBe(409);
    expect(compareMismatch.json()).toMatchObject({ error: { code: "IDEMPOTENCY_BODY_MISMATCH" } });
    expect(comparisonBody.data.comparison.name).toBe("API comparison");
    expect(comparisonBody.data.comparison.items.map((item) => item.assessmentId)).toEqual([
      firstAssessmentId,
      secondAssessmentId
    ]);
    expect(comparisonBody.data.comparison.items[0]).toMatchObject({
      displayOrder: 0,
      evidencePlane: "MAINNET_HISTORICAL",
      pnlStatus: "NOT_AVAILABLE"
    });
    expect(comparisonList.statusCode).toBe(200);
    expect(V2ComparisonListSchema.parse(comparisonList.json()).data.comparisons).toContainEqual(
      expect.objectContaining({
        comparisonId: comparisonBody.data.comparison.comparisonId,
        name: "API comparison",
        itemCount: 2
      })
    );
    expect(reload.statusCode).toBe(200);
    expect(V2ComparisonSchema.parse(reload.json()).data.comparison.items).toHaveLength(2);
  });

  it("rejects experiment writes without the current research-session csrf token and after session revocation", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "idempotency-key": "api-create-missing-csrf"
      },
      payload: {
        name: "Missing csrf replay",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const revoke = await app.inject({
      method: "POST",
      url: "/api/v2/research-session/revoke",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-revoke-session"
      }
    });
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-after-revoke"
      },
      payload: {
        name: "Revoked csrf replay",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    await app.close();

    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({
      error: { code: "CSRF_TOKEN_INVALID", retryable: false }
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ data: { revoked: true } });
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json()).toMatchObject({
      error: { code: "RESEARCH_SESSION_REQUIRED", retryable: false }
    });
  });

  it("enforces public write rate limits before route work", async () => {
    const app = buildApp(config, { consumedNonces: new Set(), signatureVerifier: verifier });
    let finalResponseStatus = 0;
    let finalBody: unknown = null;
    for (let index = 0; index < 61; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        remoteAddress: "198.51.100.9",
        payload: { purpose: "login", account }
      });
      finalResponseStatus = response.statusCode;
      finalBody = response.json();
    }
    await app.close();

    expect(finalResponseStatus).toBe(429);
    expect(finalBody).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true }
    });
  });

  it("does not let spoofed X-Forwarded-For values bypass public write rate limits", async () => {
    const app = buildApp(config, { consumedNonces: new Set(), signatureVerifier: verifier });
    let finalResponseStatus = 0;
    for (let index = 0; index < 61; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        remoteAddress: "198.51.100.10",
        headers: { "x-forwarded-for": `203.0.113.${String(index)}` },
        payload: { purpose: "login", account }
      });
      finalResponseStatus = response.statusCode;
    }
    await app.close();

    expect(finalResponseStatus).toBe(429);
  });

  it("enforces the per-session experiment quota", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    for (let index = 0; index < 20; index += 1) {
      const create = await app.inject({
        method: "POST",
        url: "/api/v2/experiments",
        headers: {
          cookie: cookies,
          "x-csrf-token": sessionBody.data.csrfToken,
          "idempotency-key": `api-quota-create-${String(index)}`
        },
        payload: {
          name: `Quota replay ${String(index)}`,
          mode: "HISTORICAL_REPLAY",
          asset: "BTC",
          intervalSec: 3600,
          policyId: "historical-last-trade",
          policyVersion: "1.1.0",
          riskEnvelopeId: "WATCH_ONLY_BOUNDED"
        }
      });
      expect(create.statusCode, JSON.stringify(create.json())).toBe(201);
    }
    const overQuota = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-quota-create-over"
      },
      payload: {
        name: "Quota replay over",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.1.0",
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    await app.close();

    expect(overQuota.statusCode).toBe(429);
    expect(overQuota.json()).toMatchObject({
      error: {
        code: "EXPERIMENT_QUOTA_EXCEEDED",
        details: { quota: 20 }
      }
    });
  });
});
