# LinkedIn post — Aura launch (29 May 2026)

> Posting notes: the strong lines are the first two (everything above "…see more"
> on LinkedIn). Attach `linkedin-carousel.pdf` (exported from
> `linkedin-carousel.html`) as a document so it renders as a swipeable carousel.
> No hashtag wall — 3 focused tags at the end.

---

I ran one query against a month of my own Claude Code transcripts.

I'd spent $2,666 in 30 days — and a single agent was quietly eating two-thirds of the bill.

None of it was visible the day before. It was sitting in JSONL files on my disk the whole time, unread.

That gap — between how much your AI coding agent is doing and what you can actually see of it — is why I built Aura.

Aura is a local-first analytics platform for AI-coding-agent sessions. It watches your transcripts, transforms them with dbt, and surfaces the things the monthly invoice never tells you:

– Which project actually burned the budget (down to the individual prompt)
– Overkill detection: fixed a typo with Opus? It gets flagged
– Real attribution: when your main agent delegates, the subagent shows up as its own row, not a faceless "claude"
– A pipeline-health tab, so you always know whether the numbers are live or stale

Everything runs in Docker on your own machine. No data leaves your laptop. It's MIT-licensed and open.

The design constraint is the tagline: spend, with receipts. Every dollar traces back to the prompt, the model call, and the file edit that produced it — and every page reconciles to the same total.

It reads Claude Code today; Gemini and Codex adapters are next.

Point it at your own transcripts and see what a month of your agent usage actually looks like. I suspect, like me, you'll be surprised by at least one number.

→ Repo: github.com/darshanmeel/AURA
→ Full write-up (how it works, screenshots): https://blogs.crosshire.ch/blogs/aura-spend-with-receipts

#AICoding #DataEngineering #DeveloperTools

---

## Shorter variant (if you want a tighter post)

I ran one query against a month of my own Claude Code transcripts and learned I'd spent $2,666 in 30 days — with one agent quietly eating two-thirds of it. None of it was visible the day before.

So I built Aura: a local-first analytics platform for AI-coding-agent sessions. It reads the JSONL transcripts your agents already write, transforms them with dbt, and shows you cost, attribution, and overkill — down to the individual prompt. Everything runs in Docker on your machine; nothing leaves your laptop. MIT-licensed.

Spend, with receipts.

→ github.com/darshanmeel/AURA
→ https://blogs.crosshire.ch/blogs/aura-spend-with-receipts

#AICoding #DataEngineering #DeveloperTools
