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


def _force(row: dict[str, Any], pressure_bar: float, action: str) -> float:
    """Output force (N) of a cylinder row at a gauge pressure.

    ``push`` uses the full bore area; ``pull`` uses the annular area (bore minus
    rod). This is the ONLY force model: selection and margin both call it, so a
    push/pull mismatch between "what was selected" and "what margin was reported"
    is impossible. 1 bar = 0.1 N/mm^2.
    """
    p = pressure_bar * 0.1  # N/mm^2
    if action == "push":
        area = _circle_area(row["bore"])
    elif action == "pull":
        area = _circle_area(row["bore"]) - _circle_area(row["rod_dia"])
    else:
        raise ValueError(f"action must be 'push' or 'pull', got {action!r}")
    return p * area


def select_cylinder(
    load_N: float,
    *,
    pressure_bar: float = 6.0,
    stroke_mm: float,
    load_ratio: float = 0.7,
    action: str = "push",
) -> dict[str, Any]:
    """Smallest-bore cylinder whose output force covers ``load_N`` at the given
    stroke and supply pressure.

    The requirement is ``F_req = load_N / load_ratio`` (a derating headroom). Rows
    are filtered by ACTUAL output force (so a pull selection correctly demands a
    larger bore than push, because the rod steals area) and by stroke being inside
    the series' offered range. ``raise NoFittingPart`` when none qualifies.
    """
    if load_N <= 0:
        raise ValueError("load_N must be positive")
    if not 0.0 < load_ratio <= 1.0:
        raise ValueError("load_ratio must be in (0, 1]")
    if pressure_bar <= 0:
        raise ValueError("pressure_bar must be positive")
    if stroke_mm <= 0:
        raise ValueError("stroke_mm must be positive")
    f_req = load_N / load_ratio
    rows = [
        r
        for r in load_specs("cylinders")
        if _force(r, pressure_bar, action) >= f_req
        and r["stroke_min"] <= stroke_mm <= r["stroke_max"]
    ]
    if not rows:
        raise NoFittingPart(
            f"no cylinder: need >= {f_req:.0f} N ({action}) at {pressure_bar} bar "
            f"with stroke {stroke_mm} mm inside an offered range"
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
