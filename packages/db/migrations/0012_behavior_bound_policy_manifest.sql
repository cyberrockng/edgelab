DROP TRIGGER IF EXISTS policy_versions_append_only ON policy_versions;

UPDATE policy_versions
SET
  source_hash = 'd436cd113dff89d37bf542fff2fc6fccdfe5b395d20cb856b7dc9794e5a0a889',
  manifest = '{
    "policyId": "historical-last-trade",
    "version": "1.1.0",
    "label": "Last-Trade Probability",
    "adapterName": "historicalLastTradeProbabilityPolicy",
    "sourceHash": "d436cd113dff89d37bf542fff2fc6fccdfe5b395d20cb856b7dc9794e5a0a889",
    "implementationHash": "74c3ea12c0849db864b1cc5b4b9006743f449a97244f83245b6e16543b604635",
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
