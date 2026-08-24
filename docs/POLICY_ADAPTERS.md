# Policy Adapters

`POLICY-001` exposes a compile-time TypeScript adapter interface only. EdgeLab does not load uploaded code, evaluate strings, import arbitrary runtime modules, call models, access the filesystem, access a wallet, or provide network access to policies.

## Contract

A policy receives:

- one validated DreamDEX market snapshot;
- the externally supplied decision timestamp;
- the immutable snapshot hash.

A policy returns:

- `forecastPUp` in `[0, 1]`;
- an approved action such as `WATCH_ONLY`;
- one or more reason codes.

The runtime adds `policyId`, `policyVersion`, `policyHash`, `snapshotHash`, and `decidedAt`, then validates the complete decision with the domain schema before persistence.

## Reference Policies

- `reference-neutral@1.0.0`: educational neutral baseline, always forecasts `0.5`.
- `reference-book-tilt@1.0.0`: educational captured-book-only tilt, never a profitability claim.

These are comparison fixtures, not alpha strategies.
