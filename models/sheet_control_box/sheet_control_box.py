"""Sheet-metal control box shell -- the multi-flange dogfood fixture.

A base with four 90-degree walls declared by OUTER box size
(``placement="inside"`` insets each edge by R+t, so the folded outer footprint
equals box_w x box_d exactly), automatic square corner relief at all four
corners, a safety hem on both X walls (folds inward), one cable hole in the
+X wall and a rectangular vent cutout in the base. Single fused solid.

Exercises every MVP feature except jog: inside placement, corner relief, hem,
hole + cutout, folded/flat twins and the layered DXF flat pattern
(CUT / BEND_UP_90 / BEND_UP_180).
"""

from build123d import *  # noqa: F401,F403  (repo generator convention)
from cadpy.parts import SheetMetal

# ===========================================================================
# Adjustable design parameters (single-level; sliders re-run this file)
# ===========================================================================
PARAMS = {
    "box_w": 120.0,     # OUTER footprint X (inside placement -> exact)
    "box_d": 80.0,      # OUTER footprint Y
    "box_h": 40.0,      # OUTER wall height (length= semantics)
    "thick": 1.5,       # sheet thickness
    "bend_r": 2.0,      # inner bend radius
    "k_factor": 0.44,   # neutral-fiber factor
    "hem_len": 6.0,     # safety hem return on the two X walls
    "cable_d": 16.0,    # cable hole in the +X wall
    "vent_w": 40.0,     # vent cutout in the base (X)
    "vent_d": 20.0,     # vent cutout in the base (Y)
}


def _check_params():
    p = PARAMS
    inset = p["bend_r"] + p["thick"]
    if p["box_w"] <= 4 * inset or p["box_d"] <= 4 * inset:
        raise ValueError(
            f"box_w/box_d({p['box_w']:g}×{p['box_d']:g})太小:四面 inside 折彎"
            f"各吃掉 R+t={inset:g},底面會退化。請加大外形或減小 bend_r")
    if p["box_h"] <= inset + 4.0 * p["thick"] + p["hem_len"]:
        raise ValueError(
            f"box_h({p['box_h']:g})不足:牆高扣折彎 {inset:g} 後要容納摺邊 "
            f"{p['hem_len']:g} 與最小凸緣,請加高 box_h 或縮短 hem_len")
    if p["vent_w"] >= p["box_w"] - 2 * inset - 2 * (2 * p["thick"] + p["bend_r"]) or \
       p["vent_d"] >= p["box_d"] - 2 * inset - 2 * (2 * p["thick"] + p["bend_r"]):
        raise ValueError(
            f"vent({p['vent_w']:g}×{p['vent_d']:g})太大,壓到底面折彎保留區:"
            f"請縮小 vent 或加大 box")
    # 其餘(孔距折彎/邊距、hem gap、半徑下限)由 SheetMetal 內建驗證把關


def _build() -> SheetMetal:
    p = PARAMS
    _check_params()
    sm = SheetMetal(thickness=p["thick"], bend_radius=p["bend_r"],
                    k_factor=p["k_factor"], label="control_box")
    base = sm.base_rect(p["box_w"], p["box_d"])
    walls = {}
    for edge in ("x+", "x-", "y+", "y-"):
        walls[edge] = base.flange(edge, length=p["box_h"], placement="inside",
                                  label=f"wall_{'xp' if edge == 'x+' else 'xn' if edge == 'x-' else 'yp' if edge == 'y+' else 'yn'}")
    web = p["box_h"] - (p["bend_r"] + p["thick"])
    for edge in ("x+", "x-"):
        walls[edge].hem("tip", length=p["hem_len"],
                        label=f"hem_{'xp' if edge == 'x+' else 'xn'}")
    # cable hole in the +X wall (wall local: x from bend tangent, y along edge)
    wall_span = p["box_d"] - 2.0 * (p["bend_r"] + p["thick"])
    walls["x+"].hole(web / 2.0, wall_span / 2.0, d=p["cable_d"])
    # vent cutout in the base (base local = declared box coordinates)
    cx, cy = p["box_w"] / 2.0, p["box_d"] / 2.0
    hw, hd = p["vent_w"] / 2.0, p["vent_d"] / 2.0
    base.cutout([(cx - hw, cy - hd), (cx + hw, cy - hd),
                 (cx + hw, cy + hd), (cx - hw, cy + hd)])
    return sm


def gen_step():
    return _build().folded()  # canonical folded 3D


def gen_flat():
    return _build().flat()  # flat-pattern solid → cad-chat 攤平預覽 GLB(即時切換)


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
