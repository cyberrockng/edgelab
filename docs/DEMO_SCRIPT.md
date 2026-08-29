# EdgeLab Demo Script

Target duration: 2:40. Do not record or submit this until a fresh independent System 3 audit passes.

## 0:00-0:20 Opening

EdgeLab is a promotion gate for DreamDEX Event Contract strategies. It answers one question: has this strategy earned progression, or is the qualification still incomplete under the evidence rules?

State the lane clearly: EdgeLab is not an order-book trust classifier, exchange clone, or trading bot. It qualifies strategy evidence by separating mainnet historical research, Shannon live-shadow evidence, and human-authorized Shannon execution proof.

## 0:20-0:55 Market Reality

Open `/markets?plane=mainnet-history`, filter a finalized BTC or ETH market, and inspect `/markets/:marketId?plane=mainnet-history`.

Show the stable market ID, pool, lifecycle, fills/orders/candles, and `SOURCE_INCOMPLETE` reconstructed book state. State that pool reuse is isolated by market window and no stored historical book snapshot is claimed.

## 0:55-1:30 Strategy Lab

Open Strategy Lab from the market CTA. Select Last-Trade Probability, historical replay mode, interval, decision offset, and the fixed watch-only risk envelope. Create the experiment, then start replay.

Show queued/running/completed status, decision frame hash, cutoff block, `forecastPUp`, action, exclusions, and that outcomes are loaded only after decisions.

## 1:30-2:00 Evidence Gate And Compare

Evaluate the replay from the workspace. Show the server-authored Evidence Gate: verdict, reasons, sample count, Brier/bias when available, provenance, tradeability, PnL availability, and next permitted action.

Open `/compare`, select two to four owned assessments when available, save, and refresh `/compare/:comparisonId` to show the saved immutable comparison.

## 2:00-2:30 Shannon Proof

Open `/proof`. Show chain `50312`, exact approval, POST_ONLY BUY_YES order, no fill, actual `OrderExpired` terminal event, collateral reconciliation, and explorer links. State that this proves execution handling, not profit.

Mention that Shannon setup used STT for gas and tUSDC collateral from the public faucet path. Do not narrate or display private wallet material.

## 2:30-2:40 Close

Restate the boundary: EdgeLab promotes only when evidence is sufficient. If the corrected evidence says `INSUFFICIENT_EVIDENCE`, present it as a controlled qualification state: real evidence was evaluated, but advancement stays closed until the missing evidence is collected.
