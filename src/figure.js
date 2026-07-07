import * as THREE from 'three';
import {
  JOINTS, JOINT_BY_NAME, DEG, clampAngle, FOOT_CORNERS_L, FOOT_CORNERS_R,
  TOE_CORNERS_L, TOE_CORNERS_R, PART_OF_NODE,
} from './skeletonDef.js';
import { buildSkeleton, buildMuscles } from './anatomy.js';
import { LIMB_BASES, reverseWinding, BODY_RETARGET, normBoneName } from './skeletonMesh.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _floorPt = new THREE.Vector3();

// Centroid and smallest-variance axis (≈ the flat normal of a slab-like cloud,
// e.g. a palm or a sole) of a set of points, via power iteration on
// (trace·I − covariance): the dominant eigenvector of that shifted matrix is
// the *smallest* eigenvector of the covariance. Used to orient the skeletal
// hand/foot onto the body (see Figure.#endpointAlignR).
function pcaPlaneNormal(pts) {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const tr = xx + yy + zz;
  const M = [[tr - xx, -xy, -xz], [-xy, tr - yy, -yz], [-xz, -yz, tr - zz]];
  const b = new THREE.Vector3(0.3, 1, -0.2).normalize();
  for (let k = 0; k < 48; k++) {
    const nx = M[0][0] * b.x + M[0][1] * b.y + M[0][2] * b.z;
    const ny = M[1][0] * b.x + M[1][1] * b.y + M[1][2] * b.z;
    const nz = M[2][0] * b.x + M[2][1] * b.y + M[2][2] * b.z;
    b.set(nx, ny, nz).normalize();
  }
  return { centroid: c, normal: b };
}

// Right-handed orthonormal basis matrix from a primary axis and an approximate
// second axis: columns [primary, normal×primary, normal] after making the
// normal orthogonal to the primary. Rotating one such basis onto another gives
// the frame-to-frame rotation.
function frameBasis(primary, approxNormal) {
  const e1 = primary.clone().normalize();
  const e3 = approxNormal.clone().addScaledVector(e1, -approxNormal.dot(e1)).normalize();
  const e2 = new THREE.Vector3().crossVectors(e3, e1).normalize();
  return new THREE.Matrix4().makeBasis(e1, e2, e3);
}

// Scratch objects for per-frame muscle skinning (updateMuscleSkin), reused so
// the hot loop allocates nothing.
const _gInv = new THREE.Matrix4();
const _dA = new THREE.Matrix4();
const _dB = new THREE.Matrix4();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _tA = new THREE.Vector3();
const _tB = new THREE.Vector3();
const _scl = new THREE.Vector3();

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

// Finger curl for a clasped hand (the embrace's open-side hold): per-phalanx
// bend in radians at full curl, proximal→distal; the thumb only closes
// lightly around the partner's hand. Applied to the clothed avatar's Biped
// finger bones, which bend about their local Z axis.
const FINGER_CURL = [0.75, 0.9, 0.6];
const THUMB_CURL = [0.15, 0.45, 0.35];
const FINGER_AXIS = new THREE.Vector3(0, 0, 1);
const _fingerQ = new THREE.Quaternion();

export class Figure {
  constructor({ name, height = 1.72, mass = 70, color = 0x4d8fd1, skin = 0xd9a68a, skeleton = null, muscles = null, body = null, heelRise = 0 }) {
    this.name = name;
    this.height = height;
    this.mass = mass;
    // Heel height as a fraction of stature: raises the ankle (and everything the
    // heel lifts) so a heeled avatar's foot sits natively on the floor instead
    // of being squashed flat, and the skeletal foot pitches to match.
    this.heelRise = heelRise;
    this.color = color;
    this.skin = skin;
    this.skeletonMesh = skeleton; // parsed atlas bones, or null → procedural bones
    this.muscleMesh = muscles; // parsed atlas muscles (needs skeleton), or null → procedural
    this.bodyMesh = body; // parsed clothed avatar (skinned), or null → procedural mannequin

    this.group = new THREE.Group(); // root: position (x,z) + facing (rotation.y)
    this.group.userData.figure = this;
    this.nodes = {};
    this.pickSpheres = [];
    this.layerMeshes = { skeleton: [], body: [], muscle: [] };
    this.jointSphereByName = {};
    // Bi-articular muscles that skin between two joints (see updateMuscleSkin).
    this._skinMuscles = [];

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

    // Joint hierarchy. A heeled figure lifts its ankles (and, riding them, the
    // toes) so the raised heel — not a squashed-flat sole — is what stands on
    // the floor; the extra height propagates up the closed leg chain.
    this._heelLift = this.heelRise * H;
    for (const def of JOINTS) {
      const node = new THREE.Object3D();
      node.name = `${this.name}:${def.name}`;
      node.position.set(def.offset[0] * H, def.offset[1] * H, def.offset[2] * H);
      if (this._heelLift && (def.name === 'ankle_L' || def.name === 'ankle_R')) {
        node.position.y += this._heelLift; // toes/toe are children → ride along
      }
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

    // --- Body layer: imported clothed avatar if available, else the
    // procedural mannequin volumes ---
    if (this.bodyMesh) this.#buildMeshBody();
    else this.#buildBody();
    // Muscle layer: imported atlas muscles (share the skeleton's frame, so they
    // need it too), else the procedural bellies in anatomy.js.
    if (this.muscleMesh && this.skeletonMesh) this.#buildMeshMuscles();
    else buildMuscles(this);
    // De-splay the skeletal hands/feet onto the clothed body's orientation so
    // the three layers coincide at the extremities (see #alignEndpointGeometry).
    if (this.skeletonMesh && this.bodyMesh) this.#alignEndpointGeometry();
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
  // side belly is placed and also mirrored to the left; muscles stay individual
  // (not merged) so each keeps its name and a distinct tint. A belly that only
  // rides one bone is parented rigidly to its joint node; one that crosses an
  // articulated joint (has an `insert`) is skinned between its two joints so it
  // stretches and bends as they move (see updateMuscleSkin).
  #buildMeshMuscles() {
    const { atlasMinY, atlasHeight } = this.skeletonMesh;
    const s = this.height / atlasHeight;
    this.group.updateMatrixWorld(true);
    const settle = new THREE.Matrix4().makeTranslation(0, -atlasMinY * s, 0);
    const Tpos = settle.clone().multiply(new THREE.Matrix4().makeScale(s, s, s));
    const Tneg = settle.clone().multiply(new THREE.Matrix4().makeScale(-s, s, s)); // mirror
    // Resolve a limb base to a concrete side; central nodes pass through.
    const resolve = (base, side) => (LIMB_BASES.has(base) ? `${base}_${side}` : base);

    this.muscleMesh.muscles.forEach((m, i) => {
      const material = i % 2 ? this.materials.muscleA : this.materials.muscleB;
      // Every shipped belly is right-side: place it (Tpos) and mirror to the
      // left (Tneg). The node side follows the copy's side.
      for (const [side, T, mirror] of [['R', Tpos, false], ['L', Tneg, true]]) {
        const nodeName = resolve(m.node, side);
        const node = this.nodes[nodeName];
        if (!node) continue;
        const insNode = m.insert ? this.nodes[resolve(m.insert, side)] : null;
        if (insNode) {
          // Skinned: bake into figure-local space and let updateMuscleSkin blend
          // each vertex between the two joints every frame.
          const g = m.geometry.clone();
          g.applyMatrix4(T);
          if (mirror) reverseWinding(g);
          this.#addSkinnedMuscle(g, node, insNode, material, m.label, nodeName);
        } else {
          // Rigid: bake into the node's local frame and hang it there.
          const g = m.geometry.clone();
          const X = node.matrixWorld.clone().invert().multiply(this.group.matrixWorld).multiply(T);
          g.applyMatrix4(X);
          if (mirror) reverseWinding(g);
          const mesh = new THREE.Mesh(g, material);
          mesh.userData.muscleName = m.label;
          this.addMesh(nodeName, mesh, 'muscle', true);
        }
      }
    });
  }

  // Register a bi-articular belly for two-bone skinning. `g` is baked in
  // figure-local (group) space. Anatomically a muscle's flesh is rigid on the
  // bone it lies on and only its tendon crosses a joint, so we split the weights
  // *at the articulating joint* the muscle spans — the deeper (child) of its two
  // nodes — rather than blending along the whole length. Flesh on the distal
  // side of that joint follows the child bone; flesh on the proximal side
  // follows the parent. The split is measured along the muscle's home-bone axis
  // (the bone its belly rides), which stays well-defined even when the two joint
  // pivots sit close together (adductors, lats) — a plain pivot-to-pivot ramp
  // degenerates there and lets the whole belly swing. Result: bellies stay
  // welded to their bone and only the short crossing band deforms. Each frame
  // updateMuscleSkin re-blends the baked positions/normals by that weight. The
  // mesh hangs off `group` (not a joint node) so its own frame never moves — all
  // motion comes through the two joints, keeping the skin correct even as the
  // whole dancer translates or turns.
  #addSkinnedMuscle(g, nodeA, nodeB, material, label, originNode) {
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const count = pos.count;
    const gInv = _gInv.copy(this.group.matrixWorld).invert();
    const a = new THREE.Vector3().setFromMatrixPosition(nodeA.matrixWorld).applyMatrix4(gInv);
    const b = new THREE.Vector3().setFromMatrixPosition(nodeB.matrixWorld).applyMatrix4(gInv);
    // The muscle spans the deeper (child) of its two joints. Pick the crossed
    // joint pivot, the home-bone axis to measure along, and how the distal-side
    // weight maps onto "blend toward nodeB".
    const child = this.#deeperJointNode(nodeA, nodeB);
    let cross, home, distalIsB;
    if (child === nodeB) {
      cross = b;                                     // belly on nodeA's bone (a→b)
      home = new THREE.Vector3().subVectors(b, a);
      distalIsB = true;                              // past the joint → nodeB
    } else {
      cross = a;                                     // belly on nodeA's own bone
      home = this.#distalBoneDir(nodeA, gInv) || new THREE.Vector3().subVectors(a, b);
      distalIsB = false;                             // past the joint → nodeA
    }
    const boneLen = Math.max(home.length(), 1e-6);
    home.multiplyScalar(1 / boneLen);
    // Pass 1: signed distance of each vertex from the crossed joint along the
    // home-bone axis (s > 0 on the distal / child-bone side), and how far the
    // muscle reaches on each side.
    const sArr = new Float32Array(count);
    let sMin = Infinity, sMax = -Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const s = v.fromBufferAttribute(pos, i).sub(cross).dot(home);
      sArr[i] = s;
      if (s < sMin) sMin = s;
      if (s > sMax) sMax = s;
    }
    // Transition half-width: a fraction of the bone, but never wider than the
    // shorter side reaches, so the short tendon side saturates to full weight
    // (otherwise it never fully commits to its bone and tears away at the joint).
    let band = 0.16 * boneLen;
    if (sMax > 1e-5) band = Math.min(band, 0.85 * sMax);
    if (sMin < -1e-5) band = Math.min(band, -0.85 * sMin);
    band = Math.max(band, 1e-4);
    // Pass 2: smoothstep across the joint, mapped to "blend toward nodeB".
    const weight = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const t = THREE.MathUtils.clamp((sArr[i] + band) / (2 * band), 0, 1);
      const distal = t * t * (3 - 2 * t);
      weight[i] = distalIsB ? distal : 1 - distal;
    }
    const bindPos = new Float32Array(pos.array);
    const bindNrm = new Float32Array(nrm.array);
    // Inverse of each joint's figure-local matrix at bind: brings a baked vertex
    // into the joint's frame so the joint's later motion can carry it.
    const invA = new THREE.Matrix4().multiplyMatrices(gInv, nodeA.matrixWorld).invert();
    const invB = new THREE.Matrix4().multiplyMatrices(gInv, nodeB.matrixWorld).invert();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    mesh.frustumCulled = false; // vertices leave the baked bounds as joints move
    mesh.userData.muscleName = label;
    mesh.userData.skinNode = originNode; // highlight groups it with this joint
    this.group.add(mesh);
    this.layerMeshes.muscle.push(mesh);
    this._skinMuscles.push({ mesh, nodeA, nodeB, weight, bindPos, bindNrm, invA, invB });
    return mesh;
  }

  // The deeper (child) of two hierarchy-adjacent joint nodes — the joint the
  // muscle spanning them actually crosses.
  #deeperJointNode(nodeA, nodeB) {
    for (let n = nodeA.parent; n; n = n.parent) if (n === nodeB) return nodeA;
    return nodeB;
  }

  // Figure-local direction from a joint to its distal child joint(s), i.e. along
  // the bone it carries; null if it has no joint children. Used as the home-bone
  // axis when a muscle's belly rides this joint's own bone.
  #distalBoneDir(node, gInv) {
    const here = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld).applyMatrix4(gInv);
    const acc = new THREE.Vector3();
    let n = 0;
    for (const ch of node.children) {
      if (!ch.userData || !ch.userData.jointName) continue;
      acc.add(new THREE.Vector3().setFromMatrixPosition(ch.matrixWorld).applyMatrix4(gInv));
      n++;
    }
    return n ? acc.multiplyScalar(1 / n).sub(here) : null;
  }

  // Re-skin every bi-articular muscle from its two joints' current transforms.
  // Called each frame while the muscle layer is visible (skipped otherwise, so
  // it costs nothing in the skeleton/body views). Uses dual-quaternion skinning
  // (DQS), not linear blend: the two joint deltas are rigid transforms, so
  // blending them as dual quaternions rotates each vertex along the shortest
  // arc and preserves volume. Plain linear blending collapses the belly toward
  // the joint axis at deep bends ("candy-wrapper"), which made multi-joint
  // muscles sink through the bone or pop off. Figure-local space; assumes
  // group.matrixWorld is already current.
  updateMuscleSkin() {
    if (!this._skinMuscles.length || !this.layers?.muscle || !this.group.visible) return;
    const gInv = _gInv.copy(this.group.matrixWorld).invert();
    for (const sm of this._skinMuscles) {
      // Rigid delta of each joint since bind, in figure-local space.
      const dA = _dA.multiplyMatrices(gInv, sm.nodeA.matrixWorld).multiply(sm.invA);
      const dB = _dB.multiplyMatrices(gInv, sm.nodeB.matrixWorld).multiply(sm.invB);
      dA.decompose(_tA, _qA, _scl);
      dB.decompose(_tB, _qB, _scl);
      // Unit dual quaternion for each delta: real = rotation, dual encodes the
      // translation as dual = 0.5 * (t as pure quat) * rotation.
      const arx = _qA.x, ary = _qA.y, arz = _qA.z, arw = _qA.w;
      let brx = _qB.x, bry = _qB.y, brz = _qB.z, brw = _qB.w;
      const adx = 0.5 * (_tA.x * arw + _tA.y * arz - _tA.z * ary);
      const ady = 0.5 * (-_tA.x * arz + _tA.y * arw + _tA.z * arx);
      const adz = 0.5 * (_tA.x * ary - _tA.y * arx + _tA.z * arw);
      const adw = 0.5 * (-_tA.x * arx - _tA.y * ary - _tA.z * arz);
      let bdx = 0.5 * (_tB.x * brw + _tB.y * brz - _tB.z * bry);
      let bdy = 0.5 * (-_tB.x * brz + _tB.y * brw + _tB.z * brx);
      let bdz = 0.5 * (_tB.x * bry - _tB.y * brx + _tB.z * brw);
      let bdw = 0.5 * (-_tB.x * brx - _tB.y * bry - _tB.z * brz);
      // Blend the two along the shortest arc: flip B into A's hemisphere.
      if (arx * brx + ary * bry + arz * brz + arw * brw < 0) {
        brx = -brx; bry = -bry; brz = -brz; brw = -brw;
        bdx = -bdx; bdy = -bdy; bdz = -bdz; bdw = -bdw;
      }
      const geom = sm.mesh.geometry;
      const parr = geom.attributes.position.array;
      const narr = geom.attributes.normal.array;
      const { bindPos, bindNrm, weight } = sm;
      for (let i = 0, j = 0; i < weight.length; i++, j += 3) {
        const wb = weight[i];
        const wa = 1 - wb;
        // Blend real + dual parts, then renormalize the real part.
        let rx = arx * wa + brx * wb, ry = ary * wa + bry * wb;
        let rz = arz * wa + brz * wb, rw = arw * wa + brw * wb;
        let dx = adx * wa + bdx * wb, dy = ady * wa + bdy * wb;
        let dz = adz * wa + bdz * wb, dw = adw * wa + bdw * wb;
        const inv = 1 / (Math.hypot(rx, ry, rz, rw) || 1);
        rx *= inv; ry *= inv; rz *= inv; rw *= inv;
        dx *= inv; dy *= inv; dz *= inv; dw *= inv;
        // Translation = 2 * (dual * conjugate(real)), vector part.
        const tx = 2 * (rw * dx - rx * dw + ry * dz - rz * dy);
        const ty = 2 * (rw * dy - ry * dw + rz * dx - rx * dz);
        const tz = 2 * (rw * dz - rz * dw + rx * dy - ry * dx);
        // Rotate the bound position by the blended real quaternion, add t.
        const px = bindPos[j], py = bindPos[j + 1], pz = bindPos[j + 2];
        let ix = rw * px + ry * pz - rz * py;
        let iy = rw * py + rz * px - rx * pz;
        let iz = rw * pz + rx * py - ry * px;
        let iw = -rx * px - ry * py - rz * pz;
        parr[j] = ix * rw + iw * -rx + iy * -rz - iz * -ry + tx;
        parr[j + 1] = iy * rw + iw * -ry + iz * -rx - ix * -rz + ty;
        parr[j + 2] = iz * rw + iw * -rz + ix * -ry - iy * -rx + tz;
        // Rotate the bound normal by the same quaternion (no translation).
        const nx = bindNrm[j], ny = bindNrm[j + 1], nz = bindNrm[j + 2];
        ix = rw * nx + ry * nz - rz * ny;
        iy = rw * ny + rz * nx - rx * nz;
        iz = rw * nz + rx * ny - ry * nx;
        iw = -rx * nx - ry * ny - rz * nz;
        narr[j] = ix * rw + iw * -rx + iy * -rz - iz * -ry;
        narr[j + 1] = iy * rw + iw * -ry + iz * -rx - ix * -rz;
        narr[j + 2] = iz * rw + iw * -rz + ix * -ry - iy * -rx;
      }
      geom.attributes.position.needsUpdate = true;
      geom.attributes.normal.needsUpdate = true;
    }
  }

  // Estimate our limb joints' positions in the *atlas* rest pose from the loaded
  // skeleton bones, so the clothed body can be retargeted onto the same pose the
  // skeleton and muscle layers show. Those layers render the atlas rest (arms
  // slightly abducted, hands/feet splayed out); the rig's own rest is
  // arms-straight-down, so without this the bones and muscle poke ~10 cm outside
  // the clothed skin at the hands. Each joint is located where two adjacent bone
  // clusters meet — the mean of the child cluster's vertices nearest the parent
  // cluster's centroid — which is robust regardless of how the limb hangs.
  // Endpoints (hand, toe) have no cluster of their own, so they take the far tip
  // of the distal cluster. Returns a Map of joint name → figure-local Vector3
  // (empty if no skeleton is loaded, in which case the body falls back to the
  // rig rest). Uses the same scale/settle/mirror as #buildMeshSkeleton's bake.
  #atlasLimbRest() {
    const out = new Map();
    if (!this.skeletonMesh) return out;
    const { bones, atlasMinY, atlasHeight } = this.skeletonMesh;
    const s = this.height / atlasHeight;
    const settleY = -atlasMinY * s;
    const verts = new Map(); // node name → [Vector3, …] in figure-local atlas space
    const gather = (name, geom, mirror) => {
      let a = verts.get(name); if (!a) { a = []; verts.set(name, a); }
      const p = geom.attributes.position;
      for (let i = 0; i < p.count; i += 3) { // sampled: joint estimates don't need every vert
        const x = p.getX(i) * s * (mirror ? -1 : 1);
        a.push(new THREE.Vector3(x, p.getY(i) * s + settleY, p.getZ(i) * s));
      }
    };
    for (const b of bones) {
      const isLimb = LIMB_BASES.has(b.node);
      if (b.paired && isLimb) { gather(`${b.node}_R`, b.geometry, false); gather(`${b.node}_L`, b.geometry, true); }
      else if (b.paired) { gather(b.node, b.geometry, false); gather(b.node, b.geometry, true); }
      else gather(b.node, b.geometry, false);
    }
    const centroid = (a) => a.reduce((c, v) => c.add(v), new THREE.Vector3()).multiplyScalar(1 / a.length);
    // Mean of the K cluster verts nearest (or farthest) from a reference point.
    const extremeMean = (a, ref, frac, farthest) => {
      const scored = a.map((v) => [v.distanceToSquared(ref), v]);
      scored.sort((x, y) => (farthest ? y[0] - x[0] : x[0] - y[0]));
      const k = Math.max(1, Math.floor(scored.length * frac));
      const c = new THREE.Vector3();
      for (let i = 0; i < k; i++) c.add(scored[i][1]);
      return c.multiplyScalar(1 / k);
    };
    const PARENT = { shoulder: 'chest', elbow: 'shoulder', wrist: 'elbow', hip: 'pelvis', knee: 'hip', ankle: 'knee', toes: 'ankle' };
    for (const side of ['_L', '_R']) {
      for (const [base, parBase] of Object.entries(PARENT)) {
        const a = verts.get(`${base}${side}`);
        if (!a || !a.length) continue;
        const par = verts.get(LIMB_BASES.has(parBase) ? `${parBase}${side}` : parBase);
        out.set(`${base}${side}`, par && par.length ? extremeMean(a, centroid(par), 0.05, false) : centroid(a));
      }
      const wrist = verts.get(`wrist${side}`), elbow = verts.get(`elbow${side}`);
      if (wrist && elbow) out.set(`hand${side}`, extremeMean(wrist, centroid(elbow), 0.03, true));
      const toes = verts.get(`toes${side}`), ankle = verts.get(`ankle${side}`);
      if (toes && ankle) out.set(`toe${side}`, extremeMean(toes, centroid(ankle), 0.03, true));
    }
    return out;
  }

  // Attach an imported clothed avatar (Microsoft Rocketbox: one skinned mesh
  // on a 3ds Max Biped rig, in bind pose) by re-parenting its bones onto our
  // joint nodes — the same idea as the skeleton/muscle bake, but keeping the
  // mesh's own skin weights so the surface deforms smoothly at every joint.
  //
  // For each bone in BODY_RETARGET we build a constant local matrix under its
  // target joint node: snap the bone origin to the joint, rotate its bind
  // orientation by the shortest arc that aligns its bind bone direction with
  // our rest segment direction (the bind pose is a near-A-pose; our rest is
  // arms-down, so this also drops the arms), and scale — uniformly by
  // figure/avatar height, plus axially so long bones reach the child joint,
  // plus a world-Y "squash" on the feet so shoe soles (heels included) graze
  // y = 0 at rest instead of sinking through the floor. Unmapped bones
  // (fingers, face, clavicles, skirt helpers) keep their original local
  // transform and simply ride their re-parented ancestor. The skinned mesh
  // itself hangs off `group` in the default 'attached' bind mode, which
  // cancels the mesh's own transform — every motion comes through the bones,
  // on the GPU, with no per-frame CPU work.
  #buildMeshBody() {
    const H = this.height;
    const src = this.bodyMesh;
    const s0 = H / src.height;

    // Our joints' rest positions in figure-local space (rest rotations are
    // all identity, so rest world = accumulated offsets — no scene reads).
    const rest = {};
    for (const def of JOINTS) {
      const p = def.parent ? rest[def.parent].clone() : new THREE.Vector3();
      rest[def.name] = p.add(new THREE.Vector3(...def.offset).multiplyScalar(H));
    }
    // The heel lifts the ankle and everything riding it; mirror the node-build
    // lift here so rest/target/jointY agree with the actual foot node heights.
    const HEEL_NODES = new Set(['ankle_L', 'ankle_R', 'toes_L', 'toes_R', 'toe_L', 'toe_R']);
    if (this._heelLift) for (const n of HEEL_NODES) rest[n].y += this._heelLift;
    // Retarget onto the *atlas* rest pose where it's known (limb joints), so the
    // clothed body coincides with the skeleton/muscle layers; the torso and any
    // joint the atlas can't locate fall back to the rig rest. `target` is the
    // position each bone is snapped/aligned to; the offset from its rig node is
    // baked into the bone's local matrix so posing still pivots about the node.
    const atlas = this.#atlasLimbRest();
    const target = (name) => {
      const p = atlas.get(name) || rest[name];
      return this._heelLift && HEEL_NODES.has(name) && atlas.has(name)
        ? p.clone().setY(p.y + this._heelLift) : p;
    };

    const avatar = cloneSkinned(src.scene);
    avatar.updateMatrixWorld(true);

    // Bones by normalized name, and each bone's bind world matrix. The scene
    // is loaded in bind pose, so node matrixWorld *is* the Y-up bind transform.
    // (Don't invert the inverse-bind matrices instead: those live in the
    // skinned mesh's Z-up local frame, not scene space.)
    const boneByName = new Map();
    avatar.traverse((o) => {
      if (o.isBone || normBoneName(o.name).startsWith('bip01')) boneByName.set(normBoneName(o.name), o);
    });
    const bindWorld = new Map();
    for (const b of boneByName.values()) bindWorld.set(b, b.matrixWorld.clone());
    const bindPos = (bone) => new THREE.Vector3().setFromMatrixPosition(bindWorld.get(bone));

    // Biped side letter → our joint suffix, resolved by bind world position so
    // a mirrored export still lands on the correct side.
    let sideFor = { l: '_L', r: '_R' };
    const lThigh = boneByName.get('bip01lthigh');
    if (lThigh && (bindPos(lThigh).x > 0) !== (rest.hip_L.x > 0)) sideFor = { l: '_R', r: '_L' };

    // Expand the retarget table to both sides and resolve alignment rotations
    // (inherit entries reuse an earlier bone's rotation, e.g. foot ← calf).
    const plans = new Map(); // bone object → plan
    const alignR = new Map(); // bone name (expanded) → THREE.Quaternion
    for (const s of ['l', 'r']) {
      for (const tpl of BODY_RETARGET) {
        const sided = tpl.bone.includes('S'); // side placeholder
        if (!sided && s === 'r') continue; // central bones: process once
        const sub = (name) => name && name.replace('S', s);
        const suffix = sided ? sideFor[s] : '';
        const boneName = sub(tpl.bone);
        const jointName = `${tpl.joint}${suffix}`;
        const bone = boneByName.get(boneName);
        const node = this.nodes[jointName];
        if (!bone || !node) continue;
        const q = bindPos(bone);
        const rotBind = new THREE.Quaternion();
        bindWorld.get(bone).decompose(new THREE.Vector3(), rotBind, new THREE.Vector3());
        let R = new THREE.Quaternion();
        let axialLen = null; // [ourLen, bindLen] when axially stretched
        if (tpl.dirBone && boneByName.get(sub(tpl.dirBone))) {
          const dA = bindPos(boneByName.get(sub(tpl.dirBone))).sub(q);
          const dirKey = rest[`${tpl.dirJoint}${suffix}`] ? `${tpl.dirJoint}${suffix}` : tpl.dirJoint;
          const dJ = target(dirKey).clone().sub(target(jointName));
          if (tpl.axial) axialLen = [dJ.length(), dA.length()];
          R.setFromUnitVectors(dA.normalize(), dJ.normalize());
        } else if (tpl.inherit) {
          R = (alignR.get(sub(tpl.inherit)) || new THREE.Quaternion()).clone();
        }
        alignR.set(boneName, R);
        // Offset from the rig node to the atlas joint the bone snaps to (zero for
        // joints left on the rig rest, e.g. the torso).
        const originDelta = target(jointName).clone().sub(rest[jointName]);
        plans.set(bone, { node, jointName, q, rotBind, R, axialLen, originDelta, jointY: target(jointName).y, squash: !!tpl.squash });
      }
    }

    // Apply: constant local matrix under the joint node.
    const m = new THREE.Matrix4();
    this.jointBone = {}; // retargeted Biped bone now driving each joint (for endpoint alignment)
    for (const [bone, p] of plans) {
      this.jointBone[p.jointName] = bone;
      const sx = p.axialLen ? p.axialLen[0] / Math.max(p.axialLen[1], 1e-6) : s0;
      const local = new THREE.Matrix4()
        .compose(new THREE.Vector3(), p.R.clone().multiply(p.rotBind), new THREE.Vector3(sx, s0, s0));
      if (p.squash && p.q.y * s0 > 1e-4) {
        // Vertical squash so the sole reaches exactly y = 0 at rest: the bind
        // sole sits q.y below the bone; our joint sits jointY above the floor.
        // A heeled figure raises its ankle to the shoe's natural sole depth, so
        // lam → 1 and the heel is preserved instead of flattened.
        const lam = THREE.MathUtils.clamp(p.jointY / (p.q.y * s0), 0.3, 1);
        local.premultiply(m.makeScale(1, lam, 1));
      }
      local.setPosition(p.originDelta); // snap origin to the atlas joint (after squash)
      p.node.add(bone);
      bone.matrixAutoUpdate = false;
      bone.matrix.copy(local);
    }

    // Keep handles to the (unmapped) Biped finger bones riding each hand so
    // the embrace can close a clasped hand's fingers (setFingerCurl).
    this.fingerBones = { L: [], R: [] };
    for (const [bone, p] of plans) {
      if (!p.jointName.startsWith('wrist_')) continue;
      const side = p.jointName.slice(-1);
      bone.traverse((o) => {
        const m = normBoneName(o.name).match(/finger(\d)(\d*)$/);
        if (!m) return;
        this.fingerBones[side].push({
          bone: o, rest: o.quaternion.clone(), digit: +m[1], seg: m[2] ? +m[2] : 0,
        });
      });
    }

    // The skinned meshes themselves: identity bind under `group` ('attached'
    // mode divides the mesh's own world transform back out, so parenting is
    // only for visibility/layer bookkeeping).
    avatar.updateMatrixWorld(true);
    const skinnedMeshes = [];
    avatar.traverse((o) => { if (o.isSkinnedMesh) skinnedMeshes.push(o); });
    for (const o of skinnedMeshes) { // re-parent after the walk, not during
      o.bind(o.skeleton, new THREE.Matrix4());
      o.frustumCulled = false; // posed verts leave the bind-pose bounds
      o.castShadow = !o.material.transparent; // hair cards would cast solid blobs
      o.userData.noHighlight = true; // one skin, no per-part split (see #applyHighlight)
      this.group.add(o);
      this.layerMeshes.body.push(o);
    }
  }

  // The skeleton/muscle GLBs are frozen in an anatomical reference pose that
  // holds the hands splayed (palm-down, fingers fanned) and the feet turned
  // out; the clothed avatar hangs its hands and feet naturally. So overlaying
  // the layers, the bony hands/feet poke out of the skin (the drift the
  // alignment diagnostic measures). We reconcile them by rotating the *skeleton*
  // hand/foot geometry onto the body's orientation — the body is already the
  // natural pose, so it stays put and the bones come to it ("body conforms to
  // skeleton" was chosen before we saw the skeleton is the splayed one).
  //
  // classifyBone puts the whole hand on the wrist node and the foot on the
  // ankle+toes nodes, each as a merged mesh parented at its joint with an
  // identity local transform, and every rig rest rotation is identity — so the
  // node-local axes equal the figure axes at rest, and a single mesh-local
  // quaternion rotates the geometry about the joint (its node origin) into
  // place. Because the mesh rides the node, the fix holds in every pose.
  #alignEndpointGeometry() {
    this.group.updateMatrixWorld(true);
    const gInv = this.group.matrixWorld.clone().invert();
    // Per endpoint: the skeleton node(s) whose merged mesh we rotate, the joint
    // the rotation pivots about, and the joint base(s) whose geometry defines
    // the endpoint's frame (in both layers). Only the hand uses this whole-frame
    // match: the foot rests on the floor and its flat-bone-vs-heeled-shoe shape
    // mismatch makes a centroid match over-pitch it through the floor. (Pitching
    // the heeled skeletal foot to sit inside the shoe is still TODO — see the
    // heelRise WIP notes.)
    const specs = [
      { rotNodes: ['wrist'], pivot: 'wrist', geomJoints: ['wrist'] },
    ];
    const A = new THREE.Vector3(); const P = new THREE.Vector3(); const off = new THREE.Vector3();
    for (const side of ['_L', '_R']) {
      for (const spec of specs) {
        const R = this.#endpointAlignR(side, spec, gInv);
        if (!R) continue;
        this.nodes[`${spec.pivot}${side}`].getWorldPosition(A).applyMatrix4(gInv);
        for (const base of spec.rotNodes) {
          const nodeName = `${base}${side}`;
          // Rotate this node's geometry about the pivot A. A mesh parented at a
          // node with origin P and identity rest rotation needs a local offset
          // A + R·(P − A) − P so the rotation pivots about A, not about P (zero
          // when the node *is* the pivot, e.g. the wrist/ankle's own mesh).
          this.nodes[nodeName].getWorldPosition(P).applyMatrix4(gInv);
          off.copy(P).sub(A).applyQuaternion(R).add(A).sub(P);
          for (const mesh of this.layerMeshes.skeleton) {
            if (this.#nodeNameOf(mesh) !== nodeName) continue;
            mesh.quaternion.copy(R);
            mesh.position.copy(off);
          }
        }
      }
    }
  }

  // Walk up to the joint node a mesh belongs to (its jointName), or null.
  #nodeNameOf(obj) {
    let n = obj;
    while (n && (!n.userData || n.userData.jointName === undefined)) n = n.parent;
    return n ? n.userData.jointName : null;
  }

  // Rotation (about the joint) mapping the atlas hand/foot geometry onto the
  // clothed body's. Both frames are built the *same way* — from the layer's own
  // vertices — so they are directly comparable: a primary axis (joint→geometry
  // centroid) and a flat-normal (PCA smallest axis, ≈ palm/sole normal). R is
  // then the proper rotation between two orthonormal frames. Measuring the body
  // from its skin (not its bone axes) matters because the hand/foot mesh does
  // not run along its Biped bone's axis. Returns null if either frame is
  // unavailable (e.g. body fell back to the mannequin).
  #endpointAlignR(side, spec, gInv) {
    const jointName = `${spec.pivot}${side}`;
    const jointPos = this.nodes[jointName].getWorldPosition(new THREE.Vector3()).applyMatrix4(gInv);
    // --- skeleton frame from the atlas geometry (figure-local, same scale/
    //     settle/mirror as the bake) ---
    const { atlasMinY, atlasHeight } = this.skeletonMesh;
    const s = this.height / atlasHeight;
    const settleY = -atlasMinY * s;
    const mir = side === '_L' ? -1 : 1;
    const skelPts = [];
    const bases = spec.geomJoints;
    for (const b of this.skeletonMesh.bones) {
      if (!bases.includes(b.node)) continue;
      const p = b.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 1200));
      for (let i = 0; i < p.count; i += step) {
        skelPts.push(new THREE.Vector3(p.getX(i) * s * mir, p.getY(i) * s + settleY, p.getZ(i) * s));
      }
    }
    // --- body frame from the retargeted skin (each vert's dominant bone must
    //     resolve to one of the endpoint's joints) ---
    const wantNodes = new Set(bases.map((base) => `${base}${side}`));
    const bodyPts = [];
    const v = new THREE.Vector3();
    for (const mesh of this.layerMeshes.body) {
      if (!mesh.isSkinnedMesh) continue;
      mesh.updateMatrixWorld(true);
      const si = mesh.geometry.attributes.skinIndex;
      const sw = mesh.geometry.attributes.skinWeight;
      const p = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 4000));
      for (let i = 0; i < p.count; i += step) {
        let bi = si.getX(i), bw = sw.getX(i);
        if (sw.getY(i) > bw) { bw = sw.getY(i); bi = si.getY(i); }
        if (sw.getZ(i) > bw) { bw = sw.getZ(i); bi = si.getZ(i); }
        if (sw.getW(i) > bw) { bw = sw.getW(i); bi = si.getW(i); }
        const bone = mesh.skeleton.bones[bi];
        if (bone && wantNodes.has(this.#nodeNameOf(bone))) bodyPts.push(mesh.getVertexPosition(i, v).clone());
      }
    }
    if (skelPts.length < 8 || bodyPts.length < 8) return null;
    const skel = pcaPlaneNormal(skelPts);
    const bodyF = pcaPlaneNormal(bodyPts);
    const skelPrimary = skel.centroid.clone().sub(jointPos).normalize();
    const bodyPrimary = bodyF.centroid.clone().sub(jointPos).normalize();
    // The PCA normal's sign is arbitrary; point the skeleton's the same way as
    // the body's so R is a rotation, not a rotation composed with a flip.
    if (skel.normal.dot(bodyF.normal) < 0) skel.normal.negate();
    const Ms = frameBasis(skelPrimary, skel.normal);
    const Mb = frameBasis(bodyPrimary, bodyF.normal);
    return new THREE.Quaternion().setFromRotationMatrix(Mb.multiply(Ms.transpose()));
  }

  // Curl one hand's fingers (0 = bind pose, 1 = closed around the partner's
  // hand). Used by the embrace's open-side clasp. Only the clothed avatar has
  // finger bones; the procedural fallback hand is a single ellipsoid, so this
  // is a no-op without a body mesh.
  setFingerCurl(side, curl) {
    if (!this.fingerBones) return;
    for (const f of this.fingerBones[side]) {
      const amt = (f.digit === 0 ? THUMB_CURL : FINGER_CURL)[Math.min(f.seg, 2)];
      f.bone.quaternion.copy(f.rest);
      if (curl * amt) f.bone.quaternion.multiply(_fingerQ.setFromAxisAngle(FINGER_AXIS, curl * amt));
    }
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

    // Head + hair.
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
      if (!parts || o.userData.noHighlight) {
        // The imported body avatar is one continuous skin — it can't light up
        // a single part, so it keeps its normal look during highlights (the
        // skeleton/muscle layers carry the emphasis).
        o.material = base;
        return;
      }
      // Skinned muscles hang off the group, not a joint node, so they carry the
      // joint they belong to explicitly; everything else walks up to its node.
      let jointName = o.userData.skinNode;
      if (jointName === undefined) {
        let n = o;
        while (n && n.userData.jointName === undefined) n = n.parent;
        jointName = n ? n.userData.jointName : null;
      }
      const part = jointName ? PART_OF_NODE[jointName] : null;
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
    this.updateMuscleSkin(); // keep bi-articular muscles in step (e.g. ghosts, interp)
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
    this._skinMuscles = [];
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
