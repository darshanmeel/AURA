# Tokens — drill-down

**URL:** `/tokens`  
**Primary range:** 7d  
**Variants:** today (hourly buckets), 30d (model mix)

## What this screen shows

Detailed token volume breakdown across the selected range. The dashboard shows the headline chart; this page is the full drill-down by token type, model, provider, and agent.

## Layout & components

- **Range filter** — today / 7d / 30d / all
- **By token type** — stacked bars: input · output · cache (read · 5m · 1h)
  - 5 colors: teal (input) · gold (output) · orange (cache 1h) · violet (cache 5m) · slate (cache read)
- **By provider** — Anthropic vs Google (variable N, overlay via stacked bars)
- **By model** — top-10 ranked by volume, tail lumped grey (palette rotation)
- **By agent** — top-20 table: agent · input · output · cache write · cache read · total · cost · share bar

## Data sources

| Component | Query | Mart |
|---|---|---|
| By type | `getTokenSeries(since, hourly)` | `fact_model_calls` |
| By provider | `getTokenSeriesByProvider` | `fact_model_calls` |
| By model | `getTokenSeriesByModel` | `fact_model_calls` |
| By agent | `getTokenByAgent` | `fact_model_calls × int_event_agent` |

## How to read it

- **Cache 1h (orange)** — most expensive cache write; spikes = costly inference
- **Output tokens (gold)** — drives cost most (~5× input cost typical)
- **Cache read (slate)** — cheap, often largest volume by count
- **Input (teal)** — cheap baseline
- **Cache 5m (violet)** — mid-tier write cost, intermediate lifetime
- **Agent share bar** — which subagent wrote the most tokens in range

## Edge cases

- "No token data in this range." → range with no `fact_model_calls` rows
- Hourly bucketing only triggers when `range=today`; longer ranges always bucket by day
- Tail models (beyond top-10) labeled "tail" and colored grey

## Implementation notes

- Chart is responsive SVG (viewBox) with no chart library; renders stacked bars via `TokenSeriesChart`
- Page is server-side (`force-dynamic`); `pivotByDim` runs at build time, not client
- Token types stored in `fact_model_calls`: `input_tokens`, `output_tokens`, `cache_read`, `cache_5m`, `cache_1h`
- Agent table supports variable N (no pagination); style is fixed-width columns with numeric alignment

## Screenshots

- **7d (primary):** ![](./tokens-page.png)
- **Today (hourly):** ![](./tokens-page-today.png)
- **30d (wider model mix):** ![](./tokens-page-30d.png)
