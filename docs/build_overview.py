"""Builds docs/overview.html (self-contained). Run: python docs/build_overview.py"""
from pathlib import Path

ARROW = '<defs><marker id="h" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#17191D"/></marker><marker id="hg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8A8F98"/></marker></defs>'


def line(pts, dashed=False, grey=False):
    p = " ".join(f"{x},{y}" for x, y in pts)
    col = "#8A8F98" if grey else "#17191D"
    da = ' stroke-dasharray="5 4"' if dashed else ""
    m = "hg" if grey else "h"
    return f'<polyline points="{p}" fill="none" stroke="{col}" stroke-width="1.5" stroke-linejoin="round"{da} marker-end="url(#{m})"/>'


def box(cls, x, y, w, h, tag, title, sub="", extra=""):
    t = f'<span class="tag">{tag}</span>' if tag else ""
    s = f'<span class="sub">{sub}</span>' if sub else ""
    return f'<div class="b c {cls}" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px">{t}<span class="t">{title}</span>{s}{extra}</div>'


def num(x, y, n):
    return f'<span class="num" style="left:{x}px;top:{y}px">{n}</span>'


def lbl(x, y, text, left=False):
    c = " l" if left else ""
    return f'<span class="lbl{c}" style="left:{x}px;top:{y}px">{text}</span>'


# ---------------- D1 ----------------
def d1():
    W, H = 960, 330
    a = []
    a.append(line([(170, 68), (230, 68)]))  # 1
    a.append(line([(410, 68), (470, 68)], True))  # 2
    a.append(line([(660, 68), (720, 68)], True))  # 3
    a.append(line([(830, 126), (830, 196)]))  # 4
    a.append(line([(720, 250), (660, 250)]))  # 5
    a.append(line([(95, 96), (95, 150), (690, 150), (690, 218), (720, 218)]))  # 6
    a.append(line([(170, 234), (230, 234)], True, True))  # 7
    b = [
        box("actor", 20, 40, 150, 56, "", "Developer", "runs coding sessions"),
        box("", 230, 30, 180, 76, "", "Claude Code", "AI coding assistant"),
        box("data", 470, 30, 190, 76, "DATA", "Session log files", "one line per event, on your disk"),
        f'<div class="b c entry" style="left:720px;top:30px;width:220px;height:96px"><span class="t">Aura</span><span class="sub">collects · prices · summarises</span><span class="sub">two Docker containers, your computer</span></div>',
        box("", 720, 196, 220, 76, "", "Dashboard", "web page at localhost:3000"),
        box("shape", 230, 196, 430, 76, "", "Answers", "spend · sessions · agents · apps · people · errors · tokens"),
        box("actor todo", 20, 206, 150, 56, "", "Team lead", "team view: designed, not built"),
    ]
    l = [
        lbl(200, 14, "asks for work"), lbl(440, 14, "writes every event"), lbl(690, 14, "checked every 10 s"),
        lbl(905, 161, "priced totals"), lbl(690, 268, "shows"), lbl(470, 150, "opens dashboard"),
        lbl(200, 292, "future: team totals"),
        num(200, 68, 1), num(440, 68, 2), num(690, 68, 3), num(830, 161, 4), num(690, 250, 5), num(380, 150, 6), num(200, 234, 7),
    ]
    return (f'<!--map:overview--><div class="map-wrap"><div class="map" style="width:{W}px;height:{H}px">'
            f'<svg width="{W}" height="{H}" aria-hidden="true">{ARROW}{"".join(a)}</svg>{"".join(b)}{"".join(l)}</div></div><!--/map:overview-->')


# ---------------- D2 ----------------
def d2():
    W, H = 960, 500
    lanes = ["YOU", "CLAUDE CODE", "AURA · COLLECTOR", "AURA · SUMMARISER", "DASHBOARD"]
    ys = [0, 100, 200, 300, 400]
    xs = [150, 310, 470, 630, 790]
    steps = [
        ("Run a session", "your request", "replies, tool use"),
        ("Write log line", "each event", "1 line per event"),
        ("Pick up new lines", "new lines only", "stored, secrets blanked"),
        ("Price and total", "tokens + price list", "cost per reply, per day"),
        ("Show on reload", "latest read copy", "$ on screen"),
    ]
    BW, BH = 150, 94
    out = []
    for lab, y in zip(lanes, ys):
        out.append(f'<div class="lane" style="top:{y}px;height:100px;width:{W}px"><span>{lab}</span></div>')
    out.append('<div class="grp" style="left:400px;top:300px;width:390px;height:100px"><span style="width:200px;line-height:1.35">REPEATS: RUN ~20 MIN, THEN 25 MIN PAUSE</span></div>')
    arrows = []
    labels = ["instant", "checked every 10 s", "next run: up to 25 min", "read copy: up to 10 min"]
    dashed = [False, True, True, True]
    lbls = []
    for i in range(4):
        x1, y1 = xs[i] + BW, ys[i] + 3 + 40
        x2, y2 = xs[i + 1] + 75, ys[i + 1] + 3
        arrows.append(line([(x1, y1), (x2, y1), (x2, y2)], dashed[i]))
        lbls.append(lbl(x1 + 6, y1 - 11, labels[i], True))
    boxes = []
    for i, (t, i_, o_) in enumerate(steps):
        boxes.append(
            f'<div class="b" style="left:{xs[i]}px;top:{ys[i]+3}px;width:{BW}px;height:{BH}px">'
            f'<span class="tag">STEP {i+1}</span><span class="t">{t}</span>'
            f'<div class="io"><span class="l in">IN</span><span>{i_}</span><span class="l out">OUT</span><span>{o_}</span></div></div>')
    return (f'<!--map:journey--><div class="map-wrap"><div class="map" style="width:{W}px;height:{H}px">{"".join(out)}'
            f'<svg width="{W}" height="{H}" aria-hidden="true">{ARROW}{"".join(arrows)}</svg>{"".join(boxes)}{"".join(lbls)}</div></div><!--/map:journey-->')


CSS = """
:root { --ground:#F6F6F3; --card:#FFFFFF; --line:#D9DBDF; --ink:#17191D; --muted:#5B6068; --soft:#EEEFEC;
        --teal:#DDF0EE; --teal-ink:#1C5C57; --amber:#FCEBC8; --amber-ink:#8A5A00; --green:#1E6B43; --blue:#1F5FA8;
        --lav:#E7E2F5; --lav-ink:#6B4FA8; --red:#A12D2D; }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; background:var(--ground); color:var(--ink); font:15px/1.55 "IBM Plex Sans","Segoe UI",Arial,sans-serif; }
main { max-width:1100px; margin:0 auto; padding:32px 16px 56px; }
section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:20px 24px; margin:18px 0; }
h1 { font-size:28px; font-weight:600; margin:4px 0 6px; } h2 { font-size:20px; font-weight:600; margin:0 0 8px; }
h3 { font-size:15px; margin:14px 0 4px; }
ul { margin:6px 0; padding-left:22px; } li { margin:3px 0; }
code, pre, .mono, .key, .cap, th, .eyebrow, .toc, .chip { font-family:"IBM Plex Mono",Consolas,monospace; }
code { font-size:13px; background:var(--soft); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
a { color:var(--blue); }
.eyebrow { font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.sub1 { color:var(--muted); margin:0 0 6px; }
.tagline { display:inline-block; font:12px "IBM Plex Mono",Consolas,monospace; border:1px solid var(--line); border-radius:4px; padding:1px 8px; background:var(--card); }
.toc { font-size:12px; margin:10px 0 0; } .toc a { margin-right:10px; white-space:nowrap; }
.key, .cap { font-size:12px; color:var(--muted); margin:8px 0 0; } .cap { color:var(--ink); }
.src { font:11px/1.4 "IBM Plex Mono",Consolas,monospace; color:var(--muted); margin:6px 0 0; overflow-wrap:anywhere; }
table { width:100%; border-collapse:collapse; margin:10px 0; font-size:14px; }
th, td { text-align:left; vertical-align:top; padding:7px 10px; border:1px solid var(--line); }
th { font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); background:var(--soft); }
/* tabs */
.tabs { background:var(--card); border:1px solid var(--line); border-radius:8px; margin:18px 0; padding:0 0 4px; }
.tabs > input { position:absolute; opacity:0; pointer-events:none; }
.tabbar { display:flex; flex-wrap:wrap; border-bottom:1px solid var(--line); background:var(--soft); border-radius:8px 8px 0 0; }
.tabbar label { padding:9px 18px; font:500 13px "IBM Plex Mono",Consolas,monospace; color:var(--muted); cursor:pointer; border-right:1px solid var(--line); }
.tabs > input:focus-visible ~ .tabbar label { outline:none; }
#t-does:checked ~ .tabbar label[for=t-does], #t-doesnt:checked ~ .tabbar label[for=t-doesnt],
#t-limits:checked ~ .tabbar label[for=t-limits], #t-issues:checked ~ .tabbar label[for=t-issues] { background:var(--card); color:var(--ink); box-shadow:inset 0 -2px 0 var(--ink); }
#t-does:focus-visible ~ .tabbar label[for=t-does], #t-doesnt:focus-visible ~ .tabbar label[for=t-doesnt],
#t-limits:focus-visible ~ .tabbar label[for=t-limits], #t-issues:focus-visible ~ .tabbar label[for=t-issues] { outline:2px solid var(--blue); outline-offset:-2px; }
.panel { display:none; padding:6px 22px 8px; }
.panel h3 { display:none; }
#t-does:checked ~ .panels .p-does, #t-doesnt:checked ~ .panels .p-doesnt,
#t-limits:checked ~ .panels .p-limits, #t-issues:checked ~ .panels .p-issues { display:block; }
.chip { display:inline-block; font-size:10.5px; font-weight:600; letter-spacing:.04em; border-radius:4px; padding:0 6px; margin-left:6px; white-space:nowrap; vertical-align:1px; }
.chip.c { background:var(--ink); color:#fff; border:1px solid var(--ink); }
.chip.nv { background:var(--card); color:var(--muted); border:1px dashed #8A8F98; }
ol.top { padding-left:22px; } ol.top li { margin:4px 0; }
/* map */
.map-wrap { overflow-x:auto; margin-top:10px; }
.map { position:relative; margin:0 auto; font-size:13px; line-height:1.35; }
.map svg { position:absolute; left:0; top:0; overflow:visible; }
.map .b { position:absolute; background:var(--card); border:1px solid var(--ink); border-radius:8px; padding:5px 8px; }
.map .b.data { background:var(--soft); border-color:#B9BCC2; }
.map .b.shape { background:var(--amber); border-color:var(--amber-ink); }
.map .b .t { display:block; font-weight:600; }
.map .b .tag { display:block; font:10px "IBM Plex Mono",Consolas,monospace; letter-spacing:.08em; color:var(--muted); }
.map .b.c { display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; }
.map .b.c .sub { font-size:12px; color:var(--muted); }
.map .b.actor { border-radius:999px; } .map .b.entry { border-width:2px; }
.map .b.todo { border:1px dashed #8A8F98; background:var(--ground); }
.map .num { position:absolute; width:20px; height:20px; border-radius:50%; background:var(--ink); color:#fff; font:600 11px/20px "IBM Plex Mono",Consolas,monospace; text-align:center; transform:translate(-50%,-50%); }
.map .lbl { position:absolute; font:12px "IBM Plex Mono",Consolas,monospace; color:var(--muted); white-space:nowrap; transform:translate(-50%,-50%); background:var(--card); padding:0 4px; }
.map .lbl.l { transform:translate(0,-50%); padding:0; }
.map .lane { position:absolute; left:0; background:var(--soft); border-top:1px solid var(--card); }
.map .lane span { position:absolute; left:10px; top:8px; width:120px; font:11px/1.3 "IBM Plex Mono",Consolas,monospace; letter-spacing:.06em; color:var(--muted); }
.map .grp { position:absolute; border:1px dashed var(--lav-ink); border-radius:10px; }
.map .grp span { position:absolute; left:10px; top:8px; font:11px "IBM Plex Mono",Consolas,monospace; letter-spacing:.04em; color:var(--lav-ink); }
.map .b .t { font-size:12.5px; }
.io { display:grid; grid-template-columns:28px 1fr; gap:2px 6px; font-size:11px; border-top:1px dashed rgba(23,25,29,.25); padding-top:3px; margin-top:3px; text-align:left; line-height:1.25; }
.io .l { font:600 9.5px/15px "IBM Plex Mono",Consolas,monospace; letter-spacing:.04em; border-radius:3px; text-align:center; height:15px; }
.io .l.in { background:var(--card); border:1px solid var(--blue); color:var(--blue); }
.io .l.out { background:var(--green); color:#fff; }
/* step table */
.steps td:first-child { width:34px; text-align:center; }
.steps .n { display:inline-block; width:20px; height:20px; border-radius:50%; background:var(--ink); color:#fff; font:600 11px/20px "IBM Plex Mono",Consolas,monospace; text-align:center; }
/* examples */
.exset { display:grid; grid-template-columns:repeat(auto-fit,minmax(420px,1fr)); gap:12px; margin-top:10px; }
.ex { border:1px solid var(--line); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; background:var(--card); }
.ex .h { padding:6px 10px; background:var(--soft); border-bottom:1px solid var(--line); }
.ex .h b { display:block; font-size:13px; }
.ex .verdict { font:600 10px "IBM Plex Mono",Consolas,monospace; letter-spacing:.06em; }
.ex.ok .verdict { color:var(--green); } .ex.bad .verdict { color:var(--red); }
.ex.ok { border-top:3px solid var(--green); } .ex.bad { border-top:3px solid var(--red); }
.ex .lbl2 { font:600 10px "IBM Plex Mono",Consolas,monospace; letter-spacing:.06em; color:var(--muted); padding:6px 10px 0; }
.ex table { margin:2px 0 0; font-size:12px; }
.ex td { border:0; border-bottom:1px solid var(--line); padding:3px 10px; font-family:"IBM Plex Mono",Consolas,monospace; overflow-wrap:anywhere; }
.ex td:first-child { color:var(--muted); font-size:11px; width:38%; }
.ex .res { padding:4px 10px 10px; font-size:12.5px; }
.ex .wk { padding:4px 10px; font:11.5px "IBM Plex Mono",Consolas,monospace; color:var(--muted); overflow-wrap:anywhere; }
.ex.wide { margin-top:10px; } .ex.wide .cols { display:grid; grid-template-columns:1fr 1fr; }
/* tiles */
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-top:10px; }
.tile { border:1px solid var(--line); border-radius:8px; padding:12px 14px; background:var(--card); }
.tile b { display:block; font-size:26px; font-weight:600; line-height:1.2; }
.tile span { font:12px "IBM Plex Mono",Consolas,monospace; color:var(--muted); }
@media (max-width:700px) { .ex.wide .cols { grid-template-columns:1fr; } section { padding:16px; } }
@media print {
  body { background:#fff; } main { padding:0; max-width:none; }
  section, .tabs { border:0; padding:0; break-inside:avoid-page; }
  .tabbar, .tabs > input { display:none; }
  .panel { display:block !important; padding:0 0 6px; } .panel h3 { display:block; }
  .toc { display:none; }
}
"""


def tbl(head, rows, cls=""):
    h = "".join(f"<th>{c}</th>" for c in head)
    r = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows)
    return f'<table class="{cls}"><tr>{h}</tr>{r}</table>'


def ul(items):
    return "<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>"


C = '<span class="chip c">Confirmed</span>'
NV = '<span class="chip nv">Not verified</span>'


def src(t):
    return f'<p class="src">{t}</p>'


def kv(rows):
    return "<table>" + "".join(f"<tr><td>{a}</td><td>{b}</td></tr>" for a, b in rows) + "</table>"


def card(cls, verdict, title, inrows, outrows, extra="", source=""):
    return (f'<div class="ex {cls}"><div class="h"><span class="verdict">{verdict}</span><b>{title}</b></div>'
            f'<div class="lbl2">IN</div>{kv(inrows)}{extra}<div class="lbl2">OUT</div>{kv(outrows)}'
            f'<div class="src" style="padding:0 10px 8px">{source}</div></div>')


def build():
    tabs = f"""
<div class="tabs">
<input type="radio" name="tabs" id="t-does" checked><input type="radio" name="tabs" id="t-doesnt"><input type="radio" name="tabs" id="t-limits"><input type="radio" name="tabs" id="t-issues">
<div class="tabbar"><label for="t-does">Does</label><label for="t-doesnt">Doesn't</label><label for="t-limits">Limitations</label><label for="t-issues">Top issues</label></div>
<div class="panels">
<div class="panel p-does"><h3>Does</h3>{ul([
 "Shows AI coding spend per day, session, project, helper agent and person.",
 "Replays any past session: each prompt, reply, tool use and file touched.",
 "Flags waste: big models on small jobs, failed tool runs, cut-off replies.",
 "Keeps session data on your computer; blanks passwords and keys before storing.",
 "Shows whether the numbers are current, on a pipeline-health page."])}
{src("from README.md:3,18-24 · watcher/src/aura_watcher/redact.py:58-67 · docker-compose.yml:52")}</div>
<div class="panel p-doesnt"><h3>Doesn't</h3>{ul([
 "Doesn't read your provider's bill; costs are estimates from token counts.",
 "Doesn't change or delete your session logs; it only reads them.",
 "Doesn't cover other assistants yet; Gemini and Codex are planned.",
 "Doesn't give a team-wide view; designed, not built (no central store, no sign-in).",
 "Doesn't upload session data anywhere."])}
{src("from dbt/models/marts/fact_model_calls.sql:47-59 · docker-compose.yml:9 · README.md:3,452,489-492")}</div>
<div class="panel p-limits"><h3>Limitations</h3>{ul([
 "Not real-time: new spend appears about 20–75 minutes after it happens.",
 "Pages don't refresh themselves; reload to see new numbers (health page: every 10 s).",
 "A new model shows no cost until someone adds it to the price list.",
 'Opens on "Today"; a day with no sessions shows $0 — pick 7 days, 30 days or All time.',
 "Needs room for two Docker containers: up to 5 GB and 512 MB memory."])}
{src("derived from docker-compose.yml:26-36 and watcher/src/aura_watcher/main.py:521-546,731-732 · frontend/lib/range.ts:3-7 · dbt/seeds/model_pricing.csv:1-12 · docker-compose.yml:109,135 · README.md:98")}</div>
<div class="panel p-issues"><h3>Top issues</h3><ol class="top">
<li>Per-app spend is overstated, about 6 times in the measured copy. {C}</li>
<li>The "All time" 30-day spend forecast is about 6 times too high. {C}</li>
<li>Per-agent spend differs between "All time" and date-range views. {C}</li>
<li>Some secret formats, and all session titles, are stored without blanking. {C}</li>
<li>The dashboard is open to anyone on the same network, with no sign-in. {C}</li>
<li>The health page can say "All systems nominal" while summaries are stale. {C}</li>
<li>Saving a "was this session worth it" verdict fails in the Docker setup. {C}</li>
<li>Costs of older sessions may be slightly overstated. {NV}</li>
<li>An event being written at the moment Aura reads may be lost. {NV}</li></ol>
<p class="key">Details: <a href="#issues">Known issues, assumptions, and decisions needed</a></p></div>
</div></div>"""

    glance = f"""<section id="glance"><h2>Aura at a glance</h2>
{d1()}
<p class="key">Key: pill = person · white box = system · grey = data · amber = what you get · dashed grey = not built yet · solid arrow = uses · dashed arrow = data moves · numbers = order</p>
<p class="cap">Notice: everything runs on one computer; session data is never uploaded.</p>
{src("from README.md:3,7,139 · docker-compose.yml:9,120 · watcher/src/aura_watcher/main.py:1181")}
{ul(["Aura reads Claude Code's session log files and builds a cost dashboard.",
 "It prices every model reply from its token counts and a local price list.",
 "It runs on your own computer, in two Docker containers.",
 "Passwords and keys in sessions are blanked before anything is stored.",
 "Today it reads Claude Code only."])}
{src("from README.md:3 · dbt/models/marts/fact_model_calls.sql:47-59 · docker-compose.yml:1,120 · watcher/src/aura_watcher/redact.py:58-67")}
<div class="ex ok wide"><div class="h"><span class="verdict">REAL SCENARIO</span><b>A morning session</b></div>
<div class="cols"><div><div class="lbl2">IN</div>{kv([("session ends","10:00"),("replies in session","40 (illustrative count)")])}</div>
<div><div class="lbl2">OUT</div>{kv([("cost on dashboard","between about 10:20 and 11:15"),("how","reload the page; pick \"Today\"")])}</div></div>
<div class="src" style="padding:0 10px 8px">derived from docker-compose.yml:26-36 · watcher/src/aura_watcher/main.py:521-546,731-732 (timing in "From session to dashboard")</div></div>
</section>"""

    who = f"""<section id="who"><h2>Who uses it and why</h2>
{ul(["Built for one developer first; a team view is designed but not built."])}
{tbl(["Who","Uses it for","Status"],[
 ["Individual developer","Own spend, habits, errors; replay of past sessions","Works today"],
 ["Same developer, as operator","Checks data is current on the pipeline-health page","Works today"],
 ["Team lead / manager","Spend per person, project and agent across a team","Designed, not built: needs exporter, central store, sign-in"]])}
{src("from README.md:7,98,446-452")}
<h3>Why it exists</h3>
{ul(["Session logs record every prompt, reply, token count and error; nobody reads them.",
 "The provider bill is one monthly number, with no project or agent breakdown.",
 "Once a session scrolls away, its reasoning and cost are hard to find."])}
{src("from docs/blog/introducing-aura.md:21-38 · README.md:16-28")}</section>"""

    answers = f"""<section id="answers"><h2>Questions it answers</h2>
{ul(['Every page has one date range: Today (default), 7 days, 30 days, All time.'])}
{tbl(["Question","Dashboard page","What you get"],[
 ["How much did I spend, and how fast?","Dashboard (home)","Daily spend, spend pace, 30-day projection"],
 ["Which sessions cost the most?","Sessions","Each session with title, model, turns, cost, person"],
 ["What happened in one session?","Session detail","Each reply in order, with tools, files, errors, cost"],
 ["Which agents cost most?","Agents","Spend and sessions for the main assistant and each helper"],
 ["Which apps or projects cost most?","Apps","Spend, sessions, commits per app"],
 ["Who is spending?","People","Spend and share of total per person"],
 ["What is failing?","Errors","Failed tool runs, cut-off replies, refusals"],
 ["Was a big model used for a small job?","Session and person prompt lists",'"Overkill" flag on prompts'],
 ["Are the numbers current?","Observability","Last data received, last summary run, test results"]])}
{src("from frontend/lib/range.ts:1-7 · README.md:84-98 · dbt/models/marts/fact_prompts.sql (overkill scoring) · dbt/models/marts/fact_errors.sql")}</section>"""

    scen = f"""<section id="scenario"><h2>From session to dashboard</h2>
{ul(["With shipped settings, a reply's cost reaches the dashboard in about 20–75 minutes.",
 "Collecting takes seconds; the wait is the summary timer and the read copy."])}
{d2()}
<p class="key">Key: grey band = who does it · numbered box = step · solid = then · dashed = data moves · purple dashed = repeats on a timer</p>
<p class="cap">Notice: while a summary runs, collecting waits; the two never write at once.</p>
{src("from watcher/src/aura_watcher/main.py:1181 (10 s), main.py:521-546 (read copy), main.py:549-732 (summary loop), docker-compose.yml:26 (copy every 600 s), docker-compose.yml:27-36 (run ~20 min, 25 min pause)")}
<table class="steps"><tr><th>#</th><th>Step</th><th>In</th><th>Out</th><th>Time</th></tr>
<tr><td><span class="n">1</span></td><td>You run a Claude Code session</td><td>your request</td><td>replies, tool use</td><td>length of the session</td></tr>
<tr><td><span class="n">2</span></td><td>Claude Code writes the session log</td><td>each event</td><td>one line per event in <code>&lt;user-home&gt;/.claude/projects</code></td><td>instant</td></tr>
<tr><td><span class="n">3</span></td><td>Collector reads only new lines, blanks secrets, stores them</td><td>new lines</td><td>stored events; re-reads never double count</td><td>checked every 10 s; waits while a summary runs</td></tr>
<tr><td><span class="n">4</span></td><td>Summariser prices each reply and builds totals</td><td>token counts × price list</td><td>cost per reply, session, day, app, agent, person</td><td>run ~20 min, then 25 min pause</td></tr>
<tr><td><span class="n">5</span></td><td>Aura publishes a read copy; you reload the page</td><td>latest copy</td><td>dollar figures on screen</td><td>every 10 min, waiting out a running summary</td></tr></table>
<p class="src">derived: fastest ≈ 20 min (event lands just before a run) · slowest ≈ 20 min run in progress + 25 min pause + 20 min run + up to 10 min copy ≈ 75 min · from docker-compose.yml:26-36, watcher/src/aura_watcher/main.py:521-546,731-732</p>
<h3>Examples</h3>
<div class="exset">
{card("ok","TYPICAL","One reply priced",
 [("model","claude-sonnet-5"),("new input tokens","1,000"),("output tokens","2,000"),("cache write, 5 min","20,000"),("cache read","50,000")],
 [("reply cost","$0.123"),("shown as","$0.123")],
 '<div class="wk">cost = Σ tokens × price per million ÷ 1,000,000</div><div class="wk">1,000×$3 + 2,000×$15 + 20,000×$3.75 + 50,000×$0.30 = $123,000 per million</div>',
 "derived from dbt/models/marts/fact_model_calls.sql:47-59 · prices dbt/seeds/model_pricing.csv:5 · display frontend/lib/fmt.ts:13-19")}
{card("ok","EDGE CASE","A key pasted into a session",
 [("text","config: api_key=abcd1234567890abcdef"),("short value","token=shortval")],
 [("stored text","config: «REDACTED»"),("key name kept?","no — whole match replaced"),("short value","kept as is (under 16 characters)")],
 "", "from watcher/tests/test_redact.py:6-13,41-45 · watcher/src/aura_watcher/redact.py:58-67 (synthetic test value)")}
{card("ok","EDGE CASE","The same file read twice",
 [("pass 1","2 lines in file"),("pass 2","2 more lines appended")],
 [("stored after pass 1","2 events"),("stored after pass 2","4 events, no duplicates"),("bookmark","moves forward each pass")],
 "", "from watcher/tests/test_main.py:122-182")}
{card("bad","REJECTED","Model not in the price list",
 [("model","a new model id not in the list"),("price row","none")],
 [("reply cost","not priced"),("price check","fails, names the missing model"),("health page",'"unknown model" error listed')],
 '<div class="res">Add the model\'s row to the price list; the next run prices it.</div>',
 "from dbt/tests/fact_model_calls_unknown_model_pricing.sql:1-17 · dbt/models/marts/fact_model_calls.sql:48,64-70 · watcher/src/aura_watcher/main.py:557-568")}
</div></section>"""

    month = f"""<section id="month"><h2>What one month looked like</h2>
{ul(["The author's own 30 days, as reported in the launch blog (May 2026)."])}
<div class="tiles"><div class="tile"><b>$2,666</b><span>spend in 30 days</span></div><div class="tile"><b>32,600</b><span>tool calls</span></div><div class="tile"><b>1,072</b><span>commits</span></div><div class="tile"><b>97%</b><span>cache-hit rate</span></div></div>
{ul(["One agent accounted for about two-thirds of the bill."])}
{src("from docs/blog/introducing-aura.md:3,7-10")}</section>"""

    costs = f"""<section id="costs"><h2>What it costs to run</h2>
{ul(["No licence or cloud cost; it uses your computer's memory and disk."])}
{tbl(["Item","What it means","Source"],[
 ["Software","Free, MIT licence","<code>README.md:510-512</code>"],
 ["Where it runs","Two Docker containers: collector/summariser and dashboard","<code>docker-compose.yml:1,120</code>"],
 ["Memory","Up to 5 GB (collector/summariser) and 512 MB (dashboard)","<code>docker-compose.yml:109,135</code>"],
 ["Disk","One database file of several GB, plus a full read copy","<code>docker-compose.yml:12-25</code>"],
 ["Price list upkeep","10 models priced (plus one zero-cost placeholder); new models added by hand","<code>dbt/seeds/model_pricing.csv:1-12</code>"],
 ["How cost is worked out","Token counts × price list; not your provider's bill","<code>dbt/models/marts/fact_model_calls.sql:47-59</code>"],
 ["Privacy setting","Secret blanking on by default; full-text hashing optional, off by default","<code>docker-compose.yml:52,63</code>"],
 ["Hashing trade-off","When on, session replay is unavailable for those sessions","<code>README.md:477</code>"]])}
</section>"""

    risks = f"""<section id="risks"><h2>Design and operational risks</h2>
{ul(["Three design risks; none are defects."])}
{tbl(["Risk","What it means","How it is handled"],[
 ["One computer, one database writer","Summaries and collecting take turns; long summaries delay new data","Summary pause set above run time (25 min)"],
 ["Cost is an estimate","Figures depend on a hand-kept price list, not the real bill","A check fails when a model has no price"],
 ["Data grows with history","Database is several GB; each read copy duplicates it","Read copy every 10 min; memory ceiling 5 GB"]])}
{src("from docker-compose.yml:12-36,103-109 · dbt/tests/fact_model_calls_unknown_model_pricing.sql:1-4 · watcher/src/aura_watcher/main.py:421-490")}</section>"""

    terms = f"""<section id="terms"><h2>Terms</h2>
{tbl(["Term","Meaning"],[
 ["Session","One Claude Code conversation, first prompt to last reply"],
 ["Token","A small chunk of text; models charge per million tokens"],
 ["Cache read / write","Reused context billed cheaply / context saved for reuse, billed once"],
 ["Agent","The main assistant (<code>main</code>) or a helper it hands a task to"],
 ["App","The project folder you worked in, read from its path"],
 ["Person",'Who ran the session: a configured name, default "Local User"'],
 ["Price list","Local table of prices per million tokens, per model"],
 ["Read copy","A copy of the database the dashboard reads, refreshed every 10 min"]])}
{src("from dbt/models/intermediate/int_event_agent.sql:27 · dbt/models/marts/dim_apps.sql:21,41-52 · docker-compose.yml:26,67-73 · dbt/seeds/model_pricing.csv:1")}</section>"""

    issues = f"""<section id="issues"><h2>Known issues, assumptions, and decisions needed</h2>
{ul(["Total spend matches the sum of every priced reply; splits and forecasts below do not."])}
<h3>Known issues</h3>
<ul>
<li>App and agent cost splits, and the "All time" forecast, are wrong. Apps add up to about 6× real spend; the Apps page total about 2×; forecast about 6×; agent figures change with the date range. Use total and per-session spend for budgets. {C}</li>
<li>Privacy gaps: some secret formats (cloud keys, bearer tokens, passwords in web addresses) and session titles are stored unblanked; the dashboard is reachable from the local network without sign-in. {C}</li>
<li>Some screens mislead: the health page can say "All systems nominal" with stale summaries; saving a session verdict fails in the Docker setup; the Errors date range has no effect. {C}</li>
<li>Costs of older sessions may be slightly high: cache writes without a breakdown are priced at the higher 1-hour rate. {NV}</li>
<li>An event being written exactly when Aura reads the file may be skipped for good. {NV}</li></ul>
<h3>Assumptions</h3>
<ul>
<li>Issue sizes come from a 2026-08-21 copy of real data; today's sizes may differ. {NV}</li>
<li>The 20–75 minute delay assumes a summary run of about 20 minutes, as noted in settings. {NV}</li></ul>
<h3>Decisions needed</h3>
<ul>
<li><b>Agent cost rule:</b> per reply or per session; recommend per reply; until decided, agent figures differ between "All time" and date ranges.</li>
<li><b>Dashboard access:</b> this computer only or whole local network; recommend this computer only; until decided, anyone on the same Wi-Fi can read all sessions.</li></ul>
{src("from the 2026-11-10 code review")}</section>"""

    head = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="darshan-singh-meel-docs">
<title>Aura — Overview</title><style>{CSS}</style></head><body><main>
<header id="top"><div class="eyebrow">OVERVIEW · AURA</div><h1>Aura</h1>
<p class="sub1">Shows what your AI coding assistant costs and does — on your own computer.</p>
<span class="tagline">"Spend, with receipts."</span> <span class="src">from README.md:5</span>
<p class="toc"><a href="#glance">At a glance</a><a href="#who">Who</a><a href="#answers">Questions</a><a href="#scenario">Session to dashboard</a><a href="#month">One month</a><a href="#costs">Costs</a><a href="#risks">Risks</a><a href="#terms">Terms</a><a href="#issues">Known issues</a></p></header>"""
    html = head + tabs + glance + who + answers + scen + month + costs + risks + terms + issues + "</main></body></html>\n"
    Path(__file__).with_name("overview.html").write_text(html, encoding="utf-8")


build()
