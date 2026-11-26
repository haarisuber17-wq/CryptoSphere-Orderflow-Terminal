import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowDownUp, ArrowUp, Search } from 'lucide-react';
import type { ContractType, SymbolInfo } from '@/hooks/use-binance-market';
import { useMoveRadar, type MoveRadarMarket, type MoveRadarPhase } from '@/hooks/use-move-radar';

type RadarFilter = 'ALL' | 'SETUP' | 'BUILDING' | 'EXPANSION';
type RadarSort = 'score' | 'volume' | 'change';

const phaseFilters: RadarFilter[] = ['ALL', 'SETUP', 'BUILDING', 'EXPANSION'];
const phaseOrder: Record<MoveRadarPhase, number> = { EXPANSION: 0, BUILDING: 1, SETUP: 2, QUIET: 3, WARMING: 4 };
const compactValue = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : value.toFixed(0);

function phaseLabel(phase: MoveRadarPhase) {
  return phase === 'EXPANSION' ? 'EXPANDING' : phase;
}

function MoveRadarRow({ market, rank, selected, onSelect }: { market: MoveRadarMarket; rank: number; selected: boolean; onSelect: (symbol: string) => void }) {
  const directionIcon = market.direction === 'UP' ? <ArrowUp size={12} /> : market.direction === 'DOWN' ? <ArrowDown size={12} /> : null;
  const directionTone = market.direction === 'UP' ? 'up' : market.direction === 'DOWN' ? 'down' : 'mixed';
  return <button className={`move-radar-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(market.symbol)} data-testid={`move-radar-${market.symbol}`} title={`Select ${market.symbol} · current Binance public ticker data`}>
    <span className="move-radar-rank">{String(rank).padStart(3, '0')}</span>
    <span className="move-radar-pair"><strong>{market.baseAsset}</strong><small>/{market.quoteAsset}</small><em>{compactValue(market.quoteVolume)} 24h</em></span>
    <span className={`move-radar-state ${market.phase.toLowerCase()}`}><i />{phaseLabel(market.phase)}</span>
    <span className={`move-radar-direction ${directionTone}`}>{directionIcon}{market.direction}</span>
    <span className={`move-radar-metric ${market.move1m == null ? 'unavailable' : market.move1m >= 0 ? 'up' : 'down'}`}>{market.move1m == null ? '—' : `${market.move1m >= 0 ? '+' : ''}${market.move1m.toFixed(2)}%`}</span>
    <span className="move-radar-metric">{market.rangeCompression == null ? '—' : `${market.rangeCompression.toFixed(2)}×`}</span>
    <span className="move-radar-metric">{market.volumeBurst == null ? '—' : `${market.volumeBurst.toFixed(1)}×`}</span>
    <span className={`move-radar-score ${market.score >= 55 ? 'elevated' : market.score >= 30 ? 'watch' : ''}`}><i style={{ width: `${market.score}%` }} /><strong>{market.phase === 'WARMING' ? '—' : market.score}</strong></span>
  </button>;
}

export default function MoveRadar({ symbols, contractType, selected, onSelect }: { symbols: SymbolInfo[]; contractType: ContractType; selected: string; onSelect: (symbol: string) => void }) {
  const { markets, radarState } = useMoveRadar(symbols, contractType);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RadarFilter>('ALL');
  const [sort, setSort] = useState<RadarSort>('score');
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const term = query.trim().toUpperCase();
    return markets.filter((market) => {
      const matchesSearch = !term || market.symbol.includes(term) || market.baseAsset.includes(term);
      const matchesPhase = filter === 'ALL' || market.phase === filter;
      return matchesSearch && matchesPhase;
    }).sort((a, b) => {
      if (sort === 'volume') return b.quoteVolume - a.quoteVolume;
      if (sort === 'change') return Math.abs(b.change24h) - Math.abs(a.change24h);
      return phaseOrder[a.phase] - phaseOrder[b.phase] || b.score - a.score || b.quoteVolume - a.quoteVolume;
    });
  }, [filter, markets, query, sort]);
  const rowHeight = 30;
  const viewportHeight = 340;
  const overscan = 8;
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const lastVisible = Math.min(filtered.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  const visibleMarkets = filtered.slice(firstVisible, lastVisible);
  useEffect(() => {
    listRef.current?.scrollTo(0, 0);
    setScrollTop(0);
  }, [filter, query, sort]);
  const stale = radarState.phase === 'live' && radarState.updatedAt != null && Date.now() - radarState.updatedAt > 25_000;
  const statusLabel = stale ? 'STALE' : radarState.phase === 'live' ? 'LIVE' : radarState.phase.toUpperCase();

  return <section className="move-radar" aria-label="All perpetual market move radar">
    <div className="move-radar-head">
      <div className="move-radar-heading"><Activity size={14} /><span>PERPETUAL MOVE RADAR</span><small>{symbols.length} MARKETS</small></div>
      <span className={`move-radar-feed ${stale ? 'stale' : radarState.phase}`} title={radarState.message}><i />{statusLabel}</span>
      <label className="move-radar-search"><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a pair" aria-label="Search Move Radar markets" /></label>
      <button className="move-radar-sort" onClick={() => setSort((current) => current === 'score' ? 'volume' : current === 'volume' ? 'change' : 'score')} title="Cycle sort: radar score, quote volume, 24-hour move">
        <ArrowDownUp size={12} />{sort === 'score' ? 'RADAR' : sort === 'volume' ? 'VOLUME' : '24H MOVE'}
      </button>
    </div>
    <div className="move-radar-toolbar">
      <div className="move-radar-filters" role="group" aria-label="Filter move radar phase">{phaseFilters.map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
      <span className="move-radar-explainer">Live price / volume / trade-count · 5-minute rolling baseline</span>
    </div>
    <div className="move-radar-table">
      <div className="move-radar-columns"><span>#</span><span>CONTRACT · 24H QUOTE VOL</span><span>RADAR STATE</span><span>DIRECTION</span><span>1M MOVE</span><span>RANGE / BASE</span><span>VOL / BASE</span><span>SCORE</span></div>
      <div className="move-radar-list" ref={listRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        {firstVisible > 0 && <div className="move-radar-spacer" aria-hidden="true" style={{ height: firstVisible * rowHeight }} />}
        {visibleMarkets.map((market, index) => <MoveRadarRow key={market.symbol} market={market} rank={firstVisible + index + 1} selected={selected === market.symbol} onSelect={onSelect} />)}
        {lastVisible < filtered.length && <div className="move-radar-spacer" aria-hidden="true" style={{ height: (filtered.length - lastVisible) * rowHeight }} />}
        {!filtered.length && <div className="move-radar-empty">{symbols.length ? 'No markets match this filter.' : 'Loading Binance perpetual markets…'}</div>}
      </div>
    </div>
    <div className="move-radar-footer">
      <span>{radarState.message} · updated {radarState.updatedAt == null ? '—' : new Date(radarState.updatedAt).toLocaleTimeString()}</span>
      <span>Warm-up ~5 min / coin. Estimates flag volatility conditions, not guaranteed direction or prediction.</span>
    </div>
  </section>;
}
