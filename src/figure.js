import * as THREE from 'three';
import {
  JOINTS, JOINT_BY_NAME, DEG, clampAngle, FOOT_CORNERS_L, FOOT_CORNERS_R,
  TOE_CORNERS_L, TOE_CORNERS_R, PART_OF_NODE,
} from './skeletonDef.js';
import { buildSkeleton, buildMuscles } from './anatomy.js';
import { LIMB_BASES, reverseWinding } from './skeletonMesh.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _floorPt = new THREE.Vector3();

// Flesh clearance around each joint (fraction of height) used for floor
// contact; the foot soles are handled separately via FOOT_CORNERS.
const FLOOR_CLEARANCE = {
  head: 0.055, headTop: 0.01, neck: 0.04,
  pelvis: 0.075, spine: 0.08, chest: 0.08,
  shoulder_L: 0.045, shoulder_R: 0.045,
  elbow_L: 0.03, elbow_R: 0.03,
  wrist_L: 0.025, wrist_R: 0.025,
  hand_L: 0.012, hand_R: 0.012,
  hip_L: 0.055, hip_R: 0.055,
  knee_L: 0.042, knee_R: 0.042,
  toes_L: 0.008, toes_R: 0.008, // ball of the foot: sole is 0.009H below the joint
  toe_L: 0.004, toe_R: 0.004,
};

// Body-view capsule radii per segment (fractions of height).
const BODY_RADII = {
  shoulder_L: 0.036, shoulder_R: 0.036, // upper arms
  elbow_L: 0.029, elbow_R: 0.029, // forearms
};

// Lathe profiles for the legs: [t, r] pairs, t running 0 (proximal joint) to
// 1 (distal joint), radii as fractions of height. Profiles overshoot [0, 1]
// slightly so their open rims hide inside the pelvis / knee ball / ankle.
const THIGH_PROFILE = [
  [-0.06, 0.010], [-0.04, 0.030], [0.02, 0.048], [0.08, 0.054], [0.18, 0.057],
  [0.35, 0.052], [0.55, 0.046], [0.75, 0.041], [0.9, 0.038], [1.0, 0.0345],
  [1.04, 0.024], [1.09, 0.008],
];
// Calf bulge in the upper third, tapering to a narrow ankle.
const SHANK_PROFILE = [
  [-0.05, 0.008], [-0.03, 0.024], [0, 0.0355], [0.06, 0.038], [0.16, 0.042],
  [0.28, 0.041], [0.45, 0.034], [0.65, 0.026], [0.85, 0.020], [1.0, 0.0165],
  [1.03, 0.010], [1.05, 0.004],
];

export class Figure {
  constructor({ name, height = 1.72, mass = 70, color = 0x4d8fd1, skin = 0xd9a68a, skeleton = null, muscles = null }) {
    this.name = name;
    this.height = height;
    this.mass = mass;
    this.color = color;
    this.skin = skin;
    this.skeletonMesh = skeleton; // parsed atlas bones, or null → procedural bones
    this.muscleMesh = muscles; // parsed atlas muscles (needs skeleton), or null → procedural

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

    // --- Skeleton layer: imported anatomical mesh if available, else the
    // procedural bones in anatomy.js ---
    if (this.skeletonMesh) this.#buildMeshSkeleton();
    else buildSkeleton(this);

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
    // Muscle layer: imported atlas muscles (share the skeleton's frame, so they
    // need it too), else the procedural bellies in anatomy.js.
    if (this.muscleMesh && this.skeletonMesh) this.#buildMeshMuscles();
    else buildMuscles(this);
    this.setLayers({ skeleton: false, body: true, muscle: false });
  }

  // Attach the imported atlas bones to our joint tree. Each bone is baked from
  // the shared atlas frame into a target joint node's local space (so it poses
  // with that joint), right-side bones are also mirrored across the sagittal
  // plane to build the left side, and everything landing on the same node +
  // material is merged into one mesh to keep the draw-call count low.
  #buildMeshSkeleton() {
    const { bones, atlasMinY, atlasHeight } = this.skeletonMesh;
    const s = this.height / atlasHeight;
    this.group.updateMatrixWorld(true);
    const settle = new THREE.Matrix4().makeTranslation(0, -atlasMinY * s, 0);
    const Tpos = settle.clone().multiply(new THREE.Matrix4().makeScale(s, s, s));
    const Tneg = settle.clone().multiply(new THREE.Matrix4().makeScale(-s, s, s)); // mirror

    const groups = new Map(); // `${node}|${material}` → [geometry, …]
    const stash = (nodeName, material, geom) => {
      const key = `${nodeName}|${material}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(geom);
    };

    for (const b of bones) {
      const isLimb = LIMB_BASES.has(b.node);
      const targets = [];
      if (b.paired && isLimb) {
        targets.push([`${b.node}_R`, Tpos, false], [`${b.node}_L`, Tneg, true]);
      } else if (b.paired) {
        targets.push([b.node, Tpos, false], [b.node, Tneg, true]);
      } else {
        targets.push([b.node, Tpos, false]);
      }
      for (const [nodeName, T, mirror] of targets) {
        const node = this.nodes[nodeName];
        if (!node) continue;
        const g = b.geometry.clone();
        // local = node⁻¹ · group · T  (bring the atlas-frame bone into the node)
        const X = node.matrixWorld.clone().invert().multiply(this.group.matrixWorld).multiply(T);
        g.applyMatrix4(X);
        if (mirror) reverseWinding(g);
        stash(nodeName, b.material, g);
      }
    }

    for (const [key, geoms] of groups) {
      const [nodeName, material] = key.split('|');
      const merged = mergeGeometries(geoms, false);
      geoms.forEach((g) => g.dispose());
      if (!merged) continue;
      this.addMesh(nodeName, new THREE.Mesh(merged, this.materials[material]), 'skeleton', true);
    }
  }

  // Attach the imported atlas muscles to our joint tree. They live in the same
  // atlas frame as the bones, so they bake with the *skeleton's* atlas scale
  // (a limb-only muscle file has no full-body extent of its own). Each right-
  // side belly is placed on its node and also mirrored to the left; muscles
  // stay individual (not merged) so each keeps its name for future labelling
  // and a distinct tint for readability.
  #buildMeshMuscles() {
    const { atlasMinY, atlasHeight } = this.skeletonMesh;
    const s = this.height / atlasHeight;
    this.group.updateMatrixWorld(true);
    const settle = new THREE.Matrix4().makeTranslation(0, -atlasMinY * s, 0);
    const Tpos = settle.clone().multiply(new THREE.Matrix4().makeScale(s, s, s));
    const Tneg = settle.clone().multiply(new THREE.Matrix4().makeScale(-s, s, s)); // mirror

    this.muscleMesh.muscles.forEach((m, i) => {
      const material = i % 2 ? this.materials.muscleA : this.materials.muscleB;
      const isLimb = LIMB_BASES.has(m.node);
      const targets = isLimb
        ? [[`${m.node}_R`, Tpos, false], [`${m.node}_L`, Tneg, true]]
        : [[m.node, Tpos, false], [m.node, Tneg, true]];
      for (const [nodeName, T, mirror] of targets) {
        const node = this.nodes[nodeName];
        if (!node) continue;
        const g = m.geometry.clone();
        const X = node.matrixWorld.clone().invert().multiply(this.group.matrixWorld).multiply(T);
        g.applyMatrix4(X);
        if (mirror) reverseWinding(g);
        const mesh = new THREE.Mesh(g, material);
        mesh.userData.muscleName = m.label;
        this.addMesh(nodeName, mesh, 'muscle', true);
      }
    });
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
    const legEnd = (childName) => {
      const child = JOINT_BY_NAME[childName];
      return new THREE.Vector3(child.offset[0] * H, child.offset[1] * H, child.offset[2] * H);
    };
    for (const side of ['L', 'R']) {
      // Legs: tapered profiles instead of uniform capsules.
      this.#bodyLimbProfile(`hip_${side}`, new THREE.Vector3(), legEnd(`knee_${side}`),
        THIGH_PROFILE, this.materials.clothDark);
      this.#bodyLimbProfile(`knee_${side}`, new THREE.Vector3(), legEnd(`ankle_${side}`),
        SHANK_PROFILE, this.materials.clothDark);
      // Knee ball fills the gap when the knee bends; at rest it hides just
      // inside the thigh/shank profiles so no intersection ring shows.
      this.#bodyBall(`knee_${side}`, 0, 0, 0, 0.033 * H, this.materials.clothDark);
      limbFor(`shoulder_${side}`, `elbow_${side}`, BODY_RADII[`shoulder_${side}`], this.materials.cloth);
      limbFor(`elbow_${side}`, `wrist_${side}`, BODY_RADII[`elbow_${side}`], this.materials.skin);
      // Hand: small flattened ellipsoid.
      const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), this.materials.skin);
      hand.scale.set(0.024 * H, 0.05 * H, 0.032 * H);
      hand.position.set(0, -0.05 * H, 0);
      hand.castShadow = true;
      this.nodes[`wrist_${side}`].add(hand);
      this.layerMeshes.body.push(hand);
      // Foot: bare ankle, then a shaped shoe — rounded heel, arched instep,
      // toe box. Sole grazes y = -0.039H to match FOOT_CORNERS.
      this.#bodyBall(`ankle_${side}`, 0, -0.006 * H, 0, 0.016 * H, this.materials.skin);
      this.#bodyBall(`ankle_${side}`, 0, -0.020 * H, -0.028 * H, 0.019 * H, this.materials.shoe)
        .scale.set(1.2, 0.95, 1.5);
      this.#bodyBall(`ankle_${side}`, 0, -0.016 * H, 0.024 * H, 0.019 * H, this.materials.shoe)
        .scale.set(1.4, 1.15, 2.5);
      this.#bodyBall(`ankle_${side}`, 0, -0.022 * H, 0.064 * H, 0.015 * H, this.materials.shoe)
        .scale.set(1.9, 1.1, 2.1);
      // Toe cap rides the toes joint so demi-pointe and toe curls read in
      // body view; its underside grazes the toes-local sole plane (y=-0.009H)
      // and its tail tucks under the toe box above.
      this.#bodyBall(`toes_${side}`, 0, 0.0027 * H, 0.021 * H, 0.013 * H, this.materials.shoe)
        .scale.set(2.2, 0.9, 1.9);
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

  // Tapered limb from a lathe profile of [t, r] pairs (t: 0 at a → 1 at b).
  #bodyLimbProfile(nodeName, a, b, profile, material) {
    const H = this.height;
    const len = a.distanceTo(b);
    const pts = profile.map(([t, r]) => new THREE.Vector2(r * H, (t - 0.5) * len));
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 16), material);
    this.#alignY(mesh, a, b);
    mesh.castShadow = true;
    this.nodes[nodeName].add(mesh);
    this.layerMeshes.body.push(mesh);
    return mesh;
  }

  #bodyBall(nodeName, x, y, z, radius, material) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    this.nodes[nodeName].add(mesh);
    this.layerMeshes.body.push(mesh);
    return mesh;
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

  // ------------------------------------------------------------- highlight
  // Highlight the given body parts (Set of BODY_PARTS ids): their meshes get
  // an emissive glow, everything else goes ghost-translucent. Works on every
  // layer because materials are swapped per mesh, not per layer.

  #highlightVariant(base, kind) {
    this._hlCache ??= new Map();
    let pair = this._hlCache.get(base);
    if (!pair) {
      const lit = base.clone();
      lit.emissive = new THREE.Color(0xcc8a22);
      lit.emissiveIntensity = 0.45;
      lit.transparent = false;
      lit.opacity = 1;
      const dim = base.clone();
      dim.transparent = true;
      dim.opacity = 0.13;
      dim.depthWrite = false;
      pair = { lit, dim };
      this._hlCache.set(base, pair);
    }
    return pair[kind];
  }

  setHighlight(parts) {
    this.highlightParts = parts && parts.size ? new Set(parts) : null;
    this.#applyHighlight();
  }

  #applyHighlight() {
    const parts = this.highlightParts;
    this.group.traverse((o) => {
      if (!o.isMesh || o.userData.isPick) return;
      o.userData.baseMaterial ??= o.material;
      const base = o.userData.baseMaterial;
      if (!parts) {
        o.material = base;
        return;
      }
      let n = o;
      while (n && n.userData.jointName === undefined) n = n.parent;
      const part = n ? PART_OF_NODE[n.userData.jointName] : null;
      o.material = this.#highlightVariant(base, parts.has(part) ? 'lit' : 'dim');
    });
  }

  setLayers({ skeleton, body, muscle }) {
    this.layers = { skeleton, body, muscle };
    for (const m of this.layerMeshes.skeleton) m.visible = skeleton;
    for (const m of this.layerMeshes.body) m.visible = body;
    for (const m of this.layerMeshes.muscle) m.visible = muscle;
    // Joint spheres are click targets, not anatomy: keep them faint in skeleton
    // view (the bones already show the joints) and invisible-but-clickable
    // otherwise. Raycasting ignores opacity, so picking is unaffected.
    for (const s of this.pickSpheres) {
      s.material.opacity = skeleton ? 0.22 : 0;
      s.material.depthWrite = false;
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

  // Lowest floor-relevant point of the body: foot sole corners plus every
  // joint padded by its flesh clearance.
  lowestPointY() {
    this.group.updateMatrixWorld(true);
    const H = this.height;
    let minY = Infinity;
    for (const [nodeName, corners] of [
      ['ankle_L', FOOT_CORNERS_L], ['ankle_R', FOOT_CORNERS_R],
      ['toes_L', TOE_CORNERS_L], ['toes_R', TOE_CORNERS_R],
    ]) {
      const node = this.nodes[nodeName];
      for (const [x, y, z] of corners) {
        _floorPt.set(x * H, y * H, z * H);
        node.localToWorld(_floorPt);
        if (_floorPt.y < minY) minY = _floorPt.y;
      }
    }
    for (const def of JOINTS) {
      this.nodes[def.name].getWorldPosition(_floorPt);
      const y = _floorPt.y - (FLOOR_CLEARANCE[def.name] ?? 0.02) * H;
      if (y < minY) minY = y;
    }
    return minY;
  }

  // Keep the body out of the floor: lift the root if anything is below it,
  // and settle back down only by undoing a previous lift (group.position.y
  // is 0 unless collision or a closed-chain edit moved it).
  clampToFloor() {
    const minY = this.lowestPointY();
    if (minY < -1e-4) {
      this.group.position.y -= minY;
      this.group.updateMatrixWorld(true);
    } else if (this.group.position.y > 1e-4 && minY > 1e-4) {
      this.group.position.y -= Math.min(minY, this.group.position.y);
      this.group.updateMatrixWorld(true);
    }
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
    this.#applyHighlight();
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.group.clear();
  }
}
