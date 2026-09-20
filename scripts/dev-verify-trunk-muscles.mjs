// Dev check for the BACK and the TRUNK-ANCHORED muscles: does tissue lying on a
// trunk bone stay on THAT bone when the trunk twists, bends or flexes?
//
//   node scripts/dev-verify-trunk-muscles.mjs [outDir] [--all]
//
// The vertebral column bends as a curve (src/spineColumn.js): each vertebra has
// its own frame and each rib hands over from its vertebra to the sternum. The
// muscles used to ride the two RIG frames instead — latissimus dorsi, trapezius
// and the rhomboids welded their whole spinal origin to the rigid `chest`
// frame — so in a dissociation twist the origin swung round as one slab while
// the vertebrae it arises from each turned by their own share: the lumbar and
// iliac end of latissimus by the whole 43° against a still pelvis.
//
// Neither existing probe can see it. dev-probe-muscle-anchor.mjs reads contact
// tissue in the frame of the two NODES the belly is skinned between, and the
// chest node is exactly the frame that tissue was (wrongly) rigid in — a flat 0.
// dev-probe-clip-anatomy.mjs's drift is the same measurement by another name.
//
// So this measures against the RENDERED BONES, never a node and never the
// code's own frames:
//
//   slip   for each muscle vertex lying within CONTACT_MM of a trunk bone at
//          rest, take the nearest bone vertex and two more from the SAME bone
//          a few cm away, and build a local frame from those three rendered
//          vertices. Express the muscle vertex in it at rest; pose; rebuild the
//          frame from the same three vertices and see how far the muscle vertex
//          now is from where that bone patch would have carried it. 0 = glued.
//          The frame is LOCAL (three vertices within ~45 mm) because a rib is
//          not rigid — it hands over from its vertebra to the sternum along its
//          length — so only a patch of it has a frame worth the name.
//
// NO_TRUNK=1 turns the trunk field off and shows the gates failing on the old
// rigid frames. Honours DEV_URL and BROWSER_PATH; optional <outDir> for
// screenshots of the back in each pose.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const outDir = argv.find((a) => !a.startsWith('--')) || null;
const ALL = argv.includes('--all');
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const CONTACT_MM = 10;
// Gates, on the tissue in contact with a trunk bone. A healthy rigid attachment
// reads ~0; the local-frame reconstruction itself is good to ~1 mm on a
// vertebra and ~3 mm on a rib (which shears along its length).
const MEAN_TOL = 6;
const MAX_TOL = 15;
// Tissue that TOUCHES a trunk bone without being attached to it. Reported, and
// each with its reason, because a gate that silently skips rows is how a real
// detachment gets waved through.
//   'skip'  the row is printed but never fails.
//   'mean'  the row is gated on its mean alone.
const EXEMPT = [
  // Lies on the costal face of the BLADE. The blade glides over the ribs — that
  // is the scapulothoracic "joint" — and the ribs under it turn with their own
  // vertebrae while the blade rides the chest, so 1-3 cm of slide here is the
  // anatomy, not a detachment.
  [/^Subscapularis/, 'ribs', 'skip'],
  // Attached to the ribs in FRONT of the blade (gated, mean ~3 mm) but its back
  // third is sandwiched between the blade and the cage and touches both; that
  // tissue is the blade's (skin weight ~0.05) and glides with it. It is where
  // every max outlier sits, so the max cannot gate this row.
  [/^Serratus anterior/, 'ribs', 'mean'],
];
const exemption = (name, region) => (EXEMPT.find(([re, rg]) => re.test(name) && rg === region) || [])[2];

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tangle-trunk-')),
  args: ['--window-size=1400,900', '--use-angle=default'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2600));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POSES = [
  ['twist L', { spine: { y: 8 }, chest: { y: 35 } }],
  ['twist R', { spine: { y: -8 }, chest: { y: -35 } }],
  ['side bend', { spine: { z: 20 }, chest: { z: 25 } }],
  ['flexion', { spine: { x: 50 }, chest: { x: 30 } }],
  ['extension', { spine: { x: -25 }, chest: { x: -20 } }],
  ['tango mix', { spine: { x: 10, z: -10 }, chest: { y: 30, z: 12 } }],
];

const fails = [];
// Both dancers are gated: they differ in stature and the field's distances are
// fractions of it.
for (const WHO of (process.env.FIGURE ? [process.env.FIGURE] : ['leader', 'follower'])) {
  await page.evaluate((who) => { window.__trunkWho = who; }, WHO);
  await page.evaluate((noTrunk) => {
    const app = window.__app;
    const fig = app[window.__trunkWho];
    const sel = document.querySelector('#layer-mode');
    sel.value = 'muscle';
    sel.dispatchEvent(new Event('change'));
    app.setVisibleFigures(window.__trunkWho);
    fig.resetPose();
    if (noTrunk) for (const sm of fig._skinMuscles) sm.trunk = null;
    fig.group.updateMatrixWorld(true);
    fig.updateMuscleSkin();
  }, !!process.env.NO_TRUNK);
  await sleep(500);

  const bound = await page.evaluate((CONTACT_MM) => {
    const app = window.__app;
    const fig = app[window.__trunkWho];
    const T = window.__trunk = {};
    const V = () => fig.group.position.clone().set(0, 0, 0);
    fig.group.updateMatrixWorld(true);

    // Trunk bone points (world, rest), sub-sampled, each remembering its mesh,
    // vertex index and bone range so a posed read finds the same material point.
    const bonePts = [];
    for (const nodeName of ['pelvis', 'spine', 'chest']) {
      for (const mesh of fig.nodes[nodeName].children) {
        if (!mesh.isMesh || !mesh.userData.boneRanges) continue;
        const pos = mesh.geometry.attributes.position;
        mesh.userData.boneRanges.forEach((r, ri) => {
          const step = Math.max(1, Math.floor(r.count / 260));
          for (let i = r.start; i < r.start + r.count; i += step) {
            const p = mesh.localToWorld(V().fromBufferAttribute(pos, i));
            bonePts.push({ mesh, i, key: `${mesh.uuid}:${ri}`, name: r.name, x: p.x, y: p.y, z: p.z });
          }
        });
      }
    }
    const byBone = new Map();
    bonePts.forEach((b, k) => { (byBone.get(b.key) || byBone.set(b.key, []).get(b.key)).push(k); });

    // A local frame round bone point k: itself + two neighbours on the same bone.
    const triCache = new Map();
    const triple = (k) => {
      if (triCache.has(k)) return triCache.get(k);
      const b0 = bonePts[k];
      const mates = byBone.get(b0.key);
      let k1 = -1, best = Infinity;
      for (const m of mates) {
        const b = bonePts[m];
        const d = Math.hypot(b.x - b0.x, b.y - b0.y, b.z - b0.z);
        if (m !== k && Math.abs(d - 0.03) < best) { best = Math.abs(d - 0.03); k1 = m; }
      }
      let k2 = -1; best = -1;
      if (k1 >= 0) {
        const b1 = bonePts[k1];
        const ax = V().set(b1.x - b0.x, b1.y - b0.y, b1.z - b0.z).normalize();
        for (const m of mates) {
          if (m === k || m === k1) continue;
          const b = bonePts[m];
          const w = V().set(b.x - b0.x, b.y - b0.y, b.z - b0.z);
          if (w.length() > 0.045) continue;
          const perp = w.sub(ax.clone().multiplyScalar(w.dot(ax))).length();
          if (perp > best) { best = perp; k2 = m; }
        }
      }
      const tri = k1 >= 0 && k2 >= 0 && best > 0.006 ? [k, k1, k2] : null;
      triCache.set(k, tri);
      return tri;
    };
    const M4 = fig.group.matrix.clone().constructor;
    T.frame = (tri) => {
      const [p0, p1, p2] = tri.map((k) => {
        const b = bonePts[k];
        return b.mesh.localToWorld(V().fromBufferAttribute(b.mesh.geometry.attributes.position, b.i));
      });
      const x = p1.clone().sub(p0).normalize();
      const z = x.clone().cross(p2.clone().sub(p0)).normalize();
      const y = z.clone().cross(x);
      return new M4().makeBasis(x, y, z).setPosition(p0);
    };

    const region = (name) => (/^Lumbar/i.test(name) ? 'lumbar'
      : /^Thoracic/i.test(name) ? 'thoracic'
        : /^Rib|^Costal/i.test(name) ? 'ribs'
          : /sternum|xiphoid/i.test(name) ? 'sternum'
            : /sacrum|coccyx|hip_bone|ilium|ischium|pubis/i.test(name) ? 'pelvis' : 'other');

    // Trunk bounding box, to skip limb muscles without measuring them.
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const b of bonePts) {
      lo = [Math.min(lo[0], b.x), Math.min(lo[1], b.y), Math.min(lo[2], b.z)];
      hi = [Math.max(hi[0], b.x), Math.max(hi[1], b.y), Math.max(hi[2], b.z)];
    }
    const pad = 0.02;

    T.contacts = [];
    const lim = (CONTACT_MM / 1000) ** 2;
    for (const mesh of fig.layerMeshes.muscle) {
      if (!mesh.userData.isMuscle) continue;
      const pos = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 1400));
      const rows = [];
      for (let i = 0; i < pos.count; i += step) {
        const p = mesh.localToWorld(V().fromBufferAttribute(pos, i));
        if (p.x < lo[0] - pad || p.x > hi[0] + pad || p.y < lo[1] - pad || p.y > hi[1] + pad
          || p.z < lo[2] - pad || p.z > hi[2] + pad) continue;
        let bestK = -1, best = lim;
        for (let k = 0; k < bonePts.length; k++) {
          const b = bonePts[k];
          const dx = p.x - b.x, dy = p.y - b.y, dz = p.z - b.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < best) { best = d; bestK = k; }
        }
        if (bestK < 0) continue;
        const tri = triple(bestK);
        if (!tri) continue;
        rows.push({ i, tri, region: region(bonePts[bestK].name), bone: bonePts[bestK].name,
          local: p.applyMatrix4(T.frame(tri).invert()) });
      }
      if (rows.length >= 6) {
        T.contacts.push({ mesh, name: mesh.userData.muscleName, side: mesh.userData.muscleSide, rows });
      }
    }

    T.measure = () => {
      fig.group.updateMatrixWorld(true);
      fig.updateMuscleSkin();
      const out = [];
      for (const c of T.contacts) {
        const pos = c.mesh.geometry.attributes.position;
        const by = {};
        for (const r of c.rows) {
          const want = r.local.clone().applyMatrix4(T.frame(r.tri));
          const got = c.mesh.localToWorld(V().fromBufferAttribute(pos, r.i));
          const d = want.distanceTo(got) * 1000;
          const g = by[r.region] || (by[r.region] = { n: 0, sum: 0, max: 0, worst: '' });
          g.n++; g.sum += d;
          if (d > g.max) {
            g.max = d; g.worst = r.bone;
            // The worst vertex's own skinning, so a failure names its cause.
            const sm = fig._skinMuscles.find((m) => m.mesh === c.mesh);
            g.skin = !sm ? 'rigid' : `w=${sm.weight[r.i].toFixed(2)}`
              + (sm.trunk ? ` trunk[L${sm.trunk.k[r.i]}: ${Array.from(sm.trunk.w.slice(r.i * 4, r.i * 4 + 4), (x) => x.toFixed(2)).join(' ')}]` : '');
          }
        }
        out.push({ name: c.name, side: c.side, by });
      }
      return out;
    };
    return T.contacts.map((c) => `${c.name}|${c.side}:${c.rows.length}`);
  }, CONTACT_MM);

  console.log(`
  === ${WHO} — trunk muscles: ${bound.length} bellies touch a trunk bone (contact < ${CONTACT_MM} mm) ===\n`);

  for (const [label, pose] of POSES) {
    const rows = await page.evaluate((pose) => {
      const fig = window.__app[window.__trunkWho];
      fig.resetPose();
      fig.setJointDegrees(pose);
      window.__app.requestSim?.();
      return window.__trunk.measure();
    }, pose);
    console.log(`--- ${label}`);
    const flat = [];
    let exempted = 0;
    for (const r of rows) {
      for (const [region, g] of Object.entries(r.by)) {
        if (g.n < 4) continue;
        flat.push({ ex: exemption(r.name, region), key: `${r.name} [${r.side}] on ${region}`, n: g.n, mean: g.sum / g.n, max: g.max, worst: g.worst, skin: g.skin });
      }
    }
    flat.sort((a, b) => b.mean - a.mean);
    for (const f of flat) {
      const over = f.mean > MEAN_TOL || f.max > MAX_TOL;
      const bad = f.ex === 'skip' ? false : f.ex === 'mean' ? f.mean > MEAN_TOL : over;
      if (over && !bad) exempted++;
      if (bad) fails.push(`${WHO} ${label}: ${f.key} mean ${f.mean.toFixed(1)} max ${f.max.toFixed(1)} mm`);
      if (over || ALL) {
        console.log(`  ${bad ? 'FAIL' : over ? 'exempt' : ' ok '} ${f.key.padEnd(52)} n=${String(f.n).padStart(4)}  mean ${f.mean.toFixed(1).padStart(6)}  max ${f.max.toFixed(1).padStart(6)} mm  (${f.worst}; ${f.skin})`);
      }
    }
    const gated = flat.filter((f) => f.ex !== 'skip');
    gated.sort((a, b) => b.mean - a.mean);
    if (gated[0]) console.log(`  ${flat.length} rows, ${exempted} exempt; worst gated mean: ${gated[0].key} ${gated[0].mean.toFixed(1)} mm`);
    if (outDir) {
      for (const [view, dx, dz] of [['back', -0.5, -1.55], ['front', 0.9, 1.35]]) {
        await page.evaluate((dx, dz) => {
          const app = window.__app;
          const h = app[window.__trunkWho].height;
          const p = app[window.__trunkWho].group.position;
          app.camera.position.set(p.x + dx, 0.72 * h, p.z + dz);
          app.orbit.target.set(p.x, 0.66 * h, p.z);
          app.orbit.update();
          app.requestRender?.();
        }, dx, dz);
        await sleep(500);
        await page.screenshot({ path: path.join(outDir, `trunk-${WHO}-${label.replace(/\s+/g, '-')}-${view}.png`) });
      }
    }
  }

  await page.evaluate(() => { window.__app[window.__trunkWho].resetPose(); window.__app.requestSim?.(); });
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll trunk-muscle attachments hold.');
console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join('\n')}` : '\nNo console errors.');
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
