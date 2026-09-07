# EdgeLab Demo Video

Target: 2:40–2:55. Record at 1440×900 or 1920×1080, 30 fps. Never display `.env`, campaign state files, browser storage, wallet recovery material, or unredacted terminal output.

## Recording preflight

1. Confirm `/healthz` and `/readyz` are green and note the exact current eligible counts.
2. Run `pnpm demo:open -- --smoke` to verify the authenticated campaign workspace without printing its session credential.
3. Run `pnpm demo:open` to open six ordered, read-only recording tabs for the v1.1 BTC 1h track.
4. Close notifications, password managers, unrelated tabs, developer tools, and terminals containing environment values.
5. Use a normal browser profile with the OKX extension only if an exact track is qualified **and** a fresh candidate is `READY`. The demo helper is intentionally read-only and does not load wallet extensions.
6. Record one clean narration take, then add a title card and captions. Do not accelerate wallet prompts or edit separate transactions to look atomic.

## Branch decision immediately before recording

- **Branch A — qualified lifecycle:** use only if the exact displayed policy/asset/interval has at least 30 eligible settled observations and the server assessment says `STRATEGY_QUALIFIED`.
- **Branch B — honest gate:** use if the threshold or policy gates have not passed. Showing that EdgeLab refuses execution is a valid product demonstration.
- Never combine BTC and ETH, 15m and 1h, or v1.0 and v1.1 counts.

## Timed narration and shots

### 0:00–0:18 — Product question

**Shot:** Home tab. Hold on the hero and qualification journey.

**Say:** “Trading agents can make impressive claims before they have earned the right to risk capital. EdgeLab is a DreamDEX strategy qualification and evidence system. It asks one question: has this exact strategy earned progression before receiving execution exposure?”

### 0:18–0:42 — Historical evidence, limited authority

**Shot:** Historical verdict tab. Show policy/version, sample size, Brier score, provenance, and the next permitted action.

**Say:** “First, immutable policy code is evaluated against authentic, read-only DreamDEX mainnet history. This example passed the historical gate, but notice the wording: it earned forward observation—not execution. EdgeLab keeps research, live qualification, and capital exposure separate.”

### 0:42–1:18 — Genuine forward campaign

**Shot:** Live campaign tab. Show `last-trade-forward-proxy@1.1.0`, the exact BTC 1h configuration, eligible count, abstentions, pending outcomes, timing exclusions, and latest market.

**Say:** “Next, EdgeLab commits predictions before Shannon outcomes exist. This durable campaign follows rotating market generations, deduplicates observations, survives restarts, preserves abstentions and data errors, and reconciles settlement later. The qualification requirement is 30 eligible settled observations on one exact track. Raw uptime and executable liquidity cannot inflate this number.”

### 1:18–1:42 — Deterministic verdict

**Shot:** Evaluation area in the campaign workspace.

**Branch A say:** “The exact track reached the required evidence threshold. The server applies a versioned deterministic policy and records `STRATEGY_QUALIFIED` with its reasons.”

**Branch B say:** “This track currently has [READ THE DISPLAYED COUNT] eligible observations. The missing evidence remains visible, so the server refuses to qualify it. That refusal is the control—not a demo failure.”

### 1:42–2:15 — Fresh execution gate

**Shot:** Execution gate tab with the same experiment and BTC 1h already selected. Prepare a candidate only while recording the resulting gate response.

**Branch A say:** “Qualification unlocks only a fresh market review. EdgeLab resolves the current market and collateral, checks liquidity, lot and minimum quantity, expiry headroom, wallet funds, allowance, network, and a 0.01 tUSDC cap. It revalidates again before signing, and the server returns unsigned calls only.”

**Branch B say:** “Even if a market is liquid, this request fails with `STRATEGY_NOT_QUALIFIED`. Market executability can never qualify an unproven strategy.”

If Branch A is `READY` and the owner chooses to execute, switch to the normal OKX-enabled browser. Confirm Shannon chain `50312`, the selected account, contract-resolved tUSDC address, exact approval amount, order bytes, IOC behavior, and cap. Approve each wallet request manually. Never paste or reveal a private key or seed phrase.

### 2:15–2:40 — Receipt and public claims

**Shot:** Protocol proof tab. If strategy-linked evidence exists, additionally show its workspace and Evidence Gate.

**Branch A with receipt say:** “The approval and order receipts are persisted idempotently, decoded into requested and filled quantities, and reconciled through settlement and redemption. Every page renders the same canonical result.”

**Otherwise say:** “EXG-003 is a real Shannon no-fill lifecycle artifact, but it is not linked to this strategy. EdgeLab does not rename a submitted order as a fill or invent PnL.”

### 2:40–2:52 — Close

**Shot:** Return to the Home tab and hold on the evidence journey.

**Say:** “EdgeLab advances only the evidence that earned it: deterministic qualification, honest abstention, fresh bounded execution, human authorization, and public proof.”

## Mandatory final review

- Duration is between 2 and 3 minutes.
- Captions match the spoken claims.
- No secret, session token, wallet popup identifier, or private environment value appears.
- No `filled`, `profitable`, `deployed`, or `on-chain proven` claim exceeds the evidence shown.
- Repository URL and working demo URL are visible in the description or final card.
- The uploaded video opens in a signed-out/private browser before its link is submitted.
