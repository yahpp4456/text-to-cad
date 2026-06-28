// CAD Viewer parameter + animation sidecar for the XYZ pick-and-place gantry.
//
// Seven normalized degrees of freedom drive the machine, mirroring
// models/xyz_pickplace_gantry/xyz_pickplace_gantry.py kin()/pose():
//   x, y, z  in [0, 1]  -> the three axis travels (* X/Y/Z_STROKE)
//   e0..e3   in [0, 1]  -> the four cylinder extensions (* CYL_STROKE)
//
// Ride-along (serial chain): the riser + the whole Y axis + everything above
// translate with x; the Z bracket + the whole Z axis + the head translate with y
// too; the Z carriage + head descend with z; each nozzle's rod slides down by its
// own extension. Same strokes and same moving-part sets as the Python source, so
// the animation and the generated STEP stay kinematically identical. (Cylinder
// rods are SLID out as rigid bodies here -- a faithful viewer approximation of the
// generator's lengthening-rod model; the body stays put, the rod + nozzle drop.)

const X_STROKE = 200.0; // mm, must match xyz_pickplace_gantry.py X_STROKE
const Y_STROKE = 150.0; // mm, must match Y_STROKE
const Z_STROKE = 80.0;  // mm, must match Z_STROKE
const CYL_STROKE = 25.0; // mm, must match CYL_STROKE

// Parts that ride X only (riser + Y axis fixed frame).
const RIDE_X = [
  "x_carriage_body", "x_guide_block_neg", "x_guide_block_pos", "x_screw_nut", "riser",
  "y_base", "y_pillar_neg", "y_pillar_pos", "y_motor_mount", "y_rail_neg", "y_rail_pos",
  "y_screw_shaft", "y_bearing_neg", "y_bearing_pos", "y_motor", "y_coupling",
];
// Parts that ride X and Y (Z bracket + Z axis fixed frame).
const RIDE_XY = [
  "y_carriage_body", "y_guide_block_neg", "y_guide_block_pos", "y_screw_nut", "z_bracket",
  "z_base", "z_pillar_neg", "z_pillar_pos", "z_motor_mount", "z_rail_neg", "z_rail_pos",
  "z_screw_shaft", "z_bearing_neg", "z_bearing_pos", "z_motor", "z_coupling",
];
// Parts that ride X, Y and descend with Z (Z carriage + head body, cylinders).
const RIDE_XYZ = [
  "z_carriage_body", "z_guide_block_neg", "z_guide_block_pos", "z_screw_nut",
  "head_plate", "head_arm", "cyl0_body", "cyl1_body", "cyl2_body", "cyl3_body",
];

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : 0));
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };

// Deterministic hash -> pseudo-random in [0, 1) per (cylinder i, beat b). Keeps the
// "random" nozzle dance reproducible and the loop exact.
function rnd(i, b) {
  const h = Math.sin((i * 12.9898 + b * 78.233 + 1.0) * 43758.5453);
  return h - Math.floor(h);
}
const DANCE_BEATS = 6;
// Per-beat extension target; clamped to 0 at the first/last beat so the dance
// starts and ends fully retracted (clean hand-off to the traverse phases).
function danceTarget(i, b) {
  if (b <= 0 || b >= DANCE_BEATS) return 0;
  return 0.18 + 0.82 * rnd(i, b);
}

// XYZ traverse waypoints (normalized) leading to the "work" pose held during the
// nozzle dance.
const WORK_POSE = [0.5, 0.6, 0.85];
const WAYPOINTS = [[0, 0, 0], [1.0, 0.25, 0.12], [1.0, 1.0, 0.45], WORK_POSE];
const T_TRAVERSE_END = 0.35; // t in [0, 0.35): move out through the waypoints
const T_DANCE_END = 0.85;    // t in [0.35, 0.85): hold pose, dance the nozzles
//                              t in [0.85, 1.0):  return to start

const gantry = {
  manifest: {
    schemaVersion: 1,
    step: { path: "models/xyz_pickplace_gantry/xyz_pickplace_gantry.step" },
    units: { length: "mm", angle: "deg", time: "s" },
    features: {
      x_base: { ref: "#o1.1", label: "X base plate" },
      x_pillar_neg: { ref: "#o1.2", label: "X bearing pillar (-)" },
      x_pillar_pos: { ref: "#o1.3", label: "X bearing pillar (+)" },
      x_motor_mount: { ref: "#o1.4", label: "X motor mount" },
      x_rail_neg: { ref: "#o1.5", label: "X rail (-Y)" },
      x_rail_pos: { ref: "#o1.6", label: "X rail (+Y)" },
      x_screw_shaft: { ref: "#o1.7", label: "X ball screw" },
      x_screw_nut: { ref: "#o1.8", label: "X screw nut" },
      x_bearing_neg: { ref: "#o1.9", label: "X bearing (-)" },
      x_bearing_pos: { ref: "#o1.10", label: "X bearing (+)" },
      x_motor: { ref: "#o1.11", label: "X stepper motor" },
      x_coupling: { ref: "#o1.12", label: "X coupling" },
      x_carriage_body: { ref: "#o1.13", label: "X carriage", description: "Travels +X; carries the whole gantry." },
      x_guide_block_neg: { ref: "#o1.14", label: "X block (-Y)" },
      x_guide_block_pos: { ref: "#o1.15", label: "X block (+Y)" },
      riser: { ref: "#o1.16", label: "Riser column", description: "Raises the Y axis off the X carriage." },
      y_base: { ref: "#o1.17", label: "Y base/bed" },
      y_pillar_neg: { ref: "#o1.18", label: "Y bearing pillar (-)" },
      y_pillar_pos: { ref: "#o1.19", label: "Y bearing pillar (+)" },
      y_motor_mount: { ref: "#o1.20", label: "Y motor mount" },
      y_rail_neg: { ref: "#o1.21", label: "Y rail" },
      y_rail_pos: { ref: "#o1.22", label: "Y rail" },
      y_screw_shaft: { ref: "#o1.23", label: "Y ball screw" },
      y_screw_nut: { ref: "#o1.24", label: "Y screw nut" },
      y_bearing_neg: { ref: "#o1.25", label: "Y bearing (-)" },
      y_bearing_pos: { ref: "#o1.26", label: "Y bearing (+)" },
      y_motor: { ref: "#o1.27", label: "Y stepper motor" },
      y_coupling: { ref: "#o1.28", label: "Y coupling" },
      y_carriage_body: { ref: "#o1.29", label: "Y carriage", description: "Travels +Y; carries the Z axis." },
      y_guide_block_neg: { ref: "#o1.30", label: "Y block" },
      y_guide_block_pos: { ref: "#o1.31", label: "Y block" },
      z_bracket: { ref: "#o1.32", label: "Z mount bracket" },
      z_base: { ref: "#o1.33", label: "Z back plate" },
      z_pillar_neg: { ref: "#o1.34", label: "Z bearing pillar (top)" },
      z_pillar_pos: { ref: "#o1.35", label: "Z bearing pillar (bottom)" },
      z_motor_mount: { ref: "#o1.36", label: "Z motor mount" },
      z_rail_neg: { ref: "#o1.37", label: "Z rail" },
      z_rail_pos: { ref: "#o1.38", label: "Z rail" },
      z_screw_shaft: { ref: "#o1.39", label: "Z ball screw" },
      z_screw_nut: { ref: "#o1.40", label: "Z screw nut" },
      z_bearing_neg: { ref: "#o1.41", label: "Z bearing (top)" },
      z_bearing_pos: { ref: "#o1.42", label: "Z bearing (bottom)" },
      z_motor: { ref: "#o1.43", label: "Z stepper motor" },
      z_coupling: { ref: "#o1.44", label: "Z coupling" },
      z_carriage_body: { ref: "#o1.45", label: "Z carriage", description: "Descends with z; carries the head." },
      z_guide_block_neg: { ref: "#o1.46", label: "Z block" },
      z_guide_block_pos: { ref: "#o1.47", label: "Z block" },
      head_plate: { ref: "#o1.48", label: "Nozzle bar" },
      head_arm: { ref: "#o1.49", label: "Head arm" },
      cyl0_body: { ref: "#o1.50", label: "Cylinder 0 body" },
      cyl0_rod: { ref: "#o1.51", label: "Cylinder 0 rod" },
      nozzle0: { ref: "#o1.52", label: "Nozzle 0" },
      cyl1_body: { ref: "#o1.53", label: "Cylinder 1 body" },
      cyl1_rod: { ref: "#o1.54", label: "Cylinder 1 rod" },
      nozzle1: { ref: "#o1.55", label: "Nozzle 1" },
      cyl2_body: { ref: "#o1.56", label: "Cylinder 2 body" },
      cyl2_rod: { ref: "#o1.57", label: "Cylinder 2 rod" },
      nozzle2: { ref: "#o1.58", label: "Nozzle 2" },
      cyl3_body: { ref: "#o1.59", label: "Cylinder 3 body" },
      cyl3_rod: { ref: "#o1.60", label: "Cylinder 3 rod" },
      nozzle3: { ref: "#o1.61", label: "Nozzle 3" },
    },
    parameters: {
      x: { type: "number", label: "X travel", description: "0 = -X end, 1 = +X end.", default: 0, min: 0, max: 1, step: 0.01 },
      y: { type: "number", label: "Y travel", description: "0 = retracted, 1 = full +Y.", default: 0, min: 0, max: 1, step: 0.01 },
      z: { type: "number", label: "Z travel", description: "0 = head up, 1 = head fully down.", default: 0, min: 0, max: 1, step: 0.01 },
      e0: { type: "number", label: "Nozzle 0", description: "Cylinder 0 down-stroke.", default: 0, min: 0, max: 1, step: 0.01 },
      e1: { type: "number", label: "Nozzle 1", description: "Cylinder 1 down-stroke.", default: 0, min: 0, max: 1, step: 0.01 },
      e2: { type: "number", label: "Nozzle 2", description: "Cylinder 2 down-stroke.", default: 0, min: 0, max: 1, step: 0.01 },
      e3: { type: "number", label: "Nozzle 3", description: "Cylinder 3 down-stroke.", default: 0, min: 0, max: 1, step: 0.01 },
    },
    animations: {
      pick_place_cycle: {
        label: "Pick & place cycle",
        description: "XYZ traverses to a work pose, the four nozzles fire in a random independent pattern while XYZ holds, then the gantry returns. Loops.",
        duration: 18,
        loop: true,
        update({ cycle, set }) {
          const t = cycle % 1;
          if (t < T_TRAVERSE_END) {
            // Phase 1: traverse the gantry through the waypoints to the work pose.
            const segs = WAYPOINTS.length - 1;
            const f = (t / T_TRAVERSE_END) * segs;
            const i = Math.min(segs - 1, Math.floor(f));
            const u = smooth(f - i);
            set("x", lerp(WAYPOINTS[i][0], WAYPOINTS[i + 1][0], u));
            set("y", lerp(WAYPOINTS[i][1], WAYPOINTS[i + 1][1], u));
            set("z", lerp(WAYPOINTS[i][2], WAYPOINTS[i + 1][2], u));
            for (let k = 0; k < 4; k++) set(`e${k}`, 0);
          } else if (t < T_DANCE_END) {
            // Phase 2: XYZ held at the work pose; nozzles dance independently.
            set("x", WORK_POSE[0]); set("y", WORK_POSE[1]); set("z", WORK_POSE[2]);
            const local = (t - T_TRAVERSE_END) / (T_DANCE_END - T_TRAVERSE_END);
            const beat = Math.floor(local * DANCE_BEATS);
            const frac = local * DANCE_BEATS - beat;
            for (let k = 0; k < 4; k++) {
              set(`e${k}`, lerp(danceTarget(k, beat), danceTarget(k, beat + 1), smooth(frac)));
            }
          } else {
            // Phase 3: return to the start pose.
            const u = smooth((t - T_DANCE_END) / (1 - T_DANCE_END));
            set("x", lerp(WORK_POSE[0], 0, u));
            set("y", lerp(WORK_POSE[1], 0, u));
            set("z", lerp(WORK_POSE[2], 0, u));
            for (let k = 0; k < 4; k++) set(`e${k}`, 0);
          }
        },
      },
      nozzle_dance: {
        label: "Nozzle dance (XYZ held)",
        description: "XYZ parked at the work pose; the four nozzles fire in a random independent pattern. Loops.",
        duration: 8,
        loop: true,
        update({ cycle, set }) {
          const local = cycle % 1;
          set("x", WORK_POSE[0]); set("y", WORK_POSE[1]); set("z", WORK_POSE[2]);
          const beat = Math.floor(local * DANCE_BEATS);
          const frac = local * DANCE_BEATS - beat;
          for (let k = 0; k < 4; k++) {
            set(`e${k}`, lerp(danceTarget(k, beat), danceTarget(k, beat + 1), smooth(frac)));
          }
        },
      },
      xyz_traverse: {
        label: "XYZ traverse",
        description: "Ping-pong each axis through its full travel (nozzles retracted).",
        duration: 6,
        loop: true,
        update({ cycle, set }) {
          const t = cycle % 1;
          const tri = t < 0.5 ? t * 2 : 2 - t * 2; // ping-pong 0->1->0
          set("x", tri); set("y", tri); set("z", tri);
          for (let k = 0; k < 4; k++) set(`e${k}`, 0);
        },
      },
    },
  },

  update({ params, effects }) {
    const xm = clamp01(params.x) * X_STROKE;
    const ym = clamp01(params.y) * Y_STROKE;
    const zm = clamp01(params.z) * Z_STROKE;
    const e = [params.e0, params.e1, params.e2, params.e3].map((v) => clamp01(v) * CYL_STROKE);

    for (const n of RIDE_X) effects.transform(n, { transforms: [{ translate: [xm, 0, 0] }] });
    for (const n of RIDE_XY) effects.transform(n, { transforms: [{ translate: [xm, ym, 0] }] });
    for (const n of RIDE_XYZ) effects.transform(n, { transforms: [{ translate: [xm, ym, -zm] }] });
    for (let i = 0; i < 4; i++) {
      const drop = { transforms: [{ translate: [xm, ym, -zm - e[i]] }] };
      effects.transform(`cyl${i}_rod`, drop);
      effects.transform(`nozzle${i}`, drop);
    }
  },
};

export default gantry;
