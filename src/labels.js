// Anatomy labels: named callouts on bones, muscles and joints, laid out as
// textbook MARGIN CALLOUTS — text stacked in a tidy column either side of the
// figure with a leader line to each structure — so they never overlap each
// other or the anatomy and stay readable on a slide.
//
// Labels are drawn in 2D (studio.js owns the overlay canvas and composites it
// into photo / video exports), never as 3D sprites: every size here is a
// FRACTION OF THE FRAME HEIGHT, so a label is the same relative size in the live
// view, a 1080p clip and a 4K photo — what you see is what the slide gets.
//
// A label's anchor is a material point on its structure: a joint's visible
// centre (Figure.surfacePos), or ONE VERTEX of the bone/muscle mesh, read live
// — so it rides the structure through any pose, including the CPU-skinned
// bi-articular muscles whose vertices move every frame. A clicked label anchors
// at the clicked vertex (guaranteed visible from that view); an auto label picks
// the vertex on the camera-facing side of the structure's middle.
import * as THREE from 'three';
import { JOINT_BY_NAME, BODY_PARTS, PART_OF_NODE, PART_BY_ID } from './skeletonDef.js';

// Default callout text per joint base (the anatomical joint, not "Left knee" —
// the side is visible in the picture, and the text is editable anyway).
export const JOINT_LABELS = {
  pelvis: 'Pelvis', spine: 'Lumbar spine', chest: 'Thoracic spine',
  neck: 'Cervical spine', head: 'Atlanto-occipital joint',
  scapula: 'Shoulder girdle', shoulder: 'Shoulder (glenohumeral) joint',
  elbow: 'Elbow joint', wrist: 'Wrist (radiocarpal) joint',
  hip: 'Hip joint', knee: 'Knee joint', ankle: 'Ankle (talocrural) joint',
  toes: 'MTP joints',
};

// The same joints at the SIMPLE detail level: the everyday word a dancer uses.
// Simple is a different slide, not a shorter one — "Hip", "Knee", "Foot" for a
// class, the anatomical names above for an anatomy lecture.
export const JOINT_LABELS_SIMPLE = {
  pelvis: 'Hips', spine: 'Lower back', chest: 'Upper back', neck: 'Neck',
  head: 'Head', scapula: 'Shoulder blade', shoulder: 'Shoulder', elbow: 'Elbow',
  wrist: 'Wrist', hip: 'Hip', knee: 'Knee', ankle: 'Ankle', toes: 'Toes',
};

// Callout text for atlas muscle names that read oddly once "muscle" is dropped.
const MUSCLE_TEXT = { 'Rectus abdominal': 'Rectus abdominis' };

// Kind → accent colour (the anchor dot and the pill's edge bar).
export const KIND_COLORS = { bone: '#e6d9b8', muscle: '#e0645f', joint: '#5b9bd5' };

// Second channel for the same distinction: the leader line's dash pattern, in
// multiples of its own width. On an exported slide the kind was pure hue, which
// is lost to colour-vision deficiency and to greyscale printing — bone solid,
// muscle dashed, joint dotted survives both. (Both stroke passes carry the same
// dash, so the gaps are truly empty rather than showing the halo through them.)
const KIND_DASH = { bone: [], muscle: [4, 2.6], joint: [0.1, 2.2] };

// Readable bone name from the atlas name GLTFLoader sanitised ("Rib_(10th)r",
// "Distal_phalanx_of_2d_fingerr", "Thoracic_vertebrae_(T4)"). `paired` bones
// carry a merged trailing side letter; axial ones do not — "Vomer" must keep
// its r, which is why the caller passes the flag instead of us guessing.
export function boneLabel(rawName, paired) {
  let s = rawName.replace(/_/g, ' ').trim();
  if (paired) s = s.replace(/\s*\.?[rl]$/i, '');
  s = s.replace(/\b2d\b/, '2nd').replace(/\b3d\b/, '3rd');
  let m;
  if ((m = s.match(/^Rib \((\w+)\)$/i))) return `${m[1]} rib`;
  if ((m = s.match(/^Costal cart of (\w+) rib$/i))) return `${m[1]} costal cartilage`;
  if ((m = s.match(/^(?:Cervical|Thoracic|Lumbar) vertebrae \((\w+)\)$/i))) return `${m[1]} vertebra`;
  s = s.replace(/ finger of foot$/i, ' toe');
  s = s.replace(/^(Maxilla|Mandible|Ethmoid|Navicular|Cuboid|Lunate) bone$/i, '$1');
  s = s.replace(/ Bone$/, ' bone');
  return s;
}

// Auto-labelling a whole body part must not spray 30 teeth or 56 phalanges
// across the slide: bones matching a GROUP collapse into one callout anchored
// on the group's representative, and SKIP bones are never auto-labelled (they
// stay individually clickable).
const AUTO_SKIP = /incisor|canine|molar|sesamoid|concha|lacrimal|palatine|vomer|ethmoid|sphenoid|costal_cart/i;
const AUTO_GROUPS = [
  { re: /^(?:Atlas|Axis|Cervical_vertebrae)/i, text: 'Cervical vertebrae (C1–C7)', rep: /\(C4\)/ },
  { re: /^Thoracic_vertebrae/i, text: 'Thoracic vertebrae (T1–T12)', rep: /\(T7\)/ },
  { re: /^Lumbar_vertebrae/i, text: 'Lumbar vertebrae (L1–L5)', rep: /\(L3\)/ },
  { re: /^Rib_/i, text: 'Ribs', rep: /\(6th\)/ },
  { re: /metacarpal/i, text: 'Metacarpals', rep: /^3rd/ },
  { re: /metatarsal/i, text: 'Metatarsals', rep: /^Third/ },
  { re: /phalanx.*foot/i, text: 'Phalanges (toes)', rep: /Proximal.*second/i },
  { re: /phalanx/i, text: 'Phalanges (fingers)', rep: /Proximal.*3rd/i },
  { re: /Capitate|Hamate|Lunate|Pisiform|Scaphoid|Trapez|Triquetrum/i, text: 'Carpal bones', rep: /Capitate/ },
  { re: /cuneiform|Navicular|Cuboid/i, text: 'Tarsal bones', rep: /Navicular/ },
];

const SKINNED_BOUNDS = new THREE.Sphere(new THREE.Vector3(), 10);
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();

const sideOfNode = (name) => (name && /_([LR])$/.exec(name)?.[1]) || null;
const roleOf = (figure) => figure.name.toLowerCase();

export class Labels {
  constructor(figures) {
    this.figures = figures;
    this.items = [];      // { id, kind, figure, key, text, joint?|mesh+vertex, side?, force?, temp? }
    this.visible = true;
    this.detail = 'full'; // 'full' = every bone/muscle named anatomically;
                          // 'simple' = one everyday name per body part / joint
    this.size = 0.026;    // label cap height as a fraction of the frame height
    this.frozen = null;   // Map id → { side, y } while a clip plays (see freeze)
    this.boundsPoints = null; // world points the columns must clear (a clip's whole swing)
    this.onChange = null;
    this._id = 1;
  }

  // ------------------------------------------------------------- the model
  #emit() { if (this.onChange) this.onChange(); }

  get list() { return this.items.filter((l) => !l.temp); }

  find(key) { return this.items.find((l) => l.key === key) || null; }

  #add(item) {
    const label = { id: this._id++, force: null, temp: false, ...item };
    this.items.push(label);
    this.#emit();
    return label;
  }

  remove(id) {
    const i = this.items.findIndex((l) => l.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.#emit();
    return true;
  }

  clear({ temp = false } = {}) {
    this.items = this.items.filter((l) => (temp ? !l.temp : l.temp));
    this.#emit();
  }

  setText(id, text) {
    const l = this.items.find((x) => x.id === id);
    if (l) l.text = text;
  }

  // 'simple' | 'full' — how much anatomy a new label names. Existing callouts
  // keep the text they were given (it is editable), so switching is safe.
  setDetail(detail) {
    this.detail = detail === 'simple' ? 'simple' : 'full';
    this.#emit();
  }

  get simple() { return this.detail === 'simple'; }

  // Default callout text for a joint at the current detail level.
  jointText(jointName) {
    const base = jointName.replace(/_[LR]$/, '');
    return (this.simple ? JOINT_LABELS_SIMPLE[base] : null) ?? JOINT_LABELS[base] ?? jointName;
  }

  // At Simple detail a bone or muscle is named by the BODY PART it belongs to
  // ("Foot", "Arm"), and the callout hangs on that part's representative joint
  // — so clicking around a foot yields one "Foot" callout, not eight tarsals.
  #partOfNode(nodeName) {
    const part = PART_BY_ID[PART_OF_NODE[nodeName]];
    return part?.rep ? part : null;
  }

  // Force a label into the other column (null = automatic).
  flip(id, currentSide) {
    const l = this.items.find((x) => x.id === id);
    if (!l) return;
    l.force = (l.force ?? currentSide) === 'left' ? 'right' : 'left';
    this.#emit();
  }

  addJoint(figure, jointName, { text, temp = false } = {}) {
    const def = JOINT_BY_NAME[jointName];
    if (!def) return null;
    if (def.endpoint) jointName = def.parent;
    const key = `${roleOf(figure)}|joint|${jointName}`;
    const had = this.find(key);
    if (had) return had;
    return this.#add({
      kind: 'joint', figure, key, joint: jointName, side: sideOfNode(jointName),
      text: text ?? this.jointText(jointName), temp,
    });
  }

  // `vertex` omitted → the camera-facing middle of the structure (needs camera).
  addBone(figure, mesh, range, { vertex, text, camera, temp = false } = {}) {
    const side = range.side ?? sideOfNode(this.#nodeName(mesh));
    const key = `${roleOf(figure)}|bone|${range.name}|${side ?? 'C'}`;
    const had = this.find(key);
    if (had) return had;
    return this.#add({
      kind: 'bone', figure, key, mesh, side, name: range.name,
      vertex: vertex ?? this.#facingVertex(mesh, range.start, range.count, camera),
      text: text ?? boneLabel(range.name, !!range.side), temp,
    });
  }

  addMuscle(figure, mesh, { vertex, text, camera, temp = false } = {}) {
    const name = mesh.userData.muscleName;
    const side = mesh.userData.muscleSide ?? null;
    const key = `${roleOf(figure)}|muscle|${name}|${side ?? 'C'}${temp ? '|clip' : ''}`;
    const had = this.find(key);
    if (had) return had;
    const count = mesh.geometry.attributes.position.count;
    return this.#add({
      kind: 'muscle', figure, key, mesh, side, name,
      vertex: vertex ?? this.#facingVertex(mesh, 0, count, camera),
      text: text ?? MUSCLE_TEXT[name] ?? name, temp,
    });
  }

  // Label a structure by NAME (the scriptable path): a joint name, a muscle's
  // atlas label, or a bone's readable/atlas name. `side` picks L/R where the
  // structure is paired (default: whichever copy is found first).
  addByName(figure, kind, name, side = null, opts = {}) {
    if (kind === 'joint') return this.addJoint(figure, name, opts);
    if (kind === 'muscle') {
      const mesh = this.muscleMesh(figure, name, side);
      return mesh ? this.addMuscle(figure, mesh, opts) : null;
    }
    const want = name.toLowerCase();
    for (const mesh of figure.layerMeshes.skeleton) {
      for (const range of mesh.userData.boneRanges ?? []) {
        const s = range.side ?? sideOfNode(this.#nodeName(mesh));
        if (side && s !== side) continue;
        if (range.name.toLowerCase() === want || boneLabel(range.name, !!range.side).toLowerCase() === want) {
          return this.addBone(figure, mesh, range, opts);
        }
      }
    }
    return null;
  }

  // A muscle mesh of `figure` by atlas label (+ side).
  muscleMesh(figure, name, side = null) {
    return figure.layerMeshes.muscle.find((m) => m.userData.isMuscle
      && m.userData.muscleName === name && (!side || m.userData.muscleSide === side)) || null;
  }

  // The joint a mesh hangs from (rig and atlas nodes both carry jointName).
  #nodeName(mesh) {
    for (let n = mesh.parent; n; n = n.parent) {
      if (n.userData?.jointName !== undefined) return n.userData.jointName;
    }
    return null;
  }

  #vertexWorld(mesh, i, out) {
    return mesh.localToWorld(out.fromBufferAttribute(mesh.geometry.attributes.position, i));
  }

  // The sampled vertex nearest the point one radius toward the camera from the
  // structure's centroid: on the visible side, near the middle.
  #facingVertex(mesh, start, count, camera) {
    const step = Math.max(1, Math.floor(count / 240));
    _c.set(0, 0, 0);
    let n = 0;
    for (let i = start; i < start + count; i += step, n++) _c.add(this.#vertexWorld(mesh, i, _v));
    _c.multiplyScalar(1 / Math.max(n, 1));
    let r = 0;
    for (let i = start; i < start + count; i += step) {
      r = Math.max(r, this.#vertexWorld(mesh, i, _v).distanceTo(_c));
    }
    if (camera) _t.copy(camera.position).sub(_c).normalize().multiplyScalar(r).add(_c);
    else _t.copy(_c);
    let best = start;
    let bestD = Infinity;
    for (let i = start; i < start + count; i += step) {
      const d = this.#vertexWorld(mesh, i, _v).distanceToSquared(_t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  anchorWorld(label, out = new THREE.Vector3()) {
    if (label.kind === 'joint') return label.figure.surfacePos(label.joint, out);
    return this.#vertexWorld(label.mesh, label.vertex, out);
  }

  isShown(label) {
    if (!label.figure.group.visible) return false;
    if (label.kind === 'joint') return true;
    if (!label.mesh.visible) return false;
    return !(label.kind === 'muscle' && label.figure.hiddenMuscles?.has(label.name));
  }

  // ------------------------------------------------------------- picking
  // What a ray would label: { kind, figure, text, toggle() } or null. `filter`
  // is 'auto' | 'bone' | 'muscle' | 'joint'. In 'auto' a joint wins only when the
  // ray passes close to its centre (a deliberate aim) — the pick spheres sit
  // INSIDE the bone ends, so a plain nearest-hit would never let a joint win and
  // a plain sphere-first would make every bone end unclickable.
  pick(raycaster, figures, filter = 'auto', camera = null) {
    let jointHit = null;
    if (filter === 'auto' || filter === 'joint') {
      const spheres = figures.flatMap((f) => f.pickSpheres);
      const hit = raycaster.intersectObjects(spheres, false)[0];
      if (hit) {
        const s = hit.object;
        const radius = (s.geometry.parameters?.radius ?? 0.02) * s.getWorldScale(_v).x;
        const miss = raycaster.ray.distanceToPoint(s.getWorldPosition(_v));
        if (filter === 'joint' || miss < radius * 0.6) jointHit = hit;
      }
    }
    let meshHit = null;
    if (filter !== 'joint') {
      const meshes = [];
      for (const f of figures) {
        if (filter !== 'muscle') meshes.push(...f.layerMeshes.skeleton.filter((m) => m.visible && m.userData.boneRanges));
        if (filter !== 'bone') {
          for (const m of f.layerMeshes.muscle) {
            if (!m.visible || !m.userData.isMuscle || f.hiddenMuscles?.has(m.userData.muscleName)) continue;
            // A skinned belly's vertices leave its bind-pose bounds as the joints
            // move; give it bounds a ray can never miss so picking tests triangles.
            if (m.userData.skinNode !== undefined) m.geometry.boundingSphere = SKINNED_BOUNDS;
            meshes.push(m);
          }
        }
      }
      meshHit = raycaster.intersectObjects(meshes, false)[0] || null;
    }
    const figureOf = (o) => {
      for (let n = o; n; n = n.parent) if (n.userData.figure) return n.userData.figure;
      return figures.find((f) => { let p = o; while (p && p !== f.group) p = p.parent; return !!p; });
    };

    if (jointHit) {
      const { figure, jointName } = jointHit.object.userData;
      const def = JOINT_BY_NAME[jointName];
      return this.#jointPick(figure, def.endpoint ? def.parent : jointName);
    }
    if (!meshHit) return null;
    const mesh = meshHit.object;
    const figure = figureOf(mesh);
    if (!figure) return null;
    const vertex = meshHit.face.a;
    // Simple detail: whatever was clicked, name its body part.
    if (this.simple) {
      const part = this.#partOfNode(mesh.userData.skinNode ?? this.#nodeName(mesh));
      if (part) return this.#jointPick(figure, part.rep, part.short);
    }
    if (mesh.userData.isMuscle) {
      const key = `${roleOf(figure)}|muscle|${mesh.userData.muscleName}|${mesh.userData.muscleSide ?? 'C'}`;
      const had = this.find(key);
      return {
        kind: 'muscle', figure, existing: had,
        text: had?.text ?? MUSCLE_TEXT[mesh.userData.muscleName] ?? mesh.userData.muscleName,
        toggle: () => (had ? (this.remove(had.id), null) : this.addMuscle(figure, mesh, { vertex, camera })),
      };
    }
    const range = mesh.userData.boneRanges.find((r) => vertex >= r.start && vertex < r.start + r.count);
    if (!range) return null;
    const side = range.side ?? sideOfNode(this.#nodeName(mesh));
    const had = this.find(`${roleOf(figure)}|bone|${range.name}|${side ?? 'C'}`);
    return {
      kind: 'bone', figure, existing: had, text: had?.text ?? boneLabel(range.name, !!range.side),
      toggle: () => (had ? (this.remove(had.id), null) : this.addBone(figure, mesh, range, { vertex, camera })),
    };
  }

  // What a click on `joint` would do — shared by a joint hit and, at Simple
  // detail, by a bone/muscle hit resolved to its body part.
  #jointPick(figure, joint, text = null) {
    const had = this.find(`${roleOf(figure)}|joint|${joint}`);
    return {
      kind: 'joint', figure, existing: had,
      text: had?.text ?? text ?? this.jointText(joint),
      toggle: () => (had ? (this.remove(had.id), null) : this.addJoint(figure, joint, { text })),
    };
  }

  // ---------------------------------------------------- label the highlight
  // Name everything the current highlight picks out on `figure`: the bones and
  // muscles of its highlighted body parts, plus any muscles lit in the Muscles
  // panel. Bones collapse per AUTO_GROUPS; a structure present on both sides of
  // a central part (ribs, the abdominal wall) is named once, on the side facing
  // the camera. Returns how many labels were added.
  labelHighlighted(figure, camera) {
    const before = this.items.length;
    const parts = figure.highlightParts;
    const nodes = new Set();
    if (parts) for (const p of BODY_PARTS) if (parts.has(p.id)) p.nodes.forEach((n) => nodes.add(n));
    // Of a paired structure's two copies keep the one nearer the camera — and
    // when the view is square-on and they tie, alternate, so a front view fills
    // both callout columns instead of stacking everything on one side.
    let flip = false;
    const nearer = (a, b) => {
      const da = this.#centroidDist(a, camera);
      const db = this.#centroidDist(b, camera);
      if (Math.abs(da - db) > 0.03 * Math.max(da, db)) return da <= db ? a : b;
      flip = !flip;
      return flip ? a : b;
    };

    // Simple detail: one everyday callout per highlighted part, in any layer
    // (the individual bones are exactly what this level is not naming). Muscles
    // lit by hand in the Muscles panel are still named — they have no plainer
    // name, and lighting one is already a deliberate pick.
    if (this.simple) {
      for (const p of BODY_PARTS) if (parts?.has(p.id) && p.rep) this.addJoint(figure, p.rep, { text: p.short });
      const lit = figure.litMuscles;
      if (figure.layers?.muscle && lit) {
        const picked = new Map();
        for (const mesh of figure.layerMeshes.muscle) {
          const name = mesh.userData.muscleName;
          if (!mesh.userData.isMuscle || figure.hiddenMuscles?.has(name)) continue;
          if (!lit.has(name) && !lit.has(`${name}|${mesh.userData.muscleSide}`)) continue;
          const cand = { mesh, range: { start: 0, count: mesh.geometry.attributes.position.count } };
          const had = picked.get(name);
          picked.set(name, had ? nearer(had, cand) : cand);
        }
        for (const { mesh } of picked.values()) this.addMuscle(figure, mesh, { camera });
      }
      return this.items.length - before;
    }

    if (figure.layers?.skeleton && nodes.size) {
      const picked = new Map(); // dedupe key → { mesh, range, text }
      for (const mesh of figure.layerMeshes.skeleton) {
        const ranges = mesh.userData.boneRanges;
        if (!ranges || !nodes.has(this.#nodeName(mesh))) continue;
        for (const range of ranges) {
          if (AUTO_SKIP.test(range.name)) continue;
          const group = AUTO_GROUPS.find((g) => g.re.test(range.name));
          if (group && !group.rep.test(range.name)) continue;
          const text = group ? group.text : boneLabel(range.name, !!range.side);
          // Limb meshes are per side (both wanted if both parts are lit); a
          // central mesh holds both copies of a paired bone — keep the nearer.
          const limbSide = sideOfNode(this.#nodeName(mesh));
          const key = `${text}|${limbSide ?? ''}`;
          const cand = { mesh, range, text };
          const had = picked.get(key);
          picked.set(key, had ? nearer(had, cand) : cand);
        }
      }
      for (const { mesh, range, text } of picked.values()) this.addBone(figure, mesh, range, { text, camera });
    }

    if (figure.layers?.muscle) {
      const lit = figure.litMuscles;
      const picked = new Map();
      for (const mesh of figure.layerMeshes.muscle) {
        if (!mesh.userData.isMuscle || figure.hiddenMuscles?.has(mesh.userData.muscleName)) continue;
        const name = mesh.userData.muscleName;
        const side = mesh.userData.muscleSide;
        const node = mesh.userData.skinNode ?? this.#nodeName(mesh);
        const byLit = lit && (lit.has(name) || lit.has(`${name}|${side}`));
        const byPart = nodes.has(node);
        if (!byLit && !byPart) continue;
        // One per side when the part itself is sided; otherwise the nearer copy.
        const key = `${name}|${byPart && sideOfNode(node) ? side : ''}`;
        const cand = { mesh, range: { start: 0, count: mesh.geometry.attributes.position.count } };
        const had = picked.get(key);
        picked.set(key, had ? nearer(had, cand) : cand);
      }
      for (const { mesh } of picked.values()) this.addMuscle(figure, mesh, { camera });
    }

    if (nodes.size && !figure.layers?.skeleton && !figure.layers?.muscle) {
      // Body view shows no separate structures — name the part's joints instead.
      for (const n of nodes) if (JOINT_BY_NAME[n] && !JOINT_BY_NAME[n].endpoint) this.addJoint(figure, n);
    }
    return this.items.length - before;
  }

  #centroidDist({ mesh, range }, camera) {
    if (!camera) return 0;
    const step = Math.max(1, Math.floor(range.count / 40));
    _c.set(0, 0, 0);
    let n = 0;
    for (let i = range.start; i < range.start + range.count; i += step, n++) _c.add(this.#vertexWorld(mesh, i, _v));
    return _c.multiplyScalar(1 / Math.max(n, 1)).distanceTo(camera.position);
  }

  // ------------------------------------------------------------ persistence
  toJSON() {
    return this.list.map((l) => ({
      fig: roleOf(l.figure), kind: l.kind, text: l.text, force: l.force,
      joint: l.joint, name: l.name, side: l.side, vertex: l.vertex,
    }));
  }

  fromJSON(rows) {
    for (const r of rows || []) {
      const figure = this.figures.find((f) => roleOf(f) === r.fig);
      if (!figure) continue;
      let label = null;
      if (r.kind === 'joint') label = this.addJoint(figure, r.joint, { text: r.text });
      else if (r.kind === 'muscle') {
        const mesh = this.muscleMesh(figure, r.name, r.side);
        if (mesh) label = this.addMuscle(figure, mesh, { vertex: r.vertex, text: r.text });
      } else if (r.kind === 'bone') {
        for (const mesh of figure.layerMeshes.skeleton) {
          const range = mesh.userData.boneRanges?.find((x) => x.name === r.name
            && (x.side ?? sideOfNode(this.#nodeName(mesh))) === (r.side ?? null));
          if (range) { label = this.addBone(figure, mesh, range, { vertex: r.vertex, text: r.text }); break; }
        }
      }
      if (label && r.force) label.force = r.force;
    }
  }

  // ------------------------------------------------------- layout + drawing
  // Hold every label's column and height where they are now, so text stays put
  // while a clip plays and only the leader lines follow the moving anatomy
  // (labels that re-stack every frame jitter and swap places on video).
  freeze(layout) {
    this.frozen = new Map(layout.map((p) => [p.label.id, { side: p.side, y: p.yFrac }]));
  }

  unfreeze() { this.frozen = null; }

  // Screen-space horizontal extent of the visible figures' joints, in px.
  figureBounds(camera, w, h) {
    let l = Infinity;
    let r = -Infinity;
    for (const p of this.boundsPoints ?? []) {
      _v.copy(p).project(camera);
      if (_v.z > 1) continue;
      l = Math.min(l, (_v.x * 0.5 + 0.5) * w);
      r = Math.max(r, (_v.x * 0.5 + 0.5) * w);
    }
    for (const f of this.boundsPoints ? [] : this.figures) {
      if (!f.group.visible) continue;
      for (const name of Object.keys(f.nodes)) {
        f.surfacePos(name, _v).project(camera);
        if (_v.z > 1) continue;
        const x = (_v.x * 0.5 + 0.5) * w;
        l = Math.min(l, x);
        r = Math.max(r, x);
      }
    }
    if (!(l < r)) return { l: w * 0.35, r: w * 0.65 };
    return { l: Math.max(l, 0), r: Math.min(r, w), h };
  }

  // Place every shown label: returns [{ label, side, x, y, yFrac, ax, ay, w }].
  // `top` reserves room for the clip title. All px.
  layout(ctx, camera, w, h, { top = 0, right = 0 } = {}) {
    const font = this.size * h;
    const rowH = font * 1.75;
    const pad = font * 0.9;
    ctx.font = `600 ${font}px "Segoe UI", system-ui, sans-serif`;

    const placed = [];
    for (const label of this.items) {
      if (!this.isShown(label)) continue;
      this.anchorWorld(label, _v).project(camera);
      if (_v.z > 1 || Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05) continue;
      placed.push({
        label,
        ax: (_v.x * 0.5 + 0.5) * w,
        ay: (-_v.y * 0.5 + 0.5) * h,
        w: ctx.measureText(label.text).width + font * 1.3,
      });
    }
    if (!placed.length) return placed;

    const b = this.figureBounds(camera, w, h);
    const mid = (b.l + b.r) / 2;
    const wUse = w - right; // `right` px are covered (the sidebar, in window frame)
    const slots = Math.max(1, Math.floor((h - top - pad * 2) / rowH));
    for (const p of placed) {
      const fz = this.frozen?.get(p.label.id);
      p.side = fz?.side ?? p.label.force ?? (p.ax < mid ? 'left' : 'right');
      p.fixedY = fz ? fz.y * h : null;
    }
    // Structures on the midline (spine, sternum) belong to neither column: deal
    // them to whichever is shorter, so the two stay balanced.
    const central = placed.filter((p) => p.fixedY === null && !p.label.force
      && Math.abs(p.ax - mid) < (b.r - b.l) * 0.1);
    for (const p of central) p.side = null;
    for (const p of central) {
      const nL = placed.filter((o) => o.side === 'left').length;
      const nR = placed.filter((o) => o.side === 'right').length;
      p.side = nL <= nR ? 'left' : 'right';
    }
    // A column that overflows hands its most central labels to the other side.
    for (const [from, to] of [['left', 'right'], ['right', 'left']]) {
      const col = placed.filter((p) => p.side === from && p.fixedY === null && !p.label.force);
      const room = slots - placed.filter((p) => p.side === from).length;
      if (room >= 0) continue;
      col.sort((a, c) => Math.abs(a.ax - mid) - Math.abs(c.ax - mid));
      for (const p of col.slice(0, -room)) p.side = to;
    }

    const gap = font * 2.2;
    for (const side of ['left', 'right']) {
      const col = placed.filter((p) => p.side === side);
      if (!col.length) continue;
      const maxW = Math.max(...col.map((p) => p.w));
      // The column hugs the figure, not the frame edge (short leaders read
      // better on a wide slide) — clamped so the text always fits in frame.
      const x = side === 'left'
        ? Math.max(b.l - gap, maxW + pad)
        : Math.min(b.r + gap, wUse - maxW - pad);
      col.sort((a, c) => (a.fixedY ?? a.ay) - (c.fixedY ?? c.ay));
      // Sorted by anchor height, so leaders fan out without crossing; then push
      // apart to one row each, and slide the stack back inside the frame.
      let y = top + pad + rowH / 2;
      for (const p of col) {
        p.y = p.fixedY ?? Math.max(p.ay, y);
        if (p.fixedY === null) y = p.y + rowH;
      }
      const free = col.filter((p) => p.fixedY === null);
      const over = free.length ? free[free.length - 1].y - (h - pad - rowH / 2) : 0;
      if (over > 0) {
        let limit = h - pad - rowH / 2;
        for (let i = free.length - 1; i >= 0; i--) {
          free[i].y = Math.min(free[i].y, limit);
          limit = free[i].y - rowH;
        }
      }
      for (const p of col) p.x = x;
      // Uncross: sorting by anchor height only keeps leaders apart when the
      // anchors share an x. Where two still cross, swapping their rows always
      // untangles that pair; a few passes settle the column.
      const stub = (side === 'left' ? 1 : -1) * font * 1.15;
      const cross = (p, q) => {
        const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const [x1, y1, x2, y2] = [p.x + stub, p.y, p.ax, p.ay];
        const [x3, y3, x4, y4] = [q.x + stub, q.y, q.ax, q.ay];
        return d(x1, y1, x2, y2, x3, y3) * d(x1, y1, x2, y2, x4, y4) < 0
          && d(x3, y3, x4, y4, x1, y1) * d(x3, y3, x4, y4, x2, y2) < 0;
      };
      for (let pass = 0; pass < 6; pass++) {
        let swapped = false;
        for (let i = 0; i < free.length; i++) {
          for (let j = i + 1; j < free.length; j++) {
            if (!cross(free[i], free[j])) continue;
            [free[i].y, free[j].y] = [free[j].y, free[i].y];
            swapped = true;
          }
        }
        if (!swapped) break;
      }
      for (const p of col) p.yFrac = p.y / h;
    }
    return placed;
  }

  // `theme`: { text, pill, edge, line } colours for the current backdrop.
  draw(ctx, camera, w, h, theme, opts = {}) {
    if (!this.visible) return [];
    const placed = this.layout(ctx, camera, w, h, opts);
    const font = this.size * h;
    const lineW = Math.max(1.5, font * 0.085);
    ctx.font = `600 ${font}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = ctx.lineCap = 'round';

    // Leaders first, so a pill always sits over any line that passes behind it.
    for (const p of placed) {
      const dir = p.side === 'left' ? 1 : -1;
      const x0 = p.x + dir * font * 0.25;
      const x1 = x0 + dir * font * 0.9;
      const dash = KIND_DASH[p.label.kind] ?? [];
      ctx.setLineDash(dash.map((d) => d * lineW));
      for (const [color, width] of [[theme.halo, lineW * 2.6], [theme.line, lineW]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x0, p.y);
        ctx.lineTo(x1, p.y);
        ctx.lineTo(p.ax, p.ay);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = theme.halo;
      ctx.beginPath(); ctx.arc(p.ax, p.ay, font * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = KIND_COLORS[p.label.kind];
      ctx.beginPath(); ctx.arc(p.ax, p.ay, font * 0.2, 0, Math.PI * 2); ctx.fill();
    }
    for (const p of placed) drawPill(ctx, p.label.text, p.x, p.y, font, theme, {
      align: p.side === 'left' ? 'right' : 'left', accent: KIND_COLORS[p.label.kind],
    });
    return placed;
  }
}

// A rounded text pill. `align` says which edge sits at x ('left' | 'right' |
// 'center'); `accent` paints a thin bar on the edge facing the leader line.
export function drawPill(ctx, text, x, y, font, theme, { align = 'left', accent = null, weight = 600 } = {}) {
  ctx.font = `${weight} ${font}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const padX = font * 0.55;
  const tw = ctx.measureText(text).width;
  const bw = tw + padX * 2;
  const bh = font * 1.5;
  const left = align === 'left' ? x : align === 'right' ? x - bw : x - bw / 2;
  ctx.fillStyle = theme.pill;
  ctx.beginPath();
  ctx.roundRect(left, y - bh / 2, bw, bh, bh * 0.28);
  ctx.fill();
  if (theme.edge) {
    ctx.strokeStyle = theme.edge;
    ctx.lineWidth = Math.max(1, font * 0.04);
    ctx.stroke();
  }
  if (accent) {
    const bar = font * 0.16;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(align === 'right' ? left + bw - bar : left, y - bh / 2, bar, bh, bar / 2);
    ctx.fill();
  }
  ctx.fillStyle = theme.text;
  ctx.textAlign = 'left';
  ctx.fillText(text, left + padX, y + font * 0.04);
  return { left, width: bw, height: bh };
}
