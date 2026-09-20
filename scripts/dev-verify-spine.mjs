// Dev check for the VERTEBRAL COLUMN: does a trunk bend run through the whole
// spine as a curve, or hinge two rigid blocks?
//
// The rig bends the trunk at two joints (`spine`, `chest`) and the atlas bones
// used to ride them rigidly — five lumbar vertebrae as one stick on `spine`,
// twelve thoracic vertebrae + the ribcage as one block on `chest`. A side bend
// then put ALL of the lumbar joint's angle into the L5/S1 disc and ALL of the
// chest's into a break at T12/L1, with T10-T12 (which sit below the chest
// pivot) swinging the wrong way. src/spineColumn.js spreads both along the
// column; this measures the result on the RENDERED bones, never on its frames:
//
//   per disc   the relative ROTATION of the two vertebrae (evenness: no disc
//              may carry more than a fifth of the whole bend) and the SLIP of
//              their facing surfaces, read in the lower vertebra's own frame
//              (continuity: a disc that opens or shears is a broken spine).
//              Each bone's frame comes from three of its own vertices, so
//              nothing here trusts the code under test.
//   the ends   sacrum/L5 is one of those discs; T1/C7 must not move AT ALL —
//              the neck rides the rigid chest frame, so that junction is the
//              proof the curve closes onto the rig.
//   the cage   a rib's head stays on its own vertebra, its cartilage stays on
//              the sternum, and rib and cartilage stay joined.
//
// NO_SPINE=1 disables the column and shows every gate failing on the old
// rigid rendering. Honours DEV_URL and BROWSER_PATH; optional <outDir> for
// screenshots.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const outDir = process.argv[2] || null;
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2600));

const POSES = [
  ['side bend L', { spine: { z: 20 }, chest: { z: 25 } }, 45],
  ['side bend R', { spine: { z: -20 }, chest: { z: -25 } }, 45],
  ['lumbar only', { spine: { z: 20 } }, 20],
  ['chest only', { chest: { z: 25 } }, 25],
  ['flexion', { spine: { x: 50 }, chest: { x: 30 } }, 80],
  ['extension', { spine: { x: -25 }, chest: { x: -20 } }, 45],
  ['twist', { spine: { y: 8 }, chest: { y: 35 } }, 43],
  ['tango mix', { spine: { x: 10, z: -10 }, chest: { y: 30, z: 12 } }, 36],
];

const result = await page.evaluate((POSES, noSpine) => {
  const app = window.__app;
  const fig = app.leader;
  const sel = document.querySelector('#layer-mode');
  sel.value = 'skeleton';
  sel.dispatchEvent(new Event('change'));
  app.setVisibleFigures('leader');
  fig.resetPose();
  if (noSpine) fig.spineColumn = null;
  fig.group.updateMatrixWorld(true);
  // No THREE on the page object; borrow a Vector3 from the scene graph.
  const V = () => fig.group.position.clone().set(0, 0, 0);

  // name → { mesh, range } for the source (axial or right-side) copy.
  const bones = new Map();
  fig.group.traverse((o) => {
    for (const r of o.userData?.boneRanges || []) if (r.side !== 'L') bones.set(r.name, { mesh: o, r });
  });
  const vert = (b, i, out = V()) => b.mesh.localToWorld(out.fromBufferAttribute(b.mesh.geometry.attributes.position, i));
  const indices = (b, step = 7) => {
    const a = [];
    for (let i = b.r.start; i < b.r.start + b.r.count; i += step) a.push(i);
    return a;
  };
  const centroidOf = (b, idx) => {
    const c = V();
    for (const i of idx) c.add(vert(b, i));
    return c.multiplyScalar(1 / idx.length);
  };
  // The fraction of b's (sub-sampled) verts nearest a point — a joint face.
  const nearest = (b, point, frac) => {
    const idx = indices(b);
    const d = idx.map((i) => [vert(b, i).distanceTo(point), i]).sort((p, q) => p[0] - q[0]);
    return d.slice(0, Math.max(6, Math.floor(idx.length * frac))).map((p) => p[1]);
  };
  // A bone's rigid frame from three of its own far-apart vertices.
  const triple = (b) => {
    const idx = indices(b, 3);
    const c = centroidOf(b, idx);
    let i0 = idx[0], best = -1;
    for (const i of idx) { const d = vert(b, i).distanceTo(c); if (d > best) { best = d; i0 = i; } }
    const p0 = vert(b, i0);
    let i1 = i0; best = -1;
    for (const i of idx) { const d = vert(b, i).distanceTo(p0); if (d > best) { best = d; i1 = i; } }
    const p1 = vert(b, i1);
    const axis = p1.clone().sub(p0).normalize();
    let i2 = i0; best = -1;
    for (const i of idx) {
      const w = vert(b, i).sub(p0);
      const d = w.sub(axis.clone().multiplyScalar(w.dot(axis))).length();
      if (d > best) { best = d; i2 = i; }
    }
    return [i0, i1, i2];
  };
  const M = fig.group.matrix.clone().constructor;
  const frameOf = (b, tri) => {
    const [p0, p1, p2] = tri.map((i) => vert(b, i));
    const x = p1.clone().sub(p0).normalize();
    const z = x.clone().cross(p2.clone().sub(p0)).normalize();
    const y = z.clone().cross(x);
    return new M().makeBasis(x, y, z).setPosition(p0);
  };

  const names = ['Sacrum',
    ...[5, 4, 3, 2, 1].map((n) => `Lumbar_vertebrae_(L${n})`),
    ...[12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `Thoracic_vertebrae_(T${n})`),
    'Cervical_vertebrae_(C7)'];
  const column = names.map((n) => bones.get(n));
  if (column.some((b) => !b)) return { error: `missing bones: ${names.filter((n, i) => !column[i]).join(', ')}` };
  const short = (n) => (/\((\w+)\)/.exec(n) || [0, n])[1];

  // Freeze every measurement's vertex set at REST.
  const tris = column.map(triple);
  const discs = [];
  for (let k = 0; k + 1 < column.length; k++) {
    const A = column[k], B = column[k + 1];
    const cA = centroidOf(A, indices(A));
    discs.push({ name: `${short(names[k])}/${short(names[k + 1])}`, k, faceB: nearest(B, cA, 0.08) });
  }
  const ord = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
  const sternum = bones.get('Body_of_sternum');
  const manubrium = bones.get('Manubrium_of_sternum');
  const cage = [];
  for (let n = 1; n <= 12; n++) {
    const rib = bones.get(`Rib_(${ord(n)})r`);
    const vb = bones.get(`Thoracic_vertebrae_(T${n})`);
    if (!rib || !vb) continue;
    const vIdx = column.indexOf(vb);
    cage.push({ name: `rib ${n} head`, on: vIdx, b: rib, face: nearest(rib, centroidOf(vb, indices(vb)), 0.05) });
    const cart = bones.get(`Costal_cart_of_${ord(n)}_ribr`);
    if (!cart) continue;
    const cRib = centroidOf(rib, indices(rib)), cCart = centroidOf(cart, indices(cart));
    cage.push({ name: `rib ${n} / cartilage`, pair: [rib, nearest(rib, cCart, 0.04), cart, nearest(cart, cRib, 0.15)] });
    if (n <= 7) {
      const st = n <= 2 ? manubrium : sternum;
      cage.push({ name: `cartilage ${n} / sternum`, onBone: st, b: cart, face: nearest(cart, centroidOf(st, indices(st)), 0.15) });
    }
  }
  const stTri = { s: triple(sternum), m: triple(manubrium) };

  const measure = () => {
    fig.group.updateMatrixWorld(true);
    const frames = column.map((b, i) => frameOf(b, tris[i]));
    return {
      frames,
      discFace: discs.map((d) => centroidOf(column[d.k + 1], d.faceB).applyMatrix4(frames[d.k].clone().invert())),
      cage: cage.map((c) => {
        if (c.pair) return centroidOf(c.pair[0], c.pair[1]).distanceTo(centroidOf(c.pair[2], c.pair[3]));
        const f = c.onBone ? frameOf(c.onBone, c.onBone === sternum ? stTri.s : stTri.m) : frames[c.on];
        return centroidOf(c.b, c.face).applyMatrix4(f.clone().invert());
      }),
    };
  };
  const snapshot = () => column.slice(1, -1).map((b) => Array.from(b.mesh.geometry.attributes.position.array.slice(b.r.start * 3, b.r.start * 3 + 300)));

  const rest = measure();
  const restSnap = snapshot();
  const out = [];
  for (const [label, pose, total] of POSES) {
    fig.resetPose();
    fig.setJointDegrees(pose);
    const m = measure();
    const rot = discs.map((d) => {
      // relative rotation of the upper vertebra in the lower one's frame, vs rest
      const rel = m.frames[d.k].clone().invert().multiply(m.frames[d.k + 1]);
      const rel0 = rest.frames[d.k].clone().invert().multiply(rest.frames[d.k + 1]);
      const e = rel0.invert().multiply(rel).elements;
      return Math.acos(Math.max(-1, Math.min(1, (e[0] + e[5] + e[10] - 1) / 2))) * 180 / Math.PI;
    });
    out.push({
      label, total,
      rot,
      slip: discs.map((d, i) => m.discFace[i].distanceTo(rest.discFace[i]) * 1000),
      cage: cage.map((c, i) => (c.pair ? Math.abs(m.cage[i] - rest.cage[i]) : m.cage[i].distanceTo(rest.cage[i])) * 1000),
      closure: (fig.spineColumn?.closure ?? 0) * 1000,
    });
  }
  fig.resetPose();
  fig.group.updateMatrixWorld(true);
  const back = snapshot();
  let restErr = 0;
  back.forEach((a, i) => a.forEach((x, j) => { restErr = Math.max(restErr, Math.abs(x - restSnap[i][j])); }));
  return { discs: discs.map((d) => d.name), cage: cage.map((c) => c.name), out, restErr, ramps: fig.spineColumn?.ramps, H: fig.height };
}, POSES, !!process.env.NO_SPINE);

const problems = [];
if (result.error) problems.push(result.error);
else {
  if (result.ramps) {
    const f = (r) => r.map((y) => ((y + 0.53 * result.H) / result.H).toFixed(3)).join(' – ');
    console.log(`ramps (fraction of stature): lumbar ${f(result.ramps.spine)}   chest ${f(result.ramps.chest)}`);
  }
  // The share of the whole bend one disc may carry. The old rendering put 100%
  // of a joint in one disc; an even spread over the ~10 discs of a ramp is 10%.
  const SHARE = 0.2;
  // A facing surface's travel in its neighbour's frame. The surfaces found by
  // proximity include the articular processes, ~25 mm behind the disc the pair
  // hinges on, and those legitimately sweep an arc as the disc turns — so the
  // allowance is 3 mm plus that arc for THIS disc's own measured turn.
  const slipTol = (deg) => 3 + 25 * deg * Math.PI / 180;
  const NECK_MM = 0.05; // T1/C7: exact
  const CAGE_MM = 3;
  for (const p of result.out) {
    console.log(`\n${p.label}   (rig total ${p.total}°, closure spread over the column: ${p.closure.toFixed(1)} mm)`);
    console.log(`  disc    ${result.discs.map((d) => d.padStart(7)).join('')}`);
    console.log(`  turn °  ${p.rot.map((x) => x.toFixed(1).padStart(7)).join('')}`);
    console.log(`  slip mm ${p.slip.map((x) => x.toFixed(1).padStart(7)).join('')}`);
    const worstCage = p.cage.reduce((a, x, i) => (x > a[0] ? [x, result.cage[i]] : a), [0, '']);
    console.log(`  ribcage: worst junction ${worstCage[0].toFixed(1)} mm (${worstCage[1]})`);
    p.rot.forEach((x, i) => {
      if (x > SHARE * p.total + 0.5) problems.push(`${p.label}: disc ${result.discs[i]} turns ${x.toFixed(1)}° — ${(100 * x / p.total).toFixed(0)}% of the bend in one joint (tol ${SHARE * 100}%)`);
    });
    p.slip.forEach((x, i) => {
      const last = i === p.slip.length - 1;
      const tol = last ? NECK_MM : slipTol(p.rot[i]);
      if (x > tol) problems.push(`${p.label}: disc ${result.discs[i]} slips ${x.toFixed(2)} mm (tol ${tol.toFixed(1)})`);
    });
    p.cage.forEach((x, i) => {
      if (x > CAGE_MM) problems.push(`${p.label}: ${result.cage[i]} comes apart by ${x.toFixed(1)} mm (tol ${CAGE_MM})`);
    });
  }
  console.log(`\nback at rest the column is off its bind by ${result.restErr.toExponential(1)} m`);
  if (result.restErr > 1e-6) problems.push(`the column does not return to rest (${result.restErr} m)`);
}

if (outDir && !result.error) {
  // Close on the trunk: [name, pose, camera offset from the chest, layer].
  const shots = [
    ['side-front', { spine: { z: 20 }, chest: { z: 25 } }, [0, 0, 1.15], 'skeleton'],
    ['side-back', { spine: { z: 20 }, chest: { z: 25 } }, [0, 0, -1.15], 'skeleton'],
    ['flexion', { spine: { x: 50 }, chest: { x: 30 } }, [1.25, 0, 0.1], 'skeleton'],
    ['extension', { spine: { x: -25 }, chest: { x: -20 } }, [1.25, 0, 0.1], 'skeleton'],
    ['twist-back', { spine: { y: 8 }, chest: { y: 35 } }, [0, 0.2, -1.15], 'skeleton'],
    ['side-muscle', { spine: { z: 20 }, chest: { z: 25 } }, [0, 0, 1.15], 'muscle'],
    ['side-muscle-back', { spine: { z: 20 }, chest: { z: 25 } }, [0, 0, -1.15], 'muscle'],
  ];
  for (const [name, pose, cam, layer] of shots) {
    await page.evaluate((pose, cam, layer, noSpine) => {
      const app = window.__app;
      const fig = app.leader;
      const sel = document.querySelector('#layer-mode');
      sel.value = layer;
      sel.dispatchEvent(new Event('change'));
      fig.group.position.set(0, 0, 0);
      fig.group.rotation.set(0, 0, 0);
      fig.resetPose();
      fig.setJointDegrees(pose);
      if (noSpine) fig.spineColumn = null;
      const t = fig.worldPos('spine');
      t.y += 0.08;
      app.orbit.target.copy(t);
      app.camera.position.set(t.x + cam[0], t.y + cam[1], t.z + cam[2]);
      app.orbit.update();
      app.requestSim?.();
    }, pose, cam, layer, !!process.env.NO_SPINE);
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(outDir, `spine-${name}.png`), clip: { x: 140, y: 90, width: 800, height: 760 } });
  }
}

console.log(problems.length ? `\nPROBLEMS:\n- ${problems.join('\n- ')}` : '\nThe column bends as one curve; discs, neck junction and ribcage hold.');
console.log(errors.length ? `Console errors:\n${errors.join('\n')}` : 'No console errors.');
process.exitCode = problems.length || errors.length ? 1 : 0;
await browser.close();
