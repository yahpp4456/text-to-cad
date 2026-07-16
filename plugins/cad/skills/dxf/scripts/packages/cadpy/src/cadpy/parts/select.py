"""Selection reasoning over the spec tables -- the layer step.parts lacks.

Each ``select_<family>`` turns a requirement (load, stroke, shaft, torque, ...)
into the smallest standard row that satisfies it, returns the whole row plus a
``selected_for`` block carrying the computed ``margin`` (REPORTED, never used to
block -- this is a geometric/force first cut, not an FEA/fatigue/tolerance
verdict). When nothing fits, it raises :class:`NoFittingPart` with a readable
message rather than guessing a dimension.

Force/torque models live here as the single source of truth so selection and the
reported margin can never use two different formulas.
"""

from __future__ import annotations

import math
from typing import Any

from cadpy.parts.specs_io import load_specs


class NoFittingPart(Exception):
    """No catalog row satisfies the selection constraints."""


# ---------------------------------------------------------------------------
# Pneumatic cylinder
# ---------------------------------------------------------------------------
def _circle_area(dia: float) -> float:
    return math.pi / 4.0 * dia * dia


_ACTION_ALIASES = {
    "push": "push", "extend": "push", "out": "push",
    "pull": "pull", "retract": "pull", "in": "pull",
    "double": "double", "double_acting": "double",
    "doubleacting": "double", "both": "double",
}


def _normalize_action(action: str) -> str:
    """Fold common phrasings (case, hyphen/space, ``double-acting``, ``extend`` ...)
    onto the canonical ``push`` / ``pull`` / ``double`` the force model speaks.

    An unknown value passes through unchanged so :func:`_force` still raises on it.
    """
    a = str(action).strip().lower().replace("-", "_").replace(" ", "_")
    return _ACTION_ALIASES.get(a, a)


def _force(row: dict[str, Any], pressure_bar: float, action: str) -> float:
    """Output force (N) of a cylinder row at a gauge pressure.

    ``push`` uses the full bore area; ``pull`` uses the annular area (bore minus
    rod). ``double`` (double-acting) must satisfy the load on BOTH strokes, so it
    is sized by the weaker pull stroke (the rod steals area) -- the binding case.
    This is the ONLY force model: selection and margin both call it, so a
    push/pull mismatch between "what was selected" and "what margin was reported"
    is impossible. 1 bar = 0.1 N/mm^2.
    """
    p = pressure_bar * 0.1  # N/mm^2
    if action == "push":
        area = _circle_area(row["bore"])
    elif action in ("pull", "double"):
        area = _circle_area(row["bore"]) - _circle_area(row["rod_dia"])
    else:
        raise ValueError(f"action must be 'push', 'pull' or 'double', got {action!r}")
    return p * area


def select_cylinder(
    load_N: float,
    *,
    pressure_bar: float = 6.0,
    stroke_mm: float,
    load_ratio: float = 0.7,
    action: str = "push",
    body_shape: str | None = "round",
) -> dict[str, Any]:
    """Smallest-bore cylinder whose output force covers ``load_N`` at the given
    stroke and supply pressure.

    The requirement is ``F_req = load_N / load_ratio`` (a derating headroom). Rows
    are filtered by ACTUAL output force (so a pull selection correctly demands a
    larger bore than push, because the rod steals area) and by stroke being inside
    the series' offered range. ``raise NoFittingPart`` when none qualifies.

    ``action`` is ``push`` / ``pull`` / ``double``; ``double`` (double-acting) is
    sized by its weaker pull stroke so the pick covers the load both ways. Common
    phrasings (``double-acting``, ``Double``, ``extend`` / ``retract``) normalize.

    ``body_shape`` filters the catalog: ``"round"`` (default) picks a standard
    round-body cylinder, ``"square"`` a compact square-body cylinder, and ``None``
    lets any shape win on bore. A row's shape is its ``body_shape`` field
    (rows without one are round). The force model is shape-independent, so this
    only narrows the pool -- it never changes how a given bore is sized.
    """
    if load_N <= 0:
        raise ValueError("load_N must be positive")
    if not 0.0 < load_ratio <= 1.0:
        raise ValueError("load_ratio must be in (0, 1]")
    if pressure_bar <= 0:
        raise ValueError("pressure_bar must be positive")
    if stroke_mm <= 0:
        raise ValueError("stroke_mm must be positive")
    if body_shape is not None and body_shape not in ("round", "square"):
        raise ValueError("body_shape must be 'round', 'square' or None")
    action = _normalize_action(action)  # 'double-acting', 'Double', 'retract' ... → canonical
    f_req = load_N / load_ratio
    rows = [
        r
        for r in load_specs("cylinders")
        if _force(r, pressure_bar, action) >= f_req
        and r["stroke_min"] <= stroke_mm <= r["stroke_max"]
        and (body_shape is None or r.get("body_shape", "round") == body_shape)
    ]
    if not rows:
        raise NoFittingPart(
            f"no cylinder: need >= {f_req:.0f} N ({action}) at {pressure_bar} bar "
            f"with stroke {stroke_mm} mm inside an offered range"
            + (f", body_shape {body_shape!r}" if body_shape is not None else "")
        )
    pick = min(rows, key=lambda r: r["bore"])
    pick_force = _force(pick, pressure_bar, action)
    return {
        **pick,
        "selected_for": {
            "load_N": load_N,
            "pressure_bar": pressure_bar,
            "stroke_mm": stroke_mm,
            "action": action,
            "load_ratio": load_ratio,
            "force_N": pick_force,        # actual output force; f_req = load_N / load_ratio
            "margin": pick_force / load_N,  # vs the raw load (not the derated f_req)
        },
    }


# ---------------------------------------------------------------------------
# Deep-groove ball bearing
# ---------------------------------------------------------------------------
def select_bearing(
    shaft_dia: float,
    *,
    radial_load_N: float | None = None,
) -> dict[str, Any]:
    """Smallest-bore deep-groove bearing whose bore fits ``shaft_dia`` and (if a
    ``radial_load_N`` is given) whose dynamic load rating C covers it.

    Pick is min by (bore, OD): the snuggest bore, then the most compact ring. The
    reported margin is C / radial_load (or the bore-to-shaft fit when no load is
    given). ``raise NoFittingPart`` when the shaft exceeds every bore or the load
    exceeds every rating.
    """
    if shaft_dia <= 0:
        raise ValueError("shaft_dia must be positive")
    if radial_load_N is not None and radial_load_N <= 0:
        raise ValueError("radial_load_N must be positive when given")
    rows = [
        r
        for r in load_specs("bearings")
        if r["bore"] >= shaft_dia
        and (radial_load_N is None or r["C_dynamic_N"] >= radial_load_N)
    ]
    if not rows:
        raise NoFittingPart(
            f"no bearing: shaft {shaft_dia} mm needs bore >= it"
            + (f" with C >= {radial_load_N} N" if radial_load_N is not None else "")
        )
    pick = min(rows, key=lambda r: (r["bore"], r["od"]))
    selected = {"shaft_dia": shaft_dia, "radial_load_N": radial_load_N}
    # Use the same None test as the filter so a load always yields a margin.
    if radial_load_N is not None:
        selected["margin"] = pick["C_dynamic_N"] / radial_load_N
    else:
        selected["fit_clearance"] = pick["bore"] - shaft_dia
    return {**pick, "selected_for": selected}


# ---------------------------------------------------------------------------
# Stepper motor (NEMA frame)
# ---------------------------------------------------------------------------
def select_stepper(torque_Nm: float) -> dict[str, Any]:
    """Smallest NEMA frame/length whose holding torque covers ``torque_Nm``.

    Pick is min by (face, body_len): the smallest frame, then the shortest stack.
    Margin = holding torque / required. ``raise NoFittingPart`` when the demand
    exceeds every motor in the table. Holding torque is motor-specific (see each
    row's ``confidence``); this is a first-cut sizing, not a duty-cycle/thermal
    verdict.
    """
    if torque_Nm <= 0:
        raise ValueError("torque_Nm must be positive")
    rows = [
        r for r in load_specs("motors") if r["holding_torque_Nm"] >= torque_Nm
    ]
    if not rows:
        raise NoFittingPart(
            f"no stepper: need holding torque >= {torque_Nm:.3f} Nm"
        )
    pick = min(rows, key=lambda r: (r["face"], r["body_len"]))
    return {
        **pick,
        "selected_for": {
            "torque_Nm": torque_Nm,
            "margin": pick["holding_torque_Nm"] / torque_Nm,
        },
    }


# ---------------------------------------------------------------------------
# Linear motion guide (profiled rail + carriage)
# ---------------------------------------------------------------------------
def select_linear_guide(load_N: float, *, rail_len: float) -> dict[str, Any]:
    """Smallest rail size whose dynamic load rating C covers ``load_N``.

    ``rail_len`` is not a selection criterion (any length is cut to order); it is
    carried through for the generator. Pick is min by rail_width. Margin = C /
    load. ``raise NoFittingPart`` when the load exceeds every size's rating.
    """
    if load_N <= 0:
        raise ValueError("load_N must be positive")
    if rail_len <= 0:
        raise ValueError("rail_len must be positive")
    rows = [r for r in load_specs("linear_guides") if r["C_dynamic_N"] >= load_N]
    if not rows:
        raise NoFittingPart(f"no linear guide: load {load_N} N exceeds every rating")
    pick = min(rows, key=lambda r: r["rail_width"])
    return {
        **pick,
        "selected_for": {
            "load_N": load_N,
            "rail_len": rail_len,
            "margin": pick["C_dynamic_N"] / load_N,
        },
    }


# ---------------------------------------------------------------------------
# Ball screw
# ---------------------------------------------------------------------------
def select_ball_screw(
    load_N: float,
    *,
    travel: float,
    target_speed_mm_s: float,
    accuracy: str = "C7",
    rated_rpm: float = 3000.0,
) -> dict[str, Any]:
    """Smallest screw whose lead reaches ``target_speed_mm_s`` at the motor's
    rated rpm, whose dynamic rating C covers ``load_N``, and whose grade matches.

    The required lead follows from the speed identity ``speed = lead * rpm``:
    ``lead_req = target_speed_mm_s * 60 / rated_rpm`` (mm/rev). Pick is min by
    (screw_dia, lead): smallest screw, then the finest lead that still reaches the
    speed (better resolution/thrust). ``raise NoFittingPart`` when no row meets
    the lead, the load, or the requested accuracy grade.
    """
    if load_N <= 0:
        raise ValueError("load_N must be positive")
    if travel <= 0 or target_speed_mm_s <= 0 or rated_rpm <= 0:
        raise ValueError("travel, target_speed_mm_s and rated_rpm must be positive")
    lead_req = target_speed_mm_s * 60.0 / rated_rpm
    rows = [
        r
        for r in load_specs("ball_screws")
        if r["lead"] >= lead_req
        and r["C_dynamic_N"] >= load_N
        and r["grade"] == accuracy
    ]
    if not rows:
        raise NoFittingPart(
            f"no ball screw: need lead >= {lead_req:.2f} mm/rev, C >= {load_N} N, "
            f"grade {accuracy}"
        )
    pick = min(rows, key=lambda r: (r["screw_dia"], r["lead"]))
    return {
        **pick,
        "selected_for": {
            "load_N": load_N,
            "travel": travel,
            "target_speed_mm_s": target_speed_mm_s,
            "rated_rpm": rated_rpm,
            "lead_req_mm": lead_req,
            "accuracy": accuracy,
            "margin": pick["C_dynamic_N"] / load_N,
            "speed_margin": pick["lead"] / lead_req,
        },
    }


# ---------------------------------------------------------------------------
# Spur gear
# ---------------------------------------------------------------------------
def select_gear(
    torque_Nm: float,
    *,
    shaft_dia: float | None = None,
    teeth_min: int | None = None,
) -> dict[str, Any]:
    """Smallest stock spur gear whose allowable torque covers ``torque_Nm``.

    The allowable torque of a NON-hardened S45C stock gear is the SMALLER of
    its bending-strength and surface-durability ratings (for these gears the
    surface durability governs by an order of magnitude), so selection uses
    ``min(bending, surface)`` -- the same "weaker case binds" rule as the
    double-acting cylinder. ``shaft_dia`` (if given) requires bore >= shaft;
    ``teeth_min`` filters for ratio/geometry needs. Pick is min by
    (pitch_dia, module): the most compact wheel, then the finest teeth.
    ``raise NoFittingPart`` when the torque, shaft or teeth demand exceeds
    every row. A first-cut catalog sizing, not a duty/lubrication verdict.
    """
    if torque_Nm <= 0:
        raise ValueError("torque_Nm must be positive")
    if shaft_dia is not None and shaft_dia <= 0:
        raise ValueError("shaft_dia must be positive when given")
    if teeth_min is not None and teeth_min < 6:
        raise ValueError("teeth_min must be >= 6 when given")

    def allowable(row: dict[str, Any]) -> float:
        return min(row["allow_torque_bending_Nm"], row["allow_torque_surface_Nm"])

    rows = [
        r
        for r in load_specs("gears")
        if allowable(r) >= torque_Nm
        and (shaft_dia is None or r["bore"] >= shaft_dia)
        and (teeth_min is None or r["teeth"] >= teeth_min)
    ]
    if not rows:
        raise NoFittingPart(
            f"no gear: need allowable torque >= {torque_Nm:.2f} Nm"
            + (f" with bore >= {shaft_dia} mm" if shaft_dia is not None else "")
            + (f" and teeth >= {teeth_min}" if teeth_min is not None else "")
        )
    pick = min(rows, key=lambda r: (r["pitch_dia"], r["module"]))
    governing = (
        "surface"
        if pick["allow_torque_surface_Nm"] <= pick["allow_torque_bending_Nm"]
        else "bending"
    )
    selected = {
        "torque_Nm": torque_Nm,
        "allowable_torque_Nm": allowable(pick),
        "governing": governing,
        "margin": allowable(pick) / torque_Nm,
    }
    if shaft_dia is not None:
        selected["shaft_dia"] = shaft_dia
        selected["fit_clearance"] = pick["bore"] - shaft_dia
    if teeth_min is not None:
        selected["teeth_min"] = teeth_min
    return {**pick, "selected_for": selected}


# ---------------------------------------------------------------------------
# Parallel pneumatic gripper
# ---------------------------------------------------------------------------
def select_gripper(
    grip_force_N: float,
    *,
    opening_mm: float,
    gripper_type: str = "parallel",
    pressure_MPa: float | None = None,
) -> dict[str, Any]:
    """Smallest gripper whose gripping force covers ``grip_force_N`` and whose jaw
    stroke opens at least ``opening_mm``.

    Gripping force is the TABULATED holding force at each row's rated pressure
    (``force_pressure_MPa``), not computed from bore -- a gripper's force depends on
    its internal wedge/rack ratio, so the catalog value is the single source of
    truth (as for a bearing's C or a stepper's holding torque). Pneumatic force is
    ~linear in supply pressure, so an explicit ``pressure_MPa`` scales each row's
    force from its rated pressure; omit it to size at the rated pressure. Pick is min
    by (bore, stroke): the smallest body, then the shortest stroke that still opens
    far enough. ``raise NoFittingPart`` when no row meets the force, the opening, or
    the requested type. A first-cut force/opening sizing, not a
    grip-friction/acceleration verdict.
    """
    if grip_force_N <= 0:
        raise ValueError("grip_force_N must be positive")
    if opening_mm <= 0:
        raise ValueError("opening_mm must be positive")
    if pressure_MPa is not None and pressure_MPa <= 0:
        raise ValueError("pressure_MPa must be positive when given")

    def eff_force(row: dict[str, Any]) -> float:
        rated = row["force_pressure_MPa"]
        p = rated if pressure_MPa is None else pressure_MPa
        return row["gripping_force_N"] * (p / rated)

    rows = [
        r
        for r in load_specs("grippers")
        if str(r.get("type", "parallel")) == gripper_type
        and eff_force(r) >= grip_force_N
        and r["stroke"] >= opening_mm
    ]
    if not rows:
        raise NoFittingPart(
            f"no gripper: need force >= {grip_force_N} N"
            + (f" at {pressure_MPa} MPa" if pressure_MPa is not None else "")
            + f" and stroke >= {opening_mm} mm, type {gripper_type!r}"
        )
    pick = min(rows, key=lambda r: (r["bore"], r["stroke"]))
    pick_force = eff_force(pick)
    return {
        **pick,
        "selected_for": {
            "grip_force_N": grip_force_N,
            "opening_mm": opening_mm,
            "gripper_type": gripper_type,
            "pressure_MPa": pick["force_pressure_MPa"] if pressure_MPa is None else pressure_MPa,
            "force_N": pick_force,          # tabulated force scaled to the sizing pressure
            "margin": pick_force / grip_force_N,
            "opening_margin": pick["stroke"] / opening_mm,
        },
    }


# ---------------------------------------------------------------------------
# Cleanroom cable sleeve (Elocab EHSL) + KCL end clamp
# ---------------------------------------------------------------------------
def select_sleeve(
    cable_ods: list[float],
    *,
    pack_two: bool = False,
    bend_factor: float = 10.0,
) -> dict[str, Any]:
    """Smallest EHSL sleeve that fits the given cable outside diameters.

    Catalog rules (pdf p.7): a pocket holds one cable up to ``pocket_w / 2``
    OD (up to two per pocket when ``pack_two`` -- the catalog's suggested
    maximum). The default is conservative: one pocket per cable. The reported
    ``bend_r`` follows the p.6 rule (7.5x..10x the max cable OD's pocket,
    here ``bend_factor * pocket_w / 2``).
    """
    if not isinstance(cable_ods, (list, tuple)) or not cable_ods:
        raise ValueError("cable_ods 必須是非空的外徑清單")
    ods = [float(v) for v in cable_ods]
    if any(v <= 0 for v in ods):
        raise ValueError("cable_ods 每個外徑必須為正")
    if not 7.5 <= bend_factor <= 10.0:
        raise ValueError("bend_factor 必須在 [7.5, 10](型錄彎徑規則)")
    max_od = max(ods)
    pockets_needed = -(-len(ods) // 2) if pack_two else len(ods)
    rows = [
        r
        for r in load_specs("ehsl_sleeves")
        if r["max_cable_od"] >= max_od and r["pockets"] >= pockets_needed
    ]
    if not rows:
        raise NoFittingPart(
            f"no EHSL sleeve: need pocket for OD <= {max_od} mm x "
            f"{pockets_needed} pockets (pack_two={pack_two})"
        )
    pick = min(rows, key=lambda r: (r["pocket_w"], r["pockets"], r["total_w"]))
    return {
        **pick,
        "selected_for": {
            "cable_ods": ods,
            "max_cable_od": max_od,
            "pockets_needed": pockets_needed,
            "pack_two": pack_two,
            "bend_r": bend_factor * pick["pocket_w"] / 2.0,
            "od_margin": pick["max_cable_od"] / max_od,
        },
    }


def select_kcl_clamp(pockets: int | None, sleeve_total_w: float) -> dict[str, Any]:
    """KCL clamp row for a sleeve: start at ``<pockets>A`` and size up while
    the plate width C cannot cover the sleeve (6x16 -> 105 > 6A's 104.2 ->
    7A, exactly the pairing measured in OEM Cable X.stp). ``pockets=None``
    starts from the smallest. Raises :class:`NoFittingPart` past 7A."""
    if sleeve_total_w <= 0:
        raise ValueError("sleeve_total_w 必須為正")
    rows = sorted(load_specs("kcl_clamps"), key=lambda r: r["C"])
    start = 0
    if pockets is not None:
        if not isinstance(pockets, int) or pockets < 1:
            raise ValueError("pockets 必須是 >= 1 的整數")
        want = f"{min(max(pockets, 2), 7)}A"
        start = next(i for i, r in enumerate(rows) if r["size"] == want)
    for row in rows[start:]:
        if row["C"] >= sleeve_total_w:
            return row
    raise NoFittingPart(
        f"護套總寬 {sleeve_total_w:g} 超過最大 KCL-7A(C=118.2);"
        "無更大型號,請自訂夾板或明給 kcl_clamp(size=...)"
    )
