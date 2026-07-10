"""Standard-part resolver layer: selection reasoning + simplified generators.

Two-layer division of labor (the third, step.parts' real STEP, is an agent
decision point, not automated here):

- ``select_<family>(...)`` -- pick the smallest standard row that meets a
  requirement, with a reported (never blocking) margin; raise
  :class:`NoFittingPart` when nothing fits.
- ``<family>(...)`` -- generate a simplified substitute part (envelope + mounting
  interface + travel), gated by each module's ``check_geometry``.

Each generator lives in a module whose name matches the generator function
(``pneumatic_cylinder`` etc.). The function is re-exported here so consumers can
``from cadpy.parts import pneumatic_cylinder`` and get the FUNCTION; the function
re-export wins over the same-named submodule as the package attribute. A module's
own ``check_geometry`` is reached through the submodule
(``from cadpy.parts.pneumatic_cylinder import check_geometry``). Selection
(``select`` / ``specs_io``) is pure/OCP-free; generators defer build123d to call
time, so importing this package stays cheap for pure-selection callers.
"""

from __future__ import annotations

from cadpy.parts.ball_screw import ball_screw
from cadpy.parts.deep_groove_bearing import deep_groove_bearing
from cadpy.parts.gear import gear, gear_rack, pitch_radius, rack_mesh_phase_deg
from cadpy.parts.gripper import gripper
from cadpy.parts.linear_guide import linear_guide
from cadpy.parts.pneumatic_cylinder import pneumatic_cylinder
from cadpy.parts.select import (
    NoFittingPart,
    select_ball_screw,
    select_bearing,
    select_cylinder,
    select_gear,
    select_gripper,
    select_linear_guide,
    select_stepper,
)
from cadpy.parts.specs_io import load_specs
from cadpy.parts.stepper_motor import stepper_motor

__all__ = [
    "NoFittingPart",
    "load_specs",
    "select_cylinder",
    "select_bearing",
    "select_stepper",
    "select_linear_guide",
    "select_ball_screw",
    "select_gear",
    "select_gripper",
    "pneumatic_cylinder",
    "deep_groove_bearing",
    "stepper_motor",
    "linear_guide",
    "ball_screw",
    "gear",
    "gear_rack",
    "pitch_radius",
    "rack_mesh_phase_deg",
    "gripper",
]
