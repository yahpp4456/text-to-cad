// CAD Viewer sidecar for the DIN-rail clip insertion station.
//
// THREE driven DOFs + one derived, mirroring din_rail_clip_inserter.py's kin()
// / _deflect() / _move() exactly (the same motion the Python check_geometry
// SWEEP verified penetration-free across the whole stroke):
//   place    in [0,1]  Z down  : lower the tilted clip to engagement height,
//                                fixed claw held just OUTSIDE flange A.
//   approach in [0,1]  Y lateral: slide the clip in so the fixed claw HOOKS
//                                under flange A (the DOF a vertical press lacks).
//   seat     in [0,1]  roll phi : rotate about Q; the -Y side comes down to snap.
//   deflect  (derived from seat): the spring arm bends outward as its lip passes
//                                flange B's edge, then springs back -- so the
//                                snap is penetration-free, not driven through.
//
// The tilt is the reference's real 4.5 deg (NOT exaggerated): exaggerating it
// would break the verified zero-penetration motion. The big, legible part of the
// animation is the descend + lateral approach; the final roll is the small snap.
//
// Static STEP pose = seated (place=approach=seat=1, deflect=0); both the geometry
// and these defaults agree, so sidecar-off == the exported model.

const LOWER_STROKE = 22.0;
const APPROACH_DY = 4.0;
const PHI0_DEG = 4.5;
const DEFLECT_MAX = 1.1;
const Q = [0.0, 17.5, 39.5];     // roll pivot: +Y flange outer top edge
const ROLL_AXIS = [1, 0, 0];

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

// outward (-Y) spring-arm deflection while its lip sweeps flange B's band
function deflect(seat) {
  const up0 = 0.12, up1 = 0.28, dn0 = 0.90, dn1 = 0.96;
  if (seat <= up0 || seat >= dn1) return 0.0;
  let w;
  if (seat < up1) w = (seat - up0) / (up1 - up0);
  else if (seat > dn0) w = (dn1 - seat) / (dn1 - dn0);
  else w = 1.0;
  return DEFLECT_MAX * w;
}

// extra Z so the seat foot tracks the rolling tail top, plus a clearance that
// holds it OFF the tilted tail during place/approach and closes as it seats
// (mirrors din_rail_clip_inserter.py _seat_follow).
function seatFollow(seat) {
  const tailZ = 50.0, cylY = -14.5;
  const phi = (-PHI0_DEG * (1 - seat)) * Math.PI / 180;
  const z = Q[2] + (cylY - Q[1]) * Math.sin(phi) + (tailZ - Q[2]) * Math.cos(phi);
  return (z - tailZ) + 0.6 * (1 - seat);
}

const Z_ONLY = new Set(["place_rod", "carriage", "approach_cylinder_body"]);
const YZ = new Set(["approach_rod", "slide_block", "holder", "seat_cylinder_body"]);

const dinRailClipInserter = {
  manifest: {
    schemaVersion: 1,
    step: { path: "models/din_rail_clip_inserter/din_rail_clip_inserter.step" },
    units: { length: "mm", angle: "deg", time: "s" },
    features: {
      base_plate: { ref: "#o1.1", label: "Base plate" },
      rail_nest: { ref: "#o1.2", label: "Rail nest" },
      column_neg: { ref: "#o1.3", label: "Column -X" },
      column_pos: { ref: "#o1.4", label: "Column +X" },
      top_plate: { ref: "#o1.5", label: "Top plate" },
      place_cylinder_body: { ref: "#o1.6", label: "Place cylinder", description: "Fixed; vertical descent." },
      place_rod: { ref: "#o1.7", label: "Place rod", description: "Lowers the carriage group." },
      carriage: { ref: "#o1.8", label: "Carriage", description: "Z stage on the guide rods." },
      guide_rod_neg: { ref: "#o1.9", label: "Guide rod -X", description: "Fixed; anchored in the top plate." },
      guide_rod_pos: { ref: "#o1.10", label: "Guide rod +X", description: "Fixed; anchored in the top plate." },
      slide_block: { ref: "#o1.11", label: "Slide block", description: "Y stage; carries holder + seat cylinder." },
      approach_cylinder_body: { ref: "#o1.12", label: "Approach cylinder", description: "Drives the Y slide to hook flange A." },
      approach_rod: { ref: "#o1.13", label: "Approach rod", description: "Pushes the slide laterally." },
      holder: { ref: "#o1.14", label: "Clip holder", description: "Grips the clip +Y body." },
      seat_cylinder_body: { ref: "#o1.15", label: "Seat cylinder", description: "Presses the spring tail to roll the clip in." },
      seat_rod: { ref: "#o1.16", label: "Seat rod", description: "Foot pressing the -Y tail." },
      din_rail: { ref: "#o1.17", label: "DIN rail", description: "Fixed top-hat TS35 workpiece." },
      clip_body: { ref: "#o1.18", label: "Clip body", description: "Rigid: fixed claw (hooks flange A) + held post + tail." },
      spring_arm: { ref: "#o1.19", label: "Spring arm", description: "Flexible latch; deflects over flange B then snaps under it." }
    },
    parameters: {
      place: { type: "number", label: "Place", description: "0 = lifted clear, 1 = lowered to engagement height.", default: 1, min: 0, max: 1, step: 0.01 },
      approach: { type: "number", label: "Approach", description: "0 = held off the rail, 1 = slid in so the fixed claw hooks flange A.", default: 1, min: 0, max: 1, step: 0.01 },
      seat: { type: "number", label: "Seat", description: "0 = tilted (hooked), 1 = rolled flat; the spring deflects over flange B and snaps in.", default: 1, min: 0, max: 1, step: 0.01 }
    },
    animations: {
      installCycle: {
        label: "Lower - hook - roll - snap",
        duration: 6,
        loop: true,
        // Ping-pong over the same install path the sweep checks: place
        // (f 0->0.34), approach (0.34->0.56), seat (0.56->1.0).
        update({ cycle, set }) {
          const t = cycle % 1;
          const f = t < 0.5 ? t * 2 : 2 - t * 2;
          set("place", Math.max(0, Math.min(1, f / 0.34)));
          set("approach", Math.max(0, Math.min(1, (f - 0.34) / 0.22)));
          set("seat", Math.max(0, Math.min(1, (f - 0.56) / 0.44)));
        }
      }
    }
  },

  update({ params, effects }) {
    const place = clamp01(params.place);
    const approach = clamp01(params.approach);
    const seat = clamp01(params.seat);

    const dz = LOWER_STROKE * (1 - place);
    const dy = APPROACH_DY * (1 - approach);
    const phi = -PHI0_DEG * (1 - seat);
    const defl = deflect(seat);

    const roll = { rotate: { axis: ROLL_AXIS, origin: Q, angleDeg: phi } };
    const carry = { translate: [0, dy, dz] };

    for (const name of Z_ONLY) {
      effects.transform(name, { transforms: [{ translate: [0, 0, dz] }] });
    }
    for (const name of YZ) {
      effects.transform(name, { transforms: [carry] });
    }
    // seat rod: rides the slide AND tracks the rolling tail top (with approach clearance)
    effects.transform("seat_rod", { transforms: [{ translate: [0, dy, dz + seatFollow(seat)] }] });
    // rigid clip body: roll about Q, then ride the carriage
    effects.transform("clip_body", { transforms: [roll, carry] });
    // spring arm: deflect outward (local), then roll + ride with the body
    effects.transform("spring_arm", { transforms: [{ translate: [0, -defl, 0] }, roll, carry] });
  }
};

export default dinRailClipInserter;
