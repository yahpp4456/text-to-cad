"""Cleanroom cable sleeve, drag-chain U, both ends clamped (KCL) -- the
dogfood fixture aligned to OEM ``ref/原廠CAD/Cable X.stp``:

- 6 pockets x 16 mm EHSL band (total width 105 = 6*(16+1)+3, catalog exact),
  hollow wall 1.0, swept along straight 300 / 180-degree R80 / straight 300
  (all matching the measured OEM part);
- KCL clamp pairs on both ends, size auto-selected (105 > 6A's C=104.2 ->
  7A, exactly the OEM pairing); plates press the sleeve crown tangentially
  (zero-volume contact), so INTENDED_CONTACT stays empty;
- module-level SWEEP_PATHS carries the swept centerline polyline for the
  viewer's path-preview overlay; it samples the SAME path spec the sweep
  uses (single source of truth -- slider regens keep them in lockstep).
"""

from build123d import *  # noqa: F401,F403  (repo generator convention)
from cadpy.assembly import AssemblyHelper
from cadpy.parts import (
    cleanroom_sleeve,
    clamp_location,
    kcl_clamp,
    path_polyline,
    select_kcl_clamp,
    sleeve_dims,
    sleeve_profile_loops,
)

# ===========================================================================
# Adjustable design parameters (single-level; sliders re-run this file)
# ===========================================================================
PARAMS = {
    "pockets": 6,        # 口袋數(EHSL 型錄 1..7)
    "pocket_w": 16.0,    # 口袋寬 mm(型錄 16/20/25/30/35/40/45/50/55/60/66)
    "wall_t": 1.0,       # 護套壁厚
    "straight_a": 300.0, # 下直段長
    "straight_b": 300.0, # 上直段長
    "bend_r": 80.0,      # U 彎半徑(型錄規則 7.5~10 x 口袋寬/2)
}

# clamp plates touch the sleeve crown faces tangentially: zero-volume
# contact, deliberately NOT declared (declare only real overlaps).
INTENDED_CONTACT = []


def _check_params():
    p = PARAMS
    if not 1 <= int(p["pockets"]) <= 7:
        raise ValueError(f"pockets({p['pockets']:g})須在 1~7(EHSL 型錄範圍)")
    d = sleeve_dims(int(p["pockets"]), p["pocket_w"], wall_t=p["wall_t"])
    lo = 7.5 * p["pocket_w"] / 2.0
    if p["bend_r"] < lo:
        raise ValueError(
            f"bend_r({p['bend_r']:g})低於型錄下限 {lo:g}(7.5 x 口袋寬/2);"
            "彎太緊電纜會超出耐撓曲半徑")
    if min(p["straight_a"], p["straight_b"]) < 50.0:
        raise ValueError("straight_a/straight_b 至少 50(要容納 32.4 深的固定頭)")
    return d


def _path_spec():
    p = PARAMS
    return {
        "kind": "drag_chain",
        "straight_a": p["straight_a"],
        "bend_r": p["bend_r"],
        "straight_b": p["straight_b"],
    }


# viewer path-preview overlay: sampled from the SAME spec gen_step sweeps
SWEEP_PATHS = [{"label": "sleeve_path", "points": path_polyline(_path_spec(), 96)}]

# sweep-window data: editable path params (left pane, live 2D preview) +
# read-only profile chips/loops (right pane; profile changes go through chat)
SWEEP_VIEW = {
    "pathKind": "drag_chain",
    "pathParams": ["straight_a", "bend_r", "straight_b"],
    "profileParams": [
        {"key": "pockets", "value": PARAMS["pockets"]},
        {"key": "pocket_w", "value": PARAMS["pocket_w"], "unit": "mm"},
        {"key": "wall_t", "value": PARAMS["wall_t"], "unit": "mm"},
    ],
    "profileLoops": sleeve_profile_loops(
        int(PARAMS["pockets"]), PARAMS["pocket_w"], wall_t=PARAMS["wall_t"],
    ),
}


def gen_step():
    p = PARAMS
    dims = _check_params()
    path = _path_spec()

    asm = AssemblyHelper("cleanroom_sleeve_x")
    asm.add(
        cleanroom_sleeve(
            int(p["pockets"]), p["pocket_w"], wall_t=p["wall_t"], path=path,
        ),
        "sleeve",
    )

    kcl = select_kcl_clamp(int(p["pockets"]), dims["total_w"])
    for tag, end in (("kcl_a", "start"), ("kcl_b", "end")):
        pair = kcl_clamp(kcl["size"], sleeve_h=dims["outer_h"], label_prefix=tag)
        loc = clamp_location(path, end)
        for child in pair.children:
            asm.add(loc * child, child.label)
    return asm.build()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="cleanroom_sleeve_x")
    assert_no_interference(shape, allow=INTENDED_CONTACT)


if __name__ == "__main__":
    s = gen_step()
    d = sleeve_dims(int(PARAMS["pockets"]), PARAMS["pocket_w"], wall_t=PARAMS["wall_t"])
    print("children:", len(s.children), "total_w:", d["total_w"])
    check_geometry(s)
    print("sweep path points:", len(SWEEP_PATHS[0]["points"]))
    print("static checks passed")
