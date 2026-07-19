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
// both heads turn a little the same way — his gaze out over the open side,
// her face nestled toward his right cheek — and tip a few degrees toward
// each other (temple to temple), chins lifted off the forward body curve.
function embraceArms(leader, follower) {
  leader.setJointDegrees({
    shoulder_L: { x: -30, y: 30, z: 15 }, elbow_L: { x: -120, y: -30 }, wrist_L: { x: -15 },
    shoulder_R: { x: -55, z: -18, y: 20 }, elbow_R: { x: -70 },
    spine: { x: 4 }, chest: { x: 4 }, neck: { x: -5, y: 12, z: 4 },
  });
  follower.setJointDegrees({
    shoulder_R: { x: -30, y: -30, z: -15 }, elbow_R: { x: -120, y: 30 }, wrist_R: { x: -15 },
    shoulder_L: { x: -65, z: 22 }, elbow_L: { x: -50 },
    spine: { x: 4 }, chest: { x: 4 }, neck: { x: -5, y: 12, z: 4 },
  });
}

function place(fig, x, z, facingDeg) {
  fig.group.position.set(x, 0, z);
  fig.group.rotation.y = (facingDeg * Math.PI) / 180;
}

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
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.17, 0);
      place(follower, -0.05, 0.17, 180);
      embraceArms(leader, follower);
      // Both incline gently into the shared frame (weight toward the balls
      // of the feet, chests meeting a shade before the hips — the "slight
      // pyramid" of the close embrace), then re-ground the soles.
      leader.setJointDegrees({ pelvis: { x: 3 } });
      follower.setJointDegrees({ pelvis: { x: 3 } });
      leader.group.updateMatrixWorld(true);
      follower.group.updateMatrixWorld(true);
      feetToFloor(leader);
      feetToFloor(follower);
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
      // colliders (skeletonDef.js) at a graze, not a clash.
      leader.setJointDegrees({
        hip_L: { x: -28 }, knee_L: { x: 8 }, ankle_L: { x: -12 },
        hip_R: { x: 15 }, knee_R: { x: 36 }, ankle_R: { x: 33 },
        pelvis: { x: 3 }, neck: { x: -4 },
      });
      leader.nodes.pelvis.position.y = 0.515 * leader.height;
      follower.setJointDegrees({
        hip_R: { x: 15 }, knee_R: { x: 36 }, ankle_R: { x: 33 },
        hip_L: { x: -8 }, knee_L: { x: 12 }, ankle_L: { x: -7 },
        pelvis: { x: 3 }, neck: { x: -10 },
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
