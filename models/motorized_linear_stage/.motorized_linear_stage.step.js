// CAD Viewer parameter sidecar for the motorized linear stage.
//
// One normalized degree of freedom drives the stage:
//   carriage in [0, 1]  ->  the carriage (deck + both guide blocks + screw nut)
//   translates along the screw axis (+X) by carriage * STROKE.
//
// The screw, rails, bearings, motor and frame are stationary; only the carriage
// group moves. This mirrors models/.../motorized_linear_stage.py kin()/pose()
// (the same STROKE and the same moving-part set), so the animation and the
// generated geometry stay kinematically identical.

const STROKE = 150.0; // mm, must match motorized_linear_stage.py STROKE

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const motorizedLinearStage = {
  manifest: {
    schemaVersion: 1,
    units: { length: "mm", angle: "deg", time: "s" },
    features: {
      base: { ref: "#o1.1", label: "Base plate" },
      pillar_neg: { ref: "#o1.2", label: "Bearing pillar (-X)" },
      pillar_pos: { ref: "#o1.3", label: "Bearing pillar (+X)" },
      motor_mount: { ref: "#o1.4", label: "Motor mount plate" },
      rail_neg: { ref: "#o1.5", label: "Linear rail (-Y)" },
      rail_pos: { ref: "#o1.6", label: "Linear rail (+Y)" },
      screw_shaft: { ref: "#o1.7", label: "Ball screw shaft" },
      bearing_neg: { ref: "#o1.8", label: "Support bearing (-X)" },
      bearing_pos: { ref: "#o1.9", label: "Support bearing (+X)" },
      motor: { ref: "#o1.10", label: "Stepper motor" },
      coupling: { ref: "#o1.11", label: "Shaft coupling" },
      carriage_deck: { ref: "#o1.12", label: "Carriage deck", description: "Travels along the screw." },
      guide_block_neg: { ref: "#o1.13", label: "Carriage block (-Y)" },
      guide_block_pos: { ref: "#o1.14", label: "Carriage block (+Y)" },
      screw_nut: { ref: "#o1.15", label: "Screw nut", description: "Fixed to the carriage; drives it along the screw." }
    },
    parameters: {
      carriage: {
        type: "number",
        label: "Carriage",
        description: "Normalized travel: 0 = -X end, 1 = +X end.",
        default: 0,
        min: 0,
        max: 1,
        step: 0.01
      }
    },
    animations: {
      traverse: {
        label: "Traverse 0-1-0",
        duration: 4,
        loop: true,
        // Ping-pong so the play loop returns exactly to the start pose.
        update({ cycle, set }) {
          const t = cycle % 1;
          set("carriage", t < 0.5 ? t * 2 : 2 - t * 2);
        }
      }
    }
  },

  update({ params, effects }) {
    const carriage = Math.max(0, Math.min(1, finite(params.carriage)));
    const travel = carriage * STROKE;
    const move = { transforms: [{ translate: [travel, 0, 0] }] };
    for (const name of ["carriage_deck", "guide_block_neg", "guide_block_pos", "screw_nut"]) {
      effects.transform(name, move);
    }
  }
};

export default motorizedLinearStage;
