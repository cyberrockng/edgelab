# Policy Adapters

`POLICY-001` exposes a compile-time TypeScript adapter interface only. EdgeLab does not load uploaded code, evaluate strings, import arbitrary runtime modules, call models, access the filesystem, access a wallet, or provide network access to policies.

## Contract

A policy receives:

- one validated DreamDEX market snapshot;
- the externally supplied decision timestamp;
- the immutable snapshot hash.

Historical policies receive a validated historical decision frame instead of a
live snapshot. The frame must contain only evidence available before the
decision cutoff, and outcome/resolution fields remain embargoed until after the
decision is persisted.

A policy returns:

- `forecastPUp` in `[0, 1]`;
- an approved action such as `WATCH_ONLY`;
- one or more reason codes.

The runtime adds `policyId`, `policyVersion`, `policyHash`, `snapshotHash`, and `decidedAt`, then validates the complete decision with the domain schema before persistence.

## Reference Policies

- `reference-neutral@1.0.0`: educational neutral baseline, always forecasts `0.5` for Shannon live-shadow workflow validation.
- `reference-book-tilt@1.0.0`: educational captured-book-only tilt, never a profitability claim.
- `historical-last-trade@1.0.0`: superseded historical identity retained only for reproducibility of old evidence. It must not be used for new active proof because it inferred YES/NO from fill metadata and could invert NO-tagged fills.
- `historical-last-trade@1.1.0`: corrected historical baseline for new evidence. It uses the latest eligible pre-cutoff DreamDEX binary fill in a 900-second lookback window.

These are comparison fixtures, not alpha strategies.

## Historical Last-Trade 1.1.0

DreamDEX binary `fillPriceRaw / 10^quoteDecimals` is interpreted as the
canonical market-level YES/UP probability. EdgeLab does not invert the value
because a fill row contains a NO tag; the complement is only valid for clearly
labeled account/NO-outcome display contexts, not for the strategy forecast.

Eligible fills must belong to the evaluated market, occur before the decision
cutoff, have deterministic timestamp/block/log ordering, have valid price and
quantity fields, and use a supported binary fill kind. `MINT_A_PAIR` and
`BURN_A_PAIR` are eligible when those source requirements pass.

If no qualifying fill exists, the policy returns `ABSTAIN` with a neutral
`forecastPUp` of `0.5`. Abstentions are excluded from scored forecast quality;
they are not converted into wins, losses, fills, PnL, or tradeability proof.

Historical replay success can only produce
`PROMOTE_TO_FORWARD_OBSERVATION`. It does not prove profitability, live
execution readiness, mainnet readiness, or autonomous trading authorization.
