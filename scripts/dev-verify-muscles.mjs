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
  document.getElementById('layer-body').checked = false;
  document.getElementById('layer-muscle').checked = true;
  for (const id of ['layer-body', 'layer-muscle'])
    document.getElementById(id).dispatchEvent(new Event('change'));
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
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
