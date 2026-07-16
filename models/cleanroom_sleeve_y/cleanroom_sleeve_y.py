"""Cleanroom cable sleeve sized FROM a cable list (selection demo), long
travel like OEM ``ref/原廠CAD/Cable Y.stp``.

- ``select_sleeve`` turns three 8 mm cables into the catalog pick
  (EHSL 00316: 3 pockets x 16, one pocket per cable, conservative default)
  and the catalog bend-radius rule (10x max OD -> R80);
- straights 600 (Cable Y class travel), single KCL clamp pair on the start
  end only (the far end hangs free);
- SWEEP_PATHS mirrors the swept path for the viewer overlay.
"""

from build123d import *  # noqa: F401,F403  (repo generator convention)
from cadpy.assembly import AssemblyHelper
from cadpy.parts import (
    cleanroom_sleeve,
    clamp_location,
    kcl_clamp,
    path_polyline,
    select_kcl_clamp,
    select_sleeve,
    sleeve_dims,
    sleeve_profile_loops,
)

# 要收納的電纜外徑清單(選型輸入;非滑桿——改清單請直接編輯)
CABLE_ODS = [8.0, 8.0, 8.0]

SLEEVE = select_sleeve(CABLE_ODS)

# ===========================================================================
# Adjustable design parameters (single-level; sliders re-run this file)
# ===========================================================================
PARAMS = {
    "wall_t": 1.0,       # 護套壁厚
    "straight_a": 600.0, # 下直段長(Cable Y 級行程)
    "straight_b": 600.0, # 上直段長
    "bend_r": 80.0,      # U 彎半徑(預設 = 型錄 10 x 口袋寬/2)
}

INTENDED_CONTACT = []  # clamp/sleeve contact is tangent, zero volume


def _check_params():
    p = PARAMS
    lo = 7.5 * SLEEVE["pocket_w"] / 2.0
    if p["bend_r"] < lo:
        raise ValueError(
            f"bend_r({p['bend_r']:g})低於型錄下限 {lo:g}(7.5 x 口袋寬/2)")
    if min(p["straight_a"], p["straight_b"]) < 50.0:
        raise ValueError("straight_a/straight_b 至少 50(要容納 32.4 深的固定頭)")
    return sleeve_dims(SLEEVE["pockets"], SLEEVE["pocket_w"], wall_t=p["wall_t"])


def _path_spec():
    p = PARAMS
    return {
        "kind": "drag_chain",
        "straight_a": p["straight_a"],
        "bend_r": p["bend_r"],
        "straight_b": p["straight_b"],
    }


SWEEP_PATHS = [{"label": "sleeve_path", "points": path_polyline(_path_spec(), 96)}]

# sweep-window data: profile values come from the SELECTION (not PARAMS) --
# read-only chips must carry values, not PARAMS key names
SWEEP_VIEW = {
    "pathKind": "drag_chain",
    "pathParams": ["straight_a", "bend_r", "straight_b"],
    "profileParams": [
        {"key": "pockets", "value": SLEEVE["pockets"]},
        {"key": "pocket_w", "value": SLEEVE["pocket_w"], "unit": "mm"},
        {"key": "wall_t", "value": PARAMS["wall_t"], "unit": "mm"},
    ],
    "profileLoops": sleeve_profile_loops(
        SLEEVE["pockets"], SLEEVE["pocket_w"], wall_t=PARAMS["wall_t"],
    ),
}


def gen_step():
    p = PARAMS
    dims = _check_params()
    path = _path_spec()

    asm = AssemblyHelper("cleanroom_sleeve_y")
    asm.add(
        cleanroom_sleeve(
            SLEEVE["pockets"], SLEEVE["pocket_w"], wall_t=p["wall_t"], path=path,
        ),
        "sleeve",
    )
    kcl = select_kcl_clamp(SLEEVE["pockets"], dims["total_w"])
    pair = kcl_clamp(kcl["size"], sleeve_h=dims["outer_h"], label_prefix="kcl_a")
    loc = clamp_location(path, "start")
    for child in pair.children:
        asm.add(loc * child, child.label)
    return asm.build()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="cleanroom_sleeve_y")
    assert_no_interference(shape, allow=INTENDED_CONTACT)


if __name__ == "__main__":
    s = gen_step()
    print("children:", len(s.children), "model:", SLEEVE["model"])
    check_geometry(s)
    print("static checks passed")
