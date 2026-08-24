# EdgeLab

EdgeLab is a forward-testing, live-shadow, recent-window DreamDEX Event Contract strategy evidence and calibration laboratory for Somnia Shannon testnet.

It compares two immutable reference policies using pre-outcome decisions, separated forecast/tradeability/PnL evidence, deterministic sufficiency rules, and human-authorized testnet execution proof. `INSUFFICIENT_EVIDENCE` is a valid first-class outcome.

## Current Status

Implementation in progress. `EXG-002` funding and `EXG-003` human-signed DreamDEX order/terminal lifecycle have passed on Somnia Shannon; deployment and final QA remain pending.

## Quick Start

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm build
docker compose up --build
```

## Boundaries

- Somnia Shannon testnet chain `50312` only.
- DreamDEX Event Contracts are load-bearing.
- The service never signs transactions and never receives wallet secrets.
- No historical order-book replay, synthetic fills, self-trading, fake volume, or profit/certainty claims.
- PnL is unavailable unless an actual fill and terminal settlement are both verified.

## License

Project license is pending explicit owner approval before final public submission. Until then, no open-source license grant is implied for this repository's original source.
