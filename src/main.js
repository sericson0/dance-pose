import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Figure } from './figure.js';
import {
  IK_CHAINS, JOINT_BY_NAME, JOINT_TITLES, ANCHOR_FOR, DEG, legChain, ANKLE_REST_FRAC, PART_COLOR,
} from './skeletonDef.js';
import { solveTwoBone, swivelLimb, editWithAnchor, pinAnchor, feetToFloor, flattenFoot } from './ik.js';
import { balanceReport, coupleReport, footContactsBySide } from './analysis.js';
import { PRESETS } from './presets.js';
import { loadSkeletonBones, loadMuscleMeshes, loadBodyMesh } from './skeletonMesh.js';
import { Embrace } from './embrace.js';
import {
  ContactPins, nearestJointNode, spotNode, STRAIN_COLOR, makeStrainLine, setStrainLine,
} from './pins.js';
import { resolveBodyCollision, bodyClearance, bodyContacts } from './collision.js';
import { Drawings } from './draw.js';
import { createStudio } from './studio.js';
import { initUI } from './ui.js';

// ---------------------------------------------------------------- scene
const container = document.getElementById('viewport');
// alpha: the "transparent" backdrop (studio.js) exports PNGs with no background;
// every other backdrop paints an opaque scene.background, so nothing else changes.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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
// Every asset below has a working fallback, so a failed load never stops the
// app — but it does hand the user a DIFFERENT app (procedural bones, a plain
// mannequin, no atlas to label), which used to be announced only to the
// developer console. Each failure appends its own plain sentence here; main.js
// surfaces the list once the UI exists (status line + a note in the View
// panel), in the shape of the Muscles panel's "atlas unavailable" line.
const degraded = [];

// Imported anatomical skeleton (CC-BY-SA, see public/models/ATTRIBUTION.md).
// Loaded once and shared; on failure we fall back to the procedural bones.
let skeletonBones = null;
try {
  skeletonBones = await loadSkeletonBones(`${import.meta.env.BASE_URL}models/skeleton.glb`);
} catch (err) {
  console.warn('Skeleton mesh failed to load; using procedural bones.', err);
  degraded.push('Skeleton atlas unavailable — showing simplified bones.');
}

// Imported main-mover muscles (same atlas, so they need the skeleton's scale).
// Loaded only when the skeleton did; on failure we fall back to procedural bellies.
let muscleMeshes = null;
if (skeletonBones) {
  try {
    muscleMeshes = await loadMuscleMeshes(`${import.meta.env.BASE_URL}models/muscles.glb`);
  } catch (err) {
    console.warn('Muscle mesh failed to load; using procedural muscles.', err);
    degraded.push('Muscle atlas unavailable — showing simplified muscle shapes.');
  }
}

// Imported clothed body avatars (Microsoft Rocketbox, MIT). Loaded per role;
// on failure that figure falls back to the procedural mannequin body.
async function tryLoadBody(file, who) {
  try {
    return await loadBodyMesh(`${import.meta.env.BASE_URL}models/${file}`);
  } catch (err) {
    console.warn(`Body avatar ${file} failed to load; using the mannequin body.`, err);
    degraded.push(`The ${who}'s clothed avatar is unavailable — showing a plain mannequin.`);
    return null;
  }
}
const [manBody, womanBody] = await Promise.all([
  tryLoadBody('man.glb', 'leader'), tryLoadBody('woman.glb', 'follower'),
]);

// soleScale fits each figure's balance footprint to its OWN rendered shoe (the
// shared corner tables in skeletonDef.js are sized to the man's): the woman's
// heeled shoe tip sits 0.068H ahead of her ankle vs the man's 0.087H, so her
// forward corners pull in by 0.78.
const leader = new Figure({ name: 'Leader', height: 1.78, mass: 75, color: 0x4d8fd1, skeleton: skeletonBones, muscles: muscleMeshes, body: manBody, bodyKey: 'man' });
// The woman avatar's shoe ALREADY has a real molded heel (measured ≈2.9 cm ≈
// 0.0175 H — the shoe's own heel raises her instep that far above the ball, heel
// and ball both grounded). So she stands on that heel natively (heelRise 0, no
// fake ankle raise/pitch that floated her en-pointe); `moldedHeel` only pitches
// the bare skeleton foot up inside the shoe and sizes the skeleton heel wedge.
// footNarrow squeezes her bare skeletal foot laterally into her narrower shoe:
// the atlas foot's little-toe/5th-metatarsal edge otherwise pokes ~1 cm past the
// shoe at the ball (the foot fit matches shoe length/aim but not width). The
// leader's wider shoe already contains his foot, so he keeps the default 1.
// Side effect: the intentionally narrower foot widens her toe_tip skeleton-vs-
// shoe layer gap to ~30 mm at the hardest pose (forward-ocho) — dev-verify-frames
// REPORTS this (soft, non-gating) but still exits 0; it's the "different sizes"
// the design deliberately allows, not a regression.
const follower = new Figure({ name: 'Follower', height: 1.65, mass: 60, color: 0xc95f8e, skin: 0xe0b092, skeleton: skeletonBones, muscles: muscleMeshes, body: womanBody, bodyKey: 'woman', moldedHeel: 0.0175, soleScale: { front: 0.78 }, footNarrow: 0.82 });
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
    solveTwoBone(figure, legChain(side), _gfPos);
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

// A SECOND gizmo, used only in Move mode: a yaw ring shown AROUND the slide
// arrows so the same handle both slides and turns a figure — the arrows in the
// middle to drag it across the floor, the ring outside to spin it about the
// chosen pivot (the "Turn about" dropdown). It replaces the old Slide/Turn
// toggle: one gizmo, grab whichever part you want. Larger than tcontrols so
// the ring encircles the arrows instead of tangling with them. It drives the
// same figTurn path as the arrow keys (see its handlers below).
const turnControls = new TransformControls(camera, renderer.domElement);
turnControls.setSpace('local');
turnControls.size = 1.0;
turnControls.setMode('rotate');
turnControls.showX = turnControls.showZ = false; // yaw only — dancers never tip
turnControls.showY = true;
turnControls.visible = false;
scene.add(turnControls);
turnControls.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (!e.value) { app.figTurn = null; return; }
  app.pushHistory(); // this gizmo has its own drag, so it must snapshot for undo
  beginFigureTurn(turnControls.object?.userData.figure);
});
turnControls.addEventListener('objectChange', applyFigureTurn);

// Is EITHER gizmo being dragged? Every drag guard must ask this, not
// `tcontrols.dragging` alone: Move mode attaches both, and a short turn on the
// yaw ring (under the 6 px click threshold) used to fall through to handleClick
// — which re-raycasts, misses the dancer, and deselects, so the handle vanished
// mid-turn.
const gizmoDragging = () => tcontrols.dragging || turnControls.dragging;

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

// Each handle's resting colour, so the strain amber below can be undone.
ikTarget.userData.baseColor = ikTarget.material.color.getHex();
swivelTarget.userData.baseColor = swivelTarget.material.color.getHex();
caressTarget.children[0].userData.baseColor = caressTarget.children[0].material.color.getHex();

// ----------------------------------------------- out-of-reach drag handles
// The IK target, the swivel pole and the toe-caress ring all keep following
// the cursor after the body has stopped following THEM: solveTwoBone clamps
// the target to the limb's reach, swivelLimb bisects down to the largest
// feasible roll, and caressToe pulls its goal back toward the hip until the
// toe can still touch the floor. The handle then sits somewhere the dancer
// is not, with nothing at all to say so — the caress is the worst of the
// three, the toe landing up to ~20 cm from the ring.
//
// This is the contact-pin strain line generalised (makeStrainLine /
// setStrainLine in pins.js): the same amber, the same picture — a segment
// between what was asked for and what anatomy delivered.
const HANDLE_STRAIN_GAP = 0.02; // 2 cm, matching the pin strain threshold
const handleStrain = makeStrainLine();
handleStrain.visible = false;
scene.add(handleStrain);
let handleStrained = false;

// The mesh carrying a handle's colour (the caress ring hangs off a holder).
function handleMesh(handle) {
  return handle.material ? handle : (handle.children.find((c) => c.material) || null);
}

function paintHandle(handle, hex) {
  const mesh = handleMesh(handle);
  if (mesh) mesh.material.color.setHex(hex ?? mesh.userData.baseColor);
}

// Amber the handle and draw the gap while `goal` (what the user pointed at)
// and `reached` (what the body achieved) are more than a couple of cm apart.
// `lineFrom` defaults to `goal`; the swivel pole passes the handle instead,
// because its goal is a point on the elbow's circle (the fair comparison)
// while the thing the user is holding is the handle.
// The status message fires on the TRANSITION into strain only — this runs on
// every pointermove of a drag, and a per-frame message would strobe.
function showHandleStrain(handle, goal, reached, message, lineFrom = goal) {
  const strained = goal.distanceTo(reached) > HANDLE_STRAIN_GAP;
  if (strained) {
    setStrainLine(handleStrain, lineFrom, reached);
    paintHandle(handle, STRAIN_COLOR);
    if (!handleStrained) app.status(message, 'limit');
  } else {
    paintHandle(handle, null);
  }
  handleStrain.visible = strained;
  handleStrained = strained;
  requestRender(); // the line/tint are scene changes; the loop may be idling
}

// Scratch for the comparisons above (they run on every pointermove).
const _strainA = new THREE.Vector3();
const _strainB = new THREE.Vector3();

// ------------------------------------------------------- the hips' two limits
// Both of these clamps are deliberate and correct (see moveHips / pivotHips);
// what was missing is that the handle just stopped moving and never said why.
// Each function already returns the amount it actually applied, so "requested
// vs applied" is the whole test.

// A rise stops where the most-lifted planted foot can no longer hold the floor
// even at a full relevé. moveHips names that foot in app.hipsRiseLimit.
function reportHipsRise(wanted, applied) {
  if (!(wanted > 0) || wanted - applied < 0.001) return;
  const foot = app.hipsRiseLimit === 'L' ? 'left' : app.hipsRiseLimit === 'R' ? 'right' : null;
  app.status(foot
    ? `Planted ${foot} foot is at full relevé — the hips can't rise further`
    : "The hips are as high as this stance goes — they can't rise further", 'limit');
}

// The trunk's counter-twist range in the direction the pelvis is turning, and
// how much of it the spine has already spent — read from the SAME chest/spine
// y limits pivotHips derives its clamp from (skeletonDef.js), so the quoted
// number can never drift from the behaviour.
function trunkTwistBudget(figure, dYaw) {
  let total = 0;
  let room = 0;
  for (const name of ['chest', 'spine']) {
    const [lo, hi] = JOINT_BY_NAME[name].limits.y;
    const cur = figure.nodes[name].rotation.y / DEG;
    total += dYaw > 0 ? -lo : hi; // the trunk counter-yaws AGAINST the pelvis
    room += Math.max(0, dYaw > 0 ? cur - lo : hi - cur);
  }
  return { total, spent: Math.max(0, total - room) };
}

// A hips twist stops when the SPINE, not the hips, has run out: turning
// further would saturate the chest and start carrying the shoulders round —
// the one thing the ocho dissociation is defined by not doing.
function reportHipsTwist(figure, wanted, applied) {
  if (Math.abs(wanted) - Math.abs(applied) < 1e-4) return;
  const { total, spent } = trunkTwistBudget(figure, wanted);
  app.status(`Trunk twist spent (${Math.round(spent)}° of ${Math.round(total)}°) — the shoulders would start to follow`, 'limit');
}

// Drop the strain visuals (a handle was released, or a new one picked up).
function clearHandleStrain() {
  handleStrain.visible = false;
  handleStrained = false;
  for (const h of [ikTarget, swivelTarget, caressTarget]) paintHandle(h, null);
}

// The big-toe pad — the point caressToe pins to the floor — in the toes
// joint's own frame (`toeCorners` holds it as fractions of stature).
function toePadLocal(figure, side, out = new THREE.Vector3()) {
  const tc = figure.toeCorners[`_${side}`];
  return out.set(
    (tc[0][0] + tc[1][0]) / 2, (tc[0][1] + tc[1][1]) / 2, (tc[0][2] + tc[1][2]) / 2,
  ).multiplyScalar(figure.height);
}

function toePadWorld(figure, side, out = new THREE.Vector3()) {
  return figure.nodes[`toes_${side}`].localToWorld(toePadLocal(figure, side, out));
}

// Where on the elbow/knee's circle the pole handle is asking it to sit.
// swivelLimb can only roll the limb about the root→effector axis, so the
// handle's distance from that axis carries no information — projecting it
// onto the circle is what makes "did the swivel get there?" a fair question.
function swivelGoalPoint(figure, chain, handlePos, out = new THREE.Vector3()) {
  const R = figure.nodes[chain.root].getWorldPosition(new THREE.Vector3());
  const M = figure.nodes[chain.mid].getWorldPosition(new THREE.Vector3());
  const E = figure.nodes[chain.effector].getWorldPosition(new THREE.Vector3());
  const axis = E.sub(R);
  if (axis.lengthSq() < 1e-10) return out.copy(M); // limb folded flat: no axis
  axis.normalize();
  const center = R.clone().addScaledVector(axis, M.clone().sub(R).dot(axis));
  const radius = M.distanceTo(center);
  const rel = handlePos.clone().sub(center);
  rel.addScaledVector(axis, -rel.dot(axis));
  if (rel.lengthSq() < 1e-10) return out.copy(M); // handle on the axis: no direction
  return out.copy(center).addScaledVector(rel.normalize(), radius);
}

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

// A figure's facing on the floor, in radians, read from its QUATERNION.
// `group.rotation.y` is not the same number once anything writes the quaternion
// directly — the rotate gizmo does — because the XYZ Euler decomposition then
// comes back as [180°, 180° − yaw, 180°]: the same orientation, but `rotation.y`
// reads a different angle AND runs backwards when incremented. Measured: a
// gizmo turn to 103.6° reported 76.4°, and the missing 27° went straight into
// the turn's pivot compensation as 111 mm of drift.
function figureYaw(figure) {
  const f = figureForward(figure);
  return Math.atan2(f.x, f.z);
}

// Put a figure's rotation back in canonical [0, yaw, 0] form after something
// has written its quaternion, so `rotation.y` is trustworthy again for every
// consumer that reads it (arrow-key turns, preset placement, pose save/load).
// Lossless: the figure's orientation is a pure yaw either way.
function canonicalizeYaw(figure) {
  figure.group.rotation.set(0, figureYaw(figure), 0);
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
  const chain = legChain(side);
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
  const chain = legChain(side);
  const ankleNode = figure.nodes[`ankle_${side}`];
  const toesNode = figure.nodes[`toes_${side}`];
  figure.nodes[`toes_${side}`].rotation.set(0, 0, 0); // pads stay in the sole plane
  figure.group.updateMatrixWorld(true);

  // The contact point: this figure's toe-pad center (midpoint of its fitted
  // toe corners), in the toes joint's frame.
  const pad = toePadLocal(figure, side);

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

// A planted foot within this of its captured floor spot counts as "down".
const GROUND_TOL = 0.003; // 3 mm
const _hipsQ = new THREE.Quaternion();

// Solve one planted leg so its foot holds the captured floor spot `keep` while
// the pelvis moves (used by Move hips). The leg first straightens toward the
// flat spot (knee/hip extend); if the pelvis has risen out of the leg's reach,
// the foot then rolls up onto its toe — the ankle plantarflexes so the front
// sole still rests on the floor (a relevé). Returns how far the foot's lowest
// sole point still sits ABOVE its floor spot: 0 while the foot stays down, and
// positive once even a full relevé can't reach — the signal to stop rising.
function groundPlantedLeg(figure, keep) {
  const { side, pos, quat, low0 } = keep;
  const chain = legChain(side);
  solveTwoBone(figure, chain, pos);
  const ankle = figure.nodes[`ankle_${side}`];
  // Restore the flat sole orientation captured with the spot (solveTwoBone's
  // root swing may have rolled the foot).
  ankle.quaternion.copy(ankle.parent.getWorldQuaternion(_hipsQ).invert().multiply(quat));
  figure.clampJoint(`ankle_${side}`);
  figure.group.updateMatrixWorld(true);
  let lift = figure.footLowY(side) - low0;
  if (lift <= GROUND_TOL) return Math.max(0, lift); // flat on the floor

  // Relevé: plantarflex the ankle (heel up, weight onto the ball/toe) to bring
  // the front sole back to the floor. footLowY falls monotonically as the ankle
  // points down, so bisect the added pitch over the remaining plantarflex range.
  const x0 = ankle.rotation.x;
  const room = JOINT_BY_NAME[`ankle_${side}`].limits.x[1] * DEG - x0;
  const liftAt = (dx) => {
    ankle.rotation.x = x0 + dx;
    figure.clampJoint(`ankle_${side}`);
    figure.group.updateMatrixWorld(true);
    return figure.footLowY(side) - low0;
  };
  if (room <= 1e-4 || liftAt(room) > GROUND_TOL) return Math.max(0, liftAt(room)); // as low as it goes
  let lo = 0;
  let hi = room; // liftAt(lo) > tol, liftAt(hi) <= tol
  for (let i = 0; i < 8; i++) {
    const m = (lo + hi) / 2;
    if (liftAt(m) > 0) lo = m; else hi = m;
  }
  return Math.max(0, liftAt(hi));
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
  const ankleRestY = ANKLE_REST_FRAC * H;
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

// ---------------------------------------------------------- on-demand render
// The scene is static between interactions, so `animate()` does NOT run the
// per-frame constraint/analysis pass — or even redraw — continuously; it stays
// awake only for a short window after something changes, then idles (freeing a
// CPU core and letting the GPU sleep through a long class). Two wake levels:
//   requestSim()    — the POSE or a constraint may have changed: run the full
//                     solve pass AND redraw. The window is generous so the
//                     per-frame embrace/collision/pin solvers have time to
//                     converge after the change.
//   requestRender() — only the VIEW changed (camera orbit, hover glow, a
//                     selection highlight): redraw, but don't waste a re-solve.
// When in doubt, requestSim (it is a strict superset). Every pose-mutating path
// pokes it: markEdit directly, DOM input events, and a wrapper over the whole
// `app` API (added just before animate()) so the programmatic surface — the UI
// and the headless verification scripts — never has to remember to poke.
const WAKE_FRAMES = 45; // ~0.75s at 60fps: long enough for the solvers to settle
let simFrames = WAKE_FRAMES; // full solve passes still owed
let renderFrames = WAKE_FRAMES; // redraws still owed (a superset of simFrames)
function requestSim(n = WAKE_FRAMES) {
  if (n > simFrames) simFrames = n;
  if (n > renderFrames) renderFrames = n;
}
function requestRender(n = WAKE_FRAMES) {
  if (n > renderFrames) renderFrames = n;
}

// ------------------------------------------------------------- status line
// The app's one non-modal notice region (#status-line in index.html): why a
// constraint just refused — a joint at its limit, a drag handle the body
// cannot reach, a save that failed. It is DOM chrome, so it is structurally
// incapable of reaching an export: studio.photoDataURL / startRecorder
// composite the GL canvas with the overlay canvas and never read the page.
//
// This fires from inside drags, i.e. potentially every pointermove, so the
// repeat path must be free: an identical (text, kind) only pushes the expiry
// out and touches NO DOM. The timer is a single self-rescheduling timeout
// rather than a clear/set per call.
const STATUS_MS = 3000;
// A message carrying an action (the Undo offered after a single-item delete)
// stays up longer — it is something to click, not merely to read.
const STATUS_ACTION_MS = 6000;
const statusEl = document.getElementById('status-line');
let statusMsg = '';
let statusKind = '';
let statusUntil = 0;
let statusTimer = null;
let onStatusClear = null; // set by the joint-limit flash so the amber fades with the words
// The joint currently wearing the "anatomy says no" amber, and its fade timer.
// Declared here (rather than beside the flash logic further down, next to
// styleSphere) so no early caller — deselect, a preset — can hit the TDZ.
let limitHit = null; // { figure, jointName }
let limitTimer = null;

// `action` is an optional { label, run } — one button appended after the words.
// textContent first (the text may quote a user-typed pose name), then the
// button, so nothing here can ever become markup.
function paintStatus(msg, kind, action = null) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = msg ? `status-${kind}` : '';
  statusEl.hidden = !msg;
  if (!msg || !action) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = action.label;
  btn.addEventListener('click', () => {
    setStatus('');
    action.run();
  });
  statusEl.appendChild(btn);
}

function statusTick() {
  const left = statusUntil - performance.now();
  if (left > 10) { statusTimer = setTimeout(statusTick, left); return; }
  statusTimer = null;
  statusMsg = '';
  statusKind = '';
  paintStatus('', '');
  const done = onStatusClear;
  onStatusClear = null;
  if (done) done();
}

// kind: 'info' | 'limit' (anatomy refused) | 'error' (the action failed).
// `action` (optional): { label, run } — one clickable affordance, e.g. the Undo
// offered after deleting a keyframe, which the pose-only undo stack cannot
// recover. A message with an action always repaints (the button is new every
// time) and never takes the coalescing shortcut.
function setStatus(text, kind = 'info', action = null) {
  const msg = text == null ? '' : String(text);
  if (!msg) {
    statusUntil = 0;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    statusMsg = '';
    statusKind = '';
    paintStatus('', '');
    return;
  }
  const ms = action ? STATUS_ACTION_MS : STATUS_MS;
  statusUntil = performance.now() + ms;
  // Burst of the same plain message: no DOM work.
  if (!action && msg === statusMsg && kind === statusKind) return;
  statusMsg = msg;
  statusKind = kind;
  paintStatus(msg, kind, action);
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer = setTimeout(statusTick, ms);
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
  // Plain sentences naming every asset that failed to load (empty on a healthy
  // session). Read once by initUI for the View panel's note; main.js also flashes
  // it through the status line right after the UI comes up.
  degraded,
  // Whether this browser can record at all. An enabled ⏺ that console.warns and
  // returns false is worse than a disabled one.
  canRecord: typeof MediaRecorder !== 'undefined',
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
  // Anchor: freeze the couple for hands-on embrace placement. While on, the
  // per-frame constraints that MOVE a dancer are suspended (torso pull, body
  // collision, pin adaption, the embrace hand auto-join), so posing one
  // dancer's arm no longer shoves the partner across the floor — you build the
  // embrace by hand and nobody reacts. Joint limits still clamp every edit, so
  // an arm can't be dragged into an impossible pose. Set via app.setAnchor.
  anchored: false,
  stepAnims: [], // in-flight walking steps ({ figure, st, t }), advanced by the loop
  animateSteps: true, // steps play through the roll/collection (false = snap)
  coupleDrag: null, // start transforms captured while dragging a linked couple
  figDragY: null, // root height captured when a figure drag starts
  figTurn: null, // pivot + start transforms captured while turning a figure
  // Who last actually CHANGED a pose, and when — what the embrace/collision
  // constraints consult to decide which dancer yields. Deliberately not
  // `selected`: selecting a joint is not editing it (see embraceEditing).
  lastEditedFigure: null,
  editStamp: 0,
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
    studio.hover = null;    // …and the Label mode's cursor preview
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
    // Same frame nearestJointNode picked in, and the same one endWorld plays
    // it back through (surfaceNode — the atlas node on a limb). All three have
    // to agree or the spot does not stay where it was clicked.
    const local = spotNode(figure, node).worldToLocal(worldPoint.clone());
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

  // Drop a half-authored pin without releasing the finished ones. Escape and
  // the Pin-spots mode change both route here (see cancelPending).
  cancelPinPending() {
    if (!this.pinPending) return false;
    this.pinPending = null;
    pinPendingMarker.visible = false;
    if (this.ui) this.ui.onPinsChanged();
    return true;
  },

  // Escape, and the one place that decides what Escape means. Precedence runs
  // from the most transient thing on screen to the least: a half-drawn floor
  // shape, then a half-authored pin, then the selection (with its gizmo). Each
  // step says what it just abandoned — an Escape that silently does nothing
  // reads as an Escape that is not wired up. Move-hips is exempt from the
  // deselect step because its handle is seated automatically with no click, so
  // dismissing it would leave the mode with nothing to drag.
  cancelPending() {
    if (this.drawPending) {
      this.cancelDraw();
      this.status('Drawing cancelled.', 'info');
      return 'draw';
    }
    if (this.cancelPinPending()) {
      this.status('Pin cancelled — the first spot was released.', 'info');
      return 'pin';
    }
    if (this.selected || this.ikState || this.swivelState || this.caressState) {
      this.deselect();
      this.status('Selection cleared.', 'info');
      return 'selection';
    }
    return null;
  },

  // ---------------------------------------------------------------- present
  // The teaching view: the dancers fill the screen, the chrome goes away, and
  // the keys a presenter remote actually sends drive the deck.
  presenting: false,
  slideAt: -1,

  enterPresent() {
    if (this.presenting) return;
    // Everything the exit has to put back. The frame is forced to 16:9 because
    // that is the shape a projector and every exported still already use — a
    // slide composed in "fill window" would reframe itself the moment it is
    // recorded.
    this.presentSaved = { frame: studio.frame, mode: this.mode };
    this.presenting = true;
    container.parentElement.classList.add('presenting');
    this.setMode('rotate'); // no gizmos, no half-authored shapes on screen
    this.deselect();
    if (this.ui?.setFrameMode) this.ui.setFrameMode('slide'); else this.setFrame('slide');
    document.documentElement.requestFullscreen?.().catch(() => {
      // Fullscreen needs a user gesture and can be refused by policy; the
      // chrome is hidden either way, so presenting still works in-window.
    });
    // The sidebar is gone, so the frame has a different width to fill.
    window.dispatchEvent(new Event('resize'));
    const n = this.slideNames?.().length ?? 0;
    this.status(
      n ? `Presenting — ← → change slide, Space plays, Esc leaves. ${n} slide${n === 1 ? '' : 's'}.`
        : 'Presenting — no slides saved yet. Esc leaves; save slides in the Pose tab.',
      'info',
    );
    if (this.ui) this.ui.onPresentChanged?.();
  },

  exitPresent() {
    if (!this.presenting) return;
    this.presenting = false;
    container.parentElement.classList.remove('presenting');
    const frame = this.presentSaved?.frame ?? 'window';
    if (this.ui?.setFrameMode) this.ui.setFrameMode(frame); else this.setFrame(frame);
    if (this.presentSaved?.mode) this.setMode(this.presentSaved.mode);
    this.presentSaved = null;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    window.dispatchEvent(new Event('resize'));
    if (this.ui) this.ui.onPresentChanged?.();
  },

  togglePresent() {
    if (this.presenting) this.exitPresent(); else this.enterPresent();
  },

  // Step the deck. `delta` is +1/-1; the ends are walls, not a wrap — a
  // presenter pressing → once more at the last slide should stay put rather
  // than silently loop back to the beginning mid-sentence.
  gotoSlide(delta) {
    const names = this.slideNames?.() ?? [];
    if (!names.length) {
      this.status('No slides saved yet — save one in the Pose tab.', 'info');
      return false;
    }
    const next = Math.min(names.length - 1, Math.max(0, (this.slideAt < 0 ? -1 : this.slideAt) + delta));
    if (next === this.slideAt) {
      this.status(delta > 0 ? 'Last slide.' : 'First slide.', 'info');
      return false;
    }
    this.slideAt = next;
    this.showSlide(names[next]);
    this.status(`Slide ${next + 1} of ${names.length} — ${names[next]}`, 'info');
    return true;
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
    this.markEdit(figure);
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

  // Snapshot each planted foot's floor spot (world position + flat sole
  // orientation + starting height) so a Move-hips drag measures the rise limit
  // from a fixed base — the foot rolls up onto its toe as the hips rise and
  // reverses cleanly as they come back down, instead of ratcheting. Called at
  // grab time; moveHips falls back to a live snapshot for one-shot callers.
  captureHipsPlantBase(figure, planted = this.hipsPlant) {
    figure.group.updateMatrixWorld(true);
    const base = {};
    for (const side of ['L', 'R']) {
      if (!planted[side]) continue;
      const ankle = figure.nodes[`ankle_${side}`];
      base[side] = {
        side,
        pos: ankle.getWorldPosition(new THREE.Vector3()),
        quat: ankle.getWorldQuaternion(new THREE.Quaternion()),
        low0: figure.footLowY(side),
      };
    }
    return base;
  },

  // Translate a dancer's hips: the pelvis and everything above move together
  // (no posture angle changes), while each foot marked planted keeps its world
  // position AND sole orientation — the planted leg's hip/knee/ankle re-solve
  // to accommodate, as far as the joint limits allow. Unplanted legs ride
  // along rigidly. Horizontal goes through the figure root, vertical through
  // the pelvis joint (a crouch/rise, clamped to the hip-height slider range).
  //
  // A rise never pulls a planted foot off the floor: as the hips go up the leg
  // first straightens (knee/hip extend), then the foot rolls up onto its toe
  // (ankle plantarflexes — a relevé), and once even that can't hold the foot
  // down, the pelvis stops rising there (see groundPlantedLeg). Returns the
  // vertical delta actually applied (which the caller winds the handle back to).
  moveHips(figure, delta, planted = this.hipsPlant) {
    this.markEdit(figure);
    figure.group.updateMatrixWorld(true);
    // During a drag, hold the base captured at grab time; otherwise snapshot now.
    const base = this.hipsState?.figure === figure ? this.hipsState.plantBase : null;
    const keep = [];
    for (const side of ['L', 'R']) {
      if (!planted[side]) continue;
      keep.push(base?.[side] ?? {
        side,
        pos: figure.nodes[`ankle_${side}`].getWorldPosition(new THREE.Vector3()),
        quat: figure.nodes[`ankle_${side}`].getWorldQuaternion(new THREE.Quaternion()),
        low0: figure.footLowY(side),
      });
    }

    // Horizontal move goes through the figure root (unclamped, as before).
    figure.group.position.x += delta.x || 0;
    figure.group.position.z += delta.z || 0;

    const H = figure.height;
    const py0 = figure.nodes.pelvis.position.y;
    let py = THREE.MathUtils.clamp(py0 + (delta.y || 0), 0.34 * H, 0.58 * H);

    // Pose the pelvis at height `cand` and re-solve every planted leg to hold
    // its foot down; report how far the most-lifted planted foot ends up above
    // its floor spot (0 while grounded).
    // WHICH planted foot ran out of leg — the exact reason a rise stops, which
    // the solve itself only needs as a magnitude and used to discard entirely.
    // It LATCHES across the back-off below: once the height has been wound back
    // the foot is grounded again, so reading it at the end would always say
    // "nobody". Null means the pelvis stopped at the crouch range's own ceiling
    // rather than at a leg's limit. applyHandleChange names it in the status line.
    let riseLimitSide = null;
    const solveLegsAt = (cand) => {
      figure.nodes.pelvis.position.y = cand;
      figure.group.updateMatrixWorld(true);
      let lift = 0;
      let worst = null;
      for (const k of keep) {
        const l = groundPlantedLeg(figure, k);
        if (l > lift) { lift = l; worst = k.side; }
      }
      if (lift > GROUND_TOL && worst) riseLimitSide = worst;
      return lift;
    };

    let lift = solveLegsAt(py);
    // Clamp a rise so no planted foot leaves the floor. The most-lifted foot
    // rises ~1:1 with the pelvis past the limit, so subtract the shortfall and
    // re-solve a couple of times to settle on the exact top height.
    if ((delta.y || 0) > 0) {
      for (let i = 0; i < 4 && lift > GROUND_TOL && py > py0; i++) {
        py = Math.max(py0, py - lift);
        lift = solveLegsAt(py);
      }
    }

    const dy = figure.nodes.pelvis.position.y - py0;
    this.hipsRiseLimit = riseLimitSide;
    figure.syncAtlasNodes();
    figure.group.updateMatrixWorld(true);
    return dy;
  },

  // The planted foot that stopped the last Move-hips rise ('L' | 'R' | null) —
  // set by moveHips, read by reportHipsRise.
  hipsRiseLimit: null,

  // Which handle the Move-hips gizmo offers: 'slide' translates the pelvis,
  // 'twist' turns it under a still chest (see pivotHips).
  hipsTool: 'slide',

  setHipsTool(tool) {
    this.hipsTool = tool;
    const fig = this.hipsState?.figure;
    if (this.mode === 'hips' && fig) this.selectFigure(fig);
  },

  // Twist the hips under a still upper body — the dissociation a follower's
  // ocho pivot is made of. The pelvis yaws and THE WHOLE LOWER BODY GOES WITH
  // IT: hips, legs and feet turn as one unit (they hang off the pelvis node, so
  // this is free), which is what a dancer pivoting on the ball of the foot
  // actually does. The spine twists to pay for it — the chest and lumbar joints
  // counter-yaw by the same total, so the shoulders, the head and with them the
  // embrace keep facing exactly where they were.
  //
  // The counter-twist budget is the chest's + spine's remaining range, and the
  // pelvis yaw is CLAMPED to it: past that the trunk has nothing left to give,
  // and turning further would silently saturate the chest and start carrying
  // the shoulders round with the hips — the one thing this move is defined by
  // not doing. It spends the chest's range first, thoracic rotation being where
  // tango dissociation actually lives, the lumbar spine taking the remainder
  // (±35° + ±8°, so ~43° from neutral — about a real dancer's range).
  // Returns the yaw actually applied.
  //
  // The cancellation is additive (pelvis +d, chest/spine −d), the same
  // yaw-sum-preserving idiom the walk's dissociation uses; it is exact for an
  // upright trunk and drifts slightly when the pelvis carries a large tilt,
  // since the two yaws are then applied in frames that are not quite parallel.
  // Note the planted-feet checkboxes do NOT apply here — they belong to the
  // hips SLIDE, and this move turns the feet on purpose.
  pivotHips(figure, dYaw) {
    this.markEdit(figure);
    figure.group.updateMatrixWorld(true);
    // How much counter-twist each trunk joint has left in the cancelling
    // direction (the pelvis yaws +d, so these must go −d).
    const trunk = ['chest', 'spine'].map((name) => {
      const [lo, hi] = JOINT_BY_NAME[name].limits.y;
      const cur = figure.nodes[name].rotation.y;
      return { name, node: figure.nodes[name], room: dYaw > 0 ? cur - lo * DEG : hi * DEG - cur };
    });
    const room = trunk.reduce((sum, b) => sum + Math.max(0, b.room), 0);
    const d = Math.sign(dYaw) * Math.min(Math.abs(dYaw), room);
    if (Math.abs(d) < 1e-9) return 0;

    figure.nodes.pelvis.rotation.y += d;
    let left = Math.abs(d);
    for (const b of trunk) {
      const take = Math.min(left, Math.max(0, b.room));
      b.node.rotation.y -= Math.sign(d) * take;
      figure.clampJoint(b.name);
      left -= take;
    }
    figure.syncAtlasNodes();
    figure.group.updateMatrixWorld(true);
    return d;
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

  // Anchor the couple for hands-on embrace placement (see the `anchored` flag).
  // On: the auto-constraints stop moving anyone, so you can pose the selected
  // dancer's arm into the embrace without the partner sliding away; joint
  // limits still keep the pose reachable. Off: the constraints resume and
  // re-settle the embrace next frame.
  setAnchor(on) {
    this.anchored = !!on;
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

  // Highlight body parts (Set of BODY_PARTS ids, empty/null clears). Each part
  // lights in its own colour — its BODY_PARTS default unless recoloured here.
  setHighlight(parts, colors = this.highlightColors ?? null) {
    this.highlightParts = parts;
    this.highlightColors = colors;
    for (const f of this.figures) f.setHighlight(parts, colors);
  },

  // Recolour one highlighted body part; `hex` null restores its default.
  setHighlightColor(partId, hex) {
    const colors = new Map(this.highlightColors ?? []);
    if (hex) colors.set(partId, hex); else colors.delete(partId);
    this.setHighlight(this.highlightParts, colors);
  },
  highlightColor(partId) {
    return this.highlightColors?.get(partId) ?? PART_COLOR[partId] ?? null;
  },

  // Muscles panel: hide (make transparent) / highlight (recolour) individual
  // bellies by label, across both dancers (see Figure.setMuscleHidden/Lit).
  setMuscleHidden(labels) {
    for (const f of this.figures) f.setMuscleHidden(labels);
  },
  setMuscleLit(labels) {
    for (const f of this.figures) f.setMuscleLit(labels);
  },
  // Give ONE highlighted belly its own colour (hex, or null for the default
  // amber). Its callout's accent follows — see Labels.accentColor — so the
  // muscle and the label naming it stay the same colour on a slide.
  setMuscleColor(label, hex) {
    for (const f of this.figures) f.setMuscleColor(label, hex);
    this.labels.onChange?.(); // the sidebar list wears the colour too
  },
  muscleColor(label) { return this.figures[0]?.muscleColor(label) ?? null; },
  // How strongly a picked colour paints its belly (0..1, 1 = exactly the colour
  // picked — the Muscles panel's "Colour strength").
  setMuscleTint(frac) {
    this.muscleTintValue = frac;
    for (const f of this.figures) f.setMuscleTint(frac);
  },
  muscleTint() { return this.muscleTintValue ?? 1; },

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

  // Which vertical axis a whole-figure turn spins about (Move mode's toolbar):
  //   'foot' — the ball of the support foot: the tango pivot proper (ocho,
  //            giro, calesita), where the turn is ground-referenced.
  //   'cog'  — the axis through the center of gravity: how a dancer turns when
  //            the turn is balance-referenced rather than floor-referenced, and
  //            the only axis a turn on both feet (or in the air) can use. With
  //            "Move as couple" this is the pair's SHARED COG — the axis a real
  //            giro/calesita orbits, between the two dancers rather than under
  //            either of them.
  //   'root' — the figure's own origin on the floor.
  movePivot: 'foot',

  setMovePivot(which) {
    this.movePivot = which;
  },

  // The world point `turnFigure` (and the Move-mode turn gizmo) rotates about.
  turnPivot(figure, target = new THREE.Vector3()) {
    figure.group.updateMatrixWorld(true);
    if (this.movePivot === 'root') {
      return target.set(figure.group.position.x, 0, figure.group.position.z);
    }
    if (this.movePivot === 'cog') {
      const partner = this.linkCouple
        ? this.figures.find((f) => f !== figure && f.group.visible) : null;
      const cog = partner ? coupleReport(figure, partner).cog : balanceReport(figure).cog;
      return target.set(cog.x, 0, cog.z);
    }
    return this.ballOfFoot(figure, this.supportAnkle(figure), target);
  },

  // Rotate a figure about the ball of its support foot (ocho/calesita pivot).
  pivotFigure(figure, deltaYawRad) {
    this.markEdit(figure);
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
    this.markEdit(figure);
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
    this.markEdit(figure);
    const d = figureForward(figure).multiplyScalar(dist);
    const move = (f) => { f.group.position.x += d.x; f.group.position.z += d.z; f.group.updateMatrixWorld(true); };
    move(figure);
    if (this.linkCouple) {
      const partner = this.figures.find((f) => f !== figure);
      if (partner) move(partner);
    }
  },

  // Turn a figure by a yaw delta about the current `movePivot` axis (default the
  // ball of the support foot); when linked the partner orbits the same point, so
  // the couple turns as one. The pivot is a point rigidly attached to the
  // dancer, so orbiting the root about it and adding the yaw leaves it fixed.
  turnFigure(figure, dYaw) {
    this.markEdit(figure);
    const pivotPt = this.turnPivot(figure);
    rotateAbout(figure, pivotPt, dYaw);
    if (this.linkCouple) {
      const partner = this.figures.find((f) => f !== figure);
      if (partner) rotateAbout(partner, pivotPt, dYaw);
    }
  },

  // Record that `figure`'s pose was just CHANGED (gizmo drag, slider, key
  // nudge, step). The per-frame constraints move the partner of whoever is
  // being edited, and this — not the selection — is how they know who that is.
  // Open/close a hand (0 = open, 1 = closed fist). A whole-hand shape control,
  // not a rig joint — it drives the avatar's finger bones (Figure.setHandCurl).
  setHandCurl(figure, side, curl) {
    this.markEdit(figure);
    figure.setHandCurl(side, curl);
  },

  markEdit(figure) {
    if (figure) this.lastEditedFigure = figure;
    this.editStamp = performance.now();
    requestSim(); // a pose just changed — wake the solve/redraw loop
  },

  // Edit a joint honouring the current chain mode. `mutate` changes rotations.
  // Closed chain only applies to the legs/pelvis (arms/spine are always open).
  editJoint(figure, jointName, mutate) {
    this.markEdit(figure);
    const useClosed = this.chainMode === 'closed' && CHAIN_JOINTS.has(jointName);
    const anchor = useClosed ? this.anchorNode(figure, jointName) : null;
    // How far the anatomical limits pulled the edit back (0 = it was legal):
    // a DIRECT user edit, so it is reported — amber joint + status line.
    let clamped = 0;
    if (anchor) {
      editWithAnchor(figure, anchor, () => { mutate(); clamped = figure.clampJoint(jointName); });
    } else {
      mutate();
      clamped = figure.clampJoint(jointName);
    }
    reportJointClamp(figure, jointName, clamped);
    // Re-slave the skeletal limb bones (and their muscles) to the edited joints
    // so they pivot about the anatomical joints, then refresh world matrices.
    figure.syncAtlasNodes();
    figure.group.updateMatrixWorld(true);
  },

  // Where the shown dancers are standing, on the floor plane: the mean of their
  // group origins. Nothing pins a dancer near the world origin — slideFigure,
  // stepFigure, turnFigure and the Move gizmo all translate group.position
  // without bound — so this, not (0,0,0), is what a camera should look at.
  sceneCenter(out = new THREE.Vector3()) {
    const figs = this.visibleFigures();
    out.set(0, 0, 0);
    if (!figs.length) return out;
    for (const f of figs) out.add(f.group.position);
    return out.multiplyScalar(1 / figs.length).setY(0);
  },

  // Standard teaching camera angles — AIMED AT THE DANCERS, not at the world
  // origin. The offsets are unchanged (same distance and elevation as before);
  // only what they are measured from moved. Walk a couple across the floor and
  // an origin-locked preset used to snap to empty wood with the dancers out of
  // shot, recoverable only by right-drag panning.
  setView(name) {
    const views = {
      front: [0, 1.35, 3.4],
      side: [3.4, 1.35, 0],
      top: [0, 4.6, 0.6],
      three: [1.9, 1.5, 2.7],
    };
    const p = views[name];
    if (!p) return;
    const c = this.sceneCenter();
    camera.position.set(c.x + p[0], p[1], c.z + p[2]);
    orbit.target.set(c.x, name === 'top' ? 0 : 1.05, c.z);
    // Re-aim now rather than on the next animation frame, so the camera is
    // consistent the instant this returns (frameDancers does the same through
    // studio.fitPoints). The loop's own orbit.update() is idempotent after it.
    orbit.update();
  },

  // Fit the shown dancers to the frame from the direction you are already
  // looking — the "frame this dancer" control the view presets never were.
  // Shares studio.fitPoints with the movement clips' auto-frame, so there is one
  // fitter in the app rather than two that can disagree.
  frameDancers() {
    const figs = this.visibleFigures();
    if (!figs.length) {
      this.status('No dancer is shown to frame.', 'info');
      return false;
    }
    const pts = [];
    for (const f of figs) {
      f.group.updateMatrixWorld(true);
      for (const node of Object.values(f.nodes)) pts.push(node.getWorldPosition(new THREE.Vector3()));
    }
    // Keep the viewing DIRECTION; only the aim and the distance change.
    const dir = camera.position.clone().sub(orbit.target);
    if (dir.lengthSq() < 1e-8) dir.set(1.9, 1.5, 2.7);
    dir.normalize();
    // pad is flesh around the joint centres; the fills leave a margin so the
    // dancers don't touch the frame edge.
    studio.fitPoints(pts, dir, { pad: 0.09 * figs[0].height, fillX: 0.82, fillY: 0.86 });
    return true;
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
    // Drop any "anatomy says no" feedback with the thing it was about.
    clearJointLimit();
    clearHandleStrain();
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
    this.figTurn = null;
    ikTarget.visible = false;
    swivelTarget.visible = false;
    caressTarget.visible = false;
    hipsTarget.visible = false;
    tcontrols.detach();
    turnControls.detach();
    turnControls.visible = false;
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
    const pad = toePadWorld(figure, side);
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

  // PNG snapshot of the current 3D view WITH its labels/overlays, gizmos and
  // drag handles hidden (studio.js composites the GL canvas and the overlay).
  photoDataURL(scale) {
    return studio.photoDataURL(scale);
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
    // Move mode: ONE combined gizmo — slide arrows on the floor plane
    // (tcontrols) with a yaw ring around them (turnControls) — so the same
    // handle both slides and turns the figure without a mode switch. The ring
    // spins about the chosen pivot (see applyFigureTurn); the arrow keys do
    // both too. Step mode has no drag gizmo — clicking steps, and the arrows
    // step/turn — so the figure is only recorded as active.
    if (this.mode === 'move') {
      tcontrols.attach(figure.group);
      tcontrols.setMode('translate');
      tcontrols.showX = tcontrols.showZ = true;
      tcontrols.showY = false;
      turnControls.attach(figure.group);
      turnControls.visible = true;
    } else if (this.mode === 'hips') {
      // Move-hips: a handle at the pelvis, draggable on all three axes. The
      // planted-feet checkboxes default to whichever feet touch the floor.
      figure.group.updateMatrixWorld(true);
      const contacts = footContactsBySide(figure);
      this.hipsPlant = { L: contacts.L.length > 0, R: contacts.R.length > 0 };
      figure.worldPos('pelvis', hipsTarget.position);
      hipsTarget.rotation.set(0, 0, 0);
      hipsTarget.userData.figure = figure;
      hipsTarget.visible = true;
      this.hipsState = { figure, last: hipsTarget.position.clone(), lastYaw: 0 };
      tcontrols.attach(hipsTarget);
      if (this.hipsTool === 'twist') {
        tcontrols.setMode('rotate');
        tcontrols.showY = true;
        tcontrols.showX = tcontrols.showZ = false;
      } else {
        tcontrols.setMode('translate');
        tcontrols.showX = tcontrols.showY = tcontrols.showZ = true;
      }
      if (this.ui) this.ui.onHipsPlantChanged();
    }
  },

  applyPreset(index) {
    const preset = PRESETS[index];
    if (!preset) return;
    if (studio.clipActive) studio.exitClip(); // a preset is for the couple, not the clip stage
    this.pushHistory();
    this.deselect();
    // A preset places both dancers outright, so no one is mid-edit any more:
    // clear who yields, or the couple keeps deferring to whoever was last
    // posed before the preset (see embraceEditing).
    this.lastEditedFigure = null;
    preset.apply(leader, follower);
    // Move hips keeps offering its handle across pose changes.
    if (this.mode === 'hips') this.setMode('hips');
    if (this.ui) this.ui.onPoseChanged();
  },

  // The couple's pose. `view: true` also captures how the scene is SHOWN
  // (layer, backdrop, camera, labels, highlights — see ui.getViewState), which
  // is what turns a saved pose into a slide.
  //
  // It is opt-in because this same shape is every undo snapshot, every
  // COG-trail sample and every sequence keyframe: an undo that also moved the
  // camera would be a bug, and the trail rebuilds state ~289 times per edit.
  getCoupleState(name = '', { view = false } = {}) {
    const state = {
      app: 'tangle',
      version: 1,
      name,
      meta: {
        heights: this.figures.map((f) => f.height),
        masses: this.figures.map((f) => f.mass),
      },
      figures: this.figures.map((f) => f.getPose()),
    };
    if (view) {
      const v = this.ui?.getViewState?.();
      if (v) state.view = v;
    }
    return state;
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
    // Only a slide carries a view. A pose-only state — every file saved before
    // slides existed, plus A/B snapshots, keyframes and undo entries — leaves
    // the layer, camera and labels exactly where the user has them.
    if (state.view) this.ui?.applyViewState?.(state.view);
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

  // A keyframe is not pose state, so the undo stack (couple poses only) cannot
  // bring it back — Ctrl+Z after this would restore the POSE and leave the
  // keyframe gone. The recovery is therefore offered where the loss happened,
  // as a clickable Undo on the status line.
  seqDelete(i) {
    const [removed] = this.seqStates.splice(i, 1);
    this.onSeqChanged();
    if (!removed) return;
    this.status(`Keyframe ${i + 1} deleted.`, 'info', {
      label: 'Undo',
      run: () => {
        this.seqStates.splice(Math.min(i, this.seqStates.length), 0, removed);
        this.onSeqChanged();
      },
    });
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
    if (this.recording || studio.recorder || !states || states.length < 2) return false;
    this.deselect(); // also hides every gizmo/handle
    this.interpPlaying = false;
    this.seqPlaying = false;
    if (!this.canRecord) {
      this.status('This browser has no video recorder (MediaRecorder) — use 📷 Save photo instead.', 'error');
      return false;
    }
    applyStatesT(states, 0); // first frames show the start pose, not the editor state
    // The shared recorder captures GL + the label overlay, as MP4 by default
    // (studio.videoFormat) — PowerPoint will not play a .webm. The job is held
    // on its first frame (rec: null) until the H.264 encoder is awake; see
    // warmUpMp4 in studio.js for why an unwarmed recording is an empty file.
    // `arming` is that wait made visible: the H.264 encoder can take ~5.5 s to
    // wake on the first recording of a page, and the button used to read
    // "⏺ Recording…" throughout while capturing nothing. The clip recorder
    // already showed "⏺ Preparing…" here; this mirrors it.
    const job = { states, t: 0, secs: SEQ_SEG_SECONDS * (states.length - 1), rec: null, arming: true };
    this.recording = job;
    if (this.ui) this.ui.onRecordingChanged();
    studio.whenEncoderReady().then(() => {
      if (this.recording !== job) return;
      job.arming = false;
      if (this.ui) this.ui.onRecordingChanged();
      job.rec = studio.startRecorder(name, ({ retry }) => {
        this.recording = null;
        if (this.ui) this.ui.onRecordingChanged();
        if (retry) this.recordPlayback(states, name); // MP4 unavailable here → WebM
      });
      if (!job.rec) {
        this.recording = null;
        if (this.ui) this.ui.onRecordingChanged();
      }
    });
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

// Escape hatches for anything that changes the scene outside the wrapped API
// (e.g. a future direct scene mutation): app.requestSim() to re-solve + redraw,
// app.requestRender() for a view-only redraw.
app.requestSim = requestSim;
app.requestRender = requestRender;
// Non-modal user feedback; see setStatus. Skipped by the render wrapper below
// (it changes no scene state, and it is called from inside drags).
app.status = setStatus;

// ------------------------------------------------------ presentation studio
// Labels, backdrop, the 16:9 slide frame, photo/video export and the movement
// clips all live in studio.js; this is its seam into the scene. Everything the
// UI or a script drives goes through an app.* method so the render wrapper at
// the bottom of this file pokes the loop after each call.
function hideGizmos() {
  const hidden = [];
  // The pick spheres are click targets, not anatomy: faint blobs on every joint
  // in skeleton view, so they stay out of exported pictures with the gizmos.
  for (const o of [tcontrols, turnControls, ikTarget, swivelTarget, caressTarget, hipsTarget,
    handleStrain, pins.group, pinPendingMarker, ...leader.pickSpheres, ...follower.pickSpheres]) {
    if (o.visible) { hidden.push(o); o.visible = false; }
  }
  return () => { for (const o of hidden) o.visible = true; };
}

let clipDissoc = null; // the figure a clip wants the dissociation wedge drawn for
const studio = createStudio({
  renderer, scene, camera, orbit, floor, container, app,
  hooks: {
    hideGizmos,
    setDissoc(figure) { clipDissoc = figure; applyVizVisibility(); },
  },
});
app.studio = studio;
app.labels = studio.labels;
app.labelFilter = 'auto'; // Label-mode sub-tool: 'auto' | 'bone' | 'muscle' | 'joint'

const LABELS_KEY = 'tangoPoseStudio.labels.v1';
try { studio.labels.fromJSON(JSON.parse(localStorage.getItem(LABELS_KEY) || '[]')); } catch { /* stale store */ }
studio.labels.onChange = () => {
  try { localStorage.setItem(LABELS_KEY, JSON.stringify(studio.labels.toJSON())); } catch { /* private mode */ }
  if (app.ui) app.ui.onLabelsChanged();
  requestRender();
};

Object.assign(app, {
  setBackdrop(name) { studio.setBackdrop(name); },
  setFrame(frame) { studio.setFrame(frame); },
  setPhotoScale(n) { studio.photoScale = n; },
  setVideoFormat(f) { studio.videoFormat = f; },

  // ------------------------------------------------------------------ labels
  setLabelFilter(f) { this.labelFilter = f; },
  // Scriptable labelling: kind 'joint' (name = joint), 'muscle' (atlas label,
  // e.g. 'Rectus femoris') or 'bone' (readable or atlas name, e.g. 'Femur').
  addLabel(figure, kind, name, side = null, text = undefined) {
    return studio.labels.addByName(figure, kind, name, side, { text, camera });
  },
  removeLabel(id) { return studio.labels.remove(id); },
  clearLabels() { studio.labels.clear(); },
  setLabelText(id, text) { studio.labels.setText(id, text); studio.labels.onChange(); },
  flipLabel(id) {
    const at = studio.lastLayout?.find((p) => p.label.id === id);
    studio.labels.flip(id, at?.side ?? 'left');
  },
  // Which column a callout is in right now ('left' | 'right'), and putting it
  // in one deliberately. `null` hands it back to the automatic side-of-the-
  // anchor rule.
  labelSide(id) { return studio.lastLayout?.find((p) => p.label.id === id)?.side ?? null; },
  setLabelSide(id, side) { return studio.labels.setSide(id, side); },
  // A colour for the CALLOUT itself. A muscle callout is recoloured through its
  // belly instead (app.setMuscleColor → Labels.accentColor reads it back), so
  // the belly and the label naming it stay one thing; this is for the bones and
  // joints, which have no colour of their own to take.
  setLabelColor(id, hex) {
    if (studio.labels.setColor(id, hex)) requestRender();
  },
  labelAccent(id) {
    const l = studio.labels.byId(id);
    return l ? studio.labels.accentColor(l) : null;
  },
  setLabelSize(frac) { studio.labels.size = frac; },
  setLabelsVisible(on) { studio.labels.visible = !!on; },
  // How much anatomy a NEW label names: 'simple' (one everyday name per body
  // part — "Foot", "Hip") or 'full' (every bone and muscle, anatomically).
  setLabelDetail(detail) { studio.labels.setDetail(detail); },
  // Name everything the current highlight picks out (see Labels.labelHighlighted).
  labelHighlighted(figure = this.visibleFigures()[0]) {
    return figure ? studio.labels.labelHighlighted(figure, camera) : 0;
  },

  // ---------------------------------------------------------- movement clips
  enterClip(moveId, opts) { return studio.enterClip(moveId, opts); },
  // Reset the dancer in the open clip to the anatomical position (the clip
  // otherwise keeps whatever pose they were in — see studio.enterClip).
  clipAnatomical() { return studio.clipAnatomical(); },
  exitClip() { studio.exitClip(); },
  playClip(on = true) { studio.playClip(on); },
  scrubClip(p) { studio.scrubClip(p); },
  recordClip() { return studio.recordClip(); },
  setClipOptions(patch) {
    const pattern = studio.clipOptions.pattern;
    Object.assign(studio.clipOptions, patch);
    studio.refreshClip(pattern !== studio.clipOptions.pattern);
  },
});

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
  if (!e.value) {
    app.ckc = null; app.coupleDrag = null; app.figDragY = null; app.figTurn = null;
    if (app.hipsState) app.hipsState.plantBase = null;
    return;
  }
  app.pushHistory();
  if (app.hipsState && tcontrols.object === hipsTarget) {
    // Hips drag: deltas accumulate from here (see the objectChange handler);
    // the figure-drag captures below must not see the handle as a figure.
    app.hipsState.last.copy(hipsTarget.position);
    app.hipsState.lastYaw = hipsTarget.rotation.y;
    // Freeze each planted foot's floor spot so a rise-and-fall relevés and
    // reverses about a fixed base instead of ratcheting frame to frame.
    if (app.hipsTool === 'slide') {
      app.hipsState.plantBase = app.captureHipsPlantBase(app.hipsState.figure, app.hipsPlant);
    }
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
  // Any of these IS a pose edit, however it was triggered (gizmo or keyboard),
  // so the constraints know whose partner to move — see embraceEditing().
  const owner = app.ikState?.figure ?? app.swivelState?.figure
    ?? app.caressState?.figure ?? app.hipsState?.figure;
  if (owner) app.markEdit(owner);
  if (app.ikState) {
    // Keep the IK target where the limb can reach without going underground.
    const H = app.ikState.figure.height;
    const minY = app.ikState.chain.effector.startsWith('ankle') ? ANKLE_REST_FRAC * H : 0.115 * H;
    if (ikTarget.position.y < minY) ikTarget.position.y = minY;
    const { figure, chain } = app.ikState;
    solveTwoBone(figure, chain, ikTarget.position);
    // solveTwoBone clamps the target distance into [|a−b|, a+b] and then
    // clamps both joints: past the limb's reach the handle keeps travelling
    // and the hand stops dead. Say so instead of letting it look broken.
    // Measured on the RIG effector deliberately — that is the node the handle
    // was seeded from and the node the IK drives, so the two are the same
    // frame. (Mesh truth is the right frame for a GOAL about the visible hand;
    // this is a question about the handle and the thing it moves.)
    showHandleStrain(ikTarget, ikTarget.position,
      figure.nodes[chain.effector].getWorldPosition(_strainA),
      `${JOINT_TITLES[chain.effector] || chain.effector} can't reach there — the limb is at full stretch or its limit`);
  } else if (app.swivelState) {
    // The pole handle stays where dragged; the elbow swivels to aim at it.
    const { figure, chain } = app.swivelState;
    swivelLimb(figure, chain, swivelTarget.position);
    // swivelLimb bisects for the largest roll the ROOT's limits allow, so an
    // infeasible pole direction simply stops turning the elbow. Measure against
    // the circle the elbow actually travels on (swivelGoalPoint), but draw the
    // line to the handle, which is the thing the user is holding.
    swivelGoalPoint(figure, chain, swivelTarget.position, _strainB);
    showHandleStrain(swivelTarget, _strainB, figure.nodes[chain.mid].getWorldPosition(_strainA),
      `${JOINT_TITLES[chain.mid] || chain.mid} can't swivel further — ${JOINT_TITLES[chain.root] || chain.root} is at its limit`,
      swivelTarget.position);
    if (app.ui) app.ui.refreshJointValues();
  } else if (app.caressState) {
    // The ring stays on the floor; the leg re-solves so the toe pad rests on it.
    caressTarget.position.y = 0;
    const { figure, side } = app.caressState;
    caressToe(figure, side, caressTarget.position);
    // When joint limits stop the toe reaching the floor at the ring, caressToe
    // bisects the goal back toward the hip and leaves the toe grounded short of
    // it — up to ~20 cm short, with the ring still under the cursor. The most
    // confusing of the three handles, and now the most explicit.
    showHandleStrain(caressTarget, caressTarget.position, toePadWorld(figure, side, _strainA),
      `${side === 'L' ? 'Left' : 'Right'} toe can't reach there — it stays on the floor at the leg's limit`);
    if (app.ui) app.ui.refreshJointValues();
  } else if (app.hipsState && tcontrols.object === hipsTarget) {
    const { figure, last } = app.hipsState;
    if (app.hipsTool === 'twist') {
      // Hips twist: the ring's delta yaws the pelvis under a still chest. The
      // trunk's counter-twist range clamps it, so wind the handle back to what
      // was actually applied or the ring runs away from the body.
      const want = hipsTarget.rotation.y - app.hipsState.lastYaw;
      const applied = app.pivotHips(figure, want);
      reportHipsTwist(figure, want, applied);
      app.hipsState.lastYaw += applied;
      hipsTarget.rotation.y = app.hipsState.lastYaw;
    } else {
      // Hips drag: apply the handle's delta; planted feet stay put via leg IK.
      // The vertical axis clamps at the crouch range — track the applied height
      // so a clamped drag can't accumulate.
      const delta = hipsTarget.position.clone().sub(last);
      const dy = app.moveHips(figure, delta, app.hipsPlant);
      reportHipsRise(delta.y, dy);
      last.copy(hipsTarget.position);
      last.y += dy - delta.y;
      hipsTarget.position.y = last.y;
    }
    if (app.ui) app.ui.refreshJointValues();
  } else {
    return false;
  }
  return true;
}

// Move-mode turn (the yaw ring on turnControls). Capture the pivot and both
// dancers' start transforms once, so every frame is re-derived from them
// absolutely — a long drag can't drift — and the pivot point stays put under
// the spin. A linked partner orbits the SAME point, so the couple turns as one.
function beginFigureTurn(figure) {
  app.figTurn = null;
  if (!figure) return;
  const partner = app.linkCouple
    ? app.figures.find((f) => f !== figure && f.group.visible) : null;
  canonicalizeYaw(figure);
  if (partner) canonicalizeYaw(partner);
  app.figTurn = {
    figure,
    partner,
    pivot: app.turnPivot(figure).clone(),
    yaw0: figure.group.rotation.y,
    pos0: figure.group.position.clone(),
    partnerYaw0: partner ? partner.group.rotation.y : 0,
    partnerPos0: partner ? partner.group.position.clone() : null,
  };
}

function applyFigureTurn() {
  if (!app.figTurn) return;
  app.markEdit(app.figTurn.figure);
  const { figure, partner, pivot, yaw0, pos0, partnerYaw0, partnerPos0 } = app.figTurn;
  // The gizmo wrote the quaternion, so re-canonicalise before reading a yaw
  // off `rotation.y` (see figureYaw). Wrapped, so dragging past half a turn
  // reads as a short rotation the other way rather than jumping 360°.
  canonicalizeYaw(figure);
  const raw = figure.group.rotation.y - yaw0;
  const dYaw = Math.atan2(Math.sin(raw), Math.cos(raw));
  const place = (f, p0, y0) => {
    const rel = new THREE.Vector3(p0.x - pivot.x, 0, p0.z - pivot.z).applyAxisAngle(_UP, dYaw);
    f.group.position.set(pivot.x + rel.x, p0.y, pivot.z + rel.z);
    f.group.rotation.y = y0 + dYaw;
    f.group.updateMatrixWorld(true);
  };
  place(figure, pos0, yaw0);
  if (partner) place(partner, partnerPos0, partnerYaw0);
}

tcontrols.addEventListener('objectChange', () => {
  if (applyHandleChange()) {
    // an active drag handle consumed the change
  } else if (app.selected) {
    app.markEdit(app.selected.figure);
    // The rotate gizmo writes the joint's rotation freely; this is where the
    // anatomical limits bite. Report it — otherwise the ring turns and the
    // limb simply stops, which reads as a broken app rather than an anatomical
    // one. (The solver-internal clampJoint calls stay silent by design.)
    reportJointClamp(app.selected.figure, app.selected.jointName,
      app.selected.figure.clampJoint(app.selected.jointName));
    if (app.ckc) pinAnchor(app.ckc.figure, app.ckc.node, app.ckc.matrix);
    if (app.ui) app.ui.refreshJointValues();
  } else if (tcontrols.object) {
    app.markEdit(tcontrols.object.userData.figure);
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

// A clip's title block is 2D overlay chrome, so it has no place in the scene's
// picking: studio.js says where it drew, and these three handlers drag it. The
// grab is armed by HOVER (canvasPoint below turns orbiting off while the cursor
// is over the title) rather than at pointerdown — OrbitControls listens on this
// same canvas and would already have started a camera rotate by the time a
// pointerdown handler of ours ran.
let titleDrag = false;
let titleHover = false;
// The same arrangement for a callout pill: hovering one hands it the cursor, a
// drag moves it to the column the cursor ends in, and a double-click opens its
// colour picker.
let labelDrag = false;
let labelHover = false;
const DOUBLE_TAP_MS = 400;
let labelTap = { id: null, t: 0 };
const canvasPoint = (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};

// Click-vs-drag detection so orbiting doesn't change the selection.
let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  if (titleHover && studio.beginTitleDrag(...canvasPoint(e))) titleDrag = true;
  else if (labelHover && studio.beginLabelDrag(...canvasPoint(e))) labelDrag = true;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (titleDrag) {
    titleDrag = false;
    studio.endTitleDrag();
    downPos = null;
    return; // the title took this gesture; nothing in the scene should see it
  }
  if (labelDrag) {
    labelDrag = false;
    downPos = null;
    const movedId = studio.endLabelDrag();
    if (movedId !== null) {
      const l = studio.labels.byId(movedId);
      app.status(`“${l?.text}” moved to the ${l?.force} column.`, 'info');
      labelTap = { id: null, t: 0 };
      return;
    }
    // A press that never travelled is a click ON the pill — it changed no
    // column, and it must not fall through to pick a joint behind the callout
    // either. A SECOND one in quick succession opens the colour picker.
    //
    // Counted here rather than off the native `dblclick` event: the pill's own
    // drag already owns pointerdown/up over it, so this is where the second
    // press arrives — and the gesture then does not depend on how a browser
    // (or an automated one, which never fired dblclick here at all) decides to
    // synthesise a double click.
    const hit = studio.labelHit(...canvasPoint(e));
    const now = performance.now();
    if (hit && labelTap.id === hit.label.id && now - labelTap.t < DOUBLE_TAP_MS) {
      labelTap = { id: null, t: 0 };
      openLabelColor(hit.label, e.clientX, e.clientY);
    } else labelTap = { id: hit?.label.id ?? null, t: now };
    return;
  }
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 6 || gizmoDragging()) return;
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
  // A joint the user just drove into its anatomical limit wears the app's
  // "anatomy says no" amber (see flagJointLimit). It is read here rather than
  // written by the flagger so that EVERY restyle path — hover, selection, a
  // layer switch — preserves it instead of silently wiping it.
  const strained = limitHit !== null && limitHit.figure === figure && limitHit.jointName === jointName;
  // Only body view needs the see-through treatment; skeleton view would just
  // make the spheres float over their own bones. A strained joint must reach
  // the screen through the opaque avatar, same as a hovered one.
  const showThrough = (ghost || lit || strained) && !(figure.layers && figure.layers.skeleton);
  sphere.material.emissive.set(strained ? STRAIN_COLOR
    : (lit ? HOVER_EMISSIVE : (isSel ? SELECT_EMISSIVE : 0x000000)));
  sphere.material.opacity = (lit || strained) ? 0.85 : (ghost ? GHOST_OPACITY : restingOpacity(figure));
  sphere.material.depthTest = !showThrough;
  sphere.renderOrder = showThrough ? 3 : 0;
}

// ------------------------------------------------ joint limits, made visible
// A clamp is the whole point of this app and until now it was completely
// silent: the limb stopped and nothing said why. The two DIRECT user-edit
// paths (the rotate gizmo's objectChange and app.editJoint) report it —
// amber on the joint's pick sphere plus a status line naming the limit.
//
// Deliberately NOT the solver paths (solveTwoBone / flattenFoot /
// groundPlantedLeg / pivotHips / the embrace): those clamp every iteration as
// a normal part of converging, and reporting there would strobe a permanent
// message. (`limitHit` / `limitTimer` live up beside the status line.)

function restyleSphere(figure, jointName) {
  const sphere = figure.jointSphereByName?.[jointName];
  if (!sphere) return;
  styleSphere(sphere, figure, { ghost: hoverFigure === figure, lit: hoverSphere === sphere });
}

function clearJointLimit() {
  if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
  if (!limitHit) return;
  const { figure, jointName } = limitHit;
  limitHit = null;
  restyleSphere(figure, jointName);
  requestRender(); // the tint is a scene change — the loop may be idling
}

// Name the bound the joint is now sitting on, e.g. "Left shoulder at its limit
// (−170°)". clampJoint reports only HOW FAR it moved, so the axis is recovered
// here: after the clamp the offending axis sits exactly on one of its bounds.
function limitMessage(figure, jointName) {
  const title = JOINT_TITLES[jointName] || jointName;
  const def = JOINT_BY_NAME[jointName];
  const r = figure.nodes[jointName].rotation;
  let best = null;
  for (const ax of ['x', 'y', 'z']) {
    const deg = r[ax] / DEG;
    for (const bound of def.limits[ax]) {
      const d = Math.abs(deg - bound);
      if (d < 0.5 && (!best || d < best.d)) best = { d, bound };
    }
  }
  return best ? `${title} at its limit (${Math.round(best.bound)}°)` : `${title} at its limit`;
}

// Called from the two interactive edit paths with clampJoint's return value.
// Zero (the pose was legal) clears any amber still showing on that joint.
function reportJointClamp(figure, jointName, clamped) {
  if (!clamped) {
    if (limitHit && limitHit.figure === figure && limitHit.jointName === jointName) clearJointLimit();
    return;
  }
  app.status(limitMessage(figure, jointName), 'limit');
  // Fade the amber with the words, so the two are one signal.
  onStatusClear = clearJointLimit;
  if (limitTimer) clearTimeout(limitTimer);
  limitTimer = setTimeout(clearJointLimit, STATUS_MS + 200);
  if (limitHit && limitHit.figure === figure && limitHit.jointName === jointName) return;
  const prev = limitHit;
  limitHit = { figure, jointName };
  if (prev) restyleSphere(prev.figure, prev.jointName);
  restyleSphere(figure, jointName);
  requestRender();
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

// Which joint a click on `jointName`'s pick sphere would actually ACT on, or
// null if the click does nothing in this mode. ONE function, consulted by both
// the hover and the click, so the sphere that lights is always the sphere the
// click will use. Two ways they used to disagree:
//   · Drag-limb hover skipped past a non-actionable sphere to an actionable one
//     behind it, while the click took hits[0] and fell off the end of its
//     if/else chain — the cursor lit a joint and the click did nothing at all.
//   · An endpoint (hand_L, toe_R, headTop) has its own pick sphere, but
//     selectJoint resolves it to its parent — so hovering the hand lit the HAND
//     and clicking selected the WRIST, and the highlight jumped elsewhere.
// Resolving here fixes both: the hover lights the resolved joint's own sphere.
function clickTargetJoint(jointName) {
  if (app.mode === 'ik') {
    if (/^(?:toes|toe)_[LR]$/.test(jointName)) return jointName.replace(/^toe_/, 'toes_');
    if (IK_CHAINS[jointName]) return IK_CHAINS[jointName].effector;
    if (swivelChainFor(jointName)) return jointName;
    return null; // an ordinary joint: Drag limb has nothing to do with it
  }
  const def = JOINT_BY_NAME[jointName];
  return def?.endpoint ? def.parent : jointName;
}

// A joint is actionable in drag mode only if it starts an IK chain (hand/foot)
// or an elbow/knee swivel; in rotate mode every joint can be posed.
function jointActionable(jointName) {
  return clickTargetJoint(jointName) !== null;
}

renderer.domElement.addEventListener('pointerleave', () => {
  clearHover();
  studio.hover = null;
  if (titleHover && !titleDrag) { titleHover = false; orbit.enabled = true; }
  if (labelHover && !labelDrag) { labelHover = false; orbit.enabled = true; }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (titleDrag) {
    studio.dragTitleTo(...canvasPoint(e));
    requestRender(); // overlay-only change; the solve loop may be idling
    return;
  }
  if (labelDrag) {
    if (studio.dragLabelTo(...canvasPoint(e))) requestRender();
    return;
  }
  if (downPos || gizmoDragging()) return; // don't fight a click, gizmo drag, or orbit
  // Over the clip title, the cursor belongs to the title: nothing in the scene
  // is pickable through it, and orbiting is held off so a drag moves the block
  // instead of the camera.
  const overTitle = studio.clipActive && studio.titleHit(...canvasPoint(e));
  titleHover = overTitle;
  // Assigned every move, not toggled on the edge: a gizmo drag that ends under
  // the title re-enables orbiting behind our back, and a stale edge would then
  // leave the title dragging the camera with it.
  orbit.enabled = !overTitle;
  if (overTitle) {
    clearHover();
    studio.hover = null;
    renderer.domElement.style.cursor = 'move';
    return;
  }
  // Over a callout pill the cursor belongs to the callout, on the same terms:
  // orbiting is held off so a drag moves it between the columns instead of the
  // camera, and it is ASSIGNED every move rather than toggled on the edge.
  const overLabel = !!studio.labelHit(...canvasPoint(e));
  labelHover = overLabel;
  orbit.enabled = !overLabel;
  if (overLabel) {
    clearHover();
    studio.hover = null;
    renderer.domElement.style.cursor = 'grab';
    return;
  }
  pointerRay(e);
  const visible = app.visibleFigures();

  // Label mode: preview the structure under the cursor ("+ Femur", or "✕ …" if
  // a click would remove its label). The joint ghosting below still runs, so
  // the invisible-in-body-view joints can be found here too.
  if (app.mode === 'label') {
    const pick = studio.labels.pick(raycaster, visible, app.labelFilter, camera);
    const rect = renderer.domElement.getBoundingClientRect();
    studio.hover = pick && { text: pick.text, remove: !!pick.existing, x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

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
  // Light the sphere the CLICK will act on, not merely the one under the
  // cursor: on an endpoint (hand / toe / headTop) those differ, and the
  // highlight used to jump to a neighbour the moment you clicked.
  const litSphere = hit
    ? (hit.object.userData.figure
      .jointSphereByName[clickTargetJoint(hit.object.userData.jointName)] ?? hit.object)
    : null;
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
  if (figure) setHover(figure, litSphere);
  else clearHover();
  if (app.mode === 'label') renderer.domElement.style.cursor = studio.hover ? 'pointer' : '';
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
// What the second click of each two-click shape is for, so the half-authored
// state says so instead of leaving a rubber band and no instruction.
const DRAW_NEXT = {
  line: 'Start point set — click the end of the line. (Esc cancels.)',
  arrow: 'Tail set — click where the arrow should point. (Esc cancels.)',
  circle: 'Centre set — click a point on the rim. (Esc cancels.)',
};

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
    app.status(DRAW_NEXT[app.drawTool] ?? 'Click the second point to finish. (Esc cancels.)', 'info');
    return;
  }
  const a = app.drawPending;
  app.cancelDraw();
  if (app.drawTool === 'line') app.addDrawLine(a, p);
  else if (app.drawTool === 'arrow') app.addDrawArrow(a, p);
  else if (app.drawTool === 'circle') app.addDrawCircle(a, a.distanceTo(p));
}

// The atlas labels of the HIGHLIGHTED muscle under the cursor, or null.
// Lighting is by label (a bare name lights both sides, `name|L` one of them),
// the same keys Figure.setMuscleLit takes. A clip's callout usually names a
// GROUP of bellies ("Quadriceps" is four of them, "Iliopsoas" two) and the
// colour belongs to the callout, so a click on any one of them returns the
// whole group and they recolour together.
// The bellies one callout covers. A clip's mover row groups several heads under
// a single name ("Quadriceps"), and a colour picked for it belongs to the
// callout, so it has to reach every head the callout speaks for.
function moverGroup(name) {
  const group = (studio.clip?.move.movers ?? [])
    .map((g) => (Array.isArray(g) ? g.slice(1) : [g]))
    .find((names) => names.includes(name));
  return group?.length ? group : [name];
}

function litMuscleAtPointer(visible) {
  const pick = studio.labels.pick(raycaster, visible, 'muscle', camera);
  if (!pick || pick.kind !== 'muscle') return null;
  const lit = pick.figure.litMuscles;
  const side = pick.mesh.userData.muscleSide;
  if (!lit || !(lit.has(pick.name) || lit.has(`${pick.name}|${side}`))) return null;
  return moverGroup(pick.name);
}

// Double-click a callout to colour it. A MUSCLE callout is recoloured through
// its belly (app.setMuscleColor), so the belly, its pill and the sidebar tag go
// on reading as one thing — the same picker a click on a lit belly opens. A
// bone or joint callout has no belly to carry a colour, so it takes one itself.
function openLabelColor(label, x, y) {
  if (label.kind === 'muscle') app.ui?.pickMuscleColor(moverGroup(label.name), x, y);
  else app.ui?.pickLabelColor(label.id, x, y);
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
  // On the clip stage, clicking a LIT belly opens a colour picker for it: the
  // prime movers are what the slide is about, and a teacher wants them in their
  // own colours. Only there — off the stage that click still picks a joint, and
  // in Label mode it names the muscle.
  if (studio.clipActive && app.mode !== 'label') {
    const names = litMuscleAtPointer(visible);
    if (names) { app.ui?.pickMuscleColor(names, e.clientX, e.clientY); return; }
  }
  if (app.mode === 'label') {
    // Click a bone, muscle or joint to name it; click it again to un-name it.
    const pick = studio.labels.pick(raycaster, visible, app.labelFilter, camera);
    // The Labels list ships collapsed, so a new callout used to land in DOM the
    // user cannot see; name it here as well as drawing it.
    if (pick) {
      const removing = !!pick.existing;
      pick.toggle();
      studio.hover = null;
      app.status(removing ? `Removed the “${pick.text}” label.` : `Labelled ${pick.text}.`, 'info');
    } else {
      app.status('Nothing to label there — aim at a bone, muscle or joint.', 'info');
    }
    return;
  }
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
  // The SAME predicate the hover uses (see clickTargetJoint): take the first
  // joint this mode can actually act on, rather than hits[0] — which, in Drag
  // limb, was regularly a joint the mode ignores sitting in front of one it
  // doesn't, so the cursor lit a joint and the click did nothing.
  const hit = hits.find((h) => jointActionable(h.object.userData.jointName));
  if (!hit) {
    // Every sphere under the cursor is unusable HERE. Say which mode wants it
    // instead; silently no-opping reads as a dead click.
    const name = JOINT_TITLES[hits[0].object.userData.jointName]
      || hits[0].object.userData.jointName;
    app.status(`Drag limb moves hands, feet and toes (and swivels an elbow or knee). Switch to Rotate joints to pose the ${name.toLowerCase()}.`, 'info');
    return;
  }
  const { figure, jointName } = hit.object.userData;
  if (app.mode === 'ik') {
    // The toes start a floor caress (big toe pinned to the floor); the other
    // effectors keep the free-space IK drag.
    const toe = jointName.match(/^(?:toes|toe)_(L|R)$/);
    if (toe) app.startToeCaress(figure, toe[1]);
    else if (IK_CHAINS[jointName]) app.startIK(figure, jointName);
    else app.startSwivel(figure, jointName);
  } else {
    app.selectJoint(figure, jointName);
  }
}

// ---------------------------------------------------------------- UI + loop
app.ui = initUI(app);
app.applyPreset(1); // start in the close embrace
app.history.length = 0; // the pre-preset construction state is not a useful undo target
app.ui.onHistoryChanged();

// Everything is now built AND wired, so the cold-load cover can go. It is
// removed here rather than after the GLB awaits so it never uncovers a scene
// whose listeners are not attached yet.
document.getElementById('loading-overlay')?.remove();

// Any asset that fell back to a stand-in: say so once, in the status line. The
// standing note lives in the View panel (initUI reads app.degraded), so the
// difference is still discoverable after this message fades.
if (degraded.length) {
  app.status(degraded.length === 1
    ? degraded[0]
    : `${degraded[0]} (+${degraded.length - 1} more — see the View panel.)`, 'error');
}

// How long a one-shot edit (a slider tick, a key nudge) still counts as live.
// A gizmo drag announces itself through gizmoDragging() and needs no timer;
// this covers the edits that arrive as discrete events.
const EDIT_HOLD_MS = 350;

// What the user is editing right now, so the embrace constraints leave it
// alone and move the partner instead: an IK drag, the joint under an active
// gizmo, or a whole-figure drag.
//
// A SELECTION IS NOT AN EDIT. This used to return `app.selected` outright, so
// merely CLICKING a joint made its dancer the active editor — which flipped
// which of the two yields to the embrace and collision, and jolted the partner
// on a click that changed no pose at all. Measured, selecting the leader's
// elbow: the follower's body moved 376 mm and her shoulder spun 196°, because
// maintainHands also treats the edited arm as user-owned — it re-captures the
// clasp from that hand and drags the partner's arm to meet it. Clicking a
// joint to look at it is the single most common thing a user does here, so it
// has to be inert.
//
// Between edits we keep WHO yields but drop WHICH joint. Both halves matter:
// forgetting the figure too would hand the couple back to the default mover
// the instant a drag ended and jolt them again, while keeping the joint would
// leave that arm exempt from the embrace — and the clasp re-capturing — long
// after the user let go.
function embraceEditing() {
  // A stepping dancer is the active mover: the embrace pull and the body
  // collision displace the partner, never the dancer mid-step (a leader
  // walking into the follower moves her — the sacada convention).
  if (app.stepAnims.length) return { figure: app.stepAnims[0].figure, jointName: null };
  const settled = app.lastEditedFigure
    ? { figure: app.lastEditedFigure, jointName: null } : null;
  if (!gizmoDragging() && performance.now() - app.editStamp > EDIT_HOLD_MS) return settled;
  if (app.ikState) return { figure: app.ikState.figure, jointName: app.ikState.chain.effector };
  if (app.selected) return app.selected;
  if (tcontrols.object?.userData.figure) {
    return { figure: tcontrols.object.userData.figure, jointName: null };
  }
  return settled;
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
  // A movement clip is a clean anatomy shot: the balance visuals step aside
  // (the View checkboxes keep their state and return when the clip exits), and
  // the dissociation wedge shows only if the clip itself asks for it.
  const on = !studio.clipActive;
  vizLeader.setVisible(on && vizFlags.cog && leader.group.visible, on && vizFlags.support && leader.group.visible);
  vizFollower.setVisible(on && vizFlags.cog && follower.group.visible, on && vizFlags.support && follower.group.visible);
  vizCouple.setVisible(on && vizFlags.couple && both, on && vizFlags.couple && vizFlags.support && both);
  dissocLeader.setVisible(((on && vizFlags.dissoc) || clipDissoc === leader) && leader.group.visible);
  dissocFollower.setVisible(((on && vizFlags.dissoc) || clipDissoc === follower) && follower.group.visible);
}

function animate() {
  requestAnimationFrame(animate);
  // Clamp dt so returning to a backgrounded tab can't feed the animation
  // players one giant step that overshoots.
  const dt = Math.min(clock.getDelta(), 0.1);
  if (orbit.update()) requestRender(2); // camera still moving (a drag / damping)

  // An in-flight animation (A→B, sequence, video export, a walking step) drives
  // the loop for as long as it runs.
  if (app.interpPlaying || app.seqPlaying || app.recording || app.stepAnims.length
    || studio.clipPlaying || studio.recorder)
    requestSim(2);

  if (simFrames <= 0) {
    // Idle: nothing changed and nothing is animating. Redraw only if the VIEW
    // still owes frames (camera damping settling, a hover glow), then skip the
    // whole constraint/analysis pass below.
    if (renderFrames > 0) { renderFrames--; studio.renderFrame(); }
    return;
  }
  simFrames--;
  if (renderFrames > 0) renderFrames--;

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
  if (app.recording?.rec) {
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

  // A movement clip poses its dancer for this frame (studio.js).
  studio.update(dt);

  // Keep the embrace through whatever moved this frame: torso contact first
  // (it translates a dancer), the floor clamp, then re-join the hands (arm
  // rotations only, so they cannot disturb the floor contact).
  const editing = embraceEditing();
  // Anchor mode (hands-on embrace placement) suspends every constraint that
  // MOVES a dancer — the torso pull, pin adaption, body collision and the
  // embrace hand auto-join — so posing one dancer's arm can't shove the
  // partner. The floor clamp still runs (feet stay grounded) and the visuals
  // still refresh; only the couple-moving reactions are held off.
  // A movement clip shows one dancer alone on a stage: the couple constraints
  // are held off exactly as in Anchor mode, or the hidden partner would be
  // shoved about by (and shove) the limb being demonstrated.
  const held = app.anchored || studio.clipActive;
  if (!held) {
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
  }

  // Floor collision: no body part may end up below the dance floor,
  // whatever edit produced the pose (gizmo, slider, IK, preset, import).
  leader.clampToFloor();
  follower.clampToFloor();

  if (!held) {
    embrace.maintainHands(editing);

    // Contact pins, limb half: an adapting arm/leg re-solves so its pinned spot
    // reaches the partner's. After the embrace hands so a pin on an embrace arm
    // deliberately wins (the pin is the more specific intent).
    pins.maintainLimbs(editing?.figure ?? null);
  }
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

  if (vizFlags.dissoc || clipDissoc) {
    if (leader.group.visible) dissocLeader.update(leader);
    if (follower.group.visible) dissocFollower.update(follower);
  }

  // The clip's angle arc / plane of motion read the pose every constraint and
  // the floor clamp have now finished with.
  studio.updateViz();

  statsTimer += dt;
  if (statsTimer > 0.25) {
    statsTimer = 0;
    app.ui.updateStats({ a: rA, b: rB, couple });
  }

  studio.renderFrame();
}

app.setViz = (flags) => {
  vizFlags = flags;
  applyVizVisibility();
};
app.setVisibleFiguresRefresh = applyVizVisibility;
app.setViz(vizFlags);

// Present mode owns the keyboard outright, in the CAPTURE phase: the arrow and
// Page keys are already bound to nudging a joint or a figure, and a presenter
// stepping through slides must not pose a dancer by accident. Everything here
// is consumed, so no bubble-phase handler sees it.
//
// The key set is what a presenter remote actually sends: most send Page Down /
// Page Up for next / previous, some send the arrows, so both are bound.
window.addEventListener('keydown', (e) => {
  if (!app.presenting) return;
  const k = e.key;
  let handled = true;
  if (k === 'Escape') app.exitPresent();
  else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') app.gotoSlide(1);
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') app.gotoSlide(-1);
  else if (k === 'Home') { app.slideAt = -1; app.gotoSlide(1); }
  else if (k === 'f' || k === 'F') {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (k === ' ' || e.code === 'Space') {
    // Play whatever movement this slide is about: a keyframe sequence first,
    // then an A→B comparison, and failing both just advance the deck.
    if (app.seqStates.length >= 2) app.playSeq();
    else if (app.interpStates) app.playInterp();
    else app.gotoSlide(1);
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// Leaving fullscreen by any route the page does not see — the browser eats Esc
// to exit fullscreen, and F11 never reaches us at all — must also leave Present
// mode, or the user is stranded with the sidebar and toolbar hidden and no
// visible way back. Nothing fires if the fullscreen request was refused (no
// user gesture, or policy), so an in-window presentation is unaffected.
document.addEventListener('fullscreenchange', () => {
  if (app.presenting && !document.fullscreenElement) app.exitPresent();
});

// Esc abandons whatever is half-finished — see app.cancelPending for the order.
// Never reached while presenting: the capture handler above consumes Escape.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') app.cancelPending();
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
//     pivoting on whichever axis the Move toolbar picks (support foot by
//     default, or the COG). "Move as couple" drives the pair about one
//     shared axis.
//   Move hips, Twist: ←/→ turn the pelvis under a still chest.
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
  // Anything focused inside the app chrome owns its own arrow/page keys: a
  // slider steps its value, a <select> changes option, a text field moves the
  // caret. The old guard exempted type="range" and never mentioned SELECT, so
  // this handler swallowed (and preventDefault'd) those keys and every slider
  // and dropdown in the sidebar was keyboard-dead. The 3D nudges only mean
  // anything when focus is on the canvas/body.
  if (t && (t.closest?.('#sidebar, #topbar') || t.isContentEditable
            || /^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (gizmoDragging()) return; // don't fight a live mouse drag
  const k = e.key;
  const coarse = e.shiftKey ? 3 : 1;

  // Move / Step: drive the active figure (arrows only).
  if (app.mode === 'move' || app.mode === 'step') {
    // This mode owns the whole nudge key set, so consume it here — before the
    // early-outs below. PageUp/PageDown have no meaning for a figure slide, but
    // returning without preventDefault let them scroll the page out from under
    // the user instead of being swallowed by the mode they're in.
    e.preventDefault();
    const fig = app.activeFigure;
    if (!fig || !fig.group.visible || !k.startsWith('Arrow')) return;
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
    // Hips-twist: ←/→ turn the pelvis under the still chest instead of sliding
    // the handle; the other keys still slide/raise it.
    if (handle === hipsTarget && app.hipsTool === 'twist'
        && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      const want = (k === 'ArrowLeft' ? 1 : -1) * NUDGE_TURN * coarse;
      const applied = app.pivotHips(app.hipsState.figure, want);
      reportHipsTwist(app.hipsState.figure, want, applied); // same clamp, same message
      app.hipsState.lastYaw += applied;
      hipsTarget.rotation.y = app.hipsState.lastYaw;
      if (app.ui) app.ui.refreshJointValues();
      return;
    }
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
  studio.layoutCanvas(); // window-filling, or the letterboxed 16:9 slide frame
  requestRender(); // the canvas is now a new size — redraw it
});

// Keep the render loop awake while the user interacts (see "on-demand render"
// above). A pointer MOVE is hover/orbit only — a redraw, no re-solve — so it
// pokes requestRender; every discrete interaction (press/release, wheel, key,
// and any form-control input) may change a pose, so it pokes the full solve.
// Capture phase + a wide net means a handler that stops propagation can't
// starve the loop.
window.addEventListener('pointermove', () => requestRender(), { passive: true, capture: true });
for (const ev of ['pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'click', 'change', 'input']) {
  window.addEventListener(ev, () => requestSim(), { passive: true, capture: true });
}

// Wrap the programmatic API so every app.* call re-solves + redraws afterward,
// without each method having to remember to poke. This is what keeps the UI and
// the headless verification scripts (which drive app.* directly, firing no DOM
// events) from screenshotting a stale frame. Pure readers that fire during
// hover/orbit are skipped so merely looking around never triggers a re-solve;
// markEdit and the infra pokers already poke themselves.
const RENDER_WRAP_SKIP = new Set(['requestSim', 'requestRender', 'markEdit', 'visibleFigures', 'status']);
for (const key of Object.keys(app)) {
  if (typeof app[key] !== 'function' || RENDER_WRAP_SKIP.has(key)) continue;
  const orig = app[key];
  app[key] = function (...a) {
    const r = orig.apply(this, a);
    requestSim();
    return r;
  };
}

animate();

// Handy for debugging from the browser console.
window.__app = app;
