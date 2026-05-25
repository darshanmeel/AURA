# Design Match Audit — 2026-05-25

Compared the Next.js implementation against the original AURA design mockup (`AURA Design (1).zip`).
The user confirmed that the session-detail tabs are an intentional addition; everything else should match.

---

## ✅ Pages that match the design

- **Dashboard** (`app/page.tsx`) — hero, KPI strip, apps ledger, agents table, projects rollup (added), recent errors, top files, people leaderboard, tool mix, providers, models, cache, editor's note
- **Apps list** (`app/apps/page.tsx`) — masthead strap, "one ledger" headline, card grid, agent chips
- **Sessions list** (`app/sessions/page.tsx`) — filters, stats strip, ledger table
- **Errors** (`app/errors/page.tsx`) — strip, kind filters, ledger
- **Agent profile** (`app/agents/[name]/page.tsx`) — header, 6-stat strip, apps/models tables, sessions, prompts panel (gap below)

---

## ❌ Major gaps vs design

### 1. **People list page** — severely stripped down

**Design has:**
- Masthead strap with "{N} operators · {sessions} sessions · {usd} aggregate"
- Hero section: "Who's *driving* the agents." with descriptive lede
- Rich person cards each containing:
  - Avatar + name + role
  - 4-stat grid: Cost / Sessions / Turns / Commits
  - "Apps" chips row (which apps they work in)
  - "Agents" chips row (top 4 + "+N" overflow)
  - Share bar with "X% of org spend"

**Impl has:** A minimal card grid with only cost + sessions + commits + app count. No chips, no share bar, no hero, no organization-level stats.

---

### 2. **Person detail page** — missing entire two-column layout

**Design has:**
- Profile back rail with "OPERATOR · {ID}" meta
- Profile head with avatar (large), eyebrow with role, "{N} sessions · {N} apps · {N} agents · {N} commits"
- Hero-stat with 14-day spend across tokens/turns
- **6-stat strip**: Sessions / Apps / Agents / Commits / Tokens / Errors
- **Two-column body:**
  - Main column:
    - "Agents — delegated to" full table (Agent | Sessions | Turns | Cost | Share)
    - "Apps — worked in" full table (App | Sessions | Turns | Cost | Share)
    - "Sessions — recent" SessionMiniTable
  - Side panel: **"What {firstName} actually types"** — prompts side panel with their actual prompt text

**Impl has:** Bare KPI strip + an agent chip row + a sessions table. Completely missing the agents-delegated-to breakdown, apps-worked-in breakdown, and prompts panel.

---

### 3. **App detail page** — missing People table

**Design has:** "People · in this app" full table — Person | Sessions | Turns | Cost | Share. Shows which operators are working on this app and how much each is spending.

**Impl has:** Agents table only. No people breakdown at all.

---

### 4. **Agent profile** — "People — delegating" is a stub

**Design has:** A full "People — delegating" table (Person | Sessions | Turns | Cost | Share) showing who reaches for this agent.

**Impl has:** StatBlock label="People" value="—" — literally an em-dash stub. The data exists in `dim_sessions` (via `person_id` joined through `fact_turns`).

---

## 🟡 Minor differences

- **Apps cards** — design shows people chips in addition to agent chips; impl shows agents only
- **Person cards** — design shows role text from people.json; impl omits this
- **Agent profile** — design has cost-over-time sparkline in the hero-stat; impl omits the sparkline
- **Errors strip** — design shows "Info events" count in lede; impl includes it in lede but not in stat strip

---

## Pages with extras (kept — these are intentional)

- **Dashboard "Projects — rollup"** table (added)
- **Session detail tabs** (Messages / Prompts / Agents / Errors / Files / Tokens / Tools / Git) — explicitly approved by user
- **App detail "All prompts" feed** — full chronological prompts list
- **Agents index page** (`/agents`) — added 2026-05-24 since the design had a per-agent detail but no list

---

## Fix priority

1. Rebuild **People list** with rich cards (high — most visible gap)
2. Rebuild **Person detail** with two-column layout + Agents/Apps tables + prompts panel
3. Add **"People · in this app"** table to App detail page
4. Add **"People — delegating"** table to Agent profile (replace the "—" stub)
