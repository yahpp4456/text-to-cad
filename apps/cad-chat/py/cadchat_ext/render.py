# -*- coding: utf-8 -*-
"""cad-chat 的離屏渲染:把零件畫成 PNG,給 agent 自己看圖用(藍圖 E1)。

不開視窗:OCCT 的 V3d 視圖掛在 Aspect_NeutralWindow 上,用 ToPixMap 取回畫面。每個零件一個顏色
(顏色名稱會回給呼叫端當圖例),畫出面的邊界線讓形狀看得清楚。

這個模組只管「畫」;載入產生器、擺姿態是入口腳本的事。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

# 視角預設:名稱 → 從哪個方向看過去(相機在這個方向上,看向原點);Z 朝上。
VIEWS: dict[str, tuple[float, float, float]] = {
    "iso": (1.0, -1.0, 1.0),
    "iso_back": (-1.0, 1.0, 1.0),
    "front": (0.0, -1.0, 0.0),
    "back": (0.0, 1.0, 0.0),
    "right": (1.0, 0.0, 0.0),
    "left": (-1.0, 0.0, 0.0),
    "top": (0.0, 0.0, 1.0),
    "bottom": (0.0, 0.0, -1.0),
}

# 每個零件一個顏色:名稱給人(與 agent)看,RGB 給繪圖。挑彼此分得開、在白底上都看得見的。
PALETTE: tuple[tuple[str, tuple[float, float, float]], ...] = (
    ("橘", (0.93, 0.55, 0.14)),
    ("藍", (0.20, 0.47, 0.85)),
    ("綠", (0.25, 0.66, 0.37)),
    ("紅", (0.83, 0.24, 0.22)),
    ("紫", (0.56, 0.36, 0.78)),
    ("青", (0.13, 0.66, 0.70)),
    ("棕", (0.58, 0.40, 0.24)),
    ("粉", (0.91, 0.47, 0.68)),
    ("黃綠", (0.62, 0.74, 0.20)),
    ("灰", (0.55, 0.58, 0.62)),
    ("深藍", (0.16, 0.25, 0.55)),
    ("金", (0.80, 0.66, 0.18)),
)

MAX_SIZE = 1600


@dataclass(frozen=True)
class RenderedView:
    view: str
    path: str
    width: int
    height: int


def parse_view(view: str) -> tuple[str, tuple[float, float, float]]:
    """視角名稱或 "az:el"(度;az 從 +X 起逆時針、el 為仰角)→ (正規化名稱, 觀看方向)。"""
    key = str(view or "iso").strip().lower()
    if key in VIEWS:
        return key, VIEWS[key]
    if ":" in key:
        try:
            az, el = (float(part) for part in key.split(":", 1))
        except ValueError:
            raise ValueError(f"視角無效: {view!r}(用 {', '.join(VIEWS)} 或 方位角:仰角,例 45:30)") from None
        if not (-360 <= az <= 360 and -90 <= el <= 90):
            raise ValueError(f"視角無效: {view!r}(方位角 -360~360、仰角 -90~90)")
        a, e = math.radians(az), math.radians(el)
        return f"{az:g}:{el:g}", (math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e))
    raise ValueError(f"視角無效: {view!r}(用 {', '.join(VIEWS)} 或 方位角:仰角,例 45:30)")


def legend_for(names: Sequence[str]) -> list[dict[str, str]]:
    """零件 → 顏色名稱。超過色盤長度時顏色會重複,名稱後面加序號。"""
    out = []
    for i, name in enumerate(names):
        label, _rgb = PALETTE[i % len(PALETTE)]
        out.append({"part": name, "color": label if i < len(PALETTE) else f"{label}{i // len(PALETTE) + 1}"})
    return out


def _topods(shape: Any) -> Any:
    return getattr(shape, "wrapped", shape)


def render_views(
    named_parts: Sequence[tuple[str, Any]],
    out_dir: str | Path,
    *,
    views: Iterable[str] = ("iso",),
    stem: str = "view",
    size: tuple[int, int] = (900, 640),
    hide: Iterable[str] = (),
    ghost: Iterable[str] = (),
    clip: dict | None = None,
    mode: str = "shaded",
) -> list[RenderedView]:
    """把零件畫成 PNG,每個視角一張。

    hide / ghost:零件名稱;hide 不畫,ghost 畫成半透明(看殼裡面的東西)。
    clip:{"axis": "x"|"y"|"z", "at": 座標}——把該座標「正的那一側」切掉,切面補上實心。
    mode:"shaded"(著色 + 面的邊界線)或 "wire"(線框)。
    """
    from OCP.AIS import AIS_InteractiveContext, AIS_Shape
    from OCP.Aspect import Aspect_DisplayConnection, Aspect_NeutralWindow
    from OCP.Graphic3d import Graphic3d_ClipPlane
    from OCP.Image import Image_AlienPixMap
    from OCP.OpenGl import OpenGl_GraphicDriver
    from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
    from OCP.TCollection import TCollection_AsciiString
    from OCP.V3d import V3d_Viewer
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt

    width, height = (max(64, min(MAX_SIZE, int(v))) for v in size)
    if mode not in ("shaded", "wire"):
        raise ValueError(f"mode 無效: {mode!r}(shaded 或 wire)")
    hidden, ghosted = set(hide or ()), set(ghost or ())
    parsed = [parse_view(v) for v in views]
    if not parsed:
        raise ValueError("至少要一個視角")

    driver = OpenGl_GraphicDriver(Aspect_DisplayConnection(), False)
    viewer = V3d_Viewer(driver)
    viewer.SetDefaultLights()
    viewer.SetLightOn()
    context = AIS_InteractiveContext(viewer)
    view = viewer.CreateView()
    window = Aspect_NeutralWindow()
    window.SetSize(width, height)
    view.SetWindow(window)
    view.SetBackgroundColor(Quantity_Color(1.0, 1.0, 1.0, Quantity_TOC_RGB))

    drawer = context.DefaultDrawer()
    drawer.SetFaceBoundaryDraw(True)

    shown = 0
    for index, (name, shape) in enumerate(named_parts):
        if name in hidden:
            continue
        ais = AIS_Shape(_topods(shape))
        _label, (r, g, b) = PALETTE[index % len(PALETTE)]
        context.Display(ais, 1 if mode == "shaded" else 0, 0, False)
        context.SetColor(ais, Quantity_Color(r, g, b, Quantity_TOC_RGB), False)
        if name in ghosted and mode == "shaded":
            context.SetTransparency(ais, 0.75, False)
        shown += 1
    if not shown:
        raise ValueError("沒有可畫的零件(全部被 hide 了)")

    if clip:
        axis = str(clip.get("axis", "")).lower()
        if axis not in ("x", "y", "z"):
            raise ValueError(f"clip.axis 無效: {clip.get('axis')!r}(x / y / z)")
        at = float(clip.get("at", 0.0))
        origin = [0.0, 0.0, 0.0]
        normal = [0.0, 0.0, 0.0]
        origin["xyz".index(axis)] = at
        normal["xyz".index(axis)] = -1.0  # 留下負的那一側
        plane = Graphic3d_ClipPlane(gp_Pln(gp_Pnt(*origin), gp_Dir(*normal)))
        plane.SetCapping(True)
        plane.SetOn(True)
        view.AddClipPlane(plane)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for name, (dx, dy, dz) in parsed:
        view.SetProj(dx, dy, dz)
        if abs(dz) > 0.999:  # 正上 / 正下:預設的「上」會與視線平行,改用 +Y 當畫面的上
            view.SetUp(0.0, 1.0, 0.0)
        else:
            view.SetUp(0.0, 0.0, 1.0)
        view.FitAll(0.06, False)
        view.Redraw()
        pixmap = Image_AlienPixMap()
        if not view.ToPixMap(pixmap, width, height):
            raise RuntimeError(f"離屏渲染失敗(視角 {name})")
        path = out_dir / f"{stem}_{name.replace(':', '_').replace('-', 'm')}.png"
        if not pixmap.Save(TCollection_AsciiString(str(path))):
            raise RuntimeError(f"PNG 寫入失敗: {path}")
        results.append(RenderedView(name, str(path), width, height))
    return results

