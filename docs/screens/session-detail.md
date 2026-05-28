# Session detail — Aura

**URL:** `/sessions/<sessionId>`  
**Sample captured:** 044e06c4-f1a2-48e8-9640-02d674835e40 (57 skills, 641 turns, ~$115)  
**Primary range:** N/A (session-scoped, no range filter)

## What this screen shows

Deep-dive into a single Claude Code session. Displays conversation transcripts, prompts, tool invocations, errors, costs, and tokens per-turn. Nine tabs (Details, Messages, Prompts, Agents, Errors, Files, Tokens, Tools, Git) reveal different dimensions of the same session. Fetched real-time via `lib/queries/sessions.ts`.

## Masthead

- **Left:** Eyebrow chips (provider, person, working dir, agent, git branch, skill/MCP counts)
- **Center:** Session title (first 120 chars of first prompt, split at · for italic subtitle)
- **Right:** SESSION COST hero stat in large color-coded typography; subheader with session_id, cwd, branch+commits, model, started, duration, status

## KPI strip

6 inline metrics: Turns · Output tokens · Cache 1h · Cache 5m · Cache hit % · $/turn

## Tabs (SessionTabs.tsx, all client-side state)

| Tab | What it shows | Data source |
|---|---|---|
| **Details** (default) | Turns table (first 20 of N): #, time, in/out tokens, cache write/read, stop_reason, tool, context % | `getSessionTurns()` → `fact_turns` |
| **Messages** | Per-turn USER↔CLAUDE conversation. User & assistant bubbles with direction colors (green=human, orange=agent). Tools per turn. Expandable text. Thinking blocks. | `turns` + `toolExecutions` indexed by `assistant_event_uuid` |
| **Prompts** | External user prompts with hero strip (most expensive, longest, most errored). Filter chips (All/Human/Agent/Errored/Overkill). Per-prompt: origin tag, model, cache rate, TTFT, stop reason, retry count, subagents, tool signature, cost. Collapsible tool calls + summary. | Lazy-fetched `/api/sessions/.../prompts-enriched` on tab open |
| **Agents** | Agent/subagent distribution — which agents handled which turns | `getSessionPrompts()` grouping by `p.agent` |
| **Errors** | Error ledger: time, severity tag, kind, tool, message, turn #, resolved-in (# turns until fix) | `getSessionErrors()` + `errorResolutions` map |
| **Files** | Files touched in session. Edit/read/create attribution per file. Search. | `getSessionFilesWithAttribution()` or fallback `getSessionFiles()` |
| **Tokens** | Per-turn stacked bar chart: cache-read (muted), ephemeral-5m (accent), output (ink), input (accent-2), + context-% overlay line. X-axis every 10 turns. Legend. | `turns` with `cache_read_input_tokens`, `ephemeral_*_input_tokens`, `output_tokens`, `input_tokens` |
| **Tools** | Tool-call ledger: tool name, call timestamp, result timestamp, duration, success/error | `getSessionToolExecutions()` → `fact_tool_executions` |
| **Git** | Git commands run during session: command, timestamp, exit code, stdout/stderr | `getSessionGitCommands()` → `fact_git_commands` |

## How to read it

- **Message direction**: USER→CLAUDE (green border + 👤) = human typed. CLAUDE→SUBAGENT (orange border + 🤖) = dispatch/orchestrator. Detected via text-prefix patterns in `DISPATCH_PATTERNS` regex array.
- **Overkill detection**: Prompted with 1000s of tokens for a trivial task; flagged on Prompts tab.
- **Cache metrics**: Cache hit rate = cache_read / (cache_read + ephemeral_5m + ephemeral_1h). Shown as % on Prompts row. 80%+ is green, 50%+ is accent, <50% is warn.
- **Cost-per-turn**: Session cost / turn count. Displayed in KPI strip.
- **Thinking blocks**: Collapsed by default; click "💭 show thinking" on Messages tab to expand.

## Edge cases / empty states

- **No turns**: Details + Messages show "No turn data retained."
- **No errors**: Errors tab empty message.
- **Session active**: `end_ts` NULL; status badge shows "active".
- **No thinking**: Thinking-block disclosure hidden.
- **Long sessions (500+ turns)**: Messages tab shows first 500; "show all" link on demand via `?turns=all` query param.
- **Lazy Prompts fetch**: "loading enriched data…" note while CTE query runs (first open only).

## Related screens

- [Sessions list](./sessions-list.md)
- [App detail](./app-detail.md)
- [Provider dashboard](./provider-dashboard.md)

## Screenshots

- **Details tab (default):** ![](./session-detail.png)
- **Messages:** ![](./session-detail-messages.png)
- **Prompts:** ![](./session-detail-prompts.png)
- **Agents:** ![](./session-detail-agents.png)
- **Errors:** ![](./session-detail-errors.png)
- **Files:** ![](./session-detail-files.png)
- **Tokens:** ![](./session-detail-tokens.png)
- **Tools:** ![](./session-detail-tools.png)
- **Git:** ![](./session-detail-git.png)
