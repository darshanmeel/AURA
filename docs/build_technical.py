#!/usr/bin/env python3
"""Builds docs/technical.html (self-contained). Run from the repo root: python docs/build_technical.py
Diagrams are generated here and injected between <!--map:NAME--> ... <!--/map:NAME-->.
Lineage uses Graphviz `dot` (temp files are deleted)."""
import csv, html, math, re, subprocess, sys, tempfile
from functools import lru_cache
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


# ---------------------------------------------------------------- source line numbers
WSRC = "watcher/src/aura_watcher/"


@lru_cache(maxsize=None)
def _lines(path):
    return (ROOT / path).read_text(encoding="utf-8").splitlines()


def at(path, pat, to=None):
    """'path:N' for the first line matching regex `pat`; 'path:N-M' when `to` is given
    (M = first line at or after N matching `to`). Fails when a pattern is absent."""
    ls = _lines(path)
    n = next((i for i, s in enumerate(ls, 1) if re.search(pat, s)), None)
    assert n, "%s: no line matches %r" % (path, pat)
    if to is None:
        return "%s:%d" % (path, n)
    m = next((i for i in range(n, len(ls) + 1) if re.search(to, ls[i - 1])), None)
    assert m, "%s: no line matches %r after line %d" % (path, to, n)
    return "%s:%d-%d" % (path, n, m)


def W(f, pat, to=None):
    return at(WSRC + f, pat, to)


def S(f, pat, to=None):
    """short cite (file name only) for diagram boxes"""
    return at(WSRC + f, pat, to).rsplit("/", 1)[-1]


def c(x):
    return "`%s`" % x


# ---------------------------------------------------------------- facts read from the repo
sys.path.insert(0, str(ROOT / "watcher/src"))
from aura_watcher import lake  # noqa: E402  (KEYS and SCHEMAS are the watcher -> dbt contract)

MODEL_FILES = sorted((ROOT / "dbt/models").glob("*/*.sql"))
MAT = {p.stem: re.search(r"materialized\s*=\s*'(\w+)'", p.read_text(encoding="utf-8")).group(1) for p in MODEL_FILES}
LAYER = {p.stem: p.parent.name for p in MODEL_FILES}


def n_generic_tests():
    import yaml
    n = 0
    for f in (ROOT / "dbt/models").glob("*/schema.yml"):
        for m in yaml.safe_load(f.read_text(encoding="utf-8")).get("models", []):
            n += len(m.get("data_tests") or m.get("tests") or [])
            for col in m.get("columns", []):
                n += len(col.get("data_tests") or col.get("tests") or [])
    return n


N_SINGULAR = len(list((ROOT / "dbt/tests").glob("*.sql")))
N_TEST_FILES = len(list((ROOT / "watcher/tests").glob("test_*.py")))
N_TESTS = sum(len(re.findall(r"^def test_", p.read_text(encoding="utf-8"), re.M)) for p in (ROOT / "watcher/tests").glob("test_*.py"))


# ================================================================ DIAGRAMS
def d_l0():
    cv = Cv("l0", 1000, 470)
    W_, H = 230, 96
    cv.box(0, 40, W_, H, "c actor", title="Developer using Claude Code")
    cv.box(385, 40, W_, H, "c data", "DATA", "JSONL transcripts", "`<user-home>/.claude/projects/**/*.jsonl`")
    cv.box(770, 40, W_, H, "c entry", "ENTRY", "watcher main loop", "parse · redact · buffer")
    cv.box(770, 190, W_, H, "c data", "DATA", "Parquet lake", "`data/<user>/lake/`")
    cv.box(385, 190, W_, H, "c routine", "THREAD", "dbt cycle", "work DB `work/aura.duckdb`")
    cv.box(385, 340, W_, H, "c data", "DATA", "published read DB", "`read/v<stamp>/` + `CURRENT`")
    cv.box(0, 340, W_, H, "c", "APP", "Next.js dashboard", "`localhost:3000`")
    cv.poly([(W_, 88), (385, 88)]); cv.lblv(307, 88, "appends 1 line|per event"); cv.num(307, 88, 1)
    cv.poly([(615, 88), (770, 88)], True); cv.lblv(692, 88, "poll 30 s|sweep 600 s"); cv.num(692, 88, 2)
    cv.poly([(885, 136), (885, 190)], True); cv.lbl(893, 155, "flush every", align="l"); cv.lbl(893, 170, "30 s", align="l"); cv.num(885, 163, 3)
    cv.poly([(770, 238), (615, 238)], True); cv.lblv(692, 238, "dbt reads|every 5 min"); cv.num(692, 238, 4)
    cv.poly([(500, 286), (500, 340)]); cv.lbl(508, 306, "publish,", align="l"); cv.lbl(508, 321, "switch CURRENT", align="l"); cv.num(500, 313, 5)
    cv.poly([(385, 388), (230, 388)], True); cv.lblv(307, 388, "read-only|queries"); cv.num(307, 388, 6)
    cv.poly([(115, 340), (115, 136)]); cv.lbl(123, 215, "cost +", align="l"); cv.lbl(123, 230, "behaviour", align="l"); cv.num(115, 238, 7)
    return cv.html()


def d_l2():
    cv = Cv("l2", 1000, 850)
    FH = 750
    cv.frame(0, 40, 136, FH, "HOST")
    cv.box(6, 176, 124, 104, "data", "DATA", "CLAUDE_LOGS_DIR", "`<user-home>/`|`.claude/`|`projects`", mono=True)
    cv.box(6, 640, 124, 64, "data", "DATA", "./data/<user>", "bind mount", mono=True)
    cv.frame(190, 40, 550, FH, "CONTAINER watcher", "python:3.12-slim · mem_limit 5g|init: true · restart unless-stopped")
    R = [("main()", "ENTRY · config, startup, run loop", S("main.py", r"^def main"), "routine entry"),
         ("observer → dirty queue", "PollingObserver · logical paths", S("main.py", r"^class _Handler"), "routine"),
         ("process_file → adapters", "adapters: parse, redact, buffer", S("ingest.py", r"^def process_file"), "routine"),
         ("flush every 30 s", "Parquet first, then SQLite checkpoint", S("ingest.py", r"^def flush"), "routine"),
         ("_dbt_loop → run_cycle", "every 5 min: seed, run, retry", S("main.py", r"^def _dbt_loop") + ", " + S("dbt_cycle.py", r"^def run_cycle"), "routine"),
         ("publish", "read_tables.sql → read/v<stamp>", S("dbt_cycle.py", r"^def publish"), "routine"),
         ("compaction every 600 s", "merge small lake files, verify row count", S("lake.py", r"^def compact"), "routine")]
    for i, (t, sub, cit, k) in enumerate(R):
        cv.box(205, 100 + 76 * i, 280, 64, k, title=t, sub=sub, cite_=cit, mono=True)
    cv.box(205, 650, 280, 52, "data", title="flush_lock · lake_lock", cite_=S("lake.py", r"^flush_lock =", r"^lake_lock ="), mono=True)
    DX, DW = 580, 140
    cv.box(DX, 296, DW, 56, "data", title="state/|aura_state.sqlite", sub="checkpoints", mono=True)
    cv.box(DX, 372, DW, 56, "data", title="lake/", sub="Parquet · date=<d>", mono=True)
    cv.box(DX, 448, DW, 56, "data", title="work/aura.duckdb", sub="dbt work DB", mono=True)
    cv.box(DX, 524, DW, 56, "data", title="read/v<stamp>/|+ CURRENT", sub="read DB", mono=True)
    cv.box(DX, 600, DW, 56, "data", title="artifacts/", sub="status + dbt JSON", mono=True)
    cv.box(DX, 690, DW, 56, "data", title="inbox/|verdicts-inbox.jsonl", sub="read by dbt", mono=True)
    cv.frame(770, 40, 230, FH, "CONTAINER frontend", "node:20-slim|Next standalone :3000|/data ro · inbox rw|mem_limit 1536m")
    cv.box(785, 100, 200, 56, "routine", title="app/**/page.tsx", sub="force-dynamic RSC", mono=True)
    cv.box(785, 180, 150, 56, "routine", title="app/api/**/route.ts", sub="12 handlers", mono=True)
    cv.box(785, 510, 200, 84, "routine", title="lib/db.ts query()", sub="CURRENT cached 1 s, READ_ONLY, 15 s timeout", mono=True)
    cv.box(785, 600, 200, 56, "routine", title="queries/observability.ts", sub="reads artifacts JSON", mono=True)
    cv.box(785, 690, 200, 56, "routine", title="api/sessions/[id]/verdict", sub="appends to inbox", mono=True)
    cv.box(800, 0, 200, 30, "c actor", title="Browser · GET /?range=7d", mono=True)
    cv.poly([(130, 208), (205, 208)], True); cv.lbl(167, 194, "ro mount")
    for i in (0, 1, 2, 4):
        cv.poly([(345, 100 + 76 * i + 64), (345, 100 + 76 * (i + 1))])
    cv.poly([(485, 340), (DX, 340)], True); cv.lbl(532, 326, "commit")
    cv.poly([(485, 380), (DX, 380)], True); cv.lbl(532, 366, "write")
    cv.poly([(DX, 420), (485, 420)], True); cv.lbl(532, 406, "read")
    cv.poly([(485, 460), (DX, 460)], True); cv.lbl(532, 446, "dbt run")
    cv.poly([(DX, 494), (485, 494)], True); cv.lbl(532, 480, "attach ro")
    cv.poly([(485, 534), (DX, 534)], True); cv.lbl(532, 520, "copy")
    cv.poly([(130, 672), (190, 672)], True); cv.lbl(160, 658, "rw /data")
    cv.poly([(68, 704), (68, 820), (880, 820), (880, 790)], True); cv.lbl(500, 806, "ro /data (inbox rw)")
    cv.poly([(720, 550), (785, 550)], True); cv.lbl(752, 536, "ro")
    cv.poly([(720, 628), (785, 628)], True); cv.lbl(752, 614, "ro")
    cv.poly([(785, 718), (720, 718)], True); cv.lbl(752, 704, "append")
    cv.poly([(970, 30), (970, 100)])
    cv.poly([(960, 156), (960, 510)]); cv.poly([(860, 236), (860, 510)])
    return cv.html()


def d_ingest():
    steps = [
        dict(id="s1", lane=1, row=0, kind="entry", tag="STEP 1", title="`startup`",
             bul=["mode guard, `clean_tmp`, `ensure_tables`", "purge DuckDB spill dir, open SQLite"], inn="`env vars`", out="`ctx` + checkpoints in memory"),
        dict(id="s2", lane=1, row=1, kind="routine", tag="STEP 2", title="`run()` start threads",
             bul=["observer thread, dbt thread", "then the startup sweep"], inn="`ctx`", out="`2 threads`"),
        dict(id="f3", lane=0, row=2, kind="data", tag="DATA", title="`*.jsonl` files", sub="host transcripts, read-only"),
        dict(id="s3", lane=1, row=2, kind="routine", tag="STEP 3", title="`sweep` + `list_files`",
             bul=["oldest mtime first", "queue files where size != offset"], inn="e.g. `15,000 files`", out="e.g. `200 queued`"),
        dict(id="f4", lane=0, row=3, kind="data", tag="DATA", title="file grew", sub="live append to a `*.jsonl`"),
        dict(id="s4", lane=1, row=3, kind="routine", tag="STEP 4", title="`dirty` queue",
             bul=["observer enqueues `*.jsonl` only", "main loop pops one path per turn"], inn="logical path", out="`process_file(path)`"),
        dict(id="s5", lane=1, row=4, kind="routine", tag="STEP 5", title="`process_file` from checkpoint",
             bul=["`needs_read`: offset or reset", "torn last line is left unread"], inn="`last_offset=5000`", out="`bytes 5000..EOF`"),
        dict(id="d5", lane=1, row=5, kind="dec", title="`size < offset` or new head hash?"),
        dict(id="y5", lane=0, row=5, kind="step", tag="YES", title="reset offset to 0", bul=["replace file stats"]),
        dict(id="s6", lane=2, row=6, kind="routine", tag="STEP 6", title="`ClaudeAdapter.parse_line`",
             bul=["maps type, usage, model, message.id, sessionId, cwd", "`redact_obj` then `json.dumps`"], inn="`1 JSON line`", out="`1 row or None`"),
        dict(id="x6", lane=1, row=6, kind="fail", tag="FAILURE", title="parse fails",
             bul=["`parse_errors` +1", "`watcher_errors` row"]),
        dict(id="s7", lane=1, row=7, kind="routine", tag="STEP 7", title="append to buffers",
             bul=["one buffer per lake table", "pending checkpoint stashed"], inn="`1 row`", out="`buffer +1`"),
        dict(id="s8", lane=3, row=8, kind="data", tag="STEP 8", title="`flush` every 30 s",
             bul=["under `flush_lock`, stamp `ingested_at`", "`part-*.parquet` via tmp + rename"], inn="`N buffered rows`", out="`N rows in lake`"),
        dict(id="s9", lane=3, row=9, kind="data", tag="STEP 9", title="`commit_flush` to SQLite",
             bul=["one transaction", "only after all files exist"], inn="`pending offsets`", out="`last_offset = size`"),
    ]
    arrows = [dict(a="s1", b="s2"), dict(a="s2", b="s3"), dict(a="f3", b="s3", style="dash"), dict(a="s3", b="s4"),
              dict(a="f4", b="s4", style="dash"), dict(a="s4", b="s5"), dict(a="s5", b="d5"),
              dict(a="d5", b="y5", label="yes"), dict(a="d5", b="s6", label="no", ymid=-8),
              dict(a="y5", b="s6", toff=-45, ymid=10, soff=0), dict(a="s6", b="x6", style="fail"),
              dict(a="s6", b="s7"), dict(a="s7", b="s8"), dict(a="s8", b="s9")]
    cv, H = swim("ingest", 1000, ["FILESYSTEM", "WATCHER main thread", "ADAPTER", "LAKE + SQLITE"], steps, arrows, boxw=214)
    return cv.html()


def d_dbtcycle():
    steps = [
        dict(id="d1", lane=0, row=0, kind="dec", title="`interval <= 0?`"),
        dict(id="x1", lane=1, row=0, kind="step", tag="YES", title="thread exits"),
        dict(id="d2", lane=0, row=1, kind="dec", title="same `fingerprint`, published < 1 h?"),
        dict(id="x2", lane=1, row=1, kind="step", tag="YES", title="status `skipped`", bul=["wait out the interval"]),
        dict(id="s3", lane=0, row=2, kind="routine", tag="STEP 3", title="purge spill dir, take cutoff",
             bul=["cutoff = now, under `flush_lock`", "dbt reads `ingested_at <= cutoff`"], inn="`lake` state", out="`aura_cutoff`"),
        dict(id="s4", lane=0, row=3, kind="routine", tag="STEP 4", title="acquire `lake_lock`",
             bul=["held for seed + run + publish", "compaction skips meanwhile"], inn="`—`", out="`lock held`"),
        dict(id="s5", lane=1, row=4, kind="routine", tag="STEP 5", title="`dbt seed`",
             bul=["`--profiles-dir . --no-partial-parse`", "loads `model_pricing.csv`"], inn="`%d seed rows`" % len(SEED), out="`model_pricing`"),
        dict(id="s6", lane=1, row=5, kind="routine", tag="STEP 6", title="`dbt run`",
             bul=["`run`, not `build`: models refresh even if tests fail", "incremental models rebuild touched sessions"], inn="lake Parquet", out="`%d models`" % len(MODEL_FILES)),
        dict(id="f6", lane=0, row=5, kind="fail", tag="FAILURE", title="`dbt run` failed",
             bul=["`dbt retry`: failed + skipped models", "still failing: previous read DB stays live"]),
        dict(id="s7", lane=2, row=6, kind="data", tag="STEP 7", title="`publish`",
             bul=["`read_tables.sql` into `read/v<stamp>/`", "atomic `CURRENT` switch"], inn="`work/aura.duckdb`", out="`read/CURRENT = v<stamp>`"),
        dict(id="s8", lane=1, row=7, kind="routine", tag="STEP 8", title="release lock; `dbt test`",
             bul=["then `dbt source freshness`", "failures logged, never block publish"], inn="work DB", out="`run_results.json`"),
        dict(id="s9", lane=0, row=8, kind="routine", tag="STEP 9", title="copy artifacts; `node run_all.mjs`",
             bul=["60 s timeout, non-blocking", "8 integrity checks on the read DB"], inn="`target/*.json`", out="`artifacts/*.json`"),
        dict(id="s10", lane=0, row=9, kind="routine", tag="STEP 10", title="wait `interval - elapsed`",
             bul=["start-to-start, 5 min by default"], inn="`—`", out="`next cycle`"),
    ]
    arrows = [dict(a="d1", b="x1", label="yes"), dict(a="d1", b="d2", label="no"), dict(a="d2", b="x2", label="yes"),
              dict(a="d2", b="s3", label="no"), dict(a="s3", b="s4"), dict(a="s4", b="s5"), dict(a="s5", b="s6"),
              dict(a="s6", b="f6", style="fail"), dict(a="s6", b="s7"), dict(a="s7", b="s8"), dict(a="s8", b="s9"),
              dict(a="s9", b="s10")]
    cv, H = swim("dbtcycle", 1000, ["dbt thread _dbt_loop", "dbt SUBPROCESS cwd dbt/", "publish"], steps, arrows, boxw=290)
    return cv.html()

def d_pageload():
    steps = [
        dict(id="b0", lane=0, row=0, kind="actor", title="Browser"),
        dict(id="s1", lane=1, row=0, kind="routine", tag="STEP 1", title="`GET /?range=7d`",
             bul=["route `/`, `force-dynamic`"], inn="`URL`", out="`route /`"),
        dict(id="s2", lane=2, row=1, kind="routine", tag="STEP 2", title="`parseRange`, `rangeSince`", inn="`7d`", out="`since` ISO timestamp"),
        dict(id="s3", lane=2, row=2, kind="routine", tag="STEP 3", title="`Promise.all` of 17 `safe(...)`", inn="`since`", out="`17 promises`"),
        dict(id="f3", lane=2, row=3, kind="fail", tag="FAILURE", title="mart missing", bul=["`safe()` returns fallback", "one panel empty"]),
        dict(id="s4", lane=3, row=3, kind="routine", tag="STEP 4", title="`getInstance()` CURRENT check", inn="`read/CURRENT` (cached 1 s)", out="cached or new `READ_ONLY` instance"),
        dict(id="s5", lane=3, row=4, kind="routine", tag="STEP 5", title="`runAndReadAll`", bul=["`(sql, params)`, 15 s timeout"], inn="SQL + `?` params", out="`rows`"),
        dict(id="db", lane=4, row=4, kind="data", tag="DATA", title="READ DB", sub="`read/<CURRENT>/aura.duckdb`"),
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
        dict(id="mp", lane=1, row=3, kind="data", tag="SEED", title="`model_pricing`", sub="per-Mtok rates, %d rows" % len(SEED)),
        dict(id="s3", lane=2, row=3, kind="routine", tag="STEP 3", title="`fact_model_calls.calculated_cost`",
             bul=["`sdk_trace`: `COALESCE(reported_cost_usd, 0)`", "else tokens × rate / 1e6", "residual cache write at 5m rate"], inn="tokens + pricing row", out="USD per call"),
        dict(id="d3", lane=2, row=4, kind="dec", title="`sdk_trace`? else pricing row found?"),
        dict(id="f3", lane=3, row=4, kind="fail", tag="FAILURE", title="`NULL` cost", bul=["`not_null` test fails", "`fact_turns` keeps `NULL`"]),
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


def lake_rows(table):
    """entity rows for a lake table: key columns as PK, then a '+ N columns' summary"""
    keys = lake.KEYS[table] or []
    cols = [col for col, _ in lake.SCHEMAS[table]]
    rest = [col for col in cols if col not in keys]
    return [(k, "PK", "") for k in keys] if keys else [("no primary key", "", "")], len(rest)


def d_er_raw():
    cv = Cv("er_raw", 1000, 660)
    w = 250
    k, n = lake_rows("raw_events")
    re_ = ent(cv, 0, 0, w, "raw_events", "lake · Parquet", "1 row per JSONL line with uuid + timestamp",
              k + [("session_id", "FK", ""), ("file_path", "FK", ""), ("message_id", "", ""), ("+ %d columns" % (n - 3), "", "")])
    k, n = lake_rows("session_meta")
    sm = ent(cv, 375, 0, w, "session_meta", "lake · Parquet", "1 row per observation, append-only",
             [("tenant_id", "", ""), ("session_id", "", "")] + k + [("+ %d columns" % (n - 2), "", "")])
    k, n = lake_rows("raw_session_skills")
    sk = ent(cv, 750, 0, w, "raw_session_skills", "lake · Parquet", "1 row per (tenant, session, skill)", k + [("+ %d columns" % n, "", "")])
    y1 = 260
    ic = ent(cv, 0, y1, w, "checkpoints", "SQLite state", "1 row per (tenant, JSONL file)",
             [("tenant_id", "PK", ""), ("file_path", "PK", ""), ("last_offset", "", ""), ("head_hash", "", ""), ("last_seen_at", "", ""), ("+ 3 columns", "", "")])
    k, n = lake_rows("watcher_errors")
    we = ent(cv, 375, y1, w, "watcher_errors", "lake · Parquet", "1 row per logged error; stands alone", k + [("~%d columns" % n, "", "")])
    k, n = lake_rows("raw_session_mcps")
    mc = ent(cv, 750, y1, w, "raw_session_mcps", "lake · Parquet", "1 row per (tenant, session, MCP server)", k + [("+ %d columns" % n, "", "")])
    y2 = y1 + ic["h"] + 70
    fs = ent(cv, 0, y2, w, "file_stats", "SQLite state", "1 row per (tenant, JSONL file)",
             [("tenant_id", "PK", ""), ("file_path", "PK", ""), ("+ 7 columns", "", "")])
    mt = ent(cv, 375, y2, w, "meta", "SQLite state", "1 row per key; stands alone", [("key", "PK", ""), ("value", "", "")])
    cv.h = y2 + fs["h"] + 20
    y = row_y(re_, 2)
    erline(cv, [(w, y), (375, y)], True, "many", "many", "tenant_id,|session_id", (312, y - 36))
    y = row_y(sk, 1)
    erline(cv, [(750, y), (625, y)], True, "many", "many", "tenant_id,|session_id", (687, y - 36))
    ym = row_y(mc, 1)
    erline(cv, [(750, ym), (687, ym), (687, row_y(sm, 1) + 4), (625, row_y(sm, 1) + 4)], True, "many", "many")
    cv.lbl(687, 296, "tenant_id,", chip=True); cv.lbl(687, 312, "session_id", chip=True)
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
             [("tenant_id", "PK", ""), ("model", "PK", ""), ("valid_from", "PK", ""), ("valid_to", "", ""), ("+ %d columns" % (len(SEED[0]) - 4), "", "")])
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
    cv.poly([(bx, ys[0]), (bx, hub_att)], False, head=False)
    cv.poly([(bx, hub_att), (bx, ys[-1])], True, head=False, anim=False)
    for i, yy in enumerate(ys):
        cv.poly([(X, yy), (bx, yy)], i > 1, head=False, anim=False)
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
    """ref()/source() edges read from the model files, comments stripped"""
    out = set()
    for p in MODEL_FILES:
        t = re.sub(r"--[^\n]*", "", re.sub(r"\{#.*?#\}", "", p.read_text(encoding="utf-8"), flags=re.S))
        out |= {(r, p.stem) for r in re.findall(r"ref\(\s*'(\w+)'\s*\)", t)}
        out |= {("src_" + s, p.stem) for s in re.findall(r"source\(\s*'lake'\s*,\s*'(\w+)'\s*\)", t)}
    return sorted(out)


COST = {("src_raw_events", "stg_events"), ("stg_events", "stg_assistant_messages"), ("stg_assistant_messages", "fact_model_calls"),
        ("fact_model_calls", "fact_daily_spend"), ("model_pricing", "fact_model_calls"), ("fact_model_calls", "fact_turns"),
        ("fact_turns", "dim_sessions")}
SRC = sorted({a for a, _ in read_edges() if a.startswith("src_")})
GRP = "stg_session_group"
SESS = ["stg_session_meta", "stg_session_skills", "stg_session_mcps", "stg_session_verdicts"]
UP = set(SRC) | {m for m in MAT if m.startswith("stg_")} | {"int_turns", "int_event_agent", "dim_turn_messages"}


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
        elif n == "model_pricing":
            st = 'style=filled, fillcolor="#EEEFEC", color="#B9BCC2", label="SEED: model_pricing"'
        elif n == GRP:
            st = 'style="filled,dashed", fillcolor="#FFFFFF", color="#17191D", label="stg_session_meta\nstg_session_skills\nstg_session_mcps\nstg_session_verdicts"'
        elif MAT.get(n) == "view":
            st = 'style="filled,dashed", fillcolor="#FFFFFF", color="#17191D", label="%s"' % n
        elif MAT.get(n) == "incremental":
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
    cv.box(510, 50, 170, 190, "", "CONTAINER", "frontend", bul=["`frontend/Dockerfile`", "`node:20-slim`, 3 stages", "CMD `node server.js`", "port 3000"])
    cv.box(590, 330, 100, 44, "c actor", title="Browser")
    cv.frame(800, 10, 200, 320, "GITHUB ACTIONS", solid=True, color="#17191D")
    for i, t in enumerate(["watcher job", "pipeline job"]):
        cv.box(815, 56 + 62 * i, 170, 46, "c routine", title=t, mono=True)
    cv.box(815, 180, 170, 60, "c", title="checks only", sub="no deploy")
    cv.div.append('<div class="b c" style="left:800px;top:350px;width:200px;height:70px;border:1px dashed #9AA0A8;background:transparent">'
                  '<span class="t">Central / team rollout</span><span class="sub">not built (' + at("README.md", r"## From individual to team", r"## Roadmap") + ')</span></div>')
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
SEED_CSV = "dbt/seeds/model_pricing.csv"
FMC = "dbt/models/marts/fact_model_calls.sql"
COMPOSE = "docker-compose.yml"
DBTC = "watcher/src/aura_watcher/dbt_cycle.py"
DBJS = "frontend/lib/db.ts"
PIN = lambda name: re.search(name + r"==([\w.]+)", (ROOT / "watcher/pyproject.toml").read_text(encoding="utf-8")).group(1)
PKG = lambda name: re.search(r'"%s": "([^"]+)"' % re.escape(name), (ROOT / "frontend/package.json").read_text(encoding="utf-8")).group(1)


def seed_line(model):
    return at(SEED_CSV, r"^,%s," % re.escape(model))


def calc(model, inp=0, out=0, c5=0, c1=0, cc=0, cr=0):
    r = SEED_BY[model]
    g = lambda k: float(r[k] or 0)
    v = (inp * g("cost_input_per_mtok") + out * g("cost_output_per_mtok") + c5 * g("cost_cache_write_5m_per_mtok")
         + c1 * g("cost_cache_write_1h_per_mtok") + max(cc - c5 - c1, 0) * g("cost_cache_write_5m_per_mtok")
         + cr * g("cost_cache_read_per_mtok"))
    return v / 1e6


def usd(n):  # mirrors fmt.usd in frontend/lib/fmt.ts
    return "$%.4f" % n if n < 0.01 else ("$%.3f" % n if n < 1 else "$%.2f" % n)


CHECK = {"sonnet": calc("claude-sonnet-5", 1000, 2000, 20000, 0, 20000, 50000),
         "opus": calc("claude-opus-4-8", 400, 1000, 0, 8000, 8000, 100000),
         "haiku": calc("claude-haiku-4-5", 0, 1000, 0, 0, 10000, 0)}
assert (usd(CHECK["sonnet"]), usd(CHECK["opus"])) == ("$0.082", "$0.157"), CHECK


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
    nodes = {b for _, b in edges} | {a for a, _ in edges if not a.startswith("src_") and a != "model_pricing"}
    out = {}
    for n in nodes:
        out.setdefault(d(n), []).append(n)
    return {k: sorted(v) for k, v in sorted(out.items())}


GRAIN = {  # model: (grain, key)
    "stg_events": ("1 per lake event, duplicates removed", "`tenant_id, uuid`; delete+insert on `tenant_id, session_id`"),
    "stg_content_blocks": ("1 per message.content block", "`tenant_id, event_uuid, block_idx`; delete+insert on session"),
    "stg_lake_event_dups": ("1 per losing lake copy of an event", "`tenant_id, uuid, filename, file_row_number`"),
    "stg_assistant_messages": ("1 per (tenant, message_id); latest event", "`tenant_id, message_id`"),
    "stg_session_meta": ("1 per session; latest value per attribute", "`tenant_id, session_id`"),
    "stg_session_skills": ("1 per (tenant, session, skill)", "`tenant_id, session_id, skill_name`"),
    "stg_session_mcps": ("1 per (tenant, session, server)", "`tenant_id, session_id, mcp_server`"),
    "stg_session_verdicts": ("1 per session; latest inbox line", "`tenant_id, session_id`"),
    "stg_thinking_blocks": ("1 per thinking block", "`assistant_event_uuid, thinking_idx`"),
    "stg_tool_calls": ("1 per tool_use block", "`tenant_id, tool_use_id`"),
    "stg_tool_results": ("1 per tool result", "dbt unique_key `tenant_id, event_uuid`"),
    "stg_watcher_errors": ("1 per logged error", "—"),
    "dim_turn_messages": ("1 per turn; text columns only", "`tenant_id, turn_id`"),
    "int_app_cwd_lookup": ("1 per (tenant, cwd)", "`tenant_id, cwd`"),
    "int_entity_spend": ("1 per (tenant, entity_type, entity_id, project_id, date)", "same"),
    "int_event_agent": ("1 per (tenant, event_uuid)", "`tenant_id, event_uuid`"),
    "int_turns": ("1 per assistant turn (turn_id = message_id)", "`tenant_id, turn_id`"),
    "dim_agents": ("1 per (tenant, agent, app_id, project_id)", "same"),
    "dim_apps": ("1 per (tenant, app_id, project_id)", "same"),
    "dim_people": ("1 per (tenant, person_id)", "same"),
    "dim_projects": ("1 per (tenant, project_id)", "same"),
    "dim_sessions": ("1 per (tenant, session_id)", "same"),
    "fact_daily_spend": ("1 per (tenant, date, agent, model, provider)", "`tenant_id, date, agent, model`"),
    "fact_errors": ("1 per distinct error tuple", "—"),
    "fact_git_commands": ("1 per git Bash call", "—"),
    "fact_hourly_activity": ("up to 168 rows (day × hour)", "`day_of_week, hour_of_day`"),
    "fact_model_calls": ("1 per model call", "`event_uuid`"),
    "fact_prompts": ("1 per external prompt", "`tenant_id, prompt_id`"),
    "fact_session_files": ("1 per (tenant, session, file)", "same"),
    "fact_spend_pace": ("1 per tenant", "`tenant_id`"),
    "fact_tool_executions": ("1 per tool_use_id", "`tenant_id, tool_use_id`"),
    "fact_turns": ("1 per turn", "`turn_id`"),
}
assert set(GRAIN) == set(MAT), set(GRAIN) ^ set(MAT)


def build():
    edges = read_edges()
    n_edges = len(edges)
    e1 = [e for e in edges if e[1] in UP]
    e2 = [e for e in edges if e[1] not in UP]
    assert len(e1) + len(e2) == n_edges
    lin1, sc1 = d_lineage("lineage_up", e1, rd="LR")
    lin2, sc2 = d_lineage("lineage_marts", e2, group=True)
    scale = min(sc1, sc2)
    dep = depths(edges)
    n_models, n_gen, n_sing = len(MODEL_FILES), n_generic_tests(), N_SINGULAR
    n_pages = len(list((ROOT / "frontend/app").rglob("page.tsx")))
    n_api = len(list((ROOT / "frontend/app/api").rglob("route.ts")))
    S = []
    README = "README.md"

    # ---- 1
    S.append(sec("s1", "Big picture", d_l0() + key("pill = person · grey = data · teal = code · dashed = data moves · numbers = order")
        + notice("The dashboard reads only the published read DB; the lake and the work DB are never opened by the frontend.")
        + ul(["The watcher flushes parsed events to a Parquet lake every 30 s.",
              "dbt builds a work DB from the lake every 5 min, then publishes a fresh read DB.",
              "A failed run or publish keeps the previous read DB live.",
              "Delivery is at-least-once; dbt removes duplicate events.",
              "New event on screen: one flush + the wait for the next cycle (≤ 5 min) + run and publish time — `%s`." % at(README, r"\*\*Freshness:\*\*")])))

    # ---- 2
    S.append(sec("s2", "Architecture", d_l2()
        + key("frame = container · teal = code · grey = data · dashed = data moves")
        + notice("Ingest and dbt share only two locks: `flush_lock` for the instant the cutoff is taken, `lake_lock` against compaction.")
        + table(["Component", "Responsibility", "Tech", "Path"], [
            ["watcher main loop", "Observe, parse, buffer, flush every 30 s, sweep, compact", "Python 3.12, watchdog", c(WSRC + "main.py")],
            ["ClaudeAdapter", "One JSONL line to one `raw_events` row", "Python", c(WSRC + "adapters/claude.py")],
            ["SdkTraceAdapter", "SDK trace line (`kind`, `t`) to row", "Python", c(WSRC + "adapters/sdk_trace.py")],
            ["redact", "Value-level secret scrub before write", "Python `re`", c(WSRC + "redact.py")],
            ["lake", "Parquet schemas, atomic writes, compaction, two locks", "DuckDB `COPY`", c(WSRC + "lake.py")],
            ["state", "SQLite checkpoints, file stats, meta", "sqlite3", c(WSRC + "state.py")],
            ["dbt_cycle", "dbt subprocesses, publish, prune, artifacts", "Python `subprocess`", c(WSRC + "dbt_cycle.py")],
            ["dbt project `aura`", "staging, intermediate, marts, pricing seed", "dbt-core %s, dbt-duckdb %s" % (PIN("dbt-core"), PIN("dbt-duckdb")), "`dbt/`"],
            ["frontend", "Server-rendered dashboard + %d API handlers" % n_api, "Next.js %s, React 18" % PKG("next"), "`frontend/`"],
            ["number verify", "Reconciles cost totals after each cycle", "Node 20, `@duckdb/node-api`", "`scripts/verify/run_all.mjs`"]])
        + ul(["Compose polls files: inotify events do not cross Docker Desktop bind mounts — `%s`." % at(COMPOSE, r"inotify events do not cross"),
              "Native mode uses the OS observer and sweeps every 60 s — `%s`." % at("start.ps1", r"AURA_OBSERVER", r"AURA_SWEEP"),
              "Work DB basename must stay `aura.duckdb`: dbt bakes the catalog name into views — `%s`." % at(DBTC, r"dbt bakes the catalog"),
              "The main thread owns buffers and SQLite; the dbt thread owns the work DB — `%s`." % W("main.py", r"One ingest thread")])))

    # ---- 3
    S.append(sec("s3", "Flow: ingest and backfill", d_ingest()
        + key("teal = code · grey = data · purple dashed = repeats · red dashed = failure branch · numbers = order")
        + notice("Files are written first and the checkpoint commits after, so a crash re-reads lines and dbt removes the duplicates.")
        + table(["#", "Step", "In", "Out", "Source"], [
            ["1", "`startup`", "`env vars`", "`ctx` + checkpoints in memory", c(W("main.py", r"^def startup", r"return ingest\.new_context"))],
            ["2", "`run()` start threads", "`ctx`", "`2 threads`", c(W("main.py", r"^def run\(", r"daemon=True"))],
            ["3", "`sweep` + `list_files`", "e.g. `15,000 files`", "e.g. `200 queued`", c(W("ingest.py", r"^def list_files")) + " " + c(W("ingest.py", r"^def sweep"))],
            ["4", "`dirty` queue", "logical path", "`process_file(path)`", c(W("main.py", r"^class _Handler", r"on_created")) + " " + c(W("main.py", r"^def _process_dirty"))],
            ["5", "`process_file` from checkpoint", "`last_offset=5000`", "`bytes 5000..EOF`", c(W("ingest.py", r"^def needs_read")) + " " + c(W("ingest.py", r"^def read_new_lines"))],
            ["6", "`ClaudeAdapter.parse_line`", "`1 JSON line`", "`1 row or None`", c(W("adapters/claude.py", r"def parse_line"))],
            ["7", "append to buffers", "`1 row`", "`buffer +1`", c(W("ingest.py", r'ctx\.buffers\["raw_events"\]\.append'))],
            ["8", "`flush` every 30 s", "`N buffered rows`", "`N rows in lake`", c(W("ingest.py", r"^def flush", r"return True$")) + " " + c(W("lake.py", r"^def write_rows"))],
            ["9", "`commit_flush` to SQLite", "`pending offsets`", "`last_offset = size`", c(W("state.py", r"^def commit_flush"))]], "steps", mono=(2, 3))
        + ul(["The startup sweep is the backfill: files whose size differs from the offset, oldest first — `%s`." % W("ingest.py", r"oldest mtime first"),
              "dbt does not wait for the backfill; the first cycle runs on whatever the lake holds — `%s`." % at(README, r"It does not wait for the backfill"),
              "Backfill speed measured at about 28 minutes for 6 GB of transcripts — `%s`." % at(README, r"about 28 minutes"),
              "A torn last line is read only if it parses as JSON — `%s`." % W("ingest.py", r"^def read_new_lines", r"^    with open"),
              "Reset to offset 0 when the file shrinks or its first 512 bytes change — `%s`." % W("ingest.py", r"^def needs_read", r"return 0, True"),
              "Mid-file flush at 20,000 rows or 64 MB bounds memory — `%s`." % W("ingest.py", r"S12: bound memory"),
              "A failed table write keeps buffers and pending checkpoints; the next tick retries — `%s`." % W("ingest.py", r"^def flush", r"C5:"),
              "Workflow `journal.jsonl` files are skipped — `%s`." % W("ingest.py", r"^def is_workflow_journal")])
        + '<div class="payloads">'
        + payload("IN", "3-line JSONL file: user, assistant, ai-title", '{"type":"user", ...}\n{"type":"assistant", ...}\n{"type":"ai-title", ...}')
        + payload("OUT", "rows written (first flush)", "lake raw_events        +2\nlake session_meta      +2  (first-sight row, title from ai-title)\nSQLite file_stats      lines_total=3 events_kept=2 dropped_known=1\nSQLite checkpoints     last_offset = file size")
        + '</div>' + cite("derived from %s and %s" % (W("ingest.py", r"^def _process", r"^def _prime"), W("adapters/claude.py", r'"ai-title",')))
        + exset([
            ex("ok", "TYPICAL", "Torn last line", [("file", "u1, u2, first 20 bytes of u3"), ("then", "rest of u3 appended")],
               "first flush: `u1, u2`, offset after line 2; second flush adds `u3`", "from %s" % at("watcher/tests/test_ingest.py", r"def test_torn_line")),
            ex("edge", "EDGE", "File truncated", [("last_offset", "1000"), ("file size now", "smaller")],
               "re-read from `0`; `file_stats` replaced, not added", "from %s" % at("watcher/tests/test_ingest.py", r"def test_truncation_resets")),
            ex("edge", "EDGE", "Crash before checkpoint", [("flush", "files written"), ("commit_flush", "raises")],
               "lines re-read after restart; `raw_events` holds each uuid twice, `stg_lake_event_dups` drops one",
               "from %s" % at("watcher/tests/test_state.py", r"def test_crash_between_flush"))])))

    # ---- 4
    S.append(sec("s4", "Flow: dbt cycle and publish", d_dbtcycle()
        + key("lanes = thread / subprocess / publish · teal = code · grey = data · red dashed = failure branch")
        + notice("A failed run or failed publish leaves `CURRENT` untouched, so the dashboard keeps serving the previous version.")
        + ul(["Skip when lake files, inbox and dbt code are unchanged and the last publish is under 1 h old — `%s`." % at(DBTC, r"recent = _cycle", r"return \"skipped\""),
              "The cutoff is taken under `flush_lock`: every row stamped before it is in a finished file — `%s`." % at(DBTC, r"with lake\.flush_lock:", r"cutoff = "),
              "`run`, not `build`, so models refresh when tests fail; tests run after publish — `%s`." % at(DBTC, r'dbt\(\["run"\]', r'dbt\(\["retry"\]'),
              "Incremental models rebuild sessions with lake rows newer than their last `_built_at` minus 1 h — `%s`." % at("dbt/macros/recent_sessions.sql", r"macro recent_sessions", r"endmacro"),
              "Each dbt command times out after `AURA_DBT_TIMEOUT_SECONDS` (1800) — `%s`." % at(DBTC, r"timeout=cfg\.dbt_timeout"),
              "Prune keeps `CURRENT` and the newest older version; a locked dir is retried next cycle — `%s`." % at(DBTC, r"^def prune", r"keep = ")])
        + table(["Item", "Value", "Source"], [
            ["Cycle interval", "5 min start-to-start (`AURA_DBT_RUN_INTERVAL_MINUTES`)", c(W("main.py", r"stop\.wait\(max"))],
            ["Lake flush", "30 s (`AURA_FLUSH_SECONDS`)", c(W("main.py", r"flush_seconds=float"))],
            ["Last full cold build", "PASS=155, ERROR=0, 1347 s", "owner-reported run; not stored in the repo"],
            ["Warm 5-min cycle", "not measured yet", "—"],
            ["Lag per publish", "recorded in `artifacts/freshness.ndjson`", c(at(DBTC, r"^def freshness_lag"))]])
        + cite("derived from %s" % at(DBTC, r"^def run_cycle", r"return result"))))

    # ---- 5
    S.append(sec("s5", "Flow: page load", d_pageload()
        + key("lanes = processes · teal = code · grey = data · red dashed = failure branch")
        + notice("A new read DB version opens a new instance; the old one closes after the query timeout plus 1 s so in-flight queries finish.")
        + table(["#", "From → To", "Step", "Source"], [
            ["1", "Browser → Next", "`GET /?range=7d`", c(at("frontend/app/page.tsx", r"force-dynamic"))],
            ["2", "page.tsx", "`parseRange`, `rangeSince`", c(at("frontend/app/page.tsx", r"parseRange\(searchParams", r"rangeSince\(range\)")) + " " + c(at("frontend/lib/range.ts", r"export function parseRange"))],
            ["3", "page.tsx", "`Promise.all` of 17 `safe(label, getX(since), fallback)`", c(at("frontend/app/page.tsx", r"await Promise\.all", r"safe\('topMcps'")) + " " + c(at("frontend/lib/api-safe.ts", r"export async function safe"))],
            ["4", "lib/db.ts", "`getInstance()` reads `CURRENT` (cached 1 s), opens new version", c(at(DBJS, r"^function currentVersion", r"^}")) + " " + c(at(DBJS, r"^async function getInstance", r"^}"))],
            ["5", "lib/db.ts → READ DB", "`runAndReadAll(sql, params)`, 15 s timeout", c(at(DBJS, r"^export async function query", r"^}"))],
            ["6", "lib/db.ts", "`normalizeBigInts`", c(at(DBJS, r"^export function normalizeBigInts", r"^}"))],
            ["7", "page.tsx → Browser", "render with `fmt.usd`", c(at("frontend/lib/fmt.ts", r"usd:", r"^  \},"))]], "steps")
        + ul(["Timeout rejects with `Query timeout after 15000ms: <first 80 chars of SQL>` — `%s`." % at(DBJS, r"Query timeout after"),
              "No `CURRENT` pointer yet: `read DB not published yet`; pages show empty states — `%s`." % at(DBJS, r"read DB not published yet"),
              "Missing mart: `safe()` returns the fallback and logs `[aura:safe]`; one panel stays empty — `%s`." % at("frontend/lib/api-safe.ts", r"\[aura:safe\] query failed"),
              "Range lives in the URL: `today` (default), `7d`, `30d`, `all` — `%s`." % at("frontend/lib/range.ts", r"export function parseRange", r"^}"),
              "Pages never price tokens; they sum dbt cost columns — `%s`." % at("frontend/lib/queries/dashboard.ts", r"SELECT SUM\(daily_cost\)")]) + "<h3>Page variants</h3>"
        + table(["Page", "How data arrives", "Source"], [
            ["`/`, `/agents`, `/apps`, `/people`, `/tokens`", "Server component queries per request", c(at("frontend/app/page.tsx", r"await Promise\.all"))],
            ["`/sessions`", "Client fetch `GET /api/sessions?range&sort…`", c(at("frontend/app/sessions/page.tsx", r"fetch\(`/api/sessions"))],
            ["`/errors`", "Client fetch `GET /api/errors?since=…`", c(at("frontend/app/errors/page.tsx", r"fetch\(`/api/errors"))],
            ["`/sessions/[sessionId]`", "12 queries; Prompts tab lazy-loads `/api/sessions/{id}/prompts-enriched`", c(at("frontend/app/sessions/[sessionId]/page.tsx", r"await Promise\.all", r"\]\)")) + " " + c(at("frontend/components/SessionTabs.tsx", r"prompts-enriched"))],
            ["`/observability`", "SSR `getPipelineSnapshot()`, then poll `/api/observability` every 10 s", c(at("frontend/app/observability/page.tsx", r"getPipelineSnapshot\(\)")) + " " + c(at("frontend/app/observability/PipelineLive.tsx", r"REFRESH_SEC ="))]])
        + '<div class="payloads">' + payload("OUT", "GET /api/sessions?range=7d&sort=cost",
            '{ "sessions": [ rows in the requested sort order ],\n  "stats": { "total_count": …, "total_cost": … } }')
        + '</div>' + cite("from %s" % at("frontend/app/api/sessions/route.ts", r"NextResponse\.json\(\{ sessions, stats \}"))))

    # ---- 6
    jr = lambda title, sub, rows, cls="": ('<div class="stage %s"><div class="h"><b>%s</b><small>%s</small></div><table>%s</table></div>'
        % (cls, title, sub, "".join("<tr><td>%s</td><td>%s</td></tr>" % (k, v) for k, v in rows)))
    arrow = '<div class="arrow"><svg viewBox="0 0 28 16"><path d="M2 8 H22 M16 2 L24 8 L16 14" fill="none" stroke="#17191D" stroke-width="1.5"/></svg></div>'
    journey = ('<div class="journey">'
        + jr("1 · JSONL line", "as written", [("type", "assistant"), ("model", "claude-sonnet-5"), ("message.id", "msg_1"), ("input_tokens", "1000"),
              ("output_tokens", "2000"), ("cache_creation", "20000"), ("ephemeral_5m", "20000"), ("ephemeral_1h", "0"), ("cache_read", "50000")])
        + arrow + jr("2 · lake raw_events", "parsed + redacted", [("uuid", "&lt;line uuid&gt;"), ("message_id", "msg_1"), ("tokens", "same, as columns"), ("payload", "redacted")])
        + arrow + jr("3 · stg_assistant_messages", "deduped by message_id", [("rows", '<span class="old">3 streamed</span><span class="new-v">1 row for msg_1</span>')], "changed")
        + '<div class="what"><div>as written</div><div></div><div>parsed + redacted</div><div></div><div>deduped by message_id</div></div></div>')
    sr = SEED_BY["claude-sonnet-5"]
    journey2 = ('<div class="journey" style="grid-template-columns:1fr">'
        + jr("4 · fact_model_calls", "priced with seed row", [("calculated_cost",
              '<span class="calc">(1000×%s + 2000×%s + 20000×%s + 0×%s + 0 residual + 50000×%s) / 1e6</span>'
              % (sr["cost_input_per_mtok"], sr["cost_output_per_mtok"], sr["cost_cache_write_5m_per_mtok"], sr["cost_cache_write_1h_per_mtok"], sr["cost_cache_read_per_mtok"])),
              ("result", '<span class="new-v">%.3f → %s</span>' % (CHECK["sonnet"], usd(CHECK["sonnet"])))]) + '</div>')
    S.append(sec("s6", "Flow: cost calculation", d_cost()
        + key("teal = code · grey = data · amber = shape change · red dashed = failure branch")
        + notice("Cost is priced once per model call in dbt; every mart and screen sums that value.")
        + table(["#", "Step", "In", "Out", "Source"], [
            ["1", "`ClaudeAdapter` token columns", "`message.usage`", "6 token columns on `raw_events`", c(W("adapters/claude.py", r'"input_tokens": usage', r'"cache_read_input_tokens": usage'))],
            ["1b", "`SdkTraceAdapter`", "`result.total_cost_usd`", "`reported_cost_usd`", c(W("adapters/sdk_trace.py", r'get\("total_cost_usd"\)'))],
            ["2", "`stg_assistant_messages`", "N streamed rows per `message_id`", "1 row (latest `ts`, `byte_offset`)", c(at("dbt/models/staging/stg_assistant_messages.sql", r"ROW_NUMBER\(\) OVER", r"message_id IS NOT NULL"))],
            ["3", "`fact_model_calls.calculated_cost`", "tokens + pricing row", "USD per call", c(at(FMC, r"^\s+CASE\s*$", r"END AS calculated_cost"))],
            ["4", "fan-out", "`calculated_cost`", "`fact_daily_spend.daily_cost`, `fact_turns` → `dim_sessions.total_cost`, `int_entity_spend.total_cost`, `fact_spend_pace.today_cost`",
             "%s %s %s %s" % (c(at("dbt/models/marts/fact_daily_spend.sql", r"SUM\(calculated_cost\)")), c(at("dbt/models/marts/fact_turns.sql", r"mc\.calculated_cost")),
                              c(at("dbt/models/marts/dim_sessions.sql", r"SUM\(calculated_cost\)")), c(at("dbt/models/marts/fact_spend_pace.sql", r"SUM\(calculated_cost\) AS today_cost")))],
            ["5", "`getDashboardKPIs` → `fmt.usd`", "`SUM(daily_cost)`", "`$0.123`-style string", "%s %s" % (c(at("frontend/lib/queries/dashboard.ts", r"SELECT SUM\(daily_cost\)")), c(at("frontend/app/page.tsx", r"fmt\.usd\(kpis\.total_cost\)")))]], "steps")
        + "<h3>Data journey: one message</h3>" + journey + journey2
        + cite("derived from %s and %s, synthetic token counts" % (at(FMC, r"^\s+CASE\s*$", r"END AS calculated_cost"), seed_line("claude-sonnet-5")))
        + ul(["Residual cache write (no 5m/1h split) is priced at the 5m rate, floored at 0 — `%s`." % at(FMC, r"GREATEST\(COALESCE\(c\.cache_creation", r"cost_cache_write_5m"),
              "`fact_turns` passes `NULL` cost through; it no longer shows 0 — `%s`." % at("dbt/models/marts/fact_turns.sql", r"NULL when the model has no pricing row"),
              "`fmt.usd(null)` renders `$—` — `%s`." % at("frontend/lib/fmt.ts", r"\$—"),
              "Reconciliation checks run after each cycle — `%s`." % at("scripts/verify/run_all.mjs", r"check: 'session_cost_reconciles'", r"check: 'sdk_verbatim_cost'")])))

    # ---- 7
    lake_t = [["`%s`" % t, "lake Parquet · " + ("1 per row" if t == "raw_events" else "see grain"), "`%s`" % (", ".join(lake.KEYS[t]) if lake.KEYS[t] else "none"),
               "watcher `ingest.flush` → `lake.write_rows` (`%s`)" % W("lake.py", r"^def write_rows")] for t in lake.SCHEMAS]
    lake_t[0][1] = "lake Parquet · 1 per JSONL line with uuid + ts"
    lake_t[1][1] = "lake Parquet · 1 per (tenant, session, skill)"
    lake_t[2][1] = "lake Parquet · 1 per (tenant, session, server)"
    lake_t[3][1] = "lake Parquet · 1 per observation, append-only"
    lake_t[4][1] = "lake Parquet · 1 per logged error"
    state_t = [
        ["`checkpoints`", "SQLite · 1 per (tenant, file)", "`tenant_id, file_path`", "watcher `state.commit_flush` (`%s`)" % W("state.py", r"^def commit_flush")],
        ["`file_stats`", "SQLite · 1 per (tenant, file)", "`tenant_id, file_path`", "watcher `state.commit_flush`"],
        ["`meta`", "SQLite · 1 per key", "`key`", "watcher `state.set_meta` (`%s`)" % W("state.py", r"^def set_meta")],
        ["`verdicts-inbox.jsonl`", "file · 1 line per verdict POST", "latest line per session wins", "frontend `api/sessions/[id]/verdict/route.ts`, read by `stg_session_verdicts`"]]
    models_t = []
    for layer in ("staging", "intermediate", "marts"):
        for m in sorted(m for m in MAT if LAYER[m] == layer and MAT[m] != "view"):
            models_t.append(["`%s`%s" % (m, " (incremental)" if MAT[m] == "incremental" else ""), GRAIN[m][0], GRAIN[m][1], "dbt `dbt/models/%s/%s.sql`" % (layer, m)])
    models_t.append(["`model_pricing` (seed)", "1 per (tenant, model, valid_from)", "same", "`dbt seed` from `%s`" % SEED_CSV])
    parents = {}
    for a, b in edges:
        parents.setdefault(b, []).append(a)
    views_t = [["`%s`" % m, ", ".join("`%s`" % p for p in sorted(parents[m])), GRAIN[m][0]] for m in sorted(MAT) if MAT[m] == "view"]
    n_view = len(views_t)
    n_lake = len(lake.SCHEMAS)
    S.append(sec("s7", "Data model",
        ul(["%d lake tables and 3 SQLite tables (watcher), %d dbt models, 1 seed; no enforced foreign keys." % (n_lake, n_models)])
        + "<h3>Watcher tables</h3>" + d_er_raw()
        + key("PK/FK badges · ‖ one · crow's foot many · dashed = logical (not enforced)")
        + notice("`session_meta` and `watcher_errors` have no key: they are append-only logs that dbt collapses.")
        + cite("derived from %s and %s" % (W("lake.py", r"^SCHEMAS = ", r"^KEYS = "), at("watcher/src/aura_watcher/state.py", r"CREATE TABLE IF NOT EXISTS checkpoints", r"meta\(key")))
        + "<h3>Core marts</h3>" + d_er_marts()
        + key("solid = enforced by dbt relationships test · dashed = logical join · PK/FK badges")
        + notice("Four facts are tested against `dim_sessions` and `fact_prompts` against `dim_apps`; the other joins are logical.")
        + cite("solid lines from dbt/models/marts/schema.yml")
        + ul(["`watcher_errors`, `fact_errors`, `fact_git_commands` have no primary key.",
              "Standalone, not drawn: `fact_daily_spend`, `fact_hourly_activity`, `fact_spend_pace`, `int_entity_spend`, `int_event_agent`, `dim_agents`."])
        + "<h3>All objects</h3>" + table(["Object", "Grain", "Key", "Written by"], lake_t + state_t + models_t)
        + cite("from %s, %s and dbt/models/**/*.sql" % (W("lake.py", r"^KEYS = ", r"^}"), at("watcher/src/aura_watcher/state.py", r"CREATE TABLE IF NOT EXISTS checkpoints")))
        + "<h3>Views</h3>" + table(["View", "Built from", "Rows"], views_t) + cite("from dbt/models/staging/*.sql and dbt/models/intermediate/int_turns.sql")))

    # ---- 8
    deprows = [[str(k), ", ".join("`%s`" % m for m in v)] for k, v in dep.items()]
    child = {a for a, _ in edges}
    assert "stg_thinking_blocks" not in child
    over = {}
    for m in sorted(MAT):
        default = "table" if LAYER[m] == "marts" else "view"
        if MAT[m] != default:
            over.setdefault(MAT[m], []).append(m)
    S.append(sec("s8", "dbt lineage", "<h3>Sources to staging and intermediate</h3>" + lin1 + "<h3>Into marts</h3>" + lin2
        + key("grey = source/seed · dashed = view · teal = table · amber = incremental · bold = cost chain")
        + notice("`stg_events` and `stg_content_blocks` parse the transcript JSON once; every downstream model reads their columns.")
        + cite("%d ref/source edges from dbt/models/**/*.sql (%d in the first diagram, %d in the second; the four stg_session_* edges to dim_sessions are drawn as one grouped node); layout by Graphviz dot" % (n_edges, len(e1), len(e2)))
        + "<h3>Build order</h3>" + table(["Depth", "Models"], deprows) + cite("derived from the edge list: longest path from a source")
        + ul(["%d models, 1 seed, %d lake sources, %d generic + %d singular tests (`dbt/tests/`)." % (n_models, len(SRC), n_gen, n_sing),
              "Defaults: staging and intermediate = view, marts = table — `%s`." % at("dbt/dbt_project.yml", r"^models:", r"materialized: table"),
              "Overrides to table: %s." % ", ".join("`%s`" % m for m in over["table"]),
              "Incremental (delete+insert per session): %s." % ", ".join("`%s`" % m for m in over["incremental"]),
              "`stg_session_verdicts` reads the inbox file with `read_json`, not the lake — `%s`." % at("dbt/models/staging/stg_session_verdicts.sql", r"read_json"),
              "`raw_events` freshness on `ingested_at`: warn 5 min, error 30 min — `%s`." % at("dbt/models/staging/sources.yml", r"warn_after", r"error_after"),
              "`stg_thinking_blocks` has no downstream model."])))

    # ---- 9
    sql1 = ("CASE\n  WHEN c.source = 'sdk_trace' THEN COALESCE(c.reported_cost_usd, 0)\n  WHEN mp.model IS NULL THEN NULL\n"
            "  ELSE ( input  × cost_input_per_mtok\n       + output × cost_output_per_mtok\n       + ephemeral_5m × cost_cache_write_5m_per_mtok\n"
            "       + ephemeral_1h × cost_cache_write_1h_per_mtok\n       + GREATEST(cache_creation − 5m − 1h, 0) × cost_cache_write_5m_per_mtok\n"
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
    CASE = at(FMC, r"^\s+CASE\s*$", r"END AS calculated_cost")
    r91 = exset([
        ex("ok", "TYPICAL", "Crash before checkpoint", [("flush", "Parquet files written"), ("commit_flush", "raises")],
           "same lines re-read; `stg_lake_event_dups` marks the older copy, `stg_events` keeps one", "from %s" % at("watcher/tests/test_state.py", r"def test_crash_between_flush")),
        ex("edge", "EDGE", "Compaction", [("partition", "3 small files, same uuid in two")],
           "one `compacted-*.parquet`, newest `ingested_at` wins, row count verified before inputs are deleted", "from %s" % at("watcher/tests/test_lake.py", r"def test_compaction_dedups")),
        ex("edge", "EDGE", "Count mismatch", [("compacted rows", "differ from distinct keys")],
           "inputs kept, `watcher_errors` row source `compaction`", "from %s" % at("watcher/tests/test_lake.py", r"def test_compaction_verify_mismatch")),
        ex("edge", "EDGE", "Streamed message (dbt)", [("message_id=m1", "ts 10:00:01"), ("message_id=m1", "ts 10:00:03")],
           "only the `10:00:03` row kept in `stg_assistant_messages`; tokens counted once",
           "derived from %s" % at("dbt/models/staging/stg_assistant_messages.sql", r"ROW_NUMBER\(\) OVER"))])
    hk = ("derived from %s, %s" % (CASE, seed_line("claude-sonnet-5")))
    r92 = exset([
        ex("ok", "TYPICAL", "Sonnet call with 5m cache", [("model", "claude-sonnet-5"), ("input / output", "1000 / 2000"), ("creation", "20000 (5m 20000, 1h 0)"), ("read", "50000")],
           "(2000 + 20000 + 50000 + 0 + 0 + 10000) / 1e6 = %.3f → `%s`" % (CHECK["sonnet"], usd(CHECK["sonnet"])), hk),
        ex("ok", "TYPICAL", "Opus call with 1h cache", [("model", "claude-opus-4-8"), ("input / output", "400 / 1000"), ("creation", "8000 (5m 0, 1h 8000)"), ("read", "100000")],
           "(2000 + 25000 + 0 + 80000 + 0 + 50000) / 1e6 = %.3f → `%s`" % (CHECK["opus"], usd(CHECK["opus"])), "derived from %s, %s" % (CASE, seed_line("claude-opus-4-8"))),
        ex("edge", "EDGE", "Old log without cache split", [("model", "claude-haiku-4-5"), ("output", "1000"), ("creation", "10000"), ("5m / 1h", "NULL")],
           "residual 10000 × %s (5m rate); (5000 + 12500) / 1e6 = %.4f → `%s`" % (SEED_BY["claude-haiku-4-5"]["cost_cache_write_5m_per_mtok"], CHECK["haiku"], usd(CHECK["haiku"])),
           "derived from %s, %s" % (at(FMC, r"Residual: zero when breakdown"), seed_line("claude-haiku-4-5"))),
        ex("bad", "FAILURE", "Unknown model id", [("model", "claude-sonnet-5-20260101"), ("tokens", "any")],
           "no seed row → `calculated_cost NULL`; `not_null` + singular test fail naming the model; the watcher logs `unknown_model`; `fact_turns` keeps `NULL`. Remedy: add a row to `dbt/seeds/model_pricing.csv`.",
           "from %s, %s, %s" % (at(FMC, r"WHEN mp\.model IS NULL"), at("dbt/tests/fact_model_calls_unknown_model_pricing.sql", r"^SELECT DISTINCT"), at(DBTC, r'"unknown_model"'))),
        ex("edge", "EDGE", "SDK trace run", [("source", "sdk_trace"), ("reported_cost_usd", "0.42"), ("earlier turns", "NULL")],
           "`0.42`; earlier turns `0`", "from %s; check %s" % (at(FMC, r"WHEN c\.source = 'sdk_trace'"), at("scripts/verify/run_all.mjs", r"check: 'sdk_verbatim_cost'")))])
    INT = "dbt/models/intermediate/int_turns.sql"
    r93 = exset([
        ex("ok", "TYPICAL", "Tool loop", [("user prompt", "10:00 'fix bug'"), ("assistant", "10:01, 10:03")],
           "2 turns, both `user_prompt='fix bug'`, `turn_number` 1, 2", "derived from %s" % at(INT, r"ASOF LEFT JOIN")),
        ex("edge", "EDGE", "Tool result is not a prompt", [("user event", 'array content [{"type":"tool_result",…}]')],
           "excluded from the prompt pool; the turn keeps the earlier human prompt", "derived from %s" % at(INT, r"starts_with|!= '\['", r"is_sidechain = FALSE")),
        ex("edge", "EDGE", "Subagent turn", [("assistant", "sidechain assistant message at 10:05")],
           "gets the last non-sidechain prompt 'fix bug' (the file comment says NULL; see I-1)", "derived from %s" % at(INT, r"ASOF LEFT JOIN", r"a\.ts\s+>= u\.user_ts")),
        ex("ok", "TYPICAL", "Prompt spans", [("prompts", "10:00, 10:20"), ("turns", "10:01, 10:05, 10:21")],
           "span 1 gets 2 turns, span 2 gets 1; the last span is open-ended", "derived from %s" % at("dbt/models/marts/fact_prompts.sql", r"span_owners AS", r"\),"))])
    r94 = exset([
        ex("ok", "TYPICAL", "Key = value", [("text", "config: api_key=abcd1234567890abcdef")], "`config: «REDACTED»` (key name gone too)", "from %s" % at("watcher/tests/test_redact.py", r"def test_redact_secret_no_whitespace")),
        ex("edge", "EDGE", "Short value kept", [("text", "token=short77")], "unchanged (value under 8 characters)", "from %s" % at("watcher/tests/test_redact.py", r"def test_redact_does_not_touch_short_values")),
        ex("edge", "EDGE", "Long blob", [("text", '"A" × 300')], "`<base64:300 bytes>`; a 199-char run stays unchanged",
           "from %s, %s" % (at("watcher/tests/test_redact.py", r"def test_truncate_base64\("), at("watcher/tests/test_redact.py", r"alnum_run_199_chars"))),
        ex("edge", "EDGE", "Look-alike words", [("text", "risk-adjusted-return and desk-jockey are normal words")], "unchanged (`\\b` anchor)", "from %s" % at("watcher/tests/test_redact.py", r"code_identifier_risk")),
        ex("edge", "EDGE", "Secret-named key", [("dict", '{"password": "<any string>"}')], "value replaced whole by `«REDACTED»`", "from %s" % at("watcher/tests/test_redact.py", r"def test_redact_obj_redacts_value_by_secret_key"))])
    S.append(sec("s9", "Business rules",
        "<h3>9.1 Delivery and dedup: at-least-once, key <code>(tenant_id, uuid)</code></h3>"
        + ul(["Parquet files are written first, the SQLite checkpoint commits after — `%s`." % W("ingest.py", r"^def flush", r"C5:"),
              "A crash between the two re-reads the lines, so the lake can hold one uuid twice.",
              "Newest `ingested_at` wins, then filename, then row number — `%s`." % at("dbt/models/staging/stg_lake_event_dups.sql", r"QUALIFY", r"> 1"),
              "`stg_events` anti-joins the losing copies — `%s`; compaction applies the same rule — `%s`." % (at("dbt/models/staging/stg_events.sql", r"^    ANTI JOIN"), W("lake.py", r"^def _dedup_sql", r"count\(DISTINCT \(tenant_id, uuid\)\)")),
              "Claude rows: `uuid` = JSONL line uuid; SDK rows: `<session>:<byte_offset>` — `%s`." % W("adapters/sdk_trace.py", r'uuid = f"\{session_id\}:\{byte_offset\}"'),
              "Message-level dedup (`message_id`) happens in dbt, not in the lake."]) + r91
        + "<h3>9.2 Cost formula with pricing SCD lookup</h3>"
        + ul(["`calculated_cost` = sum(token bucket × per-Mtok rate) / 1,000,000; `sdk_trace` uses its reported cost."])
        + '<div class="payloads">' + payload("IN", "fact_model_calls.sql", sql1, "sql") + payload("IN", "SCD join, fact_model_calls.sql", sql2, "sql") + "</div>"
        + "<h3>Pricing seed (USD per Mtok)</h3>"
        + table(["tenant_id", "model", "provider", "input", "output", "5m", "1h", "read", "valid_from", "valid_to"], seedrows, mono=(1, 3, 4, 5, 6, 7, 8, 9))
        + cite("from %s (5 of %d rows)" % (at(SEED_CSV, r"^tenant_id", r"<synthetic>"), len(SEED)))
        + ul(["%d rows, all global; batch rates unused." % len(SEED),
              "No pricing row → `NULL` → `not_null` test fails — `%s`." % at("dbt/models/marts/schema.yml", r"name: calculated_cost", r"not_null"),
              "Singular test lists unpriced models — `dbt/tests/fact_model_calls_unknown_model_pricing.sql`.",
              "Model ids match exactly; version-suffixed ids need their own row.",
              "Residual cache creation (no split) is priced at the 5m rate — `%s`." % at(FMC, r"GREATEST\(COALESCE\(c\.cache_creation", r"cost_cache_write_5m"),
              "Tenant row beats global row via `QUALIFY` — `%s`." % at(FMC, r"^QUALIFY ROW_NUMBER", r"^\) = 1")]) + r92
        + "<h3>9.3 Incremental cursor and parse-once staging</h3>"
        + ul(["Incremental models: `stg_events`, `stg_content_blocks`, `stg_tool_results`, `fact_tool_executions`, `fact_prompts`, `dim_turn_messages`.",
              "`recent_sessions()` = sessions with lake rows ingested since the model's last `_built_at`, minus 1 h — `%s`." % at("dbt/macros/recent_sessions.sql", r"macro recent_sessions", r"endmacro"),
              "`lake_cutoff()` limits every lake read of a cycle to `ingested_at <= aura_cutoff` — `%s`." % at("dbt/macros/lake_cutoff.sql", r"macro lake_cutoff"),
              "`_built_at` = `LEAST(cutoff, UTC now)`, so a manual run without `--vars` cannot freeze the cursor — `%s`." % at("dbt/macros/recent_sessions.sql", r"macro built_at"),
              "A touched session is deleted and reinserted whole, so its dedup and spans stay exact.",
              "`stg_events` extracts the JSON fields once with one `json_extract_string` — `%s`; `stg_content_blocks` unnests content once — `%s`." % (at("dbt/models/staging/stg_events.sql", r"json_extract_string\(valid_payload"), at("dbt/models/staging/stg_content_blocks.sql", r"unnest\(items\)"))])
        + "<h3>9.4 Turns and prompt spans</h3>"
        + ul(["Source: `stg_assistant_messages`; `turn_id = message_id` — `%s`." % at(INT, r"a\.message_id\s+AS turn_id"),
              "Prompt pool: `userType='external'`, not `isMeta`, content not starting `[`, `is_sidechain = FALSE` — `%s`." % at(INT, r"WHERE event_type = 'user'", r"is_sidechain = FALSE"),
              "Turn gets the latest prompt via `ASOF LEFT JOIN … a.ts >= u.user_ts` — `%s`." % at(INT, r"ASOF LEFT JOIN", r"a\.ts\s+>= u\.user_ts"),
              "`fact_prompts`: a prompt's span runs to the next prompt; turns, tools and messages join with `ASOF JOIN` — `%s`." % at("dbt/models/marts/fact_prompts.sql", r"span_owners AS", r"ASOF JOIN span_owners"),
              "`assistant_response` = first `text` block in `content[0..19]` — `%s`." % at(INT, r"first_text AS", r"GROUP BY"),
              "`turn_number` = `ROW_NUMBER` per session by assistant ts — `%s`." % at(INT, r"AS turn_number")]) + r93
        + "<h3>9.5 Redaction: scrub payload before write</h3>"
        + ul(["Object-level: `redact_obj` walks the parsed line, then `json.dumps`, so payloads stay valid JSON — `%s`." % W("redact.py", r"^def redact_obj", r"return o"),
              "Order in `redact_content`: key=value, Bearer, URL credentials, known formats, PEM, then long blobs — `%s`." % W("redact.py", r"^def redact_content", r"return content"),
              "A string under a secret-named key is replaced whole — `%s`." % W("redact.py", r"^def _secret_key"),
              "Both adapters call `redact_obj`; SDK rows redact the object before `json.dumps` — `%s`." % W("adapters/sdk_trace.py", r"json\.dumps\(redact_obj"),
              "Toggle `AURA_REDACT_PAYLOAD` (default `true`), read once at import — `%s`." % W("redact.py", r"^def redact_enabled"),
              "Session titles get the same treatment — `%s`." % W("redact.py", r"^def redact_title"),
              "`cwd`, `git_branch`, `file_path` are stored raw; `AURA_HASH_CONTENT=1` replaces conversation text with `sha256:<hex>` for new ingests."])
        + table(["Pattern", "Matches", "Replaced by"], [
            ["`REDACT_REGEX`", "`api_key/secret/token/password/…` + `:`/`=` + 8+ chars", "`«REDACTED»` (whole match)"],
            ["`BEARER_REGEX`, `URL_CREDS_REGEX`", "`Bearer <16+ chars>`, `scheme://user:pass@`", "`«REDACTED»`"],
            ["`CREDENTIAL_REGEX`", "`AKIA…`, `ASIA…`, `ghp_…`, `github_pat_…`, `sk-…`, `xox?-…`, JWT `eyJ…`", "`«REDACTED»`"],
            ["`PEM_REGEX`", "`-----BEGIN … PRIVATE KEY-----` … END", "`«REDACTED»`"],
            ["`BASE64_REGEX`", "`[A-Za-z0-9+/]{200,}`", "`<base64:N bytes>`"]])
        + cite("from %s" % W("redact.py", r"^_KEYWORD = ", r"^PEM_REGEX")) + r94
        + "<h3>9.6 App and project from cwd</h3>"
        + ul(["`cwd` is split on `/`; the segment after `apps`, `services` or `packages` is the app, the one before it the project — `%s`." % at("dbt/models/marts/dim_apps.sql", r"apps.*services.*packages"),
              "No such segment: app and project are both the last path segment."])
        + exset([
            ex("ok", "TYPICAL", "Monorepo app", [("cwd", "<repo>/apps/web")], "app `web`, project `<repo>`", "derived from %s" % at("dbt/models/marts/dim_apps.sql", r"apps.*services.*packages")),
            ex("edge", "EDGE", "Plain folder", [("cwd", "<user-home>/notes")], "app `notes`, project `notes`", "derived from %s" % at("dbt/models/marts/dim_apps.sql", r"apps.*services.*packages"))])))

    # ---- 10
    cfg = [
        ["`AURA_USER`", "OS user name", "`${AURA_USER:-${USERNAME:-${USER:-local}}}`", "Selects `data/<user>/`"],
        ["`CLAUDE_LOGS_DIR`", "`~/.claude/projects`", "same", "Host transcripts dir, mounted ro at `/logs/claude`"],
        ["`AURA_LOGS_DIR`", "`/logs/claude`", "`/logs/claude`", "Where the watcher looks for `.jsonl`"],
        ["`AURA_DATA_DIR`", "`/data`", "`/data`", "Root of lake, state, work, read, inbox, artifacts"],
        ["`AURA_RUN_MODE`", "`unknown`", "`compose` (scripts: `native`)", "Mode guard compares it (exit 2 on clash)"],
        ["`AURA_LAKE_DIR`", "`<data>/lake`", "not set", "Parquet lake"],
        ["`AURA_STATE_DB`", "`<data>/state/aura_state.sqlite`", "not set", "Checkpoints, file stats, meta"],
        ["`AURA_DB_PATH`", "`<data>/work/aura.duckdb`", "`/data/work/aura.duckdb`", "dbt work DB; basename must stay `aura.duckdb`"],
        ["`AURA_READ_DIR`", "`<data>/read`", "not set", "Published read DBs + `CURRENT`"],
        ["`AURA_ARTIFACTS_DIR`", "`<data>/artifacts`", "not set", "Status JSON, dbt artifacts, ndjson logs"],
        ["`AURA_VERDICTS_INBOX`", "`<data>/inbox/verdicts-inbox.jsonl`", "same path in both services", "Frontend appends, dbt reads"],
        ["`AURA_EXTRA_TRACE_DIRS`", "empty", "not set", "Comma-separated extra dirs with SDK traces"],
        ["`AURA_OBSERVER`", "`polling`", "`polling` (scripts: `native`)", "File observer type"],
        ["`AURA_POLL_SECONDS`", "`30`", "`30`", "Polling observer interval"],
        ["`AURA_SWEEP_INTERVAL_SECONDS`", "`600`", "not set (scripts: `60`)", "Re-scan for missed bytes; `<= 0` disables"],
        ["`AURA_FLUSH_SECONDS` / `AURA_FLUSH_MAX_ROWS`", "`30` / `20000`", "not set", "Lake flush interval / early-flush row count"],
        ["`AURA_COMPACT_MIN_FILES`", "`50`", "not set", "Compact today's partition at this many files"],
        ["`AURA_COVERAGE_INTERVAL`", "`300`", "not set", "Ingest coverage report"],
        ["`AURA_DBT_RUN_INTERVAL_MINUTES`", "`5`", "`5`", "dbt cycle, start to start; `<= 0` disables"],
        ["`AURA_DBT_TIMEOUT_SECONDS`", "`1800`", "not set", "Timeout per dbt command"],
        ["`AURA_DBT_DIR` / `AURA_VERIFY_SCRIPT`", "`/app/dbt` / `/app/scripts/verify/run_all.mjs`", "`/app/dbt` / not set", "dbt project dir / number-check script"],
        ["`AURA_DBT_THREADS` / `AURA_DBT_DUCKDB_THREADS`", "set in dbt profile (file not opened)", "`2` / `2` (scripts: threads `1`)", "Models built concurrently / DuckDB threads per query"],
        ["`AURA_DBT_MEMORY_LIMIT`", "set in dbt profile (file not opened)", "`4000MB` (scripts: `6GB`)", "DuckDB pool for dbt; keep ~1 GB below `mem_limit 5g`"],
        ["`AURA_REDACT_PAYLOAD`", "`true`", "`true`", "Secret/base64 redaction on payload"],
        ["`AURA_HASH_CONTENT`", "off", "empty", "`1`/`true` hashes conversation text at ingest"],
        ["`AURA_MODEL_WINDOWS_JSON`", "empty", "empty", "Override context window sizes"],
        ["`AURA_DEFAULT_PERSON_ID` / `_NAME`", "OS username", "falls back to `AURA_USER`", "Person instead of container `root`"],
        ["`AURA_QUERY_TIMEOUT_MS`", "`15000`", "not set", "Frontend per-query timeout"],
        ["`AURA_DUCKDB_THREADS` / `AURA_DUCKDB_MEMORY_LIMIT`", "`4` / `1GB`", "not set", "Frontend DuckDB limits (container `mem_limit 1536m`)"],
        ["`NODE_ENV`", "—", "`production`", "Frontend runtime mode"]]
    S.append(sec("s10", "Configuration",
        ul(["Runtime config = environment variables; every path defaults under `AURA_DATA_DIR`. `aura.toml` is metadata only — `%s`." % at("aura.toml", r"Nothing in this")])
        + table(["Setting", "Default", "Compose", "Purpose"], cfg)
        + cite("%s, %s, %s, %s" % (at(COMPOSE, r"AURA_RUN_MODE", r"AURA_DEFAULT_PERSON_NAME"), W("main.py", r"^def load_config", r"verify_script="), at(DBJS, r"const DATA_DIR", r"QUERY_TIMEOUT_MS"), at("start.ps1", r"AURA_RUN_MODE", r"AURA_DBT_MEMORY_LIMIT")))
        + ul(["`.env` (copy of `.env.example`) feeds compose substitution; values not documented here — `<redacted>`.",
              "`dbt/profiles.yml` reads `AURA_DB_PATH` and the `AURA_DBT_*` names; file not opened.",
              "Removed in the redesign: `AURA_READ_DB_PATH`, `AURA_SNAPSHOT_INTERVAL`, `AURA_BACKFILL_BATCH_SIZE`, `AURA_BACKFILL_BATCH_SECONDS` — `%s`." % at(README, r"^Removed:"),
              "Container limits: watcher `mem_limit 5g`, frontend `1536m` — `%s`, `%s`." % (at(COMPOSE, r"mem_limit: 5g"), at(COMPOSE, r"mem_limit: 1536m"))])))

    # ---- 11
    tree = """watcher/            Python package: ingest, lake, state, dbt cycle, publish
  src/aura_watcher/ main.py · ingest.py · lake.py · state.py · dbt_cycle.py · read_tables.sql · redact.py · coverage.py · export_legacy.py · adapters/
  tests/            pytest suite (%d test modules, %d tests)
dbt/                dbt project "aura"
  models/           staging/ · intermediate/ · marts/
  macros/           lake_cutoff.sql · recent_sessions.sql
  seeds/            model_pricing.csv
  tests/            %d singular tests
frontend/           Next.js dashboard
  app/              %d page routes + api/ (%d handlers)
  lib/              db.ts · fmt.ts · range.ts · api-safe.ts · queries/
  components/       SVG charts, tables
scripts/verify/     run_all.mjs (run by the watcher after each cycle, and by CI)
docs/               number-map.md · blog/ · build_overview.py · build_technical.py
data/<user>/        runtime only, git-ignored
  lake/             <table>/date=<d>/part-*.parquet (5 tables)
  work/             aura.duckdb (dbt work DB) · aura.duckdb.tmp/ (spill)
  read/             v<stamp>/aura.duckdb · CURRENT
  state/            aura_state.sqlite · native.pids
  inbox/            verdicts-inbox.jsonl
  artifacts/        watcher_status.json · run_results.json · publish.ndjson · freshness.ndjson · number_verify.json
  logs/             native mode only
docker-compose.yml  watcher + frontend services
start.ps1 · start.sh  native run modes
.github/workflows/  ci.yml""" % (N_TEST_FILES, N_TESTS, n_sing, n_pages, n_api)
    S.append(sec("s11", "Folder tree", '<pre class="tree">%s</pre>' % esc(tree) + ul([
        "`data/` is git-ignored — `%s`." % at(".gitignore", r"^data/"),
        "Per-user data dir `data/<user>/` — `%s`." % at(COMPOSE, r"\./data/\$\{AURA_USER"),
        "The lake has %d tables, one directory each — `%s`." % (n_lake, W("lake.py", r"^SCHEMAS = "))])))

    # ---- 12
    C = lambda *cmds: Raw("<br>".join("<code>%s</code>" % esc(x) for x in cmds))
    S.append(sec("s12", "Commands", table(["Task", "Command", "Source"], [
        ["First run (compose)", C("cp .env.example .env", "docker compose up --build"), "`%s`" % at(README, r"^cp \.env\.example", r"^docker compose up --build")],
        ["Open dashboard", C("http://127.0.0.1:3000"), "`%s`" % at(README, r"Then open")],
        ["Native, Windows", C(".\\start.ps1", ".\\start.ps1 -Rebuild", ".\\start.ps1 -Stop"), "`%s`" % at("start.ps1", r"\.\\start\.ps1 ", r"-Stop")],
        ["Native, Linux/macOS (untested)", C("./start.sh", "./start.sh --rebuild", "./start.sh stop"), "`%s`" % at("start.sh", r"\./start\.sh ", r"stop ")],
        ["Stop compose", C("docker compose down"), "`%s`" % at(README, r"^\| Stop ")],
        ["One sweep + one dbt cycle", C("python -m aura_watcher.main --once --with-dbt"), "`%s`" % W("main.py", r"--once", r"--with-dbt")],
        ["dbt by hand (watcher stopped)", C("cd dbt", "dbt run --profiles-dir . --no-partial-parse"), "`%s`" % at(README, r"^dbt run --profiles-dir")],
        ["Full refresh of fact_prompts", C("dbt run --full-refresh"), "`%s` (needs the full 4 GB pool)" % at(README, r"Known limit")],
        ["Frontend dev", C("cd frontend", "npm run dev"), "`%s`" % at(README, r"npm run dev")],
        ["Legacy DuckDB import (once)", C("python -m aura_watcher.export_legacy --src data/aura.duckdb --data-dir data/<user>"), "`%s`" % at(README, r"export_legacy --src")],
        ["Number verify", C("cd scripts/verify && npm install && npm run verify"), "`%s` (set `AURA_READ_DIR`, `AURA_ARTIFACTS_DIR`)" % at("scripts/verify/package.json", r'"verify"')],
        ["CI: watcher", C("python -m pip install -e ./watcher pytest ruff", "python -m ruff check watcher/src", "python -m pytest watcher/tests -q"), "`%s`" % at(".github/workflows/ci.yml", r"pip install -e \./watcher pytest ruff", r"pytest watcher/tests")],
        ["CI: pipeline", C("python -m aura_watcher.main --once --with-dbt", "dbt test --profiles-dir . --no-partial-parse", "npm ci --legacy-peer-deps", "npm run build", "npm test", "node scripts/verify/run_all.mjs"), "`%s`" % at(".github/workflows/ci.yml", r"Watcher once \+ dbt cycle", r"Number checks")]])
        + ul(["Local dbt needs absolute `AURA_DB_PATH`, `AURA_LAKE_DIR`, `AURA_VERDICTS_INBOX` and an existing inbox file — `%s`." % at(README, r"export AURA_DB_PATH", r"dbt run --profiles-dir")])))

    # ---- 13
    S.append(sec("s13", "Deploy and access", d_deploy()
        + key("frame = machine / container · grey = data · dashed grey = not built")
        + notice("The only runtime environment is one developer machine; CI builds no Docker image and deploys nothing.")
        + "<h3>Environments</h3>"
        + table(["Environment", "Runs", "How", "Source"], [
            ["Local Docker (default)", "watcher + frontend containers", "`docker compose up --build`", "`%s`, `%s`" % (COMPOSE + ":1", at(README, r"^## Quick start"))],
            ["Local native", "watcher + frontend as host processes", "`start.ps1` / `start.sh`", "`%s`" % at("start.ps1", r"^# Native")],
            ["CI", "ruff, pytest, pipeline on fixtures, Next build, vitest", "GitHub Actions on push to `main` and PRs", "`%s`" % at(".github/workflows/ci.yml", r"^on:", r"pull_request")],
            ["Staging / production / team hub", "—", "Not defined in source — confirm with owner", "`%s` (proposal only)" % at(README, r"## From individual to team", r"## Roadmap")]])
        + "<h3>Deploy steps</h3>"
        + "<ol><li>Install the prerequisites below.</li>"
          "<li><code>cp .env.example .env</code>; set <code>AURA_DEFAULT_PERSON_ID</code>, <code>AURA_DEFAULT_PERSON_NAME</code> (values <code>&lt;redacted&gt;</code>).</li>"
          "<li>Optional: set <code>CLAUDE_LOGS_DIR</code> if transcripts are not in <code>&lt;user-home&gt;/.claude/projects</code>.</li>"
          "<li><code>docker compose up --build</code></li>"
          "<li>The first dbt cycle starts at once on whatever the lake holds; until it publishes, pages show <code>read DB not published yet</code>. <code>/observability</code> shows progress.</li></ol>"
        + ul(["Update: `git pull origin main`, then `docker compose up --build` — pull rule from `CLAUDE.md`, rebuild from `%s`." % at(README, r"^docker compose up --build")])
        + "<h3>Roll back</h3>"
        + '<p><b>Rollback: Not defined in source — confirm with owner.</b></p>'
        + ul(["Data in `./data/<user>` survives rebuilds (bind mount) — `%s`." % at(COMPOSE, r"\./data/\$\{AURA_USER"),
              "Re-ingest is idempotent (checkpoints + dedup), so a rebuilt image re-uses existing data — `%s`." % at(README, r"File paths are stored as logical paths"),
              "A bloated work DB can be deleted with Aura stopped; the next cycle rebuilds it from the lake — `%s`." % at(README, r"\*\*Work DB growth\.\*\*"),
              "A hung `docker compose stop` means `init: true` is missing — `%s`." % at(COMPOSE, r"init: true")])
        + "<h3>Prerequisites</h3>"
        + table(["Tool", "Version", "Why", "Source"], [
            ["Docker + Docker Compose", "not pinned", "run both services", "`%s`" % at(README, r"Requirements:")],
            ["Python", "3.12 (3.13/3.14 unsupported)", "native watcher/dbt", "`%s`, `%s`" % (at("start.ps1", r"Python 3\.12 is required"), at("watcher/Dockerfile", r"^FROM python"))],
            ["Node.js", "20 in images; ≥ 20 native", "frontend, verify runner", "`%s`, `%s`" % (at("frontend/Dockerfile", r"^FROM node"), at("start.ps1", r"Node >= 20 is required"))],
            ["dbt-core / dbt-duckdb / duckdb", "%s / %s / %s (pinned)" % (PIN("dbt-core"), PIN("dbt-duckdb"), PIN("duckdb")), "transforms", "`%s`" % at("watcher/pyproject.toml", r"dependencies = \[", r"\]")],
            ["`@duckdb/node-api`", PKG("@duckdb/node-api"), "frontend DB reads", "`%s`" % at("frontend/package.json", r"@duckdb/node-api")],
            ["Claude Code transcripts", "at least 1 session in `<user-home>/.claude/projects`", "input data", "`%s`" % at(README, r"Requirements:")],
            ["Config names", "`.env`: `AURA_DEFAULT_PERSON_ID`, `AURA_DEFAULT_PERSON_NAME`, `AURA_HASH_CONTENT`, `CLAUDE_LOGS_DIR`", "compose substitution", "`%s`" % at(COMPOSE, r"AURA_HASH_CONTENT")]])
        + "<h3>Access</h3>"
        + table(["What", "Where", "Notes"], [
            ["Dashboard", "`http://127.0.0.1:3000`", "no login; published on localhost only — `%s`" % at(COMPOSE, r"127\.0\.0\.1:3000")],
            ["Observability", "`http://127.0.0.1:3000/observability`", "polls every 10 s"],
            ["JSON API", "`/api/dashboard`, `/api/sessions`, `/api/agents/[name]`, `/api/apps`, `/api/people`, `/api/errors`, `/api/observability`", "%d GET + 1 POST" % (n_api - 1)],
            ["Work DB", "host `data/<user>/work/aura.duckdb`", "single writer: stop the watcher before opening"],
            ["Read DB", "host `data/<user>/read/CURRENT` → `v<stamp>/aura.duckdb`", "open `READ_ONLY`"],
            ["Artifacts", "`data/<user>/artifacts/` (`watcher_status.json`, `run_results.json`, `sources.json`, `manifest.json`, `publish.ndjson`, `freshness.ndjson`, `number_verify.json`, `history/`)", "read by `/observability`"],
            ["Logs", "compose: `docker compose logs -f watcher`; native: `data/<user>/logs/`", "`PYTHONUNBUFFERED=1` → live (`%s`)" % at("watcher/Dockerfile", r"PYTHONUNBUFFERED")],
            ["Access requests / roles", "Not defined in source — confirm with owner", "—"]])
        + "<h3>Health checks</h3>"
        + ul(["Healthy = fresh `watcher_status.json`, a recent successful dbt cycle with a published version, 0 errors per hour."])
        + table(["Check", "Command / place", "Healthy", "Source"], [
            ["Container health", "`docker compose ps`", "both `healthy`", "`%s`, `%s`" % (at(COMPOSE, r"healthcheck:", r"start_period"), at(COMPOSE, r"fetch\('http://127"))],
            ["Watcher healthcheck rule", "`watcher_status.json` mtime < 120 s", "exit 0", "`%s`" % at(COMPOSE, r"watcher_status\.json")],
            ["Recent ingestion", "`last_flush_at` and `max_event_ts` in `watcher_status.json`; or SQL below on the lake", "advancing while Claude Code is in use", "`%s`; `%s`" % (W("main.py", r"^def write_status", r"\"dbt\": dict"), at("CLAUDE.md", r"read_parquet"))],
            ["Pipeline page", "`/observability` headline + bronze/dbt/error cards", "bronze < 300 s, dbt < 10 min + success, 0 errors/h", "`%s`" % at("frontend/lib/queries/observability.ts", r"^function bronzeStatus", r"^function errorBasedHealth")],
            ["dbt source freshness", "`sources.json` / observability table", "`raw_events` < 5 min warn, < 30 min error", "`%s`" % at("dbt/models/staging/sources.yml", r"warn_after", r"error_after")],
            ["Number integrity", "`artifacts/number_verify.json`", "`fail: 0` of `total: 8`", "`%s`" % at("scripts/verify/run_all.mjs", r"check: 'session_cost_reconciles'", r"check: 'sdk_verbatim_cost'")],
            ["Freshness lag", "`artifacts/freshness.ndjson`", "median under 5 min (target, not yet measured warm)", "`%s`; `%s`" % (at(DBTC, r"^def freshness_lag"), at(README, r"The target is a median"))]])
        + '<div class="payloads">' + payload("IN", "lake · from CLAUDE.md (Goal-Driven Execution)", "SELECT count(*)\nFROM read_parquet('data/<user>/lake/raw_events/*/*.parquet')\nWHERE ingested_at > (now() AT TIME ZONE 'UTC') - INTERVAL 5 minutes;", "sql") + "</div>"
        + ul(["`ingested_at` is flush time in naive UTC; zero rows is normal when nobody is using Claude Code.",
              "Do not open the work DB while the watcher runs; open read DBs `READ_ONLY`."])
        + "<h3>Observability thresholds</h3>"
        + table(["Signal", "Green", "Yellow", "Red"], [
            ["bronze age", "< 300 s", "300-1800 s", "≥ 1800 s"],
            ["dbt run", "< 10 min and success", "10-60 min or failed", "> 60 min or no `run_results.json`"],
            ["watcher errors / hour", "0", "1-10", "> 10"]]) + cite("from %s" % at("frontend/lib/queries/observability.ts", r"^function bronzeStatus", r"^function errorBasedHealth"))
        + '<div class="payloads">' + payload("OUT", "healthy log excerpt · from dbt_cycle.py print strings", "[dbt] seed\n[dbt] run\n[dbt] test") + "</div>"))

    # ---- 14
    S.append(sec("s14", "Operational gotchas", table(["#", "Symptom", "Cause", "What to do", "Source"], cls="cards", rows=[
        ["1", "Numbers stop advancing", "A failed or timed-out dbt cycle (or failed publish) keeps the previous read DB live", "Check dbt status on `/observability`; error is in the watcher log and `watcher_status.json`", "`%s`, `%s`" % (at(README, r"Numbers stop advancing"), at(DBTC, r'status\["error"\] = "publish failed"'))],
        ["2", "`Out of Memory … 16383.9 PiB used`", "Orphan spill files after an unclean shutdown; DuckDB 1.5.4 temp accounting underflows, so every spill is refused (spurious OOM)", "The watcher purges `work/aura.duckdb.tmp/` at startup and before each dbt command; else empty it with the watcher stopped", "`%s`, `%s`" % (at(DBTC, r"^def purge_duckdb_spill_dir", r'"""$'), at(README, r"16383\.9 PiB"))],
        ["3", "Real OOM, e.g. `3.7 GiB/3.7 GiB used`", "`fact_prompts` full refresh needs the full 4 GB pool", "Keep `AURA_DBT_MEMORY_LIMIT` ≥ 4 GB and ~1 GB under `mem_limit`; lower dbt threads first", "`%s`, `%s`" % (at(README, r"Known limit"), at(COMPOSE, r"Keep ~1 GB below"))],
        ["4", "Live ingestion silently stops", "PollingObserver freeze (suspected hung stat on the Windows bind mount): `max_event_ts` stuck at the last backfill, no traceback, no `watcher_errors` row, dbt keeps cycling. Cause not reproduced in code", "Compare `max_event_ts` and `files_pending` in `watcher_status.json`; the sweep re-queues files whose size != offset every 600 s; restart the watcher", "`%s`, `%s`" % (W("ingest.py", r"^def sweep", r"ctx\.last_sweep = files"), W("main.py", r"^def write_status", r"files_pending"))],
        ["5", "Dashboard says `read DB not published yet`, panels empty", "No dbt cycle has published yet, so `read/CURRENT` is missing", "Wait for the first cycle; watch `/observability` or the watcher log", "`%s`, `%s`" % (at(DBJS, r"read DB not published yet"), at(README, r"read DB not published yet"))],
        ["6", "Costs show `$—`, tests fail on a model", "New model id not in the seed; the watcher logs `unknown_model`", "Add a row to `dbt/seeds/model_pricing.csv`", "`%s`, `%s`" % (at(FMC, r"WHEN mp\.model IS NULL"), at(DBTC, r'"unknown_model"'))],
        ["7", "dbt views fail (\"catalog not found\")", "Work DB basename is not `aura.duckdb`", "Keep `work/aura.duckdb`; local copies must also be named `aura.duckdb`", "`%s`" % at(DBTC, r"dbt bakes the catalog")],
        ["8", "`another Aura watcher … is running`, exit 2", "The other run mode wrote its status in the last 120 s", "Stop it (`docker compose down`, `start.ps1 -Stop`) or wait", "`%s`" % W("main.py", r"^def mode_guard", r"return None$")],
        ["9", "`docker compose stop` hangs", "dbt child not reaped without an init process", "Keep `init: true` on the watcher service", "`%s`" % at(COMPOSE, r"init: true")],
        ["10", "Extra `read/v*` dirs on Windows", "A version the frontend still has open cannot be deleted", "A later cycle removes it", "`%s`" % at(DBTC, r"^def prune", r"retried next cycle|PermissionError")]])
        + ul(["Windows checkouts: `.gitattributes` forces LF so containers start — `%s`." % at(".gitattributes", r"eol=lf"),
              "A native stop is a hard kill; up to 30 s of buffered rows are re-read at the next start — `%s`." % at("start.ps1", r"A stop is a hard kill"),
              "Code defaults match compose (5 min dbt, 30 s flush); native mode sweeps every 60 s."])))

    # ---- 15
    def st(x):
        return Raw('<span class="st %s">%s</span>' % ("ok" if x == "C" else "nv", "Confirmed" if x == "C" else "Not verified"))

    def wh(*paths):
        return Raw(" ".join("<code>%s</code>" % esc(p) for p in paths))
    I = [
        ("I-1", "`int_turns` header says sidechain turns get `user_prompt = NULL`; the ASOF join attaches the last non-sidechain prompt", wh(at(INT, r"Sidechain assistant turns now receive"), at(INT, r"ASOF LEFT JOIN", r"a\.ts\s+>= u\.user_ts")), "Code vs comment mismatch; sidechain turns show a parent prompt", "C", "Fix the comment or add a `CASE` on `is_sidechain`"),
        ("I-2", "`int_entity_spend` agent rows mix definitions: spend per event agent, tools and commits per session's mode agent", wh(at("dbt/models/intermediate/int_entity_spend.sql", r"fmc\.agent,"), at("dbt/models/intermediate/int_entity_spend.sql", r"COALESCE\(ds\.agent, 'main'\)")), "Agent spend, tools and commits can disagree for mixed-agent sessions", "C", "See decision D-2"),
        ("I-3", "Footer price table hard-coded and stale vs the seed (Opus $15/$75, Gemini 1.5)", wh(at("frontend/components/atoms.tsx", r"Anthropic Pricing", r"Gemini 1\.5 Flash"), seed_line("claude-opus-4-8")), "Footer shows rates the cost chain does not use", "C", "Read rates from the seed or remove the footer"),
        ("I-4", "`aura.toml` is read by no code", wh(at("aura.toml", r"Nothing in this")), "Edits to it have no effect", "C", "Delete it or wire it up"),
        ("I-5", "CI does not build Docker images or run `start.ps1`", wh(at(".github/workflows/ci.yml", r"^jobs:", r"start\.sh syntax")), "Compose and Windows native paths unchecked", "C", "Add an image-build job"),
        ("I-6", "`fact_prompts.app_id` comes from `dim_sessions.app_id`; prompts of sessions without an app match keep NULL", wh(at("dbt/models/marts/fact_prompts.sql", r"ds\.app_id")), "Some prompts missing from per-app views", "N", "Measure the NULL share, then decide"),
        ("I-7", "`/observability` layer ages probe timestamp columns by name; not re-checked against the current marts", wh(at("frontend/lib/queries/observability.ts", r"^export async function getMedallionLayers")), "Age or row-count cells may be blank", "N", "Run against a published read DB and compare"),
        ("I-8", "`fact_prompts` full refresh needs the full 4 GB pool", wh(at(README, r"Known limit")), "First boot or `--full-refresh` can OOM below 4 GB", "C", "Keep the dbt limit ≥ 4 GB")]
    assert len(I) == 8 and sum(1 for r in I if r[4] == "N") == 2
    ihead = ["#", "Issue", "Where (path:line)", "Impact", "Status", "Suggested fix"]
    irows = lambda rs: [[r[0], r[1], r[2], r[3], st(r[4]), r[5]] for r in rs]
    asm = [
        ["Compose (`docker-compose.yml`) is the supported deployment", "All intervals, limits and paths here are compose values; native mode differs (sweep 60 s, 1 dbt thread)"],
        ["Single tenant `local`", "Pricing tenant logic untested for more tenants"],
        ["Time zone is UTC", "dbt sets `SET GLOBAL TimeZone = 'UTC'`; the watcher passes `TZ=UTC` to dbt — `%s`, `%s`" % (at("dbt/dbt_project.yml", r"SET GLOBAL TimeZone"), at(DBTC, r'"TZ": "UTC"'))],
        ["Warm 5-min cycle time is unknown", "The under-5-minute freshness target is not demonstrated; only the cold build (1347 s) is measured, and that figure is owner-reported"],
        ["JSONL schema is undocumented", "Parsing rules reflect observed fields; unknown event types are counted in `file_stats.dropped_unknown`"],
        ["Native `start.sh` untested", "Only `bash -n` runs in CI — `%s`" % at(".github/workflows/ci.yml", r"bash -n start\.sh")]]
    dec = ["**D-1 Footer prices:** read from the seed (recommended) or remove the footer — until then it shows rates the pipeline does not use.",
           "**D-2 Agent attribution:** per model call for spend, tools and commits (recommended) or session mode for all — until then agent rows mix definitions.",
           "**D-3 `aura.toml`:** delete (recommended) or wire into config — until then it suggests settings that do nothing.",
           "**D-4 CI scope:** add a Docker image build job (recommended) or document that compose is untested in CI."]
    decl = "<ul>" + "".join("<li>%s</li>" % re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", md(d)) for d in dec) + "</ul>"
    S.append(sec("s15", "Known issues, assumptions, and decisions needed",
        ul(["Status: Confirmed = checked in code at the cited lines; Not verified = listed as not re-checked in the graph rebuild of 2026-11-11."])
        + "<h3>Issues</h3>" + table(ihead, irows(I), "issues") + cite("from the knowledge graph's known-issues list and the CONFIRMED notes in its dbt logic pages, re-checked at the cited lines")
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
    P = [("Does", ["`watcher` parses Claude Code and SDK-trace JSONL into a Parquet lake, oldest file first, flushing every 30 s.",
                   "`redact.py` scrubs secrets from `payload` before write; optional SHA-256 content hashing.",
                   "A dbt thread builds %d models every 5 min into a work DB; cost is priced per model call." % len(MODEL_FILES),
                   "Each successful run publishes a read-only DB `read/v<stamp>`; `CURRENT` switches atomically.",
                   "`frontend` serves %d pages and %d API handlers on `127.0.0.1:3000`; `/observability` shows pipeline health."
                   % (len(list((ROOT / "frontend/app").rglob("page.tsx"))), len(list((ROOT / "frontend/app/api").rglob("route.ts"))))]),
         ("Doesn't", ["Doesn't change or delete transcripts — logs mounted read-only (`/logs/claude:ro`).",
                      "Doesn't authenticate users or manage access — no login, no roles.",
                      "Doesn't fetch prices — only `dbt/seeds/model_pricing.csv`.",
                      "Doesn't use cron or Airflow — dbt runs on a watcher thread.",
                      "Doesn't deploy anywhere — CI checks only; Gemini/Codex adapters not built."]),
         ("Limitations", ["Dashboard lags: one flush (30 s) + the wait for the next 5-min cycle + run and publish time.",
                          "Warm cycle time is not measured; the last full cold build took 1347 s (PASS=155, ERROR=0).",
                          "Incremental models rebuild only sessions with new lake rows.",
                          "dbt test failures don't block publish (`dbt run`, not `dbt build`).",
                          "One machine, one tenant (`local`); dbt pool 4000 MB inside a 5 GB container."]),
         ("Top issues", ["`int_turns` comment says sidechain turns get no prompt; code gives them the parent prompt — Confirmed",
                         "`int_entity_spend` agent rows mix per-event spend with per-session tools and commits — Confirmed",
                         "Footer price table is stale against the pricing seed — Confirmed",
                         "`aura.toml` is read by no code — Confirmed",
                         "CI builds no Docker image and does not run `start.ps1` — Confirmed",
                         "`fact_prompts` full refresh needs the full 4 GB pool — Confirmed",
                         "Prompts of sessions without an app match keep `app_id` NULL — Not verified",
                         "`/observability` layer ages not re-checked against current marts — Not verified"])]
    h = '<div class="otabs">'
    for n, (t, _) in enumerate(P, 1):
        h += '<input type="radio" name="ot" id="ot%d"%s><label for="ot%d">%s</label>' % (n, " checked" if n == 1 else "", n, esc(t))
    for n, (t, items) in enumerate(P, 1):
        lis = "".join("<li>%s</li>" % md(x) for x in items)
        h += '<div class="op" id="op%d"><h3 class="pt">%s</h3>%s</div>' % (n, esc(t), ("<ol>%s</ol>" if n == 4 else "<ul>%s</ul>") % lis)
    return h + "</div>" + cite("Top issues: full detail in section 15. Status rule: Confirmed = checked in code at the cited lines; Not verified = listed as not re-checked in the graph rebuild of 2026-11-11.")


def main():
    S, n_edges, lin = build()
    ex_css = EXAMPLE.read_text(encoding="utf-8")
    css = re.search(r"<style>(.*?)</style>", ex_css, re.S).group(1) + EXTRA_CSS
    titles = ["Big picture", "Architecture", "Flow: ingest and backfill", "Flow: dbt cycle and publish", "Flow: page load",
              "Flow: cost calculation", "Data model", "dbt lineage", "Business rules", "Configuration", "Folder tree", "Commands",
              "Deploy and access", "Operational gotchas", "Known issues, assumptions, and decisions needed"]
    assert len(S) == len(titles)
    S = [re.sub(r"<h2>", "<h2>%d · " % (i + 1), x, count=1) for i, x in enumerate(S)]
    toc = "".join('<li><a href="#s%d">%s</a></li>' % (i + 1, t) for i, t in enumerate(titles))
    chips = "".join("<span>%s</span>" % esc(x) for x in ["watcher · Python 3.12", "dbt-core %s / dbt-duckdb %s (pinned)" % (PIN("dbt-core"), PIN("dbt-duckdb")),
                    "duckdb %s (pinned)" % PIN("duckdb"), "Next.js %s" % PKG("next"), "@duckdb/node-api %s" % PKG("@duckdb/node-api"), "docker compose: 2 services"])
    head = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            '<meta name="generator" content="darshan-singh-meel-docs"><title>Aura technical</title><style>%s</style></head><body><main>' % css)
    top = ('<div class="eyebrow">Technical document</div><h1>Aura technical</h1>%s<div class="chips">%s</div>'
           '<p class="cite">pins from %s, %s</p><nav class="toc"><ol>%s</ol></nav>'
           % (otabs(), chips, at("watcher/pyproject.toml", r"dependencies = \[", r"\]"), at("frontend/package.json", r'"@duckdb/node-api"', r'"next"'), toc))
    OUT.write_text(head + top + chr(10).join(S) + "</main></body></html>", encoding="utf-8")
    print("wrote", OUT.relative_to(ROOT), OUT.stat().st_size, "bytes; lineage edges", n_edges)


if __name__ == "__main__":
    main()
