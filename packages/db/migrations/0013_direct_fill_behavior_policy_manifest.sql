DROP TRIGGER IF EXISTS policy_versions_append_only ON policy_versions;

UPDATE policy_versions
SET
  source_hash = 'd8451528c5f423e9bcb9a34a3d35e8f773c4ddbda5920c0f9199a261c2b4006c',
  manifest = '{
    "policyId": "historical-last-trade",
    "version": "1.1.0",
    "label": "Last-Trade Probability",
    "adapterName": "historicalLastTradeProbabilityPolicy",
    "sourceHash": "d8451528c5f423e9bcb9a34a3d35e8f773c4ddbda5920c0f9199a261c2b4006c",
    "implementationHash": "3440452063e86422728ab5b4bf1a317da37da61902b47d87eb0db4d9485391fc",
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
