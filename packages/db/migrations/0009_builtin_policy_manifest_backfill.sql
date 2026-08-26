DROP TRIGGER IF EXISTS policy_versions_append_only ON policy_versions;

UPDATE policy_versions
SET label = 'Educational neutral baseline',
    adapter_name = 'referenceNeutralPolicy',
    source_hash = '498cdefa23848b4fb00a9f517aa418bb25ccab9e857d792ca5dd4a7ab05d534d',
    manifest = '{
      "policyId": "reference-neutral",
      "version": "1.0.0",
      "label": "Educational neutral baseline",
      "adapterName": "referenceNeutralPolicy",
      "sourceHash": "498cdefa23848b4fb00a9f517aa418bb25ccab9e857d792ca5dd4a7ab05d534d",
      "implementationHash": "94be8beb48af1214acea71ddb3fed86d8d217542f767c914fb945a007976410b",
      "parameters": { "forecastPUp": 0.5, "action": "WATCH_ONLY" },
      "supportedPlanes": ["MAINNET_HISTORICAL", "SHANNON_FORWARD"]
    }'::jsonb
WHERE policy_id = 'reference-neutral'
  AND version = '1.0.0';

UPDATE policy_versions
SET label = 'Educational captured-book tilt',
    adapter_name = 'referenceBookTiltPolicy',
    source_hash = '72f757b2f97c7764b7c4b31b8934974214c97fe8562976ef9c09b6322276b47f',
    manifest = '{
      "policyId": "reference-book-tilt",
      "version": "1.0.0",
      "label": "Educational captured-book tilt",
      "adapterName": "referenceBookTiltPolicy",
      "sourceHash": "72f757b2f97c7764b7c4b31b8934974214c97fe8562976ef9c09b6322276b47f",
      "implementationHash": "52f1b2c9f3f6873afdeefafee2f53896c0fe7c3bd21fd1a78f5a956334a569c5",
      "parameters": { "neutralForecastPUp": 0.5, "tilt": 0.04 },
      "supportedPlanes": ["SHANNON_FORWARD"]
    }'::jsonb
WHERE policy_id = 'reference-book-tilt'
  AND version = '1.0.0';

UPDATE policy_versions
SET label = 'Last-Trade Probability',
    adapter_name = 'historicalLastTradeProbabilityPolicy',
    source_hash = '55701efdfcde6afce916a66c1be0a25246d4514b8d052a77a3e7f2de9d552936',
    manifest = '{
      "policyId": "historical-last-trade",
      "version": "1.0.0",
      "label": "Last-Trade Probability",
      "adapterName": "historicalLastTradeProbabilityPolicy",
      "sourceHash": "55701efdfcde6afce916a66c1be0a25246d4514b8d052a77a3e7f2de9d552936",
      "implementationHash": "b51591880ce6ce552e5658771a51484c6810264e23992d58bf7df21d39bb9994",
      "parameters": {
        "lookbackSeconds": 900,
        "targetOutcome": "YES_UP",
        "priceScale": "fillPriceRaw / 10^quoteDecimals",
        "probabilityClamp": [0.05, 0.95],
        "fillOrder": ["timestampSeconds", "blockNumber", "transactionIndex", "logIndex", "id"]
      },
      "supportedPlanes": ["MAINNET_HISTORICAL"]
    }'::jsonb
WHERE policy_id = 'historical-last-trade'
  AND version = '1.0.0';

CREATE TRIGGER policy_versions_append_only
BEFORE UPDATE OR DELETE ON policy_versions
FOR EACH ROW
EXECUTE FUNCTION reject_policy_version_mutation();
