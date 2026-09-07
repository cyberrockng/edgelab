import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExecutionLifecycleSummary } from "../components/ExecutionLifecycleSummary.js";
import { QualificationJourney, type QualificationJourneyStage } from "../components/QualificationJourney.js";
import {
  apiErrorMessage,
  compactId,
  fetchControlledLiquidityCandidate,
  fetchExecutionCandidate,
  importExecutionReceipt,
  reconcileExecutionIntent,
  revalidateExecutionCandidate,
  revalidateExecutionOrder,
  type ControlledLiquidityCandidateResponse,
  type ExecutionCandidateResponse
} from "../data.js";

const defaultAccount = "0x6b3a87a4bbf7d7d324df227d640fc42ebf987971";
const shannonChainHex = "0xc488";
const watchTracks = [
  { asset: "BTC" as const, intervalSec: 900 as const, label: "BTC 15m" },
  { asset: "BTC" as const, intervalSec: 3600 as const, label: "BTC 1h" },
  { asset: "ETH" as const, intervalSec: 900 as const, label: "ETH 15m" },
  { asset: "ETH" as const, intervalSec: 3600 as const, label: "ETH 1h" }
];

interface EthereumProvider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
    okxwallet?: EthereumProvider;
  }
}

function walletProvider(): EthereumProvider | undefined {
  return window.okxwallet ?? window.ethereum;
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isTxHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function callForWallet(call: {
  readonly to: string;
  readonly data: string;
  readonly valueRaw: string;
}, from: string) {
  return {
    from,
    to: call.to,
    data: call.data,
    value: `0x${BigInt(call.valueRaw).toString(16)}`
  };
}

async function walletRequest<T>(
  args: { readonly method: string; readonly params?: readonly unknown[] },
  label: string,
  timeoutMs = 30_000
): Promise<T> {
  const provider = walletProvider();
  if (provider === undefined) {
    throw new Error("No OKX-compatible injected wallet provider was found.");
  }
  let timer: number | undefined;
  try {
    return await Promise.race([
      provider.request(args) as Promise<T>,
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`${label} did not respond. Unlock OKX, close any stale wallet popup, then try again.`));
        }, timeoutMs);
      })
    ]).catch((error: unknown) => {
      const walletError = error as { readonly code?: number; readonly message?: string };
      const message = walletError.message?.toLowerCase() ?? "";
      if (walletError.code === 4001 || message.includes("user rejected") || message.includes("user denied")) {
        throw new Error(`${label} was rejected in OKX Wallet. No transaction was submitted.`);
      }
      if (walletError.code === -32002) {
        throw new Error(`${label} is already pending. Open OKX Wallet and resolve or dismiss the stale request.`);
      }
      if (message.includes("insufficient funds") || message.includes("insufficient balance")) {
        throw new Error(`${label} cannot proceed because the wallet lacks STT for gas or tUSDC collateral.`);
      }
      if (walletError.code === 4100 || message.includes("unauthorized") || message.includes("wallet is locked")) {
        throw new Error(`${label} requires an unlocked, connected OKX Wallet account.`);
      }
      if (walletError.code === 4902 || message.includes("unrecognized chain") || message.includes("unknown chain")) {
        throw new Error(`${label} requires Somnia Shannon chain 50312 to be configured in OKX Wallet.`);
      }
      throw error;
    });
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

async function waitForWalletReceipt(txHash: string, label: string, timeoutMs = 120_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await walletRequest<unknown>(
      { method: "eth_getTransactionReceipt", params: [txHash] },
      `${label} receipt check`,
      15_000
    );
    if (receipt !== null && typeof receipt === "object") {
      const status = (receipt as { readonly status?: string }).status;
      if (status === "0x0") {
        throw new Error(`${label} reverted on Somnia Shannon. No subsequent transaction was requested.`);
      }
      if (status === "0x1") {
        return;
      }
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1_500));
  }
  throw new Error(`${label} is still pending after two minutes. Keep the transaction hash and retry reconciliation later.`);
}

async function waitForServerConfirmation(
  intentId: string,
  txRole: "approval" | "order",
  timeoutMs = 60_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const lifecycle = (await reconcileExecutionIntent(intentId)).data.executionLifecycle;
    const transaction = lifecycle?.transactions[txRole];
    if (transaction?.state === "CONFIRMED") {
      return;
    }
    if (transaction?.state === "REVERTED") {
      throw new Error(`${txRole === "approval" ? "Approval" : "Order"} transaction reverted on Somnia Shannon.`);
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1_500));
  }
  throw new Error("The transaction is confirmed in the wallet but the server RPC has not reconciled it yet. Retry reconciliation later.");
}

async function connectWallet(): Promise<string> {
  const accounts = await walletRequest<unknown>({ method: "eth_requestAccounts" }, "Wallet connection");
  const account = Array.isArray(accounts) ? accounts.find(isAddress) : null;
  if (account === null || account === undefined) {
    throw new Error("Wallet did not return an account.");
  }
  return account;
}

async function ensureShannonNetwork(): Promise<void> {
  const current = await walletRequest<unknown>({ method: "eth_chainId" }, "Wallet network check", 15_000);
  if (current === shannonChainHex) {
    return;
  }
  await walletRequest(
    {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: shannonChainHex }]
    },
    "Wallet network switch"
  );
  const switched = await walletRequest<unknown>({ method: "eth_chainId" }, "Wallet network confirmation", 15_000);
  if (switched !== shannonChainHex) {
    throw new Error("OKX Wallet did not switch to Somnia Shannon chain 50312. Switch networks manually, then retry.");
  }
}

async function requireSelectedAccount(expectedAccount: string): Promise<void> {
  const accounts = await walletRequest<unknown>({ method: "eth_accounts" }, "Wallet account check", 15_000);
  const selected = Array.isArray(accounts) ? accounts.find(isAddress) : null;
  if (selected === null || selected === undefined) {
    throw new Error("OKX Wallet is locked or disconnected. Unlock it, then connect the intended proof account.");
  }
  if (selected.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error(`OKX Wallet is using ${selected}; switch to the candidate account ${expectedAccount}.`);
  }
}

type Candidate = ExecutionCandidateResponse["executionCandidate"];
type ControlledLiquidityCandidate = ControlledLiquidityCandidateResponse["controlledLiquidityCandidate"];
type WatchTrack = (typeof watchTracks)[number];

type WatchSample =
  | {
      readonly observedAt: string;
      readonly track: WatchTrack;
      readonly status: "READY" | "BLOCKED";
      readonly candidate: Candidate;
    }
  | {
      readonly observedAt: string;
      readonly track: WatchTrack;
      readonly status: "ERROR";
      readonly message: string;
    };

async function sendAndImport(input: {
  readonly experimentId: string;
  readonly account: string;
  readonly asset: "BTC" | "ETH";
  readonly intervalSec: 900 | 3600;
}) {
  if (walletProvider() === undefined) {
    throw new Error("No OKX-compatible injected wallet provider was found.");
  }
  await requireSelectedAccount(input.account);
  await ensureShannonNetwork();
  const fresh = await revalidateExecutionCandidate(input);
  const candidate = fresh.data.executionCandidate;
  if (candidate.status !== "READY" || candidate.unsignedTransactions === null) {
    throw new Error("Fresh market revalidation closed the execution gate. Prepare a new candidate.");
  }
  if (candidate.account.toLowerCase() !== input.account.toLowerCase()) {
    throw new Error("Fresh candidate account does not match the selected wallet.");
  }
  const sent: string[] = [];
  const common = { intentHash: candidate.intentHash };
  if (candidate.unsignedTransactions.approval !== null) {
    const approvalHash = await walletRequest<unknown>(
      {
        method: "eth_sendTransaction",
        params: [callForWallet(candidate.unsignedTransactions.approval, candidate.account)]
      },
      "Approval transaction"
    );
    if (!isTxHash(approvalHash)) {
      throw new Error("Wallet did not return an approval transaction hash.");
    }
    sent.push(approvalHash);
    const imported = await importExecutionReceipt({ ...common, txHash: approvalHash, txRole: "approval" });
    if (imported.data.executionReceipt.status === "TX_REVERTED") {
      throw new Error("Exact tUSDC approval reverted on Somnia Shannon. The order was not requested.");
    }
    if (imported.data.executionReceipt.status === "TX_PENDING") {
      await waitForWalletReceipt(approvalHash, "Exact tUSDC approval");
      await waitForServerConfirmation(fresh.data.intentId, "approval");
    }
  }
  await requireSelectedAccount(candidate.account);
  await ensureShannonNetwork();
  const signingFresh = await revalidateExecutionOrder(fresh.data.intentId);
  const signingCandidate = signingFresh.data.executionCandidate;
  if (signingCandidate.status !== "READY" || signingCandidate.unsignedTransactions === null) {
    throw new Error("Signing-time revalidation closed the execution gate. Prepare a new candidate.");
  }
  const orderHash = await walletRequest<unknown>(
    {
      method: "eth_sendTransaction",
      params: [callForWallet(signingCandidate.unsignedTransactions.order, signingCandidate.account)]
    },
    "Order transaction"
  );
  if (!isTxHash(orderHash)) {
    throw new Error("Wallet did not return an order transaction hash.");
  }
  sent.push(orderHash);
  const importedOrder = await importExecutionReceipt({ ...common, txHash: orderHash, txRole: "order" });
  if (importedOrder.data.executionReceipt.status === "TX_REVERTED") {
    throw new Error("Bounded IOC order reverted on Somnia Shannon.");
  }
  if (importedOrder.data.executionReceipt.status === "TX_PENDING") {
    await waitForWalletReceipt(orderHash, "Bounded IOC order");
    await waitForServerConfirmation(fresh.data.intentId, "order");
  }
  const final = await reconcileExecutionIntent(fresh.data.intentId);
  return { hashes: sent, lifecycle: final.data.executionLifecycle };
}

async function sendControlledLiquiditySetup(candidate: ControlledLiquidityCandidate): Promise<string[]> {
  if (walletProvider() === undefined) {
    throw new Error("No OKX-compatible injected wallet provider was found.");
  }
  if (candidate.status !== "READY" || candidate.setup === null) {
    throw new Error("Controlled liquidity candidate is not ready.");
  }
  await requireSelectedAccount(candidate.maker);
  await ensureShannonNetwork();
  const sent: string[] = [];
  for (const call of candidate.setup.calls) {
    const txHash = await walletRequest<unknown>(
      {
        method: "eth_sendTransaction",
        params: [callForWallet(call, candidate.maker)]
      },
      call.description
    );
    if (!isTxHash(txHash)) {
      throw new Error("Wallet did not return a setup transaction hash.");
    }
    sent.push(txHash);
    await waitForWalletReceipt(txHash, call.description);
  }
  return sent;
}

export default function ExecutionCandidatePage() {
  const initialSearchParams = new URLSearchParams(window.location.search);
  const requestedAsset = initialSearchParams.get("asset");
  const requestedInterval = Number(initialSearchParams.get("intervalSec"));
  const [experimentId, setExperimentId] = useState(
    () => initialSearchParams.get("experimentId") ?? ""
  );
  const [account, setAccount] = useState(defaultAccount);
  const [asset, setAsset] = useState<"BTC" | "ETH">(
    requestedAsset === "ETH" ? "ETH" : "BTC"
  );
  const [intervalSec, setIntervalSec] = useState<900 | 3600>(
    requestedInterval === 3600 ? 3600 : 900
  );
  const [watchEnabled, setWatchEnabled] = useState(false);
  const [watchSamples, setWatchSamples] = useState<readonly WatchSample[]>([]);
  const [watchTrackIndex, setWatchTrackIndex] = useState(0);
  const [maker, setMaker] = useState("");
  const [liquiditySide, setLiquiditySide] = useState<"SELL_YES" | "SELL_NO">("SELL_YES");
  const [liquidityPriceRaw, setLiquidityPriceRaw] = useState("600000");
  const [liquidityQuantityRaw, setLiquidityQuantityRaw] = useState("1000");
  const candidateMutation = useMutation({
    mutationFn: () => fetchExecutionCandidate({ experimentId, account, asset, intervalSec })
  });
  const walletMutation = useMutation({
    mutationFn: connectWallet,
    onSuccess(nextAccount) {
      setAccount(nextAccount);
    }
  });
  const submitMutation = useMutation({
    mutationFn: () => {
      return sendAndImport({ experimentId, account, asset, intervalSec });
    }
  });
  const controlledLiquidityMutation = useMutation({
    mutationFn: () =>
      fetchControlledLiquidityCandidate({
        maker,
        asset,
        intervalSec,
        side: liquiditySide,
        priceRaw: liquidityPriceRaw,
        quantityRaw: liquidityQuantityRaw
      })
  });
  const controlledSubmitMutation = useMutation({
    mutationFn: () => {
      const controlled = controlledLiquidityMutation.data?.data.controlledLiquidityCandidate;
      if (controlled === undefined) {
        throw new Error("Prepare controlled liquidity first.");
      }
      return sendControlledLiquiditySetup(controlled);
    }
  });
  const candidate = candidateMutation.data?.data.executionCandidate;
  const controlledCandidate = controlledLiquidityMutation.data?.data.controlledLiquidityCandidate;
  const currentWatchSample = watchSamples[0];
  const strategyQualified = candidate?.strategyLink.qualificationVerdict === "STRATEGY_QUALIFIED";
  const executionJourney: readonly QualificationJourneyStage[] = [
    {
      title: "Strategy + exact policy",
      status: experimentId.length === 36 ? "IDENTIFIED" : "REQUIRED",
      detail: "Candidate requests bind to one persisted forward experiment.",
      state: experimentId.length === 36 ? "complete" : "current"
    },
    {
      title: "Forward qualification",
      status: strategyQualified ? "QUALIFIED" : candidate === undefined ? "NOT CHECKED" : "NOT EARNED",
      detail: "The server verifies the deterministic assessment before market checks.",
      state: strategyQualified ? "complete" : candidate === undefined ? "current" : "locked"
    },
    {
      title: "Fresh executable market",
      status: candidate?.status ?? "LOCKED",
      detail: "Book, pool, expiry, collateral, funds and cap must all pass now.",
      state: candidate?.status === "READY" ? "current" : "locked"
    },
    {
      title: "OKX authorization",
      status: submitMutation.isSuccess ? "AUTHORIZED" : candidate?.status === "READY" ? "AVAILABLE" : "LOCKED",
      detail: "The browser wallet reviews every exact unsigned Shannon call.",
      state: submitMutation.isSuccess ? "complete" : candidate?.status === "READY" ? "current" : "locked"
    },
    {
      title: "Receipt + reconciliation",
      status: submitMutation.isSuccess ? "IMPORTED" : "UNPROVEN",
      detail: "Order, fill, settlement and redemption evidence are reconciled later.",
      state: submitMutation.isSuccess ? "current" : "unproven"
    }
  ];

  useEffect(() => {
    if (!watchEnabled) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const track = watchTracks[watchTrackIndex % watchTracks.length];
      if (track === undefined) {
        return;
      }
      fetchExecutionCandidate({ experimentId, account, asset: track.asset, intervalSec: track.intervalSec })
        .then((response) => {
          if (cancelled) {
            return;
          }
          const nextSample: WatchSample = {
            observedAt: new Date().toISOString(),
            track,
            status: response.data.executionCandidate.status,
            candidate: response.data.executionCandidate
          };
          setWatchSamples((samples) => [nextSample, ...samples].slice(0, 24));
          if (nextSample.status === "READY") {
            setAsset(track.asset);
            setIntervalSec(track.intervalSec);
            setWatchEnabled(false);
          } else {
            setWatchTrackIndex((index) => index + 1);
          }
        })
        .catch((error: unknown) => {
          if (cancelled) {
            return;
          }
          const nextSample: WatchSample = {
            observedAt: new Date().toISOString(),
            track,
            status: "ERROR",
            message: apiErrorMessage(error)
          };
          setWatchSamples((samples) => [nextSample, ...samples].slice(0, 24));
          setWatchTrackIndex((index) => index + 1);
        });
    }, watchSamples.length === 0 ? 250 : 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [account, experimentId, watchEnabled, watchSamples.length, watchTrackIndex]);

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Execution Candidate</p>
        <h1>Strategy-linked order bytes, without server custody.</h1>
        <p>
          EdgeLab can prepare a bounded Shannon testnet candidate only after live market
          data and the forward strategy agree. The server never signs or broadcasts it.
        </p>
      </section>

      <QualificationJourney
        stages={executionJourney}
        title="Execution opens only after qualification"
        description="Account connection may identify the wallet, but no transaction request is available until qualification and every fresh executability check passes."
      />

      <section className="workflowGrid">
        <form
          className="controlPanel"
          aria-label="Execution candidate controls"
          onSubmit={(event) => {
            event.preventDefault();
            submitMutation.reset();
            candidateMutation.mutate();
          }}
        >
          <label>
            Qualified forward experiment ID
            <input
              value={experimentId}
              pattern="^[0-9a-fA-F-]{36}$"
              onChange={(event) => {
                candidateMutation.reset();
                submitMutation.reset();
                setExperimentId(event.target.value);
              }}
              placeholder="Live-shadow experiment UUID"
              required
            />
          </label>
          <label>
            Wallet address
            <input
              value={account}
              pattern="^0x[a-fA-F0-9]{40}$"
              onChange={(event) => {
                setAccount(event.target.value);
              }}
              required
            />
          </label>
          <label>
            Asset
            <select
              value={asset}
              onChange={(event) => {
                candidateMutation.reset();
                submitMutation.reset();
                setAsset(event.target.value as "BTC" | "ETH");
              }}
            >
              <option>BTC</option>
              <option>ETH</option>
            </select>
          </label>
          <label>
            Interval
            <select
              value={intervalSec}
              onChange={(event) => {
                candidateMutation.reset();
                submitMutation.reset();
                setIntervalSec(Number(event.target.value) as 900 | 3600);
              }}
            >
              <option value={900}>15 minutes</option>
              <option value={3600}>1 hour</option>
            </select>
          </label>
          <button type="submit" disabled={candidateMutation.isPending}>
            {candidateMutation.isPending ? "Preparing..." : "Prepare Candidate"}
          </button>
          <button
            type="button"
            className="secondaryAction"
            onClick={() => {
              setWatchEnabled((enabled) => !enabled);
            }}
          >
            {watchEnabled ? "Pause Watcher" : "Watch All Tracks"}
          </button>
          <button
            type="button"
            className="secondaryAction"
            onClick={() => {
              walletMutation.mutate();
            }}
            disabled={walletMutation.isPending}
          >
            {walletMutation.isPending ? "Connecting..." : "Connect OKX Account (No Signing)"}
          </button>
          <p className="formNote">
            Connecting only selects the account. Approval and order prompts remain unavailable until this exact candidate is READY.
          </p>
          {candidateMutation.isError ? <p className="errorText">{apiErrorMessage(candidateMutation.error)}</p> : null}
          {walletMutation.isError ? <p className="errorText">{apiErrorMessage(walletMutation.error)}</p> : null}
        </form>

        <article className="routePanel">
          <span className={candidate?.status === "READY" ? "statusPill pass" : "statusPill"}>
            {candidate?.status ?? "Not prepared"}
          </span>
          <h2>Human-authorized Shannon execution packet.</h2>
          <p>
            Fixed cap: 1 IOC order, 0.01 tUSDC maximum escrow, Somnia Shannon only.
            The exact strategy must first have a STRATEGY_QUALIFIED forward assessment,
            and a wallet must review every approval or order transaction.
          </p>
          <div className={`authorizationNotice ${candidate?.status === "READY" ? "authorizationReady" : "authorizationLocked"}`}>
            <span>{candidate?.status === "READY" ? "Wallet authorization available" : "Wallet transaction gate closed"}</span>
            <strong>
              {candidate?.status === "READY"
                ? "Submission will revalidate once more before OKX shows any transaction."
                : "Your OKX transaction approval is not needed yet."}
            </strong>
            <p>
              {candidate === undefined
                ? "Prepare a qualified strategy-linked candidate to see the current blocking evidence."
                : candidate.status === "READY"
                  ? "Review the exact tUSDC escrow and one bounded Shannon IOC order in the wallet."
                  : "The server returned no executable signing authority; resolve the reported gate reasons first."}
            </p>
          </div>
          {candidate !== undefined ? (
            <dl className="factGrid">
              <div>
                <dt>Qualification</dt>
                <dd>{`${candidate.strategyLink.qualificationVerdict} · ${String(candidate.strategyLink.eligibleForwardObservationCount)} observations`}</dd>
              </div>
              <div>
                <dt>Intent hash</dt>
                <dd>{compactId(candidate.intentHash)}</dd>
              </div>
              <div>
                <dt>Market</dt>
                <dd>{compactId(candidate.market.stableMarketId)}</dd>
              </div>
              <div>
                <dt>Side</dt>
                <dd>{candidate.sizing.side}</dd>
              </div>
              <div>
                <dt>Forecast P(UP)</dt>
                <dd>{`${(candidate.strategyLink.decision.forecastPUp * 100).toFixed(2)}%`}</dd>
              </div>
              <div>
                <dt>Quantity raw</dt>
                <dd>{candidate.sizing.quantityRaw}</dd>
              </div>
              <div>
                <dt>Expiry headroom</dt>
                <dd>{`${String(candidate.risk.expiryHeadroomSeconds)}s`}</dd>
              </div>
              <div>
                <dt>Minimum escrow</dt>
                <dd>{candidate.risk.minimumPoolEscrowDisplay ?? "No executable ask"}</dd>
              </div>
              <div>
                <dt>Cap adequacy</dt>
                <dd>{candidate.risk.capAdequateForPoolMinimum ? "Meets pool minimum" : "Not executable yet"}</dd>
              </div>
              <div>
                <dt>Collateral binding</dt>
                <dd>{candidate.risk.collateralBindingMatches ? "Market and pool agree" : "Mismatch — blocked"}</dd>
              </div>
              <div>
                <dt>Wallet funds</dt>
                <dd>{candidate.risk.walletHasRequiredCollateral && candidate.risk.walletHasGas ? "tUSDC and STT available" : "Funding required"}</dd>
              </div>
            </dl>
          ) : null}
          <button
            type="button"
            className="primaryAction inlineAction"
            disabled={candidate?.status !== "READY" || submitMutation.isPending}
            onClick={() => {
              submitMutation.mutate();
            }}
          >
            {submitMutation.isPending ? "Submitting..." : "Submit Bounded Shannon Order"}
          </button>
          {submitMutation.isError ? <p className="errorText">{apiErrorMessage(submitMutation.error)}</p> : null}
          {submitMutation.isSuccess ? (
            <>
              <p className="successText">
                Imported {String(submitMutation.data.hashes.length)} wallet-submitted transaction receipt
                {submitMutation.data.hashes.length === 1 ? "" : "s"}.
              </p>
              {submitMutation.data.lifecycle === null ? null : (
                <ExecutionLifecycleSummary lifecycle={submitMutation.data.lifecycle} />
              )}
            </>
          ) : null}
        </article>
      </section>

      <section className="routePanel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Readiness Watcher</p>
            <h2>Poll every asset and interval until one earns execution review.</h2>
          </div>
          <span className={currentWatchSample?.status === "READY" ? "statusPill pass" : "statusPill"}>
            {currentWatchSample === undefined
              ? (watchEnabled ? "Watching" : "Idle")
              : currentWatchSample.status === "READY"
                ? "Currently READY — revalidate before signing"
                : currentWatchSample.status}
          </span>
        </div>
        <p>
          The watcher rotates BTC/ETH across 15m and 1h markets, preserving blocked
          reasons and DreamDEX read errors so the proof trail shows why execution did
          or did not happen.
        </p>
        {currentWatchSample?.status === "READY" ? (
          <div className="calloutBox">
            <strong>{currentWatchSample.track.label} is the most recently observed READY track.</strong>
            <span>
              This observation is not signing authority. Submission performs a new server
              revalidation before asking OKX Wallet to approve anything.
            </span>
            <button
              type="button"
              className="secondaryAction"
              onClick={() => {
                candidateMutation.reset();
                submitMutation.reset();
                setAsset(currentWatchSample.track.asset);
                setIntervalSec(currentWatchSample.track.intervalSec);
              }}
            >
              Use Ready Track
            </button>
          </div>
        ) : null}
        <div className="watchTable" role="table" aria-label="Execution readiness watch history">
          <div className="watchRow watchHead" role="row">
            <span role="columnheader">Time</span>
            <span role="columnheader">Track</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Reason</span>
            <span role="columnheader">Qty</span>
          </div>
          {watchSamples.length === 0 ? (
            <div className="watchRow" role="row">
              <span role="cell">-</span>
              <span role="cell">All</span>
              <span role="cell">Idle</span>
              <span role="cell">Start watcher to collect live readiness evidence.</span>
              <span role="cell">-</span>
            </div>
          ) : (
            watchSamples.map((sample) => (
              <div className="watchRow" role="row" key={`${sample.observedAt}-${sample.track.label}`}>
                <span role="cell">{new Date(sample.observedAt).toLocaleTimeString()}</span>
                <span role="cell">{sample.track.label}</span>
                <span role="cell">
                  <span className={sample.status === "READY" ? "statusPill pass" : "statusPill"}>
                    {sample.status}
                  </span>
                </span>
                <span role="cell">
                  {sample.status === "ERROR"
                    ? sample.message
                    : sample.candidate.blockedReasons.length === 0
                      ? "candidate returned unsigned wallet calls"
                      : sample.candidate.blockedReasons.join(", ")}
                </span>
                <span role="cell">
                  {sample.status === "ERROR"
                    ? "-"
                    : `${sample.candidate.sizing.quantityRaw}/${sample.candidate.sizing.minQuantityRaw}`}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="workflowGrid">
        <form
          className="controlPanel"
          aria-label="Controlled liquidity controls"
          onSubmit={(event) => {
            event.preventDefault();
            controlledSubmitMutation.reset();
            controlledLiquidityMutation.mutate();
          }}
        >
          <p className="eyebrow">Controlled Liquidity</p>
          <label>
            Maker wallet address
            <input
              value={maker}
              placeholder="0x..."
              pattern="^0x[a-fA-F0-9]{40}$"
              onChange={(event) => {
                controlledLiquidityMutation.reset();
                controlledSubmitMutation.reset();
                setMaker(event.target.value);
              }}
              required
            />
          </label>
          <label>
            Maker side
            <select
              value={liquiditySide}
              onChange={(event) => {
                controlledLiquidityMutation.reset();
                controlledSubmitMutation.reset();
                setLiquiditySide(event.target.value as "SELL_YES" | "SELL_NO");
              }}
            >
              <option value="SELL_YES">SELL_YES ask</option>
              <option value="SELL_NO">SELL_NO ask</option>
            </select>
          </label>
          <label>
            Price raw
            <input
              value={liquidityPriceRaw}
              inputMode="numeric"
              pattern="^[0-9]+$"
              onChange={(event) => {
                controlledLiquidityMutation.reset();
                controlledSubmitMutation.reset();
                setLiquidityPriceRaw(event.target.value);
              }}
              required
            />
          </label>
          <label>
            Quantity raw
            <input
              value={liquidityQuantityRaw}
              inputMode="numeric"
              pattern="^[0-9]+$"
              onChange={(event) => {
                controlledLiquidityMutation.reset();
                controlledSubmitMutation.reset();
                setLiquidityQuantityRaw(event.target.value);
              }}
              required
            />
          </label>
          <button type="submit" disabled={controlledLiquidityMutation.isPending}>
            {controlledLiquidityMutation.isPending ? "Preparing..." : "Prepare Liquidity Setup"}
          </button>
          {controlledLiquidityMutation.isError ? (
            <p className="errorText">{apiErrorMessage(controlledLiquidityMutation.error)}</p>
          ) : null}
        </form>

        <article className="routePanel">
          <span className={controlledCandidate?.status === "READY" ? "statusPill pass" : "statusPill"}>
            {controlledCandidate?.status ?? "Not prepared"}
          </span>
          <h2>Setup a takable ask with a separate maker wallet.</h2>
          <p>
            This is controlled testnet liquidity, not organic demand. The maker mints
            a complete set, grants pool escrow authority for outcome tokens, then rests
            one post-only sell order for the proof wallet to take.
          </p>
          <p>
            Match the maker side to the prepared taker side: BUY_YES needs a SELL_YES
            ask, and BUY_NO needs a SELL_NO ask.
          </p>
          {controlledCandidate !== undefined ? (
            <dl className="factGrid">
              <div>
                <dt>Market</dt>
                <dd>{compactId(controlledCandidate.market.stableMarketId)}</dd>
              </div>
              <div>
                <dt>Setup collateral</dt>
                <dd>{controlledCandidate.risk.maxSetupCollateralDisplay}</dd>
              </div>
              <div>
                <dt>Headroom</dt>
                <dd>{`${String(controlledCandidate.risk.expiryHeadroomSeconds)}s`}</dd>
              </div>
              <div>
                <dt>Setup calls</dt>
                <dd>{String(controlledCandidate.setup?.calls.length ?? 0)}</dd>
              </div>
              <div>
                <dt>Outcome token</dt>
                <dd>{compactId(controlledCandidate.setup?.outcomeToken ?? "-")}</dd>
              </div>
              <div>
                <dt>Next</dt>
                <dd>{controlledCandidate.nextStep}</dd>
              </div>
            </dl>
          ) : null}
          {controlledCandidate?.blockedReasons.length ? (
            <ul className="checkList blockedList">
              {controlledCandidate.blockedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className="primaryAction inlineAction"
            disabled={controlledCandidate?.status !== "READY" || controlledSubmitMutation.isPending}
            onClick={() => {
              controlledSubmitMutation.mutate();
            }}
          >
            {controlledSubmitMutation.isPending ? "Submitting..." : "Submit Liquidity Setup Calls"}
          </button>
          {controlledSubmitMutation.isError ? <p className="errorText">{apiErrorMessage(controlledSubmitMutation.error)}</p> : null}
          {controlledSubmitMutation.isSuccess ? (
            <p className="successText">
              Submitted {String(controlledSubmitMutation.data.length)} setup transaction
              {controlledSubmitMutation.data.length === 1 ? "" : "s"}. Rerun the execution watcher with the proof wallet.
            </p>
          ) : null}
        </article>
      </section>

      {candidate !== undefined ? (
        <section className="routePanel">
          <h2>Readiness evidence</h2>
          {candidate.blockedReasons.length > 0 ? (
            <ul className="checkList blockedList">
              {candidate.blockedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <div className="evidenceGrid">
              <article>
                <span className="statusPill pass">Approval</span>
                <h3>{candidate.unsignedTransactions?.approval?.description ?? "No approval required"}</h3>
                <p className="monoText">{candidate.unsignedTransactions?.approval?.to ?? "allowance already omitted by builder"}</p>
              </article>
              <article>
                <span className="statusPill pass">Order</span>
                <h3>{candidate.unsignedTransactions?.order.description}</h3>
                <p className="monoText">{candidate.unsignedTransactions?.order.to}</p>
              </article>
            </div>
          )}
          <div className="evidenceGrid">
            <article>
              <h3>Controls</h3>
              <ul className="checkList">
                {candidate.controls.map((control) => (
                  <li key={control}>{control}</li>
                ))}
              </ul>
            </article>
            <article>
              <h3>Claims still blocked</h3>
              <ul className="checkList blockedList">
                {candidate.blockedClaims.map((claim) => (
                  <li key={claim}>{claim}</li>
                ))}
              </ul>
            </article>
          </div>
        </section>
      ) : null}
    </div>
  );
}
