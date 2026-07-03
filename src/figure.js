import * as THREE from 'three';
import { JOINTS, JOINT_BY_NAME, DEG, clampAngle } from './skeletonDef.js';
import { buildSkeleton, buildMuscles } from './anatomy.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);

// Body-view capsule radii per segment (fractions of height).
const BODY_RADII = {
  hip_L: 0.052, hip_R: 0.052,     // thighs
  knee_L: 0.040, knee_R: 0.040,   // shanks
  shoulder_L: 0.036, shoulder_R: 0.036, // upper arms
  elbow_L: 0.029, elbow_R: 0.029, // forearms
};

export class Figure {
  constructor({ name, height = 1.72, mass = 70, color = 0x4d8fd1, skin = 0xd9a68a }) {
    this.name = name;
    this.height = height;
    this.mass = mass;
    this.color = color;
    this.skin = skin;

    this.group = new THREE.Group(); // root: position (x,z) + facing (rotation.y)
    this.group.userData.figure = this;
    this.nodes = {};
    this.pickSpheres = [];
    this.layerMeshes = { skeleton: [], body: [], muscle: [] };
    this.jointSphereByName = {};

    this.#buildMaterials();
    this.#build();
  }

  #buildMaterials() {
    this.materials = {
      bone: new THREE.MeshStandardMaterial({ color: 0xece4d2, roughness: 0.55 }),
      cartilage: new THREE.MeshStandardMaterial({ color: 0xd7d9d2, roughness: 0.4 }),
      socket: new THREE.MeshStandardMaterial({ color: 0x3b3630, roughness: 0.6 }),
      joint: new THREE.MeshStandardMaterial({ color: 0xcfc6b0, roughness: 0.5, transparent: true }),
      cloth: new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.85 }),
      clothDark: new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.color).multiplyScalar(0.55), roughness: 0.9,
      }),
      skin: new THREE.MeshStandardMaterial({ color: this.skin, roughness: 0.7 }),
      shoe: new THREE.MeshStandardMaterial({ color: 0x23232a, roughness: 0.5 }),
      muscleA: new THREE.MeshStandardMaterial({ color: 0xbc4a3f, roughness: 0.5 }),
      muscleB: new THREE.MeshStandardMaterial({ color: 0x9c3540, roughness: 0.5 }),
    };
  }

  // Attach a mesh into a joint node and register it in a visual layer.
  // Public so anatomy.js (and future part modules) can add geometry.
  addMesh(nodeName, mesh, layer, cast = true) {
    mesh.castShadow = cast;
    this.nodes[nodeName].add(mesh);
    if (layer) this.layerMeshes[layer].push(mesh);
    return mesh;
  }

  #build() {
    const H = this.height;

    // Joint hierarchy.
    for (const def of JOINTS) {
      const node = new THREE.Object3D();
      node.name = `${this.name}:${def.name}`;
      node.position.set(def.offset[0] * H, def.offset[1] * H, def.offset[2] * H);
      node.userData = { figure: this, jointName: def.name, def };
      this.nodes[def.name] = node;
      if (def.parent) this.nodes[def.parent].add(node);
      else this.group.add(node);
    }

    // --- Skeleton layer (procedural bones live in anatomy.js) ---
    buildSkeleton(this);

    // Joint pick/display spheres (always raycastable; opacity follows skeleton layer).
    for (const def of JOINTS) {
      const r = def.endpoint ? 0.016 * H : 0.02 * H;
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), this.materials.joint.clone());
      s.userData = { figure: this, jointName: def.name, isPick: true };
      this.nodes[def.name].add(s);
      this.pickSpheres.push(s);
      this.jointSphereByName[def.name] = s;
    }

    this.#buildBody();
    buildMuscles(this);
    this.setLayers({ skeleton: false, body: true, muscle: false });
  }

  #buildBody() {
    const H = this.height;
    // --- Body layer: mannequin volumes ---
    const limbFor = (nodeName, childName, r, mat, sx = 1, sz = 1) => {
      const child = JOINT_BY_NAME[childName];
      const end = new THREE.Vector3(child.offset[0] * H, child.offset[1] * H, child.offset[2] * H);
      this.#bodyCapsule(nodeName, new THREE.Vector3(), end, r * H, mat, sx, sz);
    };

    // Trunk: hips bar, abdomen, chest, shoulder bar.
    this.#bodyCapsule('pelvis',
      new THREE.Vector3(-0.052 * H, 0, 0), new THREE.Vector3(0.052 * H, 0, 0),
      0.062 * H, this.materials.cloth, 1, 0.85);
    limbFor('pelvis', 'spine', 0.070, this.materials.cloth, 1.15, 0.85);
    limbFor('spine', 'chest', 0.074, this.materials.cloth, 1.15, 0.8);
    limbFor('chest', 'neck', 0.082, this.materials.cloth, 1.25, 0.75);
    this.#bodyCapsule('chest',
      new THREE.Vector3(-0.115 * H, 0.11 * H, 0), new THREE.Vector3(0.115 * H, 0.11 * H, 0),
      0.042 * H, this.materials.cloth);
    // Neck.
    limbFor('neck', 'head', 0.024, this.materials.skin);

    // Limbs.
    for (const side of ['L', 'R']) {
      limbFor(`hip_${side}`, `knee_${side}`, BODY_RADII[`hip_${side}`], this.materials.clothDark);
      limbFor(`knee_${side}`, `ankle_${side}`, BODY_RADII[`knee_${side}`], this.materials.clothDark);
      limbFor(`shoulder_${side}`, `elbow_${side}`, BODY_RADII[`shoulder_${side}`], this.materials.cloth);
      limbFor(`elbow_${side}`, `wrist_${side}`, BODY_RADII[`elbow_${side}`], this.materials.skin);
      // Hand: small flattened ellipsoid.
      const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), this.materials.skin);
      hand.scale.set(0.024 * H, 0.05 * H, 0.032 * H);
      hand.position.set(0, -0.05 * H, 0);
      hand.castShadow = true;
      this.nodes[`wrist_${side}`].add(hand);
      this.layerMeshes.body.push(hand);
      // Shoe.
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.062 * H, 0.046 * H, 0.19 * H), this.materials.shoe);
      shoe.position.set(0, -0.019 * H, 0.048 * H);
      shoe.castShadow = true;
      this.nodes[`ankle_${side}`].add(shoe);
      this.layerMeshes.body.push(shoe);
    }

    // Head + hair + nose (nose shows facing in both skeleton and body views).
    const headBall = new THREE.Mesh(new THREE.SphereGeometry(0.066 * H, 20, 16), this.materials.skin);
    headBall.position.set(0, 0.055 * H, 0.004 * H);
    headBall.castShadow = true;
    this.nodes.head.add(headBall);
    this.layerMeshes.body.push(headBall);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.068 * H, 20, 16), this.materials.clothDark);
    hair.position.set(0, 0.062 * H, -0.008 * H);
    hair.scale.set(1, 0.92, 0.95);
    this.nodes.head.add(hair);
    this.layerMeshes.body.push(hair);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.012 * H, 0.028 * H, 8), this.materials.skin);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.045 * H, 0.068 * H);
    this.nodes.head.add(nose); // visible in every view
  }

  #alignY(mesh, a, b) {
    const dir = b.clone().sub(a);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize());
  }

  #bodyCapsule(nodeName, a, b, radius, material, sx = 1, sz = 1) {
    const len = a.distanceTo(b);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, len, 6, 14), material);
    this.#alignY(mesh, a, b);
    mesh.scale.set(sx, 1, sz);
    mesh.castShadow = true;
    this.nodes[nodeName].add(mesh);
    this.layerMeshes.body.push(mesh);
    return mesh;
  }

  setLayers({ skeleton, body, muscle }) {
    this.layers = { skeleton, body, muscle };
    for (const m of this.layerMeshes.skeleton) m.visible = skeleton;
    for (const m of this.layerMeshes.body) m.visible = body;
    for (const m of this.layerMeshes.muscle) m.visible = muscle;
    // Joint spheres: solid only in skeleton view; invisible-but-clickable otherwise.
    for (const s of this.pickSpheres) {
      s.material.opacity = skeleton ? 0.85 : 0;
      s.material.depthWrite = skeleton;
    }
  }

  clampJoint(name) {
    const def = JOINT_BY_NAME[name];
    if (!def || !def.limits) return;
    const r = this.nodes[name].rotation;
    r.x = clampAngle(r.x, def.limits.x);
    r.y = clampAngle(r.y, def.limits.y);
    r.z = clampAngle(r.z, def.limits.z);
  }

  getPose() {
    const joints = {};
    for (const def of JOINTS) {
      if (def.endpoint) continue;
      const r = this.nodes[def.name].rotation;
      joints[def.name] = [r.x, r.y, r.z];
    }
    return {
      position: this.group.position.toArray(),
      quaternion: this.group.quaternion.toArray(),
      facing: this.group.rotation.y,
      pelvisY: this.nodes.pelvis.position.y / this.height, // stored as fraction of height
      joints,
    };
  }

  setPose(pose) {
    if (pose.position) this.group.position.fromArray(pose.position);
    if (pose.quaternion) this.group.quaternion.fromArray(pose.quaternion);
    else if (pose.facing !== undefined) this.group.rotation.y = pose.facing;
    if (pose.pelvisY !== undefined) this.nodes.pelvis.position.y = pose.pelvisY * this.height;
    for (const [name, [x, y, z]] of Object.entries(pose.joints || {})) {
      const node = this.nodes[name];
      if (!node) continue;
      node.rotation.set(x, y, z);
      this.clampJoint(name);
    }
    this.group.updateMatrixWorld(true);
  }

  resetPose() {
    for (const def of JOINTS) {
      if (!def.endpoint) this.nodes[def.name].rotation.set(0, 0, 0);
    }
    this.nodes.pelvis.position.set(0, 0.530 * this.height, 0);
    // Undo any closed-chain tilt of the root, keeping only floor position + yaw.
    const yaw = this.group.rotation.y;
    this.group.position.y = 0;
    this.group.rotation.set(0, yaw, 0);
    this.group.updateMatrixWorld(true);
  }

  // Convenience for authoring presets: angles in degrees.
  setJointDegrees(map) {
    for (const [name, axes] of Object.entries(map)) {
      const node = this.nodes[name];
      if (!node) continue;
      if (axes.x !== undefined) node.rotation.x = axes.x * DEG;
      if (axes.y !== undefined) node.rotation.y = axes.y * DEG;
      if (axes.z !== undefined) node.rotation.z = axes.z * DEG;
      this.clampJoint(name);
    }
    this.group.updateMatrixWorld(true);
  }

  worldPos(jointName, target = new THREE.Vector3()) {
    return this.nodes[jointName].getWorldPosition(target);
  }

  setHeight(h) {
    const pose = this.getPose();
    const layers = { ...this.layers };
    this.height = h;
    this.dispose();
    this.pickSpheres = [];
    this.layerMeshes = { skeleton: [], body: [], muscle: [] };
    this.jointSphereByName = {};
    this.nodes = {};
    this.#build();
    this.setPose(pose);
    this.setLayers(layers);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.group.clear();
  }
}
