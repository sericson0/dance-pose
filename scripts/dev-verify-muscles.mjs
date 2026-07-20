// Dev check: bi-articular muscles skin between their two joints. Bends the
// elbow, knee, and hip and confirms the high-weight (far-attachment) vertices
// of the crossing muscles move a lot while the near-attachment vertices barely
// budge, then screenshots the muscle view at rest and posed. Saves to argv[2].
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950', '--use-angle=default'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 20000 });
await new Promise((r) => setTimeout(r, 2500));

// Muscle view, single dancer, framed on the upper body.
await page.evaluate(() => {
  const a = window.__app;
  a.setVisibleFigures('leader');
  const sel = document.getElementById('layer-mode');
  sel.value = 'muscle'; // muscle view = skeleton + muscles
  sel.dispatchEvent(new Event('change'));
});
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: `${outDir}/m-rest.png` });

// Probe: for a muscle crossing `joint` (its nodeB is that joint), record the
// world position of its highest- and lowest-weight vertex, apply `mutate`, then
// report how far each moved. A working skin moves the far vertex a lot and the
// near vertex almost not at all.
const probe = await page.evaluate(() => {
  const a = window.__app;
  const fig = a.leader;
  const info = { count: fig._skinMuscles.length, inserts: {}, results: [] };
  for (const sm of fig._skinMuscles) {
    const key = `${sm.nodeA.userData.jointName}->${sm.nodeB.userData.jointName}`;
    info.inserts[key] = (info.inserts[key] || 0) + 1;
  }
  return info;
});

const measure = await page.evaluate(() => {
  const a = window.__app;
  const fig = a.leader;
  const out = [];

  const pick = (jointName) => fig._skinMuscles.find(
    (sm) => sm.nodeB.userData.jointName === jointName);

  const worldOfVert = (sm, i) => {
    const arr = sm.mesh.geometry.attributes.position.array;
    const v = { x: arr[i * 3], y: arr[i * 3 + 1], z: arr[i * 3 + 2] };
    // mesh is a child of group with identity local transform → group-local ==
    // mesh-local; convert to world via the mesh matrix.
    const m = sm.mesh.matrixWorld.elements;
    return {
      x: m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
      y: m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13],
      z: m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14],
    };
  };
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

  const cases = [
    { joint: 'elbow_L', mut: () => { fig.nodes.elbow_L.rotation.x = 1.4; } },
    { joint: 'knee_L', mut: () => { fig.nodes.knee_L.rotation.x = 1.4; } },
    { joint: 'ankle_L', mut: () => { fig.nodes.ankle_L.rotation.x = 0.6; } },
  ];

  for (const c of cases) {
    const sm = pick(c.joint);
    if (!sm) { out.push({ joint: c.joint, found: false }); continue; }
    // Far vertex = max weight (follows nodeB); near vertex = min weight.
    let hi = 0, lo = 0;
    for (let i = 1; i < sm.weight.length; i++) {
      if (sm.weight[i] > sm.weight[hi]) hi = i;
      if (sm.weight[i] < sm.weight[lo]) lo = i;
    }
    fig.group.updateMatrixWorld(true);
    fig.updateMuscleSkin();
    const farBefore = worldOfVert(sm, hi);
    const nearBefore = worldOfVert(sm, lo);
    a.editJoint(fig, c.joint, c.mut);
    fig.group.updateMatrixWorld(true);
    fig.updateMuscleSkin();
    const farAfter = worldOfVert(sm, hi);
    const nearAfter = worldOfVert(sm, lo);
    // reset
    a.editJoint(fig, c.joint, () => { fig.nodes[c.joint].rotation.set(0, 0, 0); });
    fig.group.updateMatrixWorld(true);
    fig.updateMuscleSkin();
    out.push({
      joint: c.joint, found: true, label: sm.mesh.userData.muscleName,
      farMoved: +dist(farBefore, farAfter).toFixed(4),
      nearMoved: +dist(nearBefore, nearAfter).toFixed(4),
    });
  }
  return out;
});

// ---- Trunk twist (tango dissociation): yaw the chest over a still pelvis and
// confirm the abdominal wall (obliques + rectus) SHEARS — its chest-end vertices
// swing with the twist while its pelvis-end vertices stay anchored, and the two
// sides deform in opposite directions (one belly stretches, the mirror shortens)
// rather than the whole sheet riding along rigidly (the old spine->chest bug). ----
const twist = await page.evaluate(() => {
  const a = window.__app;
  const fig = a.leader;

  const worldVerts = (sm) => {
    const arr = sm.mesh.geometry.attributes.position.array;
    const m = sm.mesh.matrixWorld.elements;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i], y = arr[i + 1], z = arr[i + 2];
      out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return out;
  };

  // Abdominal-wall bellies: both obliques + rectus, each skinned pelvis->chest.
  const abs = fig._skinMuscles.filter(
    (sm) => /oblique|rectus abdominal/i.test(sm.mesh.userData.muscleName));

  fig.group.updateMatrixWorld(true);
  fig.updateMuscleSkin();
  const before = abs.map(worldVerts);

  a.editJoint(fig, 'chest', () => { fig.nodes.chest.rotation.y = (30 * Math.PI) / 180; });
  fig.group.updateMatrixWorld(true);
  fig.updateMuscleSkin();
  const after = abs.map(worldVerts);

  const rows = abs.map((sm, k) => {
    const b = before[k], f = after[k];
    const n = b.length / 3;
    let cx = 0; const ys = [];
    for (let i = 0; i < b.length; i += 3) { cx += b[i]; ys.push(b[i + 1]); }
    cx /= n;
    ys.sort((p, q) => p - q);
    const yMid = ys[Math.floor(n / 2)]; // split top (rib/chest) vs bottom (pelvis)
    let topDisp = 0, botDisp = 0, topN = 0, botN = 0, topDZ = 0;
    for (let i = 0; i < b.length; i += 3) {
      const dx = f[i] - b[i], dy = f[i + 1] - b[i + 1], dz = f[i + 2] - b[i + 2];
      const d = Math.hypot(dx, dy, dz);
      if (b[i + 1] >= yMid) { topDisp += d; topDZ += dz; topN++; }
      else { botDisp += d; botN++; }
    }
    return {
      name: sm.mesh.userData.muscleName, side: cx >= 0 ? 'R' : 'L', cx: +cx.toFixed(3),
      topDisp: +(topDisp / Math.max(topN, 1)).toFixed(4),
      botDisp: +(botDisp / Math.max(botN, 1)).toFixed(4),
      topDZ: +(topDZ / Math.max(topN, 1)).toFixed(4),
    };
  });

  a.editJoint(fig, 'chest', () => { fig.nodes.chest.rotation.set(0, 0, 0); });
  fig.group.updateMatrixWorld(true);
  fig.updateMuscleSkin();
  return { count: abs.length, rows };
});

// Twist screenshots (top view reads the dissociation clearest).
for (const [view, chestY, tag] of [
  ['top', 0, 'twist-rest-top'], ['front', 0, 'twist-rest-front'],
  ['top', 30, 'twist-top'], ['front', 30, 'twist-front'],
]) {
  await page.evaluate(({ view, chestY }) => {
    const a = window.__app, fig = a.leader;
    a.editJoint(fig, 'chest', () => { fig.nodes.chest.rotation.y = (chestY * Math.PI) / 180; });
    a.setView(view);
  }, { view, chestY });
  await new Promise((r) => setTimeout(r, 350));
  await page.screenshot({ path: `${outDir}/m-${tag}.png` });
}
await page.evaluate(() => {
  const a = window.__app, fig = a.leader;
  a.editJoint(fig, 'chest', () => { fig.nodes.chest.rotation.set(0, 0, 0); });
  a.setView('three');
});

// Now pose several joints for a visual and screenshot.
await page.evaluate(() => {
  const a = window.__app;
  const fig = a.leader;
  a.editJoint(fig, 'elbow_L', () => { fig.nodes.elbow_L.rotation.x = 1.4; });
  a.editJoint(fig, 'shoulder_L', () => { fig.nodes.shoulder_L.rotation.z = -1.0; });
  a.editJoint(fig, 'knee_L', () => { fig.nodes.knee_L.rotation.x = 1.2; });
});
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: `${outDir}/m-posed.png` });

console.log(`skinned muscles: ${probe.count}`);
console.log('spans:', JSON.stringify(probe.inserts, null, 0));
console.log('deformation (world units):');
for (const r of measure) {
  if (!r.found) { console.log(`  ${r.joint}: NO SKINNED MUSCLE FOUND`); continue; }
  console.log(`  ${r.joint} (${r.label}): far vtx moved ${r.farMoved}, near vtx moved ${r.nearMoved}`);
}

console.log(`\ntrunk twist — abdominal wall shear (chest yaw 30deg, ${twist.count} bellies):`);
let twistOk = twist.count >= 4; // 2 obliques + rectus, each mirrored L/R
if (!twistOk) console.log('  ASSERT FAIL: expected >=4 abdominal bellies skinned (obliques + rectus, L/R)');
for (const r of twist.rows) {
  console.log(`  ${r.name} [${r.side}] cx=${r.cx}: chest-end moved ${r.topDisp}, pelvis-end moved ${r.botDisp}, chest-end dZ ${r.topDZ}`);
  // Shear: the chest (rib) end swings with the twist, the pelvis end stays put.
  if (!(r.topDisp > 0.01 && r.topDisp > 2 * r.botDisp)) {
    console.log(`    ASSERT FAIL: ${r.name}[${r.side}] rides rigidly (chest-end ${r.topDisp} not >> pelvis-end ${r.botDisp})`);
    twistOk = false;
  }
}
// Asymmetry: for each oblique the two sides swing their chest-ends in opposite
// directions (dZ opposite sign) — the essence of dissociation stretch.
const byName = {};
for (const r of twist.rows) (byName[r.name] ||= []).push(r);
for (const [name, rows] of Object.entries(byName)) {
  if (!/oblique/i.test(name)) continue;
  const L = rows.find((x) => x.side === 'L'), R = rows.find((x) => x.side === 'R');
  if (!L || !R) { console.log(`  ASSERT FAIL: ${name} missing an L/R side`); twistOk = false; continue; }
  if (L.topDZ * R.topDZ < 0) {
    console.log(`  ${name}: asymmetric OK (L dZ ${L.topDZ} vs R dZ ${R.topDZ})`);
  } else {
    console.log(`  ASSERT FAIL: ${name} sides not asymmetric (L dZ ${L.topDZ}, R dZ ${R.topDZ})`);
    twistOk = false;
  }
}
console.log(twistOk ? 'twist: PASS' : 'twist: FAIL');

console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
