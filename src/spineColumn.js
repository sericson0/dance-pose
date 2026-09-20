import * as THREE from 'three';
import { PointGrid } from './pointGrid.js';

// The vertebral column as a CURVE, not two sticks.
//
// The rig bends the trunk at two hinges — `spine` (lumbar, 0.62H) and `chest`
// (thoracic, 0.72H) — and that is right for what the rig is for: the COG, the
// embrace, the clothed avatar and every constraint read those two frames. But
// the atlas bones were hung on them RIGIDLY, the five lumbar vertebrae as one
// block on `spine` and all twelve thoracic vertebrae plus the whole ribcage as
// one block on `chest`, so a side bend rendered as a straight lumbar stick
// hinged on the sacrum with a second kink at T9/T10 — and T10-T12, which sit
// BELOW the chest pivot, swung the wrong way out from under L1.
//
// This spreads each joint's rotation along the column. It is DISPLAY ONLY: no
// rig node moves, nothing changes at rest, and the two ends are exact — the
// sacrum stays in the pelvis frame and T1 lands exactly where the rigid chest
// frame puts it, so the neck, the girdle and the sternum stay welded.
//
//   orientation  vertebra k turns by  q_spine^A(k) · q_chest^B(k), where A and
//                B are LINEAR ramps in rest height — a constant curvature, i.e.
//                "evenly distributed". Each ramp is SYMMETRIC ABOUT ITS RIG
//                PIVOT, and that is the load-bearing choice: a hinge at height
//                p and a bend spread evenly over [p − a, p + a] carry the top of
//                the column to the same place to second order (the first
//                moment of the rotation density is what sets the far end's
//                displacement). An even bend over the anatomical regions
//                instead — lumbar = L5-L1, thoracic = T12-T1 — has its centroid
//                6 cm above the chest pivot and leaves T1 46 mm short of the
//                shoulders at a 25° side bend. So the chest ramp runs T1 down
//                to ~L3 and overlaps the lumbar one; that is the honest drawing
//                of a rig whose "thoracic" hinge sits at T9/T10.
//   position     a chain: each vertebra hinges on the disc it shares with the
//                one below. The few mm the chain still misses the rigid T1 by
//                (the rig pivots lie on the body's midline, ~5 cm in front of
//                the column, so flexion lengthens the path and a twist sweeps
//                it sideways) is spread along the column by arc length — it
//                opens every disc a hair instead of one joint by centimetres.
//   ribs         a rib is rigid on ITS OWN vertebra at the head and hands over
//                to the chest frame (the sternum's) toward its sternal end, so
//                the cage fans open on the convex side and closes on the
//                concave one while every costovertebral and sternocostal
//                junction stays shut. The sternum itself stays chest-rigid:
//                the clavicles articulate on it and ride the scapula nodes.
//
//   muscles      ride the same curve. A belly anchored on `chest` or `pelvis`
//                takes that side of its skin from these frames, per vertex,
//                instead of from the one rigid rig frame (bindTrunk / trunkDQ
//                at the bottom of this file, consumed by Figure.updateMuscleSkin)
//                — or the whole back slides off the bones the moment they bend.
//
// CPU skinning in the meshes' own node frames, like the bi-articular muscles:
// the geometry attribute stays the truth, so labels, landmarks, picking and
// the probes all keep reading it the way they always have.

// How far each rib's sternal end follows the chest frame (1 = welded to the
// sternum via its cartilage). 11 and 12 are floating ribs with no cartilage to
// the sternum; they follow a little so the lower cage fans evenly instead of
// leaving a step under rib 10.
const RIB_FOLLOW = { 11: 0.6, 12: 0.3 };
// The hand-over along a rib, as the angle (degrees) round the thorax's vertical
// axis measured from the front midline: a rib is its vertebra's until it has
// come round past RIB_BACK (the rib angle, just lateral of the transverse
// process) and the sternum's by RIB_FRONT (the sternocostal joints).
const RIB_BACK = 150;
const RIB_FRONT = 20;
// Where a vertebra's BODY centre sits between its front face and the tip of
// its spinous process — the disc, which is what it hinges on, is under the
// body, not under the centroid of body + arch.
const BODY_DEPTH = 0.3;
// Slack added to the deformed meshes' bounding volumes (fraction of stature):
// frustum culling and the raycaster's early-out both read the REST bounds.
const BOUNDS_SLACK = 0.08;

const VERTEBRA_RE = /^(Lumbar|Thoracic)_vertebrae_\(([LT])(\d+)\)/i;
const RIB_RE = /^Rib_\((\d+)/i;
const CART_RE = /^Costal_cart_of_(\d+)/i;
const RIGID = 255;

// The trunk FIELD's frames (see bindTrunk): 0 = the pelvis, 1..17 = the
// vertebrae L5..T1, 18 = the rigid chest frame.
const TRUNK_FRAMES = 19;
const F_PELVIS = 0;
const F_CHEST = 18;
// Below the ribcage there is no rib to hand tissue over to the sternum: the
// hand-over fades out down the floating ribs exactly as RIB_FOLLOW fades the
// ribs themselves, per level (pelvis, L5..L1, T12, T11, then T10 and up).
const LEVEL_FOLLOW = Array.from({ length: 18 }, (_, e) => (e <= 5 ? 0 : RIB_FOLLOW[18 - e] ?? 1));
// Which of "the pelvis" and "the column above it" a piece of tissue belongs to,
// as a window on the contact ratio dPelvis / (dPelvis + dColumn) — the same
// instrument as Figure.#contactWeights. Tissue lying on the ilium or sacrum is
// the pelvis's however high up the crest it sits (the crest reaches L4), and a
// level-by-height rule alone would turn it with L4/L5.
const PELVIS_WINDOW = [0.4, 0.7];
// Tissue over the ribcage follows the RIBS under it, not the vertebra at its
// own height: a rib slopes down two or three vertebral levels on its way round
// (the 10th rib passes the flank at the height of L1-L2, the 7th cartilage
// meets the sternum at T10-T11), so by height alone latissimus and serratus
// anterior rode frames 2-3 levels below the ribs they lie on and slid 13-18 mm
// over them in a twist. Within RIB_NEAR of a rib the tissue takes that rib's
// own binding outright, beyond RIB_FAR the level by height; fractions of stature.
const RIB_NEAR = 0.012;
const RIB_FAR = 0.03;
// Ribs are blended over everything within this of the nearest one, so tissue
// lying between two ribs shears between them instead of stepping.
const RIB_BLEND = 0.009;
const RIB_SAMPLES = 1400;

// L5 → 0 … L1 → 4, T12 → 5 … T1 → 16: bottom to top.
const vertebraIndex = (region, n) => (region.toUpperCase() === 'L' ? 5 - n : 17 - n);

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => x * x * (3 - 2 * x);
const IDENT = new THREE.Quaternion();

const _qs = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _e = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _Mn = new THREE.Matrix4();
const _F = new THREE.Matrix4();
const _T = new THREE.Matrix4();
const _P = new THREE.Matrix4();
const _tq = new THREE.Quaternion();
const _tt = new THREE.Vector3();
const _ts = new THREE.Vector3();

export class SpineColumn {
  // Build at REST (every rig rotation identity), after the skeleton bake.
  constructor(figure) {
    this.figure = figure;
    this.vertebrae = [];
    this.meshes = [];
    this._key = new Float64Array(8);
    this._key[3] = this._key[7] = 1; // rest: nothing to do until a joint turns

    const { pelvis, spine, chest } = figure.nodes;
    figure.group.updateMatrixWorld(true);
    const pelvisInv = pelvis.matrixWorld.clone().invert();
    // Figure-local rest → pelvis-local rest: the bind of the trunk FIELD the
    // muscle layer rides (bindTrunk / trunkDQ below).
    this.bindInv = pelvisInv.clone().multiply(figure.group.matrixWorld);
    this._serial = 0;      // bumped whenever the frames are re-solved
    this._meshSerial = 0;  // the solve the bone meshes were last deformed to
    this._dq = new Float64Array(TRUNK_FRAMES * 8);

    // Pass 1 — the vertebrae: body centre + extent, in pelvis-local rest coords.
    const found = new Map();
    const sources = [];
    for (const node of [spine, chest]) {
      for (const mesh of node.children) {
        if (!mesh.isMesh || !mesh.userData.boneRanges) continue;
        const rel = pelvisInv.clone().multiply(mesh.matrixWorld);
        sources.push({ mesh, node, rel });
        const pos = mesh.geometry.attributes.position;
        for (const r of mesh.userData.boneRanges) {
          const m = VERTEBRA_RE.exec(r.name);
          if (!m) continue;
          let y = 0, zMin = Infinity, zMax = -Infinity;
          for (let i = r.start; i < r.start + r.count; i++) {
            _v.fromBufferAttribute(pos, i).applyMatrix4(rel);
            y += _v.y; zMin = Math.min(zMin, _v.z); zMax = Math.max(zMax, _v.z);
          }
          found.set(vertebraIndex(m[2], +m[3]), {
            name: r.name,
            body: new THREE.Vector3(0, y / r.count, zMax - BODY_DEPTH * (zMax - zMin)),
          });
        }
      }
    }
    // The chain needs every link: a gap would hinge two vertebrae on a disc
    // that is not between them. Anything short of the full column stays rigid.
    for (let k = 0; k < 17; k++) if (!found.has(k)) return;
    this.vertebrae = Array.from({ length: 17 }, (_, k) => found.get(k));
    const V = this.vertebrae;

    // Discs: joint[k] is the hinge under vertebra k. The lumbosacral one is
    // extrapolated half a segment below L5 (the sacrum is not in the chain).
    V.forEach((v, k) => {
      v.joint = k ? V[k - 1].body.clone().add(v.body).multiplyScalar(0.5)
        : v.body.clone().multiplyScalar(1.5).addScaledVector(V[1].body, -0.5);
    });
    let len = 0;
    V.forEach((v, k) => { len += v.body.distanceTo(k ? V[k - 1].body : v.joint); v.s = len; });
    V.forEach((v) => { v.s /= len; });

    // The two ramps, each symmetric about its rig pivot (see the header): the
    // lumbar one from the lumbosacral disc, the chest one from T1.
    const yS = spine.position.y;
    const yC = yS + chest.position.y;
    const top = V[16].body.y;
    const sLo = V[0].joint.y, sHi = 2 * yS - sLo;
    const cHi = top, cLo = 2 * yC - cHi;
    V.forEach((v) => {
      v.a = clamp01((v.body.y - sLo) / (sHi - sLo));
      v.b = clamp01((v.body.y - cLo) / (cHi - cLo));
      v.q = new THREE.Quaternion();
      v.p = v.body.clone(); // rest: every vertebra is where it was bound
    });
    V[16].a = V[16].b = 1; // T1 IS the chest frame — orientation closes exactly
    this.ramps = { spine: [sLo, sHi], chest: [cLo, cHi] };
    this.chestRest = new THREE.Vector3().copy(spine.position).add(chest.position);
    this.chestRestInv = new THREE.Matrix4().makeTranslation(
      -this.chestRest.x, -this.chestRest.y, -this.chestRest.z);
    // pelvis→spine and pelvis→chest, as of the last solve (rest until one runs).
    this.Ms = new THREE.Matrix4().makeTranslation(spine.position.x, spine.position.y, spine.position.z);
    this.Mc = new THREE.Matrix4().makeTranslation(this.chestRest.x, this.chestRest.y, this.chestRest.z);

    // The thorax's vertical axis for the rib hand-over: midway between the
    // thoracic bodies and the sternum.
    let zBack = 0;
    for (let k = 5; k < 17; k++) zBack += V[k].body.z / 12;
    let zFront = null;
    for (const { mesh, rel } of sources) {
      const pos = mesh.geometry.attributes.position;
      for (const r of mesh.userData.boneRanges) {
        if (!/sternum/i.test(r.name)) continue;
        let z = 0;
        for (let i = r.start; i < r.start + r.count; i++) z += _v.fromBufferAttribute(pos, i).applyMatrix4(rel).z;
        zFront = Math.max(zFront ?? -Infinity, z / r.count);
      }
    }
    const z0 = zFront === null ? zBack + 0.045 * figure.height : (zBack + zFront) / 2;
    this.z0 = z0;
    // Rest heights of the trunk field's levels: the pelvis half a segment below
    // the lumbosacral disc (L5 mirrored through it), then the 17 bodies.
    this.levelY = [2 * V[0].joint.y - V[0].body.y, ...V.map((v) => v.body.y)];

    // Pass 2 — bind every vertex: which vertebra's frame it rides and how much
    // of the chest frame it takes. Bones that are neither (the sternum) keep
    // RIGID and are never touched.
    const ribs = []; // x, y, z (pelvis-local rest), level, chest share — every rib vertex
    for (const { mesh, node, rel } of sources) {
      const geom = mesh.geometry;
      const pos = geom.attributes.position;
      const nrm = geom.attributes.normal;
      const n = pos.count;
      const frame = new Uint8Array(n).fill(RIGID);
      const t = new Float32Array(n);
      const bindPos = new Float32Array(n * 3);
      const bindNrm = new Float32Array(n * 3);
      const relN = new THREE.Matrix3().setFromMatrix4(rel); // rigid, so no inverse-transpose
      let any = false;
      for (const r of mesh.userData.boneRanges) {
        let k = RIGID, follow = 0, m;
        if ((m = VERTEBRA_RE.exec(r.name))) k = vertebraIndex(m[2], +m[3]);
        else if ((m = RIB_RE.exec(r.name) || CART_RE.exec(r.name))) {
          k = vertebraIndex('T', +m[1]);
          follow = RIB_FOLLOW[+m[1]] ?? 1;
        }
        if (k === RIGID || k < 0 || k > 16) continue;
        any = true;
        for (let i = r.start; i < r.start + r.count; i++) {
          _v.fromBufferAttribute(pos, i).applyMatrix4(rel);
          bindPos[i * 3] = _v.x; bindPos[i * 3 + 1] = _v.y; bindPos[i * 3 + 2] = _v.z;
          _w.fromBufferAttribute(nrm, i).applyMatrix3(relN);
          bindNrm[i * 3] = _w.x; bindNrm[i * 3 + 1] = _w.y; bindNrm[i * 3 + 2] = _w.z;
          frame[i] = k;
          if (follow) {
            const u = Math.atan2(Math.abs(_v.x), _v.z - z0) * (180 / Math.PI);
            t[i] = follow * smooth(clamp01((RIB_BACK - u) / (RIB_BACK - RIB_FRONT)));
            ribs.push(_v.x, _v.y, _v.z, k + 1, t[i]); // level = vertebra + 1
          }
        }
      }
      if (!any) continue;
      const slack = BOUNDS_SLACK * figure.height;
      geom.computeBoundingSphere();
      geom.boundingSphere.radius += slack;
      geom.computeBoundingBox();
      geom.boundingBox.expandByScalar(slack);
      this.meshes.push({ mesh, node, frame, t, bindPos, bindNrm, G: new Float64Array(18 * 12) });
    }
    // The ribs' own binding, thinned, for the trunk field (bindTrunk).
    const stride = Math.max(1, Math.floor(ribs.length / 5 / RIB_SAMPLES)) * 5;
    const thin = [];
    for (let i = 0; i < ribs.length; i += stride) thin.push(...ribs.slice(i, i + 5));
    this.ribSamples = Float32Array.from(thin);
    // Nothing below the lowest rib can be near one: most trunk-node bellies are
    // hip muscles, and this spares every one of their vertices the search.
    this.ribFloor = Infinity;
    for (let c = 1; c < thin.length; c += 5) this.ribFloor = Math.min(this.ribFloor, thin[c]);
  }

  // The frames: every vertebra's orientation and place for the current spine /
  // chest rotation, in pelvis-local coordinates. Free when neither joint has
  // turned since the last call (syncAtlasNodes runs many times a frame inside
  // the solvers). Separate from the bone deform below because the MUSCLE layer
  // rides these frames too (trunkDQ) and may be showing while the bones are not.
  solve(force = false) {
    const V = this.vertebrae;
    if (!V.length) return;
    const { spine, chest } = this.figure.nodes;
    const qs = _qs.copy(spine.quaternion);
    const qc = _qc.copy(chest.quaternion);
    const key = this._key;
    if (!force && key[0] === qs.x && key[1] === qs.y && key[2] === qs.z && key[3] === qs.w
      && key[4] === qc.x && key[5] === qc.y && key[6] === qc.z && key[7] === qc.w) return;
    key[0] = qs.x; key[1] = qs.y; key[2] = qs.z; key[3] = qs.w;
    key[4] = qc.x; key[5] = qc.y; key[6] = qc.z; key[7] = qc.w;
    this._serial++;
    // Per instance, not module scratch: the two dancers solve independently and
    // a keyed-out call must still find ITS matrices here.
    const _Ms = this.Ms, _Mc = this.Mc;

    // Orientation, then the chain of discs.
    V.forEach((v, k) => {
      v.q.copy(IDENT).slerp(qs, v.a).multiply(_qa.copy(IDENT).slerp(qc, v.b));
      const below = k ? V[k - 1] : null;
      v.p.copy(v.joint);
      if (below) v.p.sub(below.body).applyQuaternion(below.q).add(below.p);
      v.p.add(_v.copy(v.body).sub(v.joint).applyQuaternion(v.q));
    });
    // Close onto the rigid chest frame at T1; spread the miss by arc length.
    _Ms.compose(spine.position, qs, _one);
    _Mc.compose(chest.position, qc, _one).premultiply(_Ms);
    _e.copy(V[16].body).sub(this.chestRest).applyMatrix4(_Mc).sub(V[16].p);
    this.closure = _e.length();
    V.forEach((v) => v.p.addScaledVector(_e, v.s));
  }

  // Deform the bones to the current frames. Skipped while the skeleton is
  // hidden — the stale serial makes the next visible call catch up.
  update(force = false) {
    if (!this.meshes.length) return;
    this.solve(force);
    if (!force && (!this.figure.layers?.skeleton || this._meshSerial === this._serial)) return;
    this._meshSerial = this._serial;
    const { chest } = this.figure.nodes;
    const V = this.vertebrae;
    const _Ms = this.Ms, _Mc = this.Mc;

    for (const sm of this.meshes) {
      // Bind coords (pelvis-local rest) → this mesh's own frame, per vertebra:
      // G = (node · mesh)⁻¹ · [ p + q (x − body) ]. Slot 17 is the chest frame.
      _Mn.copy(sm.node === chest ? _Mc : _Ms).multiply(sm.mesh.matrix).invert();
      for (let k = 0; k <= 17; k++) {
        if (k < 17) {
          const v = V[k];
          _F.compose(v.p, v.q, _one).multiply(_T.makeTranslation(-v.body.x, -v.body.y, -v.body.z));
        } else _F.copy(_Mc).multiply(this.chestRestInv);
        const e = _F.premultiply(_Mn).elements;
        const o = k * 12;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) sm.G[o + r * 4 + c] = e[c * 4 + r];
      }
      const { G, frame, t, bindPos, bindNrm } = sm;
      const parr = sm.mesh.geometry.attributes.position.array;
      const narr = sm.mesh.geometry.attributes.normal.array;
      for (let i = 0, j = 0; i < frame.length; i++, j += 3) {
        const f = frame[i];
        if (f === RIGID) continue;
        const o = f * 12;
        const x = bindPos[j], y = bindPos[j + 1], z = bindPos[j + 2];
        const nx = bindNrm[j], ny = bindNrm[j + 1], nz = bindNrm[j + 2];
        let px = G[o] * x + G[o + 1] * y + G[o + 2] * z + G[o + 3];
        let py = G[o + 4] * x + G[o + 5] * y + G[o + 6] * z + G[o + 7];
        let pz = G[o + 8] * x + G[o + 9] * y + G[o + 10] * z + G[o + 11];
        let qx = G[o] * nx + G[o + 1] * ny + G[o + 2] * nz;
        let qy = G[o + 4] * nx + G[o + 5] * ny + G[o + 6] * nz;
        let qz = G[o + 8] * nx + G[o + 9] * ny + G[o + 10] * nz;
        const w = t[i];
        if (w > 0) {
          // The frames differ by ≤ ~15° across one rib, so a linear blend of
          // the two placements loses nothing visible.
          const c = 17 * 12, u = 1 - w;
          px = u * px + w * (G[c] * x + G[c + 1] * y + G[c + 2] * z + G[c + 3]);
          py = u * py + w * (G[c + 4] * x + G[c + 5] * y + G[c + 6] * z + G[c + 7]);
          pz = u * pz + w * (G[c + 8] * x + G[c + 9] * y + G[c + 10] * z + G[c + 11]);
          qx = u * qx + w * (G[c] * nx + G[c + 1] * ny + G[c + 2] * nz);
          qy = u * qy + w * (G[c + 4] * nx + G[c + 5] * ny + G[c + 6] * nz);
          qz = u * qz + w * (G[c + 8] * nx + G[c + 9] * ny + G[c + 10] * nz);
          const inv = 1 / (Math.hypot(qx, qy, qz) || 1);
          qx *= inv; qy *= inv; qz *= inv;
        }
        parr[j] = px; parr[j + 1] = py; parr[j + 2] = pz;
        narr[j] = qx; narr[j + 1] = qy; narr[j + 2] = qz;
      }
      sm.mesh.geometry.attributes.position.needsUpdate = true;
      sm.mesh.geometry.attributes.normal.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- the trunk
  // as a FIELD, for the muscle layer.
  //
  // The bones above bend as a curve, but a muscle skinned to `chest` or `pelvis`
  // rides ONE rigid frame, so the two part company as soon as the trunk turns:
  // latissimus dorsi arises from the sacrum, the iliac crest and every spinous
  // process from L5 to T7, and welded to the chest frame its whole origin swung
  // round as a slab — in a 43° dissociation twist the tissue lying on the pelvis
  // left it by 73 mm (309 mm in trunk flexion), the lumbar part by 46, and
  // trapezius, the rhomboids, serratus anterior and psoas major each came off
  // their own vertebrae and ribs by 1-4 cm the same way.
  //
  // So a trunk-anchored belly's trunk side follows THIS instead: per vertex, the
  // frame of the vertebra at its height (interpolated between neighbours), handed
  // over to the chest frame round the ribcage by the SAME rule the ribs use (so
  // tissue lying on a rib moves as that patch of rib does) and to the pelvis by
  // contact. Both rig frames are reproduced exactly where they hold — T1 and the
  // front of the cage ARE the chest frame, tissue on the pelvis IS the pelvis's —
  // so a belly nowhere near the column is left alone (bindTrunk returns null).
  //
  // `pos` is figure-local rest (a BufferAttribute); the clouds are figure-local
  // bone surfaces (Figure.#boneCloud). `own` is the rig frame this replaces,
  // 'chest' or 'pelvis'. Returns { k, w, own } — per vertex the lower level and
  // four weights [level k, level k+1, chest, pelvis] — or null.
  //
  // `ribsOnly` is for a FREE sheet (the abdominal wall): it keeps the rigid chest
  // frame everywhere except where it actually lies on a rib, and there takes that
  // rib's binding. No level-by-height and no pelvis share — in front of the lumbar
  // spine there is no bone for the tissue to be on, and "the vertebra at this
  // height" has barely turned, which would crowd the whole twist in under the
  // costal margin.
  bindTrunk(pos, own, pelvisCloud, columnCloud, { ribsOnly = false } = {}) {
    if (!this.vertebrae.length) return null;
    const Y = this.levelY;
    const n = pos.count;
    const k = new Uint8Array(n);
    const w = new Float32Array(n * 4);
    const pelvisGrid = pelvisCloud?.length ? PointGrid.of(pelvisCloud, 3, 0.04) : null;
    const columnGrid = columnCloud?.length ? PointGrid.of(columnCloud, 3, 0.04) : null;
    const [rLo, rHi] = PELVIS_WINDOW;
    const pelvisTop = Y[6]; // T12: nothing above it is near enough the pelvis to ask
    const R = this.ribSamples;
    const H = this.figure.height;
    const near = RIB_NEAR * H, far = RIB_FAR * H, blend = RIB_BLEND * H;
    const ribGrid = R.length ? PointGrid.of(R, 5) : null;
    let strays = 0;
    for (let i = 0; i < n; i++) {
      _w.fromBufferAttribute(pos, i);
      _v.copy(_w).applyMatrix4(this.bindInv);
      // Level by height.
      let e = 0;
      while (e < 16 && _v.y >= Y[e + 1]) e++;
      let f = clamp01((_v.y - Y[e]) / (Y[e + 1] - Y[e]));
      // Round the cage: the vertebra's at the back, the sternum's at the front.
      const follow = LEVEL_FOLLOW[e] * (1 - f) + LEVEL_FOLLOW[e + 1] * f;
      const u = Math.atan2(Math.abs(_v.x), _v.z - this.z0) * (180 / Math.PI);
      let t = follow * smooth(clamp01((RIB_BACK - u) / (RIB_BACK - RIB_FRONT)));
      // Over the cage: the binding of the ribs underneath (see RIB_NEAR).
      let share = 0;
      if (ribGrid && _v.y > this.ribFloor - far) {
        const dMin = ribGrid.nearest(_v.x, _v.y, _v.z, far);
        share = 1 - smooth(clamp01((dMin - near) / (far - near)));
        if (share > 0) {
          let sw = 0, sl = 0, st = 0;
          ribGrid.within(_v.x, _v.y, _v.z, dMin + blend, (c, d) => {
            const g = 1 / (d * d + 1e-6);
            sw += g; sl += g * R[c + 3]; st += g * R[c + 4];
          });
          const level = ribsOnly ? sl / sw : (e + f) * (1 - share) + (sl / sw) * share;
          e = Math.min(16, Math.floor(level));
          f = clamp01(level - e);
          t = ribsOnly ? st / sw : t * (1 - share) + (st / sw) * share;
        }
      }
      // Pelvis or column, by contact.
      let col = 1;
      if (ribsOnly) t = 1 - share * (1 - t); // off the ribs: the chest frame, whole
      else if (_v.y < pelvisTop && _v.y > Y[0] && pelvisGrid && columnGrid) {
        // (At or below level 0 the height rule already says "pelvis", whole.)
        // The ratio only matters inside its window, so the column search stops
        // at the distance where it would read "wholly the pelvis's" anyway.
        const dP = pelvisGrid.nearest(_w.x, _w.y, _w.z, 0.12);
        const dC = columnGrid.nearest(_w.x, _w.y, _w.z, dP * (1 - rLo) / rLo + 1e-4);
        const r = dP / Math.max(dP + dC, 1e-9);
        col = smooth(clamp01((r - rLo) / (rHi - rLo)));
      }
      k[i] = e;
      const o = i * 4;
      w[o] = col * (1 - t) * (1 - f);
      w[o + 1] = col * (1 - t) * f;
      w[o + 2] = col * t;
      w[o + 3] = 1 - col;
      // Fold the levels that ARE a rig frame into it: level 0 is the pelvis and
      // T1 (level 17) is the chest, exactly.
      if (e === 0) { w[o + 3] += w[o]; w[o] = 0; }
      if (e === 16) { w[o + 2] += w[o + 1]; w[o + 1] = 0; }
      if ((own === 'chest' ? w[o + 2] : w[o + 3]) < 0.98) strays++;
    }
    return strays ? { k, w, own: own === 'chest' ? F_CHEST : F_PELVIS } : null;
  }

  // The 19 trunk frames' rigid deltas since bind as dual quaternions, in
  // figure-local space (8 numbers a frame: real xyzw, dual xyzw), chained into
  // one hemisphere from the chest down so neighbours blend along the short arc.
  // `gInv` = the figure group's inverse world matrix, as updateMuscleSkin has it.
  trunkDQ(gInv) {
    this.solve();
    const V = this.vertebrae;
    const out = this._dq;
    _P.multiplyMatrices(gInv, this.figure.nodes.pelvis.matrixWorld);
    for (let e = TRUNK_FRAMES - 1; e >= 0; e--) {
      if (e === F_PELVIS) _F.identity();
      else if (e === F_CHEST) _F.copy(this.Mc).multiply(this.chestRestInv);
      else {
        const v = V[e - 1];
        _F.compose(v.p, v.q, _one).multiply(_T.makeTranslation(-v.body.x, -v.body.y, -v.body.z));
      }
      _F.premultiply(_P).multiply(this.bindInv).decompose(_tt, _tq, _ts);
      const o = e * 8;
      let s = 1;
      if (e < F_CHEST) {
        const a = o + 8;
        if (out[a] * _tq.x + out[a + 1] * _tq.y + out[a + 2] * _tq.z + out[a + 3] * _tq.w < 0) s = -1;
      }
      const x = _tq.x * s, y = _tq.y * s, z = _tq.z * s, qw = _tq.w * s;
      out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = qw;
      out[o + 4] = 0.5 * (_tt.x * qw + _tt.y * z - _tt.z * y);
      out[o + 5] = 0.5 * (-_tt.x * z + _tt.y * qw + _tt.z * x);
      out[o + 6] = 0.5 * (_tt.x * y - _tt.y * x + _tt.z * qw);
      out[o + 7] = 0.5 * (-_tt.x * x - _tt.y * y - _tt.z * z);
    }
    return out;
  }
}
