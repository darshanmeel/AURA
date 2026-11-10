#!/usr/bin/env python3
"""Builds docs/technical.html (self-contained). Run from the repo root: python docs/build_technical.py
Diagrams are generated here and injected between <!--map:NAME--> ... <!--/map:NAME-->.
Lineage uses Graphviz `dot` (temp files are deleted)."""
import csv, html, math, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "technical.html"
EXAMPLE = Path.home() / ".claude/skills/darshan-singh-meel-docs/references/example-components.html"

INK, MUTED, LINE, RED, GREEN, BLUE = "#17191D", "#5B6068", "#D9DBDF", "#A12D2D", "#1E6B43", "#1F5FA8"
MONO = "'IBM Plex Mono',Consolas,monospace"


# ---------------------------------------------------------------- text helpers
def esc(s):
    return html.escape(str(s), quote=False)


def md(s):
    """escape, then `x` -> <code>x</code>"""
    return re.sub(r"`([^`]+)`", lambda m: "<code>%s</code>" % m.group(1), esc(s))


class Raw(str):
    """pre-built HTML, not escaped"""


def cell(c):
    return str(c) if isinstance(c, Raw) else md(c)


def table(head, rows, cls="", mono=()):
    h = "".join("<th>%s</th>" % esc(x) for x in head)
    body = ""
    for r in rows:
        body += "<tr>" + "".join(
            '<td data-l="%s"%s>%s</td>' % (esc(head[i]), ' class="v"' if i in mono else "", cell(c)) for i, c in enumerate(r)) + "</tr>"
    return '<table class="%s"><thead><tr>%s</tr></thead><tbody>%s</tbody></table>' % (cls, h, body)


def ul(items):
    return "<ul>" + "".join("<li>%s</li>" % cell(i) for i in items) + "</ul>"


def cite(s):
    return '<p class="cite">%s</p>' % md(s)


def key(s):
    return '<p class="key">Key: %s</p>' % md(s)


def notice(s):
    return '<p class="cap">Notice: %s</p>' % md(s)


def hl_sql(t):
    t = esc(t)
    t = re.sub(r"\b(CASE|WHEN|THEN|ELSE|END|AND|OR|IS|NULL|LEFT JOIN|ON|QUALIFY|OVER|PARTITION BY|ORDER BY|SELECT|FROM|WHERE|GROUP BY|COALESCE|CAST|AS|ROW_NUMBER|count|now|INTERVAL|max|FILTER)\b",
               r'<span class="tk">\1</span>', t)
    t = re.sub(r"(&#x27;[^&]*?&#x27;|'[^']*')", r'<span class="ts">\1</span>', t)
    return t


def payload(direction, label, text, lang=""):
    body = hl_sql(text) if lang == "sql" else esc(text)
    return ('<div class="payload"><div class="h"><span class="dir %s">%s</span><span>%s</span></div><pre>%s</pre></div>'
            % (direction.lower(), direction, md(label), body))


def ex(kind, verdict, title, ins, out, src):
    rows = "".join("<tr><td>%s</td><td>%s</td></tr>" % (esc(k), md(v)) for k, v in ins)
    return ('<div class="ex %s"><div class="h"><span class="verdict">%s</span><b>%s</b></div>'
            '<div class="lbl2">IN</div><table>%s</table><div class="lbl2">OUT</div><div class="res">%s</div>'
            '<div class="cite">%s</div></div>' % (kind, verdict, esc(title), rows, md(out), md(src)))


def exset(cards):
    return '<div class="exset">%s</div>' % "".join(cards)


def sec(sid, title, body):
    return '<section id="%s"><h2>%s</h2>%s</section>' % (sid, esc(title), body)


# ---------------------------------------------------------------- diagram canvas
def tw(s, size=12, mono=False):
    return len(s) * size * (0.62 if mono else 0.53)


def lines(s, avail, size=12, mono=False):
    return max(1, math.ceil(tw(s, size, mono) / max(avail, 20)))


class Cv:
    def __init__(self, name, w, h):
        self.name, self.w, self.h = name, w, h
        self.svg, self.div, self.under = [], [], []
        self.hov = []

    def _m(self, c):
        return {"k": INK, "r": RED, "g": "#9AA0A6", "b": BLUE}[c]

    def poly(self, pts, dash=False, c="k", width=1.5, head=True, tail=False, anim=True):
        p = " ".join("%g,%g" % xy for xy in pts)
        d = ' stroke-dasharray="5 4"' if dash else ""
        me = ' marker-end="url(#%s-h%s)"' % (self.name, c) if head else ""
        ms = ' marker-start="url(#%s-h%s)"' % (self.name, c) if tail else ""
        self.svg.append('<polyline class="%s" points="%s" fill="none" stroke="%s" stroke-width="%g" stroke-linejoin="round"%s%s%s/>'
                        % ("flow" if dash and anim and c != "r" else "", p, self._m(c), width, d, me, ms))

    def lbl(self, x, y, text, chip=False, align="c"):
        tr = "transform:translate(-50%,-50%)" if align == "c" else "transform:translate(0,-50%)"
        self.div.append('<span class="lbl%s" style="left:%gpx;top:%gpx;%s">%s</span>'
                        % (" chip" if chip else "", x, y, tr, esc(text)))

    def lblv(self, x, y, text):
        """stacked label lines centred above a horizontal line at y"""
        ls = text.split("|")
        for i, t in enumerate(ls):
            self.lbl(x, y - 22 - 14 * (len(ls) - 1 - i), t)

    def num(self, x, y, n):
        self.div.append('<span class="num" style="left:%gpx;top:%gpx">%s</span>' % (x, y, n))

    def frame(self, x, y, w, h, label, sub="", color="#9AA0A8", solid=False):
        st = "solid" if solid else "dashed"
        self.div.append('<div class="grp" style="left:%gpx;top:%gpx;width:%gpx;height:%gpx;border-style:%s;border-color:%s">'
                        '<span>%s</span></div>' % (x, y, w, h, st, color, esc(label)))
        for i, line in enumerate(filter(None, sub.split("|"))):
            self.div.append('<span class="lbl" style="left:%gpx;top:%gpx;transform:none;background:transparent;font-size:10.5px">%s</span>'
                            % (x + 10, y + 32 + 14 * i, esc(line)))

    def lane(self, x, w, label, h):
        self.under.append('<div class="lane" style="left:%gpx;top:0;width:%gpx;height:%gpx;border-left:1px solid #fff"><span>%s</span></div>'
                        % (x, w, h, esc(label)))

    def box(self, x, y, w, h, kind="", tag="", title="", sub="", bul=(), inn=None, out=None, cite_="", mono=None, bid=None):
        cls = "b " + kind
        t = ""
        if tag:
            t += '<span class="tag">%s</span>' % esc(tag)
        if title:
            st = ' style="font-family:%s;font-size:11.5px"' % MONO if mono else ""
            t += '<span class="t"%s>%s</span>' % (st, md(title).replace("|", "<br>"))
        if sub:
            t += '<span class="sub">%s</span>' % md(sub).replace("|", "<br>")
        if bul:
            t += "<ul>%s</ul>" % "".join("<li>%s</li>" % md(b) for b in bul)
        if inn is not None:
            t += ('<div class="io"><span class="l in">IN</span><span>%s</span><span class="l out">OUT</span><span>%s</span></div>'
                  % (md(inn), md(out)))
        if cite_:
            t += '<span class="tag" style="display:block;margin-top:3px">%s</span>' % md(cite_)
        self.div.append('<div class="%s" style="left:%gpx;top:%gpx;width:%gpx;height:%gpx">%s</div>' % (cls, x, y, w, h, t))

    def diamond(self, x, y, w, h, text, fill="#E7E2F5"):
        cx, cy = x + w / 2, y + h / 2
        self.svg.append('<polygon points="%g,%g %g,%g %g,%g %g,%g" fill="%s" stroke="#6B4FA8" stroke-width="1.2"/>'
                        % (cx, y, x + w, cy, cx, y + h, x, cy, fill))
        self.div.append('<div class="b c decision" style="left:%gpx;top:%gpx;width:%gpx;height:%gpx;padding:0 30px">%s</div>'
                        % (x, y, w, h, md(text)))

    def html(self, extra_style=""):
        defs = "".join('<marker id="%s-h%s" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
                       '<path d="M0,0 L10,5 L0,10 z" fill="%s"/></marker>' % (self.name, c, self._m(c)) for c in "krgb")
        return ('<!--map:%s--><div class="map-wrap"><div class="map hov" style="width:%dpx;height:%dpx"><svg width="%d" height="%d" aria-hidden="true">'
                '<defs>%s</defs>%s</svg>%s</div></div><!--/map:%s-->'
                % (self.name, self.w, self.h, self.w, self.h, defs, "".join(self.svg), "".join(self.div), self.name)).replace('<svg width', "".join(self.under) + '<svg width', 1)


# ---------------------------------------------------------------- swimlane layout (lanes = columns, rows = time)
def step_h(s, w):
    inner = w - 22
    h = 18
    if s.get("tag"):
        h += 14
    h += 17 * lines(re.sub("`", "", s.get("title", "")), inner, 12.5, True) if s.get("kind") == "routine" else \
        17 * lines(re.sub("`", "", s.get("title", "")), inner, 13)
    for b in s.get("bul", ()):
        h += 15 * lines(re.sub("`", "", b), inner - 16, 12) + 2
    if s.get("bul"):
        h += 8
    if s.get("inn") is not None:
        h += 12
        for v in (s["inn"], s["out"]):
            h += 15 * lines(re.sub("`", "", v), w - 22 - 40, 11, True) + 3
    if s.get("sub"):
        h += 15 * lines(s["sub"], inner, 11.5)
    if s.get("cite_"):
        h += 14
    return max(h + 22, s.get("minh", 0))


def swim(name, W, lane_names, steps, arrows, gap=48, top=34, boxw=None, minlane=0):
    """steps: dicts id,lane,row,kind,tag,title,bul,inn,out. kind 'dec' = diamond. arrows: dicts a,b,label,style,off,toff,ymid"""
    nl = len(lane_names)
    lw = W / nl
    bw = boxw or min(lw - 36, 290)
    S = {s["id"]: s for s in steps}
    rows = sorted({s["row"] for s in steps})
    for s in steps:
        s["w"] = bw if s["kind"] != "dec" else min(bw, 230)
        s["h"] = 76 if s["kind"] == "dec" else step_h(s, bw)
        s["gpad"] = 26 if s.get("grp") else 0
    rowh = {r: max(s["h"] + s["gpad"] for s in steps if s["row"] == r) for r in rows}
    rowy, y = {}, top
    for r in rows:
        rowy[r] = y
        y += rowh[r] + gap
    H = y - gap + 20
    cv = Cv(name, W, H)
    for i, ln in enumerate(lane_names):
        cv.lane(i * lw, lw, ln, H)
    for s in steps:
        s["x"] = s["lane"] * lw + (lw - s["w"]) / 2
        s["y"] = rowy[s["row"]] + s["gpad"]
        if s.get("grp"):
            cv.frame(s["x"] - 12, s["y"] - s["gpad"], s["w"] + 24, s["h"] + s["gpad"] + 10, s["grp"], color="#6B4FA8")
        if s["kind"] == "dec":
            cv.diamond(s["x"], s["y"], s["w"], s["h"], s["title"])
        else:
            cv.box(s["x"], s["y"], s["w"], s["h"], kind={"routine": "routine", "data": "data", "shape": "shape",
                   "fail": "fail", "step": "", "actor": "c actor", "entry": "routine entry"}[s["kind"]],
                   tag=s.get("tag", ""), title=s.get("title", ""), sub=s.get("sub", ""), bul=s.get("bul", ()),
                   inn=s.get("inn"), out=s.get("out"))
    for a in arrows:
        A, B = S[a["a"]], S[a["b"]]
        c = {"fail": "r"}.get(a.get("style"), "k")
        dash = a.get("style") in ("dash", "fail")
        if A["row"] == B["row"]:
            y0 = min(A["y"] + A["h"] / 2, B["y"] + B["h"] / 2) + a.get("off", 0)
            if A["x"] < B["x"]:
                pts = [(A["x"] + A["w"], y0), (B["x"], y0)]
            else:
                pts = [(A["x"], y0), (B["x"] + B["w"], y0)]
            cv.poly(pts, dash, c)
            lx, ly = (pts[0][0] + pts[1][0]) / 2, y0 - 10
        else:
            sx = A["x"] + A["w"] / 2 + a.get("soff", 0)
            tx = B["x"] + B["w"] / 2 + a.get("toff", 0)
            y1 = rowy[A["row"]] + rowh[A["row"]] if a.get("rowbottom") else A["y"] + A["h"]
            y1 = A["y"] + A["h"]
            y2 = B["y"] - B["gpad"]
            ym = rowy[A["row"]] + rowh[A["row"]] + gap / 2 + a.get("ymid", 0)
            if abs(sx - tx) < 1 and B["row"] == rows[rows.index(A["row"]) + 1]:
                pts = [(sx, y1), (tx, y2)]
                lx, ly = sx + 6, (y1 + y2) / 2
                cv.poly(pts, dash, c)
                if a.get("label"):
                    cv.lbl(lx, ly, a["label"], align="l")
                continue
            pts = [(sx, y1), (sx, ym), (tx, ym), (tx, y2)]
            cv.poly(pts, dash, c)
            lx, ly = (sx + tx) / 2, ym
            if abs(sx - tx) < 60:
                lx = max(sx, tx) + 8
                if a.get("label"):
                    cv.lbl(lx, ly, a["label"], align="l")
                continue
        if a.get("label"):
            cv.lbl(lx, ly, a["label"])
    return cv, H


# ================================================================ DIAGRAMS
def d_l0():
    cv = Cv("l0", 1000, 440)
    W, H = 230, 96
    cv.box(0, 40, W, H, "c actor", title="Developer using Claude Code")
    cv.box(385, 40, W, H, "c data", "DATA", "JSONL transcripts", "`<user-home>/.claude/projects/**/*.jsonl`")
    cv.box(770, 40, W, H, "c entry", "ENTRY", "watcher", "parse · redact · write")
    cv.box(770, 210, W, H, "c data", "DATA", "DuckDB write DB", "`data/aura.duckdb`")
    cv.box(385, 210, W, H, "c data", "DATA", "DuckDB read snapshot", "`data/read/aura.duckdb`")
    cv.box(0, 210, W, H, "c", "APP", "Next.js dashboard", "`localhost:3000`")
    cv.box(770, 372, W, 56, "c routine", title="dbt run (inside watcher)", mono=True)
    cv.poly([(W, 88), (385, 88)]); cv.lblv(307, 88, "appends 1 line|per event"); cv.num(307, 88, 1)
    cv.poly([(615, 88), (770, 88)], True); cv.lblv(692, 88, "poll every 10 s"); cv.num(692, 88, 2)
    cv.poly([(885, 136), (885, 210)], True); cv.lbl(893, 160, "INSERT", align="l"); cv.lbl(893, 175, "raw_events", align="l"); cv.num(885, 173, 3)
    cv.poly([(885, 306), (885, 372)], head=True, tail=True); cv.lbl(893, 330, "every 25 min", align="l"); cv.lbl(893, 345, "builds marts", align="l"); cv.num(885, 339, 4)
    cv.poly([(770, 258), (615, 258)], True); cv.lblv(692, 258, "copy every|600 s"); cv.num(692, 258, 5)
    cv.poly([(385, 258), (230, 258)], True); cv.lblv(307, 258, "read-only|queries"); cv.num(307, 258, 6)
    cv.poly([(115, 210), (115, 136)]); cv.lbl(123, 160, "cost +", align="l"); cv.lbl(123, 175, "behaviour", align="l"); cv.num(115, 173, 7)
    return cv.html()


def d_l2():
    cv = Cv("l2", 1000, 900)
    cv.frame(0, 40, 136, 810, "HOST")
    cv.box(6, 176, 124, 104, "data", "DATA", "CLAUDE_LOGS_DIR", "`<user-home>/`|`.claude/`|`projects`", mono=True)
    cv.box(6, 600, 124, 64, "data", "DATA", "./data/", "bind mount", mono=True)
    cv.frame(190, 40, 550, 810, "CONTAINER watcher", "python:3.12-slim · mem_limit 5g|init: true · restart unless-stopped")
    R = [("main", "main()", "ENTRY · startup, env, threads", "main.py:978", "routine entry"),
         ("obs", "PollingObserver", "timeout=10 · JSONLHandler live events", "main.py:1181,390-418", "routine"),
         ("pf", "process_file → adapters", "ClaudeAdapter · SdkTraceAdapter: parse, redact", "main.py:228, adapters/claude.py:84", "routine"),
         ("wr", "DuckDBWriter + CheckpointManager", "inserts, offsets", "duckdb_writer.py · checkpoint.py", "routine"),
         ("dbtw", "dbt_worker", "seed → run → test in /app/dbt", "main.py:549", "routine"),
         ("snap", "snapshot_worker → take_snapshot", "every AURA_SNAPSHOT_INTERVAL", "main.py:521, snapshot.py:7", "routine"),
         ("sw", "sweep_worker", "catch missed bytes, 600 s", "main.py:761", "routine"),
         ("cov", "coverage_worker", "coverage JSON, 300 s", "main.py:735", "routine"),
         ("vi", "process_verdicts_inbox", "every 5 s, main thread", "main.py:905", "routine")]
    for i, (_, t, sub, c, k) in enumerate(R):
        cv.box(205, 100 + 76 * i, 280, 64, k, title=t, sub=sub, cite_=c, mono=True)
    cv.box(205, 792, 515, 34, "data", title="_snapshot_lock: one in-process lock (main.py:427)", mono=True)
    DX, DW = 580, 140
    cv.box(DX, 328, DW, 64, "data", title="/data/|aura.duckdb", sub="write DB", mono=True)
    cv.box(DX, 480, DW, 64, "data", title="/data/read/|aura.duckdb", sub="read DB", mono=True)
    cv.box(DX, 590, DW, 80, "data", title="/data/artifacts/", sub="dbt JSON files", mono=True)
    cv.box(DX, 700, DW, 80, "data", title="/data/|verdicts-inbox.jsonl", sub="verdict hand-off", mono=True)
    cv.frame(770, 40, 230, 770, "CONTAINER frontend", "node:20-alpine|Next standalone :3000|/data ro · mem_limit 512m")
    cv.box(785, 126, 200, 64, "routine", title="app/**/page.tsx", sub="force-dynamic RSC", mono=True)
    cv.box(785, 220, 150, 64, "routine", title="app/api/**/route.ts", sub="12 handlers", mono=True)
    cv.box(785, 477, 200, 70, "routine", title="lib/db.ts query()", sub="READ_ONLY, inode check, 15 s timeout", mono=True)
    cv.box(785, 590, 200, 80, "routine", title="queries/observability.ts", sub="reads artifacts JSON", mono=True)
    cv.box(785, 708, 200, 64, "routine", title="api/sessions/[id]/verdict", sub="appends to inbox", mono=True)
    cv.box(800, 0, 200, 30, "c actor", title="Browser · GET /?range=7d", mono=True)
    cv.poly([(130, 208), (205, 208)], True); cv.lbl(167, 194, "ro mount")
    cv.poly([(345, 164), (345, 176)]); cv.poly([(345, 240), (345, 252)]); cv.poly([(345, 316), (345, 328)])
    cv.poly([(485, 350), (DX, 350)], True); cv.lbl(532, 336, "INSERT")
    cv.poly([(485, 420), (515, 420), (515, 372), (DX, 372)]); cv.lbl(548, 386, "dbt run")
    cv.poly([(650, 392), (650, 480)], True); cv.lbl(658, 436, "checkpoint", align="l")
    cv.poly([(485, 512), (DX, 512)], True); cv.lbl(505, 498, "copy")
    cv.poly([(485, 452), (545, 452), (545, 630), (DX, 630)], True); cv.lbl(552, 567, "copy artifacts", align="l")
    cv.poly([(DX, 740), (485, 740)], True); cv.lbl(532, 726, "poll 5 s")
    cv.poly([(130, 632), (190, 632)], True); cv.lbl(160, 618, "rw /data")
    cv.poly([(68, 664), (68, 880), (880, 880), (880, 810)], True); cv.lbl(500, 866, "ro /data")
    cv.poly([(720, 512), (785, 512)], True); cv.lbl(752, 498, "ro")
    cv.poly([(720, 630), (785, 630)], True); cv.lbl(752, 616, "ro")
    cv.poly([(785, 740), (720, 740)], True); cv.lbl(752, 726, "append")
    cv.poly([(970, 30), (970, 126)])
    cv.poly([(960, 190), (960, 477)]); cv.poly([(860, 284), (860, 477)])
    return cv.html()


def d_ingest():
    steps = [
        dict(id="s1", lane=1, row=0, kind="entry", tag="STEP 1", title="`purge_duckdb_spill_dir`",
             bul=["deletes `{db}.tmp` contents before first connect"], inn="`/data/aura.duckdb.tmp/*`", out="`0 orphan spill files`"),
        dict(id="s2", lane=1, row=1, kind="routine", tag="STEP 2", title="`DuckDBWriter()` + start threads",
             bul=["DDL `CREATE TABLE IF NOT EXISTS`", "snapshot, coverage, dbt, sweep threads"], inn="`env vars`", out="`4 daemon threads`"),
        dict(id="f3", lane=0, row=2, kind="data", tag="DATA", title="`*.jsonl` files", sub="host transcripts, read-only"),
        dict(id="s3", lane=1, row=2, kind="routine", tag="STEP 3", title="`list_backfill_files` + `filter_files_with_new_bytes`",
             bul=["oldest mtime first", "skip fully checkpointed files"], inn="e.g. `15,000 files`", out="e.g. `200 with new bytes`"),
        dict(id="s4", lane=1, row=3, kind="routine", tag="STEP 4", title="`run_batched_backfill`", grp="Repeats per batch (100 files / 120 s)",
             bul=["holds lock per batch", "persistent connection"], inn="`100 files`", out="`lock released`"),
        dict(id="f5", lane=0, row=4, kind="data", tag="DATA", title="file grew", sub="live append to a `*.jsonl`"),
        dict(id="s5", lane=1, row=4, kind="routine", tag="STEP 5", title="`JSONLHandler.on_modified / on_created`",
             bul=["`*.jsonl` only, not workflow journals"], inn="`file grew`", out="`process_file(path)`"),
        dict(id="s6", lane=1, row=5, kind="routine", tag="STEP 6", title="`process_file` read from checkpoint",
             bul=["seek `last_offset`"], inn="`last_offset=5000`", out="`bytes 5000..EOF`"),
        dict(id="d6", lane=1, row=6, kind="dec", title="`size < last_offset?`"),
        dict(id="y6", lane=0, row=6, kind="step", tag="YES", title="reset offset to 0", bul=["overwrite file stats"]),
        dict(id="s7", lane=2, row=7, kind="routine", tag="STEP 7", title="`ClaudeAdapter.parse_line`",
             bul=["maps type, usage, model, message.id, sessionId, cwd", "`redact_obj` then `json.dumps`"], inn="`1 JSON line`", out="`1 row or None`"),
        dict(id="x7", lane=1, row=7, kind="fail", tag="FAILURE", title="`json.loads` fails",
             bul=["`parse_errors` +1", "`watcher_errors` row"]),
        dict(id="s8", lane=3, row=8, kind="data", tag="STEP 8", title="`insert_events` (+ skills, mcps)",
             bul=["`ON CONFLICT DO NOTHING` on `(tenant_id, uuid)`"], inn="`N rows`", out="`N new · 0 dup`"),
        dict(id="s9", lane=3, row=9, kind="data", tag="STEP 9", title="`update_checkpoint` + `update_file_stats`",
             bul=["same lock hold", "only if offset advanced"], inn="`new_offset`", out="`last_offset = size`"),
        dict(id="s10", lane=1, row=10, kind="routine", tag="STEP 10", title="`sweep_worker`",
             bul=["every 600 s re-scans for missed bytes"], inn="`all files`", out="`missed bytes ingested`"),
    ]
    arrows = [dict(a="s1", b="s2"), dict(a="s2", b="s3"), dict(a="f3", b="s3", style="dash"), dict(a="s3", b="s4"),
              dict(a="s4", b="s5"), dict(a="f5", b="s5", style="dash"), dict(a="s5", b="s6"), dict(a="s6", b="d6"),
              dict(a="d6", b="y6", label="yes"), dict(a="d6", b="s7", label="no", ymid=-8),
              dict(a="y6", b="s7", toff=-45, ymid=10, soff=0), dict(a="s7", b="x7", style="fail"),
              dict(a="s7", b="s8"), dict(a="s8", b="s9"), dict(a="s9", b="s10")]
    cv, H = swim("ingest", 1000, ["FILESYSTEM", "WATCHER main.py", "ADAPTER", "DUCKDB aura.duckdb"], steps, arrows, boxw=214)
    return cv.html()


def d_dbtcycle():
    steps = [
        dict(id="d1", lane=0, row=0, kind="dec", title="`interval <= 0?`"),
        dict(id="x1", lane=1, row=0, kind="step", tag="YES", title="thread exits"),
        dict(id="s2", lane=0, row=1, kind="routine", tag="STEP 2", title="`acquire _snapshot_lock`",
             bul=["ingestion and snapshots now wait"], inn="`—`", out="`lock held`"),
        dict(id="s3", lane=1, row=2, kind="routine", tag="STEP 3", title="`dbt source freshness`",
             bul=["skipped until `initial_backfill_done`"], inn="`raw_events.ts`", out="`sources.json`"),
        dict(id="s4", lane=1, row=3, kind="routine", tag="STEP 4", title="`dbt seed`",
             bul=["`--profiles-dir . --no-partial-parse`", "loads `model_pricing.csv`"], inn="`11 seed rows`", out="`model_pricing`"),
        dict(id="s5", lane=1, row=4, kind="routine", tag="STEP 5", title="`dbt run`",
             bul=["`--profiles-dir . --no-partial-parse`", "`run`, not `build`: models refresh even if tests fail"], inn="`raw_events`", out="`29 models`"),
        dict(id="f5", lane=0, row=4, kind="fail", tag="FAILURE", title="`exit != 0`", bul=["`watcher_errors` source `dbt_run`", "models keep last build"]),
        dict(id="s6", lane=1, row=5, kind="routine", tag="STEP 6", title="`dbt test`",
             bul=["`--profiles-dir . --no-partial-parse`", "failures logged, never block"], inn="`105 generic + 2 singular`", out="`run_results.json`"),
        dict(id="s7", lane=0, row=6, kind="routine", tag="STEP 7", title="`release lock` then copy artifacts",
             bul=["to `/data/artifacts`", "keeps last 20 in `history/`"], inn="`target/*.json`", out="`/data/artifacts/*.json`"),
        dict(id="q1", lane=2, row=6, kind="routine", tag="STEP S1", title="`with _snapshot_lock:`",
             bul=["waits for dbt, never skips"], inn="`—`", out="`lock`"),
        dict(id="s8", lane=0, row=7, kind="routine", tag="STEP 8", title="`node run_all.mjs` (60 s timeout)",
             bul=["8 integrity checks"], inn="`read DB`", out="`number_verify.json`"),
        dict(id="q2", lane=2, row=7, kind="data", tag="STEP S2", title="`take_snapshot`",
             bul=["`PRAGMA force_checkpoint`", "`copy2` to `dst.tmp`, `os.replace`"], inn="`/data/aura.duckdb`", out="`/data/read/aura.duckdb` (new inode)"),
        dict(id="s9", lane=0, row=8, kind="routine", tag="STEP 9", title="`sleep 25 min`",
             bul=["sleep starts after the cycle ends"], inn="`—`", out="`next cycle`"),
    ]
    arrows = [dict(a="d1", b="x1", label="yes"), dict(a="d1", b="s2", label="no"), dict(a="s2", b="s3"), dict(a="s3", b="s4"),
              dict(a="s4", b="s5"), dict(a="s5", b="f5", style="fail"), dict(a="s5", b="s6"), dict(a="s6", b="s7"),
              dict(a="s7", b="q1", style="dash"), dict(a="s7", b="s8"), dict(a="q1", b="q2"), dict(a="s8", b="s9")]
    cv, H = swim("dbtcycle", 1000, ["dbt_worker THREAD", "dbt SUBPROCESS cwd /app/dbt", "snapshot_worker THREAD"], steps, arrows, boxw=290)
    return cv.html()


def d_pageload():
    steps = [
        dict(id="b0", lane=0, row=0, kind="actor", title="Browser"),
        dict(id="s1", lane=1, row=0, kind="routine", tag="STEP 1", title="`GET /?range=7d`",
             bul=["route `/`, `force-dynamic`"], inn="`URL`", out="`route /`"),
        dict(id="s2", lane=2, row=1, kind="routine", tag="STEP 2", title="`parseRange`, `rangeSince`", inn="`7d`", out="`since` ISO timestamp"),
        dict(id="s3", lane=2, row=2, kind="routine", tag="STEP 3", title="`Promise.all` of 17 `safe(...)`", inn="`since`", out="`17 promises`"),
        dict(id="f3", lane=2, row=3, kind="fail", tag="FAILURE", title="mart missing", bul=["`safe()` returns fallback", "one panel empty"]),
        dict(id="s4", lane=3, row=3, kind="routine", tag="STEP 4", title="`getInstance()` inode check", inn="`statSync(DB_PATH).ino`", out="cached or new `READ_ONLY` instance"),
        dict(id="s5", lane=3, row=4, kind="routine", tag="STEP 5", title="`runAndReadAll`", bul=["`(sql, params)`, 15 s timeout"], inn="SQL + `?` params", out="`rows`"),
        dict(id="db", lane=4, row=4, kind="data", tag="DATA", title="READ DB", sub="`data/read/aura.duckdb`"),
        dict(id="s6", lane=3, row=5, kind="routine", tag="STEP 6", title="`normalizeBigInts`", inn="`5n`, `Date`", out="`5`, ISO string"),
        dict(id="f5", lane=4, row=5, kind="fail", tag="FAILURE", title="query over 15 s", bul=["interrupt, then reject", "see bullets below"]),
        dict(id="s7", lane=2, row=6, kind="routine", tag="STEP 7", title="render with `fmt.usd`", inn="`rows`", out="HTML + RSC payload"),
        dict(id="b7", lane=0, row=7, kind="actor", title="HTML + RSC payload"),
    ]
    arrows = [dict(a="b0", b="s1"), dict(a="s1", b="s2"), dict(a="s2", b="s3"), dict(a="s3", b="f3", style="fail", soff=-40, toff=-40),
              dict(a="s3", b="s4", soff=40), dict(a="s4", b="s5"), dict(a="s5", b="db", style="dash"), dict(a="s5", b="s6"),
              dict(a="s5", b="f5", style="fail", soff=40, ymid=-8), dict(a="s6", b="s7"), dict(a="s7", b="b7")]
    cv, H = swim("pageload", 1000, ["BROWSER", "NEXT SERVER :3000", "page.tsx RSC", "lib/db.ts", "READ DB"], steps, arrows, boxw=170)
    return cv.html()


def d_cost():
    steps = [
        dict(id="s1", lane=0, row=0, kind="routine", tag="STEP 1", title="`ClaudeAdapter` token columns", inn="`message.usage`", out="6 token columns on `raw_events`"),
        dict(id="s1b", lane=0, row=1, kind="routine", tag="STEP 1b", title="`SdkTraceAdapter`", inn="`result.total_cost_usd`", out="`reported_cost_usd`"),
        dict(id="s2", lane=1, row=2, kind="shape", tag="STEP 2", title="`stg_assistant_messages`", bul=["latest `ts`, `byte_offset` wins"], inn="N streamed rows per `message_id`", out="1 row"),
        dict(id="mp", lane=1, row=3, kind="data", tag="SEED", title="`model_pricing`", sub="per-Mtok rates, 11 rows"),
        dict(id="s3", lane=2, row=3, kind="routine", tag="STEP 3", title="`fact_model_calls.calculated_cost`",
             bul=["`sdk_trace`: `COALESCE(reported_cost_usd, 0)`", "else tokens × rate / 1e6"], inn="tokens + pricing row", out="USD per call"),
        dict(id="d3", lane=2, row=4, kind="dec", title="`sdk_trace`? else pricing row found?"),
        dict(id="f3", lane=3, row=4, kind="fail", tag="FAILURE", title="`NULL` cost", bul=["`not_null` test fails", "`fact_turns` shows `$0.0000`"]),
        dict(id="s4", lane=2, row=5, kind="routine", tag="STEP 4", title="fan-out of `calculated_cost`",
             bul=["`fact_daily_spend.daily_cost`", "`fact_turns` → `dim_sessions.total_cost`", "`int_entity_spend`, `fact_spend_pace`"], inn="`calculated_cost`", out="4 mart totals"),
        dict(id="s5", lane=3, row=6, kind="routine", tag="STEP 5", title="`getDashboardKPIs` → `fmt.usd`", inn="`SUM(daily_cost)`", out="`$0.123`"),
    ]
    arrows = [dict(a="s1", b="s1b"), dict(a="s1b", b="s2"), dict(a="s2", b="s3"), dict(a="mp", b="s3", style="dash"),
              dict(a="s3", b="d3"), dict(a="d3", b="f3", style="fail", label="no"), dict(a="d3", b="s4", label="yes"), dict(a="s4", b="s5")]
    cv, H = swim("cost", 1000, ["WATCHER", "dbt STAGING", "dbt MARTS", "FRONTEND"], steps, arrows, boxw=214)
    return cv.html()


# ---------------------------------------------------------------- ER diagrams
EH = 66
RH = 22


def ent_h(n):
    return EH + 4 + RH * n


def ent(cv, x, y, w, name, layer, grain, rows):
    """rows: (col, badge, right) ; col starting with '+' or '~' = summary line"""
    trs = ""
    for col, badge, right in rows:
        if col.startswith("+") or col.startswith("~"):
            trs += '<tr><td colspan="2" style="color:#5B6068;font-style:italic">%s</td></tr>' % esc(col.lstrip("~"))
            continue
        bs = "".join('<span class="k%s">%s</span>' % (b.lower(), b) for b in badge.split())
        trs += "<tr><td>%s %s</td><td>%s</td></tr>" % (esc(col), bs, esc(right))
    cv.div.append('<div class="b ent" style="left:%gpx;top:%gpx;width:%gpx;height:%gpx"><div class="eh" style="height:%dpx"><b>%s</b>'
                  '<small>%s · %s</small></div><table>%s</table></div>'
                  % (x, y, w, ent_h(len(rows)), EH, esc(name), esc(layer), esc(grain), trs))
    return dict(x=x, y=y, w=w, h=ent_h(len(rows)), cx=x + w / 2, cy=y + ent_h(len(rows)) / 2)


def row_y(e, i):
    return e["y"] + EH + 1 + RH * i + RH / 2


def endmark(cv, p, d, kind):
    x, y = p
    dx, dy = d
    px, py = -dy, dx
    L = []
    if kind == "many":
        for s in (-1, 0, 1):
            L.append((x, y, x + dx * 13 + px * 6 * s, y + dy * 13 + py * 6 * s))
    else:
        for t in (8, 13):
            L.append((x + dx * t + px * 5, y + dy * t + py * 5, x + dx * t - px * 5, y + dy * t - py * 5))
    for a, b, c, e in L:
        cv.svg.append('<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1.5"/>' % (a, b, c, e, INK))


def erline(cv, pts, dash, k1, k2, label=None, lp=None, align="c"):
    cv.poly(pts, dash, head=False, anim=False)

    def dir_(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1
        return dx / n, dy / n
    endmark(cv, pts[0], dir_(pts[0], pts[1]), k1)
    endmark(cv, pts[-1], dir_(pts[-1], pts[-2]), k2)
    if label:
        for i, t in enumerate(label.split("|")):
            cv.lbl(lp[0], lp[1] + 14 * i, t, align=align)


def d_er_raw():
    cv = Cv("er_raw", 1000, 660)
    w = 250
    re_ = ent(cv, 0, 0, w, "raw_events", "watcher", "1 row per JSONL line with uuid + timestamp",
              [("tenant_id", "PK", ""), ("uuid", "PK", ""), ("session_id", "FK", ""), ("file_path", "FK", ""), ("message_id", "", ""), ("+ 23 columns", "", "")])
    sm = ent(cv, 375, 0, w, "session_meta", "watcher", "1 row per session",
             [("session_id", "PK", ""), ("tenant_id", "", ""), ("+ 7 columns", "", "")])
    sk = ent(cv, 750, 0, w, "raw_session_skills", "watcher", "1 row per (tenant, session, skill)",
             [("tenant_id", "PK", ""), ("session_id", "PK", ""), ("skill_name", "PK", ""), ("+ 1 column", "", "")])
    y1 = 260
    ic = ent(cv, 0, y1, w, "ingest_checkpoints", "watcher", "1 row per (tenant, JSONL file)",
             [("tenant_id", "PK", ""), ("file_path", "PK", ""), ("last_offset", "", ""), ("last_seen_at", "", ""), ("+ 1 column", "", "")])
    sv = ent(cv, 375, y1, w, "session_verdicts", "watcher", "1 row per (tenant, session)",
             [("tenant_id", "PK", ""), ("session_id", "PK", ""), ("+ 3 columns", "", "")])
    mc = ent(cv, 750, y1, w, "raw_session_mcps", "watcher", "1 row per (tenant, session, MCP server)",
             [("tenant_id", "PK", ""), ("session_id", "PK", ""), ("mcp_server", "PK", ""), ("+ 1 column", "", "")])
    y2 = y1 + ic["h"] + 70
    fs = ent(cv, 0, y2, w, "ingest_file_stats", "watcher", "1 row per (tenant, JSONL file)",
             [("tenant_id", "PK", ""), ("file_path", "PK", ""), ("+ 7 columns", "", "")])
    we = ent(cv, 750, y2, w, "watcher_errors", "watcher", "1 row per logged error; stands alone",
             [("no primary key", "", ""), ("~5 columns", "", "")])
    cv.h = y2 + fs["h"] + 20
    y = row_y(re_, 2)
    erline(cv, [(w, y), (375, y)], True, "many", "one", "tenant_id,|session_id", (312, y - 36))
    y = row_y(sk, 1)
    erline(cv, [(750, y), (625, y)], True, "many", "one", "tenant_id,|session_id", (687, y - 36))
    ym = row_y(mc, 1)
    erline(cv, [(750, ym), (687, ym), (687, row_y(sm, 1) + 4), (625, row_y(sm, 1) + 4)], True, "many", "one")
    cv.lbl(687, 296, "tenant_id,", chip=True); cv.lbl(687, 312, "session_id", chip=True)
    erline(cv, [(500, y1), (500, sm["y"] + sm["h"])], True, "one", "one", "tenant_id, session_id", (508, (y1 + sm["h"]) / 2), "l")
    erline(cv, [(60, re_["h"]), (60, y1)], True, "many", "one", "tenant_id, file_path", (68, (re_["h"] + y1) / 2 + 6), "l")
    erline(cv, [(60, ic["y"] + ic["h"]), (60, y2)], True, "one", "one", "tenant_id, file_path", (68, (ic["y"] + ic["h"] + y2) / 2), "l")
    return cv.html()


def d_er_marts():
    cv = Cv("er_marts", 1000, 960)
    w = 250
    pj = ent(cv, 375, 0, w, "dim_projects", "marts", "1 row per (tenant_id, project_id)", [("tenant_id", "PK", ""), ("project_id", "PK", "")])
    ap = ent(cv, 375, 163, w, "dim_apps", "marts", "1 row per (tenant_id, app_id, project_id)",
             [("tenant_id", "PK", ""), ("app_id", "PK", ""), ("project_id", "PK", ""), ("+ rollups", "", "")])
    cw = ent(cv, 375, 370, w, "int_app_cwd_lookup", "intermediate", "1 row per (tenant_id, cwd)",
             [("tenant_id", "PK", ""), ("cwd", "PK", ""), ("app_id", "FK", ""), ("project_id", "FK", "")])
    ss = ent(cv, 375, 577, w, "dim_sessions", "marts", "1 row per (tenant_id, session_id)",
             [("tenant_id", "PK", ""), ("session_id", "PK", ""), ("person_id", "FK", ""), ("cwd", "", ""), ("+ session roll-up columns", "", "")])
    pe = ent(cv, 375, 806, w, "dim_people", "marts", "1 row per (tenant_id, person_id)", [("tenant_id", "PK", ""), ("person_id", "PK", "")])
    mp = ent(cv, 0, 330, w, "model_pricing", "seed", "1 row per (tenant_id, model, valid_from)",
             [("tenant_id", "PK", ""), ("model", "PK", ""), ("valid_from", "PK", ""), ("valid_to", "", ""), ("+ 11 columns", "", "")])
    mc = ent(cv, 0, 560, w, "fact_model_calls", "marts", "1 row per model call",
             [("event_uuid", "PK", ""), ("model_call_id", "", ""), ("session_id", "FK", ""), ("model", "FK", ""), ("+ tokens, calculated_cost", "", "")])
    ft = ent(cv, 0, 789, w, "fact_turns", "marts", "1 row per turn",
             [("turn_id", "PK", ""), ("session_id", "FK", ""), ("assistant_event_uuid", "", "")])
    X = 750
    pr = ent(cv, X, 163, w, "fact_prompts", "marts · incremental", "1 row per external prompt",
             [("tenant_id", "PK", ""), ("prompt_id", "PK", ""), ("app_id", "FK", ""), ("session_id", "FK", "")])
    te = ent(cv, X, 360, w, "fact_tool_executions", "marts · incremental", "1 row per tool_use_id",
             [("tenant_id", "PK", ""), ("tool_use_id", "PK", ""), ("session_id", "FK", "")])
    er = ent(cv, X, 525, w, "fact_errors", "marts", "1 row per distinct error tuple", [("session_id", "FK", ""), ("no primary key", "", "")])
    gc = ent(cv, X, 668, w, "fact_git_commands", "marts", "1 row per git Bash call", [("session_id", "FK", ""), ("no primary key", "", "")])
    sf = ent(cv, X, 811, w, "fact_session_files", "marts", "1 row per (tenant, session, file)",
             [("tenant_id", "PK", ""), ("session_id", "PK FK", ""), ("file_path", "PK", "")])
    cv.h = 960
    hub_att = ss["y"] + 110
    bx = 735
    ys = [row_y(te, 2), row_y(er, 0), row_y(gc, 0), row_y(sf, 1)]
    cv.poly([(bx, ys[0]), (bx, ys[-1])], False, head=False)
    for yy in ys:
        cv.poly([(X, yy), (bx, yy)], False, head=False)
        endmark(cv, (X, yy), (1, 0), "many")
    cv.poly([(bx, hub_att), (625, hub_att)], False, head=False)
    endmark(cv, (625, hub_att), (1, 0), "one")
    cv.lbl(680, hub_att - 12, "session_id")
    lx = 312
    ys = [row_y(mc, 2), row_y(ft, 1)]
    cv.poly([(lx, ys[0]), (lx, ys[1])], False, head=False)
    for yy in ys:
        cv.poly([(w, yy), (lx, yy)], False, head=False)
        endmark(cv, (w, yy), (-1, 0), "many")
    cv.poly([(lx, hub_att), (375, hub_att)], False, head=False)
    endmark(cv, (375, hub_att), (-1, 0), "one")
    cv.lbl(344, hub_att - 12, "session_id")
    ya = row_y(pr, 2)
    erline(cv, [(X, ya), (625, ya)], False, "many", "one", "app_id", (688, ya - 12))
    yd = row_y(pr, 3)
    erline(cv, [(X, yd), (680, yd), (680, ss["y"] + 70), (625, ss["y"] + 70)], True, "many", "one")
    cv.lbl(680, 420, "session_id", chip=True)
    cv.lbl(680, 440, "logical, untested", chip=True)
    cv.poly([(125, mp["y"] + mp["h"]), (125, mc["y"])], True, head=False, anim=False)
    endmark(cv, (125, mc["y"]), (0, -1), "many"); endmark(cv, (125, mp["y"] + mp["h"]), (0, 1), "one")
    cv.lbl(135, 530, "model, ts in validity range", align="l")
    erline(cv, [(125, mc["y"] + mc["h"]), (125, ft["y"])], True, "one", "one", "turn_id = model_call_id", (135, 759), "l")
    erline(cv, [(500, pe["y"]), (500, ss["y"] + ss["h"])], True, "one", "many", "person_id", (508, 786), "l")
    erline(cv, [(500, cw["y"] + cw["h"]), (500, ss["y"])], True, "one", "many", "cwd", (508, 547), "l")
    erline(cv, [(500, ap["y"] + ap["h"]), (500, cw["y"])], True, "one", "many", "app_id, project_id", (508, 340), "l")
    erline(cv, [(500, pj["y"] + pj["h"]), (500, ap["y"])], True, "one", "many", "project_id", (508, 133), "l")
    return cv.html()


# ---------------------------------------------------------------- lineage (Graphviz)
def read_edges():
    t = (ROOT / "AURA-knowledge-graph/flows/dbt-lineage.md").read_text(encoding="utf-8")
    return re.findall(r"^\s+(\w+) --> (\w+)\s*$", t, re.M)


COST = {("src_raw_events", "stg_events"), ("stg_events", "stg_assistant_messages"), ("stg_assistant_messages", "fact_model_calls"),
        ("fact_model_calls", "fact_daily_spend"), ("model_pricing", "fact_model_calls"), ("fact_model_calls", "fact_turns"),
        ("fact_turns", "dim_sessions")}
SRC = ["src_raw_events", "src_session_meta", "src_raw_session_skills", "src_raw_session_mcps", "src_session_verdicts",
       "src_ingest_checkpoints", "src_watcher_errors"]
VIEWS = ["stg_events", "stg_assistant_messages", "stg_session_meta", "stg_session_skills", "stg_session_mcps",
         "stg_session_verdicts", "stg_thinking_blocks", "int_turns", "dim_turn_messages"]
INCR = ["stg_tool_results", "fact_tool_executions", "fact_prompts"]


GRP = "stg_session_group"
SESS = ["stg_session_meta", "stg_session_skills", "stg_session_mcps", "stg_session_verdicts"]
UP = set(SRC) | set(VIEWS[:7]) | {"stg_tool_calls", "stg_tool_results", "int_turns", "int_event_agent", "dim_turn_messages"}


def d_lineage(name, edges, extra=(), group=False, rd="TB"):
    es = []
    for a, b in edges:
        if group and a in SESS:
            a = GRP
        if (a, b) not in es:
            es.append((a, b))
    nodes = sorted({n for e in es for n in e} | set(extra))
    L = ["digraph G {", 'rankdir=%s; nodesep=0.12;' % rd + ' ranksep=0.5; splines=true; bgcolor="transparent";',
         'node [shape=box, fontname="Courier New", fontsize=11, margin="0.06,0.03", height=0.26, penwidth=1];',
         'edge [color="#9AA0A6", penwidth=1, arrowsize=0.55];']
    for n in nodes:
        lab = n[4:] if n.startswith("src_") else n
        if n.startswith("src_"):
            st = 'style=filled, fillcolor="#EEEFEC", color="#B9BCC2", label="src: %s"' % lab
            if n == "src_watcher_errors":
                st = st[:-1] + '\n(read by frontend only)"'
        elif n == "model_pricing":
            st = 'style=filled, fillcolor="#EEEFEC", color="#B9BCC2", label="SEED: model_pricing"'
        elif n == GRP:
            st = 'style="filled,dashed", fillcolor="#FFFFFF", color="#17191D", label="stg_session_meta\nstg_session_skills\nstg_session_mcps\nstg_session_verdicts"'
        elif n in VIEWS:
            st = 'style="filled,dashed", fillcolor="#FFFFFF", color="#17191D", label="%s"' % n
        elif n in INCR:
            st = 'style=filled, fillcolor="#FCEBC8", color="#8A5A00", label="%s"' % n
        else:
            st = 'style=filled, fillcolor="#DDF0EE", color="#1C5C57", label="%s"' % n
        L.append('%s [%s];' % (n, st))
    for a, b in es:
        if (a, b) in COST:
            L.append('%s -> %s [color="#17191D", penwidth=2.4, arrowsize=0.8];' % (a, b))
        else:
            L.append("%s -> %s;" % (a, b))
    L.append("}")
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / "lineage.dot"
        f.write_text(chr(10).join(L), encoding="utf-8")
        svg = subprocess.run(["dot", "-Tsvg", str(f)], capture_output=True, text=True, check=True, encoding="utf-8").stdout
    svg = svg[svg.index("<svg"):]
    m = re.search(r'viewBox="0.00 0.00 ([\d.]+) ([\d.]+)"', svg)
    vw, vh = float(m.group(1)), float(m.group(2))
    px = vw * 4 / 3
    maxw = min(px, 1000)
    svg = re.sub(r'<svg width="[^"]*" height="[^"]*"', '<svg width="100%%" style="max-width:%dpx;height:auto" role="img" aria-label="dbt lineage %s"' % (maxw, name), svg, count=1)
    svg = re.sub(r'<title>[^<]*</title>', "", svg)
    return '<!--map:%s--><div class="map-wrap">%s</div><!--/map:%s-->' % (name, svg, name), maxw / px


def d_deploy():
    cv = Cv("deploy", 1000, 430)
    cv.frame(0, 10, 690, 410, "DEVELOPER MACHINE (Docker host)", solid=True, color="#17191D")
    cv.box(16, 70, 140, 96, "c data", "DATA", "Claude transcripts", "<user-home>/|.claude/projects")
    cv.box(16, 270, 140, 80, "c data", "DATA", "./data/", "host folder in repo")
    cv.box(266, 50, 180, 190, "", "CONTAINER", "watcher", bul=["`watcher/Dockerfile`", "`python:3.12-slim`", "CMD `python -m aura_watcher.main`"])
    cv.box(510, 50, 170, 190, "", "CONTAINER", "frontend", bul=["`frontend/Dockerfile`", "`node:20-alpine`, 3 stages", "CMD `node server.js`", "port 3000"])
    cv.box(590, 330, 100, 44, "c actor", title="Browser")
    cv.frame(800, 10, 200, 320, "GITHUB ACTIONS", solid=True, color="#17191D")
    for i, t in enumerate(["watcher job", "dbt job", "frontend job"]):
        cv.box(815, 56 + 62 * i, 170, 46, "c routine", title=t, mono=True)
    cv.box(815, 250, 170, 60, "c", title="checks only", sub="no deploy")
    cv.div.append('<div class="b c" style="left:800px;top:350px;width:200px;height:70px;border:1px dashed #9AA0A8;background:transparent">'
                  '<span class="t">Central / team rollout</span><span class="sub">not built (README.md:420-479)</span></div>')
    cv.poly([(156, 105), (266, 105)], True); cv.lblv(211, 105, "ro|/logs/claude")
    cv.poly([(156, 300), (356, 300), (356, 240)], True, head=True, tail=True); cv.lbl(256, 286, "rw /data")
    cv.poly([(156, 330), (556, 330), (556, 240)], True); cv.lbl(380, 344, "ro /data")
    cv.poly([(640, 330), (640, 240)]); cv.lbl(640, 285, "localhost:3000", chip=True)
    cv.poly([(690, 130), (800, 130)]); cv.lblv(745, 130, "git push|main / PR")
    return cv.html()


# ================================================================ CONTENT
SEED = []
with open(ROOT / "dbt/seeds/model_pricing.csv", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        SEED.append(r)
SEED_BY = {r["model"]: r for r in SEED}


def calc(model, inp=0, out=0, c5=0, c1=0, cc=0, cr=0):
    r = SEED_BY[model]
    g = lambda k: float(r[k] or 0)
    v = (inp * g("cost_input_per_mtok") + out * g("cost_output_per_mtok") + c5 * g("cost_cache_write_5m_per_mtok")
         + c1 * g("cost_cache_write_1h_per_mtok") + (cc - c5 - c1) * g("cost_cache_write_1h_per_mtok")
         + cr * g("cost_cache_read_per_mtok"))
    return v / 1e6


def usd(n):  # mirrors frontend/lib/fmt.ts:13-19
    return "$%.4f" % n if n < 0.01 else ("$%.3f" % n if n < 1 else "$%.2f" % n)


CHECK = {"sonnet": calc("claude-sonnet-5", 1000, 2000, 20000, 0, 20000, 50000),
         "opus": calc("claude-opus-4-8", 400, 1000, 0, 8000, 8000, 100000),
         "haiku": calc("claude-haiku-4-5", 0, 1000, 0, 0, 10000, 0)}
assert (usd(CHECK["sonnet"]), usd(CHECK["opus"]), usd(CHECK["haiku"])) == ("$0.123", "$0.157", "$0.025"), CHECK


def depths(edges):
    par = {}
    for a, b in edges:
        par.setdefault(b, set()).add(a)
    memo = {}

    def d(n):
        if n.startswith("src_") or n == "model_pricing":
            return -1
        if n not in memo:
            memo[n] = 1 + max([d(p) for p in par.get(n, [])] or [-1])
        return memo[n]
    nodes = {b for _, b in edges}
    out = {}
    for n in nodes:
        out.setdefault(d(n), []).append(n)
    return {k: sorted(v) for k, v in sorted(out.items())}


def build():
    edges = read_edges()
    n_edges = len(edges)
    e1 = [e for e in edges if e[1] in UP]
    e2 = [e for e in edges if e[1] not in UP]
    assert len(e1) + len(e2) == n_edges
    lin1, sc1 = d_lineage("lineage_up", e1, extra=["src_watcher_errors"], rd="LR")
    lin2, sc2 = d_lineage("lineage_marts", e2, group=True)
    scale = min(sc1, sc2)
    dep = depths(edges)
    S = []

    # ---- 1
    S.append(sec("s1", "Big picture", d_l0() + key("pill = person · grey = data · teal = code · dashed = data moves · numbers = order")
        + notice("The dashboard never reads the write DB; it reads a copy refreshed every 600 s.")
        + ul(["One process owns `data/aura.duckdb`; dbt runs as its subprocess.",
              "Readers open only the snapshot `data/read/aura.duckdb`, `READ_ONLY`."])))

    # ---- 2
    S.append(sec("s2", "Architecture", d_l2()
        + key("frame = container · teal = code · grey = data · dashed = data moves")
        + notice("Every watcher routine that touches DuckDB takes the same `_snapshot_lock`, so dbt blocks ingestion while it runs.")
        + table(["Component", "Responsibility", "Tech", "Path"], [
            ["watcher", "Ingest JSONL, own write DB, schedule dbt + snapshot", "Python 3.12, watchdog, duckdb", "`watcher/src/aura_watcher/`"],
            ["ClaudeAdapter", "One JSONL line to one `raw_events` row", "Python", "`watcher/src/aura_watcher/adapters/claude.py`"],
            ["SdkTraceAdapter", "SDK trace line (`kind`, `t`, `turn`) to row", "Python", "`watcher/src/aura_watcher/adapters/sdk_trace.py`"],
            ["redact", "Regex scrub before write", "Python `re`", "`watcher/src/aura_watcher/redact.py`"],
            ["dbt project `aura`", "staging, intermediate, marts, pricing seed", "dbt-duckdb", "`dbt/`"],
            ["frontend", "Server-rendered dashboard + 12 API handlers", "Next.js 14.2.3, React 18", "`frontend/`"],
            ["number verify", "Reconciles cost totals after each dbt cycle", "Node 20, `@duckdb/node-api`", "`scripts/verify/run_all.mjs`"]])
        + ul(["Polling, not inotify: inotify drops events on Windows bind mounts — `main.py:1179-1181`.",
              "Read DB basename must equal write DB basename (`aura.duckdb`) — `main.py:981-985`."])))

    # ---- 3
    S.append(sec("s3", "Flow: ingest and backfill", d_ingest()
        + key("teal = code · grey = data · purple dashed = repeats · red dashed = failure branch · numbers = order")
        + notice("Steps 8 and 9 run under one lock hold, so a crash re-reads lines and the dedup key absorbs them.")
        + table(["#", "Step", "In", "Out", "Source"], [
            ["1", "`purge_duckdb_spill_dir`", "`/data/aura.duckdb.tmp/*`", "`0 orphan spill files`", "`main.py:33-90,1008`"],
            ["2", "`DuckDBWriter()` + start threads", "`env vars`", "`4 daemon threads`", "`main.py:1010,1044-1083`"],
            ["3", "`list_backfill_files` + `filter_files_with_new_bytes`", "e.g. `15,000 files`", "e.g. `200 with new bytes`", "`main.py:114,154,1096-1123`"],
            ["4", "`run_batched_backfill`", "`100 files`", "`lock released`", "`main.py:440,498`"],
            ["5", "`JSONLHandler.on_modified / on_created`", "`file grew`", "`process_file(path)`", "`main.py:398-418`"],
            ["6", "`process_file` read from checkpoint", "`last_offset=5000`", "`bytes 5000..EOF`", "`main.py:259-296`"],
            ["7", "`ClaudeAdapter.parse_line`", "`1 JSON line`", "`1 row or None`", "`adapters/claude.py:84-228`"],
            ["8", "`insert_events` (+ skills, mcps)", "`N rows`", "`N new · 0 dup`", "`duckdb_writer.py:194-228`"],
            ["9", "`update_checkpoint` + `update_file_stats`", "`new_offset`", "`ingest_checkpoints.last_offset = size`", "`main.py:349-370`, `checkpoint.py:18-27`"],
            ["10", "`sweep_worker`", "`all files`", "`missed bytes ingested`", "`main.py:761,774`"]], "steps", mono=(2, 3))
        + ul(["Workers start before backfill, so dashboards refresh during a long catch-up.",
              "Oldest file first keeps `max(raw_events.ts)` advancing — `main.py:114-152`.",
              "Live path: read and parse run outside the lock; only DB writes are locked (a backfill batch holds the lock for the whole batch) — `main.py:258-259,349-390`.",
              "Size check: `size < last_offset` resets the offset to 0 — `main.py:266-268`.",
              "Workflow `journal.jsonl` files are skipped by backfill — `main.py:140,178`."])
        + '<div class="payloads">'
        + payload("IN", "3-line JSONL file: user, assistant, ai-title", '{"type":"user", ...}\n{"type":"assistant", ...}\n{"type":"ai-title", ...}')
        + payload("OUT", "rows written", "raw_events              +2\ningest_file_stats      lines_total=3 events_kept=2 dropped_known=1\ningest_checkpoints     last_offset = file size\nsession_meta           session_title set from ai-title")
        + '</div>' + cite("derived from watcher/src/aura_watcher/main.py:303-377")
        + exset([
            ex("ok", "TYPICAL", "Append two lines", [("file", "uuid-inc-1, uuid-inc-2"), ("then append", "uuid-inc-3, uuid-inc-4")],
               "`count(*) = 2`, then `4`; checkpoint `cp2 > cp1`", "from watcher/tests/test_main.py:122-182"),
            ex("edge", "EDGE", "File truncated", [("last_offset", "5000"), ("file size now", "3000 bytes")],
               "re-read from `0`; `ingest_file_stats` overwritten, not added", "from watcher/tests/test_main.py:68")])))

    # ---- 4
    S.append(sec("s4", "Flow: dbt cycle and snapshot", d_dbtcycle()
        + key("lanes = threads / process · teal = code · grey = data · red dashed = failure branch")
        + notice("A ~20 min cycle plus a 25 min sleep gives a ~45 min period with a 25 min lock-free window.")
        + ul(["Cycle ~20 min; slowest models `stg_tool_results` 450-634 s, `fact_prompts` ~493 s — `docker-compose.yml:27-28`.",
              "`run`, not `build`, so models refresh even when tests fail — `main.py:644-651`.",
              "Incremental (delete+insert, 24 h lookback on `ingest_checkpoints.last_seen_at`): `stg_tool_results`, `fact_tool_executions`, `fact_prompts` — `dbt/models/marts/fact_prompts.sql:49-57`.",
              "Snapshot copies the whole file under the lock — `docker-compose.yml:17-25`."])
        + table(["Time", "dbt_worker", "snapshot_worker", "Ingestion"], [
            ["10:00", "lock taken, `dbt run` starts", "waits", "waits"],
            ["10:20", "lock released, verify runs", "copies, read DB replaced", "flushes backlog"],
            ["10:45", "next cycle starts", "—", "waits again"]])
        + cite("derived from watcher/src/aura_watcher/main.py:549-733")))

    # ---- 5
    S.append(sec("s5", "Flow: page load", d_pageload()
        + key("lanes = processes · teal = code · grey = data · red dashed = failure branch")
        + notice("A replaced snapshot gets a new inode; the old handle stays open 3 s so in-flight queries finish.")
        + table(["#", "From → To", "Step", "Source"], [
            ["1", "Browser → Next", "`GET /?range=7d`", "`frontend/app/page.tsx:1`"],
            ["2", "page.tsx", "`parseRange`, `rangeSince`", "`page.tsx:28-29`, `lib/range.ts:3-23`"],
            ["3", "page.tsx", "`Promise.all` of 17 `safe(label, getX(since), fallback)`", "`page.tsx:46-64`, `lib/api-safe.ts:17`"],
            ["4", "lib/db.ts", "`getInstance()` inode check", "`lib/db.ts:30-65`"],
            ["5", "lib/db.ts → READ DB", "`runAndReadAll(sql, params)`, 15 s timeout", "`lib/db.ts:115-176`"],
            ["6", "lib/db.ts", "`normalizeBigInts`", "`lib/db.ts:70-113`"],
            ["7", "page.tsx → Browser", "render with `fmt.usd`", "`lib/fmt.ts:13-19`"]], "steps")
        + ul(["Timeout failure rejects with `Query timeout after 15000ms: <first 80 chars of SQL>` — `lib/db.ts:115-176`.", "Missing mart: `safe()` returns the fallback and logs `[aura:safe]`; one panel stays empty — `lib/api-safe.ts:17`.",
        "Range lives in the URL: `today` (default), `7d`, `30d`, `all` — `frontend/lib/range.ts:3-23`.",
        "Pages never price tokens; they sum dbt cost columns — `frontend/lib/queries/dashboard.ts:27`."]) + "<h3>Page variants</h3>"
        + table(["Page", "How data arrives", "Source"], [
            ["`/`, `/agents`, `/apps`, `/people`, `/tokens`", "Server component queries per request", "`frontend/app/page.tsx:47`"],
            ["`/sessions`", "Client fetch `GET /api/sessions?range&sort…`", "`frontend/app/sessions/page.tsx:33`"],
            ["`/errors`", "Client fetch `GET /api/errors` (latest 500 rows)", "`frontend/app/api/errors/route.ts:4-6`"],
            ["`/sessions/[sessionId]`", "12 queries; Prompts tab lazy-loads `/api/sessions/{id}/prompts-enriched`", "`frontend/app/sessions/[sessionId]/page.tsx:41-52`"],
            ["`/observability`", "SSR `getPipelineSnapshot()`, then poll `/api/observability` every 10 s", "`frontend/app/observability/PipelineLive.tsx:1394-1411`"]])
        + '<div class="payloads">' + payload("OUT", "GET /api/sessions?range=7d&sort=cost",
            '{ "sessions": [ up to 200 rows by total_cost DESC ],\n  "stats": { "total_count": …, "total_cost": … } }')
        + '</div>' + cite("from frontend/app/api/sessions/route.ts:17-20")))

    # ---- 6
    jr = lambda title, sub, rows, cls="": ('<div class="stage %s"><div class="h"><b>%s</b><small>%s</small></div><table>%s</table></div>'
        % (cls, title, sub, "".join("<tr><td>%s</td><td>%s</td></tr>" % (k, v) for k, v in rows)))
    arrow = '<div class="arrow"><svg viewBox="0 0 28 16"><path d="M2 8 H22 M16 2 L24 8 L16 14" fill="none" stroke="#17191D" stroke-width="1.5"/></svg></div>'
    journey = ('<div class="journey">'
        + jr("1 · JSONL line", "as written", [("type", "assistant"), ("model", "claude-sonnet-5"), ("message.id", "msg_1"), ("input_tokens", "1000"),
              ("output_tokens", "2000"), ("cache_creation", "20000"), ("ephemeral_5m", "20000"), ("ephemeral_1h", "0"), ("cache_read", "50000")])
        + arrow + jr("2 · raw_events", "parsed + redacted", [("uuid", "&lt;line uuid&gt;"), ("message_id", "msg_1"), ("tokens", "same, as columns"), ("payload", "redacted")])
        + arrow + jr("3 · stg_assistant_messages", "deduped by message_id", [("rows", '<span class="old">3 streamed</span><span class="new-v">1 row for msg_1</span>')], "changed")
        + '<div class="what"><div>as written</div><div></div><div>parsed + redacted</div><div></div><div>deduped by message_id</div></div></div>')
    journey2 = ('<div class="journey" style="grid-template-columns:1fr">'
        + jr("4 · fact_model_calls", "priced with seed row", [("calculated_cost",
              '<span class="calc">(1000×3.0 + 2000×15.0 + 20000×3.75 + 0×6.0 + 0 residual + 50000×0.3) / 1e6</span>'),
              ("result", '<span class="new-v">0.123 → $0.123</span>')]) + '</div>')
    S.append(sec("s6", "Flow: cost calculation", d_cost()
        + key("teal = code · grey = data · amber = shape change · red dashed = failure branch")
        + notice("Cost is priced once per model call in dbt; every mart and screen sums that value.")
        + table(["#", "Step", "In", "Out", "Source"], [
            ["1", "`ClaudeAdapter` token columns", "`message.usage`", "6 token columns on `raw_events`", "`adapters/claude.py:214-219`"],
            ["1b", "`SdkTraceAdapter`", "`result.total_cost_usd`", "`reported_cost_usd`", "`adapters/sdk_trace.py:162-167`"],
            ["2", "`stg_assistant_messages`", "N streamed rows per `message_id`", "1 row (latest `ts`, `byte_offset`)", "`stg_assistant_messages.sql:6-8,39`"],
            ["3", "`fact_model_calls.calculated_cost`", "tokens + pricing row", "USD per call", "`fact_model_calls.sql:41-89`"],
            ["4", "fan-out", "`calculated_cost`", "`fact_daily_spend.daily_cost`, `fact_turns` → `dim_sessions.total_cost`, `int_entity_spend.total_cost`, `fact_spend_pace.today_cost`",
             "`fact_daily_spend.sql:13`, `fact_turns.sql:34`, `dim_sessions.sql:18,43`"],
            ["5", "`getDashboardKPIs` → `fmt.usd`", "`SUM(daily_cost)`", "`$0.123`", "`lib/queries/dashboard.ts:27`, `page.tsx:134`"]], "steps")
        + "<h3>Data journey: one message</h3>" + journey + journey2
        + cite("derived from dbt/models/marts/fact_model_calls.sql:41-60 and dbt/seeds/model_pricing.csv:5, synthetic token counts")
        + ul(["`fact_turns` uses `COALESCE(calculated_cost, 0.0)`; an unpriced turn shows `$0.0000` — `fact_turns.sql:34`, `fmt.ts:13-19`.",
              "Reconciliation checks run after each cycle — `scripts/verify/run_all.mjs:72-110`."])))

    # ---- 7
    def vt(rows):
        return table(["Object", "Grain", "Key", "Written by"], rows)
    T1 = [
        ["`raw_events`", "1 per JSONL line with uuid + ts", "`tenant_id, uuid`", "watcher `DuckDBWriter.insert_events` (`duckdb_writer.py:194`)"],
        ["`ingest_checkpoints`", "1 per (tenant, file)", "`tenant_id, file_path`", "watcher `CheckpointManager.update_checkpoint` (`checkpoint.py:18`)"],
        ["`ingest_file_stats`", "1 per (tenant, file)", "`tenant_id, file_path`", "watcher `update_file_stats` (`duckdb_writer.py:256`)"],
        ["`session_meta`", "1 per session", "`session_id`", "watcher `write_session_meta`, `upsert_session_attributes` (`session_meta.py:128`, `duckdb_writer.py:323`)"],
        ["`raw_session_skills`", "1 per (tenant, session, skill)", "`tenant_id, session_id, skill_name`", "watcher `insert_session_skills` (`duckdb_writer.py:230`)"],
        ["`raw_session_mcps`", "1 per (tenant, session, server)", "`tenant_id, session_id, mcp_server`", "watcher `insert_session_mcps` (`duckdb_writer.py:243`)"],
        ["`session_verdicts`", "1 per (tenant, session)", "`tenant_id, session_id`", "watcher `process_verdicts_inbox` (`main.py:905-960`)"],
        ["`watcher_errors`", "1 per logged error", "—", "watcher `log_error` (`duckdb_writer.py:357`)"],
        ["`stg_tool_calls` (table)", "1 per tool_use block", "`tenant_id, tool_use_id`", "dbt `dbt/models/staging/stg_tool_calls.sql`"],
        ["`stg_tool_results` (incremental)", "1 per tool_use_id", "dedup on `tenant_id, COALESCE(tool_use_id, event_uuid)`; dbt unique_key `tenant_id, event_uuid`", "dbt `dbt/models/staging/stg_tool_results.sql`"],
        ["`int_app_cwd_lookup`", "1 per (tenant, cwd)", "`tenant_id, cwd`", "dbt `dbt/models/intermediate/int_app_cwd_lookup.sql`"],
        ["`int_entity_spend`", "1 per (tenant, entity_type, entity_id, project_id, date)", "same", "dbt `dbt/models/intermediate/int_entity_spend.sql`"],
        ["`int_event_agent`", "1 per (tenant, event_uuid)", "`tenant_id, event_uuid`", "dbt `dbt/models/intermediate/int_event_agent.sql`"],
        ["`dim_agents`", "1 per (tenant, agent, app_id, project_id)", "same", "dbt `dbt/models/marts/dim_agents.sql`"],
        ["`dim_apps`", "1 per (tenant, app_id, project_id)", "same", "dbt `dbt/models/marts/dim_apps.sql`"],
        ["`dim_people`", "1 per (tenant, person_id)", "same", "dbt `dbt/models/marts/dim_people.sql`"],
        ["`dim_projects`", "1 per (tenant, project_id)", "same", "dbt `dbt/models/marts/dim_projects.sql`"],
        ["`dim_sessions`", "1 per (tenant, session_id)", "same", "dbt `dbt/models/marts/dim_sessions.sql`"],
        ["`fact_daily_spend`", "1 per (tenant, date, agent, model, provider)", "`tenant_id, date, agent, model`", "dbt `dbt/models/marts/fact_daily_spend.sql`"],
        ["`fact_errors`", "1 per distinct error tuple", "—", "dbt `dbt/models/marts/fact_errors.sql`"],
        ["`fact_git_commands`", "1 per git Bash call", "—", "dbt `dbt/models/marts/fact_git_commands.sql`"],
        ["`fact_hourly_activity`", "up to 168 rows (day × hour)", "`day_of_week, hour_of_day`", "dbt `dbt/models/marts/fact_hourly_activity.sql`"],
        ["`fact_model_calls`", "1 per model call", "`event_uuid`", "dbt `dbt/models/marts/fact_model_calls.sql`"],
        ["`fact_prompts` (incremental)", "1 per external prompt", "`tenant_id, prompt_id`", "dbt `dbt/models/marts/fact_prompts.sql`"],
        ["`fact_session_files`", "1 per (tenant, session, file)", "same", "dbt `dbt/models/marts/fact_session_files.sql`"],
        ["`fact_spend_pace`", "1 per tenant", "`tenant_id`", "dbt `dbt/models/marts/fact_spend_pace.sql`"],
        ["`fact_tool_executions` (incremental)", "1 per tool_use_id", "`tenant_id, tool_use_id`", "dbt `dbt/models/marts/fact_tool_executions.sql`"],
        ["`fact_turns`", "1 per turn", "`turn_id`", "dbt `dbt/models/marts/fact_turns.sql`"],
        ["`model_pricing` (seed)", "1 per (tenant, model, valid_from)", "same", "`dbt seed` from `dbt/seeds/model_pricing.csv`"],
        ["`coverage_test` (seed)", "1 placeholder row", "—", "`dbt seed` from `dbt/seeds/coverage_test.csv`"]]
    assert len(T1) == 30
    T2 = [
        ["`stg_events`", "`source aura.raw_events`", "1 per `raw_events` row; payload that is not JSON → NULL"],
        ["`stg_assistant_messages`", "`stg_events`", "1 per (tenant_id, message_id); latest ts, byte_offset"],
        ["`stg_session_meta`", "`source aura.session_meta`", "1 per (tenant_id, session_id)"],
        ["`stg_session_skills`", "`source raw.raw_session_skills`", "1 per (tenant_id, session_id, skill_name)"],
        ["`stg_session_mcps`", "`source raw.raw_session_mcps`", "1 per (tenant_id, session_id, mcp_server)"],
        ["`stg_session_verdicts`", "`source aura.session_verdicts`", "1 per (tenant_id, session_id)"],
        ["`stg_thinking_blocks`", "`stg_events`", "1 per thinking block (assistant_event_uuid, thinking_idx)"],
        ["`int_turns`", "`stg_assistant_messages`, `stg_events`", "1 per assistant turn (turn_id = message_id)"],
        ["`dim_turn_messages`", "`int_turns`", "1 per turn_id; text columns only; must stay a view (OOM)"]]
    S.append(sec("s7", "Data model",
        ul(["8 raw tables (watcher), 29 dbt models, 2 seeds; raw tables have no enforced foreign keys."])
        + "<h3>Watcher tables</h3>" + d_er_raw()
        + key("PK/FK badges · ‖ one · crow's foot many · dashed = logical (not enforced)")
        + notice("`session_meta` is keyed by `session_id` alone, unlike every other raw table.")
        + cite("derived from watcher/src/aura_watcher/duckdb_writer.py:82-170")
        + "<h3>Core marts</h3>" + d_er_marts()
        + key("solid = enforced by dbt relationships test · dashed = logical join · PK/FK badges")
        + notice("Six facts are tested against `dim_sessions`; `fact_prompts` → `dim_sessions` is not tested.")
        + cite("solid lines from dbt/models/marts/schema.yml")
        + ul(["`watcher_errors`, `fact_errors`, `fact_git_commands` have no primary key.",
              "Standalone, not drawn: `fact_daily_spend`, `fact_hourly_activity`, `fact_spend_pace`, `int_entity_spend`, `int_event_agent`, `dim_agents`, `coverage_test`."])
        + "<h3>All objects</h3>" + vt(T1) + cite("from watcher/src/aura_watcher/duckdb_writer.py:82-170 and dbt/models/**/*.sql")
        + "<h3>Views</h3>" + table(["View", "Built from", "Rows"], T2) + cite("from dbt/models/staging/*.sql and dbt/models/intermediate/int_turns.sql")))

    # ---- 8
    deprows = [[str(k), ", ".join("`%s`" % m for m in v)] for k, v in dep.items()]
    S.append(sec("s8", "dbt lineage", "<h3>Sources to staging and intermediate</h3>" + lin1 + "<h3>Into marts</h3>" + lin2
        + key("grey = source/seed · dashed = view · teal = table · amber = incremental · bold = cost chain")
        + notice("`dim_apps` builds before `dim_sessions` because it reads `fact_turns`, `fact_git_commands` and `fact_errors`.")
        + cite("%d ref/source edges from dbt/models/**/*.sql (%d in the first diagram, %d in the second; the four stg_session_* edges to dim_sessions are drawn as one grouped node); layout by Graphviz dot" % (n_edges, len(e1), len(e2)))
        + "<h3>Build order</h3>" + table(["Depth", "Models"], deprows) + cite("derived from the edge list: longest path from a source")
        + ul(["29 models, 2 seeds, 7 sources, 105 generic + 2 singular tests (`dbt/tests/`).",
              "Defaults: staging and intermediate = view, marts = table — `dbt/dbt_project.yml:26-33`.",
              "Overrides: `stg_tool_calls`, `int_app_cwd_lookup`, `int_entity_spend`, `int_event_agent` table; `int_turns`, `dim_turn_messages` view; `stg_tool_results`, `fact_tool_executions`, `fact_prompts` incremental.",
              "`raw_events` freshness: warn 5 min, error 30 min on `ts` — `dbt/models/staging/sources.yml:24-25`.",
              "`stg_thinking_blocks` has no downstream model.",
              "`watcher_errors` has no dbt edge; the frontend reads it directly."])))

    # ---- 9
    sql1 = ("CASE\n  WHEN c.source = 'sdk_trace' THEN COALESCE(c.reported_cost_usd, 0)\n  WHEN mp.model IS NULL THEN NULL\n"
            "  ELSE ( input  × cost_input_per_mtok\n       + output × cost_output_per_mtok\n       + ephemeral_5m × cost_cache_write_5m_per_mtok\n"
            "       + ephemeral_1h × cost_cache_write_1h_per_mtok\n       + (cache_creation − 5m − 1h) × cost_cache_write_1h_per_mtok\n"
            "       + cache_read × cost_cache_read_per_mtok ) / 1000000.0\nEND")
    sql2 = ("LEFT JOIN model_pricing mp\n  ON c.model = mp.model\n AND (mp.tenant_id IS NULL OR mp.tenant_id = c.tenant_id)\n"
            " AND c.ts >= mp.valid_from\n AND c.ts <= COALESCE(CAST(mp.valid_to AS TIMESTAMP), '9999-12-31')\n"
            "QUALIFY ROW_NUMBER() OVER (\n  PARTITION BY c.tenant_id, c.message_id\n  ORDER BY CASE WHEN mp.tenant_id IS NULL THEN 1 ELSE 0 END) = 1")
    want = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "gemini-2.5-pro", "<synthetic>"]
    seedrows = []
    for m in want:
        r = SEED_BY[m]
        seedrows.append(["(empty = global)" if m == want[0] else "(empty)", m, r["provider"], r["cost_input_per_mtok"], r["cost_output_per_mtok"],
                         r["cost_cache_write_5m_per_mtok"], r["cost_cache_write_1h_per_mtok"], r["cost_cache_read_per_mtok"],
                         r["valid_from"], r["valid_to"] or "(empty)"])
    r91 = exset([
        ex("ok", "TYPICAL", "Append two lines", [("file", "uuid-inc-1, uuid-inc-2"), ("then append", "uuid-inc-3, uuid-inc-4")],
           "`count(*) = 2`, then `4`; checkpoint `cp2 > cp1`", "from watcher/tests/test_main.py:122-182"),
        ex("edge", "EDGE", "Rerun the same files", [("input", "same files through `run_batched_backfill` twice")],
           "`0 new rows` (key conflict ignored)", "from watcher/tests/test_backfill_batching.py:95"),
        ex("edge", "EDGE", "File truncated", [("last_offset", "5000"), ("file size now", "3000 bytes")],
           "re-read from `0`; `ingest_file_stats` overwritten, not added", "from watcher/tests/test_main.py:68; main.py:266-268"),
        ex("edge", "EDGE", "Streamed message (dbt)", [("message_id=m1", "ts 10:00:01"), ("message_id=m1", "ts 10:00:03")],
           "only the `10:00:03` row kept in `stg_assistant_messages`; tokens counted once",
           "derived from dbt/models/staging/stg_assistant_messages.sql:6; test dbt/models/staging/schema.yml:43")])
    r92 = exset([
        ex("ok", "TYPICAL", "Sonnet call with 5m cache", [("model", "claude-sonnet-5"), ("input / output", "1000 / 2000"), ("creation", "20000 (5m 20000, 1h 0)"), ("read", "50000")],
           "(3000 + 30000 + 75000 + 0 + 0 + 15000) / 1e6 = 0.123 → `%s`" % usd(CHECK["sonnet"]),
           "derived from dbt/models/marts/fact_model_calls.sql:50-59, dbt/seeds/model_pricing.csv:5"),
        ex("ok", "TYPICAL", "Opus call with 1h cache", [("model", "claude-opus-4-8"), ("input / output", "400 / 1000"), ("creation", "8000 (5m 0, 1h 8000)"), ("read", "100000")],
           "(2000 + 25000 + 0 + 80000 + 0 + 50000) / 1e6 = 0.157 → `%s`" % usd(CHECK["opus"]),
           "derived from fact_model_calls.sql:50-59, model_pricing.csv:2"),
        ex("edge", "EDGE", "Old log without cache split", [("model", "claude-haiku-4-5"), ("output", "1000"), ("creation", "10000"), ("5m / 1h", "NULL")],
           "residual 10000 × 2.0; (5000 + 20000) / 1e6 = 0.025 → `%s`" % usd(CHECK["haiku"]), "derived from fact_model_calls.sql:57, model_pricing.csv:8"),
        ex("bad", "FAILURE", "Unknown model id", [("model", "claude-sonnet-5-20260101"), ("tokens", "any")],
           "no seed row → `calculated_cost NULL`; `not_null` + singular test fail naming the model; `fact_turns` shows `$0.0000`. Remedy: add a row to `dbt/seeds/model_pricing.csv`.",
           "from dbt/models/marts/fact_model_calls.sql:65-73, fact_turns.sql:34, frontend/lib/fmt.ts:13-19"),
        ex("edge", "EDGE", "SDK trace run", [("source", "sdk_trace"), ("reported_cost_usd", "0.42"), ("earlier turns", "NULL")],
           "`0.42`; earlier turns `0`", "from fact_model_calls.sql:42-47; check scripts/verify/run_all.mjs:174")])
    r93 = exset([
        ex("ok", "TYPICAL", "Tool loop", [("user prompt", "10:00 'fix bug'"), ("assistant", "10:01, 10:03")],
           "2 turns, both `user_prompt='fix bug'`, `turn_number` 1, 2", "derived from dbt/models/intermediate/int_turns.sql:127-136"),
        ex("edge", "EDGE", "Tool result is not a prompt", [("user event", 'array content [{"type":"tool_result",…}]')],
           "excluded from the prompt pool; the turn keeps the earlier human prompt", "derived from int_turns.sql:43-46"),
        ex("edge", "EDGE", "Subagent turn", [("assistant", "sidechain assistant message at 10:05")],
           "gets the last non-sidechain prompt 'fix bug'", "derived from dbt/models/intermediate/int_turns.sql:127-136")])
    r94 = exset([
        ex("ok", "TYPICAL", "Key = value", [("text", "config: api_key=abcd1234567890abcdef")], "`config: «REDACTED»` (key name gone too)", "from watcher/tests/test_redact.py:6-13"),
        ex("edge", "EDGE", "Short value kept", [("text", "token=shortval")], "unchanged", "from watcher/tests/test_redact.py:41-45"),
        ex("edge", "EDGE", "Long blob", [("text", '"A" × 300')], "`<base64:300 bytes>`; a 199-char run stays unchanged",
           "from test_redact.py:48-53,257"),
        ex("edge", "EDGE", "Look-alike words", [("text", "risk-adjusted-return and desk-jockey are normal words")], "unchanged (`\\b` anchor)", "from test_redact.py:255")])
    S.append(sec("s9", "Business rules",
        "<h3>9.1 Dedup key: <code>raw_events (tenant_id, uuid)</code>, first write wins</h3>"
        + ul(["`INSERT … ON CONFLICT DO NOTHING`; nothing is ever updated — `duckdb_writer.py:225-228`.",
              "Claude rows: `uuid` = JSONL line uuid; SDK rows: `<session>:<byte_offset>`.",
              "Batch guard: rows whose key set differs from `events[0]` are skipped with a warning — `duckdb_writer.py:202-219`.",
              "Message-level dedup (`message_id`) happens in dbt, not here."]) + r91
        + "<h3>9.2 Cost formula with pricing SCD lookup</h3>"
        + ul(["`calculated_cost` = sum(token bucket × per-Mtok rate) / 1,000,000; `sdk_trace` uses its reported cost."])
        + '<div class="payloads">' + payload("IN", "fact_model_calls.sql:41-59", sql1, "sql") + payload("IN", "SCD join, fact_model_calls.sql:74-89", sql2, "sql") + "</div>"
        + "<h3>Pricing seed (USD per Mtok)</h3>"
        + table(["tenant_id", "model", "provider", "input", "output", "5m", "1h", "read", "valid_from", "valid_to"], seedrows, mono=(1, 3, 4, 5, 6, 7, 8, 9))
        + cite("from dbt/seeds/model_pricing.csv:1-12 (5 of %d rows)" % len(SEED))
        + ul(["%d rows, all global; batch rates unused." % len(SEED),
              "No pricing row → `NULL` → `not_null` test fails — `dbt/models/marts/schema.yml:20`.",
              "Singular test lists unpriced models — `dbt/tests/fact_model_calls_unknown_model_pricing.sql`.",
              "Model ids match exactly; version-suffixed ids need their own row.",
              "Cache creation without a 5m/1h split is priced at the 1h rate — `fact_model_calls.sql:57`.",
              "Tenant row beats global row via `QUALIFY` — `fact_model_calls.sql:86-89`."]) + r92
        + "<h3>9.3 Turn construction: one turn per deduped assistant message</h3>"
        + ul(["Source: `stg_assistant_messages`; `turn_id = message_id` — `int_turns.sql:72`.",
              "Prompt pool: `userType='external'`, not `isMeta`, content not starting `[`, `is_sidechain = FALSE` — `int_turns.sql:39-58`.",
              "`ASOF LEFT JOIN … a.ts >= u.user_ts` — `int_turns.sql:127-136`.",
              "`assistant_response` = first `type='text'` block in `content[0..19]` — `int_turns.sql:92-113`.",
              "`turn_number` = `ROW_NUMBER` per session by assistant ts — `int_turns.sql:71`."]) + r93
        + "<h3>9.4 Redaction: scrub payload before write</h3>"
        + ul(["Order: `REDACT_REGEX`, `CREDENTIAL_REGEX`, `PEM_REGEX`, `BASE64_REGEX` — `redact.py:58-75`.",
              "Claude path: `redact_obj` walks the object, then `json.dumps` — `adapters/claude.py:192`, `redact.py:78-98`.",
              "Toggle `AURA_REDACT_PAYLOAD` (default `true`), read once at import.",
              "Only `payload` is redacted; `cwd`, `git_branch`, `file_path` are stored raw.",
              "`AURA_HASH_CONTENT=1` replaces `message.content` with `sha256:<hex>` for new ingests."])
        + table(["Pattern", "Matches", "Replaced by"], [
            ["`REDACT_REGEX`", "`api_key/secret/token/password` + `:`/`=` + 16+ chars", "`«REDACTED»` (whole match)"],
            ["`CREDENTIAL_REGEX`", "`AKIA…`, `ASIA…`, `ghp_…`, `github_pat_…`, `sk-…`, `xox?-…`, JWT `eyJ…`", "`«REDACTED»`"],
            ["`PEM_REGEX`", "`-----BEGIN … PRIVATE KEY-----` … END", "`«REDACTED»`"],
            ["`BASE64_REGEX`", "`[A-Za-z0-9+/]{200,}`", "`<base64:N bytes>`"]])
        + cite("from watcher/src/aura_watcher/redact.py:29-56") + r94
        + "<h3>9.5 App and project from cwd</h3>"
        + ul(["`cwd` is split on `/`; the segment after `apps`, `services` or `packages` is the app, the one before it the project — `dim_apps.sql:21,41-52`.",
              "No such segment: app and project are both the last path segment."])
        + exset([
            ex("ok", "TYPICAL", "Monorepo app", [("cwd", "<repo>/apps/web")], "app `web`, project `<repo>`", "derived from dbt/models/marts/dim_apps.sql:41-52"),
            ex("edge", "EDGE", "Plain folder", [("cwd", "<user-home>/notes")], "app `notes`, project `notes`", "derived from dbt/models/marts/dim_apps.sql:41-52")])))

    # ---- 10
    cfg = [
        ["`CLAUDE_LOGS_DIR`", "`<user-home>/.claude/projects`", "same", "Host transcripts dir, mounted ro at `/logs/claude`"],
        ["`AURA_LOGS_DIR`", "`/logs/claude`", "`/logs/claude`", "Where the watcher looks for `.jsonl`"],
        ["`AURA_DB_PATH`", "`/data/aura.duckdb`", "`/data/aura.duckdb`", "Write DB (watcher + dbt)"],
        ["`AURA_READ_DB_PATH`", "`/data/read/aura.duckdb`", "same (watcher + frontend)", "Read snapshot; basename must be `aura.duckdb`"],
        ["`AURA_SNAPSHOT_INTERVAL`", "`2` s", "`600`", "Seconds between snapshot copies"],
        ["`AURA_DBT_RUN_INTERVAL_MINUTES`", "`5`", "`25`", "Sleep after each dbt cycle; `<= 0` disables"],
        ["`AURA_DBT_THREADS`", "set in dbt profile (file not opened)", "`2`", "dbt models built concurrently"],
        ["`AURA_DBT_DUCKDB_THREADS`", "set in dbt profile (file not opened)", "`2`", "DuckDB threads per query"],
        ["`AURA_DBT_MEMORY_LIMIT`", "set in dbt profile (file not opened)", "`4000MB`", "DuckDB pool for dbt; keep ~1 GB below `mem_limit 5g`"],
        ["`AURA_BACKFILL_BATCH_SIZE`", "`200`", "`100`", "Files per backfill lock hold"],
        ["`AURA_BACKFILL_BATCH_SECONDS`", "`120`", "not set", "Max seconds per backfill batch"],
        ["`AURA_SWEEP_INTERVAL_SECONDS`", "`600`", "not set", "Missed-bytes re-scan; `<= 0` disables"],
        ["`AURA_COVERAGE_INTERVAL`", "`300`", "not set", "Coverage JSON refresh"],
        ["`AURA_ARTIFACTS_DIR`", "`/data/artifacts`", "not set", "Artifacts dir for coverage JSON"],
        ["`AURA_EXTRA_TRACE_DIRS`", "empty", "`/data/sdk-traces` (illustrative)", "Extra comma-separated dirs to ingest"],
        ["`AURA_VERDICTS_INBOX`", "`/data/verdicts-inbox.jsonl`", "not set", "Verdict hand-off file"],
        ["`AURA_REDACT_PAYLOAD`", "`true`", "`true`", "Secret/base64 redaction on payload"],
        ["`AURA_HASH_CONTENT`", "off", "empty", "`1`/`true` hashes conversation text at ingest"],
        ["`AURA_MODEL_WINDOWS_JSON`", "empty", '`{"claude-opus-5-20260601":1000000}`', "Override context window sizes"],
        ["`AURA_DEFAULT_PERSON_ID`", "OS username", "`${AURA_DEFAULT_PERSON_ID:-local}`", "Person id instead of container `root`"],
        ["`AURA_DEFAULT_PERSON_NAME`", "person id", "`${AURA_DEFAULT_PERSON_NAME:-Local User}`", "Display name"],
        ["`AURA_QUERY_TIMEOUT_MS`", "`15000`", "not set", "Frontend per-query timeout"],
        ["`NODE_ENV`", "—", "`production`", "Frontend runtime mode"]]
    assert len(cfg) == 23
    S.append(sec("s10", "Configuration",
        ul(["Runtime config = compose environment variables; `aura.toml` is not read by any code."])
        + table(["Setting", "Default", "Example", "Purpose"], cfg)
        + cite("docker-compose.yml:9-90, watcher/src/aura_watcher/main.py:979-1036, frontend/lib/db.ts:13-14")
        + ul(["`.env` (copy of `.env.example`) feeds compose substitution; values not documented here — `<redacted>`.",
              "`dbt/profiles.yml` reads `AURA_DB_PATH` and the `AURA_DBT_*` names; file not opened.",
              "Container limits: watcher `mem_limit 5g`, frontend `512m` — `docker-compose.yml:109,135`."])))

    # ---- 11
    tree = """watcher/            Python package: adapters, writer, checkpoint, snapshot, workers
  src/aura_watcher/ main.py · duckdb_writer.py · checkpoint.py · redact.py · snapshot.py · adapters/
  tests/            pytest suite (14 test modules, 166 tests)
dbt/                dbt project "aura"
  models/           staging/ · intermediate/ · marts/
  seeds/            model_pricing.csv · coverage_test.csv
  tests/            2 singular tests
frontend/           Next.js dashboard
  app/              13 page routes + api/ (12 handlers)
  lib/              db.ts · fmt.ts · range.ts · queries/
  components/       SVG charts, tables
scripts/verify/     run_all.mjs (automated) + Playwright scripts (manual)
docs/               HOW-IT-WORKS.md · number-map.md · screens/ · blog/
data/               runtime only, git-ignored: aura.duckdb · read/ · artifacts/
docker-compose.yml  watcher + frontend services
.github/workflows/  ci.yml"""
    S.append(sec("s11", "Folder tree", '<pre class="tree">%s</pre>' % esc(tree) + ul(["`data/` is git-ignored — `.gitignore:227`."])))

    # ---- 12
    C = lambda *cmds: Raw("<br>".join("<code>%s</code>" % esc(c) for c in cmds))
    S.append(sec("s12", "Commands", table(["Task", "Command", "Source"], [
        ["First run", C("cp .env.example .env", "docker-compose up --build"), "`README.md:135-136`"],
        ["Open dashboard", C("http://localhost:3000"), "`README.md:139`"],
        ["Local watcher", C("cd watcher", "python -m venv .venv && source .venv/bin/activate", "pip install -e .", "python -m aura_watcher.main"), "`README.md:216-219`"],
        ["Local dbt", C("cd dbt", "pip install dbt-duckdb", "dbt seed --profiles-dir .", "dbt run --profiles-dir .", "dbt test --profiles-dir ."), "`README.md:233-237`"],
        ["Local frontend", C("cd frontend", "npm install", "npm run dev"), "`README.md:246-248`"],
        ["Full refresh of fact_prompts", C("dbt run --full-refresh"), "`README.md:380` (needs the full 4 GB pool)"],
        ["Number verify", C("cd scripts/verify && npm install && npm run verify"), "`scripts/verify/package.json:8` (set `AURA_READ_DB_PATH`, `AURA_ARTIFACTS_DIR`)"],
        ["CI: watcher", C("python -m pip install -e ./watcher pytest ruff", "python -m ruff check watcher/src", "python -m pytest watcher/tests -q"), "`.github/workflows/ci.yml:29-45`"],
        ["CI: dbt", C('python -m pip install "dbt-core==1.12.0" "dbt-duckdb==1.10.1" "duckdb==1.5.4"', "dbt parse --profiles-dir . --project-dir .", "dbt compile --profiles-dir . --project-dir ."), "`ci.yml:65-86`"],
        ["CI: frontend", C("npm ci", "npm run build"), "`ci.yml:112-124`"]])
        + ul(["Local env vars: `AURA_LOGS_DIR`, `AURA_DB_PATH`, `AURA_READ_DB_PATH` in every shell — `README.md:187-211`."])))

    # ---- 13
    S.append(sec("s13", "Deploy and access", d_deploy()
        + key("frame = machine / container · grey = data · dashed grey = not built")
        + notice("The only runtime environment is one developer machine; CI builds nothing that is deployed.")
        + "<h3>Environments</h3>"
        + table(["Environment", "Runs", "How", "Source"], [
            ["Local Docker (default)", "watcher + frontend containers", "`docker-compose up --build`", "`docker-compose.yml`, `README.md:128-139`"],
            ["Local dev (no Docker)", "3 shells: watcher, dbt, frontend", "see Commands", "`README.md:178-253`"],
            ["CI", "lint, tests, dbt parse/compile, Next build", "GitHub Actions on push to `main` and PRs", "`.github/workflows/ci.yml:3-12`"],
            ["Staging / production / team hub", "—", "Not defined in source — confirm with owner", "`README.md:420-479` (proposal only)"]])
        + "<h3>Deploy steps</h3>"
        + "<ol><li>Install the prerequisites below.</li>"
          "<li><code>cp .env.example .env</code>; set <code>AURA_DEFAULT_PERSON_ID</code>, <code>AURA_DEFAULT_PERSON_NAME</code> (values <code>&lt;redacted&gt;</code>).</li>"
          "<li>Optional: set <code>CLAUDE_LOGS_DIR</code> if transcripts are not in <code>&lt;user-home&gt;/.claude/projects</code>.</li>"
          "<li><code>docker-compose up --build</code></li>"
          "<li>Wait for the first dbt cycle (~20 min) and first snapshot; both take the same lock. <code>/observability</code> shows progress.</li></ol>"
        + ul(["Update: `git pull origin main`, then `docker-compose up --build` — pull rule from `CLAUDE.md`, rebuild from `README.md:136`."])
        + "<h3>Roll back</h3>"
        + '<p><b>Rollback: Not defined in source — confirm with owner.</b></p>'
        + ul(["Data in `./data/` survives rebuilds (bind mount) — `docker-compose.yml:8,123`.",
              "Re-ingest is idempotent (byte offsets + dedup key), so a rebuilt image re-uses existing data — `README.md:152`.",
              "Last resort for a hung stop: `docker rm -f` — `README.md:371`."])
        + "<h3>Prerequisites</h3>"
        + table(["Tool", "Version", "Why", "Source"], [
            ["Docker + Docker Compose", "not pinned", "run both services", "`README.md:130`"],
            ["Python", "3.12 (3.13/3.14 unsupported)", "local watcher/dbt", "`README.md:183`, `watcher/Dockerfile:1`"],
            ["Node.js", "18+ local; 20 in images and CI", "frontend, verify runner", "`README.md:183`, `frontend/Dockerfile:1`, `ci.yml:106`"],
            ["dbt-core / dbt-duckdb / duckdb", "1.12.0 / 1.10.1 / 1.5.4 (CI pin)", "transforms", "`.github/workflows/ci.yml:65`"],
            ["`@duckdb/node-api`", "1.5.3-r.1", "frontend DB reads", "`frontend/package.json:15`"],
            ["Claude Code transcripts", "at least 1 session in `<user-home>/.claude/projects`", "input data", "`README.md:130`"],
            ["Config names", "`.env`: `AURA_DEFAULT_PERSON_ID`, `AURA_DEFAULT_PERSON_NAME`, `AURA_HASH_CONTENT`, `CLAUDE_LOGS_DIR`", "compose substitution", "`docker-compose.yml:9,63,72-73`"]])
        + "<h3>Access</h3>"
        + table(["What", "Where", "Notes"], [
            ["Dashboard", "`http://localhost:3000`", "no login; port 3000 published by compose"],
            ["Observability", "`http://localhost:3000/observability`", "polls every 10 s"],
            ["JSON API", "`/api/dashboard`, `/api/sessions`, `/api/agents/[name]`, `/api/apps`, `/api/people`, `/api/errors`, `/api/observability`", "11 GET + 1 POST"],
            ["Write DB", "host `data/aura.duckdb` · container `/data/aura.duckdb`", "single writer: do not open while watcher runs"],
            ["Read DB", "host `data/read/aura.duckdb` · container `/data/read/aura.duckdb`", "open `READ_ONLY`"],
            ["dbt artifacts", "`data/artifacts/` (`run_results.json`, `sources.json`, `manifest.json`, `history/`, `number_verify.json`, `ingest_coverage/latest.json`)", "read by `/observability`"],
            ["Logs", "`docker compose logs -f watcher`", "`PYTHONUNBUFFERED=1` → live (`watcher/Dockerfile:6`)"],
            ["Access requests / roles", "Not defined in source — confirm with owner", "—"]])
        + "<h3>Health checks</h3>"
        + ul(["Healthy = fresh `raw_events`, a recent successful dbt run, read DB younger than 1800 s."])
        + table(["Check", "Command / place", "Healthy", "Source"], [
            ["Container health", "`docker compose ps`", "both `healthy`", "`docker-compose.yml:91-102,129-134`"],
            ["Watcher healthcheck rule", "read DB exists and mtime < 1800 s", "exit 0", "`docker-compose.yml:98`"],
            ["Frontend healthcheck", "`wget -q --spider http://$(hostname):3000/`", "exit 0", "`docker-compose.yml:130`"],
            ["Recent ingestion", "SQL below on the read DB", "count > 0 while Claude Code is in use", "project rule `CLAUDE.md` (Goal-Driven Execution)"],
            ["Pipeline page", "`/observability` headline + bronze/dbt/error cards", "bronze < 300 s, dbt < 10 min + success, 0 errors/h", "`frontend/lib/queries/observability.ts:35-46`"],
            ["dbt source freshness", "`sources.json` / observability table", "`raw_events` < 5 min warn, < 30 min error", "`dbt/models/staging/sources.yml:24-25`"],
            ["Number integrity", "`data/artifacts/number_verify.json`", "`fail: 0` of `total: 8`", "`scripts/verify/run_all.mjs:72-174`"],
            ["Watcher errors", "`SELECT source, count(*) FROM watcher_errors WHERE ts > now() - INTERVAL 1 hour GROUP BY 1`", "0 rows", "`duckdb_writer.py:144` (derived)"]])
        + '<div class="payloads">' + payload("IN", "read DB · derived, not run", "SELECT count(*)\nFROM raw_events\nWHERE ts > now() - INTERVAL 5 minutes;", "sql") + "</div>"
        + ul(["Run on `data/read/aura.duckdb` opened read-only; never on the write DB while the watcher runs.",
              "The read DB lags up to 600 s; widen to `INTERVAL 15 minutes` when checking the snapshot.",
              "`ts` is event time (`TIMESTAMP`, no zone); zero rows is normal when nobody is using Claude Code."])
        + '<div class="payloads">' + payload("IN", "one-liner · derived, not run",
            "docker compose exec watcher python -c \"import duckdb; print(duckdb.connect('/data/read/aura.duckdb', read_only=True).sql(\\\"SELECT max(ts), count(*) FILTER (WHERE ts > now() - INTERVAL 15 minutes) FROM raw_events\\\").fetchall())\"") + "</div>"
        + "<h3>Observability thresholds</h3>"
        + table(["Signal", "Green", "Yellow", "Red"], [
            ["bronze age", "< 300 s", "300-1800 s", "≥ 1800 s"],
            ["dbt run", "< 10 min and success", "10-60 min or failed", "> 60 min or no `run_results.json`"],
            ["watcher errors / hour", "0", "1-10", "> 10"]]) + cite("from frontend/lib/queries/observability.ts:35-46")
        + '<div class="payloads">' + payload("OUT", "healthy log excerpt · from main.py:615-670 print strings", "Invoking dbt seed...\nInvoking dbt run...\nInvoking dbt test...") + "</div>"))

    # ---- 14
    S.append(sec("s14", "Operational gotchas", table(["#", "Symptom", "Cause", "What to do", "Source"], cls="cards", rows=[
        ["1", "`raw_events` hours stale", "dbt cycle and snapshot copy hold `_snapshot_lock` back to back", "Keep dbt interval (25 min) above cycle time; snapshot interval (600 s) above copy time", "`README.md:365-367`, `docker-compose.yml:17-36`"],
        ["2", "`Out of Memory … 16383.9 PiB used`", "Orphan spill files after unclean shutdown", "Startup purge handles it; else empty `data/aura.duckdb.tmp/` with watcher stopped", "`main.py:33-90`, `README.md:369`"],
        ["3", "Real OOM in `fact_prompts` full refresh", "Needs the full 4 GB pool", "Keep `AURA_DBT_MEMORY_LIMIT=4000MB` under `mem_limit 5g`; lower dbt threads first", "`README.md:369,380`, `docker-compose.yml:81-109`"],
        ["4", "Turns show `$0.0000`, tests fail on a model", "New model id not in seed", "Add row to `dbt/seeds/model_pricing.csv`", "`fact_model_calls.sql:65-73`"],
        ["5", "Ingestion stops on Windows", "inotify drops events on bind mounts", "Polling observer used; `sweep_worker` re-scans every 600 s", "`main.py:1179-1181,761`"],
        ["6", "dbt views fail on read DB (\"catalog not found\")", "Read DB basename is not `aura.duckdb`", "Keep `read/aura.duckdb`; local dbt copies also named `aura.duckdb`", "`snapshot.py:11-18`, `main.py:981-985`"],
        ["7", "Empty dashboard right after start", "Default range `today`; first snapshot ≤ 600 s, first dbt ~20 min", "Use `?range=30d`; watch `/observability`", "`README.md:141-146`, `frontend/lib/range.ts:3-23`"],
        ["8", "Frontend errors on first run", "Starts before the first snapshot exists (`depends_on` has no health condition)", "Wait for watcher `healthy`", "`docker-compose.yml:127-128`"]])
        + ul(["Windows checkouts: `.gitattributes` forces LF so containers start — `.gitattributes:5-21`.",
              "Code defaults (2 s snapshot, 5 min dbt) are for tests; run with compose values."])))

    # ---- 15
    def st(x):
        return Raw('<span class="st %s">%s</span>' % ("ok" if x == "C" else "nv", "Confirmed" if x == "C" else "Not verified"))

    def wh(*paths):
        return Raw(" ".join("<code>%s</code>" % esc(p) for p in paths))
    I = [
        ("I-1", "`turn_stats` joins turns by session only; multi-cwd session cost lands on every app", wh("dbt/models/marts/dim_apps.sql:68-87"), "`SUM(dim_apps.total_cost)` ~6x spend; `/apps`, top apps, `dim_projects`", "C", "Carry cwd and join on `(tenant_id, session_id, cwd)`"),
        ("I-2", "Tool calls on non-winning streamed events miss their turn", wh("dbt/models/staging/stg_tool_calls.sql:8-30", "dbt/models/marts/fact_turns.sql:36-37", "dbt/models/marts/fact_errors.sql:41-51", "dbt/models/marts/fact_session_files.sql:57"), "~18% executions: tool counts, error turn, file cost low", "C", "Add `message_id` to `stg_tool_calls`; join on it"),
        ("I-3", "Apps total sums all `entity_type` rows", wh("frontend/lib/queries/apps.ts:42-45"), "`/apps` total 2.24x", "C", "Add `entity_type = 'app'`"),
        ("I-4", "All-time projection divisor capped at 14 days", wh("frontend/app/page.tsx:93-97", "frontend/lib/queries/dashboard.ts:5,68"), "30-day projection 6.2x", "C", "Divide by real day span"),
        ("I-5", "Verdict route appends to read-only `/data`", wh("frontend/app/api/sessions/[id]/verdict/route.ts:51", "docker-compose.yml:123"), "Every verdict POST 500 under compose", "C", "Shared rw inbox mount + `AURA_VERDICTS_INBOX` on both"),
        ("I-6", "Observability layer probes use non-existent ts columns; empty catch blanks counts", wh("frontend/lib/queries/observability.ts:921-926,976-1000"), "Gold ages and row counts blank", "C", "Fix 4 column names; split try blocks"),
        ("I-7", "SDK redaction on serialised string", wh("watcher/src/aura_watcher/adapters/sdk_trace.py:177-178"), "Invalid JSON payload; dbt parse fails", "C", "`json.dumps(redact_obj(raw))`"),
        ("I-8", "Range rollups sum session counts per model call", wh("frontend/lib/queries/agents.ts:85-89", "frontend/lib/queries/apps.ts:76-80", "frontend/lib/queries/people.ts:78-82"), "Range turn/tool counts inflated; cost correct", "C", "Aggregate calls per session first"),
        ("I-9", "Joins use `dim_apps.cwd` (one ANY_VALUE cwd)", wh("frontend/lib/queries/sessions.ts:49", "frontend/lib/queries/dashboard.ts:235"), "Sessions drop out or duplicate", "C", "Join `int_app_cwd_lookup`"),
        ("I-10", "Prompts tab effect cancels its own fetch", wh("frontend/components/SessionTabs.tsx:714-724"), "Enriched prompt data never shown", "C", "Drop `enrichedLoading` from deps"),
        ("I-11", "Half-written last line passes the checkpoint", wh("watcher/src/aura_watcher/main.py:294-296,356-357,926-927"), "One event lost per torn read", "N", "Stop before unterminated line on parse failure"),
        ("I-12", "`int_entity_spend` app tools/commits grouped without `project_id`", wh("dbt/models/intermediate/int_entity_spend.sql:96-132"), "Doubled counts for apps in 2 projects", "C", "Add `project_id` to group/join"),
        ("I-13", "`fact_prompts.app_id` from `dim_apps.cwd`", wh("dbt/models/marts/fact_prompts.sql:397-401"), "~14% prompts NULL app", "C", "Use `dim_sessions.app_id`"),
        ("I-14", "`/api/errors` ignores `since`", wh("frontend/app/api/errors/route.ts:4-6"), "Range pills do nothing on `/errors`", "C", "Pass validated `since`"),
        ("I-15", "Unanswered prompts tiered as model tier 1", wh("dbt/models/marts/fact_prompts.sql:429-436,477-487"), "False overkill, NULL reason", "C", "NULL model → NULL tier"),
        ("I-16", "Dispatch tool list `('TaskCreate','Agent')` vs `('Task','Agent')`", wh("dbt/models/marts/fact_prompts.sql:255", "dbt/models/intermediate/int_event_agent.sql:27"), "Legacy dispatches missed", "C", "Use `('Task','Agent')`"),
        ("I-17", "Observability headline ignores `dbt_status`", wh("frontend/app/observability/PipelineLive.tsx:281-401"), "Stale dbt shows \"All systems nominal\"", "C", "Add dbt status to verdict"),
        ("I-18", "dbt subprocesses have no timeout under the lock", wh("watcher/src/aura_watcher/main.py:614,627,649,669"), "Hung dbt freezes all ingestion", "C", "Add timeout; log after release"),
        ("I-19", "`fact_session_files.edit_count` counts Reads; duration not divided by k", wh("dbt/models/marts/fact_session_files.sql:21,64-67"), "File metrics overstated", "C", "Count Edit/Write only; divide by k"),
        ("I-20", "Lifetime agent cost by session's mode agent; range by call", wh("dbt/models/marts/dim_agents.sql:22-27", "dbt/models/intermediate/int_entity_spend.sql:136-147"), "`/agents` differs by range", "C", "See decision D-1"),
        ("I-21", "Residual cache creation priced at 1h rate", wh("dbt/models/marts/fact_model_calls.sql:55-59"), "Old-log cost overstated", "C", "See decision D-4"),
        ("I-22", "`dim_sessions.status` never `active`", wh("dbt/models/marts/dim_sessions.sql:254"), "No live-session status", "C", "Derive from last activity"),
        ("I-23", "`dbt_worker` hard-codes `/data/artifacts`", wh("watcher/src/aura_watcher/main.py:679"), "`AURA_ARTIFACTS_DIR` splits artifacts", "C", "Pass `artifacts_dir` to `dbt_worker`"),
        ("I-24", "Coverage counts workflow journals", wh("watcher/src/aura_watcher/main.py:746-752"), "Coverage never reaches full", "C", "Apply `is_workflow_journal` filter"),
        ("I-25", "`session_id` fallback: folder vs file stem", wh("watcher/src/aura_watcher/adapters/claude.py:131-134", "watcher/src/aura_watcher/main.py:407"), "Rare files split across 2 ids", "C", "One stem-based helper"),
        ("I-26", "`int_turns` header says sidechain prompt NULL; code attaches it", wh("dbt/models/intermediate/int_turns.sql:11-12,133-136"), "Code vs docs mismatch", "C", "Fix comment or add CASE"),
        ("I-27", "Parse errors logged outside the lock", wh("watcher/src/aura_watcher/main.py:322,329,344"), "Error rows lost while dbt runs", "C", "Log inside write block"),
        ("I-28", "Frontend port on all interfaces, no auth", wh("docker-compose.yml:120-121"), "LAN can read transcripts", "C", "See decision D-3"),
        ("I-29", "Image deps lower-bound only; CI pins", wh("watcher/pyproject.toml:12-17"), "Rebuild may change DuckDB file format", "C", "See decision D-5"),
        ("I-30", "CI runs dbt parse/compile only", wh(".github/workflows/ci.yml:47-95"), "dbt tests and Docker builds unchecked", "C", "Add fixture ingest + `dbt build`"),
        ("I-31", "Docs drift: dbt 5 min / snapshot 2 s / backfill order / Streamlit", wh("README.md:222", "docs/HOW-IT-WORKS.md:22-24", "CLAUDE.md:3"), "Operators misled", "C", "Align docs to compose values"),
        ("I-32", "Truncated file not picked by backfill/sweep (`offset < size`)", wh("watcher/src/aura_watcher/main.py:168-175"), "Rotated files missed if observer freezes", "N", "Use `!=` if truncation happens"),
        ("I-33", "Naive-UTC `ts` vs session `CURRENT_DATE`/`NOW()`", wh("dbt/models/marts/fact_hourly_activity.sql:24-25", "dbt/models/marts/fact_spend_pace.sql:25,103"), "Day/hour shift if TZ not UTC", "N", "`SET TimeZone='UTC'`"),
        ("I-34", "musl image + `@duckdb/node-api` native module", wh("frontend/Dockerfile:1-17"), "Frontend may fail first query", "N", "Build and load `/`; else `node:20-slim`"),
    ]
    assert len(I) == 34 and sum(1 for r in I if r[4] == "N") == 4
    ihead = ["#", "Issue", "Where (path:line)", "Impact", "Status", "Suggested fix"]
    irows = lambda rs: [[r[0], r[1], r[2], r[3], st(r[4]), r[5]] for r in rs]
    issues = (table(ihead, irows(I[:10]), "issues")
              + "<details><summary>24 more issues (I-11 to I-34)</summary>" + table(ihead, irows(I[10:]), "issues") + "</details>")
    asm = [
        ["Compose (`docker-compose.yml`) is the supported deployment", "All intervals, limits and paths here are compose values, not code defaults"],
        ["Single tenant `local`", "`fact_errors` and pricing tenant logic untested for more tenants"],
        ["Container process time zone is UTC", "Daily/hourly rollups and `rangeSince` assume it"],
        ["Claude Code only appends to transcripts", "Truncation handling (I-32) matters only if files shrink"],
        ["Issue sizes are from a 2026-08-21 snapshot", "Current ratios may differ; re-measure before quoting"],
        ["JSONL schema is undocumented", "Parsing rules reflect observed fields; new event types may be dropped"]]
    dec = ["**D-1 Agent cost attribution:** per model call (recommended) or session's dominant agent — until then `/agents` lifetime and range totals differ.",
           "**D-2 Verdict inbox location:** shared rw mount `./data/inbox` (recommended) or drop verdicts — until then every verdict save fails under compose.",
           "**D-3 Dashboard binding:** `127.0.0.1:3000` (recommended) or LAN with auth — until then anyone on the network can read transcripts.",
           "**D-4 Residual cache-write rate:** 5m rate (recommended, default TTL) or keep 1h — until then old-log cost stays overstated.",
           "**D-5 Version pinning:** pin `duckdb==1.5.4` + CI dbt versions in the image (recommended) or keep lower bounds — until then a rebuild can break reader compatibility.",
           "**D-6 `/sessions` totals:** label \"sessions started in range\" (recommended) or switch to spend-in-range — until then `/sessions` and the dashboard disagree on boundary days."]
    decl = "<ul>" + "".join("<li>%s</li>" % re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", md(d)) for d in dec) + "</ul>"
    S.append(sec("s15", "Known issues, assumptions, and decisions needed",
        ul(["Status: Confirmed = kept as must/should after the 2026-11-10 review's verification; Not verified = marked plausible or a question there, or inferred in the graph review.",
            "Sizes measured on a read snapshot dated 2026-08-21."])
        + "<h3>Issues</h3>" + issues + cite("from reviews/review-2026-11-10-1853.html (must/should/question items)")
        + ul(["The review asked whether the frontend has a memory limit; compose sets `mem_limit 512m` (`docker-compose.yml:135`). Open part: DuckDB threads/memory are not set (`frontend/lib/db.ts:42`) — Not verified."])
        + "<h3>Assumptions</h3>" + table(["Assumption", "Why it matters"], asm)
        + "<h3>Decisions needed</h3>" + decl))

    return S, n_edges, (0, 0, scale)


EXTRA_CSS = """
main{max-width:1100px} h3{font-size:15px;font-weight:600;margin:18px 0 6px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px}
.chips span{font-family:"IBM Plex Mono",Consolas,monospace;font-size:12px;background:var(--soft);border:1px solid var(--line);border-radius:4px;padding:2px 8px}
nav.toc{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 24px;margin:14px 0}
nav.toc ol{margin:0;padding-left:22px;columns:3;font-size:14px} nav.toc a{color:var(--ink)}
.cite{font-family:"IBM Plex Mono",Consolas,monospace;font-size:11px;color:var(--muted);margin:4px 0 8px}
.ex .cite{padding:0 10px 8px;margin:0}
.ex td{white-space:normal;word-break:break-word} .ex td:first-child{white-space:nowrap}
.exset{grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
pre.tree{background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:12px 14px;font-size:12.5px;overflow-x:auto}
td.v,td.v code{font-family:"IBM Plex Mono",Consolas,monospace}
table code{white-space:normal;word-break:break-word}
.map .b ul{list-style:disc} .map .lane{border-top:0}
.map .b.c .sub{display:block} .map .b .sub{display:block;font-size:11.5px;color:var(--muted)}
.map-wrap svg text{font-family:"Courier New",Consolas,monospace}
.journey .stage .h small{display:block} .journey{align-items:start} .map code{white-space:normal;word-break:break-all}
body{overflow-wrap:anywhere} code,.cite{white-space:normal !important;overflow-wrap:anywhere;word-break:break-all} .map-wrap{max-width:100%;-webkit-overflow-scrolling:touch}
.map{margin:0 !important} .map-wrap svg[role=img]{min-width:760px}
main>section>table,section>table,.ex table{display:block;max-width:100%;overflow-x:auto}
.otabs{position:relative;margin:14px 0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px 4px}
.otabs input{position:absolute;opacity:0;width:1px;height:1px}
.otabs label{display:inline-block;font-family:"IBM Plex Mono",Consolas,monospace;font-size:12.5px;border:1px solid var(--ink);border-radius:4px;padding:3px 12px;margin:0 6px 8px 0;cursor:pointer;background:var(--card);color:var(--ink)}
.otabs input:checked+label{background:var(--ink);color:#fff}
.otabs input:focus-visible+label{outline:2px solid #1F5FA8;outline-offset:2px}
.otabs .op{display:none;clear:both}
#ot1:checked~#op1,#ot2:checked~#op2,#ot3:checked~#op3,#ot4:checked~#op4{display:block}
.otabs .pt{display:none;font-size:14px;margin:8px 0 2px}
.otabs ul,.otabs ol{margin:4px 0 8px;padding-left:20px;font-size:14px}
.st{font-family:"IBM Plex Mono",Consolas,monospace;font-size:11px;border:1px solid var(--line);border-radius:4px;padding:1px 6px;white-space:nowrap}
.st.ok{background:#E3F1E8;border-color:#9CC9AE;color:#1E6B43}.st.nv{background:#FCEBC8;border-color:#E0B25C;color:#8A5A00}
table.issues td:nth-child(3) code{display:block}
table.steps td:first-child,table.issues td:first-child{white-space:nowrap}
details{margin:10px 0}summary{cursor:pointer;font-weight:600;font-size:14px;margin-bottom:6px}
@media print{.otabs label{display:none}.otabs .op{display:block !important;break-inside:avoid}.otabs .pt{display:block}details{display:block}}
@media (max-width:700px){nav.toc ol{columns:1} main{padding-left:16px;padding-right:16px}}
@media print{nav.toc{display:none}}
.cite{word-break:normal !important}
@media (max-width:700px){
.map-wrap:has(>.map)::before{content:"Narrow screen: boxes in reading order, arrows hidden.";display:block;font:11px "IBM Plex Mono",Consolas,monospace;color:var(--muted);margin-bottom:6px}
.map{width:auto !important;height:auto !important;display:flex;flex-direction:column;gap:8px}
.map>svg,.map .lbl,.map .num,.map .lane{display:none}
.map .b{position:static !important;width:auto !important;height:auto !important}
.map .b.decision{border:1px solid #6B4FA8;background:#E7E2F5;border-radius:8px;padding:8px 12px}
.map .grp{position:static !important;width:auto !important;height:auto !important;border:0;border-top:1px dashed #9AA0A8;border-radius:0;padding-top:4px}
.map .grp span{position:static}
table.issues,table.cards{display:block !important;overflow:visible !important}
table.issues thead,table.cards thead{display:none}
table.issues tbody,table.issues tr,table.issues td,table.cards tbody,table.cards tr,table.cards td{display:block;width:auto}
table.issues tr,table.cards tr{border:1px solid var(--line);border-radius:6px;margin:8px 0;padding:6px 10px;background:var(--card)}
table.issues td,table.cards td{border:0;padding:3px 0;white-space:normal !important}
table.issues td::before,table.cards td::before{content:attr(data-l);display:block;font:10.5px "IBM Plex Mono",Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
table.issues td code{display:inline}
table.issues td code,table.cards td code{word-break:normal;overflow-wrap:anywhere}
table.issues td:first-child::before,table.cards td:first-child::before{display:none}
table.issues td:first-child,table.cards td:first-child{font-weight:600}
}
"""



def otabs():
    P = [("Does", ["`watcher` ingests Claude Code and SDK-trace JSONL into DuckDB `raw_events`, oldest file first.",
                   "`redact.py` scrubs secrets from `payload` before write; optional SHA-256 content hashing.",
                   "`dbt_worker` builds 29 dbt models every cycle; cost priced per model call.",
                   "`snapshot_worker` publishes a read-only copy `data/read/aura.duckdb` every 600 s.",
                   "`frontend` serves 13 pages and 12 API handlers on `:3000`; `/observability` shows pipeline health."]),
         ("Doesn't", ["Doesn't change or delete transcripts — logs mounted read-only (`/logs/claude:ro`).",
                      "Doesn't authenticate users or manage access — no login, no roles.",
                      "Doesn't fetch prices — only `dbt/seeds/model_pricing.csv`.",
                      "Doesn't use cron or Airflow — dbt runs as a watcher subprocess.",
                      "Doesn't deploy anywhere — CI checks only; Gemini/Codex adapters not built."]),
         ("Limitations", ["Dashboard lags: snapshot every 600 s plus dbt cycle (~20 min run, 25 min sleep).",
                          "One writer: dbt holds `_snapshot_lock` for its whole run; ingestion waits.",
                          "Incremental models reprocess only sessions touched in the last 24 h.",
                          "dbt test failures don't block model refresh (`dbt run`, not `dbt build`).",
                          "One machine, one tenant (`local`); dbt pool 4000 MB inside a 5 GB container."]),
         ("Top issues", ["`dim_apps` puts a session's full cost under every app it touched (~6x spend) — Confirmed",
                         "Tool calls on earlier streamed events miss their turn (~18% of executions) — Confirmed",
                         "`/apps` total sums app, agent and person rows of `int_entity_spend` (2.24x) — Confirmed",
                         "All-time 30-day projection divides by at most 14 days (6.2x) — Confirmed",
                         "Verdict POST cannot write: frontend mounts `/data` read-only — Confirmed",
                         "`/observability` gold-layer ages and row counts always blank — Confirmed",
                         "SDK-trace redaction can produce invalid JSON payloads — Confirmed",
                         "Range views multiply session turn/tool counts by calls per session — Confirmed",
                         "Session Prompts tab discards its enriched fetch — Confirmed",
                         "Half-written last line can be skipped by the checkpoint — Not verified"])]
    h = '<div class="otabs">'
    for n, (t, _) in enumerate(P, 1):
        h += '<input type="radio" name="ot" id="ot%d"%s><label for="ot%d">%s</label>' % (n, " checked" if n == 1 else "", n, esc(t))
    for n, (t, items) in enumerate(P, 1):
        lis = "".join("<li>%s</li>" % md(x) for x in items)
        h += '<div class="op" id="op%d"><h3 class="pt">%s</h3>%s</div>' % (n, esc(t), ("<ol>%s</ol>" if n == 4 else "<ul>%s</ul>") % lis)
    return h + "</div>" + cite("Top issues: full detail in section 15. Status rule: Confirmed = kept after the 2026-11-10 review's verification pass; Not verified = marked plausible or a question there.")


def main():
    S, n_edges, lin = build()
    ex_css = EXAMPLE.read_text(encoding="utf-8")
    css = re.search(r"<style>(.*?)</style>", ex_css, re.S).group(1) + EXTRA_CSS
    titles = ["Big picture", "Architecture", "Flow: ingest and backfill", "Flow: dbt cycle and snapshot", "Flow: page load",
              "Flow: cost calculation", "Data model", "dbt lineage", "Business rules", "Configuration", "Folder tree", "Commands",
              "Deploy and access", "Operational gotchas", "Known issues, assumptions, and decisions needed"]
    assert len(S) == len(titles)
    S = [re.sub(r"<h2>", "<h2>%d · " % (i + 1), x, count=1) for i, x in enumerate(S)]
    toc = "".join('<li><a href="#s%d">%s</a></li>' % (i + 1, t) for i, t in enumerate(titles))
    chips = "".join("<span>%s</span>" % esc(c) for c in ["watcher · Python 3.12", "dbt-core 1.12.0 / dbt-duckdb 1.10.1 (CI pin)", "duckdb 1.5.4 (CI pin)",
                    "Next.js 14.2.3", "@duckdb/node-api 1.5.3-r.1", "docker compose: 2 services"])
    head = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            '<meta name="generator" content="darshan-singh-meel-docs"><title>Aura technical</title><style>%s</style></head><body><main>' % css)
    top = ('<div class="eyebrow">Technical document</div><h1>Aura technical</h1>%s<div class="chips">%s</div>'
           '<p class="cite">pins from .github/workflows/ci.yml:65, frontend/package.json:12,15</p><nav class="toc"><ol>%s</ol></nav>' % (otabs(), chips, toc))
    OUT.write_text(head + top + chr(10).join(S) + "</main></body></html>", encoding="utf-8")
    print("wrote", OUT.relative_to(ROOT), OUT.stat().st_size, "bytes; lineage edges", n_edges)


if __name__ == "__main__":
    main()
