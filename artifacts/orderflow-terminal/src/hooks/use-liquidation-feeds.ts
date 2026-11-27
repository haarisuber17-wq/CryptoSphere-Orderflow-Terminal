import { useEffect, useMemo, useState } from 'react';
import type { ContractType, Liquidation, MarketStatus } from '@/hooks/use-binance-market';

export type LiquidationExchange = 'BINANCE' | 'BYBIT' | 'OKX';
export type LiquidationEvent = {
  id: string;
  exchange: LiquidationExchange;
  symbol: string;
  price: number;
  qty: number;
  notional: number | null;
  time: number;
  receivedAt: number;
  side: 'buy' | 'sell' | 'unknown';
};
export type LiquidationFeed = {
  phase: 'connecting' | 'live' | 'degraded' | 'paused';
  latencyMs: number | null;
  lastMessageAt: number | null;
};
export type LiquidationFeeds = Record<LiquidationExchange, LiquidationFeed>;

const initialFeeds: LiquidationFeeds = {
  BINANCE: { phase: 'connecting', latencyMs: null, lastMessageAt: null },
  BYBIT: { phase: 'connecting', latencyMs: null, lastMessageAt: null },
  OKX: { phase: 'connecting', latencyMs: null, lastMessageAt: null },
};

const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function baseAsset(symbol: string) {
  return symbol.replace(/_PERP$/, '').replace(/(USDT|USDC|BUSD|USD)$/, '');
}

function phaseFromMarketStatus(status: MarketStatus): LiquidationFeed['phase'] {
  if (status === 'paused') return 'paused';
  if (status === 'connected') return 'live';
  if (status === 'connecting') return 'connecting';
  return 'degraded';
}

export function useLiquidationFeeds({
  symbol,
  contractType,
  binanceLiquidations,
  binanceStatus,
  binanceLastMessageAt,
  binanceLatencyMs,
  enabled,
}: {
  symbol: string;
  contractType: ContractType;
  binanceLiquidations: Liquidation[];
  binanceStatus: MarketStatus;
  binanceLastMessageAt: number | null;
  binanceLatencyMs: number | null;
  enabled: boolean;
}) {
  const [externalEvents, setExternalEvents] = useState<LiquidationEvent[]>([]);
  const [externalFeeds, setExternalFeeds] = useState<Pick<LiquidationFeeds, 'BYBIT' | 'OKX'>>({
    BYBIT: initialFeeds.BYBIT,
    OKX: initialFeeds.OKX,
  });
  const base = baseAsset(symbol);
  const quote = contractType === 'usdt-m' ? 'USDT' : 'USD';
  const bybitSymbol = `${base}${quote}`;
  const okxInstrument = `${base}-${quote}-SWAP`;

  useEffect(() => {
    let cancelled = false;
    const sockets: WebSocket[] = [];
    const reconnectTimers: number[] = [];
    const heartbeatTimers: number[] = [];
    const attempts: Record<'BYBIT' | 'OKX', number> = { BYBIT: 0, OKX: 0 };
    let okxContractValue: { value: number; currency: string } | null = null;
    let eventSequence = 0;

    setExternalEvents([]);
    if (!enabled) {
      setExternalFeeds({
        BYBIT: { phase: 'paused', latencyMs: null, lastMessageAt: null },
        OKX: { phase: 'paused', latencyMs: null, lastMessageAt: null },
      });
      return () => { cancelled = true; };
    }

    setExternalFeeds({
      BYBIT: { phase: 'connecting', latencyMs: null, lastMessageAt: null },
      OKX: { phase: 'connecting', latencyMs: null, lastMessageAt: null },
    });

    const updateFeed = (exchange: 'BYBIT' | 'OKX', update: Partial<LiquidationFeed>) => {
      setExternalFeeds((current) => ({ ...current, [exchange]: { ...current[exchange], ...update } }));
    };

    void fetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(okxInstrument)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`OKX instrument lookup returned ${response.status}`);
        const payload = await response.json() as { data?: Array<{ ctVal?: unknown; ctValCcy?: unknown }> };
        const instrument = payload.data?.[0];
        const value = finite(instrument?.ctVal);
        const currency = typeof instrument?.ctValCcy === 'string' ? instrument.ctValCcy : '';
        if (value != null && value > 0 && currency) okxContractValue = { value, currency };
      })
      .catch((error: unknown) => {
        if (!cancelled) console.error(`Failed to load OKX contract sizing for ${okxInstrument}.`, error);
      });

    const publish = (
      exchange: 'BYBIT' | 'OKX',
      data: Record<string, unknown>,
      receivedAt: number,
      notionalFor: (qty: number, price: number) => number | null,
    ) => {
      const price = finite(data.price ?? data.bkPx);
      const qty = finite(data.size ?? data.sz);
      const time = finite(data.T ?? data.updatedTime ?? data.ts);
      const sideValue = typeof data.side === 'string' ? data.side.toLowerCase() : '';
      if (price == null || price <= 0 || qty == null || qty <= 0 || time == null || time <= 0) return;
      eventSequence += 1;
      const notional = notionalFor(qty, price);
      const event: LiquidationEvent = {
        id: `${exchange}:${time}:${price}:${eventSequence}`,
        exchange,
        symbol,
        price,
        qty,
        notional: notional != null && Number.isFinite(notional) && notional > 0 ? notional : null,
        time,
        receivedAt,
        side: sideValue === 'buy' ? 'buy' : sideValue === 'sell' ? 'sell' : 'unknown',
      };
      setExternalEvents((current) => [event, ...current].slice(0, 500));
      updateFeed(exchange, {
        phase: 'live',
        latencyMs: Math.max(0, receivedAt - time),
        lastMessageAt: receivedAt,
      });
    };

    const connect = (exchange: 'BYBIT' | 'OKX', url: string) => {
      if (cancelled) return;
      updateFeed(exchange, { phase: 'connecting', latencyMs: null });
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        updateFeed(exchange, { phase: 'degraded' });
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts[exchange], 5));
        attempts[exchange] += 1;
        reconnectTimers.push(window.setTimeout(() => connect(exchange, url), delay));
        return;
      }
      sockets.push(socket);
      let heartbeatTimer: number | undefined;

      socket.onopen = () => {
        if (cancelled) return;
        attempts[exchange] = 0;
        updateFeed(exchange, { phase: 'live', lastMessageAt: Date.now() });
        if (exchange === 'BYBIT') {
          socket.send(JSON.stringify({ op: 'subscribe', args: [`liquidation.${bybitSymbol}`] }));
        } else {
          socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] }));
        }
        heartbeatTimer = window.setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(exchange === 'BYBIT' ? JSON.stringify({ op: 'ping' }) : 'ping');
        }, 20_000);
        heartbeatTimers.push(heartbeatTimer);
      };

      socket.onmessage = (message) => {
        if (cancelled) return;
        if (message.data === 'pong') {
          updateFeed(exchange, { lastMessageAt: Date.now() });
          return;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(String(message.data)) as Record<string, unknown>;
        } catch {
          updateFeed(exchange, { phase: 'degraded' });
          return;
        }
        const receivedAt = Date.now();
        if (payload.event === 'error' || payload.success === false || (typeof payload.ret_msg === 'string' && payload.ret_msg.length > 0)) {
          updateFeed(exchange, { phase: 'degraded', lastMessageAt: receivedAt });
          return;
        }
        if (payload.op === 'pong' || payload.op === 'subscribe' || payload.event === 'subscribe') {
          updateFeed(exchange, { lastMessageAt: receivedAt });
          return;
        }

        if (exchange === 'BYBIT') {
          const records = Array.isArray(payload.data) ? payload.data : [payload.data];
          records.forEach((record) => {
            if (record && typeof record === 'object') {
              publish('BYBIT', record as Record<string, unknown>, receivedAt, (qty, price) => (
                contractType === 'coin-m' ? qty : qty * price
              ));
            }
          });
          return;
        }

        const records = Array.isArray(payload.data) ? payload.data : [];
        records.forEach((record) => {
          if (!record || typeof record !== 'object') return;
          const liquidation = record as { instId?: unknown; details?: unknown };
          if (liquidation.instId !== okxInstrument || !Array.isArray(liquidation.details)) return;
          liquidation.details.forEach((detail) => {
            if (!detail || typeof detail !== 'object') return;
            const values = detail as Record<string, unknown>;
            publish('OKX', values, receivedAt, (qty, price) => {
              if (!okxContractValue) return null;
              if (okxContractValue.currency === base) return qty * okxContractValue.value * price;
              if (okxContractValue.currency === quote) return qty * okxContractValue.value;
              return null;
            });
          });
        });
      };

      socket.onerror = () => {
        if (!cancelled) updateFeed(exchange, { phase: 'degraded' });
      };
      socket.onclose = () => {
        if (cancelled) return;
        if (heartbeatTimer != null) window.clearInterval(heartbeatTimer);
        updateFeed(exchange, { phase: 'degraded', latencyMs: null });
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts[exchange], 5));
        attempts[exchange] += 1;
        reconnectTimers.push(window.setTimeout(() => connect(exchange, url), delay));
      };
    };

    const bybitMarket = contractType === 'usdt-m' ? 'linear' : 'inverse';
    connect('BYBIT', `wss://stream.bybit.com/v5/public/${bybitMarket}`);
    connect('OKX', 'wss://ws.okx.com:8443/ws/v5/public');

    return () => {
      cancelled = true;
      reconnectTimers.forEach((timer) => window.clearTimeout(timer));
      heartbeatTimers.forEach((timer) => window.clearInterval(timer));
      sockets.forEach((socket) => socket.close());
    };
  }, [base, bybitSymbol, contractType, enabled, okxInstrument, symbol]);

  return useMemo(() => {
    const binanceEvents: LiquidationEvent[] = binanceLiquidations.map((event) => ({
      id: `BINANCE:${event.id}:${event.time}:${event.price}`,
      exchange: 'BINANCE',
      symbol,
      price: event.price,
      qty: event.qty,
      notional: event.notional,
      time: event.time,
      receivedAt: event.time,
      side: event.side,
    }));
    const feeds: LiquidationFeeds = {
      BINANCE: {
        phase: phaseFromMarketStatus(binanceStatus),
        latencyMs: binanceLatencyMs,
        lastMessageAt: binanceLastMessageAt,
      },
      BYBIT: externalFeeds.BYBIT,
      OKX: externalFeeds.OKX,
    };
    return {
      events: [...binanceEvents, ...externalEvents].sort((a, b) => b.time - a.time),
      feeds,
    };
  }, [binanceLastMessageAt, binanceLatencyMs, binanceLiquidations, binanceStatus, externalEvents, externalFeeds, symbol]);
}
