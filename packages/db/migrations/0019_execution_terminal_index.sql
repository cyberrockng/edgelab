DROP INDEX IF EXISTS one_nonterminal_intent_per_wallet_market;

CREATE UNIQUE INDEX one_nonterminal_intent_per_wallet_market
  ON execution_intents(owner_address, market_id)
  WHERE state NOT IN (
    'SETTLED', 'CANCELLED', 'EXPIRED', 'UNVERIFIED', 'FAILED',
    'TX_REVERTED', 'REDEEMED'
  );
