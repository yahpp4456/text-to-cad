# -*- coding: utf-8 -*-
"""把 content.py(文案)+ img/*.json(截圖框選中繼)組裝成 HTML 手冊。

輸出:
  docs/guide/index.html               資料夾版(img/ 相對路徑,檔案小、圖可單看)
  docs/guide/index.selfcontained.html 自包含版(圖轉 data-URI,單檔可分享;圖降尺寸控制大小)
  docs/guide/artifact.html            Artifact 發佈版(body-only,無 doctype/html/head)

框選不烙圖:用 CSS 絕對定位的疊框(座標換成百分比,響應式縮放框跟著縮)+ 編號圖例。
配色沿用 app 的 SUIYAO token(ink/design/emit/part),系統字型,亮暗主題自適應。
"""
import base64
import html
import io
import json
import os
import re

from guidelib import GUIDE as GUIDE_DIR
from guidelib import IMG

from content import GUIDE

TONE = {"primary": "#2e3192", "accent": "#18a0c4", "good": "#34ab86", "warn": "#e0902a"}
_INLINE_CACHE = {}


# ── 行內 markdown(**粗體**、`程式碼`)──
def md_inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
    return s


def load_shot(shot_id):
    p = os.path.join(IMG, shot_id + ".json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def inline_src(shot_id, max_w=1600, fmt="webp"):
    """把 PNG 降到最大寬 max_w、轉指定格式後包成 data-URI(單檔版控制大小)。
    fmt='webp' 對 UI 截圖壓縮率極高、文字仍清晰;'png' 為無損。"""
    key = (shot_id, max_w, fmt)
    if key in _INLINE_CACHE:
        return _INLINE_CACHE[key]
    png = os.path.join(IMG, shot_id + ".png")
    with open(png, "rb") as f:
        data = f.read()
    mime = "image/png"
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(data)).convert("RGB")
        if im.width > max_w:
            im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        if fmt == "webp":
            im.save(buf, format="WEBP", quality=90, method=6)
            mime = "image/webp"
        else:
            im.save(buf, format="PNG", optimize=True)
        data = buf.getvalue()
    except Exception:
        pass
    uri = f"data:{mime};base64," + base64.b64encode(data).decode("ascii")
    _INLINE_CACHE[key] = uri
    return uri


def render_figure(block, inline, max_w=1600, fmt="webp"):
    shot = block["shot"]
    meta = load_shot(shot)
    if not meta and block.get("fallback"):
        shot = block["fallback"]
        meta = load_shot(shot)
    if not meta:
        return f'<figure class="fig fig-missing">（缺圖:{html.escape(block["shot"])} — 尚未擷取)</figure>'

    vw = meta["viewport"]["width"]
    vh = meta["viewport"]["height"]
    src = inline_src(shot, max_w, fmt) if inline else f"img/{shot}.png"

    boxes, legend = [], []
    for c in meta["callouts"]:
        n = c["n"]
        tone = TONE.get(c.get("tone", "primary"), TONE["primary"])
        label = c.get("label", "")
        if c.get("rect"):
            x, y, w, h = c["rect"]
            pad = c.get("pad", 6)
            x -= pad
            y -= pad
            w += pad * 2
            h += pad * 2
            # 夾限在圖片範圍內:貼邊的框不外溢,編號徽章才不會被 frame 的 overflow 裁掉
            x1 = min(vw, x + w)
            y1 = min(vh, y + h)
            x = max(0, x)
            y = max(0, y)
            w = max(0, round(x1 - x, 1))
            h = max(0, round(y1 - y, 1))
            style = (
                f"left:{x / vw * 100:.2f}%;top:{y / vh * 100:.2f}%;"
                f"width:{w / vw * 100:.2f}%;height:{h / vh * 100:.2f}%;--c:{tone}"
            )
            boxes.append(f'<div class="cap" style="{style}"><span class="cap-n">{n}</span></div>')
        legend.append(
            f'<li><span class="lg-n" style="--c:{tone}">{n}</span>'
            f'<span class="lg-t">{md_inline(label)}</span></li>'
        )

    cap = ""
    if block.get("caption"):
        cap = f'<figcaption class="fig-cap">{md_inline(block["caption"])}</figcaption>'
    frame = (
        f'<div class="fig-frame"><div class="fig-img">'
        f'<img src="{src}" alt="{html.escape(shot)}" loading="lazy">{"".join(boxes)}</div></div>'
    )
    lg = f'<ol class="fig-legend">{"".join(legend)}</ol>' if legend else ""
    return f'<figure class="fig">{cap}{frame}{lg}</figure>'


def render_block(b, inline, max_w=1600, fmt="webp"):
    t = b["type"]
    if t == "p":
        return f'<p>{md_inline(b["md"])}</p>'
    if t == "h":
        return f'<h3>{md_inline(b["text"])}</h3>'
    if t == "figure":
        return render_figure(b, inline, max_w, fmt)
    if t == "steps":
        items = "".join(f"<li>{md_inline(x)}</li>" for x in b["items"])
        return f'<ol class="steps">{items}</ol>'
    if t == "bullets":
        items = "".join(f"<li>{md_inline(x)}</li>" for x in b["items"])
        return f'<ul class="bullets">{items}</ul>'
    if t == "table":
        head = "".join(f"<th>{md_inline(x)}</th>" for x in b["head"])
        rows = "".join(
            "<tr>" + "".join(f"<td>{md_inline(c)}</td>" for c in r) + "</tr>" for r in b["rows"]
        )
        return f'<div class="tbl-wrap"><table><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>'
    if t == "note":
        tone = b.get("tone", "info")
        return f'<div class="note note-{tone}">{md_inline(b["md"])}</div>'
    if t == "code":
        return f'<pre class="code">{html.escape(b["text"])}</pre>'
    return ""


def render_chapter(ch, inline, max_w=1600, fmt="webp"):
    blocks = "".join(render_block(b, inline, max_w, fmt) for b in ch["blocks"])
    return (
        f'<section class="chap" id="{ch["id"]}">'
        f'<h2><span class="chap-num">{html.escape(ch["num"])}</span>'
        f'<span class="chap-title">{html.escape(ch["title"])}</span></h2>'
        f'{blocks}</section>'
    )


CSS = """
:root{
  --ink:#2e3192; --design:#3461b5; --emit:#18a0c4; --part:#34ab86; --warn:#e0902a;
  --bg:#eef1f6; --card:#ffffff; --text:#1c2150; --muted:#8a93a3; --line:#e0e5ee;
  --code-bg:#f2f4fa; --matte:#e6eaf2; --shadow:0 1px 3px rgba(20,30,80,.06),0 8px 30px rgba(20,30,80,.06);
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#0e1016; --card:#161a24; --text:#e7ebf4; --muted:#8b93a6; --line:#252b38;
    --ink:#8a90e8; --design:#6f97e0; --emit:#5cc7e6; --part:#5fcaa4; --warn:#e6a94e;
    --code-bg:#11151d; --matte:#0f131b; --shadow:0 1px 3px rgba(0,0,0,.3),0 8px 30px rgba(0,0,0,.35); }
}
:root[data-theme="light"]{ --bg:#eef1f6; --card:#fff; --text:#1c2150; --muted:#8a93a3; --line:#e0e5ee;
  --ink:#2e3192; --design:#3461b5; --emit:#18a0c4; --part:#34ab86; --warn:#e0902a; --code-bg:#f2f4fa; --matte:#e6eaf2;
  --shadow:0 1px 3px rgba(20,30,80,.06),0 8px 30px rgba(20,30,80,.06); }
:root[data-theme="dark"]{ --bg:#0e1016; --card:#161a24; --text:#e7ebf4; --muted:#8b93a6; --line:#252b38;
  --ink:#8a90e8; --design:#6f97e0; --emit:#5cc7e6; --part:#5fcaa4; --warn:#e6a94e; --code-bg:#11151d; --matte:#0f131b;
  --shadow:0 1px 3px rgba(0,0,0,.3),0 8px 30px rgba(0,0,0,.35); }

*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif;
  line-height:1.7;-webkit-font-smoothing:antialiased;}
a{color:var(--design);text-decoration:none}
.wrap{display:grid;grid-template-columns:266px minmax(0,1fr);gap:0;max-width:1240px;margin:0 auto}

/* 側欄 TOC */
.side{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:26px 20px;border-right:1px solid var(--line)}
.brand{font-weight:900;font-size:19px;letter-spacing:.5px;line-height:1.25}
.brand .mk{display:inline-grid;place-items:center;width:26px;height:26px;background:var(--ink);color:#fff;border-radius:6px;font-size:15px;margin-right:8px;vertical-align:-5px}
.eyebrow{font-size:9.5px;letter-spacing:3px;color:var(--muted);font-weight:700;margin:14px 0 4px}
.toc{list-style:none;padding:0;margin:14px 0 0}
.toc li{margin:1px 0}
.toc a{display:flex;gap:9px;padding:6px 9px;border-radius:7px;color:var(--text);font-size:14px;align-items:baseline}
.toc a:hover{background:color-mix(in oklab,var(--design) 12%,transparent)}
.toc a.active{background:color-mix(in oklab,var(--design) 16%,transparent);font-weight:700}
.toc .n{font-size:11px;color:var(--muted);min-width:16px;font-variant-numeric:tabular-nums}
.theme-btn{margin-top:18px;background:var(--card);border:1px solid var(--line);color:var(--text);
  border-radius:8px;padding:7px 12px;font-size:12.5px;cursor:pointer}

/* 主欄 */
.main{padding:40px 46px 120px;min-width:0}
.hero{margin:6px 0 30px;padding-bottom:26px;border-bottom:2px solid var(--line)}
.hero .tag{font-size:10px;letter-spacing:4px;color:var(--emit);font-weight:800}
.hero h1{font-size:36px;line-height:1.15;margin:10px 0 8px;letter-spacing:.5px}
.hero .sub{font-size:16px;color:var(--muted);margin:0}
.chap{scroll-margin-top:16px;padding:30px 0;border-bottom:1px solid var(--line)}
.chap h2{display:flex;align-items:center;gap:14px;font-size:25px;margin:0 0 14px}
.chap-num{display:inline-grid;place-items:center;min-width:38px;height:38px;padding:0 8px;
  background:var(--ink);color:#fff;border-radius:10px;font-size:19px;font-weight:800}
.chap h3{font-size:16.5px;margin:24px 0 8px;color:var(--ink)}
.chap p{margin:11px 0}
code{background:var(--code-bg);padding:1.5px 6px;border-radius:5px;font-size:.9em;
  font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
.code{background:var(--code-bg);border:1px solid var(--line);border-radius:10px;padding:14px 16px;
  overflow-x:auto;font-size:13.5px;font-family:"SFMono-Regular",Consolas,monospace;color:var(--text)}
.steps,.bullets{margin:12px 0;padding-left:0;list-style:none}
.steps{counter-reset:st}
.steps li{position:relative;padding:6px 0 6px 40px;margin:2px 0}
.steps li::before{counter-increment:st;content:counter(st);position:absolute;left:0;top:5px;
  width:26px;height:26px;display:grid;place-items:center;background:var(--design);color:#fff;
  border-radius:50%;font-size:13px;font-weight:700}
.bullets li{position:relative;padding:4px 0 4px 22px;margin:1px 0}
.bullets li::before{content:"";position:absolute;left:4px;top:14px;width:7px;height:7px;
  background:var(--part);border-radius:2px;transform:rotate(45deg)}

/* 表格 */
.tbl-wrap{overflow-x:auto;margin:16px 0}
table{border-collapse:collapse;width:100%;font-size:14px;background:var(--card);border-radius:10px;overflow:hidden;box-shadow:var(--shadow)}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:color-mix(in oklab,var(--ink) 9%,transparent);font-weight:700;font-size:13px;white-space:nowrap}
tr:last-child td{border-bottom:none}

/* note */
.note{margin:16px 0;padding:13px 16px 13px 18px;border-radius:10px;font-size:14.5px;border-left:4px solid var(--design);
  background:color-mix(in oklab,var(--design) 8%,var(--card))}
.note-tip{border-left-color:var(--part);background:color-mix(in oklab,var(--part) 9%,var(--card))}
.note-warn{border-left-color:var(--warn);background:color-mix(in oklab,var(--warn) 12%,var(--card))}
.note-info{border-left-color:var(--emit);background:color-mix(in oklab,var(--emit) 9%,var(--card))}

/* 圖 + 疊框 */
.fig{margin:20px 0 26px}
.fig-cap{font-size:14px;color:var(--muted);margin:0 0 9px}
/* matte:給截圖加一圈留白,貼邊的框與編號徽章才有空間、不被裁 */
.fig-frame{padding:28px;background:var(--matte);border-radius:14px;overflow:hidden;
  box-shadow:var(--shadow);border:1px solid var(--line)}
.fig-img{position:relative;line-height:0}
.fig-img img{width:100%;height:auto;display:block;border-radius:5px;
  box-shadow:0 0 0 1px color-mix(in oklab,var(--text) 12%,transparent)}
.cap{position:absolute;border:2.5px solid var(--c);border-radius:7px;
  box-shadow:0 0 0 2px color-mix(in oklab,var(--c) 22%,transparent);pointer-events:none}
.cap-n{position:absolute;left:-2px;top:-2px;transform:translate(-40%,-40%);
  min-width:22px;height:22px;padding:0 5px;display:grid;place-items:center;background:var(--c);color:#fff;
  border-radius:50%;font-size:12.5px;font-weight:800;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.fig-legend{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:6px}
.fig-legend li{display:flex;gap:10px;align-items:baseline;font-size:14px}
.lg-n{flex:none;width:21px;height:21px;display:grid;place-items:center;background:var(--c);color:#fff;
  border-radius:50%;font-size:12px;font-weight:800}
.fig-missing{padding:30px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:12px}

@media (max-width:900px){
  .wrap{grid-template-columns:1fr}
  .side{position:static;height:auto;border-right:none;border-bottom:1px solid var(--line)}
  .toc{display:flex;flex-wrap:wrap;gap:2px}
  .main{padding:26px 20px 80px}
  .hero h1{font-size:28px}
}
"""

TOC_SCRIPT = """
(function(){
  var links=[].slice.call(document.querySelectorAll('.toc a'));
  var secs=links.map(function(a){return document.querySelector(a.getAttribute('href'));});
  function onScroll(){
    var y=window.scrollY+120,cur=0;
    for(var i=0;i<secs.length;i++){ if(secs[i]&&secs[i].offsetTop<=y) cur=i; }
    links.forEach(function(a,i){ a.classList.toggle('active',i===cur); });
  }
  window.addEventListener('scroll',onScroll,{passive:true});onScroll();
  var btn=document.querySelector('.theme-btn');
  if(btn){ btn.addEventListener('click',function(){
    var r=document.documentElement, cur=r.getAttribute('data-theme');
    var dark=cur? cur==='dark' : matchMedia('(prefers-color-scheme:dark)').matches;
    r.setAttribute('data-theme', dark?'light':'dark');
  });}
})();
"""


def build_body(inline, with_toggle, max_w=1600, fmt="webp"):
    g = GUIDE
    toc = "".join(
        f'<li><a href="#{ch["id"]}"><span class="n">{html.escape(ch["num"])}</span>'
        f'<span>{html.escape(ch["title"])}</span></a></li>'
        for ch in g["chapters"]
    )
    toggle = '<button class="theme-btn">◑ 切換亮/暗</button>' if with_toggle else ""
    side = (
        f'<aside class="side"><div class="brand"><span class="mk">穗</span>{html.escape(g["title"])}</div>'
        f'<div class="eyebrow">{html.escape(g["tagline"])}</div>'
        f'<nav><ul class="toc">{toc}</ul></nav>{toggle}</aside>'
    )
    hero = (
        f'<header class="hero"><div class="tag">{html.escape(g["tagline"])}</div>'
        f'<h1>{html.escape(g["title"])}</h1><p class="sub">{html.escape(g["subtitle"])}</p></header>'
    )
    chapters = "".join(render_chapter(ch, inline, max_w, fmt) for ch in g["chapters"])
    return f'<div class="wrap">{side}<main class="main">{hero}{chapters}</main></div>'


def build_doc(inline, standalone, max_w=1600, fmt="webp"):
    body = build_body(inline, with_toggle=standalone, max_w=max_w, fmt=fmt)
    style = f"<style>{CSS}</style>"
    script = f"<script>{TOC_SCRIPT}</script>"
    if not standalone:
        # Artifact 版:無 doctype/html/head/body(平台會包)
        return style + body + script
    return (
        '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(GUIDE["title"])}</title>{style}</head>'
        f'<body>{body}{script}</body></html>'
    )


def main():
    outs = {
        # 資料夾版:相對引 img/,原始 PNG(最清晰,適合本機檢視/diff)
        "index.html": build_doc(inline=False, standalone=True),
        # 單一檔版:圖內嵌 WebP(高解析,單檔可直接傳),控制在數 MB
        "index.selfcontained.html": build_doc(inline=True, standalone=True, max_w=1600, fmt="webp"),
        # Artifact 發佈版:body-only + WebP
        "artifact.html": build_doc(inline=True, standalone=False, max_w=1400, fmt="webp"),
    }
    for name, doc in outs.items():
        p = os.path.join(GUIDE_DIR, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(doc)
        print(f"  ✓ {name}  ({len(doc.encode('utf-8')) / 1024:.0f} KB)")
    print(f"\n手冊已生成於 {GUIDE_DIR}")


if __name__ == "__main__":
    main()
