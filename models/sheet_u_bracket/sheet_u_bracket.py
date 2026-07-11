"""Sheet-metal U bracket -- the minimal fold-tree dogfood fixture.

One flat base with two opposite 90-degree legs (declared by OUTER leg height),
two base mounting holes and one hole per leg. Demonstrates the cadpy sheet
metal conventions end to end: ``SheetMetal`` fold tree as the single source of
truth with three outputs -- ``gen_step()`` (folded 3D, canonical), ``gen_flat()``
(flat-pattern solid; the UI shows an instant folded/flat toggle from it, no
recompute) and ``gen_dxf()`` (laser-ready flat pattern, CUT + BEND_UP_90 layers).

Sizes: legs fold OUTSIDE the declared base (bend outside), so the folded outer
depth = base_d + 2*(bend_r + thick); leg height is the outer size (``length=``).
"""

from build123d import *  # noqa: F401,F403  (repo generator convention)
from cadpy.parts import SheetMetal

# ===========================================================================
# Adjustable design parameters (single-level; sliders re-run this file)
# ===========================================================================
PARAMS = {
    "base_w": 60.0,    # base plate width  (X; also the leg span)
    "base_d": 40.0,    # base plate depth  (Y, flat part between the bends)
    "leg_h": 30.0,     # OUTER leg height (includes the bend)
    "thick": 2.0,      # sheet thickness
    "bend_r": 3.0,     # inner bend radius
    "k_factor": 0.44,  # neutral-fiber factor (unfold length)
    "hole_d": 5.0,     # mounting hole diameter (2x base, 1x per leg)
}


def _check_params():
    p = PARAMS
    if p["thick"] <= 0 or p["base_w"] <= 0 or p["base_d"] <= 0:
        raise ValueError("base_w/base_d/thick 必須為正")
    min_leg = p["bend_r"] + p["thick"] + 4.0 * p["thick"]
    if p["leg_h"] <= min_leg:
        raise ValueError(
            f"leg_h({p['leg_h']:g})不可小於 bend_r+thick+4×板厚={min_leg:g}:"
            f"折彎後腹板低於折彎模夾持下限")
    # 其餘跨參數約束(孔距折彎/邊距、半徑下限、K 範圍)由 SheetMetal 內建驗證把關


def _build() -> SheetMetal:
    p = PARAMS
    _check_params()
    sm = SheetMetal(thickness=p["thick"], bend_radius=p["bend_r"],
                    k_factor=p["k_factor"], label="u_bracket")
    base = sm.base_rect(p["base_w"], p["base_d"])
    for edge, name in (("y-", "leg_front"), ("y+", "leg_back")):
        leg = base.flange(edge, length=p["leg_h"], label=name)
        # leg local coords: x from the bend tangent, y along the base edge
        web = p["leg_h"] - p["bend_r"] - p["thick"]
        leg.hole(web / 2.0, p["base_w"] / 2.0, d=p["hole_d"])
    base.hole(p["base_w"] * 0.25, p["base_d"] / 2.0, d=p["hole_d"])
    base.hole(p["base_w"] * 0.75, p["base_d"] / 2.0, d=p["hole_d"])
    return sm


def gen_step():
    # canonical = folded 3D (for export/manufacturing)
    return _build().folded()


def gen_flat():
    # flat-pattern solid; cad-chat pre-builds this into a second GLB so the 3D
    # view can toggle folded/flat instantly (no recompute)
    return _build().flat()


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
