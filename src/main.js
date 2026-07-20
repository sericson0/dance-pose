import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Figure } from './figure.js';
import { IK_CHAINS, JOINT_BY_NAME, ANCHOR_FOR, DEG } from './skeletonDef.js';
import { solveTwoBone, swivelLimb, editWithAnchor, pinAnchor, feetToFloor, flattenFoot } from './ik.js';
import { balanceReport, coupleReport, footContactsBySide } from './analysis.js';
import { PRESETS } from './presets.js';
import { loadSkeletonBones, loadMuscleMeshes, loadBodyMesh } from './skeletonMesh.js';
import { Embrace } from './embrace.js';
import { ContactPins, nearestJointNode } from './pins.js';
import { resolveBodyCollision, bodyClearance, bodyContacts } from './collision.js';
import { Drawings } from './draw.js';
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

// soleScale fits each figure's balance footprint to its OWN rendered shoe (the
// shared corner tables in skeletonDef.js are sized to the man's): the woman's
// heeled shoe ends 0.073H ahead of her ankle vs the man's 0.095H, so her
// forward corners pull in by 0.78.
const leader = new Figure({ name: 'Leader', height: 1.78, mass: 75, color: 0x4d8fd1, skeleton: skeletonBones, muscles: muscleMeshes, body: manBody, bodyKey: 'man' });
const follower = new Figure({ name: 'Follower', height: 1.65, mass: 60, color: 0xc95f8e, skin: 0xe0b092, skeleton: skeletonBones, muscles: muscleMeshes, body: womanBody, bodyKey: 'woman', heelRise: 0.012, soleScale: { front: 0.78 } });
scene.add(leader.group, follower.group);

// Embrace constraints (open-side hand clasp, close-embrace torso contact),
// re-applied every frame in the loop below.
const embrace = new Embrace(leader, follower);

// User-authored contact pins (a spot on each dancer held together — custom
// holds, paradas), also re-applied every frame. See pins.js.
const pins = new ContactPins(leader, follower);
scene.add(pins.group);

// The first spot of a pin being authored in Pin-spots mode, awaiting its
// partner spot: a marker that rides the clicked body part until the second
// click lands (or the mode changes).
const pinPendingMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.014, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 }),
);
pinPendingMarker.visible = false;
scene.add(pinPendingMarker);

// -------------------------------------------------------- balance visuals
class BalanceViz {
  constructor(colorHex) {
    this.group = new THREE.Group();
    this.color = new THREE.Color(colorHex);
    this.front = false; // draw the COG indicator in front of the dancers

    this.cogBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 14, 10),
      new THREE.MeshBasicMaterial({ color: colorHex }),
    );
    this.cogBall.userData.viz = this; // click routing (see handleClick)
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

  // Draw the COG ball / drop line / floor marker through the dancers (depth
  // test off + late render order), so the indicator can't hide inside or
  // behind a body. Toggled by clicking the COG ball in the 3D view.
  setFront(on) {
    this.front = !!on;
    for (const o of [this.cogBall, this.dropLine, this.marker]) {
      o.material.depthTest = !this.front;
      o.renderOrder = this.front ? 40 : 0;
    }
    // Late transparent-pass draw is what keeps it above the (transparent)
    // ghosts and hover spheres; restore the plain opaque look when off.
    this.cogBall.material.transparent = this.front;
    this.marker.material.transparent = this.front;
    this.cogBall.material.color.copy(this.color);
    if (this.front) this.cogBall.material.color.lerp(new THREE.Color(0xffffff), 0.4);
    this.cogBall.scale.setScalar(this.front ? 1.35 : 1);
    this.marker.scale.setScalar(this.front ? 1.25 : 1);
  }
}

const vizLeader = new BalanceViz(0x7fb3e8);
const vizFollower = new BalanceViz(0xe89ab8);
const vizCouple = new BalanceViz(0xffe08a);
scene.add(vizLeader.group, vizFollower.group, vizCouple.group);

// ------------------------------------------------- dissociation visual
// Tango dissociation made visible on the floor: the hip axis (hip_L↔hip_R)
// and the shoulder axis (shoulder_L↔shoulder_R), both projected onto the
// floor under the dancer, with a translucent wedge sweeping the twist angle
// between them. Reads best in the Top view; the number lives in the stats
// panel (tangoStats), this is the picture.
class DissociationViz {
  static WEDGE_SEGS = 24;

  constructor(colorHex) {
    this.group = new THREE.Group();
    const lineGeo = () => new THREE.BufferGeometry()
      .setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    // Hip axis: the dancer's own color. Shoulder axis: white, so the twist
    // between the two lines is unmistakable.
    this.hipLine = new THREE.Line(lineGeo(), new THREE.LineBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.95,
    }));
    this.shoulderLine = new THREE.Line(lineGeo(), new THREE.LineBasicMaterial({
      color: 0xf5f2e8, transparent: true, opacity: 0.95,
    }));
    // Wedge fan between the two axes: center + rim points, rebuilt per frame.
    const segs = DissociationViz.WEDGE_SEGS;
    const wedgeGeo = new THREE.BufferGeometry();
    wedgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((segs + 2) * 3), 3));
    const idx = [];
    for (let i = 0; i < segs; i++) idx.push(0, i + 1, i + 2);
    wedgeGeo.setIndex(idx);
    this.wedge = new THREE.Mesh(wedgeGeo, new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.group.add(this.hipLine, this.shoulderLine, this.wedge);
    this.group.visible = false;
  }

  #axisDir(figure, left, right, out) {
    figure.worldPos(left, out).sub(figure.worldPos(right, DissociationViz._t));
    out.y = 0;
    return out.lengthSq() > 1e-8 ? out.normalize() : null;
  }

  update(figure) {
    const H = figure.height;
    const hipDir = this.#axisDir(figure, 'hip_L', 'hip_R', DissociationViz._hip);
    const shDir = this.#axisDir(figure, 'shoulder_L', 'shoulder_R', DissociationViz._sh);
    if (!hipDir || !shDir) { this.group.visible = false; return; }
    this.group.visible = this._on !== false;
    const c = figure.worldPos('pelvis', DissociationViz._c);
    c.y = 0.006;

    const setLine = (line, dir, halfLen) => {
      const pts = line.geometry.attributes.position;
      pts.setXYZ(0, c.x - dir.x * halfLen, c.y, c.z - dir.z * halfLen);
      pts.setXYZ(1, c.x + dir.x * halfLen, c.y + 0.001, c.z + dir.z * halfLen);
      pts.needsUpdate = true;
    };
    setLine(this.hipLine, hipDir, 0.20 * H);
    setLine(this.shoulderLine, shDir, 0.25 * H);

    // Fan from the hip axis to the shoulder axis (signed, so the wedge opens
    // the way the shoulders actually twisted), on the left-hand ends.
    const angle = Math.atan2(
      hipDir.x * shDir.z - hipDir.z * shDir.x, hipDir.dot(shDir),
    );
    const segs = DissociationViz.WEDGE_SEGS;
    const r = 0.17 * H;
    const wp = this.wedge.geometry.attributes.position;
    wp.setXYZ(0, c.x, c.y, c.z);
    for (let i = 0; i <= segs; i++) {
      const a = -angle * (i / segs); // rotate about +Y from hipDir toward shDir
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const dx = hipDir.x * cos - hipDir.z * sin;
      const dz = hipDir.x * sin + hipDir.z * cos;
      wp.setXYZ(i + 1, c.x + dx * r, c.y, c.z + dz * r);
    }
    wp.needsUpdate = true;
    this.wedge.geometry.computeBoundingSphere();
  }

  setVisible(on) {
    this._on = on;
    if (!on) this.group.visible = false;
  }
}
DissociationViz._t = new THREE.Vector3();
DissociationViz._hip = new THREE.Vector3();
DissociationViz._sh = new THREE.Vector3();
DissociationViz._c = new THREE.Vector3();

const dissocLeader = new DissociationViz(0x7fb3e8);
const dissocFollower = new DissociationViz(0xe89ab8);
scene.add(dissocLeader.group, dissocFollower.group);

// Floor annotations (Draw mode): lines / arrows / circles / text for teaching
// diagrams — step directions, giro circles, labels. See draw.js.
const drawings = new Drawings();
scene.add(drawings.group, drawings.previewGroup);

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

// ------------------------------------------ interpolation foot grounding
// Joint-space lerping doesn't preserve world foot positions: halfway between
// two standing keyframes the support foot drifts off its spot and floats.
// The rule: a foot on the floor at BOTH ends of a segment stays connected to
// it throughout — the standing leg holds its ground, and a foot that moves
// between two grounded spots glides along the floor instead of arcing through
// the air (with both feet planted in both keyframes, both stay connected).
// The leg's hip/knee/ankle re-solve to accommodate, starting from the lerped
// pose so the leg's swivel stays continuous. A foot airborne at either end
// lerps freely — feet stay free, a boleo still flies.
const _stateFeetCache = new WeakMap(); // couple state → per-figure foot anchors

// Each figure's foot anchors in `state`: planted flag + ankle world transform.
// Measuring applies the state's poses to the figures — callers apply their own
// pose right after, so nothing is saved or restored here.
function stateFeet(state) {
  let info = _stateFeetCache.get(state);
  if (info) return info;
  info = state.figures.map((pose, i) => {
    const f = app.figures[i];
    f.setPose(pose);
    const feet = {};
    for (const side of ['L', 'R']) {
      const ankle = f.nodes[`ankle_${side}`];
      feet[side] = {
        planted: f.footLowY(side) < 0.01,
        pos: ankle.getWorldPosition(new THREE.Vector3()),
        quat: ankle.getWorldQuaternion(new THREE.Quaternion()),
      };
    }
    return feet;
  });
  _stateFeetCache.set(state, info);
  return info;
}

const _gfPos = new THREE.Vector3();
const _gfQuat = new THREE.Quaternion();
const _gfParentQ = new THREE.Quaternion();

// Re-plant the figure's both-ends-planted feet on the lerped pose at t: the
// ankle back to the lerped world spot (leg IK), the sole back to the slerped
// world orientation (through the ankle joint, limits still enforced).
function groundInterpFeet(figure, fa, fb, t) {
  for (const side of ['L', 'R']) {
    const a = fa[side];
    const b = fb[side];
    if (!a.planted || !b.planted) continue;
    _gfPos.copy(a.pos).lerp(b.pos, t);
    _gfQuat.copy(a.quat).slerp(b.quat, t);
    solveTwoBone(figure, {
      root: `hip_${side}`, mid: `knee_${side}`, effector: `ankle_${side}`, hingeSign: 1,
    }, _gfPos);
    const ankle = figure.nodes[`ankle_${side}`];
    ankle.parent.getWorldQuaternion(_gfParentQ);
    ankle.quaternion.copy(_gfParentQ.invert().multiply(_gfQuat));
    figure.clampJoint(`ankle_${side}`);
  }
  figure.syncAtlasNodes();
  figure.group.updateMatrixWorld(true);
}

// Pose the couple at t ∈ [0, 1] along a chain of couple states — the A→B
// lerp generalized to any number of keyframes (equal time per segment). The
// scrubber/player of both the A/B compare and the movement sequence land here.
function applyStatesT(states, t) {
  const segs = states.length - 1;
  const u = THREE.MathUtils.clamp(t, 0, 1) * segs;
  const i = Math.min(Math.floor(u), segs - 1);
  const sA = states[i];
  const sB = states[i + 1];
  // Foot anchors first: measuring applies the endpoint poses, which the
  // lerped pose below overwrites.
  const feetA = app.interpGroundFeet ? stateFeet(sA) : null;
  const feetB = app.interpGroundFeet ? stateFeet(sB) : null;
  app.figures.forEach((f, j) => {
    f.setPose(lerpPose(sA.figures[j], sB.figures[j], u - i));
    if (feetA && feetB) groundInterpFeet(f, feetA[j], feetB[j], u - i);
  });
}

// Tempo shared by the A→B player and the sequence player (seconds per segment).
const SEQ_SEG_SECONDS = 2.4;

// Floor trace of the three COGs along the A→B / sequence movement, vertex-
// colored by balance: the entity's own color while balanced, red where it
// loses the base.
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
  const states = app.trailStates();
  if (!states) return;
  const saved = app.getCoupleState('__trail');
  const series = { a: [], b: [], couple: [] };
  const N = 32 * (states.length - 1) + 1;
  for (let i = 0; i < N; i++) {
    applyStatesT(states, i / (N - 1));
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

// Pole-vector handle for swiveling an intermediate joint (elbow/knee) while
// its neighbours stay pinned — see app.startSwivel / swivelLimb.
const swivelTarget = new THREE.Mesh(
  new THREE.SphereGeometry(0.025, 14, 10),
  new THREE.MeshBasicMaterial({ color: 0x8ac6ff, transparent: true, opacity: 0.85 }),
);
swivelTarget.visible = false;
scene.add(swivelTarget);

// Floor target for the toe-caress drag (startToeCaress): a flat ring lying on
// the floor where the big toe rests. The gizmo moves it in the floor plane
// only; the holder stays unrotated so the gizmo axes stay world-aligned.
const caressTarget = new THREE.Object3D();
{
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.02, 0.035, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe08a, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  caressTarget.add(ring);
}
caressTarget.visible = false;
scene.add(caressTarget);

// Drag handle for the Move-hips mode: sits at the pelvis; dragging it slides
// the hips (and, rigidly, everything above) while planted feet stay put.
const hipsTarget = new THREE.Mesh(
  new THREE.SphereGeometry(0.028, 14, 10),
  new THREE.MeshBasicMaterial({ color: 0xc9a2ff, transparent: true, opacity: 0.85 }),
);
hipsTarget.visible = false;
scene.add(hipsTarget);

// The two-bone chain whose middle joint is `jointName` (elbow/knee), or null.
function swivelChainFor(jointName) {
  for (const chain of Object.values(IK_CHAINS)) {
    if (chain.mid === jointName) return chain;
  }
  return null;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// Aim the shared raycaster at a pointer event's client coords.
function pointerRay(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

// Where the current pointer ray meets the dance floor (y = 0), or null.
const _floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function floorPointAtPointer(out = new THREE.Vector3()) {
  return raycaster.ray.intersectPlane(_floorPlane, out);
}

// Accept {x,z} / {x,y,z} / Vector3 and pin it to the floor plane.
function toFloorV3(p) {
  return new THREE.Vector3(p.x ?? 0, 0, p.z ?? 0);
}

// Yaw that makes floor text at `pos` read right-way-up from the camera.
function textYawFromCamera(pos) {
  const d = new THREE.Vector3(pos.x - camera.position.x, 0, pos.z - camera.position.z);
  if (d.lengthSq() < 1e-6) return 0;
  d.normalize();
  return Math.atan2(-d.x, -d.z);
}

// ---------------------------------------------------------- whole-figure helpers
const _UP = new THREE.Vector3(0, 1, 0);

// Open vs. closed chain is only meaningful for the legs/pelvis (they have a
// grounded foot to anchor); arms and the spine are always open chain.
const CHAIN_JOINTS = new Set([
  'pelvis', 'hip_L', 'knee_L', 'ankle_L', 'toes_L', 'hip_R', 'knee_R', 'ankle_R', 'toes_R',
]);

// Walking: the free foot lands STEP_STRIDE·H ahead of the planted foot, the body
// rolls STEP_ADVANCE of that stride forward per step, and the pelvis sits at
// WALK_PELVIS·H — a slight walking crouch, since a fully straight leg (the rest
// pose) can only reach straight down. The crouch is shallower than the legs
// alone would need: the foot roll extends each leg's reach the rest of the way
// (the front heel-strike pivots the ankle in around the heel, the trailing
// heel peels because the leg has run out of length — which is exactly why real
// heels peel).
const STEP_STRIDE = 0.24;
const STEP_ADVANCE = 0.5;
const WALK_PELVIS = 0.51;

// Gait shaping — the step ends on the classic double-support "contact" moment
// (heel just struck ahead, trailing foot pushing off the ball) and animates
// through the tango collection (the free foot brushes past the support ankle,
// caressing the floor). Tango walks level — the crouch height holds throughout,
// no vertical bob; the pelvis yaws into the step while the chest counter-yaws
// so the shoulders stay with the partner (dissociation).
const STEP_DURATION = 0.55;      // seconds a step plays over (a re-press snaps it)
const HEEL_STRIKE_DEG = 12;      // stepping forward: land heel first, toe up
const TOE_LAND_DEG = 30;         // stepping backward: reach with a pointed toe
const SUPPORT_ROLL_DEG = 28;     // forward: the trailing foot peels onto the ball
const SUPPORT_RELEASE_DEG = -8;  // backward: the leading foot releases toe-up instead
const SWING_LIFT = 0.010;        // the swing foot caresses the floor, barely lifted (·H)
const BRUSH_FRAC = 0.030;        // collection: swing ankle passes this close to the support (·H)
const STEP_DISSOC_DEG = 6;       // pelvis yaw into the step (chest counter-yaws)
const STEP_SWAY = 0.010;         // transient weight shift over the support foot (·H)

const smoothstep = (u) => u * u * (3 - 2 * u);

// The dancer's forward on the floor (local +Z projected onto the ground plane).
function figureForward(figure, out = new THREE.Vector3()) {
  out.set(0, 0, 1).applyQuaternion(figure.group.quaternion);
  out.y = 0;
  if (out.lengthSq() < 1e-8) return out.set(0, 0, 1);
  return out.normalize();
}

// Orbit a figure around a world point by a yaw delta (couple pivot / calesita).
function rotateAbout(figure, point, dYaw) {
  const p = figure.group.position;
  const rel = new THREE.Vector3(p.x - point.x, 0, p.z - point.z).applyAxisAngle(_UP, dYaw);
  p.x = point.x + rel.x;
  p.z = point.z + rel.z;
  figure.group.rotation.y += dYaw;
  figure.group.updateMatrixWorld(true);
}

// Reach one leg's ankle toward `target` (where the ankle would sit with a FLAT
// sole) and shape the foot by `pitchDeg`: plantarflex > 0 rolls onto the ball /
// points the toe, dorsiflex < 0 lands the heel with the toe up. The pitch is a
// rotation of the whole foot about its ground contact — the ball for a roll,
// the heel for a heel-strike — so the ankle target itself swings along that
// arc (up-and-forward for a heel-off, up-and-back for a toe-up). Pitching in
// place around a rest-height ankle instead digs the sole into the floor, and
// the ground correction then folds the knee into a squat chasing it. Finally
// the target is nudged vertically so the foot's lowest sole corner sits
// exactly on the floor (`ground`), or merely never below it (a swing foot
// mid-flight); iterated because re-solving the leg tips the shank, which
// moves the sole.
function plantFoot(figure, side, target, pitchDeg = 0, ground = true) {
  const chain = { root: `hip_${side}`, mid: `knee_${side}`, effector: `ankle_${side}`, hingeSign: 1 };
  const t = target.clone();
  let pitch = pitchDeg;
  if (pitch) {
    const H = figure.height;
    const fwd = figureForward(figure);
    const lat = new THREE.Vector3().crossVectors(fwd, _UP).normalize();
    // Flat-foot contact point the pitch pivots about (toes node / heel corner).
    const pivot = pitch > 0
      ? target.clone().addScaledVector(fwd, 0.090 * H).addScaledVector(_UP, -0.030 * H)
      : target.clone().addScaledVector(fwd, -0.033 * H).addScaledVector(_UP, -0.035 * H);
    const flatVec = target.clone().sub(pivot);
    const hip = figure.worldPos(`hip_${side}`, new THREE.Vector3());
    const reach = (Math.abs(JOINT_BY_NAME[`knee_${side}`].offset[1])
      + Math.abs(JOINT_BY_NAME[`ankle_${side}`].offset[1])) * H;
    const arced = (deg) => flatVec.clone()
      .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(lat, -deg * DEG)).add(pivot);
    if (ground) {
      // Arcing the ankle up shortens the hip→ankle distance, and two-bone IK
      // absorbs ALL such slack in the knee — a 28° heel-off around a planted
      // ball would fold the knee to ~75°, a squat no walker makes. A real
      // push-off leg stays long: peel the heel only as far as keeps the leg
      // out near its reach (0.95·reach ≈ a 36° knee, the same bend the
      // authored trailing-grazing-toe preset carries).
      while (Math.abs(pitch) > 1 && hip.distanceTo(arced(pitch)) < 0.95 * reach) {
        pitch -= pitchDeg / 8;
      }
      if (Math.abs(pitch) <= 1) pitch = 0;
    }
    if (pitch) t.copy(arced(pitch));
  }
  for (let i = 0; i < 4; i++) {
    solveTwoBone(figure, chain, t);
    flattenFoot(figure, side, pitch * DEG);
    const low = figure.footLowY(side);
    if (low < -1e-4 || (ground && low > 1e-4)) t.y -= low;
    else break;
  }
}

// Floor-caress leg control: pose `side`'s leg so its TOE PAD rests exactly on
// the floor at `pt` (world XZ) — the tango lápiz / tendu. The foot stays flat
// while the target is under the body and rolls up onto a pointed toe as the
// leg reaches away; hip, knee, ankle and toes absorb all of the movement. The
// toe pad is the pinned contact (all other sole corners share its plane or
// sit behind it), so the sole never digs below the floor and the caress can
// never lift the body — clampToFloor reacts only to penetration.
function caressToe(figure, side, pt) {
  const H = figure.height;
  const chain = { root: `hip_${side}`, mid: `knee_${side}`, effector: `ankle_${side}`, hingeSign: 1 };
  const ankleNode = figure.nodes[`ankle_${side}`];
  const toesNode = figure.nodes[`toes_${side}`];
  figure.nodes[`toes_${side}`].rotation.set(0, 0, 0); // pads stay in the sole plane
  figure.group.updateMatrixWorld(true);

  // The contact point: this figure's toe-pad center (midpoint of its fitted
  // toe corners), in the toes joint's frame.
  const tc = figure.toeCorners[`_${side}`];
  const pad = new THREE.Vector3(
    (tc[0][0] + tc[1][0]) / 2, (tc[0][1] + tc[1][1]) / 2, (tc[0][2] + tc[1][2]) / 2,
  ).multiplyScalar(H);

  // Clamp the target inside the leg's reach (leg long + foot pointed) so the
  // solve converges with the toe ON the floor instead of hovering toward an
  // unreachable spot.
  const hip = figure.worldPos(`hip_${side}`, new THREE.Vector3());
  const legLen = (Math.abs(JOINT_BY_NAME[`knee_${side}`].offset[1])
    + Math.abs(JOINT_BY_NAME[`ankle_${side}`].offset[1])) * H;
  const toesOff = JOINT_BY_NAME[`toes_${side}`].offset;
  const footLen = pad.clone().add(new THREE.Vector3(toesOff[0] * H, toesOff[1] * H, toesOff[2] * H)).length();
  const maxR = Math.sqrt(Math.max(0, (legLen + footLen) ** 2 - hip.y ** 2)) * 0.99;
  const target = new THREE.Vector3(pt.x - hip.x, 0, pt.z - hip.z);
  if (target.length() > maxR) target.setLength(maxR);
  target.x += hip.x;
  target.z += hip.z;

  // The leg pose the reach probes below restore to.
  const padW = new THREE.Vector3();
  const names = [`hip_${side}`, `knee_${side}`, `ankle_${side}`, `toes_${side}`];
  const saved = names.map((n) => figure.nodes[n].rotation.clone());

  // Solve the leg toward a floor point; returns how far the pad ends off the
  // floor. Restores the entry pose first so repeated probes are independent.
  const solveAt = (tx, tz) => {
    names.forEach((n, i) => figure.nodes[n].rotation.copy(saved[i]));
    figure.nodes[`toes_${side}`].rotation.set(0, 0, 0); // pads stay in the sole plane
    for (let i = 0; i < 12; i++) {
      figure.group.updateMatrixWorld(true);
      padW.copy(pad);
      toesNode.localToWorld(padW);
      const ex = tx - padW.x;
      const ey = -padW.y;
      const ez = tz - padW.z;
      if (Math.hypot(ex, ey, ez) < 5e-4 && figure.footLowY(side) > -1e-4) break;
      // Carry the ankle by the toe error, then pitch the foot about the ankle
      // so the pad lands back on the floor (flattenFoot aimed at y = 0).
      const ankleT = figure.worldPos(`ankle_${side}`, new THREE.Vector3());
      ankleT.x += ex; ankleT.y += ey; ankleT.z += ez;
      solveTwoBone(figure, chain, ankleT);
      figure.group.updateMatrixWorld(true);
      const A = figure.worldPos(`ankle_${side}`, new THREE.Vector3());
      padW.copy(pad);
      toesNode.localToWorld(padW);
      const horiz = Math.hypot(padW.x - A.x, padW.z - A.z);
      if (horiz > 1e-5) {
        ankleNode.rotation.x += Math.atan2(padW.y, horiz);
        figure.clampJoint(`ankle_${side}`);
      }
      // If pinning the pad under a low ankle dorsiflexed the heel into the
      // floor, sit the sole flat instead; the next pass raises the ankle.
      figure.group.updateMatrixWorld(true);
      if (figure.footLowY(side) < -1e-4) flattenFoot(figure, side);
    }
    figure.group.updateMatrixWorld(true);
    padW.copy(pad);
    toesNode.localToWorld(padW);
    return padW.y;
  };

  // The distance clamp above is isotropic, but joint limits make the true
  // reach directional (hip extension caps the back reach, ab/adduction the
  // sides). If the toe can't get DOWN to the floor at the target, pull the
  // target in toward the point directly below the hip until it can — the toe
  // stays ON the floor at the farthest reachable point instead of floating
  // toward the cursor. Bisecting along this hip ray (not the drag path) keeps
  // reachability monotone: every point on it is a plain tendu, from a
  // collected foot at the hip out to the limit boundary.
  if (solveAt(target.x, target.z) > 0.003) {
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 7; it++) {
      const mid = (lo + hi) / 2;
      const y = solveAt(
        hip.x + (target.x - hip.x) * mid,
        hip.z + (target.z - hip.z) * mid,
      );
      if (y < 0.003) lo = mid; else hi = mid;
    }
    solveAt(hip.x + (target.x - hip.x) * lo, hip.z + (target.z - hip.z) * lo);
  }
  figure.group.updateMatrixWorld(true);
}

// Capture one footfall for `figure` (dir +1 forward, -1 back) as a step state:
// the support foot holds its floor spot while the body rolls over it and the
// free foot swings a stride ahead. Which foot swings alternates (the trailing
// foot leads), so repeated calls walk. The state is posed by poseStep(u) —
// u = 1 is the finished contact pose; smaller u are the roll-through, with the
// swing foot collecting past the support ankle.
function beginStep(figure, dir, strideM = null, forceSwing = null) {
  const H = figure.height;
  const g = figure.group;
  g.updateMatrixWorld(true);
  const fwd = figureForward(figure);
  const lat = new THREE.Vector3().crossVectors(fwd, _UP).normalize();
  const travel = fwd.clone().multiplyScalar(dir);
  const ankleRestY = 0.039 * H;
  // A linked partner steps the INITIATOR's stride (see stepFigure): two
  // different strides walk the couple apart a few cm per step until they
  // rest foot-against-foot — a follower really does match the leader's
  // step length.
  const stride = strideM ?? STEP_STRIDE * H;

  const aL = figure.worldPos('ankle_L', new THREE.Vector3());
  const aR = figure.worldPos('ankle_R', new THREE.Vector3());
  const pL = aL.dot(travel);
  const pR = aR.dot(travel);
  let swing;
  if (forceSwing) swing = forceSwing;                            // linked partner mirrors the leader
  else if (Math.abs(pL - pR) > 0.02 * H) swing = pL < pR ? 'L' : 'R'; // trailing foot swings through
  else swing = figure.__swing === 'L' ? 'R' : 'L';               // collected stance: alternate
  const support = swing === 'L' ? 'R' : 'L';
  figure.__swing = swing;

  // Support foot: hold its floor spot (its current XZ, dropped to rest height).
  const supPos = (support === 'L' ? aL : aR).clone();
  supPos.y = ankleRestY;
  // Swing foot: land it a stride ahead of the support foot along travel, keeping
  // its lateral offset so the feet stay on their own rails.
  const swStart = (swing === 'L' ? aL : aR).clone();
  const latOff = swStart.clone().sub(supPos).dot(lat);
  const swPos = supPos.clone().addScaledVector(travel, stride).addScaledVector(lat, latOff);
  swPos.y = ankleRestY;

  // Dissociation: the stepping side's hip leads the stride; the chest
  // counter-yaws by the same amount so the shoulders (and the embrace) keep
  // facing the partner — their yaw sum is preserved, not zeroed, so an
  // authored trunk twist survives the walk.
  const yawSign = (swing === 'L' ? -1 : 1) * dir;
  const pelvisYawStart = figure.nodes.pelvis.rotation.y;
  const chestYawStart = figure.nodes.chest.rotation.y;
  const pelvisYawEnd = yawSign * STEP_DISSOC_DEG * DEG;
  const chestYawEnd = chestYawStart + pelvisYawStart - pelvisYawEnd;

  // The body ends STEP_ADVANCE of the way between the two planted feet —
  // anchored along the travel line to the SUPPORT FOOT, not accumulated from
  // the body's own position: accumulating 0.5·stride per step while the feet
  // leapfrog a full stride leaves the body drifting back over the support
  // foot, with the front foot landing a full stride ahead — beyond the
  // leg's reach, so it floated. The dancer's own stance offset (how far the
  // body rides ahead of the feet midpoint — the apilado/close-embrace lean
  // carries the feet behind the chest) is measured and preserved, so a
  // leaning couple doesn't get snapped apart by the anchoring. Only the
  // along-travel coordinate is corrected; the lateral stays the body's own.
  const stanceOffset = THREE.MathUtils.clamp(
    g.position.clone().sub(aL.clone().add(aR).multiplyScalar(0.5)).dot(travel),
    -0.05 * H, 0.05 * H,
  );
  const alongCorr = supPos.clone().sub(g.position).dot(travel)
    + STEP_ADVANCE * stride + stanceOffset;
  return {
    dir, swing, support, supPos, swStart, swPos, latOff, travel, lat,
    H, ankleRestY, stride,
    bodyStart: g.position.clone(),
    bodyEnd: g.position.clone().addScaledVector(travel, alongCorr),
    // Walking crouch: a straight leg can only reach straight down, so the
    // pelvis eases down to where the reaching legs can touch the floor.
    pelvisYStart: figure.nodes.pelvis.position.y,
    pelvisYEnd: Math.min(figure.nodes.pelvis.position.y, WALK_PELVIS * H),
    pelvisYawStart, pelvisYawEnd, chestYawStart, chestYawEnd,
    swingPitchStart: figure.nodes[`ankle_${swing}`].rotation.x,
    swingPitchEnd: (dir > 0 ? -HEEL_STRIKE_DEG : TOE_LAND_DEG) * DEG,
  };
}

// Pose one moment of a step, u ∈ [0, 1].
function poseStep(figure, st, u) {
  const g = figure.group;
  const H = st.H;

  // Body: roll along the travel line, bowing transiently sideways over the
  // support foot (the weight really passes onto it at mid-step) — the bow
  // returns to the line by u = 1, so nothing accumulates across steps.
  const swaySign = Math.sign(st.supPos.clone().sub(st.bodyEnd).dot(st.lat)) || 1;
  g.position.lerpVectors(st.bodyStart, st.bodyEnd, u)
    .addScaledVector(st.lat, swaySign * STEP_SWAY * H * Math.sin(Math.PI * u));
  figure.nodes.pelvis.position.y = THREE.MathUtils.lerp(st.pelvisYStart, st.pelvisYEnd, Math.min(1, 2 * u));
  figure.nodes.pelvis.rotation.y = THREE.MathUtils.lerp(st.pelvisYawStart, st.pelvisYawEnd, u);
  figure.nodes.chest.rotation.y = THREE.MathUtils.lerp(st.chestYawStart, st.chestYawEnd, u);
  figure.clampJoint('chest');
  g.updateMatrixWorld(true);

  // Support foot: hold its spot. Stepping forward it peels onto the ball as
  // the body passes over (heel-off — the ankle rises, the toe pad keeps the
  // floor); stepping backward the leading foot releases toe-up instead,
  // heel grounded.
  const roll = smoothstep(THREE.MathUtils.clamp((u - 0.35) / 0.65, 0, 1));
  const supPitch = (st.dir > 0 ? SUPPORT_ROLL_DEG : SUPPORT_RELEASE_DEG) * roll;
  plantFoot(figure, st.support, st.supPos, supPitch, true);

  // Swing foot: travel to its landing, collecting past the support ankle
  // (the tango brush) while caressing the floor, and pitch from however it
  // left the ground to its landing attitude (heel-first forward, pointed
  // toe backward).
  const swTarget = new THREE.Vector3().lerpVectors(st.swStart, st.swPos, u);
  const brushLat = Math.sign(st.latOff || (st.swing === 'L' ? -1 : 1)) * BRUSH_FRAC * H;
  swTarget.addScaledVector(st.lat, (brushLat - st.latOff) * Math.sin(Math.PI * u));
  swTarget.y += SWING_LIFT * H * Math.sin(Math.PI * u);
  const swPitch = THREE.MathUtils.lerp(st.swingPitchStart, st.swingPitchEnd, u) / DEG;
  // Mid-flight the foot only must not pierce the floor; at u = 1 it lands.
  plantFoot(figure, st.swing, swTarget, swPitch, u >= 1);

  g.updateMatrixWorld(true);
  figure.syncAtlasNodes();
}

// Finish a step: the contact pose, settled onto the floor.
function finalizeStep(figure, st) {
  poseStep(figure, st, 1);
  const g = figure.group;
  g.position.y -= figure.lowestPointY();
  g.updateMatrixWorld(true);
  figure.syncAtlasNodes();
}

// One immediate footfall (no animation) — scripts and the couple's snap path.
function takeStep(figure, dir) {
  finalizeStep(figure, beginStep(figure, dir));
}

const app = {
  scene, camera, renderer, orbit,
  leader, follower,
  embrace,
  pins,
  pinPending: null, // first spot of a pin being authored ({ figure, node, local })
  // Smallest surface clearance between the two dancers' body colliders
  // (negative = penetration) — for the dev verification scripts.
  bodyClearance: () => bodyClearance(leader, follower),
  // The tightest collider pairs by name, tightest first — for radius tuning.
  bodyContacts: (n = 5) => bodyContacts(leader, follower).slice(0, n),
  figures: [leader, follower],
  presets: PRESETS,
  mode: 'rotate',
  chainMode: 'open', // 'open' (move distal) | 'closed' (anchor foot, move proximal)
  drawTool: 'line', // Draw-mode sub-tool: 'line' | 'arrow' | 'circle' | 'text'
  drawPending: null, // first corner of a two-click shape, awaiting the second
  draw: drawings, // the Drawings instance (verification introspects its group)
  cogViz: { leader: vizLeader, follower: vizFollower, couple: vizCouple },
  get drawings() { return drawings.list(); },
  selected: null, // { figure, jointName }
  activeFigure: null, // the figure driven by Move/Step (keyboard nudges act on it)
  ikState: null, // { figure, chain }
  swivelState: null, // { figure, chain } while dragging an elbow/knee pole handle
  ckc: null, // { node, matrix } captured while dragging in closed-chain mode
  linkCouple: false, // move/turn/step act on both dancers as one unit
  stepAnims: [], // in-flight walking steps ({ figure, st, t }), advanced by the loop
  animateSteps: true, // steps play through the roll/collection (false = snap)
  coupleDrag: null, // start transforms captured while dragging a linked couple
  figDragY: null, // root height captured when a figure drag starts
  interpStates: null, // { A, B } couple states driving the A→B scrubber
  interpGroundFeet: true, // planted-at-both-ends feet stay on the floor while interpolating
  interpPlaying: false,
  interpT: 0,
  interpTick: null, // UI callback fed the current t while playing
  seqStates: [], // movement-sequence keyframes (couple states, ≥2 to play)
  seqPlaying: false,
  seqT: 0,
  seqTick: null, // UI callback fed the current t while the sequence plays
  seqDone: null, // fired once when the sequence player reaches t = 1
  recording: null, // { states, t, secs, rec } while a video capture plays
  ghosts: { A: null, B: null }, // translucent snapshot figures
  history: [], // undo stack of serialized couple states
  redoStack: [], // states walked back from, awaiting redo (cleared by any fresh edit)
  ui: null,

  // Undo: call before any change; Ctrl+Z / the Undo button walks back.
  pushHistory() {
    const s = JSON.stringify(this.getCoupleState('undo'));
    if (this.history[this.history.length - 1] === s) return;
    this.history.push(s);
    if (this.history.length > 60) this.history.shift();
    this.redoStack.length = 0; // a fresh edit invalidates the redo trail
    if (this.ui) this.ui.onHistoryChanged();
  },

  undo() {
    const s = this.history.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.getCoupleState('undo')));
    this.applyCoupleState(JSON.parse(s));
    if (this.ui) this.ui.onHistoryChanged();
  },

  // Redo: re-apply the last undone state; the state we leave goes back onto the
  // undo stack, so undo/redo walk the same history both ways.
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.history.push(JSON.stringify(this.getCoupleState('undo')));
    this.applyCoupleState(JSON.parse(s));
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
    // The dancer the user last touched, before deselect forgets it.
    const prev = this.selected?.figure ?? this.hipsState?.figure ?? this.activeFigure;
    this.mode = mode;
    this.pinPending = null; // a half-authored pin dies with its mode
    pinPendingMarker.visible = false;
    this.cancelDraw();      // …and so does a half-drawn annotation
    this.deselect();
    // Move hips needs no click: the handle appears right away on the
    // last-touched (else the first visible) dancer; clicking the other
    // dancer still moves it there.
    if (mode === 'hips') {
      const fig = (prev?.group.visible ? prev : null) ?? this.visibleFigures()[0];
      if (fig) this.selectFigure(fig);
    }
  },

  // ------------------------------------------------------------ contact pins
  // Pin-spots mode click: the first click stores a pending spot on that
  // dancer (re-clicking the same dancer moves it); a click on the OTHER
  // dancer completes the pin between the two spots. The spot lives in the
  // local frame of the nearest joint node, so it rides that body part.
  pinClick(figure, worldPoint) {
    const node = nearestJointNode(figure, worldPoint);
    if (!node) return;
    const local = figure.nodes[node].worldToLocal(worldPoint.clone());
    if (this.pinPending && this.pinPending.figure !== figure) {
      const first = this.pinPending;
      const second = { figure, node, local };
      const forRole = (fig) => {
        const e = first.figure === fig ? first : second;
        return { node: e.node, local: e.local };
      };
      pins.add(forRole(leader), forRole(follower));
      this.pinPending = null;
      pinPendingMarker.visible = false;
    } else {
      this.pinPending = { figure, node, local };
      pinPendingMarker.visible = true;
    }
    if (this.ui) this.ui.onPinsChanged();
  },

  // Scriptable pin (headless verification): each end { node, local: [x,y,z] }.
  addPin(leaderEnd, followerEnd) {
    pins.add(
      { node: leaderEnd.node, local: new THREE.Vector3(...leaderEnd.local) },
      { node: followerEnd.node, local: new THREE.Vector3(...followerEnd.local) },
    );
    if (this.ui) this.ui.onPinsChanged();
  },

  removePin(i) {
    pins.remove(i);
    if (this.ui) this.ui.onPinsChanged();
  },

  clearPins() {
    pins.clear();
    this.pinPending = null;
    pinPendingMarker.visible = false;
    if (this.ui) this.ui.onPinsChanged();
  },

  // ------------------------------------------------------------ floor drawings
  // Annotations are scene content, not pose state: they live outside the pose
  // undo stack and are managed by the Draw toolbar's ⌫ Last / Clear.
  setDrawTool(tool) {
    this.drawTool = tool;
    this.cancelDraw();
  },

  cancelDraw() {
    this.drawPending = null;
    drawings.clearPreview();
  },

  addDrawLine(a, b) {
    const o = drawings.addLine(toFloorV3(a), toFloorV3(b));
    this.ui?.onDrawingsChanged?.();
    return o;
  },

  addDrawArrow(a, b) {
    const o = drawings.addArrow(toFloorV3(a), toFloorV3(b));
    this.ui?.onDrawingsChanged?.();
    return o;
  },

  addDrawCircle(center, radius) {
    const o = drawings.addCircle(toFloorV3(center), radius);
    this.ui?.onDrawingsChanged?.();
    return o;
  },

  // Text reads right-way-up from the current camera unless a yaw is given.
  addDrawText(pos, text, yaw) {
    const p = toFloorV3(pos);
    const o = drawings.addText(p, String(text), yaw ?? textYawFromCamera(p));
    this.ui?.onDrawingsChanged?.();
    return o;
  },

  removeLastDrawing() {
    drawings.removeLast();
    this.ui?.onDrawingsChanged?.();
  },

  clearDrawings() {
    this.cancelDraw();
    drawings.clear();
    this.ui?.onDrawingsChanged?.();
  },

  // ------------------------------------------------------------ COG highlight
  // Draw a COG indicator through/in front of the dancers (it otherwise hides
  // inside the body). `which` = 'leader' | 'follower' | 'couple', or omit for
  // all three. Clicking a COG ball in the 3D view toggles the same state.
  setCogHighlight(on, which = null) {
    const targets = which ? [this.cogViz[which]].filter(Boolean) : Object.values(this.cogViz);
    for (const v of targets) v.setFront(on);
  },

  cogHighlight() {
    return { leader: vizLeader.front, follower: vizFollower.front, couple: vizCouple.front };
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
    this.moveHips(figure, { x: 0, y: y - figure.nodes.pelvis.position.y, z: 0 },
      { L: contacts.L.length > 0, R: contacts.R.length > 0 });
  },

  // Which feet the Move-hips mode keeps planted (UI checkboxes in the topbar;
  // auto-set from floor contact when a dancer is picked in that mode).
  hipsPlant: { L: true, R: true },

  // Translate a dancer's hips: the pelvis and everything above move together
  // (no posture angle changes), while each foot marked planted keeps its world
  // position AND sole orientation — the planted leg's hip/knee/ankle re-solve
  // to accommodate, as far as the joint limits allow. Unplanted legs ride
  // along rigidly. Horizontal goes through the figure root, vertical through
  // the pelvis joint (a crouch/rise, clamped to the hip-height slider range).
  // Returns the vertical delta actually applied.
  moveHips(figure, delta, planted = this.hipsPlant) {
    figure.group.updateMatrixWorld(true);
    const keep = [];
    for (const side of ['L', 'R']) {
      if (!planted[side]) continue;
      const ankle = figure.nodes[`ankle_${side}`];
      keep.push({
        side,
        pos: ankle.getWorldPosition(new THREE.Vector3()),
        quat: ankle.getWorldQuaternion(new THREE.Quaternion()),
      });
    }
    const H = figure.height;
    const py = THREE.MathUtils.clamp(figure.nodes.pelvis.position.y + (delta.y || 0), 0.34 * H, 0.58 * H);
    const dy = py - figure.nodes.pelvis.position.y;
    figure.group.position.x += delta.x || 0;
    figure.group.position.z += delta.z || 0;
    figure.nodes.pelvis.position.y = py;
    figure.group.updateMatrixWorld(true);
    for (const { side, pos, quat } of keep) {
      solveTwoBone(figure, {
        root: `hip_${side}`, mid: `knee_${side}`, effector: `ankle_${side}`, hingeSign: 1,
      }, pos);
      // Restore the sole's world orientation through the ankle joint.
      const ankle = figure.nodes[`ankle_${side}`];
      const parentQ = ankle.parent.getWorldQuaternion(new THREE.Quaternion());
      ankle.quaternion.copy(parentQ.invert().multiply(quat));
      figure.clampJoint(`ankle_${side}`);
    }
    figure.syncAtlasNodes();
    figure.group.updateMatrixWorld(true);
    return dy;
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

  // Tilt of the joined open-side hands, degrees from vertical (0 = fingers
  // straight up); the clasp constraint re-aims the hands every frame.
  setClaspTilt(deg) {
    this.embrace.setTilt(deg);
  },

  // Height of the joined open-side hands, fraction of mean stature above the
  // shoulders (0 = shoulder level); the elbows follow the clasp height.
  setClaspHeight(frac) {
    this.embrace.setClaspHeight(frac);
  },

  // Highlight body parts (Set of BODY_PARTS ids, empty/null clears).
  setHighlight(parts) {
    this.highlightParts = parts;
    for (const f of this.figures) f.setHighlight(parts);
  },

  // Muscles panel: hide (make transparent) / highlight (recolour) individual
  // bellies by label, across both dancers (see Figure.setMuscleHidden/Lit).
  setMuscleHidden(labels) {
    for (const f of this.figures) f.setMuscleHidden(labels);
  },
  setMuscleLit(labels) {
    for (const f of this.figures) f.setMuscleLit(labels);
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

  // ------------------------------------------------------------------ walking
  // Take one walking step (dir +1 forward, -1 back). Repeated calls alternate
  // feet, so the dancer walks. With "Move as couple" on the partner steps too
  // (facing the other way, they step back to travel the same direction), so the
  // whole embrace walks together.
  stepFigure(figure, dir = 1) {
    this.pushHistory();
    this.activeFigure = figure;
    const led = this.beginFigureStep(figure, dir);
    if (this.linkCouple) {
      const partner = this.figures.find((f) => f !== figure);
      if (partner && partner.group.visible) {
        const sameWay = figureForward(figure).dot(figureForward(partner)) >= 0;
        // The partner matches the initiator's stride AND mirrors the foot
        // (his left pairs her right): a facing couple's same-letter feet are
        // on opposite rails, so same-foot stepping drives the stepping leg
        // into the partner's standing leg and the couple jams leg-on-leg.
        // Facing the same way (shadow position) the feet pair unmirrored.
        this.beginFigureStep(partner, sameWay ? dir : -dir, STEP_STRIDE * figure.height,
          sameWay ? led.swing : (led.swing === 'L' ? 'R' : 'L'));
      }
    }
    if (this.ui) this.ui.onPoseChanged();
  },

  // Start one figure's step, animated through the roll/collection by the
  // render loop (animateSteps off = snap to the finished contact pose, the
  // old behavior). A re-press mid-step snaps the running step to its end
  // first, so rapid stepping stays responsive and never double-poses a leg.
  beginFigureStep(figure, dir, strideM = null, forceSwing = null) {
    const i = this.stepAnims.findIndex((a) => a.figure === figure);
    if (i >= 0) {
      finalizeStep(figure, this.stepAnims[i].st);
      this.stepAnims.splice(i, 1);
    }
    const st = beginStep(figure, dir, strideM, forceSwing);
    if (this.animateSteps) this.stepAnims.push({ figure, st, t: 0 });
    else finalizeStep(figure, st);
    return st;
  },

  // Slide a figure across the floor along its facing (Move-mode keyboard nudge);
  // the partner comes along when linked.
  slideFigure(figure, dist) {
    const d = figureForward(figure).multiplyScalar(dist);
    const move = (f) => { f.group.position.x += d.x; f.group.position.z += d.z; f.group.updateMatrixWorld(true); };
    move(figure);
    if (this.linkCouple) {
      const partner = this.figures.find((f) => f !== figure);
      if (partner) move(partner);
    }
  },

  // Turn a figure by a yaw delta, pivoting on the ball of its support foot; when
  // linked the partner orbits the same point, so the couple turns as one.
  turnFigure(figure, dYaw) {
    const pivotPt = this.ballOfFoot(figure, this.supportAnkle(figure));
    this.pivotFigure(figure, dYaw);
    if (this.linkCouple) {
      const partner = this.figures.find((f) => f !== figure);
      if (partner) rotateAbout(partner, pivotPt, dYaw);
    }
  },

  // Edit a joint honouring the current chain mode. `mutate` changes rotations.
  // Closed chain only applies to the legs/pelvis (arms/spine are always open).
  editJoint(figure, jointName, mutate) {
    const useClosed = this.chainMode === 'closed' && CHAIN_JOINTS.has(jointName);
    const anchor = useClosed ? this.anchorNode(figure, jointName) : null;
    if (anchor) {
      editWithAnchor(figure, anchor, () => { mutate(); figure.clampJoint(jointName); });
    } else {
      mutate();
      figure.clampJoint(jointName);
    }
    // Re-slave the skeletal limb bones (and their muscles) to the edited joints
    // so they pivot about the anatomical joints, then refresh world matrices.
    figure.syncAtlasNodes();
    figure.group.updateMatrixWorld(true);
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
    if (this.hipsState && !this.hipsState.figure.group.visible) this.deselect();
    // Move hips always offers a handle: re-seat it on a shown dancer.
    if (this.mode === 'hips' && !this.hipsState) {
      const fig = this.visibleFigures()[0];
      if (fig) this.selectFigure(fig);
    }
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
    this.activeFigure = null;
    this.ikState = null;
    this.swivelState = null;
    this.caressState = null;
    this.hipsState = null;
    ikTarget.visible = false;
    swivelTarget.visible = false;
    caressTarget.visible = false;
    hipsTarget.visible = false;
    tcontrols.detach();
    if (this.ui) this.ui.onSelectionChanged();
  },

  selectJoint(figure, jointName) {
    this.deselect();
    const def = JOINT_BY_NAME[jointName];
    if (def.endpoint) jointName = def.parent;
    this.selected = { figure, jointName };
    // Always start open chain (ordinary FK — rotate everything below the joint).
    // Closed chain stays a deliberate opt-in on the legs/pelvis: it moves the
    // BODY rather than the limb, which surprises you if you didn't ask for it.
    this.chainMode = 'open';
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

  // Drag an intermediate joint (elbow/knee) while its neighbours stay put: a
  // pole handle appears at the joint, and dragging it swivels the limb about
  // the root→effector axis (see swivelLimb) within the joint's freedom of
  // motion. `jointName` is the mid joint of a two-bone chain.
  startSwivel(figure, jointName) {
    const chain = swivelChainFor(jointName);
    if (!chain) return;
    this.deselect();
    this.selected = { figure, jointName: chain.mid };
    const sphere = figure.jointSphereByName[chain.mid];
    if (sphere) sphere.material.emissive.set(0x3b6ea5);
    this.swivelState = { figure, chain };
    figure.nodes[chain.mid].getWorldPosition(swivelTarget.position);
    swivelTarget.visible = true;
    tcontrols.setMode('translate');
    tcontrols.showX = tcontrols.showY = tcontrols.showZ = true;
    tcontrols.attach(swivelTarget);
    if (this.ui) this.ui.onSelectionChanged();
  },

  // Scriptable swivel (headless verification): roll the limb whose mid joint is
  // `jointName` so the elbow/knee reaches toward `target` ({x,y,z} or Vector3).
  swivelJoint(figure, jointName, target) {
    const chain = swivelChainFor(jointName);
    if (chain) swivelLimb(figure, chain, new THREE.Vector3(target.x, target.y, target.z));
  },

  // Drag a leg by its toe with the big toe kept ON the floor: a ring target
  // slides in the floor plane and the leg re-solves so the toe pad caresses
  // it — flat foot under the body, rolling up to a point as it reaches away
  // (see caressToe). Started by clicking a toes joint in Drag limb mode.
  startToeCaress(figure, side) {
    this.deselect();
    this.selected = { figure, jointName: `toes_${side}` };
    this.chainMode = 'open';
    const sphere = figure.jointSphereByName[`toes_${side}`];
    if (sphere) sphere.material.emissive.set(0x3b6ea5);
    this.caressState = { figure, side };
    figure.group.updateMatrixWorld(true);
    const tc = figure.toeCorners[`_${side}`];
    const pad = new THREE.Vector3(
      (tc[0][0] + tc[1][0]) / 2, (tc[0][1] + tc[1][1]) / 2, (tc[0][2] + tc[1][2]) / 2,
    ).multiplyScalar(figure.height);
    figure.nodes[`toes_${side}`].localToWorld(pad);
    caressTarget.position.set(pad.x, 0, pad.z);
    caressTarget.visible = true;
    tcontrols.setMode('translate');
    tcontrols.showX = tcontrols.showZ = true;
    tcontrols.showY = false;
    tcontrols.attach(caressTarget);
    if (this.ui) this.ui.onSelectionChanged();
  },

  // Scriptable caress (headless verification): big toe to (x, z) on the floor.
  caressFoot(figure, side, pt) {
    caressToe(figure, side, new THREE.Vector3(pt.x, 0, pt.z));
    figure.syncAtlasNodes();
    figure.group.updateMatrixWorld(true);
  },

  // PNG snapshot of the current 3D view, gizmos and drag handles hidden.
  photoDataURL() {
    const hidden = [];
    for (const o of [tcontrols, ikTarget, swivelTarget, caressTarget, hipsTarget,
      pins.group, pinPendingMarker]) {
      if (o.visible) { hidden.push(o); o.visible = false; }
    }
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    for (const o of hidden) o.visible = true;
    return url;
  },

  // Download the snapshot as tangle-<timestamp>.png (the 📷 Photo button).
  capturePhoto() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = this.photoDataURL();
    a.download = `tangle-${stamp}.png`;
    a.click();
  },

  selectFigure(figure) {
    this.deselect();
    this.activeFigure = figure;
    // Move mode drags the figure on the floor; turning is the arrow keys (they
    // pivot on the support foot). Step mode has no drag gizmo — clicking steps,
    // and the arrows step/turn — so the figure is only recorded as active.
    if (this.mode === 'move') {
      tcontrols.attach(figure.group);
      tcontrols.setMode('translate');
      tcontrols.showX = tcontrols.showZ = true;
      tcontrols.showY = false;
    } else if (this.mode === 'hips') {
      // Move-hips: a handle at the pelvis, draggable on all three axes. The
      // planted-feet checkboxes default to whichever feet touch the floor.
      figure.group.updateMatrixWorld(true);
      const contacts = footContactsBySide(figure);
      this.hipsPlant = { L: contacts.L.length > 0, R: contacts.R.length > 0 };
      figure.worldPos('pelvis', hipsTarget.position);
      hipsTarget.userData.figure = figure;
      hipsTarget.visible = true;
      this.hipsState = { figure, last: hipsTarget.position.clone() };
      tcontrols.attach(hipsTarget);
      tcontrols.setMode('translate');
      tcontrols.showX = tcontrols.showY = tcontrols.showZ = true;
      if (this.ui) this.ui.onHipsPlantChanged();
    }
  },

  applyPreset(index) {
    const preset = PRESETS[index];
    if (!preset) return;
    this.pushHistory();
    this.deselect();
    preset.apply(leader, follower);
    // Move hips keeps offering its handle across pose changes.
    if (this.mode === 'hips') this.setMode('hips');
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
    applyStatesT([this.interpStates.A, this.interpStates.B], t);
  },

  playInterp(onTick) {
    if (!this.interpStates) return;
    this.seqPlaying = false; // one player at a time
    this.interpT = 0;
    this.interpPlaying = true;
    this.interpTick = onTick || null;
  },

  setPathVisible(visible) {
    trailGroup.visible = visible;
  },

  // -------------------------------------------------- movement sequence
  // A timeline of couple-state keyframes — the A→B compare generalized to a
  // whole figure (a giro is 4+ poses, not 2). The scrubber/player lerp each
  // consecutive pair exactly like A→B; the COG trail covers all segments.

  // The keyframe chain the COG floor trail traces: the sequence when it has
  // one, else the A/B pair.
  trailStates() {
    if (this.seqStates.length >= 2) return this.seqStates;
    return this.interpStates ? [this.interpStates.A, this.interpStates.B] : null;
  },

  onSeqChanged() {
    if (this.seqStates.length < 2) this.seqPlaying = false;
    updateCogTrail();
    if (this.ui) this.ui.onSequenceChanged();
  },

  // Insert the current couple pose as a keyframe (appended by default).
  seqAdd(index = this.seqStates.length) {
    this.seqStates.splice(index, 0, this.getCoupleState(`Keyframe ${this.seqStates.length + 1}`));
    this.onSeqChanged();
  },

  // Overwrite keyframe i with the current couple pose.
  seqUpdate(i) {
    if (!this.seqStates[i]) return;
    this.seqStates[i] = this.getCoupleState(this.seqStates[i].name);
    this.onSeqChanged();
  },

  seqDelete(i) {
    this.seqStates.splice(i, 1);
    this.onSeqChanged();
  },

  // Swap keyframe i with its neighbour at i + di (di = ±1).
  seqMove(i, di) {
    const j = i + di;
    if (!this.seqStates[i] || !this.seqStates[j]) return;
    [this.seqStates[i], this.seqStates[j]] = [this.seqStates[j], this.seqStates[i]];
    this.onSeqChanged();
  },

  // Jump the couple to keyframe i.
  seqApply(i) {
    if (!this.seqStates[i]) return;
    this.pushHistory();
    this.applyCoupleState(this.seqStates[i]);
  },

  // Bulk replace (import / session restore).
  setSeqStates(states) {
    this.seqStates = Array.isArray(states) ? states : [];
    this.onSeqChanged();
  },

  // Pose the couple at t ∈ [0, 1] across the whole sequence (the scrubber).
  applySeqT(t) {
    if (this.seqStates.length < 2) return;
    if (this.selected || this.ikState) this.deselect();
    this.seqT = t;
    applyStatesT(this.seqStates, t);
  },

  playSeq(onTick, onDone = null) {
    if (this.seqStates.length < 2) return;
    this.interpPlaying = false; // one player at a time
    this.seqT = 0;
    this.seqPlaying = true;
    this.seqTick = onTick || null;
    this.seqDone = onDone;
  },

  // -------------------------------------------------- animation export
  // Play a keyframe chain while recording the 3D canvas, then download the
  // capture as a .webm — class material from the same view the teacher posed.
  // `states` is any couple-state chain ([A, B] or the sequence). Returns false
  // if a capture is already running or the chain can't play.
  recordPlayback(states, name = 'tangle-movement') {
    if (this.recording || !states || states.length < 2) return false;
    if (typeof MediaRecorder === 'undefined' || !renderer.domElement.captureStream) {
      console.warn('MediaRecorder is not available in this browser.');
      return false;
    }
    this.deselect(); // also hides every gizmo/handle
    this.interpPlaying = false;
    this.seqPlaying = false;
    const stream = renderer.domElement.captureStream(60);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.webm`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.recording = null;
      if (this.ui) this.ui.onRecordingChanged();
    };
    applyStatesT(states, 0); // first frames show the start pose, not the editor state
    this.recording = { states, t: 0, secs: SEQ_SEG_SECONDS * (states.length - 1), rec };
    rec.start();
    if (this.ui) this.ui.onRecordingChanged();
    return true;
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

// Muscle catalog for the Muscles panel: unique bellies (deduped by label, each
// tagged with its region node), or empty when the muscle atlas failed to load.
app.muscles = muscleMeshes
  ? [...new Map(muscleMeshes.muscles.map((m) => [m.label, m.node])).entries()]
    .map(([label, node]) => ({ label, node }))
  : [];

// When a drag begins: snapshot for undo, remember the closed-chain anchor so
// we can pin it back each frame, and capture start transforms for a linked
// couple drag.
tcontrols.addEventListener('dragging-changed', (e) => {
  if (!e.value) { app.ckc = null; app.coupleDrag = null; app.figDragY = null; return; }
  app.pushHistory();
  if (app.hipsState && tcontrols.object === hipsTarget) {
    // Hips drag: deltas accumulate from here (see the objectChange handler);
    // the figure-drag captures below must not see the handle as a figure.
    app.hipsState.last.copy(hipsTarget.position);
    return;
  }
  if (!app.selected && tcontrols.object?.userData.figure) {
    app.figDragY = tcontrols.object.position.y;
  }
  if (app.selected && !app.ikState && app.chainMode === 'closed' && CHAIN_JOINTS.has(app.selected.jointName)) {
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

// Re-solve whatever the active drag handle (IK target / swivel pole / caress
// ring / hips handle) drives, from the handle's current position. Shared by
// the gizmo's objectChange and the keyboard nudges; returns false when no
// handle is active.
function applyHandleChange() {
  if (app.ikState) {
    // Keep the IK target where the limb can reach without going underground.
    const H = app.ikState.figure.height;
    const minY = app.ikState.chain.effector.startsWith('ankle') ? 0.039 * H : 0.115 * H;
    if (ikTarget.position.y < minY) ikTarget.position.y = minY;
    solveTwoBone(app.ikState.figure, app.ikState.chain, ikTarget.position);
  } else if (app.swivelState) {
    // The pole handle stays where dragged; the elbow swivels to aim at it.
    swivelLimb(app.swivelState.figure, app.swivelState.chain, swivelTarget.position);
    if (app.ui) app.ui.refreshJointValues();
  } else if (app.caressState) {
    // The ring stays on the floor; the leg re-solves so the toe pad rests on it.
    caressTarget.position.y = 0;
    caressToe(app.caressState.figure, app.caressState.side, caressTarget.position);
    if (app.ui) app.ui.refreshJointValues();
  } else if (app.hipsState && tcontrols.object === hipsTarget) {
    // Hips drag: apply the handle's delta; planted feet stay put via leg IK.
    // The vertical axis clamps at the crouch range — track the applied height
    // so a clamped drag can't accumulate.
    const { figure, last } = app.hipsState;
    const delta = hipsTarget.position.clone().sub(last);
    const dy = app.moveHips(figure, delta, app.hipsPlant);
    last.copy(hipsTarget.position);
    last.y += dy - delta.y;
    hipsTarget.position.y = last.y;
    if (app.ui) app.ui.refreshJointValues();
  } else {
    return false;
  }
  return true;
}

tcontrols.addEventListener('objectChange', () => {
  if (applyHandleChange()) {
    // an active drag handle consumed the change
  } else if (app.selected) {
    app.selected.figure.clampJoint(app.selected.jointName);
    if (app.ckc) pinAnchor(app.ckc.figure, app.ckc.node, app.ckc.matrix);
    if (app.ui) app.ui.refreshJointValues();
  } else if (tcontrols.object) {
    // Figures stay at their drag-start height (usually the floor).
    if (app.figDragY !== null) tcontrols.object.position.y = app.figDragY;
    if (app.coupleDrag) {
      // Mirror the drag onto the partner: same translation, and rotation
      // about the dragged dancer so the embrace turns as one unit.
      const { dragged, other, draggedPos, draggedYaw, otherPos, otherYaw } = app.coupleDrag;
      const dYaw = dragged.group.rotation.y - draggedYaw;
      const rel = otherPos.clone().sub(draggedPos).applyAxisAngle(_UP, dYaw);
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

// Hover feedback: glow the joint under the cursor (rotate / drag modes) or show
// a pointer over a draggable dancer (move / walk modes).
//
// In body view the pick spheres are invisible AND buried inside the opaque
// avatar, so a glow alone never reaches the screen — you can't pick what you
// can't see. Hovering a dancer there ghosts that dancer's whole joint set
// through the skin and lights the one under the cursor. `depthTest` off is what
// draws them through the body; `renderOrder` keeps them above the skin they
// punch through. Skeleton view already shows the spheres over visible bones, so
// it keeps its flat 0.22 look and normal depth sorting.
const HOVER_EMISSIVE = 0xf5b942;
const SELECT_EMISSIVE = 0x3b6ea5;
const GHOST_OPACITY = 0.3; // the hovered dancer's other joints
let hoverSphere = null;
let hoverFigure = null;

// The pick sphere's opacity when not hovered: faintly shown in skeleton view,
// invisible (but still clickable) otherwise — mirrors Figure.setLayers.
function restingOpacity(figure) {
  return figure.layers && figure.layers.skeleton ? 0.22 : 0;
}

function styleSphere(sphere, figure, { ghost = false, lit = false } = {}) {
  const { jointName } = sphere.userData;
  const isSel = app.selected && app.selected.figure === figure && app.selected.jointName === jointName;
  // Only body view needs the see-through treatment; skeleton view would just
  // make the spheres float over their own bones.
  const showThrough = (ghost || lit) && !(figure.layers && figure.layers.skeleton);
  sphere.material.emissive.set(lit ? HOVER_EMISSIVE : (isSel ? SELECT_EMISSIVE : 0x000000));
  sphere.material.opacity = lit ? 0.85 : (ghost ? GHOST_OPACITY : restingOpacity(figure));
  sphere.material.depthTest = !showThrough;
  sphere.renderOrder = showThrough ? 3 : 0;
}

function clearHover() {
  if (hoverFigure) {
    for (const s of hoverFigure.pickSpheres) styleSphere(s, hoverFigure);
    hoverFigure = null;
  }
  hoverSphere = null;
  renderer.domElement.style.cursor = '';
}

// `figure` is the dancer under the cursor, `sphere` the joint under it (may be
// null — over the body but not over a joint).
function setHover(figure, sphere) {
  if (figure !== hoverFigure) {
    clearHover();
    hoverFigure = figure;
    for (const s of figure.pickSpheres) styleSphere(s, figure, { ghost: true });
  }
  if (sphere !== hoverSphere) {
    if (hoverSphere) styleSphere(hoverSphere, figure, { ghost: true });
    if (sphere) styleSphere(sphere, figure, { ghost: true, lit: true });
    hoverSphere = sphere;
  }
  renderer.domElement.style.cursor = sphere ? 'pointer' : '';
}

// A joint is actionable in drag mode only if it starts an IK chain (hand/foot)
// or an elbow/knee swivel; in rotate mode every joint can be posed.
function jointActionable(jointName) {
  if (app.mode === 'ik') return !!(IK_CHAINS[jointName] || swivelChainFor(jointName));
  return true;
}

renderer.domElement.addEventListener('pointerleave', clearHover);
renderer.domElement.addEventListener('pointermove', (e) => {
  if (downPos || tcontrols.dragging) return; // don't fight a click, gizmo drag, or orbit
  pointerRay(e);
  const visible = app.visibleFigures();

  if (app.mode === 'draw') {
    clearHover();
    renderer.domElement.style.cursor = 'crosshair';
    if (app.drawPending) {
      const p = floorPointAtPointer();
      if (p) drawings.showPreview(app.drawTool, app.drawPending, p);
    }
    return;
  }

  if (app.mode === 'move' || app.mode === 'step' || app.mode === 'hips' || app.mode === 'pin') {
    clearHover();
    const hits = raycaster.intersectObjects(visible.map((f) => f.group), true);
    renderer.domElement.style.cursor = hits.some((h) => h.object.visible) ? 'pointer' : '';
    return;
  }

  const spheres = visible.flatMap((f) => f.pickSpheres);
  const hit = raycaster.intersectObjects(spheres, false)
    .find((h) => jointActionable(h.object.userData.jointName));
  // Ghost in the joints of whichever dancer the cursor is over, not just when
  // it happens to land on a joint — the spheres are small and, in body view,
  // invisible until then.
  let figure = hit ? hit.object.userData.figure : null;
  if (!figure) {
    const bodyHit = raycaster.intersectObjects(visible.map((f) => f.group), true)
      .find((h) => h.object.visible && !h.object.userData.isPick);
    for (let n = bodyHit && bodyHit.object; n && !figure; n = n.parent) {
      figure = visible.find((f) => f.group === n) || null;
    }
  }
  if (figure) setHover(figure, hit ? hit.object : null);
  else clearHover();
});

// Clicking a COG ball toggles drawing that COG indicator in front of the
// dancers. A highlighted (in-front) ball wins the click outright — it is what
// the user sees over everything else — otherwise the nearest of ball vs.
// whatever the mode would pick wins, so joint/figure picking stays intact.
function cogBallHit() {
  const balls = [vizLeader, vizFollower, vizCouple].map((v) => v.cogBall).filter((b) => b.visible);
  return raycaster.intersectObjects(balls, false)[0] ?? null;
}

function cogWinsClick(cogHit, otherHit) {
  if (!cogHit) return false;
  return cogHit.object.userData.viz.front || !otherHit || cogHit.distance <= otherHit.distance;
}

function toggleCogHit(hit) {
  const viz = hit.object.userData.viz;
  viz.setFront(!viz.front);
}

// Two-click authoring on the floor plane: the first click anchors the shape,
// the second commits it (Text is a single click + prompt). A click that
// misses the floor cancels the pending shape; so does Esc or a mode change.
function handleDrawClick() {
  const p = floorPointAtPointer();
  if (!p) { app.cancelDraw(); return; }
  if (app.drawTool === 'text') {
    const text = window.prompt('Label to write on the floor:');
    if (text && text.trim()) app.addDrawText(p, text.trim());
    return;
  }
  if (!app.drawPending) {
    app.drawPending = p.clone();
    drawings.showPreview(app.drawTool, app.drawPending, p);
    return;
  }
  const a = app.drawPending;
  app.cancelDraw();
  if (app.drawTool === 'line') app.addDrawLine(a, p);
  else if (app.drawTool === 'arrow') app.addDrawArrow(a, p);
  else if (app.drawTool === 'circle') app.addDrawCircle(a, a.distanceTo(p));
}

function handleClick(e) {
  pointerRay(e);

  const cogHit = cogBallHit();

  if (app.mode === 'draw') {
    // Mid-shape, floor clicks always continue the drawing; otherwise the COG
    // ball keeps its toggle even in Draw mode.
    if (!app.drawPending && cogHit) { toggleCogHit(cogHit); return; }
    handleDrawClick();
    return;
  }

  const visible = app.visibleFigures();
  if (app.mode === 'pin') {
    // Author a contact pin: a spot on one dancer, then a spot on the other.
    // Pick spheres are invisible raycast targets — a pin wants the surface.
    const hits = raycaster.intersectObjects(visible.map((f) => f.group), true);
    const hit = hits.find((h) => h.object.visible && !h.object.userData.isPick);
    if (hit) {
      let o = hit.object;
      while (o && !o.userData.figure) o = o.parent;
      if (o) app.pinClick(o.userData.figure, hit.point);
    } else {
      app.pinPending = null;
      pinPendingMarker.visible = false;
      if (app.ui) app.ui.onPinsChanged();
    }
    return;
  }
  if (app.mode === 'move' || app.mode === 'step' || app.mode === 'hips') {
    const hits = raycaster.intersectObjects(visible.map((f) => f.group), true);
    const hit = hits.find((h) => h.object.visible);
    if (cogWinsClick(cogHit, hit)) { toggleCogHit(cogHit); return; }
    if (hit) {
      let o = hit.object;
      while (o && !o.userData.figure) o = o.parent;
      if (o) {
        app.selectFigure(o.userData.figure);
        // In Step mode a click on a dancer takes one step forward — keep
        // clicking to walk. The arrow keys step/turn the same dancer.
        if (app.mode === 'step') app.stepFigure(o.userData.figure, 1);
      }
    } else if (app.mode !== 'hips') app.deselect(); // hips keeps its auto handle
    return;
  }

  const spheres = visible.flatMap((f) => f.pickSpheres);
  const hits = raycaster.intersectObjects(spheres, false);
  if (cogWinsClick(cogHit, hits[0])) { toggleCogHit(cogHit); return; }
  if (hits.length === 0) {
    app.deselect();
    return;
  }
  const { figure, jointName } = hits[0].object.userData;
  if (app.mode === 'ik') {
    // The toes start a floor caress (big toe pinned to the floor); the other
    // effectors keep the free-space IK drag.
    const toe = jointName.match(/^(?:toes|toe)_(L|R)$/);
    if (toe) app.startToeCaress(figure, toe[1]);
    else if (IK_CHAINS[jointName]) app.startIK(figure, jointName);
    else if (swivelChainFor(jointName)) app.startSwivel(figure, jointName);
    // clicks on other joints in drag mode are ignored
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
  // A stepping dancer is the active mover: the embrace pull and the body
  // collision displace the partner, never the dancer mid-step (a leader
  // walking into the follower moves her — the sacada convention).
  if (app.stepAnims.length) return { figure: app.stepAnims[0].figure, jointName: null };
  return null;
}

// The one arm the user is posing right now, as { figure, side } for body
// collision (so it can't be pushed through the partner) — null unless the edit
// targets an arm joint. See resolveBodyCollision.
const ARM_JOINT = /^(?:scapula|shoulder|elbow|wrist|hand)_(L|R)$/;
function editedArm(editing) {
  const m = editing?.jointName?.match(ARM_JOINT);
  return m ? { figure: editing.figure, side: m[1] } : null;
}

const clock = new THREE.Clock();
let statsTimer = 0;
let vizFlags = { cog: true, support: true, couple: true, dissoc: false };

function applyVizVisibility() {
  const both = leader.group.visible && follower.group.visible;
  vizLeader.setVisible(vizFlags.cog && leader.group.visible, vizFlags.support && leader.group.visible);
  vizFollower.setVisible(vizFlags.cog && follower.group.visible, vizFlags.support && follower.group.visible);
  vizCouple.setVisible(vizFlags.couple && both, vizFlags.couple && vizFlags.support && both);
  dissocLeader.setVisible(vizFlags.dissoc && leader.group.visible);
  dissocFollower.setVisible(vizFlags.dissoc && follower.group.visible);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  orbit.update();

  if (app.interpPlaying) {
    app.interpT = Math.min(1, app.interpT + dt / SEQ_SEG_SECONDS);
    app.applyInterp(app.interpT);
    if (app.interpTick) app.interpTick(app.interpT);
    if (app.interpT >= 1) app.interpPlaying = false;
  }

  // Advance the movement-sequence player (Play button in the Sequence panel).
  if (app.seqPlaying) {
    const segs = app.seqStates.length - 1;
    if (segs < 1) app.seqPlaying = false;
    else {
      app.seqT = Math.min(1, app.seqT + dt / (SEQ_SEG_SECONDS * segs));
      applyStatesT(app.seqStates, app.seqT);
      if (app.seqTick) app.seqTick(app.seqT);
      if (app.seqT >= 1) {
        app.seqPlaying = false;
        const done = app.seqDone;
        app.seqDone = null;
        if (done) done();
      }
    }
  }

  // Advance a video capture's playback; stop the recorder shortly after the
  // final pose so the last frames make it into the file.
  if (app.recording) {
    const r = app.recording;
    r.t = Math.min(1, r.t + dt / r.secs);
    applyStatesT(r.states, r.t);
    if (r.t >= 1 && !r.stopping) {
      r.stopping = true;
      setTimeout(() => r.rec.stop(), 150);
    }
  }

  // Advance in-flight walking steps: roll the body over the support foot,
  // collect the swing foot past it, land on the contact pose (see poseStep).
  for (let i = app.stepAnims.length - 1; i >= 0; i--) {
    const anim = app.stepAnims[i];
    anim.t += dt;
    if (anim.t >= STEP_DURATION) {
      finalizeStep(anim.figure, anim.st);
      app.stepAnims.splice(i, 1);
    } else {
      poseStep(anim.figure, anim.st, smoothstep(anim.t / STEP_DURATION));
    }
  }

  // Keep the embrace through whatever moved this frame: torso contact first
  // (it translates a dancer), the floor clamp, then re-join the hands (arm
  // rotations only, so they cannot disturb the floor contact).
  const editing = embraceEditing();
  embrace.maintainTorso(editing?.figure ?? null);

  // Contact pins, translation half: a pin whose adapting end rides the torso
  // slides that dancer, so it runs with the torso pull — before collision and
  // the floor clamp, which both get to push back.
  pins.maintainBody(editing?.figure ?? null);

  // Body collision: the dancers may touch but never enter each other's
  // space — resolve any capsule penetration by sliding the partner of
  // whoever is being edited (see collision.js). The arm currently being posed
  // is also a collider, so it can't be pushed through the partner (it displaces
  // them instead); the resting/wrapping embrace arms are not (they lie on the
  // partner by design). `editedArm` names that one arm.
  resolveBodyCollision(leader, follower, editing?.figure ?? null, editedArm(editing));

  // Floor collision: no body part may end up below the dance floor,
  // whatever edit produced the pose (gizmo, slider, IK, preset, import).
  leader.clampToFloor();
  follower.clampToFloor();

  embrace.maintainHands(editing);

  // Contact pins, limb half: an adapting arm/leg re-solves so its pinned spot
  // reaches the partner's. After the embrace hands so a pin on an embrace arm
  // deliberately wins (the pin is the more specific intent).
  pins.maintainLimbs(editing?.figure ?? null);
  pins.updateVisuals();
  if (app.pinPending) {
    app.pinPending.figure.nodes[app.pinPending.node].localToWorld(
      pinPendingMarker.position.copy(app.pinPending.local),
    );
  }

  // Pivot the skeletal limb bones about their anatomical joints (the embrace,
  // collision and IK above all move rig joints directly, so re-slave the atlas
  // sub-tree before this frame renders).
  leader.syncAtlasNodes();
  follower.syncAtlasNodes();

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

  if (vizFlags.dissoc) {
    if (leader.group.visible) dissocLeader.update(leader);
    if (follower.group.visible) dissocFollower.update(follower);
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

// Esc abandons a half-authored floor drawing.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') app.cancelDraw();
});

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  const redo = (k === 'z' && e.shiftKey) || k === 'y';
  const undo = k === 'z' && !e.shiftKey;
  if (!undo && !redo) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'range') return;
  e.preventDefault();
  if (redo) app.redo();
  else app.undo();
});

// Keyboard nudges — one small change per key event, so a tap nudges a little
// and holding a key moves continuously (the OS key-repeat re-fires keydown);
// Shift makes any nudge coarser. What the keys drive depends on what's active:
//   Move / Step modes (the active figure): arrows slide/turn or step/turn,
//     pivoting on the support foot. "Move as couple" drives the pair.
//   A selected joint (Rotate joints): ↑/↓ drive its X axis (↑ = hip/shoulder
//     forward, ankle toes-up, knee straighten), ←/→ its Z — the side-to-side
//     axis (Y where there is no Z), PageUp/PageDown its Y twist.
//   A drag handle (hand/foot IK target, elbow/knee swivel pole, toe-caress
//     ring, hips handle): arrows move it across the floor relative to the
//     camera (↑ = away from the camera), PageUp/PageDown raise/lower it.
const NUDGE_DIST = 0.03;                  // metres per press when sliding a figure
const NUDGE_TURN = 4 * Math.PI / 180;     // radians per press when turning
const STEP_TURN = 8 * Math.PI / 180;      // radians per press when turning in Step mode
const ROT_NUDGE = 2 * DEG;                // radians per press on a selected joint
const HANDLE_NUDGE = 0.012;               // metres per press on a drag handle
const NUDGE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);
const _nudgeDir = new THREE.Vector3();
let lastNudge = 0;

// One undo entry per burst of nudges.
function nudgeHistory() {
  const now = performance.now();
  if (now - lastNudge > 500) app.pushHistory();
  lastNudge = now;
}

// Where a handle nudge moves in world space: arrows in the floor plane
// relative to the camera (↑ away from it), PageUp/PageDown straight up/down.
function nudgeDirection(key, out) {
  if (key === 'PageUp') return out.set(0, 1, 0);
  if (key === 'PageDown') return out.set(0, -1, 0);
  camera.getWorldDirection(out);
  out.y = 0;
  if (out.lengthSq() < 1e-6) {
    // Top view: the view direction has no floor component — pan along screen-up.
    out.set(0, 1, 0).applyQuaternion(camera.quaternion);
    out.y = 0;
  }
  if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
  out.normalize();
  if (key === 'ArrowDown') return out.negate();
  if (key === 'ArrowRight') return out.set(-out.z, 0, out.x);
  if (key === 'ArrowLeft') return out.set(out.z, 0, -out.x);
  return out; // ArrowUp
}

window.addEventListener('keydown', (e) => {
  if (!NUDGE_KEYS.has(e.key)) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'range') return;
  if (tcontrols.dragging) return; // don't fight a live mouse drag
  const k = e.key;
  const coarse = e.shiftKey ? 3 : 1;

  // Move / Step: drive the active figure (arrows only).
  if (app.mode === 'move' || app.mode === 'step') {
    const fig = app.activeFigure;
    if (!fig || !fig.group.visible || !k.startsWith('Arrow')) return;
    e.preventDefault();
    nudgeHistory();
    if (app.mode === 'step') {
      if (k === 'ArrowUp') app.stepFigure(fig, 1);
      else if (k === 'ArrowDown') app.stepFigure(fig, -1);
      else if (k === 'ArrowLeft') app.turnFigure(fig, STEP_TURN);
      else if (k === 'ArrowRight') app.turnFigure(fig, -STEP_TURN);
    } else if (k === 'ArrowUp') app.slideFigure(fig, NUDGE_DIST * coarse);
    else if (k === 'ArrowDown') app.slideFigure(fig, -NUDGE_DIST * coarse);
    else if (k === 'ArrowLeft') app.turnFigure(fig, NUDGE_TURN * coarse);
    else if (k === 'ArrowRight') app.turnFigure(fig, -NUDGE_TURN * coarse);
    return;
  }

  // A drag handle up (limb IK / swivel / toe caress / hips): nudge it and
  // re-solve, exactly as if the gizmo had moved it.
  const handle = app.ikState ? ikTarget
    : app.swivelState ? swivelTarget
      : app.caressState ? caressTarget
        : app.hipsState ? hipsTarget : null;
  if (handle) {
    e.preventDefault();
    nudgeHistory();
    handle.position.addScaledVector(nudgeDirection(k, _nudgeDir), HANDLE_NUDGE * coarse);
    applyHandleChange();
    return;
  }

  // A selected joint (Rotate joints mode): drive its free axes.
  if (app.selected) {
    const { figure, jointName } = app.selected;
    const limits = JOINT_BY_NAME[jointName].limits;
    const free = (ax) => limits[ax][0] !== limits[ax][1];
    let axis;
    let sign;
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      axis = 'x';
      sign = k === 'ArrowUp' ? -1 : 1; // ↑ lifts: hip/shoulder forward, toes up, knee straight
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      axis = free('z') ? 'z' : 'y';
      sign = k === 'ArrowRight' ? 1 : -1;
    } else {
      axis = 'y';
      sign = k === 'PageUp' ? 1 : -1;
    }
    if (!free(axis)) return;
    e.preventDefault();
    nudgeHistory();
    app.editJoint(figure, jointName, () => {
      figure.nodes[jointName].rotation[axis] += sign * ROT_NUDGE * coarse;
    });
    if (app.ui) app.ui.refreshJointValues();
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
