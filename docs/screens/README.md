# AURA — screen documentation

Auto-generated reference for every screen in the AURA dashboard. Each entry
lists the screen, its URL, and the primary screenshot (7-day range unless
otherwise noted). Variants (today / 30d / all) are captured per screen where
they meaningfully differ.

Captured on 2026-05-28 against the live local stack (watcher + dbt + frontend).

**Start here:** [OVERVIEW.md](./OVERVIEW.md) — operator's guide that
synthesises every screen below into a single navigation + lineage map.

## Index

| Screen | URL | Doc | Variants |
|---|---|---|---|
| Dashboard | `/` | [dashboard.md](./dashboard.md) | today, 30d, all |
| Sessions — list | `/sessions` | [sessions-list.md](./sessions-list.md) | today |
| Session detail (all tabs) | `/sessions/<id>` | [session-detail.md](./session-detail.md) | 8 tabs: messages, prompts, agents, errors, files, tokens, tools, git |
| Apps — list | `/apps` | [apps-list.md](./apps-list.md) | 30d |
| App detail | `/apps/<appId>` | [app-detail.md](./app-detail.md) | all |
| Agents — list | `/agents` | [agents-list.md](./agents-list.md) | all |
| Agent detail | `/agents/<name>` | [agent-detail.md](./agent-detail.md) | all |
| People — list | `/people` | [people-list.md](./people-list.md) | all |
| Person detail | `/people/<personId>` | [person-detail.md](./person-detail.md) | all |
| Errors — list | `/errors` | [errors-list.md](./errors-list.md) | today, all |
| Observability | `/observability` | [observability.md](./observability.md) | — (always live) |
| Tokens — drill-down | `/tokens` | [tokens-page.md](./tokens-page.md) | today (hourly), 30d |
| 404 / not-found | `/sessions/<unknown>` | [nav-404.md](./nav-404.md) | — |

## How this was generated

13 Haiku agents ran in parallel, one per screen. Each agent:

1. Used Playwright (chromium headless, viewport 1440×900, `fullPage: true`,
   `networkidle` + 2.5 s settle) to capture the screen at primary range and
   variants.
2. Read the corresponding `frontend/app/.../page.tsx` and its imported query
   functions to build the data-source table in its `.md`.
3. Wrote a documentation file following the same template (purpose, layout,
   data sources, how to read, edge cases, related screens, screenshots).

## Refreshing

To re-run a single screen, re-dispatch a Haiku Playwright agent with the
same brief, or run the per-screen Playwright snippet from inside its `.md`
manually.
