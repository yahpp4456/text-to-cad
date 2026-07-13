"""Sheet-metal mixed-feature box -- one part exercising hem + jog + mixed wall
heights on the same fold tree (the "deep box, mixed features" stress case).

An asymmetric enclosure on a rectangular base (all four walls fold UP inside,
so the folded footprint equals the declared box size):
- the +X wall is TALL and finishes with a 180-degree safety hem (return lip);
- the -X wall is TALL and finishes with a jog (a stepped return lip);
- the +Y / -Y walls are SHORTER plain walls;
- two cable holes in the tall walls.

Three outputs (cadpy sheet-metal convention): gen_step() = folded 3D (canonical),
gen_flat() = flat-pattern solid (the UI's instant folded/flat toggle uses it),
gen_dxf() = laser-ready flat pattern. Auto corner relief at the base corners.
"""

from build123d import *  # noqa: F401,F403  (repo generator convention)
from cadpy.parts import SheetMetal, jog_web

# ===========================================================================
# Adjustable design parameters (single-level; sliders re-run this file)
# ===========================================================================
PARAMS = {
    "box_w": 140.0,      # OUTER footprint X (inside placement -> exact)
    "box_d": 90.0,       # OUTER footprint Y
    "tall_h": 70.0,      # OUTER height of the two X walls (hem wall / jog wall)
    "short_h": 40.0,     # OUTER height of the two Y walls
    "thick": 2.0,        # sheet thickness
    "bend_r": 2.5,       # inner bend radius
    "k_factor": 0.44,    # neutral-fiber factor
    "hem_len": 10.0,     # return hem on the +X wall tip
    "jog_off": 20.0,     # jog step offset on the -X wall tip
    "jog_len": 15.0,     # jog return-lip length
    "hole_d": 20.0,      # cable hole in the +X wall (-X gets 0.8x)
}


def _check_params():
    p = PARAMS
    inset = p["bend_r"] + p["thick"]
    mf = 4.0 * p["thick"]  # SheetMetal 預設最小凸緣
    if p["box_w"] <= 4 * inset or p["box_d"] <= 4 * inset:
        raise ValueError(
            f"box_w/box_d({p['box_w']:g}×{p['box_d']:g})太小:四面 inside 折彎各吃 "
            f"R+t={inset:g},底面會退化,請加大外形或減小 bend_r")
    for hn, hv in (("tall_h", p["tall_h"]), ("short_h", p["short_h"])):
        if hv <= inset + mf:
            raise ValueError(
                f"{hn}({hv:g})不足:牆高扣折彎 {inset:g} 後低於最小凸緣 {mf:g}")
    if p["tall_h"] - inset <= mf + p["hem_len"]:
        raise ValueError(f"tall_h 不足以在頂端容納摺邊 {p['hem_len']:g}")
    if jog_web(p["jog_off"], 90.0, p["bend_r"], p["thick"]) < mf:
        raise ValueError(f"jog_off({p['jog_off']:g})太小,轉折腹板低於最小凸緣 {mf:g}")


def _build() -> SheetMetal:
    p = PARAMS
    _check_params()
    sm = SheetMetal(thickness=p["thick"], bend_radius=p["bend_r"],
                    k_factor=p["k_factor"], label="mixed_box")
    b = sm.base_rect(p["box_w"], p["box_d"])
    # 四面 inside 壁(高矮混合)
    wxp = b.flange("x+", length=p["tall_h"], placement="inside", label="wall_xp")
    wxn = b.flange("x-", length=p["tall_h"], placement="inside", label="wall_xn")
    b.flange("y+", length=p["short_h"], placement="inside", label="wall_yp")
    b.flange("y-", length=p["short_h"], placement="inside", label="wall_yn")
    # +X 壁頂 180° 回捲摺邊;-X 壁頂轉折階梯唇
    wxp.hem("tip", length=p["hem_len"], label="hem_xp")
    wxn.jog("tip", offset=p["jog_off"], length=p["jog_len"], label="jog_xn")
    # 兩高壁纜孔(wall 局部:x 從折彎切線、y 沿邊寬中心)
    web = p["tall_h"] - (p["bend_r"] + p["thick"])
    span = p["box_d"] - 2.0 * (p["bend_r"] + p["thick"])
    wxp.hole(web / 2.0, span / 2.0, d=p["hole_d"])
    wxn.hole(web / 2.0, span / 2.0, d=p["hole_d"] * 0.8)
    return sm


def gen_step():
    return _build().folded()  # canonical folded 3D


def gen_flat():
    return _build().flat()  # 攤平實體 → UI 摺疊/攤平即時切換


def gen_dxf():
    return _build().dxf()


def check_geometry(shape):
    from cadpy.parts.sheet_metal import check_geometry as check_sheet

    check_sheet(shape)


if __name__ == "__main__":
    s = gen_step()
    print("label:", s.label, "volume:", round(s.volume, 2))
    check_geometry(s)
    print("flat size:", tuple(round(v, 3) for v in _build().flat_size()))
    print("static checks passed")
