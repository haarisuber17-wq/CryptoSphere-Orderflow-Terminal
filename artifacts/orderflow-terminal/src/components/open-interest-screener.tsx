import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownUp, Search } from 'lucide-react';
import type { ContractType, OpenInterestMarket, SymbolInfo } from '@/hooks/use-binance-market';
import { useOpenInterest } from '@/hooks/use-binance-market';

type OpenInterestFilter = 'ALL' | 'RISING' | 'FALLING';
type OpenInterestSort = 'value' | 'change' | 'symbol';

const filters: OpenInterestFilter[] = ['ALL', 'RISING', 'FALLING'];

function compact(value: number) {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toLocaleString('en-US', { maximumSignificantDigits: 5 });
}

function OpenInterestRow({ market, rank, contractType, selected, onSelect }: { market: OpenInterestMarket; rank: number; contractType: ContractType; selected: boolean; onSelect: (symbol: string) => void }) {
  const change = market.change5m;
  const ageMs = Date.now() - market.updatedAt;
  const unit = contractType === 'usdt-m' ? market.baseAsset : 'CONTRACTS';
  return <button className={`open-interest-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(market.symbol)} data-testid={`open-interest-${market.symbol}`} title={`${market.symbol} · Binance open-interest snapshot ${Math.max(0, Math.round(ageMs / 1000))} seconds ago`}>
    <span className="open-interest-rank">{String(rank).padStart(3, '0')}</span>
    <span className="open-interest-pair"><strong>{market.baseAsset}</strong><small>/{market.quoteAsset}</small><em>{market.symbol}</em></span>
    <span className="open-interest-value">{compact(market.openInterest)} <small>{unit}</small></span>
    <span className="open-interest-notional">{market.openInterestValue == null ? '—' : `$${compact(market.openInterestValue)}`}</span>
    <span className={`open-interest-change ${change == null ? 'unavailable' : change >= 0 ? 'up' : 'down'}`}>{change == null ? 'WARMING' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</span>
    <time className={ageMs > 180_000 ? 'stale' : ''}>{new Date(market.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
  </button>;
}

export default function OpenInterestScreener({ symbols, contractType, selected, onSelect }: { symbols: SymbolInfo[]; contractType: ContractType; selected: string; onSelect: (symbol: string) => void }) {
  const { markets, feed } = useOpenInterest(symbols, contractType);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<OpenInterestFilter>('ALL');
  const [sort, setSort] = useState<OpenInterestSort>('value');
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const ranked = useMemo(() => {
    const term = query.trim().toUpperCase();
    return markets.filter((market) => {
      const matchesSearch = !term || market.symbol.includes(term) || market.baseAsset.includes(term);
      const matchesFilter = filter === 'ALL' || (filter === 'RISING' ? (market.change5m ?? 0) > 0 : (market.change5m ?? 0) < 0);
      return matchesSearch && matchesFilter;
    }).sort((a, b) => {
      if (sort === 'change') return (b.change5m ?? -Infinity) - (a.change5m ?? -Infinity);
      if (sort === 'symbol') return a.symbol.localeCompare(b.symbol);
      return (b.openInterestValue ?? -Infinity) - (a.openInterestValue ?? -Infinity);
    });
  }, [filter, markets, query, sort]);
  const rowHeight = 31;
  const viewportHeight = 340;
  const overscan = 8;
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const lastVisible = Math.min(ranked.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  const visibleMarkets = ranked.slice(firstVisible, lastVisible);
  const stale = feed.updatedAt != null && Date.now() - feed.updatedAt > 180_000;
  const sortLabel = sort === 'value' ? 'OI VALUE' : sort === 'change' ? '5M CHANGE' : 'PAIR';

  useEffect(() => {
    listRef.current?.scrollTo(0, 0);
    setScrollTop(0);
  }, [filter, query, sort]);

  return <section className="open-interest" aria-label="All perpetual markets open interest">
    <div className="open-interest-head">
      <div className="open-interest-heading"><Activity size={14} /><span>PERPETUAL OPEN INTEREST</span><small>{symbols.length} MARKETS</small></div>
      <span className={`open-interest-feed ${stale ? 'stale' : feed.phase}`} title={feed.message} aria-live="polite"><i />{feed.phase === 'scanning' ? `${feed.scanned}/${feed.total}` : stale ? 'STALE' : feed.phase.toUpperCase()}</span>
      <label className="open-interest-search"><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a pair" aria-label="Search Open Interest markets" /></label>
      <button className="open-interest-sort" onClick={() => setSort((current) => current === 'value' ? 'change' : current === 'change' ? 'symbol' : 'value')} title="Cycle sort: open-interest value, 5-minute change, pair">
        <ArrowDownUp size={12} />{sortLabel}
      </button>
    </div>
    <div className="open-interest-toolbar">
      <div className="open-interest-filters" role="group" aria-label="Filter open-interest change">{filters.map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
      <span className="open-interest-explainer">{feed.message}</span>
    </div>
    <div className="open-interest-table">
      <div className="open-interest-columns"><span>#</span><span>PERPETUAL PAIR</span><span>OPEN INTEREST</span><span>OI VALUE · USD</span><span>5M ΔOI</span><span>UPDATED</span></div>
      <div className="open-interest-list" ref={listRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        {firstVisible > 0 && <div className="open-interest-spacer" aria-hidden="true" style={{ height: firstVisible * rowHeight }} />}
        {visibleMarkets.map((market, index) => <OpenInterestRow key={market.symbol} market={market} rank={firstVisible + index + 1} contractType={contractType} selected={selected === market.symbol} onSelect={onSelect} />)}
        {lastVisible < ranked.length && <div className="open-interest-spacer" aria-hidden="true" style={{ height: (ranked.length - lastVisible) * rowHeight }} />}
        {!ranked.length && <div className="open-interest-empty">{markets.length ? 'No markets match this filter.' : symbols.length ? 'Collecting the first Binance open-interest snapshot…' : 'Loading Binance perpetual markets…'}</div>}
      </div>
    </div>
    <div className="open-interest-footer">
      <span>{feed.updatedAt == null ? 'Awaiting first full scan' : `Last full scan ${new Date(feed.updatedAt).toLocaleTimeString()}`} · values use Binance public market data</span>
      <span>5-minute Δ warms up from local snapshots · USDT-M uses mark price; COIN-M uses contract face value</span>
    </div>
  </section>;
}
