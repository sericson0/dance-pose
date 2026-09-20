// Does the toes (MTP) joint hinge about the metatarsal heads, or about a point
// somewhere else in the foot?
//
// #atlasLimbRest estimates every seated joint from the RAW atlas bones, but
// #alignEndpointGeometry then MOVES the foot out from under its nodes — an
// 18.6° (leader) / 13.9° (follower) rotation onto the shoe's midline plus a
// ~1.3 cm seat translation. That fit pivots about the ankle, so the ankle keeps
// its geometry and the toes node, 13 cm out along the foot, does not: the
// metatarsal heads ended up 3.7 cm from the node that is supposed to be the
// hinge through them, and toe flexion swung the phalanges on that crank.
// Figure.#reseatToesPivot puts the node back on the rendered joint.
//
// THE METRIC IS AN ANCHOR, and deliberately independent of how the fix picks
// the pivot (a check that measures what the fix optimises is circular — see the
// foot-fit `measureAxes` tale in CLAUDE.md). Freeze the toes-mesh vertices that
// physically TOUCH the ankle mesh at rest — the proximal phalanx bases against
// the metatarsal heads, i.e. the articulation itself — then measure how far
// their centroid travels IN THE ANKLE NODE'S OWN FRAME as the joint runs its
// range. A hinge through the joint leaves that interface still whatever the
// angle; a hinge displaced by d drags it by ~d·θ, which is the phalanges
// ploughing through the heads.
//
// Measured before the fix / after:  leader 22.7 → 0.2 mm at 35°, 43.3 → 0.3 mm
// at −70°; follower 14.3 → 0.3 and 27.3 → 0.6.
//
// Honours DEV_URL and BROWSER_PATH.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2];
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.DEV_URL || 'http://localhost:5173';

// The articulation may not travel more than this, in mm, at any angle in range.
const ANCHOR_TOL = 3;
// …and the node itself must sit on the joint, measured IN THE HINGE'S PLANE.
// The MTP is a pure x hinge (skeletonDef.js locks its y and z), and a rotation
// about x does not depend on its pivot's x at all, so only the y/z offset can
// reach the movement — which is why #narrowFoot's later lateral squeeze is
// allowed to leave a few mm of x behind.
const OFFSET_TOL_MM = 10;

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.setViewport({ width: 1500, height: 950 });
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));

const probe = await page.evaluate(() => {
  const app = window.__app;
  const out = {};
  for (const who of ['leader', 'follower']) {
    const fig = app[who];
    // No THREE on the page object; borrow a Vector3 from the scene graph.
    const V = (x = 0, y = 0, z = 0) => fig.group.position.clone().set(x, y, z);
    fig.resetPose();
    fig.syncAtlasNodes();
    fig.group.updateMatrixWorld(true);
    const gInv = fig.group.matrixWorld.clone().invert();

    const meshesOn = (node) => fig.layerMeshes.skeleton.filter((m) => {
      let n = m;
      while (n && (!n.userData || n.userData.jointName === undefined)) n = n.parent;
      return n && n.userData.jointName === node;
    });

    const res = {};
    for (const side of ['_L', '_R']) {
      const toesMeshes = meshesOn(`toes${side}`);
      const ankleMeshes = meshesOn(`ankle${side}`);
      if (!toesMeshes.length || !ankleMeshes.length) { res[side] = { error: 'no foot meshes' }; continue; }

      // Candidate vertices as {mesh, index} so a SET frozen at rest can be
      // re-read in any pose and stays the same material points.
      const gather = (list, step) => {
        const pts = [];
        for (const m of list) {
          const p = m.geometry.attributes.position;
          for (let i = 0; i < p.count; i += step) pts.push({ m, i });
        }
        return pts;
      };
      const wp = (c, v) => {
        v.fromBufferAttribute(c.m.geometry.attributes.position, c.i);
        return c.m.localToWorld(v);
      };

      const toeC = gather(toesMeshes, 1);
      const ankW = gather(ankleMeshes, 3).map((c) => wp(c, V()));

      // The articulation: toes verts lying against the metatarsals. 4 mm of a
      // 1.75 m figure — these bones really do meet in the atlas (≈570 verts
      // qualify). The nearest 8% is the fallback if a future model leaves a
      // wider joint space, so the check degrades rather than vanishing.
      const scored = [];
      const v = V();
      for (const c of toeC) {
        const w = wp(c, v);
        let best = Infinity;
        for (const a of ankW) { const d = w.distanceToSquared(a); if (d < best) best = d; }
        scored.push([best, c]);
      }
      scored.sort((a, b) => a[0] - b[0]);
      const touching = scored.filter((s) => Math.sqrt(s[0]) < 0.004).map((s) => s[1]);
      const set = touching.length >= 50 ? touching
        : scored.slice(0, Math.max(50, Math.round(scored.length * 0.08))).map((s) => s[1]);

      const ankleNode = fig.atlasNodes[`ankle${side}`] || fig.nodes[`ankle${side}`];
      const centroidInAnkle = () => {
        const acc = V();
        const t = V();
        for (const c of set) acc.add(ankleNode.worldToLocal(wp(c, t)));
        return acc.multiplyScalar(1 / set.length);
      };
      const centroidFig = () => {
        const acc = V();
        const t = V();
        for (const c of set) acc.add(wp(c, t));
        return acc.multiplyScalar(1 / set.length).applyMatrix4(gInv);
      };

      const sample = (deg) => {
        fig.resetPose();
        if (deg) fig.setJointDegrees({ [`toes${side}`]: { x: deg } });
        fig.syncAtlasNodes();
        fig.group.updateMatrixWorld(true);
        return { deg, mtp: centroidInAnkle().toArray() };
      };

      // The whole hinge range from skeletonDef.js, plus a mid point each way.
      const lim = fig.nodes[`toes${side}`].userData.def?.limits?.x;
      if (!lim) { res[side] = { error: 'no toes limits on the joint node' }; continue; }
      const [lo, hi] = lim;
      const angles = [0, hi, hi / 2, lo / 2, lo];

      fig.resetPose(); fig.syncAtlasNodes(); fig.group.updateMatrixWorld(true);
      const mtpFig = centroidFig();
      const node = fig.atlasNodes[`toes${side}`] || fig.nodes[`toes${side}`];
      const nodeFig = node.getWorldPosition(V()).applyMatrix4(gInv);
      const off = mtpFig.clone().sub(nodeFig);
      res[side] = {
        nSet: set.length,
        touching: touching.length,
        // How far the node sits from the joint, split into the part the hinge
        // can feel (y/z) and the part it provably cannot (x).
        offHingeMm: Math.hypot(off.y, off.z) * 1000,
        offAxialMm: Math.abs(off.x) * 1000,
        samples: angles.map(sample),
      };
      fig.resetPose(); fig.syncAtlasNodes();
    }
    out[who] = res;
  }
  return out;
});

const problems = [];
console.log('MTP articulation travel, measured in the ankle node\'s own frame:');
for (const [who, sides] of Object.entries(probe)) {
  for (const [side, r] of Object.entries(sides)) {
    if (r.error) { problems.push(`${who}${side}: ${r.error}`); continue; }
    const base = r.samples[0].mtp;
    const travel = r.samples.map((s) => ({
      deg: s.deg,
      mm: Math.hypot(...s.mtp.map((n, i) => n - base[i])) * 1000,
    }));
    const worst = Math.max(...travel.map((t) => t.mm));
    console.log(`  ${who}${side}  joint face ${r.touching} verts (set ${r.nSet}) · node off the joint: `
      + `${r.offHingeMm.toFixed(1)} mm in the hinge plane, ${r.offAxialMm.toFixed(1)} mm along the axis`);
    console.log(`      ${travel.map((t) => `${String(Math.round(t.deg)).padStart(4)}° ${t.mm.toFixed(1).padStart(5)} mm`).join('   ')}`);
    if (worst > ANCHOR_TOL) {
      problems.push(`${who}${side}: the MTP articulation travels ${worst.toFixed(1)} mm through the toe range `
        + `(tol ${ANCHOR_TOL}) — the phalanges are being dragged across the metatarsal heads, not hinged on them`);
    }
    if (r.offHingeMm > OFFSET_TOL_MM) {
      problems.push(`${who}${side}: the toes node sits ${r.offHingeMm.toFixed(1)} mm off the joint in the hinge plane `
        + `(tol ${OFFSET_TOL_MM}) — clip arcs and planes are drawn there too`);
    }
  }
}

// Screenshots at the extremes of the hinge, in skeleton view: the phalanx bases
// should stay seated on the metatarsal heads at every angle.
if (OUT) {
  const zoom = async () => {
    await page.evaluate(() => {
      const app = window.__app;
      const p = app.leader.surfacePos('toes_R');
      app.orbit.target.copy(p);
      app.camera.position.set(p.x + 0.34, p.y + 0.18, p.z + 0.22);
      app.orbit.update();
      app.camera.lookAt(p);
    });
    await new Promise((r) => setTimeout(r, 700));
  };
  for (const [name, deg] of [['rest', 0], ['flex35', 35], ['ext70', -70]]) {
    await page.evaluate((d) => {
      const app = window.__app;
      const el = document.querySelector('#layer-mode');
      el.value = 'skeleton'; el.dispatchEvent(new Event('change'));
      app.leader.resetPose();
      if (d) app.leader.setJointDegrees({ toes_R: { x: d } });
      app.leader.syncAtlasNodes();
    }, deg);
    await zoom();
    await page.screenshot({ path: path.join(OUT, `toe-${name}.png`) });
  }
  console.log(`\nshots in ${path.resolve(OUT)}`);
}

console.log('');
console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}`
  : 'The MTP hinges on the metatarsal heads on both figures, both sides.');
console.log(errs.length ? `\nconsole errors:\n${errs.join('\n')}` : '\nNo console errors.');
process.exitCode = problems.length || errs.length ? 1 : 0;
await browser.close();
