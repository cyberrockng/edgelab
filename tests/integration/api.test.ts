import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, classifyExecutionFillState, decodeOrderLifecycleFromReceipt } from "@edgelab/server";
import { createPool, runMigrations } from "@edgelab/db";
import type { RuntimeConfig } from "@edgelab/config";
import { LoginChallengeSchema, type SignatureVerifier } from "@edgelab/auth";
import { orderBookEventsAbi, type BinaryMarket } from "@somnia-chain/markets-sdk";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import type {
  DreamDexSdkClient,
  HistoricalDreamDexSdkClient,
  HistoricalIndexerFetch,
  HistoricalRpcFetch
} from "@edgelab/dreamdex";
import { z } from "zod";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab_test";

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
const V2ObservationProofSchema = z.object({
  data: z.object({
    observationProof: z.object({
      proofId: z.literal("OBSERVE-001"),
      status: z.literal("PASSED"),
      sourcePlane: z.literal("SHANNON_FORWARD"),
      chainId: z.literal(50312),
      transactionSubmitted: z.literal(false),
      walletRequired: z.literal(false),
      observedMarketCount: z.number(),
      totalShadowDecisions: z.number(),
      implementedControls: z.array(z.string()),
      observedMarkets: z.array(
        z.object({
          stableMarketId: z.string(),
          snapshotHash: z.string(),
          decisionCount: z.number()
        })
      ),
      judgeSummary: z.object({
        oneLine: z.string(),
        nextMilestone: z.string(),
        blockedClaims: z.array(z.string())
      })
    })
  }),
  meta: z.object({
    sourcePlane: z.literal("SHANNON_FORWARD"),
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
        verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "STRATEGY_QUALIFIED", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
        sampleSize: z.number(),
        pnlStatus: z.literal("NOT_AVAILABLE")
      }),
      evidenceGate: z.object({
        serverAuthored: z.literal(true),
        decision: z.object({
          verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "STRATEGY_QUALIFIED", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
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
const V2ExecutionCandidateSchema = z.object({
  data: z.object({
    executionCandidate: z.object({
      status: z.enum(["READY", "BLOCKED"]),
      intentHash: z.string().regex(/^[a-f0-9]{64}$/),
      account: z.string(),
      sourcePlane: z.literal("SHANNON_EXECUTION"),
      network: z.object({ chainId: z.literal(50312) }),
      strategyLink: z.object({
        experimentId: z.string().uuid(),
        assessmentId: z.string().uuid(),
        assessmentHash: z.string(),
        qualificationVerdict: z.literal("STRATEGY_QUALIFIED"),
        eligibleForwardObservationCount: z.number(),
        sourceObservationPolicy: z.literal("last-trade-forward-proxy@1.0.0"),
        linkedHistoricalPolicy: z.literal("historical-last-trade@1.1.0"),
        snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.object({
          policyId: z.literal("last-trade-forward-proxy"),
          action: z.string(),
          forecastPUp: z.number(),
          reasonCodes: z.array(z.string())
        })
      }),
      risk: z.object({
        maxEscrowRaw: z.string(),
        orderCount: z.literal(1),
        serverSigner: z.literal(false),
        mainnetWrite: z.literal(false),
        minimumPoolEscrowRaw: z.string().nullable(),
        minimumPoolEscrowDisplay: z.string().nullable(),
        capAdequateForPoolMinimum: z.boolean(),
        requiredEscrowRaw: z.string(),
        collateralResolvedFromMarket: z.string(),
        walletHasRequiredCollateral: z.boolean(),
        walletHasGas: z.boolean()
      }),
      sizing: z.object({
        side: z.enum(["BUY_YES", "BUY_NO"]),
        quantityRaw: z.string(),
        priceRaw: z.string().nullable()
      }),
      unsignedTransactions: z
        .object({
          order: z.object({ to: z.string(), data: z.string(), valueRaw: z.string(), description: z.string() }),
          approval: z
            .object({ to: z.string(), data: z.string(), valueRaw: z.string(), description: z.string() })
            .nullable()
        })
        .nullable(),
      blockedReasons: z.array(z.string()),
      blockedClaims: z.array(z.string())
    })
  }),
  meta: z.object({
    sourcePlane: z.literal("SHANNON_EXECUTION"),
    blockchainWrite: z.literal(false),
    walletRequired: z.literal(true)
  })
});
const V2ControlledLiquidityCandidateSchema = z.object({
  data: z.object({
    controlledLiquidityCandidate: z.object({
      status: z.enum(["READY", "BLOCKED"]),
      maker: z.string(),
      sourcePlane: z.literal("SHANNON_EXECUTION"),
      network: z.object({ chainId: z.literal(50312) }),
      market: z.object({
        poolAddress: z.string(),
        asset: z.string(),
        intervalSeconds: z.number().nullable()
      }),
      setup: z
        .object({
          setupKind: z.literal("CONTROLLED_TESTNET_LIQUIDITY"),
          calls: z.array(z.object({ to: z.string(), data: z.string(), valueRaw: z.string(), description: z.string() })),
          disclosures: z.array(z.string())
        })
        .nullable(),
      sizing: z.object({
        side: z.enum(["SELL_YES", "SELL_NO"]),
        quantityRaw: z.string(),
        minQuantityRaw: z.string()
      }),
      risk: z.object({
        controlledLiquidity: z.literal(true),
        organicLiquidityClaim: z.literal(false),
        serverSigner: z.literal(false),
        mainnetWrite: z.literal(false)
      }),
      blockedReasons: z.array(z.string())
    })
  }),
  meta: z.object({
    sourcePlane: z.literal("SHANNON_EXECUTION"),
    blockchainWrite: z.literal(false),
    walletRequired: z.literal(true),
    controlledLiquidity: z.literal(true)
  })
});
const V2ExecutionReceiptSchema = z.object({
  data: z.object({
    executionReceipt: z.object({
      status: z.enum(["TX_PENDING", "TX_REVERTED", "APPROVED", "UNFILLED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "EXPIRED", "UNVERIFIED", "FAILED"]),
      intentId: z.string().uuid(),
      intentHash: z.string().regex(/^[a-f0-9]{64}$/),
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      txRole: z.enum(["approval", "order"]),
      account: z.string(),
      receiptStatus: z.boolean().nullable(),
      blockNumber: z.string().nullable(),
      logHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
      lifecycleDecoded: z.boolean(),
      order: z
        .object({
          orderId: z.string(),
          state: z.string(),
          requestedQuantityRaw: z.string(),
          filledQuantityRaw: z.string(),
          remainingQuantityRaw: z.string(),
          fillState: z.enum(["NO_FILL", "PARTIAL_FILL", "FULL_FILL"]),
          terminal: z.boolean(),
          fillCount: z.number()
        })
        .nullable(),
      nextMissingProof: z.string()
    })
  }),
  meta: z.object({
    sourcePlane: z.literal("SHANNON_EXECUTION"),
    blockchainWrite: z.literal(false),
    serverVerified: z.literal(true)
  })
});
const V2ExecutionLifecycleSchema = z.object({
  data: z.object({
    executionLifecycle: z.object({
      intentId: z.string().uuid(),
      experimentId: z.string().uuid(),
      state: z.string(),
      qualification: z.object({ verdict: z.literal("STRATEGY_QUALIFIED"), assessmentHash: z.string() }),
      transactions: z.object({
        approval: z.object({ txHash: z.string(), state: z.string() }).nullable(),
        order: z.object({ txHash: z.string(), state: z.string() }).nullable(),
        redeem: z.object({ txHash: z.string(), state: z.string() }).nullable()
      }),
      order: z.object({
        orderId: z.string(),
        state: z.string(),
        requestedQuantityRaw: z.string(),
        filledQuantityRaw: z.string(),
        remainingQuantityRaw: z.string(),
        fillState: z.string(),
        evidenceSource: z.string()
      }).nullable(),
      settlement: z.object({ state: z.string() }),
      redemption: z.object({
        state: z.string(),
        redeemedQuantityRaw: z.string().nullable(),
        actualPayoutRaw: z.string().nullable(),
        evidenceSource: z.string().nullable()
      }),
      publicClaim: z.string()
    }).nullable()
  })
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
      policies: z.array(z.object({ policyVersionId: z.string().uuid(), policyId: z.string(), version: z.string(), role: z.string() }))
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
      verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "STRATEGY_QUALIFIED", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
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
          verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "STRATEGY_QUALIFIED", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
          sampleSize: z.number(),
          evidencePlane: z.string(),
          promotionScope: z.string(),
          pnlStatus: z.string()
        }),
        decision: z.object({
          verdict: z.enum(["PROMOTE_TO_FORWARD_OBSERVATION", "STRATEGY_QUALIFIED", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
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
        discoveryIssue: z
          .object({
            reasonCode: z.string(),
            message: z.string()
          })
          .optional(),
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
      eligibleDecisionCount: z.number(),
      abstentionCount: z.number(),
      pendingOutcomeCount: z.number(),
      timingExcludedDecisionCount: z.number(),
      excludedEpisodeCount: z.number(),
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

function decisionWindowLiveClient(): DreamDexSdkClient {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const current = {
    ...binaryMarket,
    status: "Trading",
    finalized: false,
    winningOutcome: null,
    tradingStart: String(nowSeconds - 3_570),
    expiry: String(nowSeconds + 30),
    intervalSec: "3600",
    interval: "1h"
  };
  return {
    listLiveBinaryMarkets() {
      return Promise.resolve([current]);
    },
    getBinaryBookParams() {
      return Promise.resolve({ tickSize: 1000n, lotSize: 1000n, minQuantity: 1000n });
    },
    getLiveBinaryOrderBookByMarket() {
      return { yesBids: [{ price: 1000n, quantity: 2000n }], yesAsks: [], noBids: [], noAsks: [] };
    },
    getBinaryMarket() {
      return Promise.resolve(current);
    }
  };
}

function executionReadyLiveClient(): DreamDexSdkClient {
  const future = { ...binaryMarket, status: "Trading", finalized: false, winningOutcome: null, expiry: "4102444800" };
  return {
    listLiveBinaryMarkets() {
      return Promise.resolve([future]);
    },
    getBinaryBookParams() {
      return Promise.resolve({ tickSize: 1000n, lotSize: 1000n, minQuantity: 1000n });
    },
    getLiveBinaryOrderBookByMarket() {
      return {
        yesBids: [{ price: 500000n, quantity: 50000n }],
        yesAsks: [{ price: 600000n, quantity: 50000n }],
        noBids: [{ price: 400000n, quantity: 50000n }],
        noAsks: [{ price: 500000n, quantity: 50000n }]
      };
    },
    getBinaryMarket() {
      return Promise.resolve(future);
    },
    createTrader() {
      return {
        buildPlaceOrder(params: { readonly pool: string }) {
          return Promise.resolve({
            approval: {
              to: binaryMarket.collateral,
              data: "0xaabb",
              value: 0n,
              description: "Approve bounded collateral escrow"
            },
            order: {
              to: params.pool,
              data: "0xccdd",
              value: 0n,
              description: "Place bounded IOC binary order"
            }
          });
        }
      } as unknown as ReturnType<NonNullable<DreamDexSdkClient["createTrader"]>>;
    }
  };
}

function noAskExecutionReadyLiveClient(): DreamDexSdkClient {
  const future = { ...binaryMarket, status: "Trading", finalized: false, winningOutcome: null, expiry: "4102444800" };
  return {
    ...executionReadyLiveClient(),
    listLiveBinaryMarkets() {
      return Promise.resolve([future]);
    },
    getLiveBinaryOrderBookByMarket() {
      return {
        yesBids: [],
        yesAsks: [],
        noBids: [],
        noAsks: [{ price: 600000n, quantity: 50000n }]
      };
    },
    getBinaryMarket() {
      return Promise.resolve(future);
    }
  };
}

function capTooLowExecutionClient(): DreamDexSdkClient {
  return {
    ...executionReadyLiveClient(),
    getBinaryBookParams() {
      return Promise.resolve({ tickSize: 1000n, lotSize: 1000n, minQuantity: 20_000n });
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

const executionReadiness = {
  observedBlockNumber: "100",
  marketCollateral: binaryMarket.collateral,
  poolCollateral: binaryMarket.collateral,
  collateralBindingMatches: true,
  walletBalanceRaw: "1000000",
  walletAllowanceRaw: "0",
  walletNativeBalanceRaw: "1000000000000000000"
} as const;

async function createQualifiedForwardStrategy(
  app: ReturnType<typeof buildApp>
): Promise<{ readonly experimentId: string; readonly cookie: string; readonly csrfToken: string }> {
  const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
  const sessionBody = V2SessionSchema.parse(session.json());
  const cookie = cookieHeader(session);
  const created = await app.inject({
    method: "POST",
    url: "/api/v2/experiments",
    headers: {
      cookie,
      "x-csrf-token": sessionBody.data.csrfToken,
      "idempotency-key": `qualified-forward-${crypto.randomUUID()}`
    },
    payload: {
      name: "Qualified BTC hourly forward strategy",
      mode: "LIVE_SHADOW",
      asset: "BTC",
      intervalSec: 3600,
      policyId: "last-trade-forward-proxy",
      policyVersion: "1.0.0",
      decisionOffsetSec: 60,
      riskEnvelopeId: "WATCH_ONLY_BOUNDED"
    }
  });
  const experiment = V2ExperimentSchema.parse(created.json()).data.experiment;
  const policyVersionId = experiment.policies[0]?.policyVersionId;
  if (policyVersionId === undefined) {
    throw new Error("Forward strategy policy version was not recorded");
  }
  const compactExperimentId = experiment.experimentId.replaceAll("-", "");
  for (let index = 0; index < 30; index += 1) {
    const suffix = index.toString(16).padStart(32, "0");
    const marketId = `0x${compactExperimentId}${suffix}`;
    const snapshotHash = `${compactExperimentId}${suffix}`;
    const settlementHash = `${suffix}${compactExperimentId}`;
    const episode = await pool.query<{ id: string }>(
      `
        INSERT INTO market_episodes(
          experiment_id, market_id, asset, interval_seconds, pool_address, market_nonce,
          trading_starts_at, expires_at, source_observed_at, state
        )
        VALUES ($1, $2, 'BTC', 3600, $3, $4, '2099-12-31T22:00:00Z', '2100-01-01T00:00:00Z',
          '2099-12-31T22:30:00Z', 'DECISION_RECORDED')
        RETURNING id
      `,
      [experiment.experimentId, marketId, binaryMarket.poolAddress, index]
    );
    const snapshot = await pool.query<{ id: string }>(
      `
        INSERT INTO market_snapshots(episode_id, chain_id, captured_at, snapshot_hash, evidence_class, payload)
        VALUES ($1, 50312, '2099-12-31T23:59:30Z', $2, 'CAPTURED', '{}'::jsonb)
        RETURNING id
      `,
      [episode.rows[0]?.id, snapshotHash]
    );
    const outcomeUp = index % 2 === 0;
    await pool.query(
      `
        INSERT INTO shadow_decisions(
          experiment_id, episode_id, policy_version_id, snapshot_id, decision_offset_sec,
          forecast_p_up, action, proposal, reason_codes, decided_at, policy_hash, risk_hash
        )
        SELECT $1, $2, pv.id, $3, 60, $4, 'WATCH_ONLY', '{}'::jsonb,
          ARRAY['FORWARD_TEST_FIXTURE'], '2099-12-31T23:59:30Z', pv.source_hash, $5
        FROM policy_versions pv
        WHERE pv.id = $6
      `,
      [
        experiment.experimentId,
        episode.rows[0]?.id,
        snapshot.rows[0]?.id,
        outcomeUp ? 0.8 : 0.2,
        "a".repeat(64),
        policyVersionId
      ]
    );
    await pool.query(
      `
        INSERT INTO settlements(market_id, resolved, voided, winner, source_observed_at, payload, settlement_hash)
        VALUES ($1, true, false, $2, '2100-01-01T00:01:00Z', '{}'::jsonb, $3)
      `,
      [marketId, outcomeUp ? "YES" : "NO", settlementHash]
    );
  }
  const evaluated = await app.inject({
    method: "POST",
    url: `/api/v2/experiments/${experiment.experimentId}/evaluate`,
    headers: {
      cookie,
      "x-csrf-token": sessionBody.data.csrfToken,
      "idempotency-key": `forward-evaluate-${crypto.randomUUID()}`
    }
  });
  expect(evaluated.statusCode).toBe(200);
  expect(evaluated.json()).toMatchObject({ data: { assessment: { verdict: "STRATEGY_QUALIFIED", sampleSize: 30 } } });
  return { experimentId: experiment.experimentId, cookie, csrfToken: sessionBody.data.csrfToken };
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

  it("classifies fill evidence independently from terminal order labels", () => {
    expect(classifyExecutionFillState({
      orderState: "ORDER_VERIFIED",
      filledQuantityRaw: "0",
      remainingQuantityRaw: "16000",
      hasOrderEvidence: true
    })).toBe("UNKNOWN");
    expect(classifyExecutionFillState({
      orderState: "CANCELLED",
      filledQuantityRaw: "4000",
      remainingQuantityRaw: "12000",
      hasOrderEvidence: true
    })).toBe("PARTIAL_FILL");
    expect(classifyExecutionFillState({
      orderState: "EXPIRED",
      filledQuantityRaw: "0",
      remainingQuantityRaw: "16000",
      hasOrderEvidence: true
    })).toBe("NO_FILL");
    expect(classifyExecutionFillState({
      orderState: "FILLED",
      filledQuantityRaw: "16000",
      remainingQuantityRaw: "0",
      hasOrderEvidence: true
    })).toBe("FULL_FILL");
  });

  it("uses the final taker remainder when a placed order fills in the same receipt", () => {
    const poolAddress = `0x${"8".repeat(40)}`;
    const placedLog = {
      address: poolAddress,
      data:
        ["0x", "00000000000000000000000000000000", "0000000000000000000000000000007b", "00000000000000000000000000000000", "00000000000000000000000000000001", "00000000000000000000000077777777", "77777777777777777777777777777777", "00000000000000000000000000000000", "00000000000000000000000000000000", "00000000000000000000000000000000", "000000000000000000000000000927c0", "00000000000000000000000000000000", "00000000000000000000000000003e80", "00000000000000000000000000000000", "00000000000000000000000000003e80", "00000000000000000000000000000000", "000000000000000038eecfcf56a60000"].join(""),
      topics: [
        ["0x", "d90f62f61ee2f606b132cfdfd883ddd0", "79228b6fd6bffd9d7cf848daf824639d"].join(""),
        ["0x", "00000000000000000000000000000000", "0000000000000000000000000000007b"].join("")
      ],
      logIndex: "0x0"
    };
    const filledLog = {
      address: poolAddress,
      topics: encodeEventTopics({
        abi: orderBookEventsAbi,
        eventName: "OrderFilled",
        args: { takerOrderId: 123n, makerOrderId: 456n }
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [16000n, 0n, 32000n, 600000n]
      ),
      logIndex: "0x1"
    };

    expect(decodeOrderLifecycleFromReceipt({
      poolAddress,
      receiptStatus: true,
      receipt: { status: "0x1", blockNumber: "0x64", logs: [placedLog, filledLog] },
      fallbackQuantityRaw: "16000",
      observedAt: "2026-09-05T00:00:00.000Z"
    })).toMatchObject({
      orderId: "123",
      state: "FILLED",
      quantityRaw: "16000",
      remainingQuantityRaw: "0",
      filledQuantityRaw: "16000"
    });
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

  it("resigns a durable research session after a server secret rotation without exposing the token", async () => {
    const firstApp = buildApp(config, { pool });
    const created = await firstApp.inject({ method: "POST", url: "/api/v2/research-session" });
    const createdBody = V2SessionSchema.parse(created.json());
    const oldCookie = cookieHeader(created);
    const encodedValue = oldCookie.split("=", 2)[1] ?? "";
    const rawToken = decodeURIComponent(encodedValue).split(".", 1)[0] ?? "";
    await firstApp.close();

    const restartedApp = buildApp(
      { ...config, SESSION_SECRET: "different-local-session-secret-after-restart" },
      { pool }
    );
    const resumed = await restartedApp.inject({
      method: "POST",
      url: "/api/v2/research-session/resume",
      headers: {
        authorization: `Bearer ${rawToken}`,
        "x-csrf-token": createdBody.data.csrfToken
      }
    });
    const refreshedCookie = cookieHeader(resumed);
    await restartedApp.close();

    expect(rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      data: { session: { id: createdBody.data.session.id } },
      meta: { resumed: true, tokenPolicy: "opaque-bearer-not-returned" }
    });
    expect(JSON.stringify(resumed.json())).not.toContain(rawToken);
    expect(refreshedCookie).not.toBe(oldCookie);
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
    expect(policiesBody.data.policies).toContainEqual(
      expect.objectContaining({
        policyId: "last-trade-forward-proxy",
        version: "1.0.0",
        supportedPlanes: ["SHANNON_FORWARD"]
      })
    );
    expect(policiesBody.data.policies).toContainEqual(
      expect.objectContaining({
        policyId: "last-trade-forward-proxy",
        version: "1.1.0",
        supportedPlanes: ["SHANNON_FORWARD"]
      })
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

  it("serves OBSERVE-001 as public Shannon forward evidence without wallet or transaction claims", async () => {
    const app = buildApp(config, v2Deps());
    const response = await app.inject({ method: "GET", url: "/api/v2/observation-proof" });
    const body = V2ObservationProofSchema.parse(response.json());
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(body.data.observationProof.observedMarketCount).toBe(4);
    expect(body.data.observationProof.totalShadowDecisions).toBe(8);
    expect(body.data.observationProof.implementedControls).toEqual(
      expect.arrayContaining([
        "one durable pre-outcome snapshot reused across restarts",
        "late or already-expired markets are excluded before snapshot and decision writes"
      ])
    );
    expect(body.data.observationProof.judgeSummary.oneLine).toContain("pre-outcome Shannon decisions");
    expect(body.data.observationProof.judgeSummary.blockedClaims).toEqual(
      expect.arrayContaining(["realized PnL", "filled execution", "capital authorization"])
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

  it("fails closed when an executable market is requested for an unqualified strategy", async () => {
    const app = buildApp(config, {
      ...v2Deps(),
      pool,
      dreamDexClient: executionReadyLiveClient(),
      executionReadinessReader: () => Promise.resolve(executionReadiness)
    });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookie = cookieHeader(session);
    const created = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": `unqualified-forward-${crypto.randomUUID()}`
      },
      payload: {
        name: "Unqualified executable market test",
        mode: "LIVE_SHADOW",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "last-trade-forward-proxy",
        policyVersion: "1.0.0",
        decisionOffsetSec: 60,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const experiment = V2ExperimentSchema.parse(created.json()).data.experiment;
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/shannon/execution-candidate?experimentId=${experiment.experimentId}&account=${account}&asset=BTC&intervalSec=3600`,
      headers: { cookie }
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "STRATEGY_NOT_QUALIFIED",
        retryable: false
      }
    });
  });

  it("fails closed when the latest forward assessment revokes an earlier qualification", async () => {
    const app = buildApp(config, {
      ...v2Deps(),
      pool,
      dreamDexClient: executionReadyLiveClient(),
      executionReadinessReader: () => Promise.resolve(executionReadiness)
    });
    const strategy = await createQualifiedForwardStrategy(app);
    const policy = await pool.query<{ policy_version_id: string }>(
      `
        SELECT epv.policy_version_id
        FROM experiments e
        JOIN experiment_policy_versions epv ON epv.configuration_id = e.active_configuration_id
        WHERE e.id = $1 AND epv.role = 'CANDIDATE'
        LIMIT 1
      `,
      [strategy.experimentId]
    );
    const policyVersionId = policy.rows[0]?.policy_version_id;
    if (policyVersionId === undefined) {
      throw new Error("Forward strategy policy version was not recorded");
    }
    const inputHash = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const assessmentHash = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const metric = await pool.query<{ id: string }>(
      `
        INSERT INTO metric_runs(
          experiment_id, policy_version_id, rule_version, sample_size, exclusion_count,
          execution_metrics, pnl_status, input_hash, evidence_plane, promotion_scope,
          provenance, evaluation_version, canonical_input, created_at
        )
        VALUES (
          $1, $2, 'eval-003-forward-qualification-v1', 31, 0,
          '{}'::jsonb, 'NOT_AVAILABLE', $3, 'SHANNON_FORWARD', 'EXECUTION_EXPOSURE',
          '{}'::jsonb, 'test-newer-rejection', '{}'::jsonb, now() + interval '1 second'
        )
        RETURNING id
      `,
      [strategy.experimentId, policyVersionId, inputHash]
    );
    await pool.query(
      `
        INSERT INTO evidence_assessments(
          metric_run_id, rule_version, verdict, reason_codes, thresholds, assessment_hash, created_at
        )
        VALUES (
          $1, 'eval-003-forward-qualification-v1', 'REJECT', ARRAY['LATEST_EVIDENCE_REJECTED'],
          '{}'::jsonb, $2, now() + interval '1 second'
        )
      `,
      [metric.rows[0]?.id, assessmentHash]
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/shannon/execution-candidate?experimentId=${strategy.experimentId}&account=${account}&asset=BTC&intervalSec=3600`,
      headers: { cookie: strategy.cookie }
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "STRATEGY_NOT_QUALIFIED",
        retryable: false
      }
    });
  });

  it("blocks execution candidate construction when the live book has no executable top ask", async () => {
    const app = buildApp(config, {
      ...v2Deps(),
      pool,
      dreamDexClient: futureLiveClient(),
      executionReadinessReader: () => Promise.resolve(executionReadiness)
    });
    const strategy = await createQualifiedForwardStrategy(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/shannon/execution-candidate?experimentId=${strategy.experimentId}&account=${account}&asset=BTC&intervalSec=3600`,
      headers: { cookie: strategy.cookie }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = V2ExecutionCandidateSchema.parse(response.json());
    expect(body.data.executionCandidate.status).toBe("BLOCKED");
    expect(body.data.executionCandidate.unsignedTransactions).toBeNull();
    expect(body.data.executionCandidate.blockedReasons).toContain("POLICY_ABSTAINED");
    expect(body.data.executionCandidate.blockedReasons).toContain("NO_EXECUTABLE_TOP_ASK");
    expect(body.data.executionCandidate.blockedReasons).not.toContain("ORDER_CAP_BELOW_POOL_MINIMUM");
    expect(body.data.executionCandidate.risk.minimumPoolEscrowRaw).toBeNull();
  });

  it("builds a bounded strategy-linked execution candidate without signing or broadcasting", async () => {
    const app = buildApp(config, {
      ...v2Deps(),
      pool,
      dreamDexClient: executionReadyLiveClient(),
      executionReadinessReader: () => Promise.resolve(executionReadiness)
    });
    const strategy = await createQualifiedForwardStrategy(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/shannon/execution-candidate?experimentId=${strategy.experimentId}&account=${account}&asset=BTC&intervalSec=3600`,
      headers: { cookie: strategy.cookie }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = V2ExecutionCandidateSchema.parse(response.json());
    expect(body.data.executionCandidate.status).toBe("READY");
    expect(body.data.executionCandidate.strategyLink).toMatchObject({
      experimentId: strategy.experimentId,
      qualificationVerdict: "STRATEGY_QUALIFIED",
      eligibleForwardObservationCount: 30
    });
    expect(body.data.executionCandidate.blockedReasons).toEqual([]);
    expect(body.data.executionCandidate.risk.serverSigner).toBe(false);
    expect(body.data.executionCandidate.risk.mainnetWrite).toBe(false);
    expect(body.data.executionCandidate.risk.minimumPoolEscrowRaw).toBe("600");
    expect(body.data.executionCandidate.risk.capAdequateForPoolMinimum).toBe(true);
    expect(body.data.executionCandidate.sizing).toMatchObject({
      side: "BUY_YES",
      priceRaw: "600000",
      quantityRaw: "16000"
    });
    expect(body.data.executionCandidate.unsignedTransactions?.order).toMatchObject({
      to: binaryMarket.poolAddress,
      data: "0xccdd"
    });
    expect(body.meta.blockchainWrite).toBe(false);
    expect(body.meta.walletRequired).toBe(true);
  });

  it("can qualify BUY_NO from an inverse no-ask signal when the yes midpoint is unavailable", async () => {
    const app = buildApp(config, {
      ...v2Deps(),
      pool,
      dreamDexClient: noAskExecutionReadyLiveClient(),
      executionReadinessReader: () => Promise.resolve(executionReadiness)
    });
    const strategy = await createQualifiedForwardStrategy(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/shannon/execution-candidate?experimentId=${strategy.experimentId}&account=${account}&asset=BTC&intervalSec=3600`,
      headers: { cookie: strategy.cookie }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = V2ExecutionCandidateSchema.parse(response.json());
    expect(body.data.executionCandidate.status).toBe("READY");
    expect(body.data.executionCandidate.strategyLink.decision.action).toBe("WATCH_ONLY");
    expect(body.data.executionCandidate.strategyLink.decision.forecastPUp).toBeCloseTo(0.4);
    expect(body.data.executionCandidate.strategyLink.decision.reasonCodes).toContain("LIVE_BOOK_ASK_FALLBACK");
    expect(body.data.executionCandidate.strategyLink.decision.reasonCodes).toContain("INVERSE_NO_ASK_SIGNAL");
    expect(body.data.executionCandidate.strategyLink.decision.reasonCodes).toContain("EXECUTABLE_SIDE_BUY_NO");
    expect(body.data.executionCandidate.sizing).toMatchObject({
      side: "BUY_NO",
      priceRaw: "600000",
      quantityRaw: "25000"
    });
    expect(body.data.executionCandidate.blockedReasons).toEqual([]);
  });

  it("keeps controlled-liquidity setup wallet-gated and labels it non-organic", async () => {
    const app = buildApp(config, { ...v2Deps(), dreamDexClient: executionReadyLiveClient() });
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/shannon/controlled-liquidity-candidate?maker=${account}&asset=BTC&intervalSec=3600&quantityRaw=1`
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = V2ControlledLiquidityCandidateSchema.parse(response.json());
    expect(body.data.controlledLiquidityCandidate.status).toBe("BLOCKED");
    expect(body.data.controlledLiquidityCandidate.setup).toBeNull();
    expect(body.data.controlledLiquidityCandidate.risk).toMatchObject({
      controlledLiquidity: true,
      organicLiquidityClaim: false,
      serverSigner: false,
      mainnetWrite: false
    });
    expect(body.data.controlledLiquidityCandidate.blockedReasons).toContain("ORDER_CAP_BELOW_POOL_MINIMUM");
  });

  it("blocks controlled-liquidity setup from the public proof wallet", async () => {
    const proofWallet = "0x6b3a87a4bbf7d7d324df227d640fc42ebf987971";
    const app = buildApp(config, { ...v2Deps(), dreamDexClient: executionReadyLiveClient() });
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/shannon/controlled-liquidity-candidate?maker=${proofWallet}&asset=BTC&intervalSec=3600&quantityRaw=1000`
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = V2ControlledLiquidityCandidateSchema.parse(response.json());
    expect(body.data.controlledLiquidityCandidate.status).toBe("BLOCKED");
    expect(body.data.controlledLiquidityCandidate.setup).toBeNull();
    expect(body.data.controlledLiquidityCandidate.blockedReasons).toEqual(["MAKER_MATCHES_PROOF_WALLET"]);
  });

  it("separates cap-too-low sizing from missing-liquidity blockers", async () => {
    const app = buildApp(config, {
      ...v2Deps(),
      pool,
      dreamDexClient: capTooLowExecutionClient(),
      executionReadinessReader: () => Promise.resolve(executionReadiness)
    });
    const strategy = await createQualifiedForwardStrategy(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/shannon/execution-candidate?experimentId=${strategy.experimentId}&account=${account}&asset=BTC&intervalSec=3600`,
      headers: { cookie: strategy.cookie }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = V2ExecutionCandidateSchema.parse(response.json());
    expect(body.data.executionCandidate.status).toBe("BLOCKED");
    expect(body.data.executionCandidate.blockedReasons).toEqual(["ORDER_CAP_BELOW_POOL_MINIMUM"]);
    expect(body.data.executionCandidate.risk.minimumPoolEscrowRaw).toBe("12000");
    expect(body.data.executionCandidate.risk.minimumPoolEscrowDisplay).toBe("0.012 tUSDC");
    expect(body.data.executionCandidate.risk.capAdequateForPoolMinimum).toBe(false);
    expect(body.data.executionCandidate.unsignedTransactions).toBeNull();
  });

  it("imports a wallet-submitted strategy execution receipt after Shannon RPC verification", async () => {
    const originalFetch = globalThis.fetch;
    let approvalPending = true;
    let redemptionAvailable = false;
    const approvalTxHash = `0x${"8".repeat(64)}`;
    const txHash = `0x${"9".repeat(64)}`;
    const redemptionTxHash = `0x${"6".repeat(64)}`;
    const redemptionEventAbi = parseAbi([
      "event Redeemed(uint256 indexed marketKey, address indexed holder, address indexed to, uint8 outcomeIdx, uint256 amountBurned, uint256 collateralOut)"
    ]);
    const redemptionLog = {
      address: `0x${"6".repeat(40)}`,
      topics: encodeEventTopics({
        abi: redemptionEventAbi,
        eventName: "Redeemed",
        args: { marketKey: 1n, holder: account, to: account }
      }),
      data: encodeAbiParameters(
        [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }],
        [0, 16000n, 15900n]
      ),
      logIndex: "0x0"
    };
    const placedLog = {
      data:
        ["0x", "00000000000000000000000000000000", "0000000000000000000000000000007b", "00000000000000000000000000000000", "00000000000000000000000000000001", "00000000000000000000000077777777", "77777777777777777777777777777777", "00000000000000000000000000000000", "00000000000000000000000000000000", "00000000000000000000000000000000", "000000000000000000000000000927c0", "00000000000000000000000000000000", "00000000000000000000000000003e80", "00000000000000000000000000000000", "00000000000000000000000000003e80", "00000000000000000000000000000000", "000000000000000038eecfcf56a60000"].join(""),
      topics: [
        ["0x", "d90f62f61ee2f606b132cfdfd883ddd0", "79228b6fd6bffd9d7cf848daf824639d"].join(""),
        ["0x", "00000000000000000000000000000000", "0000000000000000000000000000007b"].join("")
      ]
    };
    const unrelatedExpiredLog = {
      data: "0x",
      topics: encodeEventTopics({
        abi: orderBookEventsAbi,
        eventName: "OrderExpired",
        args: { orderId: 999n }
      })
    };
    const app = buildApp(config, {
      ...v2Deps(),
      pool,
      dreamDexClient: {
        ...executionReadyLiveClient(),
        getRouterActions() {
          return Promise.resolve(redemptionAvailable ? [{
            id: "101_0",
            kind: "Redeem" as const,
            account,
            market: binaryMarket.marketId,
            amount: "16000",
            payout: "15900",
            routedVia: null,
            timestamp: String(Math.ceil(Date.now() / 1000) + 5),
            txHash: redemptionTxHash
          }] : []);
        }
      },
      executionReadinessReader: () => Promise.resolve(executionReadiness)
    });
    const strategy = await createQualifiedForwardStrategy(app);
    const revalidated = await app.inject({
      method: "POST",
      url: "/api/v2/shannon/execution-candidates/revalidate",
      headers: {
        cookie: strategy.cookie,
        "x-csrf-token": strategy.csrfToken,
        "idempotency-key": `candidate-revalidate-${crypto.randomUUID()}`
      },
      payload: { experimentId: strategy.experimentId, account, asset: "BTC", intervalSec: 3600 }
    });
    expect(revalidated.statusCode).toBe(201);
    const candidate = V2ExecutionCandidateSchema.parse(revalidated.json()).data.executionCandidate;
    const rpcFetch = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as { readonly method: string; readonly params: readonly string[] };
      const isApproval = body.params[0] === approvalTxHash;
      const isRedemption = body.params[0] === redemptionTxHash;
      const result =
        body.method === "eth_getTransactionByHash"
          ? {
              from: account,
              to: isRedemption
                ? `0x${"6".repeat(40)}`
                : isApproval ? candidate.unsignedTransactions?.approval?.to : candidate.unsignedTransactions?.order.to,
              input: isRedemption
                ? "0xdeadbeef"
                : isApproval ? candidate.unsignedTransactions?.approval?.data : candidate.unsignedTransactions?.order.data,
              value: "0x0",
              nonce: isRedemption ? "0x2b" : isApproval ? "0x29" : "0x2a"
            }
          : isApproval && approvalPending
            ? null
            : {
              status: "0x1",
              blockNumber: isRedemption ? "0x65" : "0x64",
              logs: isRedemption
                ? [redemptionLog]
                : isApproval
                ? []
                : [
                    { address: binaryMarket.poolAddress, ...unrelatedExpiredLog, logIndex: "0x0" },
                    { address: binaryMarket.poolAddress, data: placedLog.data, topics: placedLog.topics, logIndex: "0x1" }
                  ]
            };
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
    globalThis.fetch = rpcFetch;
    const approvalResponse = await app.inject({
      method: "POST",
      url: "/api/v2/shannon/execution-receipts",
      headers: {
        cookie: strategy.cookie,
        "x-csrf-token": strategy.csrfToken,
        "idempotency-key": "strategy-approval-import-test"
      },
      payload: { intentHash: candidate.intentHash, txHash: approvalTxHash, txRole: "approval" }
    });
    const pendingApproval = V2ExecutionReceiptSchema.parse(approvalResponse.json()).data.executionReceipt;
    approvalPending = false;
    const approvalReconcileResponse = await app.inject({
      method: "POST",
      url: `/api/v2/execution-intents/${pendingApproval.intentId}/reconcile`,
      headers: {
        cookie: strategy.cookie,
        "x-csrf-token": strategy.csrfToken,
        "idempotency-key": "strategy-approval-reconcile-test"
      },
      payload: {}
    });
    const orderRevalidationResponse = await app.inject({
      method: "POST",
      url: `/api/v2/execution-intents/${pendingApproval.intentId}/revalidate-order`,
      headers: {
        cookie: strategy.cookie,
        "x-csrf-token": strategy.csrfToken,
        "idempotency-key": "strategy-order-signing-revalidation-test"
      },
      payload: {}
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/shannon/execution-receipts",
      headers: {
        cookie: strategy.cookie,
        "x-csrf-token": strategy.csrfToken,
        "idempotency-key": "strategy-execution-import-test"
      },
      payload: { intentHash: candidate.intentHash, txHash, txRole: "order" }
    });
    const receiptBody = V2ExecutionReceiptSchema.parse(response.json());
    const reconciledResponse = await app.inject({
      method: "POST",
      url: `/api/v2/execution-intents/${receiptBody.data.executionReceipt.intentId}/reconcile`,
      headers: {
        cookie: strategy.cookie,
        "x-csrf-token": strategy.csrfToken,
        "idempotency-key": "strategy-execution-reconcile-test"
      },
      payload: {}
    });
    const experimentExecutionResponse = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${strategy.experimentId}/execution`,
      headers: { cookie: strategy.cookie }
    });
    await pool.query(
      `
        INSERT INTO order_evidence(
          tx_hash, order_id, state, quantity_raw, remaining_quantity_raw,
          evidence_source, observed_at, payload
        )
        VALUES ($1, '123', 'ORDER_VERIFIED', 16000, 16000,
          'DREAMDEX_INDEXER', now() + interval '1 second', '{"delayedIndexerStatus":"Open"}'::jsonb)
      `,
      [txHash]
    );
    const afterDelayedOpenIndexerResponse = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${strategy.experimentId}/execution`,
      headers: { cookie: strategy.cookie }
    });
    const activeIntentHash = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const activeTxHash = `0x${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const activeInputHash = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const activeIntent = await pool.query<{ id: string }>(
      `
        INSERT INTO execution_intents(
          owner_address, experiment_id, assessment_id, policy_version_id,
          market_id, chain_id, intent_type, state, pool_address, side,
          price_raw, quantity_raw, escrow_raw, expires_at, caps,
          idempotency_key, intent_hash, candidate_snapshot_hash,
          candidate_payload, last_validated_at
        )
        SELECT
          owner_address, experiment_id, assessment_id, policy_version_id,
          market_id || '-active-test', chain_id, intent_type, 'ORDER_VERIFIED', pool_address, side,
          price_raw, quantity_raw, escrow_raw, expires_at, caps,
          $1, $2, candidate_snapshot_hash, candidate_payload, last_validated_at
        FROM execution_intents
        WHERE intent_hash = $3
        RETURNING id
      `,
      [`active-order-${crypto.randomUUID()}`, activeIntentHash, candidate.intentHash]
    );
    await pool.query(
      `
        INSERT INTO chain_transactions(
          tx_hash, intent_id, chain_id, from_address, nonce, receipt_status,
          block_number, verified_at, payload, tx_role, transaction_input_hash
        )
        VALUES ($1, $2, 50312, $3, 43, true, 101, now(), '{}'::jsonb, 'order', $4)
      `,
      [activeTxHash, activeIntent.rows[0]?.id, account, activeInputHash]
    );
    await pool.query(
      `
        INSERT INTO order_evidence(
          tx_hash, order_id, state, quantity_raw, remaining_quantity_raw,
          evidence_source, observed_at, payload
        )
        VALUES ($1, '456', 'ORDER_VERIFIED', 16000, 16000, 'SHANNON_RPC', now(), '{}'::jsonb)
      `,
      [activeTxHash]
    );
    const activeOrderResponse = await app.inject({
      method: "GET",
      url: `/api/v2/execution-intents/${activeIntent.rows[0]?.id ?? "missing"}`,
      headers: { cookie: strategy.cookie }
    });
    await pool.query(
      `
        INSERT INTO order_evidence(
          tx_hash, order_id, state, quantity_raw, remaining_quantity_raw,
          evidence_source, observed_at, payload
        )
        VALUES ($1, '456', 'FILLED', 16000, 0, 'DREAMDEX_INDEXER', now(), '{}'::jsonb)
      `,
      [activeTxHash]
    );
    await pool.query(
      "UPDATE execution_intents SET reconciliation_payload = '{\"claimableAmountRaw\":\"16000\"}'::jsonb WHERE id = $1",
      [activeIntent.rows[0]?.id]
    );
    redemptionAvailable = true;
    const redeemedResponse = await app.inject({
      method: "POST",
      url: `/api/v2/execution-intents/${activeIntent.rows[0]?.id ?? "missing"}/reconcile`,
      headers: {
        cookie: strategy.cookie,
        "x-csrf-token": strategy.csrfToken,
        "idempotency-key": "strategy-redemption-reconcile-test"
      },
      payload: {}
    });
    const retriedRedeemedResponse = await app.inject({
      method: "POST",
      url: `/api/v2/execution-intents/${activeIntent.rows[0]?.id ?? "missing"}/reconcile`,
      headers: {
        cookie: strategy.cookie,
        "x-csrf-token": strategy.csrfToken,
        "idempotency-key": "strategy-redemption-reconcile-retry-test"
      },
      payload: {}
    });
    const redemptionRows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chain_transactions WHERE intent_id = $1 AND tx_role = 'redeem'",
      [activeIntent.rows[0]?.id]
    );
    await app.close();
    globalThis.fetch = originalFetch;

    expect(approvalResponse.statusCode).toBe(202);
    expect(pendingApproval.status).toBe("TX_PENDING");
    expect(pendingApproval.receiptStatus).toBeNull();
    expect(approvalReconcileResponse.statusCode).toBe(200);
    expect(orderRevalidationResponse.statusCode).toBe(200);
    expect(V2ExecutionLifecycleSchema.parse(approvalReconcileResponse.json()).data.executionLifecycle?.transactions.approval?.state).toBe("CONFIRMED");
    expect(response.statusCode).toBe(201);
    const body = receiptBody;
    expect(body.data.executionReceipt).toMatchObject({
      status: "UNFILLED",
      intentHash: candidate.intentHash,
      txHash,
      txRole: "order",
      receiptStatus: true,
      blockNumber: "100",
      lifecycleDecoded: true,
      order: {
        orderId: "123",
        state: "UNFILLED",
        requestedQuantityRaw: "16000",
        filledQuantityRaw: "0",
        remainingQuantityRaw: "16000",
        fillState: "NO_FILL",
        terminal: true,
        fillCount: 0
      }
    });
    expect(reconciledResponse.statusCode).toBe(200);
    expect(experimentExecutionResponse.statusCode).toBe(200);
    const lifecycle = V2ExecutionLifecycleSchema.parse(experimentExecutionResponse.json()).data.executionLifecycle;
    expect(lifecycle).toMatchObject({
      experimentId: strategy.experimentId,
      qualification: { verdict: "STRATEGY_QUALIFIED" },
      transactions: {
        approval: { txHash: approvalTxHash, state: "CONFIRMED" },
        order: { txHash, state: "CONFIRMED" },
        redeem: null
      },
      order: {
        orderId: "123",
        state: "UNFILLED",
        fillState: "NO_FILL"
      },
      settlement: { state: "NOT_APPLICABLE" },
      redemption: { state: "NOT_APPLICABLE" },
      publicClaim: "CONFIRMED_NO_FILL"
    });
    expect(V2ExecutionLifecycleSchema.parse(afterDelayedOpenIndexerResponse.json()).data.executionLifecycle).toMatchObject({
      order: { state: "UNFILLED", fillState: "NO_FILL" },
      publicClaim: "CONFIRMED_NO_FILL"
    });
    expect(activeOrderResponse.statusCode).toBe(200);
    expect(V2ExecutionLifecycleSchema.parse(activeOrderResponse.json()).data.executionLifecycle).toMatchObject({
      order: { state: "ORDER_VERIFIED", fillState: "UNKNOWN" },
      publicClaim: "EXECUTION_NOT_YET_PROVEN"
    });
    expect(redeemedResponse.statusCode).toBe(200);
    expect(V2ExecutionLifecycleSchema.parse(redeemedResponse.json()).data.executionLifecycle).toMatchObject({
      state: "REDEEMED",
      transactions: { redeem: { txHash: redemptionTxHash, state: "CONFIRMED" } },
      order: { state: "FILLED", fillState: "FULL_FILL" },
      redemption: {
        state: "REDEEMED",
        redeemedQuantityRaw: "16000",
        actualPayoutRaw: "15900",
        evidenceSource: "DREAMDEX_REDEEMED_EVENT_AND_SHANNON_RPC"
      },
      publicClaim: "CONFIRMED_FULL_FILL"
    });
    expect(retriedRedeemedResponse.statusCode).toBe(200);
    expect(V2ExecutionLifecycleSchema.parse(retriedRedeemedResponse.json()).data.executionLifecycle?.redemption.state).toBe("REDEEMED");
    expect(redemptionRows.rows[0]?.count).toBe("1");
    expect(rpcFetch).toHaveBeenCalledTimes(8);
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
    const app = buildApp(config, { ...v2Deps(), dreamDexClient: decisionWindowLiveClient(), pool });
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
    const reconciled = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/live-shadow/reconcile`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-live-reconcile-002"
      }
    });
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
    expect(reconciled.statusCode).toBe(200);
    expect(V2LiveShadowSchema.parse(reconciled.json()).data.liveShadow).toMatchObject({
      decisionCount: 1,
      eligibleDecisionCount: 0,
      pendingOutcomeCount: 1
    });
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
