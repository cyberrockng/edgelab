# EdgeLab implementation handoff — 9 September 2026

Source baseline: `ebc16e3ab5fa9e6a530d88df68fbc4d139b0e7ed`

Delivered scope:

- Phase A information architecture: Overview, Lab, and Markets are the only primary destinations; study Results, Observations, Evidence, and Execution are URL-addressable; legacy URLs redirect without initiating writes.
- A compact Overview backed by `GET /api/v2/public/overview`, with the historical example and current public campaign kept distinct.
- A list-first Lab whose creation panel loads the supported policy registry from the server and preserves query-string seeds without submission.
- Route-level bundles. The production build records 101.68 KiB gzip for the initial shared JavaScript; execution is a separate 6.60 KiB gzip chunk and is not loaded by Overview.
- Additive migration `0020_evaluation_v4_foundations` for immutable protocols, campaign state, paired forecasts, v4 assessment details, quote details, explicit publication, commitments, and external receipts.
- Phase B protocol and capture path: new forward studies freeze a v4 protocol and campaign, capture only in `[deadline-5s, deadline)`, require candidate receipt before the deadline, preserve missed windows, and persist the candidate beside a positive-size, non-crossed, two-sided YES midpoint baseline.
- Phase B evaluation: paired candidate/market Brier, Brier skill, fixed ten-bin reliability with Wilson intervals, ECE, missing-baseline handling, shared observation-key deduplication, deterministic two-day moving-block bootstrap, family-adjusted bounds, fixed-end gates, immutable v4 assessments, and sanitized reproducibility exports.
- Phase B presentation and comparisons: Results shows paired metrics plus an accessible reliability plot/table. Saved comparisons bind 2–4 immutable assessments to an append-only scope manifest, recompute v4 metrics and intervals on compatible shared observation keys, report per-candidate exclusions, and label incompatible scopes descriptive-only.
- Phase C scenario evidence: every v4 paired capture stores the full executable-side book, verified lot/tick/minimum parameters, a fixed 100-quote-unit bankroll, a one-unit window budget, no-trade or source-unavailable classification, and primary plus adverse `+.01/share` integer quote plans. Settled evaluation includes no-trades as zero, excludes missing sources against coverage, bootstraps stress return by UTC day, and requires positive return after removing the best of at least four calendar weeks.
- Phase C execution integrity: fresh candidates consume sorted multi-level YES/NO depth under lot, tick, requested-quantity, reviewed-price, and collateral limits. The old probability-plus-five-point rule is replaced by the frozen `.05` model haircut, `.01/share` reserve, and `.01/share` minimum-edge rule at both displayed depth and the maximum reviewed price. Raw quote evidence is bound to the intent with a five-second review expiry.
- v4 execution remains closed unless both `FORWARD_CRITERIA_MET` and `SCENARIO_CRITERIA_MET` produce `ELIGIBLE_FOR_FRESH_REVIEW`. Candidate retry is idempotent; signing-time checks bind the exact account, assessment, market generation, contract, collateral, side, quantity, price, quote policy, planner result, and calldata. Approval, order submission, fills, settlement, voids, and redemption remain separate receipt-backed states.

The v3 archive remains intact and readable. New v4 studies use a separate evaluation endpoint and the legacy endpoint rejects them. A v4 study can reach fresh Shannon review only after its forecast and captured-book economic criteria both pass; currently insufficient studies remain blocked. The following specification work remains after Phase C: the signed external adapter, commitment registry/verifier, a fixed matched case study with accrued forward outcomes, and separately authorized deployment or third-party adoption.

Local validation:

- `pnpm check`: lint and typecheck passed; 153 unit and integration tests passed against the dedicated local PostgreSQL service.
- `pnpm build`: passed.
- `pnpm test:e2e`: all 56 browser tests passed across three desktop profiles and Pixel 5 mobile.
- `pnpm secret:scan`: passed for 185 files.
- `pnpm evidence:manifest:check`: passed for 90 public/sanitized artifacts.
- `git diff --check`: passed.

No transaction, deployment, external outreach, submission update, or historical evidence rewrite was performed.
