// Do the foot's two hinges turn about their own joint faces — the talus on the
// tibial plafond, the phalanges on the metatarsal heads — or about wherever the
// raw atlas estimate happened to leave the node?
//
// #atlasLimbRest estimates every seated joint from the RAW atlas bones, but
// #alignEndpointGeometry then MOVES the foot out from under its nodes: an 18.6°
// (leader) / 13.9° (follower) rotation onto the shoe's midline, a stretch along
// it, and a ~1.3 cm seat translation. The fit pivots about the ankle, so the
// ankle is carried off by the translation alone while the toes node, 13 cm out
// along the foot, takes the rotation too. Measured before Figure
// .#reseatFootPivots: the metatarsal heads sat 3.7 cm from the node meant to
// hinge through them, and the talocrural face 0.9–2.0 cm from the ankle node.
//
// THE METRIC IS AN ANCHOR, and deliberately independent of how the fix picks
// the pivot (a check that measures what the fix optimises is circular — see the
// foot-fit `measureAxes` tale in landmarks.js). Freeze the child bone's
// vertices that physically TOUCH the parent bone at rest — the joint face
// itself — then measure how far their centroid travels IN THE PARENT NODE'S
// OWN FRAME as the joint runs its range. A hinge through the joint leaves that
// face still whatever the angle; a hinge displaced by d drags it by ~d·θ, which
// is one bone ploughing across the other.
//
// Measured before the fix / after:
//   MTP        leader 22.7 → 0.2 mm at 35°, 43.3 → 0.3 at −70°
//              follower 14.3 → 0.3,         27.3 → 0.6
//   talocrural leader  6.4 → 1.3 at 45°,     3.6 → 0.8 at −25°
//              follower 13.9 → 0.8,          7.9 → 0.4
//
// PER DIGIT (each toe on its own metatarsal head), before Figure
// .#buildToeDigits / after — leader, right foot, toes 1..5:
//    35°    7.8   6.6   2.4   5.4  14.9  →  all ≤ 0.8 mm
//   −70°   15.3  12.7   4.7  10.2  28.5  →  all ≤ 1.5 mm
// while the whole-cluster MTP row above read 0.2–0.6 mm throughout: it is a
// centroid over five joint faces, and the two ends of an oblique row move in
// opposite directions about a hinge through its middle.
//
// Honours DEV_URL and BROWSER_PATH.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2];
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.DEV_URL || 'http://localhost:5173';

// The joint face may not travel more than this, in mm, at any angle in range.
// The talocrural band is a broad collar (the malleoli wrap the talus) rather
// than the MTP's sharp interface, so its centroid is the noisier of the two.
const ANCHOR_TOL = 4;
// …and the node itself must sit on the joint, measured IN THE HINGE'S PLANE.
// Both of these are pure x hinges (skeletonDef.js locks the ankle's y and the
// toes' y and z), and a rotation about x does not depend on its pivot's x at
// all, so only the y/z offset can reach the movement — which is why
// #narrowFoot's later lateral squeeze may leave a few mm of x behind.
const OFFSET_TOL_MM = 10;

// [child joint, the parent bone it articulates on, the angles to sweep].
// Angles come from skeletonDef.js at runtime; these are just the extra
// mid-range samples' source.
const JOINTS = [
  { base: 'toes', on: 'ankle', label: 'MTP (phalanges on the metatarsal heads)' },
  { base: 'ankle', on: 'knee', label: 'talocrural (talus on the tibial plafond)' },
  // EACH TOE ON ITS OWN METATARSAL HEAD. The whole-cluster MTP row above is a
  // centroid over all five joint faces, and a centroid cannot see what one
  // hinge does to five joints that are not in a line: the metatarsal break is
  // oblique (the 5th head sits ~4 cm behind the 1st along the foot), so a
  // single hinge through the MIDDLE of the row is a crank for both ends of it.
  // That row read 0.2–0.6 mm while the little toe was being levered out of its
  // socket — see Figure.#buildToeDigits.
  ...['first', 'second', 'third', 'fourth', 'fifth'].map((word, i) => ({
    base: 'toes', on: 'ankle', digit: { n: i + 1, word }, label: 'MTP, per digit (each toe on its own metatarsal head)',
  })),
];

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

const probe = await page.evaluate((JOINTS_) => {
  const app = window.__app;
  const out = [];
  for (const who of ['leader', 'follower']) {
    const fig = app[who];
    // No THREE on the page object; borrow a Vector3 from the scene graph.
    const V = (x = 0, y = 0, z = 0) => fig.group.position.clone().set(x, y, z);

    const meshesOn = (node) => fig.layerMeshes.skeleton.filter((m) => {
      let n = m;
      while (n && (!n.userData || n.userData.jointName === undefined)) n = n.parent;
      return n && n.userData.jointName === node;
    });
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

    for (const J of JOINTS_) {
      for (const side of ['_L', '_R']) {
        const key = `${who}${side}${J.digit ? ` toe ${J.digit.n}` : ''}`;
        const rest = () => {
          fig.resetPose(); fig.syncAtlasNodes(); fig.group.updateMatrixWorld(true);
        };
        rest();
        const gInv = fig.group.matrixWorld.clone().invert();
        const childMeshes = meshesOn(`${J.base}${side}`);
        const parentMeshes = meshesOn(`${J.on}${side}`);
        if (!childMeshes.length || !parentMeshes.length) {
          out.push({ key, joint: J.label, error: 'no meshes for this joint' });
          continue;
        }

        // A DIGIT row keeps only that toe's phalanges, picked by BONE NAME
        // through boneRanges — so it measures the same material whether or not
        // the figure splits the toes into per-digit meshes.
        const re = J.digit && new RegExp(`${J.digit.word}_finger_of_foot`, 'i');
        const childC = gather(childMeshes, 1).filter((c) => !re
          || c.m.userData.boneRanges?.some((r) => re.test(r.name) && c.i >= r.start && c.i < r.start + r.count));
        if (!childC.length) { out.push({ key, joint: J.label, error: 'no verts for this digit' }); continue; }
        const parW = gather(parentMeshes, 3).map((c) => wp(c, V()));

        // The joint face: child verts lying against the parent bone. 4 mm of a
        // ~1.7 m figure. A fixed threshold alone is not enough here — the
        // follower's heel pitch closes her talocrural gap (946 verts qualify)
        // while the leader's stays wider (37) — so the nearest 8% is the
        // fallback and the check degrades rather than vanishing.
        const scored = [];
        const v = V();
        for (const c of childC) {
          const w = wp(c, v);
          let best = Infinity;
          for (const a of parW) { const d = w.distanceToSquared(a); if (d < best) best = d; }
          scored.push([best, c]);
        }
        scored.sort((a, b) => a[0] - b[0]);
        const touching = scored.filter((s) => Math.sqrt(s[0]) < 0.004).map((s) => s[1]);
        const set = touching.length >= 50 ? touching
          : scored.slice(0, Math.max(50, Math.round(scored.length * 0.08))).map((s) => s[1]);

        const parentNode = fig.atlasNodes[`${J.on}${side}`] || fig.nodes[`${J.on}${side}`];
        const inParent = () => {
          const acc = V(); const t = V();
          for (const c of set) acc.add(parentNode.worldToLocal(wp(c, t)));
          return acc.multiplyScalar(1 / set.length);
        };
        const inFigure = () => {
          const acc = V(); const t = V();
          for (const c of set) acc.add(wp(c, t));
          return acc.multiplyScalar(1 / set.length).applyMatrix4(gInv);
        };

        const lim = fig.nodes[`${J.base}${side}`].userData.def?.limits?.x;
        if (!lim) { out.push({ key, joint: J.label, error: 'no x limits on the joint node' }); continue; }
        const [lo, hi] = lim;
        const angles = [0, hi, hi / 2, lo / 2, lo];

        rest();
        const faceFig = inFigure();
        const node = fig.atlasNodes[`${J.base}${side}`] || fig.nodes[`${J.base}${side}`];
        const off = faceFig.clone().sub(node.getWorldPosition(V()).applyMatrix4(gInv));

        const samples = angles.map((deg) => {
          fig.resetPose();
          if (deg) fig.setJointDegrees({ [`${J.base}${side}`]: { x: deg } });
          fig.syncAtlasNodes(); fig.group.updateMatrixWorld(true);
          return { deg, p: inParent().toArray() };
        });
        rest();

        out.push({
          key,
          joint: J.label,
          touching: touching.length,
          nSet: set.length,
          // How far the node sits from the joint, split into the part the hinge
          // can feel (y/z) and the part it provably cannot (x).
          offHingeMm: Math.hypot(off.y, off.z) * 1000,
          offAxialMm: Math.abs(off.x) * 1000,
          samples,
        });
      }
    }
  }
  return out;
}, JOINTS);

const problems = [];
let lastJoint = null;
for (const r of probe) {
  if (r.joint !== lastJoint) { console.log(`\n=== ${r.joint} — face travel in the parent bone's own frame ===`); lastJoint = r.joint; }
  if (r.error) { problems.push(`${r.key} ${r.joint}: ${r.error}`); console.log(`  ${r.key}: ${r.error}`); continue; }
  const base = r.samples[0].p;
  const travel = r.samples.map((s) => ({ deg: s.deg, mm: Math.hypot(...s.p.map((n, i) => n - base[i])) * 1000 }));
  const worst = Math.max(...travel.map((t) => t.mm));
  console.log(`  ${r.key.padEnd(11)} face ${String(r.touching).padStart(4)} verts (set ${r.nSet}) · node off the joint: `
    + `${r.offHingeMm.toFixed(1)} mm in the hinge plane, ${r.offAxialMm.toFixed(1)} along the axis`);
  console.log(`      ${travel.map((t) => `${String(Math.round(t.deg)).padStart(4)}° ${t.mm.toFixed(1).padStart(5)} mm`).join('   ')}`);
  if (worst > ANCHOR_TOL) {
    problems.push(`${r.key} ${r.joint}: the joint face travels ${worst.toFixed(1)} mm through the range `
      + `(tol ${ANCHOR_TOL}) — the bones are being dragged across each other, not hinged`);
  }
  // Not for a digit row: the toes NODE is the middle of the row by design, and
  // each toe hinges about its own face instead (the travel above is its test).
  if (!/ toe \d$/.test(r.key) && r.offHingeMm > OFFSET_TOL_MM) {
    problems.push(`${r.key} ${r.joint}: the node sits ${r.offHingeMm.toFixed(1)} mm off the joint in the hinge plane `
      + `(tol ${OFFSET_TOL_MM}) — clip arcs and planes are drawn there too`);
  }
}

// Screenshots at the extremes of both hinges, in skeleton view: the joint faces
// should stay seated on each other at every angle.
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
  const shots = [
    ['rest', {}], ['toes-flex35', { toes_R: { x: 35 } }], ['toes-ext70', { toes_R: { x: -70 } }],
    ['ankle-point45', { ankle_R: { x: 45 } }], ['ankle-flex25', { ankle_R: { x: -25 } }],
  ];
  for (const [name, pose] of shots) {
    await page.evaluate((p) => {
      const app = window.__app;
      const el = document.querySelector('#layer-mode');
      el.value = 'skeleton'; el.dispatchEvent(new Event('change'));
      app.leader.resetPose();
      if (Object.keys(p).length) app.leader.setJointDegrees(p);
      app.leader.syncAtlasNodes();
    }, pose);
    await zoom();
    await page.screenshot({ path: path.join(OUT, `foot-${name}.png`) });
  }
  console.log(`\nshots in ${path.resolve(OUT)}`);
}

console.log('');
console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}`
  : 'Both foot hinges turn about their own joint faces, on both figures and both sides.');
console.log(errs.length ? `\nconsole errors:\n${errs.join('\n')}` : '\nNo console errors.');
process.exitCode = problems.length || errs.length ? 1 : 0;
await browser.close();
