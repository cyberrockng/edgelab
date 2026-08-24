# DreamDEX / Somnia SDK Feedback

Captured during EdgeLab implementation against `@somnia-chain/markets-sdk` `0.28.1` on Somnia Shannon chain `50312`.

## Useful Surfaces

- `listLiveBinaryMarkets`, `getBinaryBookParams`, `getOrderOnchain`, and `getOwnOpenOrdersOnchain` were sufficient to verify a real no-fill order lifecycle without relying on indexer lag.
- `OrderPlaced` plus `BinaryOrderPlaced(kind=0)` gave the semantic proof needed to distinguish the order as `BUY_YES`.
- The SDK comments around binary order expiry were accurate: binary orders must not outlive market expiry.

## Integration Friction

- `createTrader(...).buildPlaceOrder(...)` still requires an authenticated signer-shaped configuration, even when only unsigned call data is needed. EdgeLab avoided local signing by ABI-encoding the bounded browser-wallet call directly.
- The Somnia RPC rejected `eth_getLogs` ranges larger than 1000 blocks. Evidence collection now chunks log reads.
- A `cancelOrder(orderId)` call that lands after order expiry can succeed and emit `OrderExpired` rather than `OrderCancelled`. This is valid terminal proof, but UIs and evidence schemas should label it explicitly.

## EdgeLab Handling

- The service never receives a signing account and never submits wallet transactions.
- Approval was exact to the expected escrow amount, not unlimited.
- The order lifecycle remained valid with no fill: order receipt, semantic event, no-fill state, terminal event, and collateral reconciliation were recorded separately.
