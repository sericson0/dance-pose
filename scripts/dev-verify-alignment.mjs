// Dev check / diagnostic: how well the clothed body avatar overlays the
// skeleton atlas it is retargeted onto. The three layers are meant to
// coincide (CLAUDE.md), so at rest the skeleton bone geometry should sit
// *inside* the body skin and the two layers' geometry should share a centroid
// at every joint. This script measures, per joint node, the world-space gap
// between the skeleton geometry and the body skin attributed to that joint,
// plus the sharp endpoint drifts (fingertip, toe, heel) where misalignment is
// worst. It also renders overlay screenshots (skeleton bones showing through a
// translucent body) front/side and zoomed on the hands and feet.
//
// Usage: node scripts/dev-verify-alignment.mjs <outDir>   (dev server running)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-align';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const report = await page.evaluate(() => {
  const THREE_V = Object.getPrototypeOf(window.__app.figures[0].group.position).constructor;
  const app = window.__app;

  // Walk up an object's parent chain to the joint node it belongs to.
  const jointOf = (obj) => {
    let n = obj;
    while (n && (!n.userData || n.userData.jointName === undefined)) n = n.parent;
    return n ? n.userData.jointName : null;
  };

  const out = { figures: [] };
  for (const fig of app.figures) {
    fig.resetPose();
    fig.group.position.set(0, 0, 0);
    fig.group.rotation.set(0, 0, 0);
    fig.group.updateMatrixWorld(true);

    // --- gather skeleton geometry per node (world space) ---
    const skel = new Map(); // node -> { sum:Vec3, n }
    const addSkel = (node, v) => {
      let a = skel.get(node); if (!a) { a = { sum: new THREE_V(), n: 0 }; skel.set(node, a); }
      a.sum.add(v); a.n++;
    };
    const v = new THREE_V();
    for (const mesh of fig.layerMeshes.skeleton) {
      const node = jointOf(mesh); if (!node) continue;
      mesh.updateMatrixWorld(true);
      const p = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 3000));
      for (let i = 0; i < p.count; i += step) {
        v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
        addSkel(node, v);
      }
    }

    // --- gather body skin geometry per node, via each vert's dominant bone ---
    const body = new Map();
    const addBody = (node, v) => {
      let a = body.get(node); if (!a) { a = { sum: new THREE_V(), n: 0 }; body.set(node, a); }
      a.sum.add(v); a.n++;
    };
    const skinned = fig.layerMeshes.body.filter((m) => m.isSkinnedMesh);
    // Endpoint extremes: farthest skin/skeleton vert from a reference joint.
    const ext = {}; // key -> { sk:{d,pt}, bo:{d,pt} }
    const bumpExt = (key, kind, d, pt) => {
      let e = ext[key]; if (!e) { e = { sk: { d: -1 }, bo: { d: -1 } }; ext[key] = e; }
      if (d > e[kind].d) e[kind] = { d, pt: pt.clone() };
    };
    const refs = {}; // reference joint world positions
    for (const s of ['_L', '_R']) {
      refs[`wrist${s}`] = fig.nodes[`wrist${s}`].getWorldPosition(new THREE_V());
      refs[`ankle${s}`] = fig.nodes[`ankle${s}`].getWorldPosition(new THREE_V());
    }
    for (const mesh of skinned) {
      mesh.updateMatrixWorld(true);
      const si = mesh.geometry.attributes.skinIndex;
      const sw = mesh.geometry.attributes.skinWeight;
      const p = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 6000));
      for (let i = 0; i < p.count; i += step) {
        // dominant bone
        let bi = si.getX(i), bw = sw.getX(i);
        if (sw.getY(i) > bw) { bw = sw.getY(i); bi = si.getY(i); }
        if (sw.getZ(i) > bw) { bw = sw.getZ(i); bi = si.getZ(i); }
        if (sw.getW(i) > bw) { bw = sw.getW(i); bi = si.getW(i); }
        const bone = mesh.skeleton.bones[bi];
        const node = bone ? jointOf(bone) : null;
        if (!node) continue;
        mesh.getVertexPosition(i, v);
        addBody(node, v);
        // fingertip: farthest from wrist among wrist-region verts
        for (const s of ['_L', '_R']) {
          if (node === `wrist${s}` || node === `hand${s}`) bumpExt(`fingertip${s}`, 'bo', v.distanceTo(refs[`wrist${s}`]), v);
          if (node === `ankle${s}` || node === `toes${s}` || node === `toe${s}`) bumpExt(`foot${s}`, 'bo', v.distanceTo(refs[`ankle${s}`]), v);
        }
      }
    }
    // skeleton endpoint extremes (same references)
    for (const mesh of fig.layerMeshes.skeleton) {
      const node = jointOf(mesh); if (!node) continue;
      mesh.updateMatrixWorld(true);
      const p = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 3000));
      for (let i = 0; i < p.count; i += step) {
        v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
        for (const s of ['_L', '_R']) {
          if (node === `wrist${s}` || node === `hand${s}`) bumpExt(`fingertip${s}`, 'sk', v.distanceTo(refs[`wrist${s}`]), v);
          if (node === `ankle${s}` || node === `toes${s}` || node === `toe${s}`) bumpExt(`foot${s}`, 'sk', v.distanceTo(refs[`ankle${s}`]), v);
        }
      }
    }

    // --- per-node centroid drift ---
    const drifts = [];
    for (const [node, sa] of skel) {
      const ba = body.get(node);
      if (!ba || !ba.n) continue;
      const sc = sa.sum.clone().multiplyScalar(1 / sa.n);
      const bc = ba.sum.clone().multiplyScalar(1 / ba.n);
      drifts.push({ node, mm: sc.distanceTo(bc) * 1000, skN: sa.n, boN: ba.n });
    }
    drifts.sort((a, b) => b.mm - a.mm);

    // endpoint drifts: gap between the two layers' extreme points
    const endpoints = {};
    for (const [key, e] of Object.entries(ext)) {
      if (e.sk.d < 0 || e.bo.d < 0) continue;
      endpoints[key] = {
        tipGapMm: e.sk.pt.distanceTo(e.bo.pt) * 1000,
        skReach: e.sk.d * 1000, boReach: e.bo.d * 1000,
      };
    }
    out.figures.push({ name: fig.name, height: fig.height, drifts, endpoints });
    fig.resetPose();
  }
  return out;
});

// ---- print ----
const problems = [];
for (const f of report.figures) {
  console.log(`\n=== ${f.name} (H=${f.height.toFixed(2)}m) ===`);
  console.log('per-joint centroid drift (skeleton vs body geometry):');
  for (const d of f.drifts.slice(0, 12)) {
    console.log(`  ${d.node.padEnd(12)} ${d.mm.toFixed(1).padStart(6)} mm   (skel ${d.skN} / body ${d.boN} verts)`);
    if (d.mm > 25) problems.push(`${f.name}: ${d.node} layers ${d.mm.toFixed(0)}mm apart`);
  }
  console.log('endpoint extreme drift (fingertip / foot):');
  for (const [key, e] of Object.entries(f.endpoints)) {
    console.log(`  ${key.padEnd(12)} tipGap ${e.tipGapMm.toFixed(1).padStart(6)} mm   reach skel ${e.skReach.toFixed(0)} / body ${e.boReach.toFixed(0)} mm`);
    if (e.tipGapMm > 30) problems.push(`${f.name}: ${key} tips ${e.tipGapMm.toFixed(0)}mm apart (reach skel ${e.skReach.toFixed(0)} vs body ${e.boReach.toFixed(0)})`);
  }
}

// ---- overlay screenshots: skeleton bones showing through a translucent body ----
async function shot(name, fn) {
  await page.evaluate(fn);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${outDir}/${name}.png` });
}
await page.evaluate(() => {
  const a = window.__app;
  a.figures.forEach((f) => { f.resetPose(); f.group.position.set(0, 0, 0); f.group.rotation.set(0, 0, 0); });
  a.setVisibleFigures('leader');
  for (const f of a.figures) {
    f.setLayers({ skeleton: true, body: true, muscle: false });
    for (const m of f.layerMeshes.body) {
      if (!m.material) continue;
      m.material = m.material.clone();
      m.material.transparent = true;
      m.material.opacity = 0.4;
      m.material.depthWrite = false;
    }
  }
  a.figures[0].group.updateMatrixWorld(true);
});
await shot('overlay-front', () => {
  const a = window.__app;
  a.camera.position.set(0, 1.1, 3.0); a.orbit.target.set(0, 1.0, 0);
});
await shot('overlay-hands', () => {
  const a = window.__app;
  const w = a.figures[0].nodes.wrist_L.getWorldPosition(new (Object.getPrototypeOf(a.figures[0].group.position).constructor)());
  a.camera.position.set(w.x + 0.5, w.y + 0.1, 0.6); a.orbit.target.copy(w);
});
await shot('overlay-feet', () => {
  const a = window.__app;
  a.camera.position.set(0.8, 0.25, 0.9); a.orbit.target.set(0.1, 0.06, 0.12);
});

if (problems.length) console.log('\nPROBLEMS:\n' + problems.join('\n'));
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length ? 1 : 0);
