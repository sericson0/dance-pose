import { feetToFloor } from './ik.js';

// Sign conventions (see skeletonDef.js): hip x<0 leg forward · knee x>0 bend ·
// ankle x>0 point toes · toes x<0 toes up (demi-pointe) / x>0 curl under ·
// spine (lumbar) / chest (thoracic) x>0 lean forward · shoulder x<0 arm
// forward/up · left-side z>0 = out to the side (right side mirrored) ·
// elbow x<0 bend.

// The tango embrace frame. Open side (his left / her right): the upper arms
// lift the forearms so the joined hands are held UP by the couple's heads
// (tango carries the open-side hold at about temple height, elbows bent and
// hanging), out past the open-side shoulders — the embrace constraints then
// join the hands there (see embrace.js). Closed side: his right arm wraps
// around her UNDER her left arm, hers drapes over his to his right shoulder —
// the swivel authored here is what keeps that layering when the constraints
// re-solve the arms every frame. Heads: the V placement (presets put her
// slightly toward his closed side) passes her head by his right cheek, so
// both heads turn the same way — his gaze out over the open side, her face
// nestled toward his right cheek — tilt toward each other (temple to
// temple), and drop 15° as a NOD at the `head` joint (upper cervical), not
// a deeper neck pitch: the quiet, inward close-embrace gaze. Nodding at the
// head node pivots the face down where a neck pitch would translate the
// whole head capsule ~6 cm toward the partner — dropped at the neck, the
// two head colliders clash in the V and hold the couple 4+ cm out of torso
// contact. Even as a nod the capsules tip a little forward, so the temple
// tilt deepens (z 4° → 8°) to let the dropped heads pass cheek by cheek:
// measured at z4, close embrace stuck 13 cm short of chest contact; at z8
// it reaches the exact held distance again, and the y12/z8 pair is the one
// combination that also keeps the turned/pivoted transients settling where
// the closed-side palms still reach (a y18 yaw fixed the straight default
// but deflected the follower's collide-and-slide in the turned states).
// NOTE the yaw cannot rescue a square placement: what decides whether the
// heads pass or meet head-on is the couple's lateral OFFSET, not the yaw (a
// head capsule runs head→headTop, i.e. nearly along the yaw axis, so yawing
// barely moves it — it only swings where the 8° temple tilt points). At
// contact distance the capsules overlap 7.9 cm at a 5 cm offset and 3.1 cm
// at 11 cm; only ~14 cm clears them. Close embrace is authored at that offset
// and deepens the yaw to y20 locally — see its comment for why that override
// is not shared.
// Hips: the leader's pelvis turns 10° toward the couple's midline
// (her offset side, his right) with the chest counter-twisted to stay square
// to her — his hips angle in under an unmoved embrace frame, a small
// authored dissociation. Walk/apilado deliberately re-override neck x
// afterwards (their heads stay up over the body lean) but keep the nod.
// The arm chain sits on the ANATOMICAL joint centres (skeletonDef.js), whose
// rest already carries ~9.1° of shoulder abduction and a 19.4° elbow bend — so
// these angles are offset to compensate (elbow flexion +19.4°, abduction 9.1°
// toward zero) and reproduce roughly the intended world pose.
//
// The ARM angles are READ BACK OUT of the embrace solve, not hand-authored:
// apply this preset, tick both embrace constraints, let it settle, and dump
// the eight arm joints (scripts/dev-verify-embrace.mjs drives the same path).
// That is the only way to keep them honest — hand-authored angles went stale
// when the arm chain moved onto the anatomical joint centres and nobody could
// see it, because the constraints overwrite the arms the moment they are
// engaged. With them OFF, which is how the app STARTS, the stale angles were
// what the user actually saw: both dancers with their arms flung out in the
// air, the clasp hands 32 cm apart and the leader's right palm 48 cm in FRONT
// of his own chest instead of around her back.
//
// So: after changing the embrace solve or a preset's placement, re-bake these
// rather than nudging them by hand. They still only SEED the constrained
// solve (which re-solves all four arms every frame), but they ARE the pose in
// the unconstrained view, and that view is the app's front door.
function embraceArms(leader, follower) {
  leader.setJointDegrees({
    shoulder_L: { x: -11, y: 37, z: -6 }, elbow_L: { x: -111, y: -23 }, wrist_L: { x: -65, z: 7 },
    shoulder_R: { x: -8, y: 3, z: -8 }, elbow_R: { x: -92, y: 9 }, wrist_R: { x: 0, y: 0, z: 0 },
    spine: { x: 4 }, chest: { x: 4, y: 10 }, pelvis: { y: -10 },
    neck: { x: -5, y: 12, z: 8 }, head: { x: 15 },
  });
  follower.setJointDegrees({
    shoulder_R: { x: -66, y: -47, z: -72 }, elbow_R: { x: -99, y: 51 }, wrist_R: { x: -17, z: -30 },
    shoulder_L: { x: -79, y: -45, z: -27 }, elbow_L: { x: -84, y: -2 }, wrist_L: { x: 0, y: 0, z: 0 },
    spine: { x: 4 }, chest: { x: 4 }, neck: { x: -5, y: 12, z: 8 }, head: { x: 15 },
  });
}

function place(fig, x, z, facingDeg) {
  fig.group.position.set(x, 0, z);
  fig.group.rotation.y = (facingDeg * Math.PI) / 180;
}

// The default "Close embrace" pose, captured whole from the app. It was built
// BY HAND with the constraints off (the Anchor / "place arms by hand" mode)
// and exported, so it is a settled artistic pose rather than a solve output:
// the follower is nestled into the leader's right side and turned ~31° in to
// meet his chest (facing ≈149°, not a square 180°), cheek to cheek; his right
// arm wraps her back and hers drapes over his right shoulder; the open-side
// clasp is drawn in high and tucked between the bodies. Baked as raw joint
// rotations (radians) + placement + hand curl and applied with setPose, so it
// reproduces byte-for-byte what was authored — DO NOT hand-edit the numbers;
// re-author in Anchor mode, export, and regenerate this block instead.
//
// NOTE this pose is authored for the constraints-OFF view (how the app opens).
// Unlike the couple's canonical embrace frame (embraceArms), it is NOT the
// embrace solver's fixed point: ticking "Hold embrace (arms)" will re-solve
// all four arms toward the solver's targets and shift them from these exact
// angles (the solver's clasp/back targets still assume the older square
// geometry — see the embrace rework notes in CLAUDE.md). The default look is
// faithful; the constrained look is the solver's, as before.
const CLOSE_EMBRACE_LEADER = {
  position: [0.16234, 0, -0.36315],
  quaternion: [0, 0, 0, 1],
  pelvisY: 0.53,
  handCurl: { L: 0.77, R: 0.21 },
  joints: {
    pelvis: [0.05236, -0.17453, 0],
    spine: [0.06981, 0, 0],
    chest: [0.06981, 0.17453, 0],
    neck: [-0.08727, 0.40143, 0],
    head: [0.2618, 0, 0],
    shoulder_L: [-0.33022, 0.25681, 0.19094],
    elbow_L: [-2.09991, 0.13963, 0],
    wrist_L: [-0.01745, 0, 0],
    hip_L: [-0.01521, 0, 0],
    knee_L: [0.03026, 0, 0],
    ankle_L: [-0.0666, 0, 0],
    shoulder_R: [0.68068, 1.23918, -1.52543],
    elbow_R: [-1.39626, -0.94248, 0],
    wrist_R: [0, 0, 0.27925],
    hip_R: [-0.0154, 0, 0],
    knee_R: [0.03026, 0, 0],
    ankle_R: [-0.06641, 0, 0],
  },
};

const CLOSE_EMBRACE_FOLLOWER = {
  position: [0.13027, 0, -0.07856],
  quaternion: [0, 0.963941, 0, 0.266116],
  pelvisY: 0.52921,
  handCurl: { L: 0.23, R: 0.34 },
  joints: {
    pelvis: [0.05236, 0, 0],
    spine: [0.05236, 0, 0],
    chest: [-0.10472, 0.1098, -0.01357],
    neck: [-0.08727, 0.59341, 0],
    head: [0.2618, 0.15708, 0],
    scapula_L: [0, 0, 0.08727],
    shoulder_L: [0.50867, -0.92453, 2.47551],
    elbow_L: [-1.78024, 1.53589, 0],
    wrist_L: [0.05236, 0, 0.10472],
    hip_L: [0.033, -0.00244, -0.01044],
    knee_L: [0.03182, 0, 0],
    ankle_L: [-0.13342, 0, 0.01226],
    shoulder_R: [-0.89813, -0.4999, -0.39344],
    elbow_R: [-2.01065, 1.53589, 0],
    hip_R: [0.033, -0.00244, -0.01044],
    knee_R: [0.03182, 0, 0],
    ankle_R: [-0.11861, 0, 0.01226],
  },
};

export const PRESETS = [
  {
    name: 'Standing (reset)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, -0.35, 0, 0);
      place(follower, 0.35, 0, 0);
      leader.setJointDegrees({ shoulder_L: { z: 8 }, shoulder_R: { z: -8 } });
      follower.setJointDegrees({ shoulder_L: { z: 8 }, shoulder_R: { z: -8 } });
    },
  },
  {
    name: 'Close embrace',
    // The app's opening pose: a hand-authored close embrace captured whole
    // (CLOSE_EMBRACE_LEADER / _FOLLOWER above). setPose replays the exact
    // placement, joint angles and hand curls, so the default is byte-for-byte
    // what was built in Anchor mode. See the constant's comment for why this
    // is authored for the constraints-off view and shifts when the embrace
    // constraints are engaged.
    apply(leader, follower) {
      leader.setPose(CLOSE_EMBRACE_LEADER);
      follower.setPose(CLOSE_EMBRACE_FOLLOWER);
    },
  },
  {
    name: 'Walk — leader forward, follower back',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.14, 0);
      place(follower, -0.05, 0.26, 180);
      embraceArms(leader, follower);
      // Walking adds a whole-body lean (pelvis x) on top of the embrace's
      // forward lean; keep both heads upright over it (real walkers look
      // ahead, not down into the partner) so the heads meet the body-contact
      // colliders (skeletonDef.js) at a graze, not a clash — that includes
      // zeroing the standing frame's 15° head nod (embraceArms): nodded, the
      // head capsules clash at walking contact and the collision/torso-pull
      // tug-of-war holds the clasp open. The leader's standing hip-in twist
      // (pelvis y -10 / chest y +10) is zeroed the same way: mid-stride the
      // trunk yaw belongs to the step's own dissociation, and the static
      // twist swings his open-side shoulder back far enough that the clasp
      // can no longer close.
      leader.setJointDegrees({
        hip_L: { x: -28 }, knee_L: { x: 8 }, ankle_L: { x: -12 },
        hip_R: { x: 15 }, knee_R: { x: 36 }, ankle_R: { x: 33 },
        pelvis: { x: 3, y: 0 }, chest: { y: 0 }, neck: { x: -4 }, head: { x: 0 },
      });
      leader.nodes.pelvis.position.y = 0.515 * leader.height;
      follower.setJointDegrees({
        hip_R: { x: 15 }, knee_R: { x: 36 }, ankle_R: { x: 33 },
        hip_L: { x: -8 }, knee_L: { x: 12 }, ankle_L: { x: -7 },
        pelvis: { x: 3 }, neck: { x: -10 }, head: { x: 0 },
      });
      follower.nodes.pelvis.position.y = 0.527 * follower.height;
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
    },
  },
  {
    name: 'Apilado (shared-axis lean)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.145, 0);
      place(follower, -0.05, 0.145, 180);
      embraceArms(leader, follower);
      // Whole-body lean toward the partner, then re-ground the feet.
      leader.setJointDegrees({ pelvis: { x: 8 }, chest: { x: 3 }, neck: { x: -6 } });
      follower.setJointDegrees({ pelvis: { x: 9 }, chest: { x: 3 }, neck: { x: -6 } });
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
      feetToFloor(leader);
      feetToFloor(follower);
    },
  },
  {
    name: 'Cruzada (follower crosses)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.17, 0);
      place(follower, -0.05, 0.17, 180);
      embraceArms(leader, follower);
      // Leader collected, weight settled with soft knees, feet flat
      // (hip/ankle compensate the knee bend so the soles stay level).
      leader.setJointDegrees({
        hip_L: { x: -3 }, knee_L: { x: 6 }, ankle_L: { x: -3 },
        hip_R: { x: -3 }, knee_R: { x: 6 }, ankle_R: { x: -3 },
      });
      // Follower: left foot crossed tightly in front of the right with a
      // little turnout, toe grazing the floor, weight on the right leg.
      follower.setJointDegrees({
        hip_L: { x: -8, z: -22, y: 12 },
        knee_L: { x: 24 }, ankle_L: { x: 4 },
        hip_R: { x: -2, z: 3 }, knee_R: { x: 4 }, ankle_R: { x: -2 },
      });
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
    },
  },
  {
    name: 'Forward ocho (follower mid-step)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.17, 0);
      place(follower, -0.08, 0.24, 180);
      embraceArms(leader, follower);
      // Leader marks the ocho: weight over the flat left foot, chest rotated,
      // free right foot collected behind on a grazing toe.
      leader.setJointDegrees({
        chest: { y: 10 }, spine: { y: 6 },
        hip_L: { x: -3 }, knee_L: { x: 6 }, ankle_L: { x: -3 },
        hip_R: { x: 14 }, knee_R: { x: 42 }, ankle_R: { x: 30 },
      });
      // Follower mid forward-ocho: hips turned, upper body dissociated back
      // toward the leader, right leg reaching through, trailing toe grazing.
      follower.setJointDegrees({
        pelvis: { y: -28 },
        spine: { y: 8 }, chest: { y: 30 }, neck: { y: -18 },
        hip_R: { x: -28 }, knee_R: { x: 8 }, ankle_R: { x: 30 },
        hip_L: { x: 15 }, knee_L: { x: 40 }, ankle_L: { x: 33 },
      });
      follower.nodes.pelvis.position.y = 0.515 * follower.height;
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
    },
  },
  {
    name: 'Back ocho (follower mid-step)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.17, 0);
      place(follower, -0.05, 0.28, 180);
      embraceArms(leader, follower);
      // Leader marks the back ocho: weight over the right foot, chest rotated
      // the other way, free left foot collected on a grazing toe.
      leader.setJointDegrees({
        chest: { y: -10 }, spine: { y: -6 },
        hip_R: { x: -3 }, knee_R: { x: 6 }, ankle_R: { x: -3 },
        hip_L: { x: 14 }, knee_L: { x: 42 }, ankle_L: { x: 30 },
      });
      // Follower mid back-ocho: hips turned, chest dissociated back toward the
      // leader, left leg reaching behind on a pointed grazing toe.
      follower.setJointDegrees({
        pelvis: { y: 26 },
        spine: { y: -8 }, chest: { y: -26 }, neck: { y: 16 },
        hip_L: { x: 15 }, knee_L: { x: 36 }, ankle_L: { x: 33 },
        hip_R: { x: -8 }, knee_R: { x: 12 }, ankle_R: { x: -4 },
      });
      follower.nodes.pelvis.position.y = 0.527 * follower.height;
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
    },
  },
  {
    name: 'Colgada (counter-lean)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.22, 0);
      place(follower, -0.04, 0.22, 180);
      // Arms reaching to a hand-to-hand grip — the pull holds both dancers up.
      leader.setJointDegrees({
        shoulder_L: { x: -50, z: 10 }, elbow_L: { x: -40 },
        shoulder_R: { x: -50, z: -10 }, elbow_R: { x: -40 },
        neck: { x: -8 },
      });
      follower.setJointDegrees({
        shoulder_R: { x: -50, z: -10 }, elbow_R: { x: -40 },
        shoulder_L: { x: -50, z: 10 }, elbow_L: { x: -40 },
        neck: { x: -8 },
      });
      // Both hang back away from the shared axis; feet stay in at the middle.
      leader.setJointDegrees({ pelvis: { x: -18 }, spine: { x: 6 }, chest: { x: 5 } });
      follower.setJointDegrees({ pelvis: { x: -18 }, spine: { x: 6 }, chest: { x: 5 } });
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
      feetToFloor(leader);
      feetToFloor(follower);
      // The hip's backward limit keeps the IK from reaching the floor on a
      // deep back-lean; settle the remaining gap through the root.
      leader.group.position.y -= leader.lowestPointY();
      follower.group.position.y -= follower.lowestPointY();
    },
  },
  {
    name: 'Volcada (follower leans in)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.19, 0);
      place(follower, -0.04, 0.13, 180);
      embraceArms(leader, follower);
      // Leader: split stance, slight back-lean to receive her weight.
      leader.setJointDegrees({
        pelvis: { x: -4 },
        hip_L: { x: -14 }, knee_L: { x: 8 },
        hip_R: { x: 12 }, knee_R: { x: 6 },
      });
      leader.group.updateMatrixWorld(true);
      feetToFloor(leader);
      // Follower: tilted forward past her base onto the leader, support leg
      // vertical under the pelvis, free leg trailing behind off the floor.
      follower.setJointDegrees({
        pelvis: { x: 16 }, spine: { x: 2 }, chest: { x: 2 },
        hip_R: { x: -16 }, knee_R: { x: 4 }, ankle_R: { x: -4 },
        hip_L: { x: 15 }, knee_L: { x: 20 }, ankle_L: { x: 45 },
      });
      follower.group.updateMatrixWorld(true);
    },
  },
  {
    name: 'Parada / pasada (step over)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.24, 0);
      place(follower, -0.05, 0.22, 180);
      embraceArms(leader, follower);
      // Leader sinks on the left leg and extends the right foot to stop the
      // follower's foot; both soles flat (angle triples sum to zero).
      leader.setJointDegrees({
        hip_L: { x: -8 }, knee_L: { x: 26 }, ankle_L: { x: -18 },
        hip_R: { x: -20 }, knee_R: { x: 10 }, ankle_R: { x: 9 },
      });
      leader.nodes.pelvis.position.y = 0.5155 * leader.height;
      // Follower steps over the leader's foot: left leg lifted high mid-pasada.
      follower.setJointDegrees({
        spine: { y: 6 }, chest: { y: 8 },
        hip_R: { x: -2 }, knee_R: { x: 4 }, ankle_R: { x: -2 },
        hip_L: { x: -48 }, knee_L: { x: 70 }, ankle_L: { x: 30 },
      });
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
    },
  },
  {
    name: 'Giro (follower side step)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.15, 0);
      place(follower, -0.10, 0.22, 180);
      embraceArms(leader, follower);
      // Leader pivots collected on the left foot, torso leading the turn,
      // free right foot on the toe beside it.
      leader.setJointDegrees({
        spine: { y: 8 }, chest: { y: 16 },
        hip_L: { x: -3 }, knee_L: { x: 6 }, ankle_L: { x: -3 },
        hip_R: { x: 2 }, knee_R: { x: 50 }, ankle_R: { x: 42 },
      });
      leader.nodes.pelvis.position.y = 0.525 * leader.height;
      // Follower: wide side step of the molinete — right leg reaching out on a
      // grazing toe, lowered into the standing left leg, shoulders staying
      // with the leader.
      follower.setJointDegrees({
        spine: { y: -8 }, chest: { y: -24 }, neck: { y: 12 },
        hip_R: { x: -2, z: -24 }, knee_R: { x: 6 }, ankle_R: { x: 12, z: 18 },
        hip_L: { x: -4, z: 4 }, knee_L: { x: 18 }, ankle_L: { x: -14 },
      });
      follower.nodes.pelvis.position.y = 0.518 * follower.height;
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
    },
  },
  {
    name: 'Dissociation (ocho preparation)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.17, 0);
      place(follower, -0.05, 0.17, 180);
      embraceArms(leader, follower);
      // Follower's upper body twists against quiet hips — the heart of the
      // ocho. Almost all of it comes from the thoracic spine: the lumbar
      // facets allow only a few degrees.
      follower.setJointDegrees({
        spine: { y: 8 }, chest: { y: 35 }, neck: { y: -20 },
        hip_R: { y: 5 },
      });
      follower.group.updateMatrixWorld(true);
    },
  },
];
