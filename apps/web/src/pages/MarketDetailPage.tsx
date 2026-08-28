import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError,
  apiErrorMessage,
  compactId,
  fetchV2,
  formatEpoch,
  type HistoricalCandlesResponse,
  type HistoricalDetailResponse,
  type HistoricalFillsResponse,
  type HistoricalOrdersResponse,
  type HistoricalResolutionResponse,
  type HistoricalStatusHistoryResponse
} from "../data.js";

function UnknownValue() {
  return <span className="mutedCell">Not available</span>;
}

function decimalFromRaw(raw: string | null | undefined, decimals: number): number | null {
  if (raw === null || raw === undefined || !/^[0-9]+$/.test(raw) || decimals < 0) {
    return null;
  }
  if (decimals === 0) {
    const wholeValue = Number(raw);
    return Number.isFinite(wholeValue) ? wholeValue : null;
  }
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/, "");
  const value = Number(`${whole}${fraction.length > 0 ? `.${fraction}` : ""}`);
  return Number.isFinite(value) ? value : null;
}

function probabilityLabel(raw: string | null | undefined, decimals: number): string {
  const value = decimalFromRaw(raw, decimals);
  return value === null ? "Not available" : `${(value * 100).toFixed(2)}% YES/UP`;
}

function tokenQuantityLabel(raw: string | null | undefined): string {
  const value = decimalFromRaw(raw, 18);
  if (value === null) {
    return "Not available";
  }
  return value >= 1 ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : value.toPrecision(4);
}

function routePlane(value: string | null): "mainnet-history" | "shannon-live" | null {
  if (value === "mainnet-history" || value === "shannon-live") {
    return value;
  }
  return null;
}

export default function MarketDetailPage() {
  const { marketId } = useParams();
  const [searchParams] = useSearchParams();
  const validMarketId = /^0x[a-fA-F0-9]{64}$/.test(marketId ?? "");
  const plane = routePlane(searchParams.get("plane"));
  const mainnetDetail = validMarketId && plane === "mainnet-history";

  const detailQuery = useQuery({
    enabled: mainnetDetail,
    queryKey: ["historical-market-detail", marketId],
    queryFn: () => fetchV2<HistoricalDetailResponse>(`/api/v2/mainnet/history/markets/${marketId ?? ""}`)
  });
  const resolutionQuery = useQuery({
    enabled: mainnetDetail,
    queryKey: ["historical-market-resolution", marketId],
    queryFn: () => fetchV2<HistoricalResolutionResponse>(`/api/v2/mainnet/history/markets/${marketId ?? ""}/resolution`)
  });
  const statusQuery = useQuery({
    enabled: mainnetDetail,
    queryKey: ["historical-market-status", marketId],
    queryFn: () =>
      fetchV2<HistoricalStatusHistoryResponse>(`/api/v2/mainnet/history/markets/${marketId ?? ""}/status-history`)
  });
  const candlesQuery = useQuery({
    enabled: mainnetDetail,
    queryKey: ["historical-market-candles", marketId],
    queryFn: () =>
      fetchV2<HistoricalCandlesResponse>(
        `/api/v2/mainnet/history/markets/${marketId ?? ""}/candles?intervalSeconds=3600&limit=12`
      )
  });
  const ordersQuery = useQuery({
    enabled: mainnetDetail,
    queryKey: ["historical-market-orders", marketId],
    queryFn: () => fetchV2<HistoricalOrdersResponse>(`/api/v2/mainnet/history/markets/${marketId ?? ""}/orders?limit=12`)
  });
  const fillsQuery = useQuery({
    enabled: mainnetDetail,
    queryKey: ["historical-market-fills", marketId],
    queryFn: () => fetchV2<HistoricalFillsResponse>(`/api/v2/mainnet/history/markets/${marketId ?? ""}/fills?limit=12`)
  });
  const bookQuery = useQuery({
    enabled: mainnetDetail,
    retry: false,
    queryKey: ["historical-market-book", marketId],
    queryFn: async () => {
      try {
        await fetchV2<unknown>(`/api/v2/mainnet/history/markets/${marketId ?? ""}/reconstructed-book?atBlock=latest`);
        return "AVAILABLE";
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 409) {
          return "SOURCE_INCOMPLETE";
        }
        throw error;
      }
    }
  });

  const market = detailQuery.data?.data.market;
  const quoteDecimals = market?.quoteDecimals ?? 18;
  const bookCapabilityMessage = bookQuery.isLoading
    ? "Checking reconstruction capability..."
    : bookQuery.data ?? (bookQuery.isError ? apiErrorMessage(bookQuery.error) : "SOURCE_INCOMPLETE");

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Market Detail</p>
        <h1>Inspect one DreamDEX market with source provenance.</h1>
        <p>Orders, fills, candles, lifecycle, and resolution remain separate evidence tabs.</p>
      </section>

      {!validMarketId ? (
        <section className="routePanel" aria-label="Market detail state">
          <span className="statusPill">Invalid route</span>
          <h2>Market ID is not a DreamDEX bytes32 identifier.</h2>
          <p className="monoText">{marketId ?? "No market selected"}</p>
          <Link className="secondaryAction" to="/markets">
            Back to Markets
          </Link>
        </section>
      ) : null}

      {validMarketId && plane === null ? (
        <section className="routePanel" aria-label="Market plane required">
          <span className="statusPill statusWarning">Plane required</span>
          <h2>Choose the market evidence plane before loading detail.</h2>
          <p>Market identifiers can exist on different chains, so EdgeLab will not infer one from the URL.</p>
          <div className="actionRow">
            <Link className="primaryAction" to={`/markets/${marketId ?? ""}?plane=mainnet-history`}>
              Mainnet Historical
            </Link>
            <Link className="secondaryAction" to={`/markets?plane=shannon-live`}>
              Shannon Live
            </Link>
          </div>
        </section>
      ) : null}

      {validMarketId && plane === "shannon-live" ? (
        <section className="routePanel" aria-label="Shannon market detail unavailable">
          <span className="statusPill">SHANNON_FORWARD</span>
          <h2>Shannon live market detail is not served by the mainnet history route.</h2>
          <p>Use the live market list or Strategy Lab for forward observation. No mainnet historical request was made for this URL.</p>
          <div className="actionRow">
            <Link className="primaryAction" to={`/lab?market=${encodeURIComponent(marketId ?? "")}`}>
              Use in Strategy Lab
            </Link>
            <Link className="secondaryAction" to="/markets?plane=shannon-live">
              Back to Live Markets
            </Link>
          </div>
        </section>
      ) : null}

      {mainnetDetail ? (
        <>
          <section className="routePanel" aria-label="Market detail state">
            <div className="sourceBar">
              <span className="statusPill">MAINNET_HISTORICAL</span>
              <span className="statusPill">Read-only</span>
              <span className="statusPill">{detailQuery.isFetching ? "Refreshing" : "Current response"}</span>
            </div>
            {detailQuery.isLoading ? (
              <div className="stateBox" role="status">
                Loading market detail...
              </div>
            ) : null}
            {detailQuery.isError ? (
              <div className="stateBox errorState" role="alert">
                {apiErrorMessage(detailQuery.error)}
              </div>
            ) : null}
            {market !== undefined ? (
              <>
                <h2>{market.question}</h2>
                <p className="monoText">{market.stableMarketId}</p>
                <dl className="factGrid">
                  <div>
                    <dt>Asset</dt>
                    <dd>{market.asset}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{market.status}</dd>
                  </div>
                  <div>
                    <dt>Winning outcome</dt>
                    <dd>{market.winningOutcome ?? "Not resolved"}</dd>
                  </div>
                  <div>
                    <dt>Window</dt>
                    <dd>
                      {formatEpoch(market.tradingStartSeconds)} to {formatEpoch(market.expirySeconds)}
                    </dd>
                  </div>
                  <div>
                    <dt>Trades</dt>
                    <dd>{market.tradeCount}</dd>
                  </div>
                  <div>
                    <dt>Opening price</dt>
                    <dd>{market.openingPriceRaw ?? "Not available"}</dd>
                  </div>
                </dl>
                <div className="actionRow">
                  <Link className="primaryAction" to={`/lab?market=${encodeURIComponent(market.stableMarketId)}`}>
                    Use in Strategy Lab
                  </Link>
                  <Link className="secondaryAction" to="/markets?plane=mainnet-history">
                    Back to Markets
                  </Link>
                </div>
              </>
            ) : null}
          </section>

          <section className="detailGrid" aria-label="Historical market evidence">
            <article className="routePanel">
              <span className="statusPill">Lifecycle</span>
              <h2>Status history</h2>
              {statusQuery.data?.data.statusHistory.length === 0 ? <p>No status transition rows returned.</p> : null}
              {statusQuery.isError ? <p className="errorText">{apiErrorMessage(statusQuery.error)}</p> : null}
              <div className="dataTable compactTable" role="table" aria-label="Status history">
                {statusQuery.data?.data.statusHistory.map((row) => (
                  <div role="row" key={`${row.blockNumber}-${row.newStatus}`}>
                    <span role="cell">{row.oldStatus}</span>
                    <span role="cell">{row.newStatus}</span>
                    <span role="cell">Block {row.blockNumber}</span>
                    <span role="cell">{formatEpoch(row.timestampSeconds)}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="routePanel">
              <span className="statusPill">Resolution</span>
              <h2>Outcome data</h2>
              {resolutionQuery.isLoading ? <p>Loading resolution...</p> : null}
              {resolutionQuery.isError ? <p className="errorText">{apiErrorMessage(resolutionQuery.error)}</p> : null}
              <dl className="factGrid twoCol">
                <div>
                  <dt>Opening answer</dt>
                  <dd>{resolutionQuery.data?.data.resolution.openingAnswer === null ? <UnknownValue /> : "Available"}</dd>
                </div>
                <div>
                  <dt>Closing answer</dt>
                  <dd>{resolutionQuery.data?.data.resolution.closingAnswer === null ? <UnknownValue /> : "Available"}</dd>
                </div>
              </dl>
              <p>Resolution is displayed after the fact. It is never supplied to historical strategy decisions.</p>
            </article>

            <article className="routePanel">
              <span className="statusPill">Candles</span>
              <h2>OHLC evidence</h2>
              {candlesQuery.isError ? <p className="errorText">{apiErrorMessage(candlesQuery.error)}</p> : null}
              <div className="dataTable candleTable" role="table" aria-label="Historical candles">
                <div role="row" className="tableHeader">
                  <span role="columnheader">Bucket</span>
                  <span role="columnheader">Open</span>
                  <span role="columnheader">Close</span>
                  <span role="columnheader">Trades</span>
                </div>
                {candlesQuery.data?.data.candles.map((row) => (
                  <div role="row" key={row.bucketStartSeconds}>
                    <span role="cell">{formatEpoch(row.bucketStartSeconds)}</span>
                    <span role="cell">{row.openPriceRaw}</span>
                    <span role="cell">{row.closePriceRaw}</span>
                    <span role="cell">{row.tradeCount}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="routePanel">
              <span className="statusPill">Orders</span>
              <h2>Bounded order sample</h2>
              {ordersQuery.isError ? <p className="errorText">{apiErrorMessage(ordersQuery.error)}</p> : null}
              <div className="dataTable orderTable" role="table" aria-label="Historical orders">
                <div role="row" className="tableHeader">
                  <span role="columnheader">Order</span>
                  <span role="columnheader">Side</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Price</span>
                  <span role="columnheader">Remaining</span>
                </div>
                {ordersQuery.data?.data.orders.map((row) => (
                  <div role="row" key={row.orderId}>
                    <span role="cell">{compactId(row.orderId)}</span>
                    <span role="cell">{row.side}</span>
                    <span role="cell">{row.status}</span>
                    <span role="cell" title={`raw ${row.priceRaw}`}>
                      {probabilityLabel(row.priceRaw, quoteDecimals)}
                    </span>
                    <span role="cell" title={`raw ${row.remainingQuantityRaw}`}>
                      {tokenQuantityLabel(row.remainingQuantityRaw)}
                    </span>
                  </div>
                ))}
              </div>
            </article>

            <article className="routePanel">
              <span className="statusPill">Fills</span>
              <h2>Bounded fill sample</h2>
              {fillsQuery.isError ? <p className="errorText">{apiErrorMessage(fillsQuery.error)}</p> : null}
              {fillsQuery.data?.data.fills.length === 0 ? <p>No fills returned for this bounded page.</p> : null}
              <div className="dataTable fillTable" role="table" aria-label="Historical fills">
                <div role="row" className="tableHeader">
                  <span role="columnheader">Block</span>
                  <span role="columnheader">Kind</span>
                  <span role="columnheader">Price</span>
                  <span role="columnheader">Quantity</span>
                </div>
                {fillsQuery.data?.data.fills.map((row) => (
                  <div role="row" key={`${row.blockNumber}-${row.logIndex}`}>
                    <span role="cell">
                      {row.blockNumber}:{row.logIndex}
                    </span>
                    <span role="cell">{row.kind ?? "Unknown"}</span>
                    <span role="cell" title={`raw ${row.fillPriceRaw}`}>
                      {probabilityLabel(row.fillPriceRaw, quoteDecimals)}
                    </span>
                    <span role="cell" title={`raw ${row.quantityRaw}`}>
                      {tokenQuantityLabel(row.quantityRaw)}
                    </span>
                  </div>
                ))}
              </div>
            </article>

            <article className="routePanel">
              <span className="statusPill statusWarning">Source incomplete</span>
              <h2>Reconstructed resting book</h2>
              <p>
                EdgeLab does not display a historical book until completeness, lifecycle semantics,
                same-block ordering, and archive comparison are proven.
              </p>
              <div className="stateBox">
                {bookCapabilityMessage}
              </div>
            </article>
          </section>
        </>
      ) : null}
    </div>
  );
}
