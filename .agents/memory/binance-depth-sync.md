---
name: Binance depth synchronization
description: Durable rules for keeping Binance Futures public order books consistent in the Orderflow Terminal.
---

Binance Futures diff-depth data must be applied to a REST snapshot using update IDs: discard events fully older than the snapshot, accept the first event when `U <= lastUpdateId + 1 <= u`, then require contiguous updates or resync after a gap.

**Why:** Replacing the order book with each websocket delta makes the displayed top of book incomplete and can silently produce incorrect imbalance and liquidity-wall readings.

**How to apply:** Keep connection health separate from depth-book freshness. A websocket error can be transient while valid messages continue; expose stale/reconnecting depth state without treating every browser `onerror` event as a terminal feed failure.