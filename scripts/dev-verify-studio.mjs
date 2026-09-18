// Dev check for the presentation studio (src/studio.js, labels.js, movements.js):
//   labels  — scripted + REAL pointer-click authoring (click a bone → callout,
//             click again → gone), "label highlighted" grouping, margin layout
//             (rows never overlap, every pill inside the frame), the labels
//             actually land in the exported photo, localStorage persistence;
//   frame   — the 16:9 slide frame renders at exactly 1920×1080, 2× photo = 4K;
//   clips   — EVERY row of the MOVEMENTS table moves the way its name says, on
//             BOTH sides (measured on the posed figure: "pronation" must turn the
//             visible palm down, "inversion" must turn the sole toward the
//             midline …) — the table is sign conventions all the way down, and a
//             flipped sign is a wrong anatomy slide, so this is the real gate;
//             the angle readout matches the table's range; a clip ends on its
//             starting pose (seamless loop); callouts hold still while it plays;
//             the hidden partner is never shoved; exiting restores the couple,
//             camera, frame and visibility; ⏺ produces a non-trivial MP4.
// Honours DEV_URL (default http://localhost:5173) and BROWSER_PATH (default
// Edge; an isolated profile is used, so it runs alongside an open browser).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = process.argv[2] || '.';
fs.mkdirSync(outDir, { recursive: true });
const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tangle-verify-')),
  args: ['--window-size=1500,950'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setLayer = (v) => page.evaluate((val) => {
  const el = document.getElementById('layer-mode');
  el.value = val;
  el.dispatchEvent(new Event('change'));
}, v);
const savePhoto = async (name, scale = 1) => {
  const url = await page.evaluate((s) => window.__app.photoDataURL(s), scale);
  fs.writeFileSync(path.join(outDir, name), Buffer.from(url.split(',')[1], 'base64'));
};

// ------------------------------------------------------------------ labels
await page.evaluate(() => {
  const app = window.__app;
  localStorage.removeItem('tangoPoseStudio.labels.v1');
  app.applyPreset(0);
  app.setVisibleFigures('leader');
  app.leader.group.position.set(0, 0, 0);
  app.setView('front');
  app.clearLabels();
});
await setLayer('skeleton');
await sleep(400);

const scripted = await page.evaluate(() => {
  const app = window.__app;
  const made = [
    app.addLabel(app.leader, 'bone', 'Femur', 'R'),
    app.addLabel(app.leader, 'bone', 'Tibia', 'L'),
    app.addLabel(app.leader, 'bone', 'Vomer'),
    app.addLabel(app.leader, 'joint', 'knee_L'),
    app.addLabel(app.leader, 'joint', 'hand_R'), // an endpoint → its parent joint
  ];
  return { texts: made.map((l) => l && l.text), n: app.labels.list.length };
});
console.log('--- scripted labels:', JSON.stringify(scripted));
if (scripted.n !== 5) problems.push(`expected 5 scripted labels, got ${scripted.n}`);
if (scripted.texts[0] !== 'Femur' || scripted.texts[1] !== 'Tibia') problems.push('bone label text wrong');
if (scripted.texts[2] !== 'Vomer') problems.push(`an unpaired bone lost its trailing r: "${scripted.texts[2]}"`);
if (!/Wrist/.test(scripted.texts[4] || '')) problems.push('endpoint joint label did not resolve to its parent joint');

// Real pointer authoring: Label mode, click the right humerus, click it again.
await page.evaluate(() => document.querySelector('[data-mode="label"]').click());
const humerus = await page.evaluate(() => {
  const app = window.__app;
  const f = app.leader;
  for (const mesh of f.layerMeshes.skeleton) {
    const r = mesh.userData.boneRanges?.find((x) => /^Humerus/.test(x.name) && x.side === 'R');
    if (!r) continue;
    // A vertex on the camera-facing side of the shaft's middle.
    const pos = mesh.geometry.attributes.position;
    const v = app.leader.group.position.clone();
    let best = null;
    const c = v.clone().set(0, 0, 0);
    for (let i = r.start; i < r.start + r.count; i += 7) c.add(mesh.localToWorld(v.fromBufferAttribute(pos, i).clone()));
    c.multiplyScalar(1 / Math.ceil(r.count / 7));
    for (let i = r.start; i < r.start + r.count; i += 3) {
      const w = mesh.localToWorld(v.fromBufferAttribute(pos, i).clone());
      if (Math.abs(w.y - c.y) > 0.02) continue;
      if (!best || w.z > best.z) best = w;
    }
    best.project(app.camera);
    const rect = app.renderer.domElement.getBoundingClientRect();
    return [rect.left + (best.x * 0.5 + 0.5) * rect.width, rect.top + (-best.y * 0.5 + 0.5) * rect.height];
  }
  return null;
});
await page.mouse.move(humerus[0], humerus[1]);
await sleep(150);
const hoverText = await page.evaluate(() => window.__app.studio.hover?.text);
await page.mouse.click(humerus[0], humerus[1]);
await sleep(150);
const afterClick = await page.evaluate(() => window.__app.labels.list.map((l) => `${l.kind}:${l.text}:${l.side}`));
await page.mouse.click(humerus[0], humerus[1]);
await sleep(150);
const afterSecond = await page.evaluate(() => window.__app.labels.list.length);
console.log(`--- click-to-label: hover "${hoverText}", after click ${JSON.stringify(afterClick.slice(-1))}, after 2nd click n=${afterSecond}`);
if (hoverText !== 'Humerus') problems.push(`label-mode hover preview says "${hoverText}", want "Humerus"`);
if (!afterClick.includes('bone:Humerus:R')) problems.push('clicking the humerus did not label it');
if (afterSecond !== 5) problems.push('clicking a labelled bone again did not remove its label');
await page.evaluate(() => document.querySelector('[data-mode="rotate"]').click());

// Label highlighted: a whole body part, small bones grouped.
const auto = await page.evaluate(() => {
  const app = window.__app;
  app.clearLabels();
  app.setHighlight(new Set(['torso', 'head', 'arm_L', 'leg_R', 'foot_R', 'pelvis']));
  const n = app.labelHighlighted();
  const texts = app.labels.list.map((l) => l.text);
  app.setHighlight(new Set());
  return { n, texts };
});
console.log(`--- label highlighted: ${auto.n} labels`);
for (const want of ['Ribs', 'Femur', 'Humerus', 'Carpal bones', 'Sacrum', 'Mandible', 'Tarsal bones']) {
  if (!auto.texts.includes(want)) problems.push(`"Label highlighted" missed ${want}`);
}
if (auto.texts.filter((t) => t === 'Ribs').length !== 1) problems.push('ribs were not collapsed into one callout');
if (auto.texts.some((t) => /incisor|molar|rib$/i.test(t))) problems.push('auto-label sprayed teeth / single ribs');
if (auto.n > 45) problems.push(`auto-label produced ${auto.n} callouts — too many to read`);

// Simple detail: everyday names, ONE callout per highlighted body part in any
// layer, and a clicked bone named by the part it belongs to ("Leg", not "Femur").
const simple = await page.evaluate(() => {
  const app = window.__app;
  const parts = new Set(['torso', 'head', 'foot_R', 'arm_L']);
  app.clearLabels();
  app.setLabelDetail('simple');
  const joint = app.addLabel(app.leader, 'joint', 'knee_L')?.text;
  app.setHighlight(parts);
  const n = app.labelHighlighted();
  const texts = app.labels.list.map((l) => `${l.kind}:${l.text}`);
  // A bone pick resolves to its part, in whatever layer.
  let bonePick = null;
  for (const mesh of app.leader.layerMeshes.skeleton) {
    const r = mesh.userData.boneRanges?.find((x) => /^Femur/.test(x.name));
    if (!r) continue;
    const node = app.labels.pick({ // a hand-made "hit": labels.pick only needs the ray
      intersectObjects: (objs) => (objs.includes(mesh) ? [{ object: mesh, face: { a: r.start } }] : []),
      ray: { distanceToPoint: () => 1e9 },
    }, [app.leader], 'bone', app.camera);
    bonePick = node && `${node.kind}:${node.text}`;
    break;
  }
  app.setLabelDetail('full');
  app.setHighlight(new Set());
  app.clearLabels();
  return { joint, n, texts, bonePick };
});
console.log(`--- simple detail: joint "${simple.joint}", ${simple.n} part labels ${JSON.stringify(simple.texts)}, femur → ${simple.bonePick}`);
if (simple.joint !== 'Knee') problems.push(`simple joint label reads "${simple.joint}", want "Knee"`);
for (const want of ['joint:Torso', 'joint:Head', 'joint:Foot', 'joint:Arm']) {
  if (!simple.texts.includes(want)) problems.push(`simple "Label highlighted" missed ${want}`);
}
if (simple.texts.some((t) => /^bone:/.test(t))) problems.push('simple detail named individual bones');
if (simple.n !== 4) problems.push(`simple detail made ${simple.n} callouts for 4 parts`);
if (simple.bonePick !== 'joint:Leg') problems.push(`clicking the femur at simple detail gives ${simple.bonePick}, want joint:Leg`);

// Highlight colours: each part lights in its OWN colour, recolouring one part
// leaves the others alone, and the two sides of a muscle belly are independent
// (they used to share one material, so lighting one leg lit both).
const colors = await page.evaluate(async () => {
  const app = window.__app;
  const litHexes = () => {
    const out = {};
    app.leader.group.traverse((o) => {
      if (!o.isMesh || o.userData.isPick || !o.visible || !o.material?.emissive) return;
      const hex = `#${o.material.emissive.getHexString()}`;
      if (hex === '#000000') return;
      let name = null;
      for (let n = o; n && !name; n = n.parent) if (n.userData?.jointName) name = n.userData.jointName;
      (out[hex] ??= []).push(name);
    });
    return out;
  };
  const defaultBefore = app.highlightColor('arm_L');
  app.setHighlight(new Set(['head', 'arm_L', 'foot_R']));
  const before = Object.keys(litHexes());
  app.setHighlightColor('arm_L', '#ff00ff');
  const after = Object.keys(litHexes());
  const armHex = Object.entries(litHexes()).find(([, ns]) => ns.some((n) => n === 'elbow_L'))?.[0];
  const headHex = Object.entries(litHexes()).find(([, ns]) => ns.some((n) => n === 'head'))?.[0];
  // Muscle layer: lighting one leg must not light the other.
  document.getElementById('layer-mode').value = 'muscle';
  document.getElementById('layer-mode').dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 300));
  app.setHighlight(new Set(['leg_L']));
  const sides = {};
  for (const m of app.leader.layerMeshes.muscle) {
    if (!m.userData.isMuscle || (m.userData.skinNode ?? '').slice(0, 3) !== 'hip') continue;
    sides[m.userData.muscleSide] = `#${m.material.emissive.getHexString()}`;
  }
  app.setHighlightColor('arm_L', null);
  app.setHighlight(new Set());
  return { before, after, armHex, headHex, sides, defaultBefore, defaultArm: app.highlightColor('arm_L') };
});
console.log(`--- highlight colours: ${JSON.stringify(colors)}`);
if (colors.before.length !== 3) problems.push(`3 lit parts share ${colors.before.length} colour(s) — they must differ`);
if (colors.armHex !== '#ff00ff') problems.push(`recolouring the left arm gave ${colors.armHex}`);
if (colors.headHex === '#ff00ff') problems.push('recolouring one part changed another');
if (colors.sides.L === '#000000' || colors.sides.L === colors.sides.R) {
  problems.push(`lighting the left leg lit the right leg's muscles too (L ${colors.sides.L}, R ${colors.sides.R})`);
}
if (colors.defaultArm !== colors.defaultBefore) problems.push(`clearing a part's colour did not restore its default (${colors.defaultArm} vs ${colors.defaultBefore})`);
await setLayer('skeleton');
await sleep(300);

// Restore the detailed label set the layout checks below measure.
await page.evaluate(() => {
  const app = window.__app;
  app.clearLabels();
  app.setHighlight(new Set(['torso', 'head', 'arm_L', 'leg_R', 'foot_R', 'pelvis']));
  app.labelHighlighted();
  app.setHighlight(new Set());
});

// Layout, in the slide frame: one row each, inside the frame, leaders uncrossed.
await page.evaluate(() => { window.__app.setFrame('slide'); window.__app.setBackdrop('light'); });
await sleep(500);
const layout = await page.evaluate(() => {
  const app = window.__app;
  const gl = app.renderer.domElement;
  const lay = app.studio.lastLayout;
  const rowH = app.labels.size * gl.height * 1.75;
  let overlaps = 0;
  let outside = 0;
  let crossings = 0;
  const cross = (p, q) => {
    const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return d(p.x, p.y, p.ax, p.ay, q.x, q.y) * d(p.x, p.y, p.ax, p.ay, q.ax, q.ay) < 0
      && d(q.x, q.y, q.ax, q.ay, p.x, p.y) * d(q.x, q.y, q.ax, q.ay, p.ax, p.ay) < 0;
  };
  for (const side of ['left', 'right']) {
    const col = lay.filter((p) => p.side === side).sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) if (col[i].y - col[i - 1].y < rowH * 0.98) overlaps++;
    for (const p of col) {
      const x0 = side === 'left' ? p.x - p.w : p.x;
      if (x0 < 0 || x0 + p.w > gl.width || p.y < rowH / 2 || p.y > gl.height - rowH / 2) outside++;
    }
    for (let i = 0; i < col.length; i++) for (let j = i + 1; j < col.length; j++) if (cross(col[i], col[j])) crossings++;
  }
  return {
    size: [gl.width, gl.height], shown: lay.length, overlaps, outside, crossings,
    sides: [lay.filter((p) => p.side === 'left').length, lay.filter((p) => p.side === 'right').length],
  };
});
console.log('--- layout:', JSON.stringify(layout));
if (layout.size[0] !== 1920 || layout.size[1] !== 1080) problems.push(`slide frame is ${layout.size.join('×')}, want 1920×1080`);
if (layout.overlaps) problems.push(`${layout.overlaps} callout rows overlap`);
if (layout.outside) problems.push(`${layout.outside} callouts fall outside the frame`);
if (layout.crossings > 2) problems.push(`${layout.crossings} leader lines still cross`);
if (Math.min(...layout.sides) < layout.shown * 0.25) problems.push(`callout columns unbalanced: ${layout.sides.join(' / ')}`);
await savePhoto('studio-labels-skeleton.png');

// The labels are IN the exported photo (GL + overlay composite), and 2× is 4K.
const photo = await page.evaluate(async () => {
  const app = window.__app;
  const load = (url) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = url; });
  const withL = await load(app.photoDataURL(1));
  app.setLabelsVisible(false);
  const without = await load(app.photoDataURL(1));
  app.setLabelsVisible(true);
  const big = await load(app.photoDataURL(2));
  const px = (img) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, c.width, c.height).data;
  };
  const a = px(withL);
  const b = px(without);
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) > 40) diff++;
  return { diff, size: [withL.width, withL.height], big: [big.width, big.height], live: [app.renderer.domElement.width, app.renderer.domElement.height] };
});
console.log('--- photo:', JSON.stringify(photo));
if (photo.diff < 20000) problems.push(`labels barely change the exported photo (${photo.diff} px) — overlay not composited?`);
if (photo.big[0] !== 3840 || photo.big[1] !== 2160) problems.push(`2× photo is ${photo.big.join('×')}, want 3840×2160`);
if (photo.live[0] !== 1920) problems.push('a scaled photo left the live canvas resized');

// Muscles: lit set → callouts on the muscle layer, both columns used.
await setLayer('muscle');
await page.evaluate(() => {
  const app = window.__app;
  app.clearLabels();
  app.setBackdrop('dark');
  app.setMuscleLit(new Set(['Rectus femoris', 'Deltoid', 'Pectoralis major', 'Sartorius', 'Tibialis anterior', 'Rectus abdominal', 'Gracilis', 'Vastus lateralis']));
});
await sleep(300);
const musc = await page.evaluate(() => {
  const app = window.__app;
  const n = app.labelHighlighted();
  return { n, texts: app.labels.list.map((l) => l.text), sides: app.labels.list.map((l) => l.side) };
});
await sleep(300);
console.log('--- muscle labels:', JSON.stringify(musc.texts));
if (musc.n !== 8) problems.push(`lit muscles → ${musc.n} labels, want 8 (one per belly, not per side)`);
if (!musc.texts.includes('Rectus abdominis')) problems.push('Rectus abdominal was not given its readable name');
if (new Set(musc.sides).size < 2) problems.push('front-view muscle callouts all landed on one side of the body');
await savePhoto('studio-labels-muscle.png');

const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tangoPoseStudio.labels.v1') || '[]').length);
if (stored !== 8) problems.push(`labels not persisted (${stored} rows in localStorage)`);
await page.evaluate(() => { window.__app.setMuscleLit(new Set()); window.__app.clearLabels(); window.__app.setFrame('window'); });

// ------------------------------------------------------------------- clips
// Direction semantics, measured on the posed figure (it stands at the origin
// facing +Z, so world axes ARE its anatomical axes: +X = its left, +Y up).
const semantics = await page.evaluate(() => {
  const app = window.__app;
  const THREE_V = app.leader.group.position.constructor;
  const v = (x = 0, y = 0, z = 0) => new THREE_V(x, y, z);
  const out = [];
  const snap = (f, s) => {
    f.group.updateMatrixWorld(true);
    f.syncAtlasNodes();
    const P = (j) => f.surfacePos(j).clone();
    const axisOf = (node, a) => v(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0)
      .applyQuaternion(f.nodes[node].getWorldQuaternion(f.group.quaternion.clone()));
    const thumb = f.fingerBones?.[s]?.find((b) => b.digit === 0 && b.seg === 0);
    const pinky = f.fingerBones?.[s]?.find((b) => b.digit === 4 && b.seg === 0);
    return {
      elbow: P(`elbow_${s}`), wrist: P(`wrist_${s}`), shoulder: P(`shoulder_${s}`),
      knee: P(`knee_${s}`), ankle: P(`ankle_${s}`), toes: P(`toes_${s}`),
      head: P('headTop'), neck: P('neck'),
      palm: f.palmDirWorld ? f.palmDirWorld(s).clone() : null,
      fingers: f.fingerDirWorld ? f.fingerDirWorld(s).clone() : null,
      thumbSide: thumb && pinky ? thumb.bone.getWorldPosition(v()).sub(pinky.bone.getWorldPosition(v())).normalize() : null,
      footFwd: axisOf(`ankle_${s}`, 'z'), sole: axisOf(`ankle_${s}`, 'y').negate(),
      toeFwd: axisOf(`toes_${s}`, 'z'),
      chestFwd: axisOf('chest', 'z'), headFwd: axisOf('head', 'z'), pelvisFwd: axisOf('pelvis', 'z'),
    };
  };
  // Each test: given base snapshot a, end snapshot b and m = +1 when "medial" is
  // +X (right limb) / −1 (left limb) → a number that must be POSITIVE.
  const d = (a, b, k) => b[k].clone().sub(a[k]);
  const TESTS = {
    sh_flex: (a, b) => d(a, b, 'elbow').z, sh_ext: (a, b) => -d(a, b, 'elbow').z,
    sh_abd: (a, b, m) => -m * d(a, b, 'elbow').x, sh_add: (a, b, m) => m * d(a, b, 'elbow').x,
    sh_ir: (a, b, m) => m * d(a, b, 'wrist').x, sh_er: (a, b, m) => -m * d(a, b, 'wrist').x,
    sh_hadd: (a, b) => d(a, b, 'elbow').z, sh_habd: (a, b) => -d(a, b, 'elbow').z,
    sc_elev: (a, b) => d(a, b, 'shoulder').y, sc_dep: (a, b) => -d(a, b, 'shoulder').y,
    sc_pro: (a, b) => d(a, b, 'shoulder').z, sc_ret: (a, b) => -d(a, b, 'shoulder').z,
    el_flex: (a, b) => a.elbow.distanceTo(a.wrist) && (a.shoulder.distanceTo(a.wrist) - b.shoulder.distanceTo(b.wrist)),
    el_ext: (a, b) => b.shoulder.distanceTo(b.wrist) - a.shoulder.distanceTo(a.wrist),
    fa_pro: (a, b) => a.palm.y - b.palm.y, fa_sup: (a, b) => b.palm.y - a.palm.y,
    wr_flex: (a, b) => d(a, b, 'fingers').dot(a.palm), wr_ext: (a, b) => -d(a, b, 'fingers').dot(a.palm),
    wr_rad: (a, b) => d(a, b, 'fingers').dot(a.thumbSide), wr_uln: (a, b) => -d(a, b, 'fingers').dot(a.thumbSide),
    hp_flex: (a, b) => d(a, b, 'knee').z, hp_ext: (a, b) => -d(a, b, 'knee').z,
    hp_abd: (a, b, m) => -m * d(a, b, 'knee').x, hp_add: (a, b, m) => m * d(a, b, 'knee').x,
    hp_ir: (a, b, m) => m * d(a, b, 'footFwd').x, hp_er: (a, b, m) => -m * d(a, b, 'footFwd').x,
    kn_flex: (a, b) => -d(a, b, 'ankle').z, kn_ext: (a, b) => d(a, b, 'ankle').z,
    an_df: (a, b) => d(a, b, 'footFwd').y, an_pf: (a, b) => -d(a, b, 'footFwd').y,
    an_inv: (a, b, m) => m * d(a, b, 'sole').x, an_ev: (a, b, m) => -m * d(a, b, 'sole').x,
    to_ext: (a, b) => d(a, b, 'toeFwd').y, to_flex: (a, b) => -d(a, b, 'toeFwd').y,
    tr_flex: (a, b) => d(a, b, 'neck').z, tr_ext: (a, b) => -d(a, b, 'neck').z,
    // Central joints bend/turn TOWARD the chosen side: m = +1 for R (−X).
    tr_lat: (a, b, m) => -m * d(a, b, 'neck').x, tr_rot: (a, b, m) => -m * d(a, b, 'chestFwd').x,
    pv_ant: (a, b) => -d(a, b, 'pelvisFwd').y, pv_post: (a, b) => d(a, b, 'pelvisFwd').y,
    nk_flex: (a, b) => d(a, b, 'head').z, nk_ext: (a, b) => -d(a, b, 'head').z,
    nk_lat: (a, b, m) => -m * d(a, b, 'head').x, nk_rot: (a, b, m) => -m * d(a, b, 'headFwd').x,
    tg_dissoc: (a, b, m) => -m * d(a, b, 'chestFwd').x, tg_pivot: (a, b, m) => -m * d(a, b, 'pelvisFwd').x,
    // The heel rises over the ball (measured foot-relative: this snapshot is
    // taken before the render loop's floor clamp has lifted the body).
    tg_releve: (a, b) => (b.ankle.y - b.toes.y) - (a.ankle.y - a.toes.y),
  };
  for (const move of app.studio.movements) {
    for (const side of ['L', 'R']) {
      app.enterClip(move.id, { figure: app.leader, side });
      const clip = app.studio.clip;
      app.scrubClip(0);
      const a = snap(app.leader, side);
      app.scrubClip((clip.segs[0].t1 + 0.05) / clip.duration);
      const b = snap(app.leader, side);
      const test = TESTS[move.id];
      const score = test ? test(a, b, side === 'R' ? 1 : -1) : null;
      // Single-joint swings: the readout's end range must equal the table's.
      const d0 = move.drive[0];
      const single = move.drive.length === 1 && !move.marker;
      const to = side === 'R' && d0.axis !== 'x' ? -d0.to : d0.to; // rows are left-handed
      const want = single ? Math.abs(to - (clip.baseAngles[`${d0.joint}_${side}`]?.[d0.axis] ?? 0) * 180 / Math.PI) : null;
      out.push({ id: move.id, side, score, tested: !!test, end: Math.abs(clip.motion.end) * 180 / Math.PI, want });
    }
  }
  return out;
});
const untested = [...new Set(semantics.filter((s) => !s.tested).map((s) => s.id))];
if (untested.length) problems.push(`movements with no direction test: ${untested.join(', ')}`);
const wrongWay = semantics.filter((s) => s.tested && !(s.score > 1e-3));
for (const s of wrongWay) problems.push(`${s.id} (${s.side}) moves the WRONG WAY for its name (score ${s.score?.toFixed?.(4)})`);
for (const s of semantics) {
  if (s.want !== null && Math.abs(s.end - s.want) > 1.5) problems.push(`${s.id} (${s.side}) readout ends at ${s.end.toFixed(1)}°, table says ${s.want.toFixed(1)}°`);
}
console.log(`--- clip semantics: ${semantics.length} movement×side checks, ${wrongWay.length} wrong-way`);

// Lifecycle: enter from a couple pose, play, exit → everything back.
await page.evaluate(() => { window.__app.exitClip(); window.__app.applyPreset(1); window.__app.setVisibleFigures('both'); window.__app.setView('three'); });
await sleep(900);
const before = await page.evaluate(() => {
  const app = window.__app;
  return { state: JSON.stringify(app.getCoupleState('x').figures), cam: app.camera.position.toArray(), frame: app.studio.frame };
});
await page.evaluate(() => {
  const sel = document.getElementById('clip-move');
  sel.value = 'hp_flex';
  sel.dispatchEvent(new Event('change'));
});
await sleep(600);
const entered = await page.evaluate(() => {
  const app = window.__app;
  const gl = app.renderer.domElement;
  return {
    active: app.studio.clipActive, frame: app.studio.frame, size: [gl.width, gl.height],
    followerHidden: !app.follower.group.visible, backdrop: app.studio.backdrop,
    followerPos: app.follower.group.position.toArray(),
    cogHidden: !app.cogViz.leader.cogBall.visible,
    clipLabels: app.labels.items.filter((l) => l.temp).map((l) => l.text),
    lit: [...(app.leader.litMuscles || [])],
  };
});
console.log('--- clip entered:', JSON.stringify(entered));
if (!entered.active) problems.push('choosing a movement did not enter the clip stage');
if (entered.size[0] !== 1920 || entered.size[1] !== 1080) problems.push('clip stage is not the 1920×1080 slide frame');
if (!entered.followerHidden) problems.push('the partner is still visible on the clip stage');
if (!entered.cogHidden) problems.push('balance visuals still showing on the clip stage');
if (!entered.clipLabels.includes('Iliopsoas')) problems.push('prime movers were not labelled');
if (!entered.lit.includes('Rectus femoris|R')) problems.push('prime movers were not lit on the moving side only');

// Play: callouts stay put while anchors move, the partner is never shoved, and
// the clip comes back to its first pose (a seamless loop).
const play = await page.evaluate(async () => {
  const app = window.__app;
  const clip = app.studio.clip;
  const pose0 = JSON.stringify(app.leader.getPose().joints);
  const fol0 = app.follower.group.position.toArray();
  app.setClipOptions({ stroke: 0.8, hold: 0.2 });
  app.scrubClip(0);
  app.playClip(true);
  const ys = new Map();
  const ay = new Map();
  let maxAngle = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 2300) {
    await new Promise((r) => requestAnimationFrame(r));
    maxAngle = Math.max(maxAngle, Math.abs(clip.motion.angle) * 180 / Math.PI);
    for (const p of app.studio.lastLayout || []) {
      if (!ys.has(p.label.id)) { ys.set(p.label.id, [p.y, p.y]); ay.set(p.label.id, [p.ay, p.ay]); }
      const a = ys.get(p.label.id); a[0] = Math.min(a[0], p.y); a[1] = Math.max(a[1], p.y);
      const b = ay.get(p.label.id); b[0] = Math.min(b[0], p.ay); b[1] = Math.max(b[1], p.ay);
    }
  }
  app.playClip(false);
  app.scrubClip(1);
  const poseEnd = JSON.stringify(app.leader.getPose().joints);
  const fol1 = app.follower.group.position.toArray();
  return {
    maxAngle,
    labelDrift: Math.max(0, ...[...ys.values()].map(([lo, hi]) => hi - lo)),
    anchorTravel: Math.max(0, ...[...ay.values()].map(([lo, hi]) => hi - lo)),
    loops: pose0 === poseEnd,
    partnerMoved: Math.hypot(fol1[0] - fol0[0], fol1[2] - fol0[2]),
  };
});
console.log('--- clip play:', JSON.stringify(play));
if (play.maxAngle < 110) problems.push(`hip flexion clip only reached ${play.maxAngle.toFixed(0)}° while playing`);
if (play.labelDrift > 1) problems.push(`callouts moved ${play.labelDrift.toFixed(1)} px while the clip played (should be frozen)`);
if (play.anchorTravel < 30) problems.push('callout anchors did not follow the moving muscles');
if (!play.loops) problems.push('the clip does not end on its starting pose (loop would jump)');
if (play.partnerMoved > 1e-6) problems.push(`the hidden partner was pushed ${(play.partnerMoved * 100).toFixed(1)} cm during the clip`);

await page.evaluate(() => { const c = window.__app.studio.clip; window.__app.scrubClip((c.segs[0].t1 + 0.1) / c.duration); });
await sleep(300);
await savePhoto('studio-clip-hip-flexion.png');
await page.evaluate(() => {
  const app = window.__app;
  app.enterClip('sh_abd', { figure: app.follower, side: 'L' });
  const c = app.studio.clip;
  app.scrubClip((c.segs[0].t1 + 0.1) / c.duration);
});
await setLayer('skeleton');
await page.evaluate(() => window.__app.setBackdrop('light'));
await sleep(300);
await savePhoto('studio-clip-shoulder-abduction-light.png');
await setLayer('muscle');
await page.evaluate(() => window.__app.setBackdrop('dark'));

// Relevé: the body rises, the soles never leave (or enter) the floor.
const releve = await page.evaluate(async () => {
  const app = window.__app;
  app.enterClip('tg_releve', { figure: app.leader, side: 'R' });
  const c = app.studio.clip;
  app.scrubClip((c.segs[0].t1 + 0.1) / c.duration);
  await new Promise((r) => setTimeout(r, 300));
  return { rise: app.leader.group.position.y, low: Math.min(app.leader.footLowY('L'), app.leader.footLowY('R')) };
});
console.log('--- relevé:', JSON.stringify(releve));
if (releve.rise < 0.04) problems.push(`relevé lifted the body only ${(releve.rise * 100).toFixed(1)} cm`);
if (Math.abs(releve.low) > 0.004) problems.push(`relevé left the feet ${(releve.low * 100).toFixed(1)} cm off the floor`);
await savePhoto('studio-clip-releve.png');

// ⏺ Record → a real MP4 of the composited stage.
const rec = await page.evaluate(async () => {
  window.__blobs = [];
  const origURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__blobs.push({ size: b.size, type: b.type }); return origURL(b); };
  let fileName = null;
  HTMLAnchorElement.prototype.click = function click() { fileName = this.download; };
  const app = window.__app;
  app.enterClip('el_flex', { figure: app.leader, side: 'R' });
  app.setClipOptions({ stroke: 0.7, hold: 0.2, loops: 1 });
  const started = app.recordClip();
  const locked = document.getElementById('clip-record').disabled && document.getElementById('clip-exit').disabled;
  const t0 = performance.now();
  while (app.studio.busy && performance.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 100));
  return { started, locked, done: !app.studio.busy, blob: window.__blobs[0], fileName, unlocked: !document.getElementById('clip-record').disabled };
});
console.log('--- record:', JSON.stringify(rec));
if (!rec.started || !rec.done) problems.push('clip recording did not start/finish');
if (!rec.locked || !rec.unlocked) problems.push('record/exit buttons did not lock during the capture and release after');
if (!rec.blob || rec.blob.size < 30000) problems.push(`recorded video is only ${rec.blob?.size ?? 0} bytes`);
if (rec.fileName !== 'tangle-el_flex-R.mp4') problems.push(`recorded file is "${rec.fileName}", want tangle-el_flex-R.mp4`);

// Exit → the couple, camera, frame and visibility are exactly as they were.
await page.evaluate(() => document.getElementById('clip-exit').click());
await sleep(900);
const after = await page.evaluate(() => {
  const app = window.__app;
  return {
    state: JSON.stringify(app.getCoupleState('x').figures), cam: app.camera.position.toArray(), frame: app.studio.frame,
    both: app.leader.group.visible && app.follower.group.visible, temp: app.labels.items.length,
    lit: app.leader.litMuscles, spheres: app.leader.pickSpheres.every((s) => s.visible),
    cog: app.cogViz.leader.cogBall.visible,
  };
});
if (after.state !== before.state) problems.push('exiting the clip stage did not restore the couple pose');
if (after.cam.some((c, i) => Math.abs(c - before.cam[i]) > 1e-6)) problems.push('exiting the clip stage did not restore the camera');
if (after.frame !== before.frame) problems.push('exiting the clip stage did not restore the frame');
if (!after.both) problems.push('exiting the clip stage did not show both dancers again');
if (after.temp) problems.push('clip callouts survived the exit');
if (after.lit) problems.push('clip muscle highlight survived the exit');
if (!after.spheres) problems.push('joint pick spheres stayed hidden after the clip');
if (!after.cog) problems.push('balance visuals did not return after the clip');
console.log('--- exit restored:', after.state === before.state);

await browser.close();
console.log(problems.length ? `PROBLEMS:\n - ${problems.join('\n - ')}` : 'All studio checks passed.');
console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
process.exit(problems.length || logs.length ? 1 : 0);
