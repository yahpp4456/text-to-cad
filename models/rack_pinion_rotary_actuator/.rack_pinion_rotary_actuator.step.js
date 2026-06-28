// CAD Viewer parameter sidecar for the rack-and-pinion rotary actuator.
//
// One normalized degree of freedom drives the whole mechanism:
//   swing in [0, 1]  ->  rack/rod rise and pinion/platform tilt.
//
// Kinematics are derived from the gear, not eyeballed. The pinion pitch
// radius and the 90 deg swing fix the rack stroke as an arc length:
//   STROKE_90 = PINION_PITCH_R * (pi / 2)
//   travel    = swing * STROKE_90        (rack + rod translate +Z)
//   angleDeg  = -swing * 90              (pinion + platform rotate about +Y)
//
// Sign check: the rack meshes on the pinion's +X side. For the rack to rise,
// the pinion contact point must move +Z, which means a negative rotation
// about +Y -- the same sense that tilts the +X platform arm upward. So the
// rack-up direction and the platform-up tilt are physically consistent.

const PINION_PITCH_R = 12.0;
const STROKE_90 = PINION_PITCH_R * (Math.PI / 2.0); // 18.8496 mm
const SWING_AXIS = [0, 1, 0];
const SWING_ORIGIN = [-22.0, 0.0, 78.0]; // pinion axis (world)

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const rackPinionRotaryActuator = {
  manifest: {
    schemaVersion: 1,
    units: { length: "mm", angle: "deg", time: "s" },
    features: {
      base: { ref: "#o1.1", label: "Base plate" },
      support_bracket: { ref: "#o1.2", label: "Support bracket" },
      cylinder_body: { ref: "#o1.3", label: "Cylinder body" },
      piston_rod: { ref: "#o1.4", label: "Piston rod", description: "Rises with the rack." },
      coupler: { ref: "#o1.5", label: "Rod-rack coupler", description: "Clamps the rod end to the rack; rises with them." },
      rack: { ref: "#o1.6", label: "Rack", description: "Vertical toothed bar driven by the cylinder." },
      pinion: { ref: "#o1.7", label: "Pinion", description: "Converts rack travel into rotation about +Y." },
      platform: { ref: "#o1.8", label: "Platform", description: "Tilts 0-90 deg with the pinion." }
    },
    parameters: {
      swing: {
        type: "number",
        label: "Swing",
        description: "Normalized stroke: 0 = retracted/flat, 1 = extended/90 deg up.",
        default: 0,
        min: 0,
        max: 1,
        step: 0.01
      }
    },
    animations: {
      swingCycle: {
        label: "Swing 0-90-0",
        duration: 4,
        loop: true,
        // Ping-pong so the play loop returns exactly to the start pose.
        update({ cycle, set }) {
          const t = cycle % 1;
          set("swing", t < 0.5 ? t * 2 : 2 - t * 2);
        }
      }
    }
  },

  update({ params, effects }) {
    const swing = Math.max(0, Math.min(1, finite(params.swing)));
    const travel = swing * STROKE_90;
    const angleDeg = -swing * 90;

    // Rod, coupler and rack rise together as one rigid group.
    const lift = { transforms: [{ translate: [0, 0, travel] }] };
    effects.transform("piston_rod", lift);
    effects.transform("coupler", lift);
    effects.transform("rack", lift);

    // Pinion and platform share the same rotation about the pinion axis.
    const rotate = { rotate: { axis: SWING_AXIS, origin: SWING_ORIGIN, angleDeg } };
    effects.transform("pinion", { transforms: [rotate] });
    effects.transform("platform", { transforms: [rotate] });
  }
};

export default rackPinionRotaryActuator;
