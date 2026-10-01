"""Sheet-metal open rectangular box: base with four 90-degree walls and a
centered round hole in the base.

Base size is the OUTER folded footprint (placement="inside" insets each edge
by R+t). Corner relief is automatic. Wall height uses length= (outer leg,
valid for 90 degrees only).
"""

from build123d import *  # noqa: F401,F403
from cadpy.parts import SheetMetal

PARAMS = {"box_w": 120.0, "box_d": 80.0, "box_h": 40.0, "thick": 1.5, "bend_r": 2.0, "k_factor": 0.44, "hole_d": 20.0}


def _check_params():
    p = PARAMS
    if p["thick"] <= 0 or p["bend_r"] < 0.5 * p["thick"]:
        raise ValueError(
            f"bend_r({p['bend_r']:g})需 ≥ 半板厚 {0.5 * p['thick']:g},且 thick 必須為正")
    inset = p["bend_r"] + p["thick"]
    if p["box_w"] <= 4 * inset or p["box_d"] <= 4 * inset:
        raise ValueError(
            f"box_w/box_d({p['box_w']:g}×{p['box_d']:g})太小:四邊 inside 折彎各吃掉 "
            f"R+t={inset:g},底板會退化。請加大外形或減小 bend_r")
    if p["box_h"] <= inset + 2.0 * p["thick"]:
        raise ValueError(
            f"box_h({p['box_h']:g})不足:須大於 R+t+2t={inset + 2 * p['thick']:g},否則立邊無直段")
    keep = 2.0 * inset + 2.0 * (2.0 * p["thick"] + p["bend_r"])
    if p["hole_d"] <= 0 or p["hole_d"] >= min(p["box_w"], p["box_d"]) - keep:
        raise ValueError(
            f"hole_d({p['hole_d']:g})須 > 0 且 < {min(p['box_w'], p['box_d']) - keep:g}:"
            f"孔會壓到底板折彎保留區")


def _build() -> SheetMetal:
    p = PARAMS
    _check_params()
    sm = SheetMetal(thickness=p["thick"], bend_radius=p["bend_r"],
                    k_factor=p["k_factor"], label="box")
    base = sm.base_rect(p["box_w"], p["box_d"])
    names = {"x+": "wall_xp", "x-": "wall_xn", "y+": "wall_yp", "y-": "wall_yn"}
    for edge, name in names.items():
        base.flange(edge, length=p["box_h"], placement="inside", label=name)
    base.hole(p["box_w"] / 2.0, p["box_d"] / 2.0, d=p["hole_d"])
    return sm


def gen_step():
    return _build().folded()


def gen_flat():
    return _build().flat()


def gen_dxf():
    return _build().dxf()


def check_geometry(shape):
    from cadpy.parts.sheet_metal import check_geometry as check_sheet

    check_sheet(shape)
