# Vercel deployment settings

This repository is a pnpm workspace, so deploy the repository root and keep the
Vercel **Root Directory** set to `.`. The root `vercel.json` targets only the
Orderflow Terminal artifact.

The checked-in settings are:

- Framework preset: `Vite`
- Install command: `pnpm install --frozen-lockfile`
- Build command: `PORT=24981 BASE_PATH=/ pnpm --filter @workspace/orderflow-terminal run build`
- Output directory: `artifacts/orderflow-terminal/dist/public`
- Node.js: use the Vercel project default/current LTS
- Environment variables: none required for the public market-data build

The app opens browser WebSocket connections to Binance Futures public streams.
Vercel serves the static SPA; it does not proxy, store credentials, or execute
orders. If Binance or a network policy blocks the public stream, the terminal
shows its connection and freshness state and can reconnect from the UI.