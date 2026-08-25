# EdgeLab Demo Script

Target duration: 2:40.

## 0:00-0:20 Opening

EdgeLab is a forward-testing, live-shadow, recent-window DreamDEX Event Contract strategy evidence lab. It does not claim guaranteed alpha, does not fabricate historical books or fills, and does not let the server sign transactions.

## 0:20-0:55 Decision First

Show the dashboard verdict first: `INSUFFICIENT_EVIDENCE`.

Point out the visible reason: promotion is blocked because the strategy has not earned enough evidence. EdgeLab protected the strategy from overconfidence instead of manufacturing confidence.

## 0:55-1:25 Evidence Gate

Show the Evidence Gate:

- Candidate strategy cohort enters the gate.
- Forecast sample is blocked at `0/30`.
- Tradeability is verified by the real DreamDEX probe.
- Risk envelope passed with the 0.01 tUSDC cap and no open order.
- Settlement and realized PnL remain unavailable.

Then show the three separate evidence lanes:

- Forecast quality: pre-outcome decisions.
- Tradeability: submitted, terminal, and open order counts.
- Realized PnL: unavailable unless an actual fill and settlement both exist.

## 1:25-2:05 DreamDEX Lifecycle Proof

Show the public proof references:

- Exact 0.01 tUSDC approval.
- POST_ONLY BUY_YES order at 0.01, quantity 1.
- Terminal reconciliation with no fill required.
- Chain `50312`, order ID `110680464442257591736`.

State clearly that the terminal event was `OrderExpired` because the owner-approved cancellation landed after order expiry, and that this is recorded as terminal proof without implying a fill.

## 2:05-2:30 Reusable Evidence Export

Show `pnpm evidence:manifest` and the exported manifest hash. Explain that the manifest indexes sanitized evidence artifacts with hashes, sizes, classes, source version, and redaction notes.

## 2:30-2:40 Close

Restate the boundary: EdgeLab calibrates whether evidence is sufficient to promote a strategy. If evidence is not sufficient, the correct answer is visible and valid.
