import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Figure } from './figure.js';
import { IK_CHAINS, JOINT_BY_NAME, ANCHOR_FOR } from './skeletonDef.js';
import { solveTwoBone, editWithAnchor, pinAnchor } from './ik.js';
import { balanceReport, coupleReport } from './analysis.js';
import { PRESETS } from './presets.js';
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

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(4, 48),
  new THREE.MeshStandardMaterial({ color: 0x262a33, roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(8, 32, 0x3a4150, 0x2a2f3a);
grid.position.y = 0.001;
scene.add(grid);

// ---------------------------------------------------------------- figures
const leader = new Figure({ name: 'Leader', height: 1.78, mass: 75, color: 0x4d8fd1 });
const follower = new Figure({ name: 'Follower', height: 1.65, mass: 60, color: 0xc95f8e, skin: 0xe0b092 });
scene.add(leader.group, follower.group);

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
  figures: [leader, follower],
  presets: PRESETS,
  mode: 'rotate',
  chainMode: 'open', // 'open' (move distal) | 'closed' (anchor foot, move proximal)
  selected: null, // { figure, jointName }
  ikState: null, // { figure, chain }
  ckc: null, // { node, matrix } captured while dragging in closed-chain mode
  ui: null,

  setMode(mode) {
    this.mode = mode;
    this.deselect();
  },

  setChainMode(mode) {
    this.chainMode = mode;
  },

  // The distal node kept fixed when `jointName` is edited in closed-chain mode,
  // or null if this joint has no grounded anchor.
  anchorNode(figure, jointName) {
    const key = ANCHOR_FOR[jointName];
    if (!key) return null;
    if (key === 'support-foot') {
      figure.group.updateMatrixWorld(true);
      const lY = figure.worldPos('ankle_L').y;
      const rY = figure.worldPos('ankle_R').y;
      return figure.nodes[lY <= rY ? 'ankle_L' : 'ankle_R'];
    }
    return figure.nodes[key];
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
};

// When a closed-chain drag begins, remember where the anchor is so we can pin
// it back each frame.
tcontrols.addEventListener('dragging-changed', (e) => {
  if (!e.value) { app.ckc = null; return; }
  if (app.selected && !app.ikState && app.chainMode === 'closed') {
    const node = app.anchorNode(app.selected.figure, app.selected.jointName);
    if (node) {
      app.selected.figure.group.updateMatrixWorld(true);
      app.ckc = { figure: app.selected.figure, node, matrix: node.matrixWorld.clone() };
    }
  }
});

tcontrols.addEventListener('objectChange', () => {
  if (app.ikState) {
    solveTwoBone(app.ikState.figure, app.ikState.chain, ikTarget.position);
  } else if (app.selected) {
    app.selected.figure.clampJoint(app.selected.jointName);
    if (app.ckc) pinAnchor(app.ckc.figure, app.ckc.node, app.ckc.matrix);
    if (app.ui) app.ui.refreshJointValues();
  } else if (tcontrols.object) {
    tcontrols.object.position.y = 0; // figures stay on the floor
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
  if (app.mode === 'move' || app.mode === 'turn') {
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

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();

// Handy for debugging from the browser console.
window.__app = app;
