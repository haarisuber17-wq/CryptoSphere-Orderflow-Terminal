import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bell, BellOff, Radio, Volume2 } from 'lucide-react';
import AbsorptionWall from '@/components/absorption-wall';
import type { Candle, DepthLevel, LevelExecution, Trade } from '@/hooks/use-binance-market';
import { analyzeAbsorption, type AbsorptionDirection, type AbsorptionZone } from '@/utils/orderflow';

type AbsorptionVisualizerProps = {
  candles: Candle[];
  trades: Trade[];
  depth: DepthLevel[];
  levelExecutions: LevelExecution[];
  price: number | null;
};

const compactFlow = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (absolute >= 1e9) return `${sign}${(absolute / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${sign}${(absolute / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${sign}${(absolute / 1e3).toFixed(2)}K`;
  return `${sign}${absolute.toFixed(2)}`;
};

const priceFlow = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: value > 1000 ? 2 : 4, maximumFractionDigits: value > 1000 ? 2 : 4 });
const durationFlow = (durationMs: number) => durationMs >= 3_600_000 ? `${(durationMs / 3_600_000).toFixed(1)}h` : durationMs >= 60_000 ? `${Math.round(durationMs / 60_000)}m` : `${Math.max(1, Math.round(durationMs / 1_000))}s`;
const directionTitle = (direction: AbsorptionDirection) => direction === 'buyer-trap' ? 'BUYER ATTACK' : 'SELLER ATTACK';

function ZoneLedger({ zone, direction }: { zone: AbsorptionZone | undefined; direction: AbsorptionDirection }) {
  const buyerTrap = direction === 'buyer-trap';
  return <div className={`absorption-side ${buyerTrap ? 'buyer' : 'seller'}`} data-testid={`absorption-ledger-${direction}`}>
    <div className="absorption-side-head"><i /><span>{buyerTrap ? 'BUYER TRAP' : 'SELLER TRAP'}</span><small>{buyerTrap ? 'RESISTANCE' : 'SUPPORT'}</small></div>
    {zone ? <><div className="absorption-side-title">{buyerTrap ? 'AGGRESSIVE BUYERS MET' : 'AGGRESSIVE SELLERS MET'} <b>{priceFlow(zone.price)}</b></div><div className="absorption-side-grid">
      <div className="absorption-side-stat"><span>{buyerTrap ? 'BUYER ATTACK' : 'SELLER ATTACK'}</span><strong className="attack-value">{compactFlow(zone.attackVolume)} qty</strong></div>
      <div className="absorption-side-stat"><span>{buyerTrap ? 'SELLER ABS. ESTIMATE' : 'BUYER ABS. ESTIMATE'}</span><strong className="absorption-value">{compactFlow(zone.absorbedVolume)} qty</strong></div>
       <div className="absorption-side-stat"><span>NOTIONAL {zone.notionalSource === 'aggTrade' ? 'AGGTRADE' : 'DERIVED'}</span><strong>{compactFlow(zone.attackNotional)} USDT</strong></div>
       <div className="absorption-side-stat"><span>ABSORBED VALUE EST.</span><strong className="absorption-value">{compactFlow(zone.absorbedNotional)} USDT</strong></div>
      <div className="absorption-side-stat"><span>VISIBLE PASSIVE DEPTH</span><strong>{zone.visibleDepthLevels ? `${compactFlow(zone.visibleDepthQty)} qty` : '—'}</strong></div>
      <div className="absorption-side-stat"><span>IMBALANCE RATIO</span><strong>{zone.deltaImbalanceRatio.toFixed(2)}×</strong></div>
    </div></> : <div className="absorption-ledger-empty">No qualifying {buyerTrap ? 'positive' : 'negative'} attack in the current rolling window.</div>}
  </div>;
}

function EmptyZone() {
  return <div className="absorption-empty absorption-demo" data-testid="absorption-empty-state">
    <header className="absorption-demo-header">
      <span className="absorption-demo-kicker"><i /> NO ACTIVE LIVE ZONE</span>
      <div><h3>How absorption works</h3><span>3D illustration · not a current market signal</span></div>
    </header>
    <div className="absorption-demo-scene" role="img" aria-label="Illustration: aggressive buy orders travel toward a passive sell wall, are absorbed, and price stalls. This is not a live signal.">
      <div className="absorption-demo-floor" />
      <div className="absorption-demo-price"><span>PRICE RESPONSE</span><i /><strong>STALLS</strong></div>
      <div className="absorption-demo-flow-copy"><span>AGGRESSIVE BUY ORDERS</span><small>incoming market flow</small></div>
      <div className="absorption-demo-stream" aria-hidden="true">
        <i className="absorption-demo-packet packet-one" />
        <i className="absorption-demo-packet packet-two" />
        <i className="absorption-demo-packet packet-three" />
        <i className="absorption-demo-packet packet-four" />
      </div>
      <div className="absorption-demo-wall"><span>PASSIVE SELL WALL</span><strong>LIQUIDITY HELD</strong><small>buy volume absorbed</small></div>
      <div className="absorption-demo-impact" aria-hidden="true" />
    </div>
    <div className="absorption-demo-steps">
      <span><b>01</b> Buyers attack</span>
      <span><b>02</b> Sell liquidity absorbs flow</span>
      <span><b>03</b> Price stalls · possible buyer trap</span>
    </div>
    <p className="absorption-demo-note">Example only: the reverse is sellers meeting passive buy liquidity. The live detector uses public candle and aggTrade data; it cannot confirm hidden or filled orders.</p>
  </div>;
}

export default function AbsorptionVisualizer({ candles, trades, depth, levelExecutions, price }: AbsorptionVisualizerProps) {
  const analysis = useMemo(() => analyzeAbsorption(candles, trades, depth), [candles, depth, trades]);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastAlertRef = useRef<string | null>(null);

  const playPing = () => {
    const context = audioContextRef.current;
    if (!context) return;
    try {
      if (context.state === 'suspended') void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(760, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(520, context.currentTime + .12);
      gain.gain.setValueAtTime(.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.045, context.currentTime + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + .18);
    } catch {
      // Audio is an enhancement; silent browsers keep the visual alert.
    }
  };

  const primeAudio = () => {
    if (typeof window === 'undefined' || !window.AudioContext) return;
    try {
      audioContextRef.current ??= new window.AudioContext();
      setAudioReady(true);
      playPing();
    } catch {
      setAudioReady(false);
    }
  };

  useEffect(() => {
    const zoneId = analysis.strongest?.id ?? null;
    if (alertsEnabled && zoneId && lastAlertRef.current && lastAlertRef.current !== zoneId) playPing();
    lastAlertRef.current = zoneId;
  }, [alertsEnabled, analysis.strongest?.id]);

  const buyerZone = analysis.zones.find((zone) => zone.direction === 'buyer-trap');
  const sellerZone = analysis.zones.find((zone) => zone.direction === 'seller-trap');
  const strongest = analysis.strongest;
  const liveWall = useMemo(() => {
    if (!strongest) return null;
    const side: DepthLevel['side'] = strongest.direction === 'buyer-trap' ? 'ask' : 'bid';
    const nearest = depth
      .filter((level) => level.side === side && level.qty > 0)
      .reduce<DepthLevel | null>((best, level) => !best || Math.abs(level.price - strongest.price) < Math.abs(best.price - strongest.price) ? level : best, null);
    if (!nearest || Math.abs(nearest.price - strongest.price) > strongest.price * 0.0007) return null;
    const aggressorSide: Trade['side'] = side === 'ask' ? 'buy' : 'sell';
    const currentCandle = candles[candles.length - 1];
    const execution = levelExecutions.find((item) => item.price === nearest.price && item.side === aggressorSide && item.candleTime === currentCandle?.time);
    return {
      side,
      price: nearest.price,
      qty: nearest.qty,
      notional: nearest.price * nearest.qty,
      touched: Boolean(currentCandle && currentCandle.low <= nearest.price && currentCandle.high >= nearest.price),
      executedQty: execution?.qty ?? 0,
      executedNotional: execution?.notional ?? 0,
    };
  }, [candles, depth, levelExecutions, strongest]);

  return <section id="absorption-visualizer" className="panel absorption-panel" data-testid="absorption-visualizer">
    <div className="panel-head">
      <div className="panel-title"><Radio size={12} /> ORDER FLOW ABSORPTION / DIVERGENCE</div>
      <div className="absorption-head-actions">
        <span className="absorption-live"><i /> ROLLING CVD PROXY</span>
        <button className={`absorption-alert-toggle${alertsEnabled ? ' enabled' : ''}`} onClick={() => { if (!alertsEnabled) primeAudio(); setAlertsEnabled((enabled) => !enabled); }} aria-pressed={alertsEnabled} aria-label={alertsEnabled ? 'Disable absorption alerts' : 'Enable absorption alerts'} data-testid="button-absorption-alerts">{alertsEnabled ? <Bell size={12} /> : <BellOff size={12} />}{alertsEnabled ? 'ALERTS ON' : 'ALERTS OFF'}</button>
      </div>
    </div>
    <div className="absorption-summary"><Activity size={12} /><span>AGGRESSIVE DELTA VS PRICE RESPONSE</span><strong>{strongest ? strongest.label : 'NO ACTIVE ZONE'}</strong><span className="summary-cvd">12-BAR CVD <b className={analysis.rollingCvd >= 0 ? 'green' : 'red'}>{compactFlow(analysis.rollingCvd)} qty</b></span></div>
     {strongest ? <div className="absorption-body">
       <AbsorptionWall zone={strongest} price={price} depthAvailable={depth.length > 0} liveWall={liveWall} />
      <div className="absorption-ledger"><ZoneLedger zone={buyerZone} direction="buyer-trap" /><ZoneLedger zone={sellerZone} direction="seller-trap" /></div>
      <div className="absorption-history"><div className="absorption-history-head"><span>DETECTED ZONES / LAST 8</span><span>proxy probability · not confirmation</span></div><div className="absorption-history-list">{analysis.zones.map((zone) => <div className={`absorption-zone-row ${zone.direction}`} key={zone.id} data-testid={`absorption-zone-${zone.id}`}><i /><div><strong>{directionTitle(zone.direction)} · {priceFlow(zone.price)}</strong><small>{compactFlow(zone.absorbedVolume)} estimated absorbed · {durationFlow(zone.durationMs)} · {zone.deltaImbalanceRatio.toFixed(2)}×</small></div><span>{zone.probability}%</span></div>)}</div></div>
    </div> : <EmptyZone />}
    <div className="absorption-footnote"><Volume2 size={11} /> <b>Analytics proxy:</b> attack uses public candle buy/sell quantities; notional uses live aggTrade values when present, otherwise candle quantity × close. Visible passive depth is current public book liquidity, not proof of filled orders. Absorption estimates the stalled-response share and cannot see private resting fills.{audioReady && alertsEnabled ? ' Audio cue armed after this interaction.' : ''}</div>
  </section>;
}