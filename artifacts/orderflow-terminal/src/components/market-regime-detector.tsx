import { AlertTriangle, Ban, Check, ChevronDown, Clock3, ShieldAlert, Waves } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Candle, DepthLevel, Liquidation, MarketPulse, MarketStatus, Trade } from '@/hooks/use-binance-market';

type RegimeKind =
  | 'trend-up'
  | 'trend-down'
  | 'range-chop'
  | 'volatility-expansion'
  | 'volatility-compression'
  | 'liquidation-cascade'
  | 'low-liquidity'
  | 'data-unreliable';

type RegimeResult = {
  kind: RegimeKind;
  label: string;
  confidence: number | null;
  regimeChangedAt: number | null;
  reason: string;
  allowed: string[];
  blocked: string[];
  stats: Array<{ label: string; value: string }>;
};

const fmtCompact = (value: number) => {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
};

const fmtTime = (time: number | null) => time == null
  ? '—'
  : new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const fmtFunding = (rate: number | null) => rate == null
  ? '—'
  : `${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(4)}%`;

const directionKind = (candles: Candle[]): RegimeKind => {
  const recent = candles.slice(-36);
  if (recent.length < 12) return 'range-chop';
  const ranges = recent.map((candle) => Math.max(candle.high - candle.low, candle.close * 0.00001));
  const netMove = recent[recent.length - 1].close - recent[0].open;
  const travel = ranges.reduce((sum, range) => sum + range, 0);
  const efficiency = Math.abs(netMove) / Math.max(travel, Number.EPSILON);
  const averageRange = ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
  return efficiency >= 0.34 && Math.abs(netMove) >= averageRange * 1.8
    ? netMove > 0 ? 'trend-up' : 'trend-down'
    : 'range-chop';
};

function classify(
  candles: Candle[],
  bids: DepthLevel[],
  asks: DepthLevel[],
  trades: Trade[],
  liquidations: Liquidation[],
  status: MarketStatus,
  price: number | null,
  lastMessageAt: number | null,
  pulse: MarketPulse,
): RegimeResult {
  const age = lastMessageAt == null ? Infinity : Date.now() - lastMessageAt;
  if (status === 'error' || status === 'disconnected') {
    return {
      kind: 'data-unreliable',
      label: 'DATA UNAVAILABLE',
      confidence: null,
      regimeChangedAt: null,
      reason: 'DATA UNAVAILABLE: Binance public streams are not connected. No setup is cleared while live inputs are stale.',
      allowed: [],
      blocked: ['All directional setups', 'Liquidity / execution reads'],
      stats: [{ label: 'PUBLIC STREAM', value: status.toUpperCase() }, { label: 'LAST MESSAGE', value: fmtTime(lastMessageAt) }],
    };
  }
  if (status === 'paused' || age > 20_000) {
    return {
      kind: 'data-unreliable',
      label: 'DATA UNRELIABLE',
      confidence: null,
      regimeChangedAt: null,
      reason: 'DATA UNRELIABLE: the public stream is paused or stale. Resume or reconnect before interpreting a regime.',
      allowed: [],
      blocked: ['All directional setups', 'Liquidity / execution reads'],
      stats: [{ label: 'STREAM AGE', value: age === Infinity ? '—' : `${Math.round(age / 1000)}s` }, { label: 'LAST MESSAGE', value: fmtTime(lastMessageAt) }],
    };
  }
  if (candles.length < 12 || price == null || bids.length < 3 || asks.length < 3 || trades.length < 3) {
    return {
      kind: 'data-unreliable',
      label: 'INSUFFICIENT LIVE DATA',
      confidence: null,
      regimeChangedAt: null,
      reason: 'INSUFFICIENT LIVE DATA: waiting for 12+ candles, both sides of visible depth, and recent aggregate trades before classifying structure.',
      allowed: [],
      blocked: ['All setups until inputs are present'],
      stats: [
        { label: 'CANDLES', value: `${candles.length} / 12` },
        { label: 'BID / ASK LEVELS', value: `${bids.length} / ${asks.length}` },
        { label: 'RECENT TRADES', value: `${trades.length} / 3` },
      ],
    };
  }

  const recent = candles.slice(-36);
  const prior = candles.slice(-36, -8);
  const ranges = recent.map((candle) => Math.max(candle.high - candle.low, candle.close * 0.00001));
  const averageRange = ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
  const recentRange = ranges.slice(-8).reduce((sum, range) => sum + range, 0) / 8;
  const priorRange = prior.length
    ? prior.reduce((sum, candle) => sum + Math.max(candle.high - candle.low, candle.close * 0.00001), 0) / prior.length
    : averageRange;
  const rangeRatio = recentRange / Math.max(priorRange, Number.EPSILON);
  const netMove = recent[recent.length - 1].close - recent[0].open;
  const travel = ranges.reduce((sum, range) => sum + range, 0);
  const trendEfficiency = Math.abs(netMove) / Math.max(travel, Number.EPSILON);
  const totalVolume = recent.reduce((sum, candle) => sum + Math.max(candle.volume, 0), 0);
  const pressure = recent.reduce((sum, candle) => sum + candle.delta, 0) / Math.max(totalVolume, Number.EPSILON);
  const bestBid = bids[0]?.price ?? price;
  const bestAsk = asks[0]?.price ?? price;
  const spreadBps = Math.max(0, bestAsk - bestBid) / Math.max(price, Number.EPSILON) * 10_000;
  const depthQty = [...bids.slice(0, 15), ...asks.slice(0, 15)].reduce((sum, level) => sum + level.qty, 0);
  const depthToBar = depthQty / Math.max(totalVolume / recent.length, Number.EPSILON);
  const liquidationNotional = liquidations
    .filter((order) => order.time >= Date.now() - 5 * 60_000)
    .reduce((sum, order) => sum + order.notional, 0);
  const recentTradeNotional = trades.reduce((sum, trade) => sum + trade.notional, 0);
  const liquidationShare = liquidationNotional / Math.max(recentTradeNotional, Number.EPSILON);
  const changePct = recent[0]?.open ? (netMove / recent[0].open) * 100 : 0;
  const qualityPenalty = Math.min(20, spreadBps * 1.2) + (depthToBar < 0.05 ? 10 : 0);
  const signalScore = 50 + trendEfficiency * 90 + Math.min(Math.abs(rangeRatio - 1) * 16, 12) - qualityPenalty;
  const confidence = Math.round(Math.max(35, Math.min(92, signalScore)));
  const stats = [
    { label: '36-BAR MOVE', value: `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%` },
    { label: 'PRESSURE SHARE', value: `${pressure >= 0 ? '+' : ''}${(pressure * 100).toFixed(1)}%` },
    { label: 'RANGE RATIO', value: `${rangeRatio.toFixed(2)}×` },
    { label: 'SPREAD', value: `${spreadBps.toFixed(2)} bps` },
    { label: 'DEPTH / AVG BAR', value: `${depthToBar.toFixed(2)}×` },
    { label: 'LIQUIDATIONS / 5M', value: `${liquidations.filter((order) => order.time >= Date.now() - 5 * 60_000).length} · ${fmtCompact(liquidationNotional)}` },
    { label: 'OPEN INTEREST', value: fmtCompact(pulse.openInterest ?? NaN) },
    { label: 'FUNDING', value: fmtFunding(pulse.fundingRate) },
  ];

  if (spreadBps >= 8 || depthToBar < 0.025) {
    return {
      kind: 'low-liquidity',
      label: 'LOW LIQUIDITY',
      confidence,
      regimeChangedAt: recent[recent.length - 1]?.time ?? null,
      reason: 'NO TRADE — ORDERBOOK TOO THIN: spread or visible depth quality is below the safety threshold.',
      allowed: ['Observe resting liquidity and wait for depth recovery'],
      blocked: ['All new directional entries', 'Breakout and mean-reversion setups'],
      stats,
    };
  }
  if (liquidations.length >= 3 && liquidationShare >= 0.18) {
    return {
      kind: 'liquidation-cascade',
      label: 'LIQUIDATION CASCADE',
      confidence: Math.min(confidence, 70),
      regimeChangedAt: liquidations[0]?.time ?? null,
      reason: 'NO TRADE — LIQUIDATION CASCADE: public force-order activity is elevated; wait for forced-flow exhaustion and structure repair.',
      allowed: ['Observe liquidation exhaustion', 'Monitor absorption without entry'],
      blocked: ['New directional entries', 'Counter-cascade fades', 'Breakout continuation'],
      stats,
    };
  }
  if (rangeRatio >= 1.45) {
    return {
      kind: 'volatility-expansion',
      label: 'VOLATILITY EXPANSION',
      confidence: Math.min(confidence, 72),
      regimeChangedAt: recent[recent.length - 8]?.time ?? null,
      reason: 'NO TRADE — VOLATILITY EXPANSION: recent candle ranges are elevated versus the prior loaded bars; wait for acceptance or compression.',
      allowed: ['Observe expansion, liquidation, and absorption behavior only'],
      blocked: ['New directional entries', 'Breakout continuation', 'Mean-reversion fades'],
      stats,
    };
  }
  if (rangeRatio <= 0.65) {
    return {
      kind: 'volatility-compression',
      label: 'VOLATILITY COMPRESSION',
      confidence: Math.min(confidence, 68),
      regimeChangedAt: recent[recent.length - 8]?.time ?? null,
      reason: 'NO TRADE — VOLATILITY COMPRESSION: realized range is contracted and directional edge is unconfirmed.',
      allowed: ['Map likely expansion levels', 'Observe liquidity positioning'],
      blocked: ['Mid-range entries', 'Breakout anticipation', 'Low-timeframe chasing'],
      stats,
    };
  }

  const structure = directionKind(candles);
  if (structure === 'trend-up' && pressure >= 0.06) {
    return {
      kind: structure,
      label: 'TRENDING UP',
      confidence,
      regimeChangedAt: recent[recent.length - 1]?.time ?? null,
      reason: 'Conditional read only: continuation requires a pullback that holds structure and renewed aggressive buy pressure.',
      allowed: ['Long pullback with confirmation', 'Upside continuation after acceptance'],
      blocked: ['Breakout without acceptance', 'Counter-trend chase', 'Shorts into rising structure'],
      stats,
    };
  }
  if (structure === 'trend-down' && pressure <= -0.06) {
    return {
      kind: structure,
      label: 'TRENDING DOWN',
      confidence,
      regimeChangedAt: recent[recent.length - 1]?.time ?? null,
      reason: 'Conditional read only: continuation requires a rally rejection and renewed aggressive sell pressure.',
      allowed: ['Short rally rejection with confirmation', 'Downside continuation after acceptance'],
      blocked: ['Breakout without acceptance', 'Counter-trend chase', 'Longs into falling structure'],
      stats,
    };
  }
  return {
    kind: 'range-chop',
    label: 'RANGE / CHOP',
    confidence,
    regimeChangedAt: recent[recent.length - 1]?.time ?? null,
    reason: 'NO TRADE — CHOP / LOW DIRECTIONAL EDGE: price travel and pressure are not aligned enough to clear the directional gate.',
    allowed: ['Map range edges and liquidity response'],
    blocked: ['Mid-range entries', 'Breakout without acceptance', 'Counter-trend chase'],
    stats,
  };
}

export default function MarketRegimeDetector({
  symbol,
  candles,
  bids,
  asks,
  trades,
  liquidations,
  status,
  price,
  lastMessageAt,
  pulse,
}: {
  symbol: string;
  candles: Candle[];
  bids: DepthLevel[];
  asks: DepthLevel[];
  trades: Trade[];
  liquidations: Liquidation[];
  status: MarketStatus;
  price: number | null;
  lastMessageAt: number | null;
  pulse: MarketPulse;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const result = useMemo(
    () => classify(candles, bids, asks, trades, liquidations, status, price, lastMessageAt, pulse),
    [asks, bids, candles, lastMessageAt, liquidations, price, pulse, status, trades],
  );
  const gateOpen = (result.kind === 'trend-up' || result.kind === 'trend-down')
    && result.confidence != null
    && result.confidence >= 58;
  const tone = result.kind === 'trend-up'
    ? 'up'
    : result.kind === 'trend-down'
      ? 'down'
      : result.kind === 'range-chop'
        ? 'range'
        : result.kind === 'volatility-compression'
          ? 'compression'
          : result.kind === 'liquidation-cascade'
            ? 'cascade'
            : result.kind === 'low-liquidity'
              ? 'thin'
              : 'blocked';
  const gateLabel = gateOpen ? 'CONDITIONAL — NO EXECUTION' : 'NO-TRADE';

  return <section className={`regime-detector ${tone}`} id="market-regime-detector" data-testid="panel-market-regime-detector">
    <div className="regime-head">
      <div className="regime-heading">
        <div className="regime-kicker"><Waves size={13} /> LIVE MARKET REGIME DETECTOR <span>PUBLIC DATA</span></div>
        <h2>{symbol} <small>structure and safety gate</small></h2>
      </div>
      <div className={`gate-badge ${gateOpen ? 'conditional' : 'blocked'}`} data-testid="status-no-trade-gate">
        {gateOpen ? <Check size={14} /> : <Ban size={14} />}
        <span><b>{gateLabel}</b><small>{gateOpen ? 'analysis may continue' : 'setup clearance withheld'}</small></span>
      </div>
    </div>
    <div className="regime-main">
      <div className="regime-state">
        <span className="regime-label">CURRENT REGIME</span>
        <strong data-testid="text-current-regime">{result.label}</strong>
        <p>{result.reason}</p>
      </div>
      <div className="regime-confidence">
        <div className="confidence-ring" style={{ '--confidence': `${result.confidence ?? 0}%` } as React.CSSProperties}><span>{result.confidence == null ? '—' : `${result.confidence}%`}</span></div>
        <span>CONFIDENCE</span>
        <small>{result.confidence == null ? 'not scored' : 'proxy score'}</small>
      </div>
      <div className="regime-change">
        <Clock3 size={14} />
        <div><span>REGIME CHANGE</span><strong>{fmtTime(result.regimeChangedAt)}</strong><small>{result.regimeChangedAt == null ? 'awaiting enough live bars' : 'derived from loaded public inputs'}</small></div>
      </div>
    </div>
    <div className="regime-stats">{result.stats.map((stat) => <div key={stat.label}><span>{stat.label}</span><strong>{stat.value}</strong></div>)}</div>
    <div className="regime-columns">
      <div className="setup-list allowed"><div className="setup-list-title"><Check size={13} /> ALLOWED WITH CONFIRMATION</div>{result.allowed.length ? result.allowed.map((item) => <div className="setup-item" key={item}><i />{item}</div>) : <div className="setup-item muted">None while live inputs are unavailable</div>}</div>
      <div className="setup-list blocked-list"><div className="setup-list-title"><ShieldAlert size={13} /> BLOCKED BY GATE</div>{result.blocked.map((item) => <div className="setup-item" key={item}><i />{item}</div>)}</div>
    </div>
    <div className="regime-limit-note"><b>PUBLIC DATA LIMITATION</b><span>Visible Binance depth, aggregate trades, klines, and force orders are partial public signals; hidden liquidity and private intent are unavailable.</span></div>
    <button className="regime-method-toggle" onClick={() => setDetailsOpen((value) => !value)} aria-expanded={detailsOpen} data-testid="button-regime-methodology"><AlertTriangle size={13} /><span>LIMITATION / METHOD</span><ChevronDown size={13} className={detailsOpen ? 'rotated' : ''} /></button>
    {detailsOpen && <div className="regime-method"><b>PUBLIC DATA LIMITATION</b><span>This detector uses Binance public klines, visible depth, aggregate trades, liquidations, and current funding/open-interest context. It cannot see private order intent, hidden liquidity, account risk, or institutional certainty.</span><span>Regime labels are contextual proxies, not forecasts. NO-TRADE means the available inputs do not clear the safety threshold; it never authorizes an order and never changes any existing strict alert evaluator.</span></div>}
  </section>;
}