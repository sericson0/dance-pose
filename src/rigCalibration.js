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
      ankle_L: [0.044307, 0.038891, -0.01466],
      ankle_R: [-0.044307, 0.038891, -0.01466],
      elbow_L: [0.126789, 0.647756, -0.031541],
      elbow_R: [-0.126789, 0.647756, -0.031541],
      hand_L: [0.175287, 0.412568, 0.048161],
      hand_R: [-0.175287, 0.412568, 0.048161],
      hip_L: [0.039958, 0.504518, -0.00568],
      hip_R: [-0.039958, 0.504518, -0.00568],
      knee_L: [0.051012, 0.262109, 0.004429],
      knee_R: [-0.051012, 0.262109, 0.004429],
      shoulder_L: [0.095093, 0.794351, -0.017529],
      shoulder_R: [-0.095093, 0.794351, -0.017529],
      toe_L: [0.063019, 0.002023, 0.078342],
      toe_R: [-0.063019, 0.002023, 0.078342],
      toes_L: [0.074757, 0.004989, 0.037914],
      toes_R: [-0.074757, 0.004989, 0.037914],
      wrist_L: [0.152071, 0.498696, 0.008197],
      wrist_R: [-0.152071, 0.498696, 0.008197],
    },
    endpointR: {
      wrist_L: [0.069496, -0.635647, 0.300984, 0.707483],
      wrist_R: [0.065536, 0.66001, -0.304483, 0.683653],
    },
    endpointS: {
      wrist_L: 0.825838,
      wrist_R: 0.821222,
    },
    endpointT: {
      wrist_L: [-0.004096, -0.011112, -0.004831],
      wrist_R: [0.002683, -0.011449, -0.004777],
    },
  },
  woman: {
    rest: {
      ankle_L: [0.044307, 0.038891, -0.01466],
      ankle_R: [-0.044307, 0.038891, -0.01466],
      elbow_L: [0.126789, 0.647756, -0.031541],
      elbow_R: [-0.126789, 0.647756, -0.031541],
      hand_L: [0.175287, 0.412568, 0.048161],
      hand_R: [-0.175287, 0.412568, 0.048161],
      hip_L: [0.039958, 0.504518, -0.00568],
      hip_R: [-0.039958, 0.504518, -0.00568],
      knee_L: [0.051012, 0.262109, 0.004429],
      knee_R: [-0.051012, 0.262109, 0.004429],
      shoulder_L: [0.095093, 0.794351, -0.017529],
      shoulder_R: [-0.095093, 0.794351, -0.017529],
      toe_L: [0.063019, 0.002023, 0.078342],
      toe_R: [-0.063019, 0.002023, 0.078342],
      toes_L: [0.074757, 0.004989, 0.037914],
      toes_R: [-0.074757, 0.004989, 0.037914],
      wrist_L: [0.152071, 0.498696, 0.008197],
      wrist_R: [-0.152071, 0.498696, 0.008197],
    },
    endpointR: {
      wrist_L: [0.087677, -0.59786, 0.297649, 0.739109],
      wrist_R: [0.088953, 0.628927, -0.302958, 0.71046],
    },
    endpointS: {
      wrist_L: 0.83633,
      wrist_R: 0.839051,
    },
    endpointT: {
      wrist_L: [-0.004447, -0.017508, -0.002686],
      wrist_R: [0.003447, -0.016933, -0.002757],
    },
  },
};
