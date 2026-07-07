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
// holds the skeletal-hand roll quaternions [x, y, z, w] (scale-free).
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
      shoulder_L: [0.093337, 0.799133, -0.017802],
      shoulder_R: [-0.093337, 0.799133, -0.017802],
      toe_L: [0.063019, 0.002023, 0.078342],
      toe_R: [-0.063019, 0.002023, 0.078342],
      toes_L: [0.074757, 0.004989, 0.037914],
      toes_R: [-0.074757, 0.004989, 0.037914],
      wrist_L: [0.152071, 0.498696, 0.008197],
      wrist_R: [-0.152071, 0.498696, 0.008197],
    },
    endpointR: {
      wrist_L: [0.261957, -0.352076, 0.161908, 0.883859],
      wrist_R: [0.266243, 0.356436, -0.163937, 0.88045],
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
      shoulder_L: [0.093337, 0.799133, -0.017802],
      shoulder_R: [-0.093337, 0.799133, -0.017802],
      toe_L: [0.063019, 0.002023, 0.078342],
      toe_R: [-0.063019, 0.002023, 0.078342],
      toes_L: [0.074757, 0.004989, 0.037914],
      toes_R: [-0.074757, 0.004989, 0.037914],
      wrist_L: [0.152071, 0.498696, 0.008197],
      wrist_R: [-0.152071, 0.498696, 0.008197],
    },
    endpointR: {
      wrist_L: [0.27588, -0.362723, 0.150582, 0.877295],
      wrist_R: [0.284182, 0.37295, -0.157352, 0.869131],
    },
  },
};
