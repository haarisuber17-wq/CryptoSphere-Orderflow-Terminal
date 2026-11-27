import { useCallback, useEffect, useRef, useState } from 'react';

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; delta: number; buyVolume: number; sellVolume: number; directionBias: number; largeBuyVolume: number; largeSellVolume: number };
export type DepthLevel = { price: number; qty: number; side: 'bid' | 'ask' };
export type Trade = { id: number; price: number; qty: number; notional: number; time: number; side: 'buy' | 'sell'; isLarge: boolean };
export type LevelExecution = { price: number; side: Trade['side']; qty: number; notional: number; tradeCount: number; candleTime: number };
export type Liquidation = { id: number; price: number; qty: number; notional: number; time: number; side: 'buy' | 'sell' };
export type MarketStatus = 'connecting' | 'connected' | 'disconnected' | 'paused' | 'error';
export type ContractType = 'usdt-m' | 'coin-m';
export type SymbolInfo = { symbol: string; baseAsset: string; quoteAsset: string; contractType: ContractType; volume: number; volumeSpike: number; change: number; lastPrice: number; contractSize?: number | null };
export type MarketPulse = { openInterest: number | null; fundingRate: number | null; markPrice: number | null; nextFundingTime: number | null; updatedAt: number | null };
export type OpenInterestMarket = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  openInterest: number;
  openInterestValue: number | null;
  change5m: number | null;
  updatedAt: number;
};
export type OpenInterestFeed = {
  phase: 'loading' | 'scanning' | 'live' | 'degraded' | 'error';
  message: string;
  updatedAt: number | null;
  scanned: number;
  total: number;
};
type OpenInterestRequestResult =
  | { item: SymbolInfo; ok: true; rateLimited: false; value: number }
  | { item: SymbolInfo; ok: false; rateLimited: boolean; error: string };

const ENDPOINTS: Record<ContractType, { rest: string; ws: string }> = {
  'usdt-m': { rest: 'https://fapi.binance.com', ws: 'wss://fstream.binance.com/stream?' },
  'coin-m': { rest: 'https://dapi.binance.com', ws: 'wss://dstream.binance.com/stream?' },
};

const num = (value: unknown) => Number(value);

export function useBinanceMarket(symbol: string, interval: string, paused: boolean, contractType: ContractType = 'usdt-m') {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [bids, setBids] = useState<DepthLevel[]>([]);
  const [asks, setAsks] = useState<DepthLevel[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [levelExecutions, setLevelExecutions] = useState<LevelExecution[]>([]);
  const [liquidations, setLiquidations] = useState<Liquidation[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [change, setChange] = useState<number | null>(null);
  const [quoteVolume, setQuoteVolume] = useState<number | null>(null);
  const [status, setStatus] = useState<MarketStatus>('connecting');
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const deltaRef = useRef<Map<number, { buy: number; sell: number; largeBuy: number; largeSell: number }>>(new Map());
  const recentNotionalRef = useRef<number[]>([]);
  const levelExecutionMapRef = useRef<Map<string, LevelExecution>>(new Map());
  const levelExecutionCandleRef = useRef<number | null>(null);

  const reconnect = useCallback(() => setReconnectKey((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const lower = symbol.toLowerCase();
    const binanceInterval = toBinanceInterval(interval);
    const endpoint = ENDPOINTS[contractType];
    const rest = endpoint.rest;
    type DepthUpdate = { U?: unknown; u?: unknown; pu?: unknown; b?: unknown; a?: unknown };
    const depthBook = {
      bids: new Map<number, number>(),
      asks: new Map<number, number>(),
    };
    const pendingDepthUpdates: DepthUpdate[] = [];
    let depthReady = false;
    let awaitingFirstDepthEvent = false;
    let lastDepthUpdateId = 0;
    let reconnectTimer: number | undefined;
    let depthResyncTimer: number | undefined;
    let reconnectAttempt = 0;
    let depthResyncAttempt = 0;
    let depthResyncInFlight = false;
    let serverClockOffsetMs: number | null = null;
    let lastFeedUiUpdateAt = 0;
    let clockSyncTimer: number | undefined;
    let tradeUiFlushTimer: number | undefined;
    let pendingTradeUpdates: Trade[] = [];
    const apiPrefix = contractType === 'usdt-m' ? 'fapi' : 'dapi';
    const depthUrl = `${rest}/${apiPrefix}/v1/depth?symbol=${symbol}&limit=50`;

    const syncServerClock = async () => {
      let bestSample: { offsetMs: number; roundTripMs: number } | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (cancelled) return;
        const requestStartedAt = Date.now();
        const monotonicStartedAt = performance.now();
        try {
          const response = await fetch(`${rest}/${apiPrefix}/v1/time`, { cache: 'no-store' });
          if (!response.ok) continue;
          const payload = await response.json() as { serverTime?: unknown };
          const serverTime = num(payload.serverTime);
          if (cancelled) return;
          if (!Number.isFinite(serverTime)) continue;
          const responseReceivedAt = Date.now();
          const roundTripMs = performance.now() - monotonicStartedAt;
          const offsetMs = serverTime - (requestStartedAt + responseReceivedAt) / 2;
          if (!bestSample || roundTripMs < bestSample.roundTripMs) bestSample = { offsetMs, roundTripMs };
        } catch {
          if (cancelled) return;
        }
        if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      if (bestSample && !cancelled) serverClockOffsetMs = bestSample.offsetMs;
    };

    const publishDepth = () => {
      setBids([...depthBook.bids.entries()]
        .filter(([, qty]) => qty > 0)
        .map(([levelPrice, qty]) => ({ price: levelPrice, qty, side: 'bid' as const }))
        .sort((a, b) => b.price - a.price)
        .slice(0, 50));
      setAsks([...depthBook.asks.entries()]
        .filter(([, qty]) => qty > 0)
        .map(([levelPrice, qty]) => ({ price: levelPrice, qty, side: 'ask' as const }))
        .sort((a, b) => a.price - b.price)
        .slice(0, 50));
    };

    const updateLevelExecutions = (trade: Trade) => {
      const totals = levelExecutionMapRef.current;
      const candleTime = levelExecutionCandleRef.current;
      if (candleTime == null) return;
      const key = `${trade.side}:${trade.price}`;
      const current = totals.get(key);
      totals.set(key, current
        ? { ...current, qty: current.qty + trade.qty, notional: current.notional + trade.notional, tradeCount: current.tradeCount + 1 }
        : { price: trade.price, side: trade.side, qty: trade.qty, notional: trade.notional, tradeCount: 1, candleTime });
    };

    const flushTradeUpdates = () => {
      tradeUiFlushTimer = undefined;
      const batch = pendingTradeUpdates;
      pendingTradeUpdates = [];
      if (!batch.length) return;

      setPrice(batch[batch.length - 1].price);
      setTrades((items) => [...batch.slice(-42).reverse(), ...items].slice(0, 42));
      setLevelExecutions([...levelExecutionMapRef.current.values()]);

      const candleInterval = intervalMs(interval);
      const changesByTime = new Map<number, { high: number; low: number; close: number; lastTradeTime: number }>();
      for (const trade of batch) {
        const time = Math.floor(trade.time / candleInterval) * candleInterval;
        const current = changesByTime.get(time);
        changesByTime.set(time, {
          high: Math.max(current?.high ?? trade.price, trade.price),
          low: Math.min(current?.low ?? trade.price, trade.price),
          close: trade.price,
          lastTradeTime: trade.time,
        });
      }

      setCandles((items) => {
        if (!items.length) return items;
        const latest = items[items.length - 1];
        const availableTimes = new Set(items.map((item) => item.time));
        const changes = new Map<number, { high: number; low: number; close: number }>();
        for (const [time, update] of changesByTime) {
          const targetTime = availableTimes.has(time)
            ? time
            : update.lastTradeTime >= latest.time && update.lastTradeTime < latest.time + candleInterval
              ? latest.time
              : null;
          if (targetTime == null) continue;
          const current = changes.get(targetTime);
          changes.set(targetTime, {
            high: Math.max(current?.high ?? update.high, update.high),
            low: Math.min(current?.low ?? update.low, update.low),
            close: update.close,
          });
        }
        if (!changes.size) return items;

        return items.map((candle) => {
          const update = changes.get(candle.time);
          if (!update) return candle;
          const flow = deltaRef.current.get(candle.time);
          if (!flow) return { ...candle, ...update };
          const delta = flow.buy - flow.sell;
          const total = flow.buy + flow.sell;
          return {
            ...candle,
            ...update,
            delta,
            buyVolume: flow.buy,
            sellVolume: flow.sell,
            directionBias: total ? delta / total : candle.directionBias,
            largeBuyVolume: flow.largeBuy,
            largeSellVolume: flow.largeSell,
          };
        });
      });
    };

    const scheduleReconnect = () => {
      if (cancelled || paused || reconnectTimer != null) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (!cancelled) setReconnectKey((value) => value + 1);
      }, delay);
    };

    const scheduleDepthResync = () => {
      if (cancelled || paused || depthResyncTimer != null) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(depthResyncAttempt, 5));
      depthResyncAttempt += 1;
      depthResyncTimer = window.setTimeout(() => {
        depthResyncTimer = undefined;
        void resyncDepth();
      }, delay);
    };

    const resyncDepth = async () => {
      if (cancelled || paused || depthResyncInFlight) return;
      depthResyncInFlight = true;
      let failed = false;
      try {
        const response = await fetch(depthUrl);
        if (!response.ok) throw new Error('Depth snapshot request failed');
        const depth = await response.json() as { bids: string[][]; asks: string[][]; lastUpdateId: number };
        if (cancelled) return;
        depthBook.bids.clear();
        depthBook.asks.clear();
        for (const [levelPrice, quantity] of depth.bids) depthBook.bids.set(num(levelPrice), num(quantity));
        for (const [levelPrice, quantity] of depth.asks) depthBook.asks.set(num(levelPrice), num(quantity));
        lastDepthUpdateId = num(depth.lastUpdateId);
        depthReady = Number.isFinite(lastDepthUpdateId);
        awaitingFirstDepthEvent = depthReady;
        depthResyncAttempt = 0;
        publishDepth();
      } catch {
        if (!cancelled) {
          depthReady = false;
          failed = true;
        }
      } finally {
        depthResyncInFlight = false;
      }
      if (cancelled) return;
      if (failed) {
        scheduleDepthResync();
        return;
      }
      const queued = pendingDepthUpdates.splice(0);
      queued.forEach((update) => applyDepthUpdate(update));
    };

    const applyDepthUpdate = (data: DepthUpdate) => {
      const firstUpdateId = num(data.U);
      const finalUpdateId = num(data.u);
      if (!Number.isFinite(firstUpdateId) || !Number.isFinite(finalUpdateId)) return;
      if (!depthReady) {
        pendingDepthUpdates.push(data);
        return;
      }
      if (finalUpdateId <= lastDepthUpdateId) return;
      const previousUpdateId = num(data.pu);
      if (awaitingFirstDepthEvent) {
        if (firstUpdateId > lastDepthUpdateId + 1) {
          depthReady = false;
          pendingDepthUpdates.push(data);
          void resyncDepth();
          return;
        }
        if (finalUpdateId < lastDepthUpdateId + 1) return;
        awaitingFirstDepthEvent = false;
      }
      const isContiguous = previousUpdateId === lastDepthUpdateId || (!Number.isFinite(previousUpdateId) && firstUpdateId <= lastDepthUpdateId + 1);
      if (firstUpdateId > lastDepthUpdateId + 1 && !isContiguous) {
        depthReady = false;
        pendingDepthUpdates.push(data);
        void resyncDepth();
        return;
      }
      for (const [levelPrice, quantity] of (data.b as string[][] | undefined) ?? []) {
        const priceValue = num(levelPrice);
        const quantityValue = num(quantity);
        if (Number.isFinite(priceValue) && Number.isFinite(quantityValue)) {
          if (quantityValue === 0) depthBook.bids.delete(priceValue);
          else depthBook.bids.set(priceValue, quantityValue);
        }
      }
      for (const [levelPrice, quantity] of (data.a as string[][] | undefined) ?? []) {
        const priceValue = num(levelPrice);
        const quantityValue = num(quantity);
        if (Number.isFinite(priceValue) && Number.isFinite(quantityValue)) {
          if (quantityValue === 0) depthBook.asks.delete(priceValue);
          else depthBook.asks.set(priceValue, quantityValue);
        }
      }
      lastDepthUpdateId = finalUpdateId;
      publishDepth();
    };

    const loadSeed = async () => {
      setStatus('connecting');
      setCandles([]);
      setBids([]);
      setAsks([]);
      setTrades([]);
      setLevelExecutions([]);
      setLiquidations([]);
      setPrice(null);
      setChange(null);
      setQuoteVolume(null);
      setLatencyMs(null);
      deltaRef.current = new Map();
      recentNotionalRef.current = [];
      levelExecutionMapRef.current = new Map();
      levelExecutionCandleRef.current = null;
      try {
        const [klinesResponse, tickerResponse, depthResponse] = await Promise.all([
           fetch(`${rest}/dapi/v1/klines?symbol=${symbol}&interval=${binanceInterval}&limit=1000`.replace('/dapi', contractType === 'usdt-m' ? '/fapi' : '/dapi')),
           fetch(`${rest}/dapi/v1/ticker/24hr?symbol=${symbol}`.replace('/dapi', contractType === 'usdt-m' ? '/fapi' : '/dapi')),
           fetch(`${rest}/dapi/v1/depth?symbol=${symbol}&limit=50`.replace('/dapi', contractType === 'usdt-m' ? '/fapi' : '/dapi')),
        ]);
        if (!klinesResponse.ok || !tickerResponse.ok || !depthResponse.ok) throw new Error('Market data request failed');
        const [klines, ticker, depth] = await Promise.all([klinesResponse.json(), tickerResponse.json(), depthResponse.json()]);
        if (cancelled) return;
        const rawKlines = klines as unknown[][];
        const latestCandleTime = num(rawKlines[rawKlines.length - 1]?.[0]);
        levelExecutionCandleRef.current = Number.isFinite(latestCandleTime) ? latestCandleTime : null;
        lastKlineMessageAt = Date.now();
        const volumes = rawKlines.map((k) => num(k[5])).sort((a, b) => a - b);
        const medianVolume = volumes[Math.floor(volumes.length / 2)] ?? 0;
        const largeVolumeCutoff = medianVolume * 2.2;
        setCandles(rawKlines.map((k) => {
          const volume = num(k[5]);
          const buyVolume = num(k[9]);
          const sellVolume = Math.max(0, volume - buyVolume);
          const delta = buyVolume - sellVolume;
          const isLargeDirectionalBar = volume >= largeVolumeCutoff;
          return { time: num(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]), volume, delta, buyVolume, sellVolume, directionBias: volume ? delta / volume : num(k[4]) >= num(k[1]) ? 1 : -1, largeBuyVolume: isLargeDirectionalBar && delta > 0 ? buyVolume : 0, largeSellVolume: isLargeDirectionalBar && delta < 0 ? sellVolume : 0 };
        }));
        setPrice(num(ticker.lastPrice));
        setChange(num(ticker.priceChangePercent));
        setQuoteVolume(num(ticker.quoteVolume));
         depthBook.bids.clear();
         depthBook.asks.clear();
         for (const [levelPrice, quantity] of depth.bids as string[][]) depthBook.bids.set(num(levelPrice), num(quantity));
         for (const [levelPrice, quantity] of depth.asks as string[][]) depthBook.asks.set(num(levelPrice), num(quantity));
         lastDepthUpdateId = num(depth.lastUpdateId);
         depthReady = Number.isFinite(lastDepthUpdateId);
         awaitingFirstDepthEvent = depthReady;
         publishDepth();
         const queued = pendingDepthUpdates.splice(0);
         queued.forEach((update) => applyDepthUpdate(update));
      } catch {
        if (!cancelled) setStatus('error');
      }
    };
    let lastKlineMessageAt = Date.now();
    let candlePollInFlight = false;
    let candlePollTimer: number | undefined;
    const pollLatestCandle = async () => {
      if (cancelled || paused || candlePollInFlight) return;
      candlePollInFlight = true;
      try {
        const response = await fetch(`${rest}/${apiPrefix}/v1/klines?symbol=${symbol}&interval=${binanceInterval}&limit=1`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Live candle refresh failed');
        const rows = await response.json() as unknown[][];
        const row = rows[0];
        if (!row || row.length < 10) throw new Error('Invalid live candle response');
        if (cancelled) return;
        const volume = num(row[5]);
        const buyVolume = num(row[9]);
        const sellVolume = Math.max(0, volume - buyVolume);
        const next: Candle = {
          time: num(row[0]),
          open: num(row[1]),
          high: num(row[2]),
          low: num(row[3]),
          close: num(row[4]),
          volume,
          delta: buyVolume - sellVolume,
          buyVolume,
          sellVolume,
          directionBias: volume ? (buyVolume - sellVolume) / volume : num(row[4]) >= num(row[1]) ? 1 : -1,
          largeBuyVolume: 0,
          largeSellVolume: 0,
        };
        if (![next.time, next.open, next.high, next.low, next.close].every(Number.isFinite)) {
          throw new Error('Non-finite live candle values');
        }
        if (levelExecutionCandleRef.current !== next.time) {
          levelExecutionCandleRef.current = next.time;
          levelExecutionMapRef.current = new Map();
          setLevelExecutions([]);
        }
        setCandles((items) => {
          const previous = items.find((candle) => candle.time === next.time);
          const merged = previous
            ? { ...next, delta: previous.delta, buyVolume: previous.buyVolume, sellVolume: previous.sellVolume, directionBias: previous.directionBias, largeBuyVolume: previous.largeBuyVolume, largeSellVolume: previous.largeSellVolume }
            : next;
          const last = items[items.length - 1];
          if (last?.time === next.time) return [...items.slice(0, -1), merged];
          if (last && last.time > next.time) return items.map((candle) => candle.time === next.time ? merged : candle);
          return [...items, merged].slice(-1000);
        });
        setPrice(next.close);
        lastKlineMessageAt = Date.now();
        setLastMessageAt(lastKlineMessageAt);
        setStatus('connected');
      } catch (error) {
        if (!cancelled) {
          setStatus('error');
          console.error('Failed to refresh the live candle from Binance.', error);
        }
      } finally {
        candlePollInFlight = false;
      }
    };
    candlePollTimer = window.setInterval(() => {
      if (!cancelled && Date.now() - lastKlineMessageAt >= 1_000) void pollLatestCandle();
    }, 250);
    void loadSeed();
    void syncServerClock();
    clockSyncTimer = window.setInterval(() => void syncServerClock(), 60_000);
     const socket = new WebSocket(`${endpoint.ws}streams=${lower}@aggTrade/${lower}@depth@100ms/${lower}@kline_${binanceInterval}/${lower}@forceOrder`);
    socketRef.current = socket;
     socket.onopen = () => { if (!cancelled) { reconnectAttempt = 0; setStatus(paused ? 'paused' : 'connected'); } };
     socket.onclose = () => { if (!cancelled && !paused) { setLatencyMs(null); setStatus('disconnected'); scheduleReconnect(); } };
     socket.onerror = () => { if (!cancelled && !paused) setStatus('connecting'); };
    socket.onmessage = (event) => {
      if (cancelled || paused) return;
       let payload: { stream: string; data: Record<string, unknown> };
       try {
         payload = JSON.parse(event.data) as { stream: string; data: Record<string, unknown> };
       } catch {
         setStatus('error');
         return;
       }
      const data = payload.data;
      const receivedAt = Date.now();
      if (receivedAt - lastFeedUiUpdateAt >= 500) {
        setLastMessageAt(receivedAt);
        const eventTime = num(data.E);
        if (serverClockOffsetMs != null && Number.isFinite(eventTime)) {
          const latencyEstimateMs = receivedAt + serverClockOffsetMs - eventTime;
          setLatencyMs(latencyEstimateMs > 0 ? Math.max(1, Math.round(latencyEstimateMs)) : null);
        }
        lastFeedUiUpdateAt = receivedAt;
      }
      if (payload.stream.endsWith('@aggTrade')) {
        const notional = num(data.p) * num(data.q);
        const recent = recentNotionalRef.current;
        const sorted = [...recent.slice(-40), notional].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        const isLarge = notional >= Math.max(25_000, median * 6);
        recentNotionalRef.current = [...recent.slice(-80), notional];
        const trade: Trade = { id: num(data.a), price: num(data.p), qty: num(data.q), notional, time: num(data.T), side: data.m ? 'sell' : 'buy', isLarge };
        updateLevelExecutions(trade);
        const candleTime = Math.floor(trade.time / intervalMs(interval)) * intervalMs(interval);
        const current = deltaRef.current.get(candleTime) ?? { buy: 0, sell: 0, largeBuy: 0, largeSell: 0 };
        current[trade.side === 'buy' ? 'buy' : 'sell'] += trade.qty;
        if (isLarge) current[trade.side === 'buy' ? 'largeBuy' : 'largeSell'] += trade.qty;
        deltaRef.current.set(candleTime, current);
        pendingTradeUpdates.push(trade);
        if (tradeUiFlushTimer == null) tradeUiFlushTimer = window.setTimeout(flushTradeUpdates, 100);
       } else if (payload.stream.endsWith('@depth@100ms')) {
         applyDepthUpdate(data as DepthUpdate);
      } else if (payload.stream.includes('@kline_')) {
        lastKlineMessageAt = receivedAt;
        const k = data.k as Record<string, unknown>;
        const next: Candle = { time: num(k.t), open: num(k.o), high: num(k.h), low: num(k.l), close: num(k.c), volume: num(k.v), delta: 0, buyVolume: 0, sellVolume: 0, directionBias: num(k.c) >= num(k.o) ? 1 : -1, largeBuyVolume: 0, largeSellVolume: 0 };
        if (levelExecutionCandleRef.current !== next.time) {
          levelExecutionCandleRef.current = next.time;
          levelExecutionMapRef.current = new Map();
          setLevelExecutions([]);
        }
        const flow = deltaRef.current.get(next.time);
        if (flow) {
          const delta = flow.buy - flow.sell;
          Object.assign(next, { delta, buyVolume: flow.buy, sellVolume: flow.sell, directionBias: flow.buy + flow.sell ? delta / (flow.buy + flow.sell) : next.directionBias, largeBuyVolume: flow.largeBuy, largeSellVolume: flow.largeSell });
        }
        setPrice(next.close);
        setCandles((items) => {
          const previous = items.find((item) => item.time === next.time);
          const merged = flow || !previous ? next : { ...next, delta: previous.delta, buyVolume: previous.buyVolume, sellVolume: previous.sellVolume, directionBias: previous.directionBias, largeBuyVolume: previous.largeBuyVolume, largeSellVolume: previous.largeSellVolume };
           return items.length && items[items.length - 1].time === next.time ? [...items.slice(0, -1), merged] : [...items, merged].slice(-1000);
        });
       } else if (payload.stream.endsWith('@forceOrder')) {
         const order = data.o as Record<string, unknown>;
         const liquidation: Liquidation = {
           id: num(order.T) || Date.now(),
           price: num(order.ap) || num(order.p),
           qty: num(order.z) || num(order.q),
           notional: (num(order.ap) || num(order.p)) * (num(order.z) || num(order.q)),
           time: num(order.T) || Date.now(),
           side: order.S === 'BUY' ? 'buy' : 'sell',
         };
         setLiquidations((items) => [liquidation, ...items].slice(0, 500));
      }
    };
     return () => {
       cancelled = true;
       if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
       if (depthResyncTimer != null) window.clearTimeout(depthResyncTimer);
       if (clockSyncTimer != null) window.clearInterval(clockSyncTimer);
       if (candlePollTimer != null) window.clearInterval(candlePollTimer);
       if (tradeUiFlushTimer != null) window.clearTimeout(tradeUiFlushTimer);
       pendingTradeUpdates = [];
       socket.close();
       if (socketRef.current === socket) socketRef.current = null;
     };
   }, [contractType, symbol, interval, paused, reconnectKey]);

  return { candles, bids, asks, trades, levelExecutions, liquidations, price, change, quoteVolume, status: paused ? 'paused' as MarketStatus : status, lastMessageAt, latencyMs, reconnect };
}

function intervalMs(interval: string) {
  const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 2_592_000_000 };
  const unit = interval.slice(-1);
  return Number(interval.slice(0, -1)) * (units[unit === 'M' ? unit : unit.toLowerCase()] ?? 60_000);
}

function toBinanceInterval(interval: string) {
  const unit = interval.slice(-1);
  return unit === 'D' || unit === 'W' ? `${interval.slice(0, -1)}${unit.toLowerCase()}` : interval;
}

export function usePerpetualSymbols(contractType: ContractType = 'usdt-m') {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    const rest = ENDPOINTS[contractType].rest;
    const apiPrefix = contractType === 'usdt-m' ? 'fapi' : 'dapi';
    Promise.all([fetch(`${rest}/${apiPrefix}/v1/exchangeInfo`), fetch(`${rest}/${apiPrefix}/v1/ticker/24hr`)]).then(async ([exchangeResponse, tickerResponse]) => {
      const [payload, tickerPayload] = await Promise.all([exchangeResponse.json(), tickerResponse.json()]);
      const tickers = new Map((tickerPayload as Array<Record<string, unknown>>).map((item) => [String(item.symbol), item]));
       const rawList = (payload.symbols as Array<Record<string, unknown>>).filter((item) => item.contractType === 'PERPETUAL' && item.status === 'TRADING' && (contractType === 'usdt-m' ? item.quoteAsset === 'USDT' : item.contractType === 'PERPETUAL')).map((item) => {
        const ticker = tickers.get(String(item.symbol));
          return { symbol: String(item.symbol), baseAsset: String(item.baseAsset), quoteAsset: String(item.quoteAsset ?? (contractType === 'usdt-m' ? 'USDT' : 'USD')), contractType, volume: num(ticker?.quoteVolume ?? ticker?.baseVolume), volumeSpike: 1, change: num(ticker?.priceChangePercent), lastPrice: num(ticker?.lastPrice), contractSize: Number.isFinite(num(item.contractSize)) ? num(item.contractSize) : null };
       });
       const sortedVolumes = rawList.map((item) => item.volume).sort((a, b) => a - b);
       const medianVolume = sortedVolumes[Math.floor(sortedVolumes.length / 2)] || 1;
       const list = rawList.map((item) => ({ ...item, volumeSpike: item.volume / medianVolume })).sort((a, b) => b.volume - a.volume);
      setSymbols(list);
    }).catch(() => setSymbols([])).finally(() => setLoading(false));
   }, [contractType]);
  return { symbols, loading };
}

export function useUsdtSymbols() {
  return usePerpetualSymbols('usdt-m');
}

export function useMarketPulse(symbol: string, contractType: ContractType = 'usdt-m') {
  const [pulse, setPulse] = useState<MarketPulse>({ openInterest: null, fundingRate: null, markPrice: null, nextFundingTime: null, updatedAt: null });

  useEffect(() => {
    let cancelled = false;
    const loadPulse = async () => {
      try {
        const rest = ENDPOINTS[contractType].rest;
        const apiPrefix = contractType === 'usdt-m' ? 'fapi' : 'dapi';
        const [interestResponse, premiumResponse] = await Promise.all([
          fetch(`${rest}/${apiPrefix}/v1/openInterest?symbol=${symbol}`),
          fetch(`${rest}/${apiPrefix}/v1/premiumIndex?symbol=${symbol}`),
        ]);
        if (!interestResponse.ok || !premiumResponse.ok) throw new Error('Market pulse request failed');
        const [interest, premium] = await Promise.all([interestResponse.json(), premiumResponse.json()]);
        if (cancelled) return;
        setPulse({
          openInterest: num(interest.openInterest),
          fundingRate: num(premium.lastFundingRate),
          markPrice: num(premium.markPrice),
          nextFundingTime: num(premium.nextFundingTime),
          updatedAt: Date.now(),
        });
      } catch {
        if (!cancelled) setPulse((current) => ({ ...current, updatedAt: Date.now() }));
      }
    };

    void loadPulse();
    const timer = window.setInterval(loadPulse, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [contractType, symbol]);

  return pulse;
}

async function fetchOpenInterestSnapshot(url: string, parentSignal: AbortSignal) {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  parentSignal.addEventListener('abort', abortRequest, { once: true });
  const timeout = window.setTimeout(abortRequest, 12_000);
  try {
    return await fetch(url, { cache: 'no-store', signal: requestController.signal });
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abortRequest);
  }
}

export function useOpenInterest(symbols: SymbolInfo[], contractType: ContractType) {
  const [markets, setMarkets] = useState<OpenInterestMarket[]>([]);
  const [feed, setFeed] = useState<OpenInterestFeed>({ phase: 'loading', message: 'Loading perpetual market list…', updatedAt: null, scanned: 0, total: 0 });
  const samplesRef = useRef(new Map<string, { at: number; value: number }[]>());
  const marketsRef = useRef(new Map<string, OpenInterestMarket>());
  const contractTypeRef = useRef(contractType);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let controller: AbortController | null = null;
    const allowed = new Set(symbols.map((item) => item.symbol));

    if (contractTypeRef.current !== contractType) {
      contractTypeRef.current = contractType;
      samplesRef.current.clear();
      marketsRef.current.clear();
      setMarkets([]);
    } else {
      for (const symbol of marketsRef.current.keys()) {
        if (!allowed.has(symbol)) marketsRef.current.delete(symbol);
      }
      for (const symbol of samplesRef.current.keys()) {
        if (!allowed.has(symbol)) samplesRef.current.delete(symbol);
      }
    }

    if (!symbols.length) {
      setFeed({ phase: 'loading', message: 'Waiting for Binance perpetual symbols…', updatedAt: null, scanned: 0, total: 0 });
      return () => { disposed = true; };
    }

    const rest = ENDPOINTS[contractType].rest;
    const apiPrefix = contractType === 'usdt-m' ? 'fapi' : 'dapi';
    const schedule = (delayMs: number) => {
      if (!disposed) retryTimer = window.setTimeout(() => void scan(), delayMs);
    };

    const scan = async () => {
      if (disposed) return;
      controller = new AbortController();
      const signal = controller.signal;
      const updatedMarkets = new Map(marketsRef.current);
      const markPrices = new Map<string, number>();
      let markPriceError: string | null = null;
      let rateLimited = false;
      let scanned = 0;
      let succeeded = 0;
      let failed = 0;
      let valueUnavailable = 0;
      let firstError: string | null = null;
      setFeed((current) => ({ ...current, phase: 'scanning', message: `Scanning 0/${symbols.length} perpetual OI snapshots…`, scanned: 0, total: symbols.length }));

      try {
        const response = await fetchOpenInterestSnapshot(`${rest}/${apiPrefix}/v1/premiumIndex`, signal);
        if (response.status === 418 || response.status === 429) {
          rateLimited = true;
          firstError = `Binance rate limit (HTTP ${response.status}); scan paused`;
        } else if (!response.ok) {
          markPriceError = `Mark-price snapshot returned HTTP ${response.status}`;
        } else {
          const payload = await response.json() as unknown;
          if (!Array.isArray(payload)) {
            markPriceError = 'Unexpected Binance mark-price snapshot format';
          } else {
            for (const item of payload as Array<Record<string, unknown>>) {
              const markPrice = Number(item.markPrice);
              if (typeof item.symbol === 'string' && Number.isFinite(markPrice) && markPrice > 0) markPrices.set(item.symbol, markPrice);
            }
            if (!markPrices.size) markPriceError = 'Binance mark-price snapshot contained no valid markets';
          }
        }
      } catch (error) {
        if (disposed || signal.aborted) return;
        markPriceError = error instanceof Error ? error.message : 'Binance mark-price snapshot failed';
      }

      if (rateLimited) {
        setFeed((current) => ({ ...current, phase: 'degraded', message: `${firstError}; retrying in 60s`, total: symbols.length }));
        schedule(60_000);
        return;
      }

      const batchSize = 12;
      for (let offset = 0; offset < symbols.length; offset += batchSize) {
        if (disposed || signal.aborted) return;
        const batch = symbols.slice(offset, offset + batchSize);
        const results = await Promise.all(batch.map(async (item): Promise<OpenInterestRequestResult> => {
          try {
            const response = await fetchOpenInterestSnapshot(`${rest}/${apiPrefix}/v1/openInterest?symbol=${encodeURIComponent(item.symbol)}`, signal);
            if (response.status === 418 || response.status === 429) return { item, ok: false, rateLimited: true, error: `HTTP ${response.status}` };
            if (!response.ok) return { item, ok: false, rateLimited: false, error: `HTTP ${response.status}` };
            const payload = await response.json() as Record<string, unknown>;
            const value = Number(payload.openInterest);
            if (payload.symbol !== item.symbol || !Number.isFinite(value) || value < 0) {
              return { item, ok: false, rateLimited: false, error: 'Invalid Binance open-interest response' };
            }
            return { item, ok: true, rateLimited: false, value };
          } catch (error) {
            if (signal.aborted) return { item, ok: false, rateLimited: false, error: 'Request cancelled' };
            return { item, ok: false, rateLimited: false, error: error instanceof Error ? error.message : 'Open-interest request failed' };
          }
        }));

        if (disposed || signal.aborted) return;
        if (results.some((result) => result.rateLimited)) {
          rateLimited = true;
          firstError = `Binance rate limit reached for ${results.find((result) => result.rateLimited)?.item.symbol ?? 'market'}; scan paused`;
        }

        const observedAt = Date.now();
        for (const result of results) {
          scanned += 1;
          if (!result.ok) {
            failed += 1;
            firstError ??= `${result.item.symbol}: ${result.error}`;
            continue;
          }

          succeeded += 1;
          const history = samplesRef.current.get(result.item.symbol) ?? [];
          history.push({ at: observedAt, value: result.value });
          while (history.length && observedAt - history[0].at > 20 * 60_000) history.shift();
          samplesRef.current.set(result.item.symbol, history);
          const baseline = [...history].reverse().find((sample) => sample.at <= observedAt - 4 * 60_000);
          const baselineIsRecent = baseline != null && observedAt - baseline.at <= 6 * 60_000 && baseline.value > 0;
          const change5m = baselineIsRecent && baseline ? ((result.value - baseline.value) / baseline.value) * 100 : null;
          const markPrice = markPrices.get(result.item.symbol);
          const openInterestValue = contractType === 'usdt-m'
            ? markPrice == null ? null : result.value * markPrice
            : result.item.contractSize == null ? null : result.value * result.item.contractSize;
          if (openInterestValue == null || !Number.isFinite(openInterestValue)) valueUnavailable += 1;
          updatedMarkets.set(result.item.symbol, {
            symbol: result.item.symbol,
            baseAsset: result.item.baseAsset,
            quoteAsset: result.item.quoteAsset,
            openInterest: result.value,
            openInterestValue: Number.isFinite(openInterestValue) ? openInterestValue : null,
            change5m: Number.isFinite(change5m) ? change5m : null,
            updatedAt: observedAt,
          });
        }

        marketsRef.current = updatedMarkets;
        setMarkets([...updatedMarkets.values()]);
        setFeed((current) => ({ ...current, phase: 'scanning', message: `Scanning ${scanned}/${symbols.length} perpetual OI snapshots…`, scanned, total: symbols.length }));
        if (rateLimited) break;
        if (offset + batchSize < symbols.length) await new Promise((resolve) => window.setTimeout(resolve, 200));
      }

      if (disposed || signal.aborted) return;
      marketsRef.current = updatedMarkets;
      setMarkets([...updatedMarkets.values()]);

      if (rateLimited) {
        setFeed((current) => ({ ...current, phase: 'degraded', message: `${firstError}; ${succeeded}/${symbols.length} updated · retrying in 60s`, updatedAt: current.updatedAt, scanned, total: symbols.length }));
        schedule(60_000);
        return;
      }

      const updatedAt = Date.now();
      const conversionError = contractType === 'usdt-m' ? markPriceError : null;
      const phase: OpenInterestFeed['phase'] = failed || conversionError || valueUnavailable ? succeeded ? 'degraded' : 'error' : 'live';
      const message = failed
        ? `${succeeded}/${symbols.length} markets updated · ${firstError ?? `${failed} requests failed`}`
        : conversionError || valueUnavailable
          ? `OI updated; USD value missing for ${valueUnavailable} markets · ${conversionError ?? 'contract conversion unavailable'}`
          : `Live Binance OI · ${succeeded}/${symbols.length} markets`;
      setFeed({ phase, message, updatedAt, scanned, total: symbols.length });
      schedule(90_000);
    };

    setFeed((current) => ({ ...current, phase: 'scanning', message: `Starting scan for ${symbols.length} perpetual markets…`, scanned: 0, total: symbols.length }));
    void scan();
    return () => {
      disposed = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [contractType, symbols]);

  return { markets, feed };
}