DROP TRIGGER IF EXISTS policy_versions_append_only ON policy_versions;

UPDATE policy_versions
SET
  source_hash = '149346eea14d0b1b58579d38be7f62d43fa27ba546168f66ffd7873d733abe38',
  manifest = '{
    "policyId": "historical-last-trade",
    "version": "1.1.0",
    "label": "Last-Trade Probability",
    "adapterName": "historicalLastTradeProbabilityPolicy",
    "sourceHash": "149346eea14d0b1b58579d38be7f62d43fa27ba546168f66ffd7873d733abe38",
    "implementationHash": "2b55050552bd63f2f9b00129706f9ace9b88225c8c0b6955c1ff040634678f75",
    "parameters": {
      "lookbackSeconds": 900,
      "targetOutcome": "YES_UP",
      "priceScale": "DreamDEX YES-term fillPriceRaw / 10^quoteDecimals",
      "probabilityClamp": [0.05, 0.95],
      "fillOrder": ["timestampSeconds", "blockNumber", "transactionIndex", "logIndex", "id"],
      "dataSemantics": "DreamDEX binary fill prices are canonical market-level YES/UP probabilities",
      "supersedes": "historical-last-trade@1.0.0"
    },
    "supportedPlanes": ["MAINNET_HISTORICAL"]
  }'::jsonb
WHERE policy_id = 'historical-last-trade'
  AND version = '1.1.0';

CREATE TRIGGER policy_versions_append_only
BEFORE UPDATE OR DELETE ON policy_versions
FOR EACH ROW
EXECUTE FUNCTION reject_policy_version_mutation();
