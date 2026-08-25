export interface EvidenceSummary {
  readonly ok: true;
  readonly counts: {
    readonly experiments: number;
    readonly episodes: number;
    readonly snapshots: number;
    readonly decisions: number;
    readonly settlements: number;
    readonly metricRuns: number;
    readonly assessments: number;
  };
  readonly chain: {
    readonly submittedOrderCount: number;
    readonly fillCount: number;
    readonly terminalOrderCount: number;
    readonly openOrderCount: number;
    readonly latestTerminalState: string | null;
    readonly tradeabilityStatus: "NOT_EVALUATED" | "EVALUATED";
  };
}

export interface ProofRow {
  readonly label: string;
  readonly value: string;
  readonly href: string | null;
}

export const capturedSummary: EvidenceSummary = {
  ok: true,
  counts: {
    experiments: 0,
    episodes: 0,
    snapshots: 0,
    decisions: 0,
    settlements: 0,
    metricRuns: 0,
    assessments: 0
  },
  chain: {
    submittedOrderCount: 1,
    fillCount: 0,
    terminalOrderCount: 1,
    openOrderCount: 0,
    latestTerminalState: "EXPIRED",
    tradeabilityStatus: "EVALUATED"
  }
};

export const minimumSample = 30;
export const explorerBase = "https://shannon-explorer.somnia.network";
export const proofWalletAddress = ["0x6b3a87a4bbf7", "d7d324df227d", "640fc42ebf987971"].join("");

export const proofRows: readonly ProofRow[] = [
  {
    label: "Wallet",
    value: "0x6b3a...7971",
    href: `${explorerBase}/address/${proofWalletAddress}`
  },
  {
    label: "Approval",
    value: "0xeb2c...5312",
    href: `${explorerBase}/tx/${[
      "0xeb2ce83146e757b",
      "8bb5b204e01b711d2",
      "e9dd479a35fc336d",
      "ef101c722e905312"
    ].join("")}`
  },
  {
    label: "Order",
    value: "0x666d...4196",
    href: `${explorerBase}/tx/${[
      "0x666d5d5a5dc95914",
      "ef6ae14684d96405",
      "5f936bf52c199658",
      "50ed1c773b954196"
    ].join("")}`
  },
  {
    label: "Terminal",
    value: "0x9405...02fd",
    href: `${explorerBase}/tx/${[
      "0x94057033d8cd59cd",
      "1c58a6efa21d25cc",
      "7dc00c4eb0a0a0ea",
      "a2cfefb860ab02fd"
    ].join("")}`
  },
  {
    label: "Order ID",
    value: "110680464442257591736",
    href: null
  }
];

export const policyRows = [
  {
    name: "Watch-only calibration",
    version: "reference-a/1.0.0",
    action: "WATCH_ONLY",
    observations: 0,
    calibration: "NOT AVAILABLE",
    tradeability: "shared Shannon probe verified",
    risk: "bounded",
    pnl: "NOT AVAILABLE",
    promotion: "not evaluated"
  },
  {
    name: "Neutral abstain baseline",
    version: "reference-b/1.0.0",
    action: "ABSTAIN",
    observations: 0,
    calibration: "NOT AVAILABLE",
    tradeability: "shared Shannon probe verified",
    risk: "bounded",
    pnl: "NOT AVAILABLE",
    promotion: "not evaluated"
  }
] as const;

export const capturedSummarySource = "CAPTURED" as const;
