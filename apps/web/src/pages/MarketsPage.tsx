import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  apiErrorMessage,
  compactId,
  fetchV2,
  formatEpoch,
  type HistoricalCountResponse,
  type MarketsMeta,
  type MarketsResponse
} from "../data.js";

const pageSize = 12;
type RoutePlane = "mainnet-history" | "shannon-live";

function parseRoutePlane(value: string | null): RoutePlane {
  return value === "shannon-live" ? "shannon-live" : "mainnet-history";
}

function planeBadge(plane: RoutePlane): "MAINNET_HISTORICAL" | "SHANNON_FORWARD" {
  return plane === "mainnet-history" ? "MAINNET_HISTORICAL" : "SHANNON_FORWARD";
}

function intervalLabel(seconds: string): string {
  const labels: Record<string, string> = {
    "900": "15 minutes",
    "3600": "1 hour",
    "14400": "4 hours",
    "86400": "24 hours"
  };
  return labels[seconds] ?? `${seconds}s`;
}

function buildHistoricalPath(asset: string, interval: string, status: string, offset: number): string {
  const params = new URLSearchParams({
    asset,
    intervalSec: interval,
    status,
    limit: String(pageSize),
    offset: String(offset)
  });
  return `/api/v2/mainnet/history/markets?${params.toString()}`;
}

export default function MarketsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const plane = parseRoutePlane(searchParams.get("plane"));
  const [draftPlane, setDraftPlane] = useState(plane);
  const [asset, setAsset] = useState(searchParams.get("asset") ?? "BTC");
  const [interval, setInterval] = useState(searchParams.get("interval") ?? "3600");
  const [status, setStatus] = useState(searchParams.get("status") ?? "Finalized");
  const offset = Number(searchParams.get("offset") ?? "0");
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;

  const marketsQuery = useQuery({
    queryKey: ["markets", plane, asset, interval, status, safeOffset],
    queryFn: () =>
      plane === "mainnet-history"
        ? fetchV2<MarketsResponse, MarketsMeta>(buildHistoricalPath(asset, interval, status, safeOffset))
        : fetchV2<MarketsResponse, MarketsMeta>("/api/v2/shannon/markets/live")
  });

  const countQuery = useQuery({
    enabled: plane === "mainnet-history",
    queryKey: ["historical-market-count", asset, interval, status],
    queryFn: () =>
      fetchV2<HistoricalCountResponse>(
        `/api/v2/mainnet/history/markets/count?${new URLSearchParams({
          asset,
          intervalSec: interval,
          status
        }).toString()}`
      )
  });

  const filteredMarkets = useMemo(() => {
    const rows = marketsQuery.data?.data.markets ?? [];
    if (plane === "mainnet-history") {
      return rows;
    }
    return rows.filter(
      (market) =>
        market.asset === asset &&
        (market.intervalSeconds === null || market.intervalSeconds === Number(interval))
    );
  }, [asset, interval, marketsQuery.data?.data.markets, plane]);

  function applyFilters() {
    setSearchParams({
      plane: draftPlane,
      asset,
      interval,
      ...(draftPlane === "mainnet-history" ? { status } : {}),
      offset: "0"
    });
  }

  function setOffset(nextOffset: number) {
    setSearchParams({
      plane,
      asset,
      interval,
      ...(plane === "mainnet-history" ? { status } : {}),
      offset: String(Math.max(0, nextOffset))
    });
  }

  const source = marketsQuery.data?.meta.source;
  const totalText =
    plane === "mainnet-history"
      ? countQuery.data === undefined
        ? "Counting markets..."
        : `${countQuery.data.data.countRelation === "AT_LEAST" ? "At least " : ""}${String(countQuery.data.data.count)} markets`
      : "Live successor set";

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">DreamDEX Market Explorer</p>
        <h1>Browse historical and live Event Contract markets without mixing networks.</h1>
        <p>Mainnet research is read-only. Shannon routes are for forward observation and execution proof.</p>
      </section>

      <section className="workflowGrid" aria-label="Market filters">
        <form
          className="controlPanel"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
        >
          <label>
            Plane
            <select
              value={draftPlane}
              onChange={(event) => {
                setDraftPlane(event.target.value as RoutePlane);
              }}
            >
              <option value="mainnet-history">Mainnet historical</option>
              <option value="shannon-live">Shannon live</option>
            </select>
          </label>
          <label>
            Asset
            <select
              value={asset}
              onChange={(event) => {
                setAsset(event.target.value);
              }}
            >
              <option>BTC</option>
              <option>ETH</option>
            </select>
          </label>
          <label>
            Interval
            <select
              value={interval}
              onChange={(event) => {
                setInterval(event.target.value);
              }}
            >
              <option value="900">15 minutes</option>
              <option value="3600">1 hour</option>
              <option value="14400">4 hours</option>
              <option value="86400">24 hours</option>
            </select>
          </label>
          {draftPlane === "mainnet-history" ? (
            <label>
              Status
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                }}
              >
                <option>Finalized</option>
                <option>Resolved</option>
              </select>
            </label>
          ) : null}
          <button type="submit">Apply Filters</button>
        </form>

        <article className="routePanel" aria-label="Market explorer state">
          <div className="sourceBar">
            <span className="statusPill">{planeBadge(plane)}</span>
            <span className="statusPill">{totalText}</span>
            <span className="statusPill">{marketsQuery.isFetching ? "Refreshing" : "Current response"}</span>
          </div>
          <h2>{plane === "mainnet-history" ? "Historical DreamDEX markets" : "Live Shannon markets"}</h2>
          <p>
            These rows come from EdgeLab API routes backed by DreamDEX reads. No raw browser GraphQL,
            no owner rows, no stored historical book snapshot claim.
          </p>
          <dl className="factGrid">
            <div>
              <dt>Plane</dt>
              <dd>{planeBadge(plane)}</dd>
            </div>
            <div>
              <dt>Filter</dt>
              <dd>
                {asset} / {intervalLabel(interval)}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{source?.evidenceClass ?? marketsQuery.data?.meta.plane ?? "loading"}</dd>
            </div>
          </dl>

          {marketsQuery.isLoading ? (
            <div className="stateBox" role="status">
              Loading DreamDEX markets...
            </div>
          ) : null}
          {marketsQuery.isError ? (
            <div className="stateBox errorState" role="alert">
              {apiErrorMessage(marketsQuery.error)}
            </div>
          ) : null}
          {!marketsQuery.isLoading && !marketsQuery.isError && filteredMarkets.length === 0 ? (
            <div className="stateBox">No markets matched these filters. EdgeLab will not fabricate rows.</div>
          ) : null}

          {filteredMarkets.length > 0 ? (
            <div className="dataTable marketTable" role="table" aria-label="DreamDEX market results">
              <div role="row" className="tableHeader">
                <span role="columnheader">Market</span>
                <span role="columnheader">Asset</span>
                <span role="columnheader">Window</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Trades</span>
                <span role="columnheader">Action</span>
              </div>
              {filteredMarkets.map((market) => (
                <div role="row" key={market.stableMarketId}>
                  <span role="cell">
                    <strong>{compactId(market.stableMarketId)}</strong>
                    <small>{formatEpoch(market.expirySeconds)}</small>
                  </span>
                  <span role="cell">{market.asset}</span>
                  <span role="cell">{market.intervalSeconds === null ? "Unknown" : intervalLabel(String(market.intervalSeconds))}</span>
                  <span role="cell">{market.status}</span>
                  <span role="cell">{market.tradeCount}</span>
                  <span role="cell">
                    {plane === "mainnet-history" ? (
                      <Link className="secondaryAction inlineAction" to={`/markets/${market.stableMarketId}?plane=mainnet-history`}>
                        Inspect
                      </Link>
                    ) : (
                      <Link className="secondaryAction inlineAction" to={`/lab?market=${encodeURIComponent(market.stableMarketId)}`}>
                        Use in Lab
                      </Link>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {plane === "mainnet-history" ? (
            <div className="paginationRow">
              <button
                type="button"
                onClick={() => {
                  setOffset(safeOffset - pageSize);
                }}
                disabled={safeOffset === 0}
              >
                Previous
              </button>
              <span>
                Offset {safeOffset} / page size {pageSize}
              </span>
              <button
                type="button"
                onClick={() => {
                  setOffset(safeOffset + pageSize);
                }}
                disabled={marketsQuery.data?.meta.hasMore !== true}
              >
                Next
              </button>
            </div>
          ) : null}
        </article>
      </section>
    </div>
  );
}
