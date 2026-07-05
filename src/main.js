import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Figure } from './figure.js';
import { IK_CHAINS, JOINT_BY_NAME, ANCHOR_FOR } from './skeletonDef.js';
import { solveTwoBone, editWithAnchor, pinAnchor, feetToFloor } from './ik.js';
import { balanceReport, coupleReport, footContactsBySide } from './analysis.js';
import { PRESETS } from './presets.js';
import { loadSkeletonBones, loadMuscleMeshes, loadBodyMesh } from './skeletonMesh.js';
import { Embrace } from './embrace.js';
import { resolveBodyCollision, bodyClearance } from './collision.js';
import { initUI } from './ui.js';

// ---------------------------------------------------------------- scene
const container = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x191c22);
scene.fog = new THREE.Fog(0x191c22, 9, 16);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 60);
camera.position.set(1.9, 1.5, 2.7);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.05, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
orbit.maxPolarAngle = Math.PI * 0.55;
orbit.minDistance = 0.8;
orbit.maxDistance = 10;

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3f4a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(3, 5, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -3; sun.shadow.camera.right = 3;
sun.shadow.camera.top = 3; sun.shadow.camera.bottom = -3;
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 12;
sun.shadow.bias = -0.0004;
scene.add(sun);

// Wooden dance floor: procedural plank texture drawn once on a canvas.
function makeWoodTexture(size = 1024, planks = 16) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  let seed = 9;
  const rand = () => { // deterministic so the floor looks the same every load
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const plankH = size / planks;
  for (let row = 0; row < planks; row++) {
    const y = row * plankH;
    let x = -rand() * size * 0.5; // stagger the butt joints per row
    while (x < size) {
      const len = size * (0.45 + rand() * 0.45);
      const light = 33 + rand() * 7;
      const hue = 25 + rand() * 6;
      ctx.fillStyle = `hsl(${hue}, ${36 + rand() * 8}%, ${light}%)`;
      ctx.fillRect(x, y, len, plankH);
      // Grain: faint darker streaks running along the plank.
      for (let g = 0; g < 14; g++) {
        const gy = y + rand() * plankH;
        ctx.strokeStyle = `hsla(${hue - 4}, 45%, ${light - 6 - rand() * 8}%, ${0.10 + rand() * 0.14})`;
        ctx.lineWidth = 0.5 + rand() * 1.2;
        ctx.beginPath();
        ctx.moveTo(x, gy);
        const wob = 2 + rand() * 4;
        ctx.bezierCurveTo(
          x + len * 0.33, gy + (rand() - 0.5) * wob,
          x + len * 0.66, gy + (rand() - 0.5) * wob,
          x + len, gy + (rand() - 0.5) * wob,
        );
        ctx.stroke();
      }
      // Occasional knot.
      if (rand() < 0.2) {
        const kx = x + len * (0.2 + rand() * 0.6);
        const ky = y + plankH * (0.25 + rand() * 0.5);
        ctx.fillStyle = `hsla(${hue - 6}, 40%, ${light - 14}%, 0.45)`;
        ctx.beginPath();
        ctx.ellipse(kx, ky, 2 + rand() * 4, 1.5 + rand() * 2.5, rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      // Butt-joint seam at the end of the board.
      ctx.fillStyle = 'rgba(28, 16, 8, 0.8)';
      ctx.fillRect(x + len - 1, y, 2, plankH);
      x += len;
    }
    // Long seam between plank rows.
    ctx.fillStyle = 'rgba(28, 16, 8, 0.85)';
    ctx.fillRect(0, y - 0.75, size, 1.5);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const woodTex = makeWoodTexture();
woodTex.repeat.set(2, 2); // 8 m diameter → ~25 cm boards
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(4, 64),
  new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.4, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ---------------------------------------------------------------- figures
// Imported anatomical skeleton (CC-BY-SA, see public/models/ATTRIBUTION.md).
// Loaded once and shared; on failure we fall back to the procedural bones.
let skeletonBones = null;
try {
  skeletonBones = await loadSkeletonBones(`${import.meta.env.BASE_URL}models/skeleton.glb`);
} catch (err) {
  console.warn('Skeleton mesh failed to load; using procedural bones.', err);
}

// Imported main-mover muscles (same atlas, so they need the skeleton's scale).
// Loaded only when the skeleton did; on failure we fall back to procedural bellies.
let muscleMeshes = null;
if (skeletonBones) {
  try {
    muscleMeshes = await loadMuscleMeshes(`${import.meta.env.BASE_URL}models/muscles.glb`);
  } catch (err) {
    console.warn('Muscle mesh failed to load; using procedural muscles.', err);
  }
}

// Imported clothed body avatars (Microsoft Rocketbox, MIT). Loaded per role;
// on failure that figure falls back to the procedural mannequin body.
async function tryLoadBody(file) {
  try {
    return await loadBodyMesh(`${import.meta.env.BASE_URL}models/${file}`);
  } catch (err) {
    console.warn(`Body avatar ${file} failed to load; using the mannequin body.`, err);
    return null;
  }
}
const [manBody, womanBody] = await Promise.all([tryLoadBody('man.glb'), tryLoadBody('woman.glb')]);

const leader = new Figure({ name: 'Leader', height: 1.78, mass: 75, color: 0x4d8fd1, skeleton: skeletonBones, muscles: muscleMeshes, body: manBody });
const follower = new Figure({ name: 'Follower', height: 1.65, mass: 60, color: 0xc95f8e, skin: 0xe0b092, skeleton: skeletonBones, muscles: muscleMeshes, body: womanBody });
scene.add(leader.group, follower.group);

// Embrace constraints (open-side hand clasp, close-embrace torso contact),
// re-applied every frame in the loop below.
const embrace = new Embrace(leader, follower);

// -------------------------------------------------------- balance visuals
class BalanceViz {
  constructor(colorHex) {
    this.group = new THREE.Group();
    this.color = new THREE.Color(colorHex);

    this.cogBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 14, 10),
      new THREE.MeshBasicMaterial({ color: colorHex }),
    );
    this.dropLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: colorHex, dashSize: 0.03, gapSize: 0.02, transparent: true, opacity: 0.8 }),
    );
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.02, 0.036, 24),
      new THREE.MeshBasicMaterial({ color: 0x5fce7f, side: THREE.DoubleSide }),
    );
    this.marker.rotation.x = -Math.PI / 2;

    const hullPositions = new Float32Array(48 * 3);
    this.hullGeo = new THREE.BufferGeometry();
    this.hullGeo.setAttribute('position', new THREE.BufferAttribute(hullPositions, 3));
    this.hullLine = new THREE.LineLoop(
      this.hullGeo,
      new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.55 }),
    );

    this.group.add(this.cogBall, this.dropLine, this.marker, this.hullLine);
  }

  update({ cog, hull, margin }) {
    this.cogBall.position.copy(cog);
    const pts = this.dropLine.geometry.attributes.position;
    pts.setXYZ(0, cog.x, cog.y, cog.z);
    pts.setXYZ(1, cog.x, 0.002, cog.z);
    pts.needsUpdate = true;
    this.dropLine.computeLineDistances();
    this.marker.position.set(cog.x, 0.003, cog.z);
    this.marker.material.color.set(margin !== null && margin > 0 ? 0x5fce7f : 0xe0645f);

    const hp = this.hullGeo.attributes.position;
    for (let i = 0; i < hull.length && i < 48; i++) hp.setXYZ(i, hull[i].x, 0.004, hull[i].z);
    hp.needsUpdate = true;
    this.hullGeo.setDrawRange(0, Math.min(hull.length, 48));
    this.hullLine.visible = this.visibleHull !== false && hull.length >= 2;
  }

  setVisible(cogOn, hullOn) {
    this.cogBall.visible = cogOn;
    this.dropLine.visible = cogOn;
    this.marker.visible = cogOn;
    this.visibleHull = hullOn;
    if (!hullOn) this.hullLine.visible = false;
  }
}

const vizLeader = new BalanceViz(0x7fb3e8);
const vizFollower = new BalanceViz(0xe89ab8);
const vizCouple = new BalanceViz(0xffe08a);
scene.add(vizLeader.group, vizFollower.group, vizCouple.group);

// ------------------------------------------------- pose interpolation (A→B)
// Component-wise joint lerp is safe: both endpoints respect the joint limits,
// and each limit interval is convex.
function lerpPose(a, b, t) {
  const joints = {};
  for (const [name, va] of Object.entries(a.joints)) {
    const vb = b.joints[name];
    if (!vb) continue;
    joints[name] = va.map((v, i) => v + (vb[i] - v) * t);
  }
  const qa = new THREE.Quaternion().fromArray(a.quaternion);
  const qb = new THREE.Quaternion().fromArray(b.quaternion);
  return {
    position: a.position.map((v, i) => v + (b.position[i] - v) * t),
    quaternion: qa.slerp(qb, t).toArray(),
    pelvisY: a.pelvisY + (b.pelvisY - a.pelvisY) * t,
    joints,
  };
}

// Floor trace of the three COGs along the A→B movement, vertex-colored by
// balance: the entity's own color while balanced, red where it loses the base.
const trailGroup = new THREE.Group();
scene.add(trailGroup);

function trailLine(pts, baseHex) {
  const pos = new Float32Array(pts.length * 3);
  const col = new Float32Array(pts.length * 3);
  const base = new THREE.Color(baseHex);
  const bad = new THREE.Color(0xe0645f);
  pts.forEach((p, i) => {
    pos.set([p.x, 0.006, p.z], i * 3);
    const c = p.ok ? base : bad;
    col.set([c.r, c.g, c.b], i * 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Line(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9,
  }));
}

function updateCogTrail() {
  for (const line of [...trailGroup.children]) {
    line.geometry.dispose();
    line.material.dispose();
    trailGroup.remove(line);
  }
  if (!app.interpStates) return;
  const { A, B } = app.interpStates;
  const saved = app.getCoupleState('__trail');
  const series = { a: [], b: [], couple: [] };
  const N = 48;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    app.figures.forEach((f, j) => f.setPose(lerpPose(A.figures[j], B.figures[j], t)));
    leader.clampToFloor();
    follower.clampToFloor();
    const rep = coupleReport(leader, follower);
    series.a.push({ x: rep.a.cog.x, z: rep.a.cog.z, ok: rep.a.margin !== null && rep.a.margin > 0 });
    series.b.push({ x: rep.b.cog.x, z: rep.b.cog.z, ok: rep.b.margin !== null && rep.b.margin > 0 });
    series.couple.push({ x: rep.cog.x, z: rep.cog.z, ok: rep.margin !== null && rep.margin > 0 });
  }
  app.applyCoupleState(saved);
  trailGroup.add(
    trailLine(series.a, 0x7fb3e8),
    trailLine(series.b, 0xe89ab8),
    trailLine(series.couple, 0xffe08a),
  );
}

// ------------------------------------------------------------------ ghosts
// Translucent copies of the A/B snapshots, for visual pose comparison.
const ghostMats = {
  A: new THREE.MeshStandardMaterial({ color: 0x8fb8e8, transparent: true, opacity: 0.22, roughness: 0.9, depthWrite: false }),
  B: new THREE.MeshStandardMaterial({ color: 0xe8c98f, transparent: true, opacity: 0.22, roughness: 0.9, depthWrite: false }),
};

function makeGhostCouple(state, which, figures) {
  return state.figures.map((pose, i) => {
    const fig = new Figure({
      name: `Ghost ${which} ${i}`,
      height: state.meta?.heights?.[i] ?? figures[i].height,
      mass: 1,
      color: 0x888888,
    });
    fig.setLayers({ skeleton: false, body: true, muscle: false });
    fig.group.traverse((o) => {
      if (!o.isMesh) return;
      if (o.userData.isPick) { o.visible = false; return; }
      o.material = ghostMats[which];
      o.castShadow = false;
    });
    fig.setPose(pose);
    return fig;
  });
}

// ------------------------------------------------------------ gizmos & picking
const tcontrols = new TransformControls(camera, renderer.domElement);
tcontrols.setSpace('local');
tcontrols.size = 0.55;
scene.add(tcontrols);
tcontrols.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });

const ikTarget = new THREE.Mesh(
  new THREE.SphereGeometry(0.025, 14, 10),
  new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85 }),
);
ikTarget.visible = false;
scene.add(ikTarget);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const app = {
  scene, camera, renderer, orbit,
  leader, follower,
  embrace,
  // Smallest surface clearance between the two dancers' body colliders
  // (negative = penetration) — for the dev verification scripts.
  bodyClearance: () => bodyClearance(leader, follower),
  figures: [leader, follower],
  presets: PRESETS,
  mode: 'rotate',
  chainMode: 'open', // 'open' (move distal) | 'closed' (anchor foot, move proximal)
  selected: null, // { figure, jointName }
  ikState: null, // { figure, chain }
  ckc: null, // { node, matrix } captured while dragging in closed-chain mode
  linkCouple: false, // move/turn drags both dancers as one unit
  coupleDrag: null, // start transforms captured while dragging a linked couple
  figDragY: null, // root height captured when a figure drag starts
  pivot: null, // { figure, ankle, point } captured while dragging in pivot mode
  interpStates: null, // { A, B } couple states driving the A→B scrubber
  interpPlaying: false,
  interpT: 0,
  interpTick: null, // UI callback fed the current t while playing
  ghosts: { A: null, B: null }, // translucent snapshot figures
  history: [], // undo stack of serialized couple states
  ui: null,

  // Undo: call before any change; Ctrl+Z / the Undo button walks back.
  pushHistory() {
    const s = JSON.stringify(this.getCoupleState('undo'));
    if (this.history[this.history.length - 1] === s) return;
    this.history.push(s);
    if (this.history.length > 60) this.history.shift();
    if (this.ui) this.ui.onHistoryChanged();
  },

  undo() {
    const s = this.history.pop();
    if (s) this.applyCoupleState(JSON.parse(s));
    if (this.ui) this.ui.onHistoryChanged();
  },

  // Drop the shown dancers' feet back onto the floor, soles flat.
  groundFeet() {
    this.pushHistory();
    for (const f of this.visibleFigures()) {
      feetToFloor(f);
      f.clampToFloor();
    }
    if (this.ui) this.ui.onPoseChanged();
  },

  setMode(mode) {
    this.mode = mode;
    this.deselect();
  },

  // Raise/lower the pelvis (hip-height slider). A rigid root compensation
  // cancels a pure translation exactly — closed chain would be a no-op — so
  // in closed-chain mode the legs re-solve instead: each planted foot keeps
  // its world position and sole orientation while the body sinks or rises
  // over it (knees bend/straighten as far as the joint limits allow).
  setPelvisHeight(figure, y) {
    if (this.chainMode !== 'closed') {
      figure.nodes.pelvis.position.y = y;
      figure.group.updateMatrixWorld(true);
      return;
    }
    figure.group.updateMatrixWorld(true);
    const contacts = footContactsBySide(figure);
    const planted = ['L', 'R'].filter((side) => contacts[side].length > 0).map((side) => {
      const ankle = figure.nodes[`ankle_${side}`];
      return {
        side,
        pos: ankle.getWorldPosition(new THREE.Vector3()),
        quat: ankle.getWorldQuaternion(new THREE.Quaternion()),
      };
    });
    figure.nodes.pelvis.position.y = y;
    figure.group.updateMatrixWorld(true);
    for (const { side, pos, quat } of planted) {
      solveTwoBone(figure, {
        root: `hip_${side}`, mid: `knee_${side}`, effector: `ankle_${side}`, hingeSign: 1,
      }, pos);
      // Restore the sole's world orientation through the ankle joint.
      const ankle = figure.nodes[`ankle_${side}`];
      const parentQ = ankle.parent.getWorldQuaternion(new THREE.Quaternion());
      ankle.quaternion.copy(parentQ.invert().multiply(quat));
      figure.clampJoint(`ankle_${side}`);
    }
    figure.group.updateMatrixWorld(true);
  },

  setChainMode(mode) {
    this.chainMode = mode;
  },

  // Toggle the embrace constraints; pass either or both flags.
  setEmbrace({ hands, close } = {}) {
    if (hands !== undefined && hands !== this.embrace.hands) {
      if (hands) this.pushHistory();
      this.embrace.setHands(hands);
    }
    if (close !== undefined && close !== this.embrace.close) {
      if (close) this.pushHistory();
      this.embrace.setClose(close);
    }
  },

  // Highlight body parts (Set of BODY_PARTS ids, empty/null clears).
  setHighlight(parts) {
    this.highlightParts = parts;
    for (const f of this.figures) f.setHighlight(parts);
  },

  // The lower of the two ankles — the foot the dancer is standing on.
  supportAnkle(figure) {
    figure.group.updateMatrixWorld(true);
    const lY = figure.worldPos('ankle_L').y;
    const rY = figure.worldPos('ankle_R').y;
    return lY <= rY ? 'ankle_L' : 'ankle_R';
  },

  // The distal node kept fixed when `jointName` is edited in closed-chain mode,
  // or null if this joint has no grounded anchor.
  anchorNode(figure, jointName) {
    const key = ANCHOR_FOR[jointName];
    if (!key) return null;
    if (key === 'support-foot') return figure.nodes[this.supportAnkle(figure)];
    return figure.nodes[key];
  },

  // World position of the ball of the foot (the pivot point in tango).
  ballOfFoot(figure, ankleName, target = new THREE.Vector3()) {
    const H = figure.height;
    figure.group.updateMatrixWorld(true);
    target.set(0, -0.039 * H, 0.095 * H);
    return figure.nodes[ankleName].localToWorld(target);
  },

  // Rotate a figure about the ball of its support foot (ocho/calesita pivot).
  pivotFigure(figure, deltaYawRad) {
    const ankle = this.supportAnkle(figure);
    const before = this.ballOfFoot(figure, ankle);
    figure.group.rotation.y += deltaYawRad;
    const after = this.ballOfFoot(figure, ankle);
    figure.group.position.x += before.x - after.x;
    figure.group.position.z += before.z - after.z;
    figure.group.updateMatrixWorld(true);
  },

  // Edit a joint honouring the current chain mode. `mutate` changes rotations.
  editJoint(figure, jointName, mutate) {
    const anchor = this.chainMode === 'closed' ? this.anchorNode(figure, jointName) : null;
    if (anchor) {
      editWithAnchor(figure, anchor, () => { mutate(); figure.clampJoint(jointName); });
    } else {
      mutate();
      figure.clampJoint(jointName);
      figure.group.updateMatrixWorld(true);
    }
  },

  // Standard teaching camera angles.
  setView(name) {
    const views = {
      front: [0, 1.35, 3.4],
      side: [3.4, 1.35, 0],
      top: [0, 4.6, 0.6],
      three: [1.9, 1.5, 2.7],
    };
    const p = views[name];
    if (!p) return;
    camera.position.set(...p);
    orbit.target.set(0, name === 'top' ? 0 : 1.05, 0);
  },

  // Show 'both' | 'leader' | 'follower'.
  setVisibleFigures(which) {
    this.shown = which;
    leader.group.visible = which === 'both' || which === 'leader';
    follower.group.visible = which === 'both' || which === 'follower';
    if (this.selected && !this.selected.figure.group.visible) this.deselect();
    this.setVisibleFiguresRefresh?.();
  },

  visibleFigures() {
    return this.figures.filter((f) => f.group.visible);
  },

  deselect() {
    if (this.selected) {
      const s = this.selected.figure.jointSphereByName[this.selected.jointName];
      if (s) s.material.emissive.set(0x000000);
    }
    this.selected = null;
    this.ikState = null;
    ikTarget.visible = false;
    tcontrols.detach();
    if (this.ui) this.ui.onSelectionChanged();
  },

  selectJoint(figure, jointName) {
    this.deselect();
    const def = JOINT_BY_NAME[jointName];
    if (def.endpoint) jointName = def.parent;
    this.selected = { figure, jointName };
    const sphere = figure.jointSphereByName[jointName];
    if (sphere) sphere.material.emissive.set(0x3b6ea5);

    const node = figure.nodes[jointName];
    const limits = JOINT_BY_NAME[jointName].limits;
    tcontrols.setMode('rotate');
    tcontrols.showX = limits.x[0] !== limits.x[1];
    tcontrols.showY = limits.y[0] !== limits.y[1];
    tcontrols.showZ = limits.z[0] !== limits.z[1];
    tcontrols.attach(node);
    if (this.ui) this.ui.onSelectionChanged();
  },

  startIK(figure, jointName) {
    const chain = IK_CHAINS[jointName];
    if (!chain) return;
    this.deselect();
    this.selected = { figure, jointName: chain.effector };
    const sphere = figure.jointSphereByName[chain.effector];
    if (sphere) sphere.material.emissive.set(0x3b6ea5);
    this.ikState = { figure, chain };
    figure.nodes[chain.effector].getWorldPosition(ikTarget.position);
    ikTarget.visible = true;
    tcontrols.setMode('translate');
    tcontrols.showX = tcontrols.showY = tcontrols.showZ = true;
    tcontrols.attach(ikTarget);
    if (this.ui) this.ui.onSelectionChanged();
  },

  selectFigure(figure) {
    this.deselect();
    tcontrols.attach(figure.group);
    if (this.mode === 'move') {
      tcontrols.setMode('translate');
      tcontrols.showX = tcontrols.showZ = true;
      tcontrols.showY = false;
    } else {
      tcontrols.setMode('rotate');
      tcontrols.showY = true;
      tcontrols.showX = tcontrols.showZ = false;
    }
  },

  applyPreset(index) {
    const preset = PRESETS[index];
    if (!preset) return;
    this.pushHistory();
    this.deselect();
    preset.apply(leader, follower);
    if (this.ui) this.ui.onPoseChanged();
  },

  getCoupleState(name = '') {
    return {
      app: 'tangle',
      version: 1,
      name,
      meta: {
        heights: this.figures.map((f) => f.height),
        masses: this.figures.map((f) => f.mass),
      },
      figures: this.figures.map((f) => f.getPose()),
    };
  },

  applyCoupleState(state) {
    this.deselect();
    if (state.meta?.heights) {
      state.meta.heights.forEach((h, i) => {
        if (Math.abs(this.figures[i].height - h) > 1e-3) this.figures[i].setHeight(h);
      });
    }
    if (state.meta?.masses) {
      state.meta.masses.forEach((m, i) => { this.figures[i].mass = m; });
    }
    state.figures.forEach((pose, i) => this.figures[i].setPose(pose));
    if (this.ui) this.ui.onPoseChanged();
  },

  // -------------------------------------------------- A→B interpolation
  setInterpStates(A, B) {
    this.interpStates = A && B ? { A, B } : null;
    this.interpPlaying = false;
    updateCogTrail();
  },

  // Apply the pose interpolated between snapshots A and B at t ∈ [0, 1].
  applyInterp(t) {
    if (!this.interpStates) return;
    if (this.selected || this.ikState) this.deselect();
    const { A, B } = this.interpStates;
    this.figures.forEach((f, i) => f.setPose(lerpPose(A.figures[i], B.figures[i], t)));
  },

  playInterp(onTick) {
    if (!this.interpStates) return;
    this.interpT = 0;
    this.interpPlaying = true;
    this.interpTick = onTick || null;
  },

  setPathVisible(visible) {
    trailGroup.visible = visible;
  },

  // Show/replace/remove the translucent ghost couple for snapshot A or B.
  setGhost(which, state) {
    const old = this.ghosts[which];
    if (old) {
      for (const f of old) {
        scene.remove(f.group);
        f.dispose();
      }
      this.ghosts[which] = null;
    }
    if (!state) return;
    const figs = makeGhostCouple(state, which, this.figures);
    for (const f of figs) scene.add(f.group);
    this.ghosts[which] = figs;
  },
};

// When a drag begins: snapshot for undo, remember the closed-chain anchor so
// we can pin it back each frame, and capture start transforms for a linked
// couple drag.
tcontrols.addEventListener('dragging-changed', (e) => {
  if (!e.value) { app.ckc = null; app.coupleDrag = null; app.figDragY = null; app.pivot = null; return; }
  app.pushHistory();
  if (!app.selected && tcontrols.object?.userData.figure) {
    app.figDragY = tcontrols.object.position.y;
  }
  if (app.mode === 'pivot' && !app.selected && tcontrols.object?.userData.figure) {
    const figure = tcontrols.object.userData.figure;
    const ankle = app.supportAnkle(figure);
    app.pivot = { figure, ankle, point: app.ballOfFoot(figure, ankle) };
  }
  if (app.selected && !app.ikState && app.chainMode === 'closed') {
    const node = app.anchorNode(app.selected.figure, app.selected.jointName);
    if (node) {
      app.selected.figure.group.updateMatrixWorld(true);
      app.ckc = { figure: app.selected.figure, node, matrix: node.matrixWorld.clone() };
    }
  }
  if (app.linkCouple && !app.selected && tcontrols.object?.userData.figure) {
    const dragged = tcontrols.object.userData.figure;
    const other = app.figures.find((f) => f !== dragged);
    app.coupleDrag = {
      dragged, other,
      draggedPos: dragged.group.position.clone(),
      draggedYaw: dragged.group.rotation.y,
      otherPos: other.group.position.clone(),
      otherYaw: other.group.rotation.y,
    };
  }
});

const _yAxis = new THREE.Vector3(0, 1, 0);

tcontrols.addEventListener('objectChange', () => {
  if (app.ikState) {
    // Keep the IK target where the limb can reach without going underground.
    const H = app.ikState.figure.height;
    const minY = app.ikState.chain.effector.startsWith('ankle') ? 0.039 * H : 0.115 * H;
    if (ikTarget.position.y < minY) ikTarget.position.y = minY;
    solveTwoBone(app.ikState.figure, app.ikState.chain, ikTarget.position);
  } else if (app.selected) {
    app.selected.figure.clampJoint(app.selected.jointName);
    if (app.ckc) pinAnchor(app.ckc.figure, app.ckc.node, app.ckc.matrix);
    if (app.ui) app.ui.refreshJointValues();
  } else if (tcontrols.object) {
    // Figures stay at their drag-start height (usually the floor).
    if (app.figDragY !== null) tcontrols.object.position.y = app.figDragY;
    if (app.pivot) {
      // Re-pin the ball of the support foot: the gizmo rotated the figure
      // about its root; shift it back so the turn happens on the foot.
      const now = app.ballOfFoot(app.pivot.figure, app.pivot.ankle);
      app.pivot.figure.group.position.x += app.pivot.point.x - now.x;
      app.pivot.figure.group.position.z += app.pivot.point.z - now.z;
    }
    if (app.coupleDrag) {
      // Mirror the drag onto the partner: same translation, and rotation
      // about the dragged dancer so the embrace turns as one unit.
      const { dragged, other, draggedPos, draggedYaw, otherPos, otherYaw } = app.coupleDrag;
      const dYaw = dragged.group.rotation.y - draggedYaw;
      const rel = otherPos.clone().sub(draggedPos).applyAxisAngle(_yAxis, dYaw);
      other.group.position.copy(draggedPos).add(rel);
      other.group.position.x += dragged.group.position.x - draggedPos.x;
      other.group.position.z += dragged.group.position.z - draggedPos.z;
      other.group.position.y = otherPos.y;
      other.group.rotation.y = otherYaw + dYaw;
    }
  }
});

// Click-vs-drag detection so orbiting doesn't change the selection.
let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 6 || tcontrols.dragging) return;
  handleClick(e);
});

function handleClick(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const visible = app.visibleFigures();
  if (app.mode === 'move' || app.mode === 'turn' || app.mode === 'pivot') {
    const hits = raycaster.intersectObjects(visible.map((f) => f.group), true);
    const hit = hits.find((h) => h.object.visible);
    if (hit) {
      let o = hit.object;
      while (o && !o.userData.figure) o = o.parent;
      if (o) app.selectFigure(o.userData.figure);
    } else app.deselect();
    return;
  }

  const spheres = visible.flatMap((f) => f.pickSpheres);
  const hits = raycaster.intersectObjects(spheres, false);
  if (hits.length === 0) {
    app.deselect();
    return;
  }
  const { figure, jointName } = hits[0].object.userData;
  if (app.mode === 'ik') {
    if (IK_CHAINS[jointName]) app.startIK(figure, jointName);
    // clicks on non-effector joints in IK mode are ignored
  } else {
    app.selectJoint(figure, jointName);
  }
}

// ---------------------------------------------------------------- UI + loop
app.ui = initUI(app);
app.applyPreset(1); // start in the close embrace
app.history.length = 0; // the pre-preset construction state is not a useful undo target
app.ui.onHistoryChanged();

// What the user is editing right now, so the embrace constraints leave it
// alone and move the partner instead: an IK drag, a selected joint, or a
// whole-figure gizmo drag.
function embraceEditing() {
  if (app.ikState) return { figure: app.ikState.figure, jointName: app.ikState.chain.effector };
  if (app.selected) return app.selected;
  if (tcontrols.dragging && tcontrols.object?.userData.figure) {
    return { figure: tcontrols.object.userData.figure, jointName: null };
  }
  return null;
}

const clock = new THREE.Clock();
let statsTimer = 0;
let vizFlags = { cog: true, support: true, couple: true };

function applyVizVisibility() {
  const both = leader.group.visible && follower.group.visible;
  vizLeader.setVisible(vizFlags.cog && leader.group.visible, vizFlags.support && leader.group.visible);
  vizFollower.setVisible(vizFlags.cog && follower.group.visible, vizFlags.support && follower.group.visible);
  vizCouple.setVisible(vizFlags.couple && both, vizFlags.couple && vizFlags.support && both);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  orbit.update();

  if (app.interpPlaying) {
    app.interpT = Math.min(1, app.interpT + dt / 2.4);
    app.applyInterp(app.interpT);
    if (app.interpTick) app.interpTick(app.interpT);
    if (app.interpT >= 1) app.interpPlaying = false;
  }

  // Keep the embrace through whatever moved this frame: torso contact first
  // (it translates a dancer), the floor clamp, then re-join the hands (arm
  // rotations only, so they cannot disturb the floor contact).
  const editing = embraceEditing();
  embrace.maintainTorso(editing?.figure ?? null);

  // Body collision: the dancers may touch but never enter each other's
  // space — resolve any capsule penetration by sliding the partner of
  // whoever is being edited (see collision.js).
  resolveBodyCollision(leader, follower, editing?.figure ?? null);

  // Floor collision: no body part may end up below the dance floor,
  // whatever edit produced the pose (gizmo, slider, IK, preset, import).
  leader.clampToFloor();
  follower.clampToFloor();

  embrace.maintainHands(editing);

  // Deform bi-articular muscles to the current pose (no-op unless the muscle
  // layer is showing). Runs after clampToFloor so joint matrices are current.
  leader.updateMuscleSkin();
  follower.updateMuscleSkin();

  const both = leader.group.visible && follower.group.visible;
  const rA = leader.group.visible ? balanceReport(leader) : null;
  const rB = follower.group.visible ? balanceReport(follower) : null;
  if (rA) vizLeader.update(rA);
  if (rB) vizFollower.update(rB);
  let couple = null;
  if (both) {
    couple = coupleReport(leader, follower);
    vizCouple.update(couple);
  }

  statsTimer += dt;
  if (statsTimer > 0.25) {
    statsTimer = 0;
    app.ui.updateStats({ a: rA, b: rB, couple });
  }

  renderer.render(scene, camera);
}

app.setViz = (flags) => {
  vizFlags = flags;
  applyVizVisibility();
};
app.setVisibleFiguresRefresh = applyVizVisibility;
app.setViz(vizFlags);

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'range') return;
    e.preventDefault();
    app.undo();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();

// Handy for debugging from the browser console.
window.__app = app;
