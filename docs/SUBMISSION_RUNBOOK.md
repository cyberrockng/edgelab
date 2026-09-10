# EdgeLab Submission Runbook

## Deadline control

The entrant reports less than 24 hours remain as of **2026-09-10**. The authenticated submission form is the controlling clock. Verify it now, record the displayed deadline, and plan to upload several hours early. Public search results do not expose a reliable current countdown.

## Required submission package

- Working testnet prototype
- Public GitHub repository
- 2–3 minute demo video
- DreamDEX SDK/documentation feedback
- Public HTTPS demo, with local Docker fallback documented
- Accurate project description, team details, and requested track selections

## Ready-to-paste project copy

**Name:** EdgeLab

**Tagline:** Evidence before exposure for DreamDEX strategies.

**One-line description:** EdgeLab qualifies immutable DreamDEX strategies using deterministic historical and forward evidence, then permits only freshly revalidated, capped, human-authorized Shannon execution.

**Problem:** Trading strategies and agents can receive capital exposure before their performance claims are independently supported. Submitted orders, fills, settlement, and PnL are also frequently collapsed into one misleading status.

**Solution:** EdgeLab records an exact strategy and policy version, captures genuine pre-outcome DreamDEX observations, evaluates promotion deterministically, and keeps strategy qualification independent from current market executability. Only a qualified strategy can request a fresh bounded unsigned candidate; OKX remains the signing authority, and receipts are reconciled into order, fill, settlement, redemption, and public-claim states.

**Who it serves:** DreamDEX strategy developers, trading-agent operators, DAOs, and risk teams that need a reproducible answer to whether an exact strategy has earned limited execution exposure.

**Why it is different:** Most market dashboards show opportunities and most trading agents optimize execution. EdgeLab governs the step before execution: it makes forward qualification, market freshness, human authorization, and post-transaction evidence one fail-closed progression instead of treating a backtest or submitted order as proof.

**Adoption model:** EdgeLab can operate as a hosted strategy-qualification workspace, an evidence API for agent platforms, or a policy gate embedded between a strategy engine and a browser wallet. The hackathon prototype proves the control plane on DreamDEX; it does not claim current revenue or mainnet execution.

**DreamDEX/Somnia integration:** DreamDEX Event Contract markets, order books, pool parameters, fills, and settlement data are read through `@somnia-chain/markets-sdk` and bounded fallbacks. Historical research is read-only on Somnia mainnet `5031`; forward observation and optional owner-approved proof are bounded to Shannon testnet `50312`.

**Current evidence disclosure:** “The full v4 lifecycle is implemented and locally verified. The fixed 28-day live study began on 10 September 2026 and cannot mature before submission, so strategy-linked execution is correctly blocked. EXG-003 is a separate real Shannon no-fill protocol artifact, not strategy performance proof.”

**Repository:** https://github.com/cyberrockng/edgelab

**Live demo:** https://api-production-bd986.up.railway.app — use it only after confirming `/healthz` reports the same revision as public `main` and the final fresh-browser smoke passes.

**SDK feedback:** `docs/SDK_FEEDBACK.md`

## Work schedule

### Now

- Keep PostgreSQL, the application, and the single BTC 15m v4 observation campaign running.
- Rehearse the honest-gate branch in `docs/DEMO_SCRIPT.md`.
- Run `pnpm demo:open -- --smoke` and one silent screen-recording rehearsal.
- Prepare the DoraHacks draft without submitting premature claims.

### When the v4 study ends

1. Confirm at least 200 paired observations are settled on the one exact policy/asset/interval cohort and the fixed 28-day window has ended.
2. Run deterministic evaluation and record the exact verdict and reason codes.
3. If qualified, request a fresh candidate; do not reuse historical READY output.
4. If blocked, record the actionable blocker and use the honest-gate video branch.
5. If READY, the owner may approve the exact tUSDC escrow and bounded IOC order in OKX on chain `50312`.
6. Reconcile receipts and wait for indexer/settlement evidence before changing public claims.

### Final capture and upload

1. Run health, readiness, tests, typecheck, lint, build, secret scan, and `git diff --check`.
2. Record the 2–3 minute video using the verified branch.
3. Review at normal speed with captions and no hidden cuts around wallet actions.
4. Upload and verify the link in a private browser.
5. Update the submission disclosure, README status, SDK feedback, and evidence manifest to match the final demonstrated state.
6. Submit before the internal cutoff and retain a timestamped confirmation screenshot/receipt.

## Owner-controlled actions

- Authenticate to DoraHacks and verify the displayed deadline and required fields.
- Record narration and approve the final video upload.
- Approve OKX transactions only after qualification and fresh READY validation.
- Submit the final form and retain its receipt.

No wallet secret, private key, seed phrase, opaque research-session token, or production environment value belongs in the video, repository, form, or evidence export.
