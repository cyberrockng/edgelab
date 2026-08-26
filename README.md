# EdgeLab

EdgeLab is a DreamDEX Event Contract strategy evidence and calibration laboratory spanning three separated evidence planes:

- Somnia mainnet `5031` historical research, read-only.
- Somnia Shannon `50312` forward/live-shadow observation, read-only plus scoped application writes.
- Somnia Shannon `50312` execution proof, browser-wallet and human-authorized only.

It compares immutable reference policies using pre-outcome decisions, separated forecast/tradeability/PnL evidence, deterministic sufficiency rules, and human-authorized testnet execution proof. `INSUFFICIENT_EVIDENCE` is a first-class valid outcome.

## Current Status

- GitHub repository: https://github.com/cyberrockng/edgelab
- Networks: Somnia mainnet `5031` for read-only historical research; Somnia Shannon testnet `50312` for forward observation and execution proof.
- DreamDEX SDK: `@somnia-chain/markets-sdk` `0.28.1`
- EXG-002 wallet funding proof: passed with public chain evidence.
- EXG-003 approval, order, and terminal lifecycle: passed with a real no-fill DreamDEX order lifecycle.
- Local Docker deployment smoke: passed.
- Public HTTPS audit deployment: https://api-production-bd986.up.railway.app
- Final submission video and form receipt: pending owner-controlled SHIP-001 actions.

## Product Boundaries

EdgeLab is not a generic CLOB backtester, trading bot, guaranteed-alpha finder, or autonomous profit machine.

- Mainnet access is read-only historical research. There is no mainnet signer, transaction builder, or write route.
- Shannon forward observation is separate from Shannon human-authorized execution proof.
- DreamDEX Event Contracts are load-bearing.
- The service never signs transactions and never receives wallet credential material.
- Consequential DreamDEX writes require explicit human wallet approval.
- No self-trading, fake volume, fabricated fills, or fabricated demo transactions.
- Forecast quality, tradeability, and realized PnL remain separate.
- PnL remains unavailable unless an actual fill and terminal settlement are both verified.

## Architecture

- `apps/web`: React multi-route Strategy Lab, market explorer, comparison, Evidence Gate, and proof UI.
- `apps/server`: Fastify API, health/readiness, research sessions, historical reads, replay jobs, evaluation, comparison, proof, and legacy v1 compatibility reads.
- `packages/domain`: shared IDs, schemas, constants, and evidence states.
- `packages/db`: Postgres migrations, leases, audit events.
- `packages/dreamdex`: separated Shannon and mainnet read adapters with fixed bounded queries.
- `packages/policy-runtime`: immutable reference policy adapter runtime.
- `packages/observe`: live-shadow pre-outcome snapshot and decision pipeline.
- `packages/metrics`: forecast, execution, PnL, and sufficiency metrics.
- `packages/evaluate`: deterministic verdict assembly.
- `packages/settle`: settlement reconciliation.
- `packages/auth`: wallet challenge and replay protection.
- `packages/chain`: EXG-003 lifecycle evidence import and chain summary.

## State Model

The database stores experiments, configuration versions, replay runs, historical source manifests, replay decisions/outcomes, market episodes, pre-outcome snapshots, shadow decisions, metric runs, evidence assessments, comparison sets, wallet identities, execution intents, chain transactions, order evidence, fill evidence, settlement records, evidence artifacts, leases, and audit events.

Important invariants:

- historical replay decisions are committed before the separate outcome stage;
- shadow decisions are written before outcomes are known;
- outcome-bearing or expired markets are rejected before observation writes;
- order submitted, fill, terminal, and settlement states are not collapsed into a single PnL claim;
- `INSUFFICIENT_EVIDENCE` is deterministic when sample thresholds or evidence requirements are not met.

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
docker compose up -d postgres
pnpm build
pnpm check
```

Default local Postgres URL:

```text
postgres://edgelab:edgelab@localhost:55432/edgelab
```

Runtime configuration is environment-variable based. Use `.env.example` style placeholders only; `.env` files are ignored.

Required runtime values:

- `DATABASE_URL`
- `PUBLIC_APP_URL`
- `SESSION_SECRET`
- `SOMNIA_CHAIN_ID=50312`
- `SOMNIA_RPC_URL`
- `SOMNIA_WS_RPC_URL`
- `DREAMDEX_INDEXER_URL`
- `SOMNIA_MAINNET_CHAIN_ID=5031`
- `SOMNIA_MAINNET_RPC_URL`
- `DREAMDEX_MAINNET_INDEXER_URL`
- `MARKETS_SDK_VERSION=0.28.1`
- `WORKER_ENABLED=true` for deployed replay workers after remediation tests pass; local on-demand testing may run either mode.

## Commands

```bash
pnpm build
pnpm check
pnpm test:e2e
pnpm secret:scan
pnpm evidence:manifest
DATABASE_URL=postgres://... SOMNIA_RPC_URL=https://api.infra.testnet.somnia.network/ NODE_ENV=local pnpm evidence:import-exg003
```

`pnpm check` runs lint, typecheck, and Vitest unit/integration suites. `pnpm test:e2e` expects a running app and uses `E2E_BASE_URL`, defaulting to `http://localhost:3011`.

## Evidence

Evidence is committed as sanitized public artifacts under `evidence/`.

Key locations:

- `evidence/feasibility/`: EXG-002 and EXG-003 public chain proof.
- `evidence/chain/`: lifecycle import and UI screenshots.
- `evidence/export/manifest.json`: reproducible artifact index with hashes and evidence classes.
- `evidence/qa/`: QA-001, QA-002, and QA-003 reports.
- `evidence/deploy/`: deployment smoke, restore, and rollback evidence.
- `docs/SDK_FEEDBACK.md`: DreamDEX/Somnia SDK implementation feedback.
- `docs/DEMO_SCRIPT.md`: timed demo script for final capture.

Regenerate the evidence manifest:

```bash
pnpm evidence:manifest
```

## Docker Deployment

Build the local production image:

```bash
docker build -t edgelab:deploy-qa .
```

Run with a host Postgres database:

```bash
docker run --rm --name edgelab-deploy-qa \
  --add-host=host.docker.internal:host-gateway \
  -p 3012:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL=postgres://edgelab:edgelab@host.docker.internal:55432/edgelab_qa \
  -e PUBLIC_APP_URL=http://localhost:3012 \
  -e SESSION_SECRET=local-deploy-session-secret-at-least-32-bytes \
  -e SOMNIA_CHAIN_ID=50312 \
  -e SOMNIA_RPC_URL=https://api.infra.testnet.somnia.network/ \
  -e SOMNIA_WS_RPC_URL=wss://api.infra.testnet.somnia.network/ws \
  -e DREAMDEX_INDEXER_URL=https://dev.smk.somnia.host/v1/graphql \
  -e MARKETS_SDK_VERSION=0.28.1 \
  -e WORKER_ENABLED=false \
  -e LOG_LEVEL=error \
  -e BUILD_COMMIT=$(git rev-parse HEAD) \
  edgelab:deploy-qa
```

Smoke checks:

```bash
curl -fsS http://localhost:3012/healthz
curl -fsS http://localhost:3012/readyz
curl -fsS http://localhost:3012/api/v1/evidence/summary
```

Rollback for the local deployment is to stop the smoke container and return to the prior pushed commit/image tag. Schema rollback is restore-from-backup only; do not deploy past a failed migration.

## Limitations

- Public Proven Experiment evidence remains truthful if it evaluates to `INSUFFICIENT_EVIDENCE`.
- Historical reconstructed resting-book state remains `SOURCE_INCOMPLETE / FAIL-CLOSED`; no stored book snapshot is claimed.
- The EXG-003 order lifecycle had no fill; this is valid tradeability evidence, not PnL evidence.
- The terminal event was `OrderExpired` after an owner-approved `cancelOrder` call landed post-expiry.
- Final narrated video and submission-form receipt remain SHIP-001 owner-controlled steps after independent audit.
- Licensed under MIT after repository dependency metadata showed no obvious GPL/AGPL/LGPL/proprietary/unknown license conflict.

## License

MIT. See `LICENSE`.
