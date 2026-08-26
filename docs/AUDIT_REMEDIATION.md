# System 3 Audit Remediation Matrix

Audit source: `CODEX_AUDIT_FEEDBACK.md`

Failed audit SHA: `53fe7bdc2bbbe0c660916223ae2e61214940f3be`

Authority: `INTERACTIVE_PRODUCT_EXECUTION_HANDOFF.md` version `2.0.0`

Overall state: `AWAITING_SYSTEM_3_RE_AUDIT`

This file tracks bounded implementation corrections. It does not supersede the
independent audit and cannot change its verdict.

| Finding | Severity | Owner | Affected files/components | Reproduced | Correction approach | Required tests | Evidence to regenerate | Deployment impact | Escalation | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| AUD-001 | P0 | Execution agent | Replay clock/frame, mainnet RPC adapter, decision/outcome persistence, replay/evaluation evidence | YES | Authoritative `< decisionAt` cutoff; strict pre-cutoff DTO; append-only decision commit before separate outcome load | Boundary/future mutation, cutoff RPC, append-only DB, outcome-order integration | `evidence/replay/lookahead-adversarial.json`, replay/proven/evaluation artifacts | Migration and corrected replay service required | EXECUTION AGENT | FIXED |
| AUD-002 | P0 | Execution agent | Legacy mutation routes, route authorization inventory | YES | Disable obsolete public mutations with deterministic `410 Gone`; retain protected v2 paths | No-session, invalid-session, foreign-session, expired-session, CSRF, duplicate, legacy bypass, route inventory | Security/remediation report | API behavior changes for legacy POST routes | EXECUTION AGENT | FIXED |
| AUD-003 | P1 | Execution agent | DreamDEX candle adapter, historical candle API/UI | YES | Force immutable market lifecycle bounds and provenance on every candle query | Recycled-pool, pre/post-window, invalid caller bounds | Historical source/remediation evidence | Historical API response metadata changes | EXECUTION AGENT | FIXED |
| AUD-004 | P1 | Execution agent | Replay runs, worker lease, checkpoint, status, idempotency, progress UI | YES | Implement owned queued jobs, concurrency/caps, checkpoints/recovery, fail-closed completeness | Duplicate, concurrent, crash/restart, lease, partial, cancel, deadline | Replay recovery/remediation report | Worker-enabled deployment and migration required | EXECUTION AGENT | FIXED |
| AUD-005 | P1 | Execution agent | Policy runtime/catalog, policy DB writes, replay decision serialization | YES | Hash executable behavior/parameters; reject version mutation; preserve `0.5 + ABSTAIN`; deterministic tuple ordering | Version mutation, YES/NO/no-fill/same-block repeatability | Strategy/evaluation artifacts | Policy/catalog API and evidence hashes change | EXECUTION AGENT | FIXED |
| AUD-006 | P1 | Execution agent | Evaluation canonical input, metric/assessment transaction, Evidence Gate provenance | YES | Hash complete immutable inputs; require complete source; atomic append-only metric+assessment | Field mutation hashes, transaction failure, four verdict fixtures | `evidence/evaluate/eval-002-report.json`, comparison/proven artifacts | Assessment hashes and API DTOs change | EXECUTION AGENT | FIXED |
| AUD-007 | P1 | Execution agent | Replay/proven evidence, manifest, Proof page fallback | YES | Invalidate contradicted artifacts; regenerate from corrected pipeline; render unavailable on API failure | Evidence reproduction, API failure, manifest graph | All contradicted replay/proven/security artifacts and manifest | Public Proven/proof behavior and release evidence change | EXECUTION AGENT | FIXED |
| AUD-008 | P1 | Execution agent | Rate limits, quotas, session lifecycle, replay cancellation/deadlines, CSRF rotation | YES | Add IP/session bounds, quotas, revoke endpoint, safe CSRF stability, bounded upstream work | Boundary+1, revoke/expiry, concurrent CSRF, cancellation, timeout | Security/QA remediation evidence | Runtime limits/config/readiness change | EXECUTION AGENT | FIXED |
| AUD-009 | P1 | Execution agent | Market route/link query plane types and data clients | YES | Canonical `mainnet-history|shannon-live`; reject missing/invalid plane; preserve through navigation | Direct/refresh/history/cross-plane/bogus plane | UI/plane screenshots and route report | Frontend route behavior changes | EXECUTION AGENT | FIXED |
| AUD-010 | P1 | Execution agent | Historical filters, adapter timeout/retry/cache/paging/completeness | YES | Date bounds, abort deadlines, capped retries, stable frozen page metadata, fail-closed caps | Timeout/429/5xx/schema/cap/page mutation/cache horizon | Historical/QA remediation evidence | Historical APIs/cache controls change | EXECUTION AGENT | FIXED |
| AUD-011 | P2 | Execution agent | Lab configuration controls, comparison list/detail/direct routes | YES | Surface approved config and saved comparison workflows without redesign | Full visible create/reload/compare refresh/keyboard flow | UI E2E/screenshots | Frontend and comparison list API changes | EXECUTION AGENT | FIXED |
| AUD-012 | P2 | Execution agent | `@fastify/static`, lockfile, SPA/API routing | YES | Upgrade to patched compatible release and regress route semantics | Production audit, traversal/API/SPA/assets | Dependency/security remediation report | Rebuilt production image required | EXECUTION AGENT | FIXED |
| AUD-013 | P2 | Execution agent; owner rule recheck | README, demo script, historical docs, SDK feedback | YES | Reconcile claims to verified 2.0 behavior and complete required SDK topics | Claim trace, links, topic checklist | Documentation/remediation report | No runtime dependency except served docs | EXECUTION AGENT; OWNER final rule check | FIXED |
| AUD-014 | P3 | Execution agent | Mobile navigation, expected reconstructed-book error handling | YES | Accessible compact navigation and normal capability-state handling | 320/375/768 keyboard/touch/console regression | UI remediation evidence | Frontend-only | EXECUTION AGENT | FIXED |

## Priority Order

1. Reproduce and correct AUD-001.
2. Reproduce and correct AUD-002.
3. Correct AUD-003, AUD-010, and AUD-004 as the source/job dependency chain.
4. Correct AUD-005 and AUD-006 before regenerating any result.
5. Correct AUD-007 only from the corrected immutable pipeline.
6. Correct AUD-008 and AUD-009, then remaining P2/P3 items.
7. Run full regression, regenerate evidence, deploy, freeze, and request a fresh
   independent System 3 audit.

## Reproduction Log

### 2026-08-25 - AUD-001 and AUD-002

- Command: `pnpm exec vitest run tests/integration/audit-remediation.test.ts --reporter=verbose`
- Failed SHA: `53fe7bdc2bbbe0c660916223ae2e61214940f3be`
- AUD-001 input: one order placed before cutoff, with only its final status,
  remaining quantity, and last-update tuple moved after cutoff.
- AUD-001 observed: the order disappeared, exclusion
  `ORDER_AFTER_CUTOFF` appeared, and frame/hash changed.
- AUD-002 input: no session/cookie/CSRF requests to the three legacy v1
  observe, reconcile, and evaluate mutations with valid-shaped IDs and
  idempotency headers.
- AUD-002 observed: statuses `[400, 400, 400]`; all reached the sentinel
  database path instead of failing at the route boundary.

### 2026-08-25 - AUD-003 and AUD-010

- AUD-003 production input: finalized market
  stable market `...1bb7`,
  lifecycle `[1787644800, 1787648400]`, 3600-second candles.
- AUD-003 observed: 20 candles with bucket starts from `1787306400` through
  `1787652000`; 19 rows were outside the stable market lifecycle.
- AUD-010 production input: bounded finalized-market list request.
- AUD-010 observed by the independent audit: no application response within
  30 seconds. A repeat during remediation completed in 3.13 seconds, proving
  latency is variable but not disproving the missing source deadline found in
  code; no abort/retry/cache boundary existed at the failed SHA.

### 2026-08-25 - AUD-004

- Command: `pnpm exec vitest run tests/integration/api.test.ts --reporter=verbose`
- Input: owned historical experiment and `POST /api/v2/experiments/:id/replay`.
- Observed: the request executed source acquisition, policy, outcome, and
  completion inline and returned HTTP `200` with terminal `SUCCEEDED`.
- Source inspection confirmed market cap 12, first order page only, fill cap
  1,000, global idempotency uniqueness, no job deadline/cancel/restart worker,
  and scoring despite `PARTIAL` source manifests.

## Status Vocabulary

- `AWAITING_REPRODUCTION`
- `REPRODUCED`
- `FIXED`
- `DEFERRED_P2_P3`
- `ESCALATED_TO_SYSTEM_2`
- `DISPUTED_WITH_REPRODUCIBLE_EVIDENCE`

## Verification Log

### 2026-08-26 - Local regression

- `pnpm check`: PASS, including lint, typecheck, and 85 unit/integration tests.
- `pnpm build`: PASS.
- Targeted adversarial suite: PASS, 55 tests across audit remediation, API,
  evaluation, DreamDEX, and policy-runtime coverage.
- `pnpm test:e2e`: PASS when run against the local built server at
  `http://localhost:3011`.
- `pnpm secret:scan`: PASS after removing hash-shaped prose from this report.
- `pnpm evidence:manifest`: regenerated repository evidence manifest.
