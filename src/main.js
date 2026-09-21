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
import { ElbowHold, captureArm, solveElbow, ELBOW_TOL } from './armFrame.js';
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

// "Fix elbows": a dancer's two elbows held where they are in the room while
// the body turns under them — the shoulder part of a pivot. See armFrame.js.
const elbowHold = new ElbowHold();
scene.add(elbowHold.group);
// A pose applied OUTRIGHT (a preset, an undo, a slide, a scrub) takes the hold
// with it — but not at the instant it lands: the couple constraints then get a
// frame or two to settle the new pose (the close-embrace pull and collision
// slide a dancer several cm), and elbows captured before that would be held in
// the room while the body was moved out from under them. So the loop
// re-captures for this many frames instead of holding.
let holdRecaptureFrames = 0;
function recaptureElbowHold() {
  if (!elbowHold.count) return;
  elbowHold.recapture();
  holdRecaptureFrames = 3;
}

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
// The COG drop line is a TUBE, not a THREE.Line. WebGL ignores
// LineBasicMaterial.linewidth on every desktop driver, so a line has exactly
// one width and "make it thicker" is not expressible at all; a cylinder scaled
// per frame is. The dashes come from an alpha map repeating along the tube,
// with the repeat re-derived from its length each frame so a dash stays the
// same size however tall the dancer's COG sits.
const DROP_DASH_PERIOD = 0.05; // metres per dash + gap
const DROP_UNIT = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
DROP_UNIT.translate(0, 0.5, 0); // base at the origin, growing up +y

function dashAlphaMap() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 16;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 4, 16);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 4, 10); // ~60% dash, 40% gap
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// What the COG line's width slider offers, in metres (diameter).
const COG_LINE_MIN = 0.002;
const COG_LINE_MAX = 0.03;
const COG_LINE_NAMES = { leader: 'Leader', follower: 'Follower', couple: 'Couple' };

class BalanceViz {
  constructor(colorHex, key) {
    this.group = new THREE.Group();
    this.color = new THREE.Color(colorHex);
    this.key = key; // 'leader' | 'follower' | 'couple', for click routing
    this.front = false; // draw the COG indicator in front of the dancers
    this.lineWidth = 0.006;
    this.lineColor = null; // null = the dancer's own colour

    this.cogBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 14, 10),
      new THREE.MeshBasicMaterial({ color: colorHex }),
    );
    this.cogBall.userData.viz = this; // click routing (see handleClick)
    this.dropLine = new THREE.Mesh(DROP_UNIT, new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.85,
      alphaMap: dashAlphaMap(), alphaTest: 0.4, side: THREE.DoubleSide,
    }));
    this.dropLine.userData.viz = this; // the line is clickable too — see cogHit
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
    // Stand the tube from the floor up to the COG: one scale + one position,
    // no geometry work. The alpha map's repeat follows the height so the dash
    // pitch stays constant instead of stretching with the dancer.
    const len = Math.max(cog.y - 0.002, 1e-4);
    const r = this.lineWidth / 2;
    this.dropLine.position.set(cog.x, 0.002, cog.z);
    this.dropLine.scale.set(r, len, r);
    this.dropLine.material.alphaMap.repeat.set(1, len / DROP_DASH_PERIOD);
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

  // The drop line's own look. `width` is a diameter in metres; `color` null
  // hands it back to the dancer's identity colour, which is what the ball, the
  // hull and the stats panel all use to say WHOSE balance this is — so it is a
  // deliberate opt-out rather than a value to be overwritten silently.
  setLineStyle({ width, color } = {}) {
    if (Number.isFinite(width)) {
      this.lineWidth = THREE.MathUtils.clamp(width, COG_LINE_MIN, COG_LINE_MAX);
    }
    if (color !== undefined) this.lineColor = color;
    this.dropLine.material.color.set(this.lineColor ?? this.color);
    // Apply the radius NOW rather than waiting for the next balance pass: the
    // viz only updates on a solve frame, and a width slider that does nothing
    // until the dancer next moves reads as a broken slider.
    this.dropLine.scale.x = this.lineWidth / 2;
    this.dropLine.scale.z = this.lineWidth / 2;
    return this.lineStyle();
  }

  lineStyle() {
    return { width: this.lineWidth, color: this.lineColor ?? `#${this.color.getHexString()}` };
  }
}

const vizLeader = new BalanceViz(0x7fb3e8, 'leader');
const vizFollower = new BalanceViz(0xe89ab8, 'follower');
const vizCouple = new BalanceViz(0xffe08a, 'couple');
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
drawings.setFigures([leader, follower]); // an annotation stores a dancer by index
drawings.setCamera(camera);              // a floating text billboards toward it
scene.add(drawings.group, drawings.previewGroup, drawings.handleGroup);

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

// A keyframe carries TWO numbers, because a movement is not only travel: how
// long it takes to GET INTO this pose (`move`, the transition from the keyframe
// before it) and how long the couple then STAYS in it (`hold`). The timeline is
// therefore hold₀, move₁, hold₁, move₂, hold₂, … — the first keyframe has no
// move (nothing precedes it to travel from) and the last one does have a hold
// (a video that lingers on the end pose).
//
// Both are OPTIONAL at read time, which is what keeps every older chain
// playing: an A/B pair carries neither and falls back to the shared tempo with
// no hold, exactly as it did. The legacy field is `dur` — "seconds to reach the
// NEXT keyframe", i.e. keyframe i's `dur` is keyframe i+1's `move` — and it is
// migrated once at the entry points (see normalizeSeqTiming) so a reordered row
// carries its own numbers with it rather than inheriting its neighbour's. The
// fallback below is the second half of that: a chain that never went through an
// entry point (any raw array handed straight to applyStatesT) still reads.
function seqTiming(states) {
  const holds = []; // holds[j] = seconds standing still ON keyframe j       (n)
  const moves = []; // moves[j] = seconds travelling from j into j+1       (n-1)
  // Read RAW — finite and positive, nothing else. The bounds are the setters'
  // job, exactly as they were for `dur`: a reader that quietly re-clamps makes
  // a hand-edited file play something other than what it says, and makes the
  // row disagree with the playback about which number is in force.
  for (let j = 0; j < states.length; j++) {
    const h = Number(states[j]?.hold);
    holds.push(Number.isFinite(h) && h > 0 ? h : 0);
    if (j === 0) continue;
    const m = Number(states[j]?.move);
    const legacy = Number(states[j - 1]?.dur);
    moves.push(Number.isFinite(m) && m > 0 ? m
      : Number.isFinite(legacy) && legacy > 0 ? legacy
        : SEQ_SEG_SECONDS);
  }
  const total = holds.reduce((a, b) => a + b, 0) + moves.reduce((a, b) => a + b, 0);
  return { holds, moves, total };
}

function statesSeconds(states) {
  return seqTiming(states).total;
}

// Where t ∈ [0, 1] of the chain's RUNNING TIME lands: segment `i` at fraction
// `u`, plus `at` — the keyframe whose extras are showing.
//
// The walk advances on a STRICT `>` at every phase boundary, which is what
// makes the reduction exact: with every hold 0 this is the old equal-time
// split down to the last bit, an exact boundary still resolving as u = 1 of
// the segment just finished rather than u = 0 of the next (the two give the
// same pose, but only one of them is the arithmetic that used to run).
//
// `at` follows the long-standing rule — extras come from the keyframe being
// travelled FROM and hold until the next is REACHED — which now reads as: the
// keyframe we are standing on, or the one we are leaving. A hold is therefore
// covered by construction, and the hand-over still happens at the instant the
// next keyframe is reached (u = 1), whether a hold follows it or not.
//
// "Reached" is read with a hair of slack, and that slack is load-bearing. `t`
// is a FRACTION of the total, so anything that names a keyframe by its time
// (seqKeyframeT, which Show uses; the players' final t = 1) hands us
// arrival/total multiplied back by total — and in binary that round trip lands
// an ulp short about a third of the time (measured over 1.2M random chains:
// 250,764 of 800,672 arrivals came back as u = 0.999999999999999). `u` itself
// is passed on RAW, so the pose is unaffected either way; but `at` is a
// DISCRETE choice between two keyframes' captions, names, drawings and muscle
// highlighting, and it must not turn on one ulp. With the slack, every one of
// those 1.2M arrivals resolves to the keyframe actually arrived at.
const U_ARRIVED = 1 - 1e-9;
function seqTimeMap(states, t) {
  const segs = states.length - 1;
  if (segs < 1) return { i: 0, u: 0, at: 0 };
  const { holds, moves, total } = seqTiming(states);
  let time = THREE.MathUtils.clamp(t, 0, 1) * total;
  for (let j = 0; j < segs; j++) {
    if (time <= holds[j]) return { i: j, u: 0, at: j }; // standing on keyframe j
    time -= holds[j];
    // The last segment swallows whatever is left: past its end we are in the
    // final keyframe's own hold, which is u = 1 of it.
    if (time <= moves[j] || j === segs - 1) {
      const u = THREE.MathUtils.clamp(time / moves[j], 0, 1);
      return { i: j, u, at: u >= U_ARRIVED ? j + 1 : j };
    }
    time -= moves[j];
  }
  return { i: segs - 1, u: 1, at: segs }; // unreachable; the clamp above ends the walk
}

// ------------------------------------------------ eased transitions
// A transition is a straight lerp in TIME by default, so the couple starts and
// stops dead — robotic, and a linear move INTO a hold is a visible jolt (full
// speed to standing still in one frame). With the sequence's `ease` toggle on
// (app.setSeqEase) the within-segment fraction is remapped so a movement leaves
// and arrives gently instead.
//
// It is remapped HERE, on the TIME → pose-parameter path, and deliberately NOT
// inside applyStatesU: the COG trail samples applyStatesU by pose parameter,
// and the PATH the couple walks must not depend on the tempo it is walked at.
// Easing changes WHEN the couple is where, never WHERE it goes — so the trail
// is byte-identical with the toggle on and off, which dev-verify-seq-ease.mjs
// checks rather than assumes. `at` (the keyframe whose extras show) is decided
// by seqTimeMap from the time PHASE and is untouched for the same reason.
//
// THE REST RULE. Easing every segment to a full stop at every keyframe turns a
// flowing figure — a giro is four keyframes the couple never stands still in —
// into a stutter: stop, go, stop, go. So each END of a segment is eased only
// where the couple is really at rest: the chain's own first and last keyframes
// (nothing precedes or follows them to be moving from), and any keyframe with a
// hold > 0, which the timeline literally stands on. A pass-through keyframe —
// hold 0, mid-chain — is crossed at speed.
//
// That leaves a velocity STEP at a pass-through keyframe whenever the two
// segments differ in duration or in distance covered (a 0.5 s transition into a
// 4 s one arrives eight times faster than it leaves). Accepted, and said out
// loud: it is exactly what the linear timeline does today, and smoothing it
// means a spline THROUGH the keyframes, which would move the path — the one
// thing this must not touch.
function restsOn(states, j) {
  // The ends of the chain rest by construction; elsewhere it takes a hold.
  // Read exactly as seqTiming reads it (raw, finite, positive) so the curve and
  // the clock can never disagree about which keyframes are rests.
  if (j === 0 || j === states.length - 1) return true;
  const h = Number(states[j]?.hold);
  return Number.isFinite(h) && h > 0;
}

// ONE curve, taken whole or by halves — there is no per-keyframe curve picker
// and no second easing to tune. smoothstep u²(3−2u) is the S: zero velocity at
// both ends, peak 1.5× the average through the middle. A segment eased at one
// end only takes the HALF of that same S it needs, stretched back over [0, 1]:
// the first half leaves at rest and arrives at 1.5×, the second half enters at
// 1.5× and stops. Using the halves is also what keeps the two sides of a
// pass-through keyframe agreeing — both free ends run at 1.5× — where two
// independent curves would meet at whatever slopes they happened to have.
//
// Every branch is exactly 0 at u = 0 and exactly 1 at u = 1 in floating point
// (smoothstep(0.5) is 0.5 exactly), so a keyframe arrival still renders that
// keyframe's own pose bit for bit — applyStatesU short-circuits u = 0/1 — and a
// hold stays byte-stable across its whole band.
//
// smootherstep (6u⁵−15u⁴+10u³) was the other candidate and is NOT used, and
// the choice was made by LOOKING at the motion rather than by taste. Filmed at
// nine equal time steps over a 131.8° sweep taking 2.4 s, its peak per-frame
// travel is 1.875× the mean against smoothstep's 1.500×, and the pose takes
// 0.23 s to move even one degree off the keyframe it is leaving, against
// 0.13 s — a fifth of the transition spent parked at each end, paid for with a
// lurch through the middle. On a tango transition, which is unhurried to begin
// with, that reads as hesitation rather than as grace. Its one real advantage,
// continuous acceleration, is unrealizable here anyway: the free end of a
// one-sided segment has a corner in the velocity whatever curve feeds it.
function easeU(states, i, u) {
  const leaves = restsOn(states, i); // travelling OUT of a keyframe it rested in
  const arrives = restsOn(states, i + 1); // …and INTO one it will rest in
  if (leaves && arrives) return smoothstep(u);
  if (leaves) return 2 * smoothstep(u / 2); // rest → speed (the S's first half)
  if (arrives) return 2 * smoothstep(0.5 + u / 2) - 1; // speed → rest (its second)
  return u; // passed through at speed, both ends
}

// Where keyframe i sits ON THE SCRUBBER: the moment the chain ARRIVES at it,
// i.e. the START of its hold. Keyframe 0 is t = 0; the last keyframe is t = 1
// exactly when it has no hold of its own, and earlier by that hold when it
// does (the tail of the timeline is time spent standing ON it, not travelling
// to it).
//
// This is the inverse of seqTimeMap's walk and is written as the same sum, so
// the two cannot drift apart: hold₀ + move₁ + hold₁ + move₂ … up to but not
// including keyframe i's own hold.
function keyframeT(states, i) {
  const { holds, moves, total } = seqTiming(states);
  const k = Math.min(Math.max(i | 0, 0), states.length - 1);
  if (k <= 0 || !(total > 0)) return 0;
  let time = 0;
  for (let j = 0; j < k; j++) time += holds[j] + moves[j];
  return THREE.MathUtils.clamp(time / total, 0, 1);
}

// ------------------------------------------------ stopping a player
// The ONE place either player's running flag is cleared. Five paths end a
// playback — a stop, a natural finish, a chain that shrank below two
// keyframes, new snapshots replacing the chain, and a video capture taking the
// player over — and each of them has to tell the UI, or a Play button is left
// reading "■ Stop" with nothing running. That stuck button is the whole bug
// this funnel exists to make impossible, so never clear the flags by hand.
// Returns whether anything actually was playing.
function clearPlaying({ seq = true, interp = true } = {}) {
  const was = (seq && app.seqPlaying) || (interp && app.interpPlaying);
  if (seq) app.seqPlaying = false;
  if (interp) app.interpPlaying = false;
  if (was && app.ui) app.ui.onPlaybackChanged();
  return was;
}

// Where a Play press starts from — the media-player rule. The scrubber's own
// position when it sits strictly INSIDE the movement (playback was stopped
// there, or the user dragged it there), because stop is a pause and Play after
// a pause means "carry on". At either end it means "from the top": at 1 there
// is nothing left to play, and at 0 the start is where it already is.
const RESUME_EPS = 1e-4;
function resumeT(t) {
  return Number.isFinite(t) && t > RESUME_EPS && t < 1 - RESUME_EPS ? t : 0;
}

// The EXTRAS a keyframe may carry beside its pose, in its own `kf` block:
// which floor drawings it shows (`kf.draw`), its on-screen caption
// (`kf.caption`) and its muscle highlighting (`kf.muscles`). Each reads the
// field it owns and leaves the rest of `kf` alone, so the three features cannot
// tread on each other — nor on a key a later one adds.
//
// Absent or null means "whatever the user has running", which is what makes
// every keyframe authored before this behave exactly as it did — and it is why
// this is safe to run from the interpolator: an untagged chain hands the
// running state back over and over, which is the state a session that has never
// tagged anything is already in.
// The keyframe whose extras are on screen. Kept so an edit made WHILE that
// keyframe is showing lands at once (a caption you are typing has to appear as
// you type it), without having to re-derive "which keyframe is current" from
// the scrubber — Show (seqApply) does not move the scrubber, so t is not an
// honest answer to that question.
let shownExtras = null;

// A keyframe's name, as the PICTURE should carry it — the empty string for a
// keyframe the user never named. `seqAdd` stores no name at all now, but every
// sequence saved before it did carries a literal "Keyframe 3", and those are
// not names: they are the row's own placeholder, frozen into the file, and they
// go STALE the moment the row is reordered. Stamping one across a recorded
// video would label the third step "Keyframe 1". So only a name the user
// actually typed is drawn — the row goes on showing (and editing) whatever the
// keyframe really holds.
const AUTO_NAME = /^Keyframe \d+$/;
function screenName(state) {
  const n = typeof state?.name === 'string' ? state.name.trim() : '';
  return n && !AUTO_NAME.test(n) ? n : '';
}

// ---- which drawings a keyframe shows -------------------------------------
// Two keys, and the second one is what makes "draw this for keyframe 3 alone"
// one gesture instead of a tour of every other row:
//   kf.draw — the SUBSET this keyframe was tagged with (captured from screen).
//   kf.own  — drawings AUTHORED FOR this keyframe while it was focused (✎).
//
// The rule is  shown(X) = base(X) ∪ X.kf.own, with
//   base(X) = X.kf.draw     when X is tagged,
//           = every drawing NO keyframe owns, otherwise.
// So an owned drawing is private to its owner(s) — an untagged keyframe's
// "all of them" stops meaning "including the ones that belong to somebody
// else" — while an ordinary drawing still shows on every untagged keyframe.
// Ownership is a UNION, not a move: a duplicated keyframe shares its
// original's ids and both go on showing the drawing.
//
// REDUCTION GUARD: with nothing owned anywhere and X untagged this returns
// exactly `null` — the filter every sequence authored before this carries, and
// the one `Drawings.setVisibleIds` treats as "no filter at all". Nothing about
// an existing timeline changes until somebody uses ✎.
let ownedCache = null; // ids owned by SOME keyframe; invalidated in onSeqChanged
function ownedDrawIds() {
  if (ownedCache) return ownedCache;
  const s = new Set();
  for (const st of app.seqStates) for (const id of st?.kf?.own ?? []) s.add(id);
  return (ownedCache = s);
}

function keyframeDrawFilter(state) {
  const kf = state?.kf;
  const tagged = Array.isArray(kf?.draw) ? kf.draw : null;
  const own = Array.isArray(kf?.own) ? kf.own : null;
  const owned = ownedDrawIds();
  if (!tagged && !owned.size) return null; // the reduction: no filter at all
  // A tagged keyframe's base is exactly what it captured; an untagged one's is
  // the PUBLIC diagram — everything nobody has claimed.
  const base = tagged ?? drawings.ids().filter((id) => !owned.has(id));
  if (!own?.length) return [...base];
  return [...new Set([...base, ...own])];
}

function applyKeyframeExtras(state) {
  // Which keyframe is CURRENT is otherwise invisible — it decides where
  // "+ Add keyframe" inserts, so the row wears a marker. The panel is told
  // only when the answer actually CHANGES, by object identity: this runs every
  // frame of a playback, and renderSequence rebuilds every row (it would tear
  // the caret out of a label being typed sixty times a second). The identity
  // test is also what keeps a re-apply of the SAME keyframe — seqSetCaption
  // and friends do one on every keystroke — free.
  const moved = (state ?? null) !== shownExtras;
  shownExtras = state ?? null;
  const kf = state?.kf;
  drawings.setVisibleIds(keyframeDrawFilter(state));
  // The caption and the name are the extras with no running counterpart: the
  // panel holds no live caption to inherit, so the neutral state is simply no
  // text and an untagged keyframe clears the band. `*Hidden` is applied by
  // handing the studio an empty string, which is also what makes the block
  // un-grabbable and keeps it out of every export — one rule, not three.
  studio.setCaption(
    kf?.captionHidden || typeof kf?.caption !== 'string' ? '' : kf.caption,
    kf?.captionColor ?? null);
  studio.setSeqName(kf?.nameHidden ? '' : screenName(state), kf?.nameColor ?? null);
  // The muscle look DOES have a running counterpart — the Muscles panel's own
  // lit set and colours — so an untagged keyframe hands it back rather than
  // going dark. It is applied as a VIEW OVERRIDE that never reaches storage;
  // see ui.setMuscleOverride for why this must not go through applyViewState.
  app.ui?.setMuscleOverride(kf?.muscles ?? null);
  if (moved) app.ui?.onShownKeyframeChanged?.();
  requestRender(); // all three are view changes; main.js renders on demand
}

// Write ONE field of a keyframe's `kf` block. The block is MERGED, never
// rebuilt: three features hang their own key here and each owns exactly one of
// them. `value === null/undefined` deletes that key rather than writing null,
// so a keyframe that was never tagged and one that was untagged serialize
// identically — and an emptied block is dropped, so nothing of this feature is
// left behind in a file that uses none of it.
function setKfField(state, key, value) {
  if (!state) return;
  const kf = { ...(state.kf || {}) };
  if (value === null || value === undefined) delete kf[key];
  else kf[key] = value;
  if (Object.keys(kf).length) state.kf = kf;
  else delete state.kf;
}

// ---- the per-keyframe EDIT FOCUS (✎) -------------------------------------
// "Add this drawing / this highlight to keyframe 3 and nowhere else" used to be
// four gestures in three places (draw it, then visit every OTHER keyframe, hide
// it there, re-capture its ◻). Focus turns it into one: while keyframe K is
// focused the couple stands at K, every drawing authored belongs to K
// (kf.own), and every Muscles-panel edit writes K's kf.muscles instead of the
// user's running look.
//
// Tracked by IDENTITY, not by index — a reorder must not silently move the
// focus to whichever keyframe slid into that row. Session state, deliberately:
// it is never serialized into a keyframe and never persisted, because it is a
// mode the user is in, not something the lesson carries.
let seqFocusState = null;

// Leave the focus. `handBack` says whether the TIMELINE has finished speaking
// too: true drops the keyframe's extras (the floor shows the whole diagram, the
// Muscles panel takes its own look back), false leaves them because the caller
// is about to apply another keyframe's — Show, a scrub, a player, focusing a
// different row. Returns whether anything was focused.
function endSeqFocus(handBack = true) {
  if (!seqFocusState) return false;
  seqFocusState = null;
  if (handBack) applyKeyframeExtras(null);
  app.ui?.onSeqFocusChanged?.();
  requestRender();
  return true;
}

// The focused keyframe's index, or -1. Resolved live: if the state has left the
// chain (deleted, replaced by an import) the focus is stale and is dropped
// here, so nothing downstream has to carry a second copy of that rule.
function seqFocusIndex() {
  if (!seqFocusState) return -1;
  const i = app.seqStates.indexOf(seqFocusState);
  if (i < 0) { seqFocusState = null; app.ui?.onSeqFocusChanged?.(); }
  return i;
}

// Pose the couple at t ∈ [0, 1] along a chain of couple states — the A→B
// lerp generalized to any number of keyframes. `t` is a fraction of the whole
// chain's RUNNING TIME, so a keyframe held longer occupies more of the
// scrubber; with equal durations this is exactly the old equal-time split.
// The scrubber/player of both the A/B compare and the movement sequence land here.
//
// `extras` is the one caller that must opt OUT: updateCogTrail runs this ~289
// times per edit to sample the COG path, and a trail rebuild is not a scrub —
// it must not leave the floor diagram set to whatever the last sample said.
//
// `ease` is RESOLVED BY THE CALLER, never sniffed from the array: the sequence
// players pass app.seqEase(), and the A→B compare — a bare [A, B] pair with no
// settings of its own — passes nothing and stays linear. Defaulting it off is
// also what keeps every chain handed straight to this function by a script
// playing exactly as it did.
function applyStatesT(states, t, { extras = true, ease = false } = {}) {
  if (!states || states.length < 2) return; // nothing to travel between
  const { i, u, at } = seqTimeMap(states, t);
  // Extras come from the keyframe being travelled FROM and hold until the next
  // one is REACHED — a diagram that re-picked itself every frame would flicker
  // its way through a recorded video. seqTimeMap has already worked out which
  // keyframe that is, holds included; easing never moves a phase boundary, so
  // this answer is the same either way.
  if (extras) applyKeyframeExtras(states[at]);
  applyStatesU(states, i, ease ? easeU(states, i, u) : u);
}

// Pose the couple at POSE PARAMETER (i, u): fraction u of segment i, with no
// reference to the clock at all. Split out of applyStatesT because the two
// questions are genuinely different — the players ask "where are we at this
// moment", the COG trail asks "draw the PATH" — and a path sampled by time
// wastes its samples wherever the couple is standing still and thins out the
// very parts that move (a 6 s hold beside a 0.5 s move would spend twelve
// times the ink on a single point). Sampling by pose parameter makes a hold
// cost nothing, which is the honest drawing of a trail.
//
// u = 0 and u = 1 are EXACT: lerpPose short-circuits both (three's slerp does
// too), so a hold really does render its keyframe's own pose rather than a
// rounded copy of it.
function applyStatesU(states, i, u) {
  const sA = states[i];
  const sB = states[i + 1];
  // Foot anchors first: measuring applies the endpoint poses, which the
  // lerped pose below overwrites.
  const feetA = app.interpGroundFeet ? stateFeet(sA) : null;
  const feetB = app.interpGroundFeet ? stateFeet(sB) : null;
  app.figures.forEach((f, j) => {
    f.setPose(lerpPose(sA.figures[j], sB.figures[j], u));
    if (feetA && feetB) groundInterpFeet(f, feetA[j], feetB[j], u);
  });
}

// Migrate a chain's timing to the two-number form, in place, ONCE — at every
// entry point a chain can arrive through (setSeqStates, which the localStorage
// restore and the JSON import both go through).
//
// The legacy `dur` on keyframe i means "seconds to reach the next one", so it
// is keyframe i+1's `move`, and the old chains all had no holds. Doing it here
// rather than only at read time is what makes a REORDER behave: `dur` belongs
// to the gap AFTER a row, so dragging row 3 to the top would otherwise hand it
// whatever the row now above it happens to say. `move` belongs to the keyframe
// itself and travels with it. The read-time fallback in seqTiming stays as
// well, for a raw array that never passed through here (an A/B pair, a chain a
// script builds by hand).
function normalizeSeqTiming(states) {
  if (!Array.isArray(states)) return states;
  states.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const m = Number(s.move);
    if (!(Number.isFinite(m) && m > 0) && i > 0) {
      const legacy = Number(states[i - 1]?.dur);
      // Carried across UNCLAMPED: this is a rename, and a migration that
      // quietly changes a number is a migration that cannot be trusted. The
      // chain must play exactly as it did before it was loaded.
      if (Number.isFinite(legacy) && legacy > 0) s.move = legacy;
    }
  });
  // Dropped only after every keyframe has read its predecessor's: leaving it
  // would give the same gap two owners, which is the bug this migration exists
  // to prevent.
  for (const s of states) { if (s && typeof s === 'object') delete s.dur; }
  return states;
}

// Default tempo of the A→B player and of a new keyframe (seconds to travel
// into it); a keyframe can override it with its own `move`, within these
// bounds.
const SEQ_SEG_SECONDS = 2.4;
const SEQ_MIN_SECONDS = 0.2;
const SEQ_MAX_SECONDS = 30;
// How long a NEW keyframe stands in its pose. Zero, deliberately: a chain with
// no holds is exactly the old equal-time split, so the second number costs a
// user who never touches it nothing at all — neither a changed playback nor a
// changed recording. A hold may be 0, which is why it has its own floor rather
// than sharing SEQ_MIN_SECONDS (a move may not: a zero-length transition is a
// cut, and it would divide the timeline by zero).
const SEQ_HOLD_SECONDS = 0;
// Whether a sequence STARTED FROM SCRATCH in this session eases its
// transitions. On, because new work should look right without having to be
// told to — but only for a timeline the user begins empty (see seqAdd). A
// chain arriving from anywhere else defaults OFF and so plays exactly as it
// always has: a session restored from localStorage without the flag, and an
// imported file without the `ease` key, are both older work whose timing the
// author already judged (ui.js resolves both).
const SEQ_EASE_FRESH = true;
// Has anyone SAID what this timeline should do — the checkbox, a restored
// session, an imported file, a script? The fresh default applies only while
// nobody has, so unticking the box and THEN adding the first keyframe keeps the
// answer the user just gave instead of overruling it. Cleared when the timeline
// is emptied, because that ends the sequence the choice was about.
let seqEaseChosen = false;
// A keyframe's own label ("cross", "pivot out"). Capped because the row is one
// line in a 320 px sidebar — a label that cannot be read in the list is not
// identifying anything, and the cap is where the input stops taking, so the
// user sees the limit instead of losing the tail on save.
const SEQ_NAME_MAX = 40;
// A keyframe's on-screen caption. Far longer than the row's label because this
// one is a SENTENCE said to the class, not an identifier — but capped all the
// same: the caption band wraps to three lines and then ellipsizes, and text the
// slide cannot show is text the author cannot proof-read.
const SEQ_CAPTION_MAX = 160;

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

let trailReplaying = false;
function updateCogTrail() {
  for (const line of [...trailGroup.children]) {
    line.geometry.dispose();
    line.material.dispose();
    trailGroup.remove(line);
  }
  const states = app.trailStates();
  if (!states) return;
  // The replay below ends by putting back the very pose it started from, so it
  // is not "a pose applied outright" and must not re-capture the elbow hold —
  // mid-edit that would take the elbows' DRIFTED position as the new target.
  trailReplaying = true;
  const saved = app.getCoupleState('__trail');
  const series = { a: [], b: [], couple: [] };
  const segs = states.length - 1;
  const N = 32 * segs + 1;
  for (let k = 0; k < N; k++) {
    // Sampled by POSE PARAMETER, not by time: 32 samples per segment whatever
    // the segment's tempo, so a held keyframe costs one point instead of a
    // third of the trail's ink (see applyStatesU). Going through the pose
    // applier directly is also what keeps the extras out of it — sampling the
    // path is not showing a keyframe, and this runs ~289 times per edit.
    const p = (k / (N - 1)) * segs;
    const seg = Math.min(Math.floor(p), segs - 1);
    applyStatesU(states, seg, p - seg);
    leader.clampToFloor();
    follower.clampToFloor();
    const rep = coupleReport(leader, follower);
    series.a.push({ x: rep.a.cog.x, z: rep.a.cog.z, ok: rep.a.margin !== null && rep.a.margin > 0 });
    series.b.push({ x: rep.b.cog.x, z: rep.b.cog.z, ok: rep.b.margin !== null && rep.b.margin > 0 });
    series.couple.push({ x: rep.cog.x, z: rep.cog.z, ok: rep.margin !== null && rep.margin > 0 });
  }
  app.applyCoupleState(saved);
  trailReplaying = false;
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
// The frame turn's clamp, said out loud on the same terms as the hips twist's.
function reportFrameTurn(figure, wanted, applied) {
  if (Math.abs(wanted) < 1e-6 || Math.abs(applied) > Math.abs(wanted) - 1e-4) return;
  app.status(`${figure.name}'s frame can't turn further — the shoulder blades and shoulders are at their limit`, 'limit');
}

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

// …and where it meets the horizontal plane at height `y` (0 = the floor).
const _levelPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function planePointAtPointer(y = 0, out = new THREE.Vector3()) {
  _levelPlane.constant = -y;
  return raycaster.ray.intersectPlane(_levelPlane, out);
}

// Accept {x,z} / {x,y,z} / Vector3 and pin it to the floor plane.
function toFloorV3(p) {
  return new THREE.Vector3(p.x ?? 0, 0, p.z ?? 0);
}

// A drawing END: a joint anchor ({ fig, joint }) passes through untouched, and
// anything else is read as a floor point. ONE rule, so the scripted API, the
// click authoring and a handle drag all accept the same two forms.
function drawEnd(p) {
  return (p && p.joint) ? p : toFloorV3(p);
}

// The dancer an anchor names. `fig` is an index or 'leader'/'follower' (the
// same two forms Drawings.#end takes, which is where it is finally stored as an
// index — a record is plain JSON by construction).
function anchorFigure(at) {
  const i = typeof at?.fig === 'string' ? (at.fig === 'follower' ? 1 : 0) : (at?.fig ?? 0);
  return app.figures[i] ?? null;
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
  drawTool: 'line', // Draw-mode sub-tool: 'line' | 'arrow' | 'circle' | 'text' | 'facing'
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
  interpDone: null, // fired once when the A→B player reaches t = 1 (never on a stop)
  seqStates: [], // movement-sequence keyframes (couple states, ≥2 to play)
  seqPlaying: false,
  seqT: 0,
  seqTick: null, // UI callback fed the current t while the sequence plays
  seqDone: null, // fired once when the sequence player reaches t = 1 (never on a stop)
  // Ease transitions in and out of the keyframes the couple rests in — ONE
  // setting for the whole sequence (see easeU). Read through seqEase()/written
  // through setSeqEase(on), which is the whole API a sequence LIBRARY needs to
  // bundle it with the rest of a saved sequence's settings.
  seqEaseOn: SEQ_EASE_FRESH,
  recording: null, // { states, t, secs, ease, rec } while a video capture plays
  // Present mode held FOR a capture: { wasPresenting } from the moment the
  // first ⏺ enters it until the take really ends. It outlives the MP4→WebM
  // retry (which re-enters recordPlayback), or the retry would bounce out of
  // Present and back in — resizing the render target mid-capture — and lose
  // the memory of whether the user was presenting to begin with.
  recPresent: null,
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
    this.selectDrawing(null); // …and a drawing's endpoint handles
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
  // from the most transient thing on screen to the least: a running playback,
  // then a half-drawn floor shape, then a half-authored pin, then the
  // selection (with its gizmo). Each step says what it just abandoned — an
  // Escape that silently does nothing reads as an Escape that is not wired up.
  // Move-hips is exempt from the deselect step because its handle is seated
  // automatically with no click, so dismissing it would leave the mode with
  // nothing to drag.
  //
  // Playback goes FIRST because a moving dancer is the most pending thing on
  // screen: it is the only item here that is still changing, and Escape during
  // an animation can only mean "stop that".
  cancelPending() {
    if (this.stopPlayback()) {
      this.status('Playback stopped.', 'info');
      return 'playback';
    }
    if (this.drawPending) {
      this.cancelDraw();
      this.status('Drawing cancelled.', 'info');
      return 'draw';
    }
    if (this.cancelPinPending()) {
      this.status('Pin cancelled — the first spot was released.', 'info');
      return 'pin';
    }
    // The edit focus is a MODE, so it sits below the half-finished things and
    // above the selection: one Escape leaves it, and that same press must not
    // also deselect (the user would lose the joint or drawing they were on for
    // a keypress they meant for the mode).
    if (seqFocusIndex() >= 0) {
      this.seqFocus(null);
      return 'seqfocus';
    }
    if (this.drawSelected) {
      this.selectDrawing(null);
      this.status('Drawing deselected.', 'info');
      return 'drawing';
    }
    if (this.cogLineSelected) {
      this.selectCogLine(null);
      return 'cogline';
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
    endSeqFocus(true); // presenting is showing, not authoring
    this.presenting = true;
    container.parentElement.classList.add('presenting');
    this.setMode('rotate'); // no gizmos, no half-authored shapes on screen
    this.deselect();
    // The joint pick spheres go with the rest of the editing chrome: in the
    // skeleton and muscle views they are translucent blobs ringing every joint,
    // which belong to posing, not to a slide. They stay clickable.
    this.setPickSpheresVisible(false);
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
    this.setPickSpheresVisible(true);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    window.dispatchEvent(new Event('resize'));
    if (this.ui) this.ui.onPresentChanged?.();
  },

  togglePresent() {
    if (this.presenting) this.exitPresent(); else this.enterPresent();
  },

  // Show/hide every dancer's joint pick spheres. Hiding also drops the hover
  // state, or the dancer the cursor happened to be over would keep its whole
  // ghosted joint set on screen (setHover styles the set once, on entry).
  setPickSpheresVisible(on) {
    clearHover();
    for (const f of this.figures) f.setPickVisible(on);
    requestRender();
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

  // The chalk colour and stroke width the NEXT shape is drawn in. With a
  // drawing selected this restyles that one instead — the swatch is where you
  // look to change a colour, so it would be a poor tool if it only ever
  // applied to a shape that does not exist yet.
  // `extend` (metres) runs a line or arrow on past both of its points — the
  // same one-control-two-meanings rule as the colour and the width.
  setDrawStyle({ color, width, extend } = {}) {
    drawings.setStyle({ color, width, extend });
    const sel = drawings.selected;
    if (sel) drawings.restyle(sel, { color, width, extend });
    // A half-drawn shape survives a style change — the next pointermove
    // redraws its rubber band in the new look.
    this.ui?.onDrawingsChanged?.();
    requestRender();
    return { ...drawings.style };
  },

  get drawStyle() { return { ...drawings.style }; },

  // Select a committed drawing (an Object3D from app.draw.group, or null to
  // deselect) — its endpoint handles appear, and the toolbar follows its look.
  selectDrawing(obj) {
    const sel = drawings.select(obj);
    if (sel) {
      const { type, color, width, extend } = sel.userData.annotation;
      drawings.setStyle({ color, width });
      // Only a segment HAS an extension; selecting a circle must not zero the
      // slider the next line will be drawn with.
      if (type === 'line' || type === 'arrow') drawings.setStyle({ extend: extend ?? 0 });
    }
    this.ui?.onDrawSelectionChanged?.(sel);
    requestRender();
    return sel;
  },

  get drawSelected() { return drawings.selected; },

  // Drag one end of the selected shape. `index` is its position in
  // Drawings.handlePoints — 0/1 for the two ends of a line or arrow, centre/rim
  // for a circle. Scriptable so the gesture can be verified without a pointer.
  moveDrawHandle(obj, index, point, anchor = null) {
    const o = drawings.moveHandle(obj, index, point ? toFloorV3(point) : null, anchor);
    this.ui?.onDrawingsChanged?.();
    requestRender();
    return o;
  },

  // The ONE place a newly committed drawing lands, whichever tool or script
  // made it — which is what lets the edit focus claim it without four copies
  // of the rule (and what a fifth shape would inherit for free).
  afterDrawAdded(o) {
    this.claimForFocus(o);
    this.ui?.onDrawingsChanged?.();
    requestRender();
    return o;
  },

  // `a`/`b` are floor points ({x, z}) or JOINT ANCHORS ({ fig, joint }) — the
  // latter pins that end to a dancer, so the line leaves the floor and rides
  // the pose. `fig` takes an index or 'leader'/'follower'.
  addDrawLine(a, b) {
    return this.afterDrawAdded(drawings.addLine(drawEnd(a), drawEnd(b)));
  },

  addDrawArrow(a, b) {
    return this.afterDrawAdded(drawings.addArrow(drawEnd(a), drawEnd(b)));
  },

  addDrawCircle(center, radius) {
    return this.afterDrawAdded(drawings.addCircle(toFloorV3(center), radius));
  },

  // `pos` is a floor point ({x, z}) or a JOINT ANCHOR ({ fig, joint }), exactly
  // as addDrawLine's ends are. Anchored, the text floats a default height above
  // that joint and turns to face the camera; on the floor it lies flat and
  // reads right-way-up from the current camera unless a yaw is given.
  // `opts.lift` overrides the height (metres above the anchor, or above the
  // floor for an unanchored text, which lifts it and billboards it too).
  addDrawText(pos, text, yaw, opts = {}) {
    const end = drawEnd(pos);
    // Yaw is ignored while the text floats, but it is still worth deriving
    // from the anchor's own position: drag the text off the dancer later and it
    // lands on the floor readable rather than at whatever angle 0 happens to be.
    const at = end.joint ? anchorFigure(end)?.surfacePos?.(end.joint) : end;
    return this.afterDrawAdded(
      drawings.addText(end, String(text), yaw ?? (at ? textYawFromCamera(at) : 0), opts));
  },

  // A FACING arrow on a committed line/arrow (its Object3D from
  // app.draw.group, or its id): level with the floor, square to the line, from
  // its midpoint — a line across the hip bones, then this to show where the
  // hips point. `opts.len` is the signed length in metres; without it the arrow
  // takes the side the dancer faces (see Drawings.addFacing).
  addDrawFacing(line, opts = {}) {
    const o = drawings.addFacing(line, opts);
    return o ? this.afterDrawAdded(o) : null;
  },

  flipDrawFacing(obj = drawings.selected) {
    const o = drawings.flipFacing(obj);
    this.ui?.onDrawingsChanged?.();
    requestRender();
    return o;
  },

  removeLastDrawing() {
    drawings.removeLast();
    this.pruneOwnedDrawIds();
    this.ui?.onDrawSelectionChanged?.(drawings.selected);
    this.ui?.onDrawingsChanged?.();
    requestRender();
  },

  // Delete the selected drawing. Annotations sit outside the pose undo stack,
  // but ⌫ Last is right there and a drawing is one gesture to redraw, so this
  // deletes without a dialog (the bulk Clear is the one that asks).
  removeSelectedDrawing() {
    const sel = drawings.selected;
    if (!sel) return false;
    drawings.remove(sel);
    this.pruneOwnedDrawIds();
    this.ui?.onDrawSelectionChanged?.(null);
    this.ui?.onDrawingsChanged?.();
    requestRender();
    return true;
  },

  clearDrawings() {
    this.cancelDraw();
    drawings.clear();
    this.pruneOwnedDrawIds();
    this.ui?.onDrawSelectionChanged?.(null);
    this.ui?.onDrawingsChanged?.();
    requestRender();
  },

  // The whole diagram as plain JSON, and back — what ui.js saves to
  // localStorage on every mutation and what the sequence export carries. A
  // record is plain data by construction (an anchored end stores its dancer as
  // an index), so this is a round trip and not a re-authoring.
  drawingsJSON() {
    return drawings.toJSON();
  },

  setDrawings(list) {
    this.cancelDraw();
    const n = drawings.fromJSON(list);
    // An imported file may carry `own` ids naming drawings this diagram does
    // not have (a sequence exported without them, a hand-edited file). A stale
    // id is HARMLESS — it matches no child, so it filters nothing — but it
    // would keep `owned` non-empty and so keep the reduction guard from
    // firing, turning "no filter at all" into an explicit list of everything.
    this.pruneOwnedDrawIds();
    this.ui?.onDrawSelectionChanged?.(null);
    this.ui?.onDrawingsChanged?.();
    requestRender();
    return n;
  },

  // Which drawings are on screen: an array of ids, or null for all of them.
  // The timeline drives this from the keyframe being travelled from
  // (applyKeyframeExtras); by hand it is how a teacher builds the subset a
  // keyframe is then tagged with.
  get drawVisibleIds() { return drawings.visibleIds(); },
  get drawShownIds() { return drawings.shownIds(); },

  setDrawVisibleIds(ids) {
    const out = drawings.setVisibleIds(ids);
    this.ui?.onDrawingsChanged?.();
    requestRender();
    return out;
  },

  // Hide or show ONE drawing. The filter is expanded from null (everything) to
  // the full id list on the first hide, so a subset is always explicit — "all
  // but this one" cannot be stored, and a keyframe that captured it would then
  // silently gain every drawing authored after it.
  setDrawingVisible(obj, on) {
    const id = obj?.userData?.annotation?.id;
    if (!id) return null;
    const next = new Set(drawings.visibleIds() ?? drawings.ids());
    if (on) next.add(id); else next.delete(id);
    return this.setDrawVisibleIds([...next]);
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

  // --------------------------------------------------------- COG line style
  // Which COG drop line the View panel's width/colour controls act on, or null
  // for all three. Set by clicking a line in the 3D view; Esc clears it.
  cogLineSelected: null,

  selectCogLine(which) {
    this.cogLineSelected = this.cogViz[which] ? which : null;
    // Whatever is being styled has to be visible to style it.
    if (this.cogLineSelected) this.cogViz[this.cogLineSelected].setFront(true);
    this.ui?.onCogLineChanged?.(this.cogLineSelected);
    this.status(this.cogLineSelected
      ? `${COG_LINE_NAMES[this.cogLineSelected]} COG line selected — set its width and colour in the View panel. Esc deselects.`
      : 'COG line deselected — width and colour now apply to all of them.', 'info');
    requestRender();
    return this.cogLineSelected;
  },

  // `width` is a diameter in metres, `color` a hex string (null = back to the
  // dancer's own colour). Applies to the selected line, else to all three.
  setCogLineStyle({ width, color } = {}) {
    const targets = this.cogLineSelected
      ? [this.cogViz[this.cogLineSelected]]
      : Object.values(this.cogViz);
    for (const v of targets) v.setLineStyle({ width, color });
    this.ui?.onCogLineChanged?.(this.cogLineSelected);
    requestRender();
    return this.cogLineStyle();
  },

  cogLineStyle() {
    const v = this.cogViz[this.cogLineSelected] ?? vizLeader;
    return v.lineStyle();
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
  // 'twist' turns it under a still chest (see pivotHips), 'frame' turns the
  // ARM FRAME about a still chest (see turnFrame) — the three pieces a pivot is
  // assembled from, which is why they share a toolbar.
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

  // Turn the ARM FRAME about a still trunk: the two elbows orbit the
  // chest's vertical axis as ONE RIGID PAIR — same height, same distance apart,
  // the forearms and hands carried round with them — while the shoulder blades
  // (one protracting, the other retracting) and the shoulder joints pay for it.
  // It is the upper-body half of a pivot: in an embrace the frame belongs to
  // the couple, so when a dancer's trunk turns against it, THIS is the motion
  // the shoulders make. (`setElbowsFixed` is the same motion from the other
  // frame: the elbows stay in the room and the body turns under them.)
  //
  // Absolute, not incremental: the elbows are captured once in the CHEST's
  // frame and every call re-derives the pose from that base and the total yaw,
  // so a long drag cannot drift and turning back retraces the way out. The
  // base is re-captured when anything else has re-posed those arms since (the
  // signature check) — another tool, a preset, the embrace re-settling.
  //
  // Returns the yaw actually applied: when the blades and shoulders run out of
  // range the elbows can no longer reach their rigid targets, and the turn
  // backs off (bisection on the elbow residual) to the last angle that holds
  // the frame together rather than letting it deform.
  frameState: null,

  turnFrame(figure, dYaw) {
    this.markEdit(figure);
    figure.group.updateMatrixWorld(true);
    const chest = figure.nodes.chest;
    const sig = () => FRAME_JOINTS.map((n) => {
      const r = figure.nodes[n].rotation;
      return `${r.x.toFixed(6)},${r.y.toFixed(6)},${r.z.toFixed(6)}`;
    }).join('|');
    let st = this.frameState;
    if (!st || st.figure !== figure || st.sig !== sig()) {
      const inv = chest.matrixWorld.clone().invert();
      const qInv = chest.getWorldQuaternion(new THREE.Quaternion()).invert();
      st = { figure, yaw: 0, arms: {} };
      for (const side of ['L', 'R']) {
        const arm = captureArm(figure, side);
        st.arms[side] = {
          pos: arm.pos.clone().applyMatrix4(inv),     // chest-local: survives the
          quat: qInv.clone().multiply(arm.quat),      // dancer being moved mid-turn
          ref: arm.ref,
        };
      }
      this.frameState = st;
    }
    const pivot = chest.getWorldPosition(new THREE.Vector3());
    const chestQ = chest.getWorldQuaternion(new THREE.Quaternion());
    const turn = new THREE.Quaternion();
    const apply = (yaw) => {
      turn.setFromAxisAngle(_UP, yaw);
      let miss = 0;
      for (const side of ['L', 'R']) {
        const a = st.arms[side];
        const target = a.pos.clone().applyMatrix4(chest.matrixWorld)
          .sub(pivot).applyQuaternion(turn).add(pivot);
        const quat = turn.clone().multiply(chestQ).multiply(a.quat);
        miss = Math.max(miss, solveElbow(figure, side, target, quat, a.ref));
      }
      return miss;
    };
    // Tighter than the hold's strain threshold: this is the rigidity of the
    // frame itself, and 8 mm of give at the clamp reads as the elbows drifting.
    const TOL = ELBOW_TOL / 4;
    const from = st.yaw;
    let to = from + dYaw;
    if (apply(to) > TOL) {
      let lo = from;
      let hi = to;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (apply(mid) > TOL) hi = mid; else lo = mid;
      }
      to = lo;
      apply(to);
    }
    st.yaw = to;
    st.sig = sig();
    st.stamp = performance.now();
    figure.syncAtlasNodes();
    figure.group.updateMatrixWorld(true);
    // A dancer whose elbows are also FIXED has just had them moved on purpose:
    // the hold follows, or it would drag them straight back next frame.
    if (elbowHold.has(figure)) elbowHold.recapture(figure);
    return to - from;
  },

  // "Fix elbows": hold `figure`'s two elbows where they are IN THE ROOM while
  // other joints (or the whole figure) move — turn the chest, twist the hips or
  // pivot the dancer on the support foot, and the shoulders and shoulder blades
  // absorb it. `figure` is a Figure, an index, or 'leader' / 'follower'.
  setElbowsFixed(figure, on) {
    const fig = typeof figure === 'string'
      ? this.figures[figure === 'follower' ? 1 : 0]
      : (typeof figure === 'number' ? this.figures[figure] : figure);
    if (!fig) return false;
    const was = elbowHold.has(fig);
    const now = elbowHold.set(fig, !!on);
    if (was !== now) this.ui?.onElbowsFixedChanged?.();
    return now;
  },

  elbowsFixed(figure) {
    const fig = typeof figure === 'string'
      ? this.figures[figure === 'follower' ? 1 : 0]
      : (typeof figure === 'number' ? this.figures[figure] : figure);
    return elbowHold.has(fig);
  },

  // The hold's live targets, for verification: [{ figure, side, pos }].
  elbowHoldTargets() {
    const out = [];
    for (const [fig, h] of elbowHold.held) {
      for (const side of ['L', 'R']) out.push({ figure: this.figures.indexOf(fig), side, pos: h[side].pos.toArray() });
    }
    return out;
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
    // Starting to pose a dancer stops a running playback: the player rewrites
    // every joint each frame, so an edit made under it lasts exactly one
    // frame. Every pose-mutating path already comes through here, which makes
    // this the one place that covers them all — and the guard keeps it free on
    // the hot path (markEdit fires on every pointermove of a drag).
    if (this.seqPlaying || this.interpPlaying) this.stopPlayback();
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
      // The frame turn's ring sits at the CHEST, the axis the elbows orbit.
      figure.worldPos(this.hipsTool === 'frame' ? 'chest' : 'pelvis', hipsTarget.position);
      hipsTarget.rotation.set(0, 0, 0);
      hipsTarget.userData.figure = figure;
      hipsTarget.visible = true;
      this.hipsState = { figure, last: hipsTarget.position.clone(), lastYaw: 0 };
      tcontrols.attach(hipsTarget);
      if (this.hipsTool === 'twist' || this.hipsTool === 'frame') {
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
    // A preset places both dancers; a running player would overwrite it next
    // frame. (applyPreset does not go through applyCoupleState, so it needs
    // its own stop.)
    this.stopPlayback();
    this.pushHistory();
    this.deselect();
    // A preset places both dancers outright, so no one is mid-edit any more:
    // clear who yields, or the couple keeps deferring to whoever was last
    // posed before the preset (see embraceEditing).
    this.lastEditedFigure = null;
    preset.apply(leader, follower);
    recaptureElbowHold(); // a pose that arrives whole moves the hold with it
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
    // A pose applied outright and a player writing a pose every frame fight,
    // and the player wins: the keyframe's Show, the slide, the library pose or
    // the undo would flash up and be overwritten on the very next frame. The
    // gesture wins instead, and playback stops where it had got to. This is
    // the one seam Show / slides / the pose library / recall A|B / undo all
    // pass through, which is why the stop belongs here rather than in five
    // callers.
    this.stopPlayback();
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
    // A pose applied outright takes the elbow hold with it (see
    // ElbowHold.recapture) — except the COG trail's own restore, which puts
    // back the pose it started from in the middle of whatever edit caused it.
    if (!trailReplaying) recaptureElbowHold();
    // Only a slide carries a view. A pose-only state — every file saved before
    // slides existed, plus A/B snapshots, keyframes and undo entries — leaves
    // the layer, camera and labels exactly where the user has them.
    if (state.view) this.ui?.applyViewState?.(state.view);
    if (this.ui) this.ui.onPoseChanged();
  },

  // -------------------------------------------------- A→B interpolation
  setInterpStates(A, B) {
    this.interpStates = A && B ? { A, B } : null;
    this.stopInterp();
    // A position on the chain that has just been replaced means nothing, and
    // Play resumes from the scrubber — so a fresh pair starts at its start.
    this.interpT = 0;
    updateCogTrail();
  },

  // Apply the pose interpolated between snapshots A and B at t ∈ [0, 1].
  applyInterp(t) {
    if (!this.interpStates) return;
    if (this.selected || this.ikState) this.deselect();
    // The scrubber's position IS interpT — what Play resumes from, exactly as
    // applySeqT stores the sequence's. The player feeds its own t back in
    // here, so this is a no-op on that path.
    this.interpT = t;
    applyStatesT([this.interpStates.A, this.interpStates.B], t);
    recaptureElbowHold();
  },

  // Play A→B. `from` overrides the resume rule for scripts: 0 replays from the
  // start whatever the scrubber says, and any t starts there.
  playInterp(onTick, onDone = null, { from = null } = {}) {
    if (!this.interpStates) return;
    this.stopSeq(); // one player at a time
    this.interpT = from === null ? resumeT(this.interpT) : THREE.MathUtils.clamp(from, 0, 1);
    this.interpPlaying = true;
    this.interpTick = onTick || this.ui?.interpScrubTo || null; // see playSeq
    this.interpDone = onDone;
    if (this.ui) this.ui.onPlaybackChanged();
  },

  // ---- stopping a player -------------------------------------------------
  // Stop is a PAUSE, not a rewind: the dancers stay in the pose the player
  // last set and `seqT`/`interpT` keep the position it stopped at, which is
  // both what the scrubber shows and what Play carries on from. `onDone` is
  // DROPPED rather than fired — it means "the movement finished", and a
  // stopped run did not; a caller chaining something onto the end of a
  // playback must not have it run because the user pressed Stop.
  stopSeq() {
    this.seqDone = null;
    return clearPlaying({ interp: false });
  },

  stopInterp() {
    this.interpDone = null;
    return clearPlaying({ seq: false });
  },

  // Whatever is playing, stop it; returns whether anything was. Everything
  // that would FIGHT a running player frame by frame comes through here — a
  // scrub, a preset, a keyframe's Show, a slide, Escape, the first edit of a
  // dancer. Merely LOOKING (an orbit, a zoom, a layer switch) deliberately
  // does not: the player is what the viewer is watching, and moving the camera
  // to watch it better must not stop it.
  stopPlayback() {
    const a = this.stopSeq();
    const b = this.stopInterp();
    return a || b;
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
    // Ownership is derived from the chain, so every mutation of it invalidates
    // the cache. It has to BE a cache: keyframeDrawFilter runs from
    // applyKeyframeExtras, i.e. several times a second while a sequence plays.
    ownedCache = null;
    // Deleting down to one keyframe leaves nothing to travel: stop, rather
    // than leave the player running on a chain it can no longer play (and its
    // button stuck offering to stop it).
    if (this.seqStates.length < 2) this.stopSeq();
    updateCogTrail();
    if (this.ui) this.ui.onSequenceChanged();
  },

  // Where a keyframe goes when nobody says: AFTER the one being stood on, else
  // at the end. Building a movement is a walk along it — you show a keyframe,
  // pose the next step, and add it — and an Add that always appended sent that
  // step to the far end of the chain, to be dragged back by hand every time.
  // "The one being stood on" is exactly the keyframe whose extras are showing
  // (seqShownIndex), which is the same answer the scrubber, the players and
  // the row's own marker give, so there is one notion of "current" and not two.
  // Resolved HERE rather than in the caller, so the button, the script and any
  // later caller cannot disagree about it.
  seqInsertIndex() {
    const at = this.seqShownIndex();
    return at >= 0 ? at + 1 : this.seqStates.length;
  },

  // Insert the current couple pose as a keyframe — after the current one by
  // default (seqInsertIndex), or wherever an explicit index says. It is given
  // the default TRAVEL and no hold — the pair that reduces the timeline to the
  // old equal-time split, so adding keyframes behaves as it always did until
  // someone actually sets a hold.
  // It is born with NO name. The row already falls back to "Keyframe N" as a
  // placeholder and seqName(i) to the same words, so nothing reads as anonymous
  // — but a stored "Keyframe 3" is a value that goes stale on the first reorder
  // AND gets stamped over the picture as if the user had written it (see
  // screenName). Only a name someone typed is a name.
  // Returns the index it landed at.
  seqAdd(index = this.seqInsertIndex()) {
    // A timeline the user begins EMPTY is new work, and new work eases (see
    // SEQ_EASE_FRESH). Only here, only on the first keyframe, and only if
    // nobody has said otherwise: anything else would overrule a choice already
    // made, and a chain from a file or a previous session brings its own.
    if (!this.seqStates.length && !seqEaseChosen) this.seqEaseOn = SEQ_EASE_FRESH;
    const state = this.getCoupleState('');
    // Every keyframe gets one, the first included: it is INERT there (seqTiming
    // reads no travel into keyframe 0) but it travels with the row, so a
    // keyframe dragged out of first place brings its own number rather than
    // silently inheriting the default.
    // A keyframe inserted mid-chain gets the plain default like any other — it
    // deliberately does NOT split the travel time of the gap it landed in. That
    // would silently re-time a movement the user had already tuned, to make an
    // arithmetic invariant nobody asked for hold.
    state.move = SEQ_SEG_SECONDS; // seconds to travel INTO this keyframe
    const at = Math.min(Math.max(index | 0, 0), this.seqStates.length);
    this.seqStates.splice(at, 0, state);
    this.onSeqChanged();
    // The keyframe you just made is the one you are working on, so the next
    // Add goes after IT — otherwise a run of adds would all pile into the same
    // slot. It is untagged, so this also hands the caption band and the Muscles
    // panel back to the user, which is what standing on an untagged keyframe
    // means everywhere else.
    // An edit focus (✎) belongs to the keyframe that WAS being stood on; with
    // the playhead moving to the new one, drawings made from here on must not
    // go on being filed under a keyframe the user is no longer looking at.
    endSeqFocus(false);
    applyKeyframeExtras(state);
    // Appending is self-evident — the row appears where you are looking. An
    // insert in the middle of a long list may not be, so it says where it went.
    if (at < this.seqStates.length - 1) {
      this.status(at > 0
        ? `Keyframe added after keyframe ${at}.`
        : 'Keyframe added at the start of the movement.', 'info');
    }
    return at;
  },

  // Copy keyframe i and drop the copy in right after it — the "same again,
  // slightly different" gesture a sequence is mostly built from (a walk is four
  // near-identical steps). A DEEP copy through JSON, which is exactly the
  // fidelity a keyframe has (it is serialized to localStorage and to an export
  // file already): nothing — `figures`, `meta`, the `kf` block, the arrays
  // inside it — may be shared, or editing the copy's caption or its drawing
  // tag would silently rewrite the original's.
  //
  // The NAME is kept as it stands: a copy of "cross" is still the cross, and a
  // keyframe named "cross (copy)" is a label the user has to clean up rather
  // than one they wrote.
  seqDuplicate(i) {
    const src = this.seqStates[i];
    if (!src) return -1;
    const copy = JSON.parse(JSON.stringify(src));
    this.seqStates.splice(i + 1, 0, copy);
    // Duplicating the keyframe you are STANDING ON leaves you standing on the
    // copy, so ⧉ then ⟳ then ⧉ builds a chain forward. Duplicating any other
    // row deliberately does not move the playhead: the copy's extras are the
    // source's, and jumping the caption band to a row the user is not looking
    // at would be a view change nobody asked for.
    if (shownExtras === src) {
      endSeqFocus(false); // the focus was on the SOURCE; the playhead is leaving it
      applyKeyframeExtras(copy);
    }
    this.onSeqChanged();
    this.status(`Keyframe ${i + 1} duplicated — the copy is keyframe ${i + 2}.`, 'info');
    return i + 1;
  },

  // Overwrite keyframe i with the current couple pose. ⟲ re-records the POSE,
  // and everything else a keyframe carries is NOT pose: its `move`/`hold` are
  // timing, its name is the user's label, and a later feature may hang its own
  // block here. So the fresh couple state is spread OVER the old one rather than
  // replacing it — an unknown field rides through untouched by construction,
  // instead of having to be listed here and silently lost when it isn't.
  // A keyframe's pose is not couple pose state either — the undo stack holds
  // the POSE OF THE DANCERS, so Ctrl+Z after this would put the couple back and
  // leave the keyframe holding the new pose. ⟳ destroys authored work in one
  // click exactly as ✕ does, so it gets the same recovery: an Undo on the
  // status line, offered where the loss happened.
  seqUpdate(i) {
    const old = this.seqStates[i];
    if (!old) return;
    const fresh = { ...old, ...this.getCoupleState(old.name) };
    this.seqStates[i] = fresh;
    // The keyframe on screen is an OBJECT, not an index, and ⟳ replaces the
    // object — so a re-record of the keyframe being stood on would otherwise
    // orphan `shownExtras` on a state no longer in the chain, and the row's
    // marker (and pickSeqTextColor, and every `shownExtras === s` fast path)
    // would report that no keyframe is current at all.
    // The edit focus (✎) is tracked by identity for the same reason and needs
    // the same re-pointing — ⟳ on the focused keyframe is the NATURAL gesture
    // (focus it, adjust the pose, re-record), and it must not quietly end the
    // session by making the focused object vanish from the chain.
    if (seqFocusState === old) seqFocusState = fresh;
    if (shownExtras === old) applyKeyframeExtras(fresh);
    this.onSeqChanged();
    this.status(`Keyframe ${i + 1} re-recorded.`, 'info', {
      label: 'Undo',
      run: () => {
        // BY IDENTITY, never by the index the message was written with: the
        // offer lives six seconds, which is long enough to drag a row, delete
        // one, or ⟳ a second keyframe — and an index-based restore would then
        // overwrite whichever keyframe had moved into that slot. If the
        // re-recorded keyframe has since been deleted there is nothing to put
        // back, and doing nothing is the only honest answer.
        const at = this.seqStates.indexOf(fresh);
        if (at < 0) return;
        this.seqStates[at] = old;
        if (seqFocusState === fresh) seqFocusState = old;
        if (shownExtras === fresh) applyKeyframeExtras(old);
        this.onSeqChanged();
      },
    });
  },

  // The cap the row's input enforces, read from here so the field and the
  // setter can never disagree about where a label stops.
  seqNameMax: SEQ_NAME_MAX,
  seqCaptionMax: SEQ_CAPTION_MAX,
  // …and the bounds the two timing boxes enforce, for the same reason: a
  // number box whose min/max disagree with the setter's clamp silently takes a
  // value and then shows something else. A move has a floor (a zero-length
  // transition is a cut, and divides the timeline by zero); a hold does not.
  seqTravelMin: SEQ_MIN_SECONDS,
  seqHoldMin: SEQ_HOLD_SECONDS,
  seqSecondsMax: SEQ_MAX_SECONDS,

  // The keyframe's own label ("cross", "pivot out"), so a row says what it is
  // rather than only where it sits. Empty is allowed and meaningful — the row
  // then falls back to its index, which is never anonymous.
  seqSetName(i, text) {
    const s = this.seqStates[i];
    if (!s) return;
    s.name = String(text ?? '').trim().slice(0, SEQ_NAME_MAX);
    this.onSeqChanged();
    // The name is drawn over the picture too, so renaming the keyframe that is
    // showing must land at once rather than on the next scrub.
    if (shownExtras === s) applyKeyframeExtras(s);
  },

  // The label shown for keyframe i: its name, else the positional fallback.
  seqName(i) {
    const s = this.seqStates[i];
    return (s && typeof s.name === 'string' && s.name.trim()) || `Keyframe ${i + 1}`;
  },

  // The name the PICTURE would draw for keyframe i — '' for one that was never
  // named, and for a legacy auto-name (see screenName). The sidebar asks so its
  // show/hide and colour controls can be inert where there is nothing to style.
  seqNameForScreen(i) {
    return screenName(this.seqStates[i]);
  },

  // ---- the two numbers a keyframe's timing is made of -----------------------
  // Both are named for what the user sets: how long it takes to GET INTO this
  // pose, and how long to STAY in it. The stored fields are `move` and `hold`;
  // the API says `travel` for the first of them only because `seqMove(i, di)`
  // is already the REORDER, and a timing setter that reads like a reorder is a
  // trap for the next caller.
  //
  // Seconds of transition from the previous keyframe INTO keyframe i. Keyframe
  // 0 has none — nothing precedes it to travel from — so it is refused there
  // rather than stored and ignored.
  seqSetTravel(i, secs) {
    if (!this.seqStates[i] || i === 0) return;
    const d = Number(secs);
    if (!Number.isFinite(d) || d <= 0) return;
    this.seqStates[i].move = Math.min(Math.max(d, SEQ_MIN_SECONDS), SEQ_MAX_SECONDS);
    this.onSeqChanged();
  },

  seqTravel(i) {
    if (i === 0) return 0; // the chain starts here; there is no travel into it
    const d = Number(this.seqStates[i]?.move);
    if (Number.isFinite(d) && d > 0) return d;
    // A chain that has not been through setSeqStates may still carry the
    // legacy field on the keyframe BEFORE this one; seqTiming reads it the
    // same way, so the row and the playback cannot disagree.
    const legacy = Number(this.seqStates[i - 1]?.dur);
    return Number.isFinite(legacy) && legacy > 0 ? legacy : SEQ_SEG_SECONDS;
  },

  // Seconds the couple STAYS in keyframe i's pose once it is reached. Every
  // keyframe has one, the last included — that final hold is how a recording
  // lingers on the end pose instead of cutting the instant it arrives. Zero is
  // a legitimate value (and the default), so unlike a move it is not refused.
  seqSetHold(i, secs) {
    if (!this.seqStates[i]) return;
    const d = Number(secs);
    if (!Number.isFinite(d) || d < 0) return;
    const clamped = Math.min(d, SEQ_MAX_SECONDS);
    // An absent `hold` and a zero one must serialize identically, or every
    // sequence saved before this grows a field that changes nothing.
    if (clamped > 0) this.seqStates[i].hold = clamped;
    else delete this.seqStates[i].hold;
    this.onSeqChanged();
  },

  seqHold(i) {
    const d = Number(this.seqStates[i]?.hold);
    // Raw, like seqTiming: the row must show the number that will actually
    // play, bounds or no bounds.
    return Number.isFinite(d) && d > 0 ? d : SEQ_HOLD_SECONDS;
  },

  // Compatibility shims for the one-number era, kept because scripts drive
  // them: a "duration" was the time to reach the NEXT keyframe, which is that
  // keyframe's own travel. The last keyframe had no next, and still has none.
  seqSetDuration(i, secs) { this.seqSetTravel(i + 1, secs); },
  seqDuration(i) {
    return i + 1 < this.seqStates.length ? this.seqTravel(i + 1) : SEQ_SEG_SECONDS;
  },

  // ---- eased transitions ---------------------------------------------------
  // ONE setting for the WHOLE sequence, like the two text placements and for
  // the same reason: a figure whose transitions changed character from keyframe
  // to keyframe would be unwatchable, and which keyframes are eased is already
  // answered by the holds the author set (see easeU's rest rule). So there is
  // no per-keyframe curve to pick.
  seqEase() { return this.seqEaseOn === true; },

  setSeqEase(on) {
    const next = !!on;
    // Marked BEFORE the early-out: asking for the value it already holds is
    // still an answer, and the fresh default must not undo it on the next add.
    seqEaseChosen = true;
    if (next === this.seqEaseOn) return next;
    this.seqEaseOn = next;
    // Not onSeqChanged: no keyframe changed, and that hook rebuilds the COG
    // trail — ~289 replays of the whole chain for a checkbox that provably
    // cannot move the trail by a single vertex (easing is a remap of time, and
    // the trail is sampled by pose parameter).
    this.ui?.onSeqEaseChanged?.();
    // Re-pose at once where the answer has actually changed: strictly inside
    // the movement, stopped, with a chain to play. At either end (and while a
    // player or a capture owns the timeline) this would only re-assert a pose
    // the toggle cannot alter — and at t = 0 that means stamping keyframe 1
    // over whatever the user has since posed by hand.
    if (this.seqStates.length >= 2 && !this.seqPlaying && !this.recording
      && this.seqT > RESUME_EPS && this.seqT < 1 - RESUME_EPS) {
      applyStatesT(this.seqStates, this.seqT, { ease: next });
    }
    requestRender();
    return next;
  },

  // Running time of the whole timeline, in seconds (what Play and ⏺ take):
  // every move PLUS every hold, the last keyframe's included.
  seqSeconds() {
    return this.seqStates.length >= 2 ? statesSeconds(this.seqStates) : 0;
  },

  // A keyframe is not pose state, so the undo stack (couple poses only) cannot
  // bring it back — Ctrl+Z after this would restore the POSE and leave the
  // keyframe gone. The recovery is therefore offered where the loss happened,
  // as a clickable Undo on the status line.
  seqDelete(i) {
    const [removed] = this.seqStates.splice(i, 1);
    if (removed === seqFocusState) endSeqFocus(true);
    // Drawings this keyframe OWNED go with it: owned means "belongs to that
    // keyframe", so left behind they would be visible on no keyframe at all —
    // present in the file, present on the floor off the timeline, and invisible
    // everywhere the lesson actually plays. Only ORPHANS go: an id another
    // keyframe still lists (a duplicate shares them) has a home, and a drawing
    // is dropped only when its LAST owner does.
    this.onSeqChanged(); // invalidates the cache, so the union below is the survivors'
    const orphans = (removed?.kf?.own ?? []).filter((id) => !ownedDrawIds().has(id));
    // …with the facing arrows standing on them, which leave the floor with
    // their line (Drawings.remove cascades) and so must come back with it.
    const going = drawings.withDependents(orphans);
    const records = drawings.list()
      .filter((a) => going.includes(a.id))
      .map((a) => JSON.parse(JSON.stringify(a)));
    if (records.length) {
      for (const o of [...drawings.group.children]) {
        if (orphans.includes(o.userData.annotation?.id)) drawings.remove(o);
      }
      this.ui?.onDrawSelectionChanged?.(drawings.selected);
      this.ui?.onDrawingsChanged?.();
      requestRender();
    }
    if (!removed) return;
    const what = records.length
      ? `Keyframe ${i + 1} and its ${records.length} drawing${records.length === 1 ? '' : 's'} deleted.`
      : `Keyframe ${i + 1} deleted.`;
    this.status(what, 'info', {
      label: 'Undo',
      run: () => {
        // BOTH halves, in one press — the records are held in this closure
        // because nothing else can bring them back (annotations sit outside the
        // pose undo stack, and the keyframe is not pose state either).
        if (records.length) {
          drawings.restore(records);
          this.ui?.onDrawingsChanged?.();
        }
        this.seqStates.splice(Math.min(i, this.seqStates.length), 0, removed);
        this.onSeqChanged();
        requestRender();
      },
    });
  },

  // Lift keyframe `from` out of the chain and drop it back in at `to` — the
  // whole reorder, however far the row travelled. It is a LIFT-AND-DROP and
  // deliberately not a run of swaps: swapping row 1 up to position 5 would
  // carry each row it passed one step backwards with it, so a four-step drag
  // would rewrite five rows instead of one. `to` is clamped rather than
  // rejected, because a drag that overshoots the ends means "first"/"last".
  seqMoveTo(from, to) {
    const n = this.seqStates.length;
    if (!this.seqStates[from]) return;
    const dest = Math.min(Math.max(to | 0, 0), n - 1);
    if (dest === from) return;
    const [moved] = this.seqStates.splice(from, 1);
    this.seqStates.splice(dest, 0, moved);
    this.onSeqChanged();
  },

  // Move keyframe i by di places (di = ±1). For a neighbour this is the same
  // as a swap, which is all any caller ever asks for.
  seqMove(i, di) {
    this.seqMoveTo(i, i + di);
  },

  // Which floor drawings keyframe i shows, by id — or null for all of them,
  // which is what an untagged keyframe means and what every keyframe authored
  // before this carries. Stored in the keyframe's `kf` block, beside whatever
  // else hangs there.
  seqDrawIds(i) {
    const ids = this.seqStates[i]?.kf?.draw;
    return Array.isArray(ids) ? [...ids] : null;
  },

  // Tag keyframe i with a subset of the diagram (or null to clear back to all).
  // The `kf` block is MERGED, never rebuilt — see setKfField.
  seqSetDrawIds(i, ids) {
    const s = this.seqStates[i];
    if (!s) return null;
    setKfField(s, 'draw', Array.isArray(ids) ? [...ids] : null);
    this.onSeqChanged();
    if (shownExtras === s) applyKeyframeExtras(s);
    return this.seqDrawIds(i);
  },

  // What a row's ◻ Drawings tag stores: the ids ON SCREEN minus the ones this
  // keyframe already OWNS. An owned drawing is carried by `kf.own` and shows
  // here by the union rule, so capturing it into `kf.draw` as well would leave
  // a ghost entry behind the day it is released — the keyframe would go on
  // showing a drawing it no longer owns and nobody could see why.
  seqCaptureDrawIds(i) {
    const own = new Set(this.seqOwnIds(i) ?? []);
    return this.seqSetDrawIds(i, this.drawShownIds.filter((id) => !own.has(id)));
  },

  // ---- drawings a keyframe OWNS (kf.own) -----------------------------------
  // Authored while that keyframe was focused, or claimed for it by hand. Union
  // semantics: an id may sit in several keyframes' `own` (a duplicated keyframe
  // shares its original's), and the drawing then shows on every one of them.
  seqOwnIds(i) {
    const ids = this.seqStates[i]?.kf?.own;
    return Array.isArray(ids) ? [...ids] : null;
  },

  seqSetOwnIds(i, ids) {
    const s = this.seqStates[i];
    if (!s) return null;
    const list = Array.isArray(ids) ? [...new Set(ids)] : null;
    // An empty list is the same thing as none — and must serialize the same
    // way, or releasing the last claim leaves a `kf` block behind on a keyframe
    // that carries nothing.
    setKfField(s, 'own', list && list.length ? list : null);
    this.onSeqChanged();
    if (shownExtras === s) applyKeyframeExtras(s);
    return this.seqOwnIds(i);
  },

  // Claim or release ONE drawing for keyframe i. `d` is an Object3D from the
  // draw group or a bare id, so the toolbar (which holds the selection) and a
  // script (which holds an id) reach the same rule.
  seqOwnDrawing(i, d, on = true) {
    const id = typeof d === 'string' ? d : d?.userData?.annotation?.id;
    if (!id || !this.seqStates[i]) return null;
    const next = new Set(this.seqOwnIds(i) ?? []);
    if (on) next.add(id); else next.delete(id);
    return this.seqSetOwnIds(i, [...next]);
  },

  // Does keyframe i own this drawing? (The toolbar's toggle reads it.)
  seqOwnsDrawing(i, d) {
    const id = typeof d === 'string' ? d : d?.userData?.annotation?.id;
    return !!id && (this.seqOwnIds(i) ?? []).includes(id);
  },

  // Drop ids naming drawings that no longer exist from every keyframe's `own`.
  // Cheap, and it is what keeps the reduction guard honest — see setDrawings.
  pruneOwnedDrawIds() {
    const live = new Set(drawings.ids());
    let changed = false;
    for (const s of this.seqStates) {
      const own = s?.kf?.own;
      if (!Array.isArray(own)) continue;
      const kept = own.filter((id) => live.has(id));
      if (kept.length === own.length) continue;
      setKfField(s, 'own', kept.length ? kept : null);
      changed = true;
    }
    if (changed) this.onSeqChanged();
    return changed;
  },

  // ---- the edit focus (✎ on a keyframe row) --------------------------------
  // Show keyframe i and scope the two authoring surfaces to it: a drawing made
  // from now on belongs to i alone, and a Muscles-panel edit writes i's own
  // highlighting instead of the running look. `null` (or ✎ again) finishes.
  //
  // Showing a keyframe is not a pose EDIT — nothing here calls markEdit, so it
  // cannot flip who yields to the embrace — but it DOES move the couple, so it
  // takes a history snapshot exactly as Show does.
  seqFocus(i) {
    if (i === null || i === undefined) {
      if (!endSeqFocus(true)) return -1;
      this.status('Finished editing that keyframe on its own.', 'info');
      return -1;
    }
    const s = this.seqStates[i];
    if (!s) return seqFocusIndex();
    if (s === seqFocusState) return i; // ✎ on the focused row is the way out
    // Moving the focus, not ending the session: the keyframe about to be shown
    // applies its own extras, so there is nothing to hand back in between.
    endSeqFocus(false);
    seqFocusState = s;
    this.pushHistory();
    this.applyCoupleState(s);
    applyKeyframeExtras(s);
    this.ui?.onSeqFocusChanged?.();
    this.status(
      `Editing keyframe ${i + 1} only — drawings and muscle highlights you add now belong to it. ✎ or Esc to finish.`,
      'info');
    return i;
  },

  // The keyframe an authoring gesture should be filed under, or -1. The
  // Muscles panel asks before every edit; claimForFocus asks per drawing.
  seqFocusIndex() { return seqFocusIndex(); },

  // A drawing has just been committed: if a keyframe is focused it owns it.
  // Re-applying the extras afterwards is what puts the new id through the
  // filter — #commit stamps the CURRENT filter on a new child, so a drawing
  // authored into a tagged keyframe would otherwise be born hidden.
  claimForFocus(o) {
    const i = seqFocusIndex();
    if (i < 0 || !o?.userData?.annotation?.id) return o;
    this.seqOwnDrawing(i, o, true);
    applyKeyframeExtras(this.seqStates[i]);
    return o;
  },

  // ---- per-keyframe caption ------------------------------------------------
  // The words shown over the picture while this keyframe is the current one
  // ("here the leader's left obliques fire"). Empty/absent = no caption, so a
  // keyframe authored before this existed shows none.
  seqCaption(i) {
    const c = this.seqStates[i]?.kf?.caption;
    return typeof c === 'string' ? c : '';
  },

  seqSetCaption(i, text) {
    const s = this.seqStates[i];
    if (!s) return '';
    const clean = String(text ?? '').trim().slice(0, SEQ_CAPTION_MAX);
    setKfField(s, 'caption', clean || null);
    this.onSeqChanged();
    // If that keyframe is the one showing, the band updates as it is typed
    // rather than on the next scrub; otherwise this is a no-op re-apply.
    if (shownExtras === s) applyKeyframeExtras(s);
    return this.seqCaption(i);
  },

  // The caption band, driven by hand (a script, or a future live caption
  // field). The timeline overwrites it from the keyframe it is travelling from.
  setCaption(text) {
    studio.setCaption(text);
    requestRender();
    return studio.caption;
  },
  caption() { return studio.caption; },
  // What the name block is showing, for the same reasons.
  seqNameShown() { return studio.seqName; },

  // ---- the two on-screen texts: where they sit, and how each keyframe inks
  // them --------------------------------------------------------------------
  // PLACEMENT is one setting for the WHOLE sequence and COLOUR/HIDING is per
  // keyframe, and the split is not an accident: a caption that jumped to a
  // different corner at every keyframe would make a recorded lesson unwatchable,
  // while the ink is part of what a particular keyframe is saying. So the two
  // placements live beside the sequence (persisted by ui.js, and carried in the
  // export file) and the rest lives in each keyframe's own `kf` block.
  SEQ_TEXTS: ['name', 'caption'],

  seqTextPos(which) {
    const p = studio.blockPos(which === 'caption' ? 'caption' : 'name');
    return p ? { x: p.x, y: p.y } : null;
  },

  // `null` hands that text back to its default spot (top-left / the foot of the
  // frame). Not an edit: overlay chrome is outside the pose undo stack, exactly
  // as drawings and labels are.
  setSeqTextPos(which, pos) {
    const key = which === 'caption' ? 'caption' : 'name';
    studio.setBlockPos(key, pos ?? null);
    this.onSeqTextMoved();
    return this.seqTextPos(key);
  },

  // Both placements at once — what the session store and the export file carry.
  seqTextPositions() {
    return { name: this.seqTextPos('name'), caption: this.seqTextPos('caption') };
  },
  setSeqTextPositions(pos) {
    for (const which of this.SEQ_TEXTS) studio.setBlockPos(which, pos?.[which] ?? null);
    this.onSeqTextMoved();
  },

  // One hook for every path that moves a text, so ui.js has a single place to
  // persist from — the arrangement drawings and the Muscles panel already use.
  onSeqTextMoved() {
    requestRender();
    this.ui?.onSeqTextChanged?.();
  },

  // How keyframe i inks its name / caption: `{ color, hidden }`, with a null
  // colour meaning the backdrop's own ink. Absent keys throughout, so a
  // keyframe nobody has styled serializes exactly as it did before this existed.
  seqTextStyle(i, which) {
    const kf = this.seqStates[i]?.kf;
    const key = which === 'caption' ? 'caption' : 'name';
    return {
      color: typeof kf?.[`${key}Color`] === 'string' ? kf[`${key}Color`] : null,
      hidden: kf?.[`${key}Hidden`] === true,
    };
  },

  // Each field goes through setKfField on its own, so they merge and delete
  // independently: clearing a colour must not take the hide with it, and
  // clearing both must leave no `kf` block behind at all.
  seqSetTextStyle(i, which, { color, hidden } = {}) {
    const s = this.seqStates[i];
    if (!s) return null;
    const key = which === 'caption' ? 'caption' : 'name';
    if (color !== undefined) setKfField(s, `${key}Color`, color || null);
    if (hidden !== undefined) setKfField(s, `${key}Hidden`, hidden ? true : null);
    this.onSeqChanged();
    if (shownExtras === s) applyKeyframeExtras(s);
    return this.seqTextStyle(i, key);
  },

  // Which keyframe the on-screen text belongs to right now — the one the
  // timeline is travelling FROM, which is the one applyKeyframeExtras last
  // applied. -1 when the texts were set by hand rather than by a keyframe, in
  // which case there is nothing for a colour to be stored on.
  seqShownIndex() {
    return shownExtras ? this.seqStates.indexOf(shownExtras) : -1;
  },

  // The second tap on a block in the 3D view. It colours THAT keyframe's text,
  // so it needs a keyframe to be showing; saying so is better than a picker
  // whose colour lands nowhere.
  pickSeqTextColor(which, x = null, y = null) {
    const i = this.seqShownIndex();
    if (i < 0) {
      this.status('That text belongs to no keyframe yet — add one to give it a colour.', 'info');
      return;
    }
    this.ui?.pickSeqTextColor?.(i, which, x, y);
  },

  // ---- per-keyframe muscle highlighting ------------------------------------
  // `{ lit: [label], colors: [[label, hex]] }`, in the same label keys the
  // Muscles panel and Figure.setMuscleColor use (`label`, `label|L`, `label|R`)
  // — or null, meaning this keyframe shows whatever the panel has running.
  seqMuscles(i) {
    const m = this.seqStates[i]?.kf?.muscles;
    if (!m) return null;
    return { lit: [...(m.lit ?? [])], colors: (m.colors ?? []).map((p) => [...p]) };
  },

  seqSetMuscles(i, muscles) {
    const s = this.seqStates[i];
    if (!s) return null;
    setKfField(s, 'muscles', muscles
      ? { lit: [...(muscles.lit ?? [])], colors: (muscles.colors ?? []).map((p) => [...p]) }
      : null);
    this.onSeqChanged();
    if (shownExtras === s) applyKeyframeExtras(s);
    return this.seqMuscles(i);
  },

  // Tag keyframe i with the highlighting that is ON SCREEN right now — the
  // same "capture what you have arranged" gesture the drawings tag uses, and
  // for the same reason: the teacher has just lit the bellies they mean, and a
  // checklist of 68 atlas names identifies nothing.
  seqCaptureMuscles(i) {
    const look = this.ui?.muscleLookNow?.();
    if (!look) return null;
    return this.seqSetMuscles(i, look);
  },

  // Hand the view back to the user: no caption, and the Muscles panel's own
  // running look. The timeline's overrides last until the timeline says
  // otherwise, so this is the way OFF it — Clear calls it, and so does the
  // panel when the user takes the look back by hand.
  clearKeyframeExtras() {
    endSeqFocus(false); // there is no keyframe left to be editing
    applyKeyframeExtras(null);
  },

  // Where keyframe i sits on the scrubber (0..1) — the instant the movement
  // ARRIVES at it. Exposed for scripts, and for the panel, which has no other
  // way to ask.
  seqKeyframeT(i) {
    return this.seqStates.length >= 2 ? keyframeT(this.seqStates, i) : 0;
  },

  // Jump the couple to keyframe i.
  seqApply(i) {
    if (!this.seqStates[i]) return;
    // Show on ANOTHER row ends the focus — the user has moved on to a different
    // keyframe, and edits must not go on being filed under the old one. Show on
    // the focused row is just Show, and keeps it.
    if (seqFocusState && this.seqStates[i] !== seqFocusState) endSeqFocus(false);
    this.pushHistory();
    this.applyCoupleState(this.seqStates[i]);
    // …and MOVE THE SCRUBBER THERE. Show used to jump the pose and leave the
    // slider wherever it happened to be, so the two disagreed about where in
    // the movement the couple was — and because Play resumes from the
    // scrubber's own position (stop is a pause), pressing Play after a Show
    // jumped straight back to the stale spot. The position is the start of
    // keyframe i's hold: first keyframe → 0, and a last keyframe with no hold
    // → 1, which resumeT reads as "from the top", which is right (there is
    // nothing left of the movement to play from there).
    if (this.seqStates.length >= 2) {
      this.seqT = keyframeT(this.seqStates, i);
      this.ui?.seqScrubTo?.(this.seqT);
    }
    // Show is the timeline's other seam onto a keyframe — the scrubber and the
    // players go through applyStatesT, this one does not. LAST, so the extras
    // on screen are keyframe i's outright rather than whatever seqTimeMap
    // would have made of the t just stored (which is the same keyframe — see
    // U_ARRIVED — but this does not have to depend on that).
    applyKeyframeExtras(this.seqStates[i]);
  },

  // Bulk replace (import / session restore). The ONE entry point a chain from
  // outside this session arrives through, which is why the legacy `dur` → `move`
  // migration lives here (see normalizeSeqTiming).
  setSeqStates(states) {
    // The chain the focus pointed into is gone, whatever arrived in its place.
    endSeqFocus(true);
    this.seqStates = normalizeSeqTiming(Array.isArray(states) ? states : []);
    this.seqT = 0; // a position on the chain being replaced means nothing here
    // Clearing the timeline puts the ease setting back to the fresh default:
    // there is no sequence left for it to be a setting OF, and the next
    // keyframe added starts a new one. A non-empty replacement (an import, the
    // session restore, a library recall) brings its own answer, so it is left
    // to the caller — sniffing one out of the keyframes would guess.
    if (!this.seqStates.length) {
      this.seqEaseOn = SEQ_EASE_FRESH;
      seqEaseChosen = false; // the choice belonged to the sequence just wiped
    }
    this.onSeqChanged();
  },

  // Pose the couple at t ∈ [0, 1] across the whole sequence (the scrubber).
  applySeqT(t) {
    if (this.seqStates.length < 2) return;
    // Grabbing the scrubber is leaving the keyframe: the playhead is about to
    // cross every other one, and applyStatesT will apply their extras.
    endSeqFocus(false);
    if (this.selected || this.ikState) this.deselect();
    this.seqT = t;
    applyStatesT(this.seqStates, t, { ease: this.seqEase() });
    recaptureElbowHold();
  },

  // Play the sequence, carrying on from wherever the scrubber sits (see
  // resumeT). `from` overrides that for scripts: 0 replays the whole chain
  // whatever the scrubber says, and any t starts there.
  playSeq(onTick, onDone = null, { from = null } = {}) {
    if (this.seqStates.length < 2) return;
    endSeqFocus(false); // the whole chain is about to speak, not one keyframe
    this.stopInterp(); // one player at a time
    this.seqT = from === null ? resumeT(this.seqT) : THREE.MathUtils.clamp(from, 0, 1);
    this.seqPlaying = true;
    // No tick given (Space, a script) still moves the scrubber: the panel's
    // own label setter is the fallback, so the slider can never sit lying
    // about where the movement has got to.
    this.seqTick = onTick || this.ui?.seqScrubTo || null;
    this.seqDone = onDone;
    if (this.ui) this.ui.onPlaybackChanged();
  },

  // -------------------------------------------------- animation export
  // Play a keyframe chain while recording the 3D canvas, then download the
  // capture as a .webm — class material from the same view the teacher posed.
  // `states` is any couple-state chain ([A, B] or the sequence). `ease` is
  // resolved by the CALLER, exactly as it is for applyStatesT: the Sequence
  // panel's ⏺ passes app.seqEase() so a recording plays the way the scrubber
  // does, and the A→B ⏺ passes nothing. Returns false if a capture is already
  // running or the chain can't play.
  recordPlayback(states, name = 'tangle-movement', { ease = false } = {}) {
    if (this.recording || studio.recorder || !states || states.length < 2) return false;
    endSeqFocus(false); // a capture plays the whole chain; editing one keyframe is over
    this.deselect(); // also hides every gizmo/handle
    this.stopPlayback(); // the capture owns the player for its whole length
    if (!this.canRecord) {
      this.status('This browser has no video recorder (MediaRecorder) — use 📷 Save photo instead.', 'error');
      return false;
    }
    // A VIDEO IS A SLIDE THAT MOVES, so it is recorded in Present mode. The
    // joint pick spheres — translucent blobs ringing every joint in the
    // skeleton and muscle views — are the visible symptom, but they are only
    // one item on the list Present already takes off a slide: the gizmos, a
    // half-drawn annotation, a drawing's endpoint handles, a pending pin
    // marker and the Label-mode cursor preview all go with them, and the frame
    // is forced to the 16:9 1920×1080 shape an export is composed in.
    //
    // TWO ORDERING CONSTRAINTS, both of which put this HERE rather than inside
    // the whenEncoderReady() continuation below:
    //  * enterPresent asks for fullscreen, which a browser grants only from a
    //    user gesture — after the await we are no longer in the click's task.
    //  * entering resizes the render target (layoutCanvas runs synchronously
    //    inside enterPresent, via the resize event it dispatches), and
    //    studio.startRecorder sizes its composite canvas from gl.width ONCE,
    //    when it starts. Enter first and every captured frame is 1920×1080;
    //    enter afterwards and the file opens at the old size.
    // `recPresent` is set only on the FIRST pass, so the WebM retry — which
    // re-enters this function — stays inside the Present mode it is already in.
    if (!this.recPresent) {
      this.recPresent = { wasPresenting: this.presenting };
      if (!this.presenting) this.enterPresent();
    }
    applyStatesT(states, 0, { ease }); // first frames show the start pose, not the editor state
    // The shared recorder captures GL + the label overlay, as MP4 by default
    // (studio.videoFormat) — PowerPoint will not play a .webm. The job is held
    // on its first frame (rec: null) until the H.264 encoder is awake; see
    // warmUpMp4 in studio.js for why an unwarmed recording is an empty file.
    // `arming` is that wait made visible: the H.264 encoder can take ~5.5 s to
    // wake on the first recording of a page, and the button used to read
    // "⏺ Recording…" throughout while capturing nothing. The clip recorder
    // already showed "⏺ Preparing…" here; this mirrors it.
    const job = { states, t: 0, secs: statesSeconds(states), ease, rec: null, arming: true };
    this.recording = job;
    if (this.ui) this.ui.onRecordingChanged();
    studio.whenEncoderReady().then(() => {
      // Superseded (only stopRecording clears a job that is still arming), and
      // it has already handed Present mode back.
      if (this.recording !== job) return;
      job.arming = false;
      if (this.ui) this.ui.onRecordingChanged();
      job.rec = studio.startRecorder(name, ({ retry }) => {
        this.recording = null;
        if (this.ui) this.ui.onRecordingChanged();
        // MP4 unavailable here → WebM. The retry keeps the Present mode this
        // capture is already holding; only a retry that refuses to start (a
        // guard tripped, no recorder) has to give it back itself.
        if (retry) {
          // The WebM retry re-enters with the SAME options — a fallback that
          // quietly played linear would hand the user a different movement.
          if (!this.recordPlayback(states, name, { ease })) this.finishRecPresent();
        } else this.finishRecPresent();
      });
      if (!job.rec) {
        this.recording = null;
        if (this.ui) this.ui.onRecordingChanged();
        this.finishRecPresent();
      }
    });
    return true;
  },

  // End a capture early and KEEP the take. Present mode hides the ⏺ button, so
  // Esc (the capture-phase handler at the foot of this file) is the only stop
  // within reach while a slide is on screen — and a stop that silently threw
  // away a two-minute take would be the worst possible answer to that gesture.
  // Returns whether there was anything to stop.
  stopRecording() {
    const job = this.recording;
    if (!job) return false;
    if (job.rec) {
      // MediaRecorder.stop() flushes what it already holds: startRecorder's
      // onstop builds the blob and downloads it exactly as a run to t = 1
      // does, and its onDone then hands Present mode back (finishRecPresent).
      job.stopping = true; // the player's own stop at t ≥ 1 must not fire too
      job.rec.stop();
      this.status('Recording stopped — saving what was captured.', 'info');
      return true;
    }
    // Still ARMING: the H.264 encoder has not woken (~5.5 s on a page's first
    // recording), so not one frame exists yet. Cancel cleanly — downloading a
    // zero-byte file is the failure warmUpMp4 exists to prevent.
    this.recording = null;
    if (this.ui) this.ui.onRecordingChanged();
    this.finishRecPresent();
    this.status('Recording cancelled — the video encoder had not started yet.', 'info');
    return true;
  },

  // Give back exactly the Present state the capture found: entered for the
  // recording → leave; already presenting → stay put, because the user is
  // mid-lesson and the video was something they did inside it.
  finishRecPresent() {
    const held = this.recPresent;
    this.recPresent = null;
    if (held && !held.wasPresenting) this.exitPresent(); // no-ops if already out
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
  // The drawings themselves stay in shot (they ARE the teaching diagram); their
  // endpoint handles are editing chrome and go with the gizmos.
  for (const o of [tcontrols, turnControls, ikTarget, swivelTarget, caressTarget, hipsTarget,
    handleStrain, pins.group, elbowHold.group, pinPendingMarker, drawings.handleGroup, drawings.previewGroup,
    ...leader.pickSpheres, ...follower.pickSpheres]) {
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
    if (app.hipsTool === 'frame') {
      // Frame turn: the ring's delta orbits the elbows about the chest. Wound
      // back to what was applied, like the hips twist, so the ring cannot run
      // away from a frame that has stopped.
      const want = hipsTarget.rotation.y - app.hipsState.lastYaw;
      const applied = app.turnFrame(figure, want);
      reportFrameTurn(figure, want, applied);
      app.hipsState.lastYaw += applied;
      hipsTarget.rotation.y = app.hipsState.lastYaw;
    } else if (app.hipsTool === 'twist') {
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

// An overlay TEXT BLOCK — the clip's title, a keyframe's name, its caption —
// is 2D chrome, so it has no place in the scene's picking: studio.js says where
// each one drew, and these handlers drag whichever is under the cursor. The
// grab is armed by HOVER (the pointermove below turns orbiting off while the
// cursor is over a block) rather than at pointerdown — OrbitControls listens on
// this same canvas and would already have started a camera rotate by the time a
// pointerdown handler of ours ran.
let blockDrag = false;
let blockHover = null; // 'title' | 'name' | 'caption' | null
// The same arrangement for a callout pill: hovering one hands it the cursor, a
// drag moves it to the column the cursor ends in, and a double-click opens its
// colour picker.
let labelDrag = false;
let labelHover = false;
// A floor drawing's endpoint handle, armed by hover for the same reason the
// title and the callout pills are: OrbitControls listens on this canvas too and
// would already have started a camera rotate by the time our pointerdown ran.
let drawHandleHover = null;
let drawHandleDrag = null;
const DOUBLE_TAP_MS = 400;
let labelTap = { id: null, t: 0 };
// The same counted second tap for an overlay text block, whose gesture the
// block's own drag already owns (see the note in the pointerup handler).
let blockTap = { key: null, t: 0 };
const canvasPoint = (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};

// Click-vs-drag detection so orbiting doesn't change the selection.
let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  if (drawHandleHover) drawHandleDrag = { ...drawHandleHover };
  else if (blockHover && studio.beginBlockDrag(...canvasPoint(e))) blockDrag = true;
  else if (labelHover && studio.beginLabelDrag(...canvasPoint(e))) labelDrag = true;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (drawHandleDrag) {
    drawHandleDrag = null;
    downPos = null;
    return; // the handle took this gesture; it must not also author a shape
  }
  if (blockDrag) {
    blockDrag = false;
    downPos = null;
    const movedKey = studio.endBlockDrag();
    if (movedKey) {
      if (movedKey !== 'title') app.onSeqTextMoved();
      blockTap = { key: null, t: 0 };
      return; // the block took this gesture; nothing in the scene should see it
    }
    // A press that never travelled is a TAP on the block. A SECOND one in quick
    // succession opens the colour picker for the keyframe's text — counted here
    // rather than off the native `dblclick`, for the reason the callout pill's
    // tap records: the block's own drag already owns pointerdown/up over it, and
    // an automated browser never fires dblclick on this canvas at all.
    const key = studio.blockHit(...canvasPoint(e));
    const now = performance.now();
    if (key && key !== 'title' && blockTap.key === key && now - blockTap.t < DOUBLE_TAP_MS) {
      blockTap = { key: null, t: 0 };
      app.pickSeqTextColor(key, e.clientX, e.clientY);
    } else blockTap = { key: key ?? null, t: now };
    return; // a click ON a block must not fall through to a joint behind it
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
  return (figure.picksVisible !== false && figure.layers && figure.layers.skeleton) ? 0.22 : 0;
}

function styleSphere(sphere, figure, { ghost = false, lit = false } = {}) {
  const { jointName } = sphere.userData;
  // Presenting: the spheres are off the slide entirely, so no hover, selection
  // or strain state may draw one back in. Checked here rather than at each
  // call site, since every restyle path in the app funnels through this.
  if (figure.picksVisible === false) {
    sphere.material.emissive.set(0x000000);
    sphere.material.opacity = 0;
    sphere.material.depthTest = true;
    sphere.renderOrder = 0;
    return;
  }
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
  if (blockHover && !blockDrag) { blockHover = null; orbit.enabled = true; }
  if (labelHover && !labelDrag) { labelHover = false; orbit.enabled = true; }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  // Before the click-vs-drag guard below: a handle drag IS a drag, and the
  // moves that carry it all arrive with downPos set.
  if (drawHandleDrag) {
    pointerRay(e);
    // An end dropped on a joint attaches there; anywhere else it lands on the
    // floor, which is also how an anchored end is detached again.
    const type = drawHandleDrag.obj?.userData.annotation?.type;
    const anchor = ANCHOR_TOOLS.has(type) ? jointAnchorAtPointer() : null;
    // The plane the handle travels in: the floor, except for a facing arrow's
    // tip, which lives at its line's height (Drawings.handlePlaneY).
    const p = anchor ? null : planePointAtPointer(drawings.handlePlaneY(drawHandleDrag.obj));
    if (anchor || p) {
      // moveHandle rebuilds the shape from its annotation, so the object (and
      // its handles) are replaced each move — track the replacement or the
      // rest of the drag edits a disposed drawing.
      drawHandleDrag.obj = app.moveDrawHandle(drawHandleDrag.obj, drawHandleDrag.index, p, anchor);
    }
    return;
  }
  if (blockDrag) {
    studio.dragBlockTo(...canvasPoint(e));
    requestRender(); // overlay-only change; the solve loop may be idling
    return;
  }
  if (labelDrag) {
    if (studio.dragLabelTo(...canvasPoint(e))) requestRender();
    return;
  }
  if (downPos || gizmoDragging()) return; // don't fight a click, gizmo drag, or orbit
  // Over an overlay text block (the clip title, a keyframe's name or caption)
  // the cursor belongs to that block: nothing in the scene is pickable through
  // it, and orbiting is held off so a drag moves the block instead of the
  // camera. A block that drew nothing recorded no box, so a hidden caption or
  // an unnamed keyframe is inert here without a flag of its own.
  const overBlock = studio.blockHit(...canvasPoint(e));
  blockHover = overBlock;
  // Assigned every move, not toggled on the edge: a gizmo drag that ends under
  // the block re-enables orbiting behind our back, and a stale edge would then
  // leave the block dragging the camera with it.
  orbit.enabled = !overBlock;
  if (overBlock) {
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
    // An endpoint handle of the selected drawing takes the cursor: orbiting is
    // held off so a press-and-drag moves the end instead of the camera. Like
    // the title's, it is ASSIGNED every move rather than toggled on the edge,
    // so a gesture that ends elsewhere can't leave orbiting switched off.
    drawHandleHover = app.drawPending ? null : drawings.handleHit(raycaster);
    orbit.enabled = !drawHandleHover;
    if (drawHandleHover) {
      clearHover();
      renderer.domElement.style.cursor = 'grab';
      return;
    }
    // A joint under the cursor is an ANCHOR target (a line/arrow end, or a
    // text, which then floats above that joint). The pick spheres are invisible
    // in body view until something ghosts them, so this borrows the rotate/drag
    // hover: you can only aim at what you can see.
    const jhit = ANCHOR_TOOLS.has(app.drawTool) ? jointSphereHit() : null;
    if (jhit) setHover(jhit.object.userData.figure, jhit.object);
    else clearHover();
    if (app.drawPending) {
      renderer.domElement.style.cursor = jhit ? 'pointer' : 'crosshair';
      const end = jhit ? jointAnchorAtPointer() : floorPointAtPointer();
      if (end) drawings.showPreview(app.drawTool, app.drawPending, end);
      return;
    }
    // Over a finished drawing the click selects it rather than starting a new
    // shape, so the cursor says so.
    renderer.domElement.style.cursor = (jhit || drawings.pickAt(raycaster)) ? 'pointer' : 'crosshair';
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
// The ball OR its drop line: both are the same indicator, and a user who wants
// to act on "the COG line" aims at the line. Being a tube rather than a
// THREE.Line, it is something a ray can actually hit.
function cogBallHit() {
  const parts = [];
  for (const v of [vizLeader, vizFollower, vizCouple]) {
    if (v.cogBall.visible) parts.push(v.cogBall, v.dropLine);
  }
  return raycaster.intersectObjects(parts, false)[0] ?? null;
}

function cogWinsClick(cogHit, otherHit) {
  if (!cogHit) return false;
  return cogHit.object.userData.viz.front || !otherHit || cogHit.distance <= otherHit.distance;
}

// A click on the BALL keeps its old meaning — draw this indicator in front of
// the dancers. A click on the LINE selects it instead, so the View panel's
// width and colour controls act on that one dancer's line rather than on all
// three; it is also drawn in front, since you have to see what you are styling.
function toggleCogHit(hit) {
  const viz = hit.object.userData.viz;
  if (hit.object === viz.dropLine) {
    app.selectCogLine(viz.key === app.cogLineSelected ? null : viz.key);
    return;
  }
  viz.setFront(!viz.front);
}

// The tools whose points may land on a JOINT rather than on the floor. A line
// and an arrow anchor either end; a text anchors its one position and then
// floats above that joint. A circle is a floor figure by nature (a giro's
// orbit is a ring on the ground), so it is deliberately not here.
const ANCHOR_TOOLS = new Set(['line', 'arrow', 'text']);

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
  // A click on a finished drawing picks it up for editing — its ends get
  // handles and the toolbar's swatch/width follow its look. Only while nothing
  // is half-authored: mid-shape the click belongs to the shape being drawn, or
  // a line crossing an earlier one could never be finished.
  if (!app.drawPending) {
    const hit = drawings.pickAt(raycaster);
    // The Facing tool's one click lands ON a line: that line gets an arrow
    // square to it, level with the floor. Anything else under the cursor is
    // selected as usual, so the tool never becomes a trap.
    const hitType = hit?.userData.annotation?.type;
    if (app.drawTool === 'facing' && (hitType === 'line' || hitType === 'arrow')) {
      const made = app.addDrawFacing(hit);
      if (made) {
        app.selectDrawing(made);
        app.status('Facing arrow added — drag the ball at its tip to lengthen it, or across the line to flip it.', 'info');
      }
      return;
    }
    if (hit) {
      app.selectDrawing(hit);
      app.status('Drawing selected — drag the ball at either end to move it (onto a joint to attach it there, onto the floor to detach), or recolour/resize it in the toolbar. Del removes it.', 'info');
      return;
    }
    if (app.drawSelected) app.selectDrawing(null);
    if (app.drawTool === 'facing') {
      app.status('Facing: click a LINE you have drawn (say, hip bone to hip bone) — it gets an arrow square to it, level with the floor.', 'info');
      return;
    }
  }
  // An end landing on a JOINT anchors there instead of on the floor, which is
  // what lets a teaching line run through a dancer and stay with them — and,
  // for a TEXT, what floats a caption above the dancer it names. The floor
  // stays the fallback, so nothing about the old gesture changes; a circle is a
  // floor diagram by nature and ignores this.
  const joint = ANCHOR_TOOLS.has(app.drawTool) ? jointAnchorAtPointer() : null;
  const p = joint ? null : floorPointAtPointer();
  if (!joint && !p) { app.cancelDraw(); return; }
  if (app.drawTool === 'text') {
    const text = window.prompt(joint
      ? `Label to float above the ${app.figures[joint.fig].name.toLowerCase()}'s ${jointWords(joint.joint)}:`
      : 'Label to write on the floor:');
    if (text && text.trim()) app.addDrawText(joint ?? p, text.trim());
    return;
  }
  if (!app.drawPending) {
    app.drawPending = joint ?? p.clone();
    drawings.showPreview(app.drawTool, app.drawPending, app.drawPending);
    app.status(joint
      ? `Anchored to the ${app.figures[joint.fig].name.toLowerCase()}'s ${jointWords(joint.joint)} — click the other end. (Esc cancels.)`
      : (DRAW_NEXT[app.drawTool] ?? 'Click the second point to finish. (Esc cancels.)'), 'info');
    return;
  }
  const a = app.drawPending;
  const b = joint ?? p;
  app.cancelDraw();
  if (app.drawTool === 'line') app.addDrawLine(a, b);
  else if (app.drawTool === 'arrow') app.addDrawArrow(a, b);
  else if (app.drawTool === 'circle') app.addDrawCircle(a, a.distanceTo(p));
}

// The joint pick sphere under the cursor, whichever dancer it belongs to.
function jointSphereHit() {
  const visible = app.visibleFigures();
  return raycaster.intersectObjects(visible.flatMap((f) => f.pickSpheres), false)[0] ?? null;
}

// The joint under the cursor as a drawing anchor ({ fig, joint }), or null.
// Deliberately NOT routed through clickTargetJoint: that resolves an endpoint
// to its parent for SELECTION (hand_L → wrist_L), and an anchor wants the point
// the user actually aimed at — a line to the hand should end at the hand.
function jointAnchorAtPointer() {
  const hit = jointSphereHit();
  if (!hit) return null;
  const { figure, jointName } = hit.object.userData;
  return { fig: app.figures.indexOf(figure), joint: jointName };
}

// "wrist_L" → "left wrist", for the status line.
function jointWords(name) {
  const side = /_L$/.test(name) ? 'left ' : (/_R$/.test(name) ? 'right ' : '');
  return `${side}${name.replace(/_[LR]$/, '').replace(/_/g, ' ')}`;
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

// Is `figure`'s arm frame being turned right now (Move hips → Frame)? True for
// the drag and the same short hold an edit gets, so the embrace does not snatch
// the arms back between two pointermoves.
function frameTurning(figure) {
  const st = app.frameState;
  return !!st && st.figure === figure && st.stamp
    && (gizmoDragging() || performance.now() - st.stamp < EDIT_HOLD_MS);
}

// The joints a frame turn / elbow hold drives, per dancer.
const FRAME_JOINTS = ['scapula_L', 'shoulder_L', 'elbow_L', 'scapula_R', 'shoulder_R', 'elbow_R'];

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

// Re-aim the billboarded floor texts at the camera. This runs on EVERY frame
// that goes out, including a view-only one — which is the whole point, and why
// it is not folded into the anchored pass below. An orbit changes no pose at
// all: it takes the idle branch, skipping the entire constraint/analysis pass,
// so a billboard driven from there would only re-aim when a dancer happened to
// move, and reads as stuck while the camera swings past it. `anchoredCount` is
// the wrong gate for the same reason twice over — it counts drawings that ride
// the POSE, and a lifted but unanchored text rides nothing.
function refreshBillboards() {
  if (drawings.billboardCount) drawings.updateBillboards();
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
    if (renderFrames > 0) { renderFrames--; refreshBillboards(); studio.renderFrame(); }
    return;
  }
  simFrames--;
  if (renderFrames > 0) renderFrames--;

  if (app.interpPlaying) {
    app.interpT = Math.min(1, app.interpT + dt / SEQ_SEG_SECONDS);
    app.applyInterp(app.interpT);
    if (app.interpTick) app.interpTick(app.interpT);
    if (app.interpT >= 1) {
      // A NATURAL finish — the one place interpDone fires (a stop drops it).
      const done = app.interpDone;
      app.interpDone = null;
      clearPlaying({ seq: false }); // …which also flips the button back to Play
      if (done) done();
    }
  }

  // Advance the movement-sequence player (Play button in the Sequence panel).
  if (app.seqPlaying) {
    const segs = app.seqStates.length - 1;
    if (segs < 1) clearPlaying({ interp: false });
    else {
      // Per-keyframe durations: the player advances through the chain's own
      // running time, so a keyframe given 6 s really takes 6 s.
      app.seqT = Math.min(1, app.seqT + dt / statesSeconds(app.seqStates));
      applyStatesT(app.seqStates, app.seqT, { ease: app.seqEase() });
      if (app.seqTick) app.seqTick(app.seqT);
      if (app.seqT >= 1) {
        // A NATURAL finish — the one place seqDone fires (a stop drops it).
        const done = app.seqDone;
        app.seqDone = null;
        clearPlaying({ interp: false }); // …which also flips the button back to Play
        if (done) done();
      }
    }
  }

  // A capture runs in Present mode, where the ⏺ button is hidden with the rest
  // of the chrome — so the status line is the only place the stop can be
  // announced. Re-asserted per frame rather than raced against the 3 s fade:
  // an identical (text, kind) is free in setStatus (it pushes the expiry out
  // and touches no DOM), which is the same property that lets the joint-limit
  // amber be reported from inside a drag. The status line is page chrome and
  // is structurally incapable of reaching the file (see setStatus).
  if (app.recording && app.presenting && !app.recording.stopping) {
    app.status(app.recording.arming
      ? 'Preparing to record… Esc cancels.'
      : 'Recording… Esc stops and saves.', 'info');
  }

  // Advance a video capture's playback; stop the recorder shortly after the
  // final pose so the last frames make it into the file.
  if (app.recording?.rec) {
    const r = app.recording;
    r.t = Math.min(1, r.t + dt / r.secs);
    applyStatesT(r.states, r.t, { ease: r.ease });
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

  // The elbow hold is live except while a pose is being PLAYED at the dancers
  // (a sequence, A→B, a capture, a clip): the player rewrites the arms every
  // frame, so the hold follows instead of fighting it, and picks up again from
  // wherever the playback leaves the elbows.
  const holdLive = elbowHold.count > 0 && holdRecaptureFrames <= 0
    && !(studio.clipActive || app.seqPlaying || app.interpPlaying || app.recording);
  if (holdRecaptureFrames > 0) { holdRecaptureFrames--; requestSim(2); }
  if (!held) {
    // An arm the elbow hold or a live frame turn is driving belongs to it; the
    // embrace treats it as it treats an arm the user is posing.
    embrace.maintainHands(editing, (figure) => (holdLive && elbowHold.has(figure))
      || frameTurning(figure));

    // Contact pins, limb half: an adapting arm/leg re-solves so its pinned spot
    // reaches the partner's. After the embrace hands so a pin on an embrace arm
    // deliberately wins (the pin is the more specific intent).
    pins.maintainLimbs(editing?.figure ?? null);
  }
  // Fixed elbows, LAST: the most specific intent on those arms, so it has the
  // final word over the embrace hands and an arm pin. Runs in Anchor mode too —
  // it moves nobody but the dancer's own arms.
  if (elbowHold.count) {
    if (holdLive) {
      elbowHold.maintain(editing);
      // Said only while the user is actually moving something: the constraint
      // runs every frame, and a standing message about a pose nobody is
      // touching would never clear.
      const s = performance.now() - app.editStamp < EDIT_HOLD_MS ? elbowHold.strained() : null;
      if (s) {
        app.status(`${s.figure.name}'s ${s.side === 'L' ? 'left' : 'right'} elbow can't stay there — the shoulder is at its limit`, 'limit');
      }
    } else {
      elbowHold.recapture();
    }
    // Editing chrome: off the slide with the rest (Present, and so a capture).
    elbowHold.group.visible = !app.presenting;
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

  // Floor drawings whose ends are pinned to joints ride the dancers. After
  // syncAtlasNodes, because an anchored end reads `surfacePos` — the node the
  // visible body is welded to, which is the atlas node on a seated limb joint.
  if (drawings.anchoredCount) drawings.updateAnchored();
  // …and a floating text re-aims at the camera on this frame too (the anchored
  // pass has just moved it; the aim is a separate question — see above).
  refreshBillboards();

  // Deform bi-articular muscles to the current pose (a no-op unless a belly is
  // actually on screen — the muscle layer, or one lit over the bare bones in
  // skeleton view). Runs after clampToFloor so joint matrices are current.
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
  // A video capture is recorded from inside Present mode (see recordPlayback),
  // which hides the ⏺ button along with the rest of the chrome: Esc is the
  // only stop the user can reach, so while a capture runs it stops and SAVES
  // the take rather than abandoning the slide. Present mode is then handed
  // back by the capture's own completion (finishRecPresent) — one Esc for the
  // recording, a second for the presentation.
  if (k === 'Escape') { if (app.recording) app.stopRecording(); else app.exitPresent(); }
  // Every other presenter key changes the shot — a slide step, or a movement
  // played over the one being captured. A remote's click must not swap the
  // slide into the middle of a video, so they are swallowed for the duration.
  else if (app.recording) handled = true;
  else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') app.gotoSlide(1);
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') app.gotoSlide(-1);
  else if (k === 'Home') { app.slideAt = -1; app.gotoSlide(1); }
  else if (k === 'f' || k === 'F') {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (k === ' ' || e.code === 'Space') {
    // Play/stop TOGGLE, the media-player convention — and the only key a
    // presenter has for it, so it cannot be play-only: a movement that runs
    // for eight seconds has to be stoppable mid-sentence. Play picks whatever
    // movement this slide is about (a keyframe sequence first, then an A→B
    // comparison) and resumes from the scrubber; failing both, Space just
    // advances the deck as it always did.
    if (!app.stopPlayback()) {
      if (app.seqStates.length >= 2) app.playSeq();
      else if (app.interpStates) app.playInterp();
      else app.gotoSlide(1);
    }
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
  if (!app.presenting || document.fullscreenElement) return;
  // A capture composites into a canvas sized from the 16:9 frame when it
  // started, so leaving Present resizes the render target out from under it.
  // End the take and SAVE it first — never leave a recorder running against a
  // canvas that has changed shape. exitPresent still runs, because the user
  // asked to LEAVE and not merely to stop; finishRecPresent then no-ops.
  if (app.recording) app.stopRecording();
  app.exitPresent();
});

// Esc abandons whatever is half-finished — see app.cancelPending for the order.
// Never reached while presenting: the capture handler above consumes Escape.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') app.cancelPending();
});

// Space is the play/stop toggle in the editor too — the same gesture Present
// mode binds, and the same one every video player has trained the user to
// expect. Space was otherwise unbound here, so nothing is taken away.
//
// The guard is what makes it safe: a caption or a keyframe label is full of
// spaces, and a FOCUSED BUTTON already treats Space as its own activation —
// pressing Space just after clicking Play would otherwise toggle twice and
// look like nothing happened. Anything focused inside the app chrome owns its
// own Space key (the same rule the nudge handler applies to the arrows); this
// only means anything with focus on the canvas or the page body.
window.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.code !== 'Space') return;
  if (app.presenting) return; // the capture handler above already consumed it
  const t = e.target;
  if (t && (t.closest?.('#sidebar, #topbar') || t.isContentEditable
            || /^(?:INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
  if (app.recording) return; // a capture owns the player for its whole length
  e.preventDefault(); // Space scrolls the page by default
  if (app.stopPlayback()) {
    app.status('Playback stopped.', 'info');
    return;
  }
  if (app.seqStates.length >= 2) app.playSeq();
  else if (app.interpStates) app.playInterp();
});

// Delete removes the selected floor drawing. Scoped to Draw mode with a
// drawing actually selected, and never while typing into a field.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (app.mode !== 'draw' || !app.drawSelected) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'range') return;
  e.preventDefault();
  if (app.removeSelectedDrawing()) app.status('Drawing removed.', 'info');
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
    if (handle === hipsTarget && app.hipsTool === 'frame') {
      // Frame turn: ←/→ orbit the elbows about the chest; the ring has no
      // position to nudge, so the other keys are simply swallowed.
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        const want = (k === 'ArrowLeft' ? 1 : -1) * NUDGE_TURN * coarse;
        const applied = app.turnFrame(app.hipsState.figure, want);
        reportFrameTurn(app.hipsState.figure, want, applied);
        app.hipsState.lastYaw += applied;
        hipsTarget.rotation.y = app.hipsState.lastYaw;
        if (app.ui) app.ui.refreshJointValues();
      }
      return;
    }
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
