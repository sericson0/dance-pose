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
import { resolveBodyCollision, bodyClearance, bodyContacts } from './collision.js';
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
  // Smallest surface clearance between the two dancers' body colliders
  // (negative = penetration) — for the dev verification scripts.
  bodyClearance: () => bodyClearance(leader, follower),
  // The tightest collider pairs by name, tightest first — for radius tuning.
  bodyContacts: (n = 5) => bodyContacts(leader, follower).slice(0, n),
  figures: [leader, follower],
  presets: PRESETS,
  mode: 'rotate',
  chainMode: 'open', // 'open' (move distal) | 'closed' (anchor foot, move proximal)
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
  interpPlaying: false,
  interpT: 0,
  interpTick: null, // UI callback fed the current t while playing
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

  // Swing a dancer's open-side elbow (role 'leader'/'follower') around its
  // shoulder→wrist axis without moving the joined hands (0 = elbow down).
  setOpenElbow(role, deg) {
    this.embrace.setOpenElbow(role, deg);
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

  // Default chain mode for a leg/pelvis joint: closed when its foot is planted
  // (bend the knee and the body sinks over the standing foot), else open.
  autoChain(figure, jointName) {
    figure.group.updateMatrixWorld(true);
    const contacts = footContactsBySide(figure);
    const planted = (side) => contacts[side] && contacts[side].length > 0;
    if (jointName === 'pelvis') return planted('L') || planted('R') ? 'closed' : 'open';
    const side = jointName.endsWith('_L') ? 'L' : 'R';
    return planted(side) ? 'closed' : 'open';
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
    // Chain mode is a legs-only choice; default it from whether the foot is planted.
    this.chainMode = CHAIN_JOINTS.has(jointName) ? this.autoChain(figure, jointName) : 'open';
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
    for (const o of [tcontrols, ikTarget, swivelTarget, caressTarget, hipsTarget]) {
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

tcontrols.addEventListener('objectChange', () => {
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
// a pointer over a draggable dancer (move / walk modes). The joint pick spheres
// are invisible click targets in body view, so without this they're undiscoverable.
const HOVER_EMISSIVE = 0xf5b942;
let hoverSphere = null;

// The pick sphere's opacity when not hovered: faintly shown in skeleton view,
// invisible (but still clickable) otherwise — mirrors Figure.setLayers.
function restingOpacity(figure) {
  return figure.layers && figure.layers.skeleton ? 0.22 : 0;
}

function clearHover() {
  if (hoverSphere) {
    const { figure, jointName } = hoverSphere.userData;
    const isSel = app.selected && app.selected.figure === figure && app.selected.jointName === jointName;
    hoverSphere.material.emissive.set(isSel ? 0x3b6ea5 : 0x000000);
    hoverSphere.material.opacity = restingOpacity(figure);
    hoverSphere = null;
  }
  renderer.domElement.style.cursor = '';
}

function setHoverSphere(sphere) {
  if (sphere === hoverSphere) return;
  clearHover();
  hoverSphere = sphere;
  sphere.material.emissive.set(HOVER_EMISSIVE);
  sphere.material.opacity = Math.max(sphere.material.opacity, 0.6);
  renderer.domElement.style.cursor = 'pointer';
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

  if (app.mode === 'move' || app.mode === 'step' || app.mode === 'hips') {
    clearHover();
    const hits = raycaster.intersectObjects(visible.map((f) => f.group), true);
    renderer.domElement.style.cursor = hits.some((h) => h.object.visible) ? 'pointer' : '';
    return;
  }

  const spheres = visible.flatMap((f) => f.pickSpheres);
  const hit = raycaster.intersectObjects(spheres, false)
    .find((h) => jointActionable(h.object.userData.jointName));
  if (hit) setHoverSphere(hit.object);
  else clearHover();
});

function handleClick(e) {
  pointerRay(e);

  const visible = app.visibleFigures();
  if (app.mode === 'move' || app.mode === 'step' || app.mode === 'hips') {
    const hits = raycaster.intersectObjects(visible.map((f) => f.group), true);
    const hit = hits.find((h) => h.object.visible);
    if (hit) {
      let o = hit.object;
      while (o && !o.userData.figure) o = o.parent;
      if (o) {
        app.selectFigure(o.userData.figure);
        // In Step mode a click on a dancer takes one step forward — keep
        // clicking to walk. The arrow keys step/turn the same dancer.
        if (app.mode === 'step') app.stepFigure(o.userData.figure, 1);
      }
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

// Keyboard nudges for the active figure (Move / Step modes). Move: arrows slide
// forward/back and turn (pivoting on the support foot). Step: arrows step
// forward/back and turn. Shift makes a Move nudge coarser. Hold "Move as couple"
// to drive the pair together.
const NUDGE_DIST = 0.03;                  // metres per press when sliding
const NUDGE_TURN = 4 * Math.PI / 180;     // radians per press when turning
const STEP_TURN = 8 * Math.PI / 180;      // radians per press when turning in Step mode
let lastNudge = 0;
window.addEventListener('keydown', (e) => {
  if (!e.key.startsWith('Arrow')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'range') return;
  const fig = app.activeFigure;
  if (!fig || !fig.group.visible || (app.mode !== 'move' && app.mode !== 'step')) return;
  e.preventDefault();
  const now = performance.now();
  if (now - lastNudge > 500) app.pushHistory(); // one undo entry per burst of nudges
  lastNudge = now;
  const k = e.key;
  if (app.mode === 'step') {
    if (k === 'ArrowUp') app.stepFigure(fig, 1);
    else if (k === 'ArrowDown') app.stepFigure(fig, -1);
    else if (k === 'ArrowLeft') app.turnFigure(fig, STEP_TURN);
    else if (k === 'ArrowRight') app.turnFigure(fig, -STEP_TURN);
  } else {
    const coarse = e.shiftKey ? 3 : 1;
    if (k === 'ArrowUp') app.slideFigure(fig, NUDGE_DIST * coarse);
    else if (k === 'ArrowDown') app.slideFigure(fig, -NUDGE_DIST * coarse);
    else if (k === 'ArrowLeft') app.turnFigure(fig, NUDGE_TURN * coarse);
    else if (k === 'ArrowRight') app.turnFigure(fig, -NUDGE_TURN * coarse);
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
