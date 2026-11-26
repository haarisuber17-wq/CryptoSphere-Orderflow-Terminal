import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContractType, SymbolInfo } from '@/hooks/use-binance-market';

export type MoveRadarPhase = 'WARMING' | 'QUIET' | 'SETUP' | 'BUILDING' | 'EXPANSION';
export type MoveRadarDirection = 'UP' | 'DOWN' | 'MIXED';
export type MoveRadarMarket = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  lastPrice: number;
  quoteVolume: number;
  change24h: number;
  score: number;
  phase: MoveRadarPhase;
  direction: MoveRadarDirection;
  move1m: number | null;
  rangeCompression: number | null;
  volumeBurst: number | null;
  tradesBurst: number | null;
  updatedAt: number | null;
  historyMinutes: number;
};

type TickerSample = { at: number; price: number; quoteVolume: number; trades: number };
type RadarState = { phase: 'connecting' | 'live' | 'disconnected' | 'error'; message: string; updatedAt: number | null };
type TickerMessage = { s?: unknown; symbol?: unknown; c?: unknown; q?: unknown; P?: unknown; n?: unknown; count?: unknown; lastPrice?: unknown; quoteVolume?: unknown };

const WS_ENDPOINTS: Record<ContractType, string> = {
  'usdt-m': 'wss://fstream.binance.com/ws/!ticker@arr',
  'coin-m': 'wss://dstream.binance.com/ws/!ticker@arr',
};
const HISTORY_MS = 6 * 60_000;
const WARMUP_MS = 5 * 60_000;

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function changeBetween(start: TickerSample | undefined, end: TickerSample | undefined) {
  if (!start || !end || start.price <= 0) return null;
  return ((end.price - start.price) / start.price) * 100;
}

function counterDelta(samples: TickerSample[], startAt: number, endAt: number, field: 'quoteVolume' | 'trades') {
  const start = samples.find((sample) => sample.at >= startAt);
  const end = [...samples].reverse().find((sample) => sample.at <= endAt);
  if (!start || !end || end.at - start.at < (endAt - startAt) * 0.65) return null;
  return Math.max(0, end[field] - start[field]);
}

function rangePercent(samples: TickerSample[]) {
  if (samples.length < 2) return null;
  const prices = samples.map((sample) => sample.price);
  const first = samples[0].price;
  return first > 0 ? ((Math.max(...prices) - Math.min(...prices)) / first) * 100 : null;
}

function calculateMarket(info: SymbolInfo, samples: TickerSample[], now: number): MoveRadarMarket {
  const latest = samples[samples.length - 1];
  const initial = samples[0];
  const historyMinutes = initial ? Math.min(5, Math.max(0, (now - initial.at) / 60_000)) : 0;
  const warming = !latest || now - latest.at > 15_000 || historyMinutes < 5;
  const oneMinuteAgo = [...samples].reverse().find((sample) => sample.at <= now - 60_000);
  const move1m = oneMinuteAgo && now - oneMinuteAgo.at <= 90_000 ? changeBetween(oneMinuteAgo, latest) : null;
  const recent = samples.filter((sample) => sample.at >= now - 60_000);
  const recentRange = rangePercent(recent);
  const previousRanges = Array.from({ length: 5 }, (_, index) => {
    const end = now - 60_000 * (index + 1);
    return rangePercent(samples.filter((sample) => sample.at >= end - 60_000 && sample.at < end));
  }).filter((value): value is number => value != null && value > 0);
  const baselineRange = previousRanges.length >= 3
    ? [...previousRanges].sort((a, b) => a - b)[Math.floor(previousRanges.length / 2)]
    : null;
  const rangeCompression = recentRange != null && baselineRange != null ? recentRange / baselineRange : null;
  const recentVolume = counterDelta(samples, now - 60_000, now, 'quoteVolume');
  const baselineVolumes = Array.from({ length: 5 }, (_, index) => counterDelta(samples, now - 60_000 * (index + 2), now - 60_000 * (index + 1), 'quoteVolume'))
    .filter((value): value is number => value != null);
  const volumeBaseline = baselineVolumes.length >= 3 ? baselineVolumes.reduce((sum, value) => sum + value, 0) / baselineVolumes.length : null;
  const volumeBurst = recentVolume != null && volumeBaseline != null && volumeBaseline > 0 ? recentVolume / volumeBaseline : null;
  const recentTrades = counterDelta(samples, now - 60_000, now, 'trades');
  const baselineTrades = Array.from({ length: 5 }, (_, index) => counterDelta(samples, now - 60_000 * (index + 2), now - 60_000 * (index + 1), 'trades'))
    .filter((value): value is number => value != null);
  const tradesBaseline = baselineTrades.length >= 3 ? baselineTrades.reduce((sum, value) => sum + value, 0) / baselineTrades.length : null;
  const tradesBurst = recentTrades != null && tradesBaseline != null && tradesBaseline > 0 ? recentTrades / tradesBaseline : null;

  if (warming) {
    return {
      ...info, lastPrice: latest?.price ?? info.lastPrice, quoteVolume: latest?.quoteVolume ?? info.volume,
      change24h: info.change, score: 0, phase: 'WARMING', direction: 'MIXED', move1m,
      rangeCompression, volumeBurst, tradesBurst, updatedAt: latest?.at ?? null, historyMinutes,
    };
  }

  const compressionPoints = rangeCompression == null ? 0
    : rangeCompression <= 0.5 ? 30
      : rangeCompression <= 0.75 ? 20
        : rangeCompression <= 1 ? 10 : 0;
  const volumePoints = volumeBurst == null ? 0
    : volumeBurst >= 3 ? 30
      : volumeBurst >= 2 ? 24
        : volumeBurst >= 1.5 ? 16
          : volumeBurst >= 1.2 ? 8 : 0;
  const tradePoints = tradesBurst == null ? 0
    : tradesBurst >= 3 ? 20
      : tradesBurst >= 2 ? 15
        : tradesBurst >= 1.5 ? 10
          : tradesBurst >= 1.2 ? 5 : 0;
  const direction: MoveRadarDirection = move1m == null || Math.abs(move1m) < 0.03 ? 'MIXED' : move1m > 0 ? 'UP' : 'DOWN';
  const expansion = move1m != null && Math.abs(move1m) >= Math.max(0.15, (baselineRange ?? 0) * 1.5) && (volumeBurst ?? 0) >= 1.5;
  const edgePoints = recentRange != null && recentRange > 0 && latest
    ? (() => {
        const low = Math.min(...recent.map((sample) => sample.price));
        const high = Math.max(...recent.map((sample) => sample.price));
        const edgeDistance = Math.min(latest.price - low, high - latest.price) / latest.price * 100;
        return edgeDistance <= recentRange * 0.15 ? 20 : edgeDistance <= recentRange * 0.3 ? 10 : 0;
      })()
    : 0;
  const score = Math.min(100, compressionPoints + volumePoints + tradePoints + edgePoints);
  const phase: MoveRadarPhase = expansion ? 'EXPANSION' : score >= 55 ? 'BUILDING' : score >= 30 ? 'SETUP' : 'QUIET';

  return {
    ...info, lastPrice: latest?.price ?? info.lastPrice, quoteVolume: latest?.quoteVolume ?? info.volume,
    change24h: info.change, score, phase, direction, move1m, rangeCompression,
    volumeBurst, tradesBurst, updatedAt: latest?.at ?? null, historyMinutes,
  };
}

export function useMoveRadar(symbols: SymbolInfo[], contractType: ContractType) {
  const historyRef = useRef(new Map<string, TickerSample[]>());
  const [radarState, setRadarState] = useState<RadarState>({ phase: 'connecting', message: 'Connecting to Binance all-market ticker…', updatedAt: null });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const allowed = new Set(symbols.map((item) => item.symbol));
    const histories = historyRef.current;
    for (const symbol of histories.keys()) {
      if (!allowed.has(symbol)) histories.delete(symbol);
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let refreshTimer: number | undefined;
    let restTimer: number | undefined;
    let retryDelay = 1_000;
    let lastWebSocketMessageAt = 0;

    const ingest = (payload: TickerMessage[], receivedAt: number) => {
      let accepted = false;
      for (const ticker of payload) {
        const symbol = String(ticker.s ?? '');
        const price = finite(ticker.c);
        const quoteVolume = finite(ticker.q);
        const trades = finite(ticker.n ?? ticker.count);
        if (!allowed.has(symbol) || price == null || price <= 0 || quoteVolume == null || trades == null) continue;
        const samples = histories.get(symbol) ?? [];
        const last = samples[samples.length - 1];
        if (last && receivedAt - last.at < 900) continue;
        samples.push({ at: receivedAt, price, quoteVolume, trades });
        while (samples.length && receivedAt - samples[0].at > HISTORY_MS) samples.shift();
        histories.set(symbol, samples);
        accepted = true;
      }
      return accepted;
    };

    const loadTickerSnapshot = async () => {
      const rest = contractType === 'usdt-m' ? 'https://fapi.binance.com' : 'https://dapi.binance.com';
      const apiPrefix = contractType === 'usdt-m' ? 'fapi' : 'dapi';
      try {
        const response = await fetch(`${rest}/${apiPrefix}/v1/ticker/24hr`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Binance ticker snapshot returned HTTP ${response.status}`);
        const payload = await response.json() as TickerMessage[];
        if (disposed) return;
        if (!Array.isArray(payload)) throw new Error('Unexpected Binance ticker snapshot format');
        const receivedAt = Date.now();
        const snapshot = payload.map((ticker) => ({
          ...ticker,
          s: ticker.s ?? ticker.symbol,
          c: ticker.c ?? ticker.lastPrice,
          q: ticker.q ?? ticker.quoteVolume,
          n: ticker.n ?? ticker.count,
        }));
        if (!ingest(snapshot, receivedAt)) throw new Error('Binance ticker snapshot contained no matching perpetual markets');
        setRadarState({
          phase: 'live',
          message: receivedAt - lastWebSocketMessageAt < 5_000 ? 'Live all-market WebSocket ticker' : 'Live Binance ticker snapshot · 15s refresh',
          updatedAt: receivedAt,
        });
      } catch (error) {
        if (!disposed) {
          const message = error instanceof Error ? error.message : 'Binance ticker snapshot failed';
          setRadarState((current) => current.updatedAt != null && Date.now() - current.updatedAt < 10_000
            ? current
            : { phase: 'error', message, updatedAt: current.updatedAt });
        }
      }
    };

    const connect = () => {
      if (disposed) return;
      setRadarState((current) => ({ ...current, phase: 'connecting', message: 'Connecting to Binance all-market ticker…' }));
      socket = new WebSocket(WS_ENDPOINTS[contractType]);
      socket.onopen = () => {
        retryDelay = 1_000;
        setRadarState({ phase: 'live', message: 'Live all-market ticker', updatedAt: Date.now() });
      };
      socket.onmessage = (event) => {
        let payload: TickerMessage[];
        try {
          payload = JSON.parse(String(event.data)) as TickerMessage[];
        } catch {
          setRadarState({ phase: 'error', message: 'Invalid Binance all-market ticker message', updatedAt: Date.now() });
          return;
        }
        if (!Array.isArray(payload)) {
          setRadarState({ phase: 'error', message: 'Unexpected Binance all-market ticker format', updatedAt: Date.now() });
          return;
        }
        const receivedAt = Date.now();
        if (ingest(payload, receivedAt)) {
          lastWebSocketMessageAt = receivedAt;
          setRadarState({ phase: 'live', message: 'Live all-market WebSocket ticker', updatedAt: receivedAt });
        }
      };
      socket.onerror = () => {
        setRadarState({ phase: 'error', message: 'Binance ticker stream error', updatedAt: Date.now() });
      };
      socket.onclose = () => {
        if (disposed) return;
        setRadarState((current) => current.phase === 'error'
          ? current
          : { phase: 'disconnected', message: 'Ticker disconnected; reconnecting…', updatedAt: current.updatedAt });
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };

    connect();
    void loadTickerSnapshot();
    refreshTimer = window.setInterval(() => setRefresh((value) => value + 1), 2_000);
    restTimer = window.setInterval(() => void loadTickerSnapshot(), 15_000);
    return () => {
      disposed = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (refreshTimer != null) window.clearInterval(refreshTimer);
      if (restTimer != null) window.clearInterval(restTimer);
      socket?.close();
    };
  }, [contractType, symbols]);

  const markets = useMemo(() => {
    const now = Date.now();
    return symbols.map((item) => calculateMarket(item, historyRef.current.get(item.symbol) ?? [], now));
  }, [refresh, symbols]);

  return { markets, radarState };
}
