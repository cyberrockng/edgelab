# EdgeLab Demo Script

Target duration: 2:40.

## 0:00-0:20 Opening

EdgeLab is a forward-testing, live-shadow, recent-window DreamDEX Event Contract strategy evidence lab. It does not claim guaranteed alpha, does not fabricate historical books or fills, and does not let the server sign transactions.

## 0:20-0:55 Decision First

Show the dashboard verdict first: `INSUFFICIENT_EVIDENCE`.

Point out the visible reasons: minimum sample not met, PnL separated from forecast quality, and tradeability evaluated independently.

## 0:55-1:25 Evidence Separation

Show the three evidence lanes:

- Forecast: pre-outcome decisions.
- Tradeability: submitted, terminal, and open order counts.
- Realized PnL: unavailable unless actual fill and settlement evidence exist.

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
