# DreamDEX / Somnia SDK Feedback

Captured during EdgeLab implementation against `@somnia-chain/markets-sdk` `0.28.1` on Somnia mainnet `5031` and Shannon chain `50312`.

## Useful Surfaces

- Mainnet `listPastBinaryMarkets`, `countBinaryMarkets`, `getMarketResolution`, `getMarketStatusHistory`, `getOpeningPrices`, and `getCandles` were sufficient for read-only market exploration when EdgeLab supplied stable market IDs and lifecycle windows.
- `listLiveBinaryMarkets`, `getBinaryBookParams`, `getOrderOnchain`, and `getOwnOpenOrdersOnchain` were sufficient to verify a real no-fill order lifecycle without relying on indexer lag.
- `OrderPlaced` plus `BinaryOrderPlaced(kind=0)` gave the semantic proof needed to distinguish the order as `BUY_YES`.
- The SDK comments around binary order expiry were accurate: binary orders must not outlive market expiry.

## Integration Friction

- `createTrader(...).buildPlaceOrder(...)` still requires an authenticated signer-shaped configuration, even when only unsigned call data is needed. EdgeLab avoided local signing by ABI-encoding the bounded browser-wallet call directly.
- Historical fill access is pool-oriented in the SDK, while strategy replay needs stable market identity. EdgeLab used fixed server-side GraphQL by `market_id` for fills and orders rather than browser-proxying arbitrary queries.
- Pools can be reused across markets. Candle calls by pool must be constrained to the target market lifecycle, and UI/API provenance must show both stable market ID and pool/window.
- Public count helpers can behave as capped fallbacks. EdgeLab labels counts as `EXACT` only below the cap and `AT_LEAST` at the cap.
- Native historical resting-book snapshots were not exposed through the SDK/indexer surfaces verified here. Reconstruction remains `SOURCE_INCOMPLETE / FAIL-CLOSED` until order/fill lifecycle semantics and same-block ordering are independently proven.
- Fill ordering exposes block/log fields, but not a transaction index in the verified indexer schema. EdgeLab sorts by timestamp, block, nullable transaction index, log index, and row ID; exact event-level reconstruction remains disabled without stronger ordering proof.
- `getBinaryPositionPnL` represents actual-account indexed fills/router actions/current balances/marks. It must not be used as counterfactual replay PnL.
- The Somnia RPC rejected `eth_getLogs` ranges larger than 1000 blocks. Evidence collection now chunks log reads.
- A `cancelOrder(orderId)` call that lands after order expiry can succeed and emit `OrderExpired` rather than `OrderCancelled`. This is valid terminal proof, but UIs and evidence schemas should label it explicitly.
- Community builder notes from the Event Contracts channel reported that `collateral()` is exposed on the per-window market, for example `IBinaryMarket(pool.market()).collateral()`, rather than directly on `BinaryPool`. EdgeLab's evidence model already records collateral at the market/window layer; final SDK feedback should verify this against the current contract ABI before submission.
- The same channel reported that `builderFeeBpsTimes1k` must be encoded as `uint96`, and that using `uint256` can produce an undecodable revert. EdgeLab does not rely on builder-fee mutation in the current proof path, but this is useful DreamDEX integration feedback to preserve and verify.
- Builder discussion also reinforced that order cancellation authority belongs to the order owner. EdgeLab keeps cancellation as a human-authorized owner-wallet action and does not present delegated cancellation as available.

## Faucet / Testnet Operations Notes

- The Somnia helper faucet sends `STT` for gas and `tUSDC` for Event Contract collateral on Shannon testnet chain `50312`.
- Observed commands were `/faucet 0xYourAddress`, `/faucet tusdc 0xYourAddress`, `/register 0xYourAddress`, and `/faucet` after registration.
- Observed limits were `50 STT` and `500 tUSDC` every 24 hours, with token-specific cooldowns.
- The Shannon tUSDC address observed from the builder channel was `0xc917D83E43C1BfCf693107AAb7Ec9719293b8cfe`; final demo setup should re-verify this against DreamDEX docs and public chain metadata.

## EdgeLab Handling

- The service never receives a signing account and never submits wallet transactions.
- Mainnet usage is read-only and has no signer, transaction constructor, or autonomous write path.
- Historical replay fetches outcomes only after pre-cutoff decision frames are persisted.
- Historical book reconstruction stays unavailable and does not feed policy, evaluation, tradeability, or PnL claims.
- Approval was exact to the expected escrow amount, not unlimited.
- The order lifecycle remained valid with no fill: order receipt, semantic event, no-fill state, terminal event, and collateral reconciliation were recorded separately.
