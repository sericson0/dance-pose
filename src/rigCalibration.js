// GENERATED — do not edit by hand. Re-generate with `npm run bake:rig`.
//
// Frozen snapshot of the skeleton<->mannequin calibration: the single neutral
// rest each figure resolves at load, used as a *tripwire*. Figure.#build
// recomputes the live calibration from the GLBs every load (that estimate is
// still the source of truth); #assertCalibration compares it to the numbers
// here and console.errors if they have drifted past tolerance — a signal that a
// model or a tuning constant changed and this file must be re-baked. The hard
// pass/fail gate lives in scripts/dev-verify-calibration.mjs.
//
// Keyed by avatar (man/woman have different Biped bind poses). `rest` holds
// canonical joint centers as fractions of stature (scale-free); `endpointR`
// holds the skeletal-hand roll quaternions [x, y, z, w]; `endpointS` holds the
// uniform hand scale; `endpointT` holds the seat translation [x, y, z] as
// fractions of stature (all scale-free).
export const RIG_CALIBRATION = {
  man: {
    rest: {
      ankle_L: [0.04419, 0.038882, -0.015217],
      ankle_R: [-0.04419, 0.038882, -0.015217],
      elbow_L: [0.126789, 0.647756, -0.031541],
      elbow_R: [-0.126789, 0.647756, -0.031541],
      hand_L: [0.175287, 0.412568, 0.048161],
      hand_R: [-0.175287, 0.412568, 0.048161],
      hip_L: [0.055665, 0.503101, -0.005528],
      hip_R: [-0.055665, 0.503101, -0.005528],
      knee_L: [0.045953, 0.24752, -0.018847],
      knee_R: [-0.045953, 0.24752, -0.018847],
      shoulder_L: [0.099941, 0.815116, -0.01744],
      shoulder_R: [-0.099941, 0.815116, -0.01744],
      toe_L: [0.063019, 0.002023, 0.078342],
      toe_R: [-0.063019, 0.002023, 0.078342],
      toes_L: [0.074757, 0.004989, 0.037914],
      toes_R: [-0.074757, 0.004989, 0.037914],
      wrist_L: [0.152071, 0.498696, 0.008197],
      wrist_R: [-0.152071, 0.498696, 0.008197],
    },
    endpointR: {
      ankle_L: [-0.120261, 0.092081, 0.056466, 0.986848],
      ankle_R: [-0.116214, -0.096529, -0.056959, 0.98688],
      wrist_L: [0.069496, -0.635647, 0.300984, 0.707483],
      wrist_R: [0.065536, 0.66001, -0.304483, 0.683653],
    },
    endpointS: {
      ankle_L: 1.134541,
      ankle_R: 1.126141,
      wrist_L: 0.825838,
      wrist_R: 0.821222,
    },
    endpointT: {
      ankle_L: [-0.005963, -0.001169, -0.004632],
      ankle_R: [0.006265, -0.001441, -0.003348],
      wrist_L: [-0.004096, -0.011112, -0.00483],
      wrist_R: [0.002683, -0.011449, -0.004777],
    },
  },
  woman: {
    rest: {
      ankle_L: [0.04419, 0.038882, -0.015217],
      ankle_R: [-0.04419, 0.038882, -0.015217],
      elbow_L: [0.126789, 0.647756, -0.031541],
      elbow_R: [-0.126789, 0.647756, -0.031541],
      hand_L: [0.175287, 0.412568, 0.048161],
      hand_R: [-0.175287, 0.412568, 0.048161],
      hip_L: [0.055665, 0.503101, -0.005528],
      hip_R: [-0.055665, 0.503101, -0.005528],
      knee_L: [0.045953, 0.24752, -0.018847],
      knee_R: [-0.045953, 0.24752, -0.018847],
      shoulder_L: [0.099941, 0.815116, -0.01744],
      shoulder_R: [-0.099941, 0.815116, -0.01744],
      toe_L: [0.063019, 0.002023, 0.078342],
      toe_R: [-0.063019, 0.002023, 0.078342],
      toes_L: [0.074757, 0.004989, 0.037914],
      toes_R: [-0.074757, 0.004989, 0.037914],
      wrist_L: [0.152071, 0.498696, 0.008197],
      wrist_R: [-0.152071, 0.498696, 0.008197],
    },
    endpointR: {
      ankle_L: [-0.10709, 0.042509, 0.037755, 0.992622],
      ankle_R: [-0.107214, -0.035991, -0.035716, 0.992942],
      wrist_L: [0.087677, -0.59786, 0.297649, 0.739109],
      wrist_R: [0.088953, 0.628927, -0.302958, 0.71046],
    },
    endpointS: {
      ankle_L: 0.971822,
      ankle_R: 0.968202,
      wrist_L: 0.83633,
      wrist_R: 0.839051,
    },
    endpointT: {
      ankle_L: [-0.004944, -0.002638, -0.00632],
      ankle_R: [0.004214, -0.002611, -0.006253],
      wrist_L: [-0.004447, -0.017508, -0.002686],
      wrist_R: [0.003448, -0.016933, -0.002757],
    },
  },
};
