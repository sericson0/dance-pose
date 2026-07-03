import { feetToFloor } from './ik.js';

// Sign conventions (see skeletonDef.js): hip x<0 leg forward · knee x>0 bend ·
// ankle x>0 point toes · spine/chest x>0 lean forward · shoulder x<0 arm
// forward/up · left-side z>0 = out to the side (right side mirrored) ·
// elbow x<0 bend.

function embraceArms(leader, follower) {
  leader.setJointDegrees({
    shoulder_L: { x: -30, z: 55 }, elbow_L: { x: -95, y: -25 }, wrist_L: { x: -10 },
    shoulder_R: { x: -55, z: -18, y: 20 }, elbow_R: { x: -70 },
    spine: { x: 4 }, chest: { x: 4 }, neck: { y: 12 },
  });
  follower.setJointDegrees({
    shoulder_R: { x: -30, z: -55 }, elbow_R: { x: -95, y: 25 }, wrist_R: { x: -10 },
    shoulder_L: { x: -65, z: 22 }, elbow_L: { x: -50 },
    spine: { x: 4 }, chest: { x: 4 }, neck: { y: 12 },
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
      leader.setJointDegrees({
        hip_L: { x: -28 }, knee_L: { x: 8 }, ankle_L: { x: -12 },
        hip_R: { x: 15 }, knee_R: { x: 6 }, ankle_R: { x: 38 },
        pelvis: { x: 3 },
      });
      leader.nodes.pelvis.position.y = 0.518 * leader.height;
      follower.setJointDegrees({
        hip_R: { x: 15 }, knee_R: { x: 4 }, ankle_R: { x: 45 },
        hip_L: { x: -8 }, knee_L: { x: 12 }, ankle_L: { x: -4 },
        pelvis: { x: 3 },
      });
      follower.nodes.pelvis.position.y = 0.514 * follower.height;
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
    name: 'Dissociation (ocho preparation)',
    apply(leader, follower) {
      leader.resetPose();
      follower.resetPose();
      place(leader, 0, -0.17, 0);
      place(follower, -0.05, 0.17, 180);
      embraceArms(leader, follower);
      // Follower's upper body twists against quiet hips — the heart of the ocho.
      follower.setJointDegrees({
        spine: { y: 18 }, chest: { y: 25 }, neck: { y: -20 },
        hip_R: { y: 5 },
      });
      follower.group.updateMatrixWorld(true);
    },
  },
];
