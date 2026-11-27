import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Crosshair, SlidersHorizontal, Waves } from 'lucide-react';
import type { Candle, ContractType, Liquidation, MarketStatus } from '@/hooks/use-binance-market';
import { useLiquidationFeeds, type LiquidationEvent, type LiquidationFeed, type LiquidationFeeds } from '@/hooks/use-liquidation-feeds';
import { detectCvdSwingDivergences } from '@/utils/orderflow';

const COLUMNS = 36;
const ROWS = 18;
const windows = [15, 30, 60];

function compact(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

function formatPrice(value: number) {
  return value.toLocaleString('en-US', { minimumFractionDigits: value >= 1_000 ? 2 : 3, maximumFractionDigits: value >= 1_000 ? 2 : 6 });
}

function formatClock(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ExchangeLatency({ feeds }: { feeds: LiquidationFeeds }) {
  return <div className="liq-latency" aria-label="Liquidation feed status and estimated event latency">
    {(Object.entries(feeds) as Array<[keyof LiquidationFeeds, LiquidationFeed]>).map(([exchange, feed]) => (
      <div className={`liq-feed ${feed.phase}`} key={exchange} title={exchange === 'BINANCE' ? 'Binance delay is estimated against Binance server time.' : 'Event-time age estimate; exchange clocks are not synchronized to this browser.'}>
        <span><i />{exchange}</span>
        <strong>{feed.phase === 'paused' ? 'PAUSED' : feed.phase === 'connecting' ? 'CONNECTING' : feed.phase === 'degraded' ? 'DEGRADED' : feed.latencyMs == null ? '—' : `~${Math.round(feed.latencyMs)} ms`}</strong>
      </div>
    ))}
    <small>BINANCE SERVER-ADJUSTED · BYBIT / OKX EVENT-AGE ESTIMATES</small>
  </div>;
}

function ThresholdControls({
  minimumNotional,
  setMinimumNotional,
  minimumPriceSwingPct,
  setMinimumPriceSwingPct,
  minimumCvdSharePct,
  setMinimumCvdSharePct,
}: {
  minimumNotional: number;
  setMinimumNotional: (value: number) => void;
  minimumPriceSwingPct: number;
  setMinimumPriceSwingPct: (value: number) => void;
  minimumCvdSharePct: number;
  setMinimumCvdSharePct: (value: number) => void;
}) {
  const numericControl = (label: string, value: number, setValue: (next: number) => void, step: number, min: number, max: number, prefix?: string, suffix?: string) => (
    <label className="liq-threshold">
      <span>{label}</span>
      <span className="liq-threshold-input">{prefix}<input type="number" min={min} max={max} step={step} value={value} onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (Number.isFinite(next) && next >= min && next <= max) setValue(next);
      }} />{suffix}</span>
    </label>
  );
  return <div className="liq-threshold-controls" aria-label="Liquidation and delta divergence thresholds">
    <div className="liq-control-heading"><SlidersHorizontal size={12} /> THRESHOLDS</div>
    {numericControl('MIN LIQUIDATION', minimumNotional, setMinimumNotional, 25_000, 0, 100_000_000, '$', ' USD')}
    {numericControl('MIN PRICE SWING', minimumPriceSwingPct, setMinimumPriceSwingPct, 0.05, 0, 5, undefined, '%')}
    {numericControl('MIN CVD DELTA', minimumCvdSharePct, setMinimumCvdSharePct, 1, 0, 100, undefined, '% VOL')}
  </div>;
}

type HeatCell = { column: number; row: number; buy: number; sell: number; buyCount: number; sellCount: number; count: number; unknownNotional: number };

function LiquidationGrid({
  events,
  currentPrice,
  now,
  windowMinutes,
  minimumNotional,
}: {
  events: LiquidationEvent[];
  currentPrice: number | null;
  now: number;
  windowMinutes: number;
  minimumNotional: number;
}) {
  const windowMs = windowMinutes * 60_000;
  const start = now - windowMs;
  const recent = events.filter((event) => event.time >= start && event.time <= now + 5_000);
  const visibleEvents = recent.filter((event) => event.notional == null || event.notional >= minimumNotional);
  const priceValues = [...visibleEvents.map((event) => event.price), ...(currentPrice == null ? [] : [currentPrice])];
  const fallbackPrice = currentPrice ?? visibleEvents[0]?.price ?? 1;
  const rawMin = priceValues.length ? Math.min(...priceValues) : fallbackPrice * 0.99;
  const rawMax = priceValues.length ? Math.max(...priceValues) : fallbackPrice * 1.01;
  const padding = Math.max((rawMax - rawMin) * 0.12, Math.max(currentPrice ?? rawMax, 1) * 0.001);
  const low = Math.max(0, rawMin - padding);
  const high = rawMax + padding;
  const span = Math.max(high - low, Number.EPSILON);
  const cells = new Map<string, HeatCell>();

  visibleEvents.forEach((event) => {
    if (event.price < low || event.price > high) return;
    const column = Math.max(0, Math.min(COLUMNS - 1, Math.floor(((event.time - start) / windowMs) * COLUMNS)));
    const row = Math.max(0, Math.min(ROWS - 1, Math.floor(((high - event.price) / span) * ROWS)));
    const key = `${column}:${row}`;
    const cell = cells.get(key) ?? { column, row, buy: 0, sell: 0, buyCount: 0, sellCount: 0, count: 0, unknownNotional: 0 };
    if (event.side === 'buy') {
      cell.buy += event.notional ?? 0;
      cell.buyCount += 1;
    } else if (event.side === 'sell') {
      cell.sell += event.notional ?? 0;
      cell.sellCount += 1;
    } else {
      cell.buy += (event.notional ?? 0) / 2;
      cell.sell += (event.notional ?? 0) / 2;
      cell.buyCount += 0.5;
      cell.sellCount += 0.5;
    }
    if (event.notional == null) cell.unknownNotional += 1;
    cell.count += 1;
    cells.set(key, cell);
  });

  const maxMagnitude = Math.max(1, ...[...cells.values()].map((cell) => cell.buy + cell.sell));
  const priceTicks = Array.from({ length: 5 }, (_, index) => high - (span * index) / 4);
  const recentEvents = visibleEvents.slice().sort((a, b) => b.time - a.time).slice(0, 4);

  return <div className="liq-grid-wrap">
    <div className="liq-grid-summary">
      <span><b>{visibleEvents.length}</b> EVENTS · <b>{new Set(visibleEvents.map((event) => event.exchange)).size}</b> VENUES</span>
      <span>PRICE / TIME · {windowMinutes} MIN</span>
    </div>
    <div className="liq-grid-chart">
      <div className="liq-price-axis">{priceTicks.map((tick, index) => <span key={index}>{formatPrice(tick)}</span>)}</div>
      <div className="liq-grid-cells" role="img" aria-label={`Liquidation clusters for ${visibleEvents.length} events across ${windowMinutes} minutes`}>
        {Array.from({ length: COLUMNS * ROWS }, (_, index) => <i key={`grid-${index}`} />)}
        {currentPrice != null && currentPrice >= low && currentPrice <= high && <div className="liq-current-price" style={{ top: `${((high - currentPrice) / span) * 100}%` }}><span>NOW {formatPrice(currentPrice)}</span></div>}
        {[...cells.values()].map((cell) => {
          const magnitude = cell.buy + cell.sell;
          const strength = magnitude > 0 ? Math.max(0.18, magnitude / maxMagnitude) : 0.18;
          const buyStrength = magnitude ? cell.buy : cell.buyCount;
          const sellStrength = magnitude ? cell.sell : cell.sellCount;
          const tone = buyStrength > sellStrength * 1.2 ? 'buy' : sellStrength > buyStrength * 1.2 ? 'sell' : 'mixed';
          const eventNotional = magnitude ? `$${compact(magnitude)}` : `${cell.count} event${cell.count === 1 ? '' : 's'}`;
          return <div
            key={`${cell.column}:${cell.row}`}
            className={`liq-cell ${tone}`}
            style={{ gridColumn: cell.column + 1, gridRow: cell.row + 1, opacity: strength }}
            title={`${eventNotional} · ${cell.count} event${cell.count === 1 ? '' : 's'}${cell.unknownNotional ? ` · ${cell.unknownNotional} without USD contract value` : ''} · ${formatPrice(high - ((cell.row + 0.5) / ROWS) * span)} · ${formatClock(start + ((cell.column + 0.5) / COLUMNS) * windowMs)}`}
          />;
        })}
      </div>
    </div>
    <div className="liq-time-axis"><span>{formatClock(start)}</span><span>{formatClock(start + windowMs / 2)}</span><span>NOW</span></div>
    <div className="liq-legend"><span><i className="buy" /> BUY-SIDE LIQUIDATIONS</span><span><i className="sell" /> SELL-SIDE LIQUIDATIONS</span><small>Intensity uses USD notional when contract sizing is available.</small></div>
    <div className="liq-event-list">
      {recentEvents.map((event) => <div key={event.id} className="liq-event-row">
        <span className={`liq-event-side ${event.side}`}>{event.side === 'unknown' ? 'LIQ' : event.side.toUpperCase()}</span>
        <b>{event.notional == null ? `${compact(event.qty)} QTY` : `$${compact(event.notional)}`}</b>
        <span>{formatPrice(event.price)}</span>
        <small>{event.exchange}</small>
        <time>{formatClock(event.time)}</time>
      </div>)}
      {!visibleEvents.length && <div className="liq-empty">{recent.length ? 'No events meet the current notional threshold.' : 'Waiting for selected-symbol liquidation events from public exchange streams.'}</div>}
    </div>
  </div>;
}

function DeltaDivergencePanel({
  candles,
  divergences,
  status,
  now,
}: {
  candles: Candle[];
  divergences: ReturnType<typeof detectCvdSwingDivergences>;
  status: MarketStatus;
  now: number;
}) {
  const latest = divergences[divergences.length - 1] ?? null;
  const timeRange = candles.length > 1 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 60_000;
  const active = latest != null && status === 'connected' && now - latest.toTime >= 0 && now - latest.toTime <= Math.max(timeRange * 3, 15_000);
  const formatDelta = (value: number) => `${value >= 0 ? '+' : '−'}${compact(Math.abs(value))}`;

  return <div className={`liq-cvd-panel ${active ? `alert ${latest?.type}` : ''}`}>
    <div className="liq-cvd-heading"><div><Waves size={13} /><span>CUMULATIVE DELTA DIVERGENCE</span></div><span className={active ? 'liq-alert-state' : 'liq-watch-state'}>{active ? <><AlertTriangle size={11} /> {latest?.type.toUpperCase()} SWING</> : 'WATCHING PRICE SWINGS'}</span></div>
    <p className="liq-cvd-method">Confirmed swing pivots compare price extremes with cumulative taker-volume delta between pivots.</p>
    {candles.length < 8
      ? <div className="liq-empty">Collecting enough candles to confirm price and CVD swing pivots.</div>
      : divergences.length
        ? <div className="liq-divergence-list">{divergences.slice().reverse().map((divergence) => {
          const ageMs = now - divergence.toTime;
          const isActive = status === 'connected' && ageMs >= 0 && ageMs <= Math.max(timeRange * 3, 15_000);
          return <div key={`${divergence.type}:${divergence.fromTime}:${divergence.toTime}`} className={`liq-divergence-row ${divergence.type} ${isActive ? 'current' : ''}`} role={isActive ? 'alert' : undefined}>
            <span className="liq-divergence-type">{divergence.type.toUpperCase()}</span>
            <span className="liq-divergence-copy">{divergence.type === 'bullish' ? 'Lower price low · higher CVD low' : 'Higher price high · lower CVD high'}</span>
            <span className="liq-divergence-values">{formatPrice(divergence.priceFrom)} → {formatPrice(divergence.priceTo)}<small>CVD {formatDelta(divergence.studyFrom)} → {formatDelta(divergence.studyTo)}</small></span>
            <time>{formatClock(divergence.toTime)}</time>
          </div>;
        })}</div>
        : <div className="liq-empty">No swing contradiction meets the configured price and CVD thresholds.</div>}
    <div className="liq-cvd-foot">{status === 'paused' ? 'FEED PAUSED · ALERT FRESHNESS FROZEN' : `${candles.length} BARS · CVD DERIVED FROM BINANCE AGGRESSOR VOLUME`}</div>
  </div>;
}

export default function LiquidationAnalytics({
  symbol,
  contractType,
  candles,
  binanceLiquidations,
  binanceStatus,
  binanceLastMessageAt,
  binanceLatencyMs,
  price,
  enabled,
}: {
  symbol: string;
  contractType: ContractType;
  candles: Candle[];
  binanceLiquidations: Liquidation[];
  binanceStatus: MarketStatus;
  binanceLastMessageAt: number | null;
  binanceLatencyMs: number | null;
  price: number | null;
  enabled: boolean;
}) {
  const [minimumNotional, setMinimumNotional] = useState(100_000);
  const [minimumPriceSwingPct, setMinimumPriceSwingPct] = useState(0.1);
  const [minimumCvdSharePct, setMinimumCvdSharePct] = useState(5);
  const [windowMinutes, setWindowMinutes] = useState(30);
  const [now, setNow] = useState(() => Date.now());
  const { events, feeds } = useLiquidationFeeds({
    symbol,
    contractType,
    binanceLiquidations,
    binanceStatus,
    binanceLastMessageAt,
    binanceLatencyMs,
    enabled,
  });
  const divergences = useMemo(() => detectCvdSwingDivergences(candles, {
    minimumPriceSwingPct,
    minimumCvdShare: minimumCvdSharePct / 100,
  }), [candles, minimumCvdSharePct, minimumPriceSwingPct]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return <section className="liquidation-analytics" id="liquidation-analytics" data-testid="module-liquidation-analytics">
    <header className="liq-module-head">
      <div className="liq-module-title"><div className="liq-title-icon"><Crosshair size={15} /></div><div><span>LIQUIDATION HEATMAP / DELTA DIVERGENCE</span><small>{symbol} · {contractType.toUpperCase()} · PUBLIC PERPETUAL FEEDS</small></div></div>
      <div className="liq-module-live"><i /> {enabled ? 'MONITORING' : 'STANDBY'}</div>
      <ExchangeLatency feeds={feeds} />
    </header>
    <ThresholdControls
      minimumNotional={minimumNotional}
      setMinimumNotional={setMinimumNotional}
      minimumPriceSwingPct={minimumPriceSwingPct}
      setMinimumPriceSwingPct={setMinimumPriceSwingPct}
      minimumCvdSharePct={minimumCvdSharePct}
      setMinimumCvdSharePct={setMinimumCvdSharePct}
    />
    <div className="liq-module-content">
      <section className="liq-heat-section" aria-label={`${symbol} liquidation heatmap`}>
        <div className="liq-section-heading"><div><Activity size={13} /><span>LIVE EXCHANGE LIQUIDATIONS</span></div><div className="liq-window-control" role="group" aria-label="Heatmap time window">{windows.map((minutes) => <button key={minutes} className={windowMinutes === minutes ? 'active' : ''} onClick={() => setWindowMinutes(minutes)}>{minutes}M</button>)}</div></div>
        <LiquidationGrid events={events} currentPrice={price} now={now} windowMinutes={windowMinutes} minimumNotional={minimumNotional} />
      </section>
      <section className="liq-delta-section" aria-label={`${symbol} cumulative delta divergence alerts`}>
        <DeltaDivergencePanel candles={candles} divergences={divergences} status={binanceStatus} now={now} />
      </section>
    </div>
    <footer className="liq-module-foot">Binance force orders · Bybit liquidation stream · OKX swap liquidation channel. Public feeds can be incomplete or delayed; displayed signals are analysis proxies, not execution instructions.</footer>
  </section>;
}
