// Dev check for the KNEE's rigging: does the knee cap stay on the femur?
//
// The patella is a sesamoid in the quadriceps tendon that glides in the
// femoral trochlear groove — it rides the THIGH and does not swing round with
// the tibia. It used to be classified with tibia/fibula onto the `knee` node
// (i.e. welded to the shin), which made it slide and turn as the knee bent;
// visible in the hip-flexion clip, whose row drives the knee to 110° alongside
// the hip.
//
// A centroid alone cannot see this: the patella sits close to the knee's
// rotation centre, so welded to the wrong segment it mostly SPINS IN PLACE.
// The orientation check is the one that catches it (22.2° -> 0.0°).
//
// Honours DEV_URL (default http://localhost:5173).
import puppeteer from 'puppeteer-core';

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2600));

const probe = await page.evaluate(async () => {
  const app = window.__app;
  const fig = app.leader;
  // No THREE on the page object; borrow a Vector3 from the scene graph.
  const V = (x = 0, y = 0, z = 0) => fig.group.position.clone().set(x, y, z);
  app.applyPreset(0);

  // Find the merged skeleton mesh holding the left patella, and which node it
  // hangs off.
  let found = null;
  fig.group.traverse((o) => {
    const ranges = o.userData?.boneRanges;
    if (!ranges || found) return;
    for (const r of ranges) {
      if (/patella/i.test(r.name) && r.side !== 'R') {
        found = { mesh: o, range: r };
        return;
      }
    }
  });
  if (!found) return { error: 'no left patella range found' };

  const centroid = (mesh, range) => {
    const pos = mesh.geometry.attributes.position;
    const v = V();
    const acc = V();
    for (let i = range.start; i < range.start + range.count; i++) {
      v.fromBufferAttribute(pos, i);
      acc.add(v);
    }
    acc.multiplyScalar(1 / range.count);
    return mesh.localToWorld(acc);
  };

  // Which node does the patella mesh actually hang off?
  let owner = found.mesh;
  const chain = [];
  while (owner && owner !== fig.group) {
    if (owner.name) chain.push(owner.name);
    owner = owner.parent;
  }

  // The femur's own geometry, so the patella can be judged against the bone it
  // is supposed to sit on rather than against a rig node.
  let femur = null;
  fig.group.traverse((o) => {
    const ranges = o.userData?.boneRanges;
    if (!ranges || femur) return;
    for (const r of ranges) {
      if (/femur/i.test(r.name) && r.side !== 'R') { femur = { mesh: o, range: r }; return; }
    }
  });

  // Centroid of the third of the femur nearest the knee — its distal end, i.e.
  // the trochlear groove the patella rides in.
  const femurDistal = () => {
    const pos = femur.mesh.geometry.attributes.position;
    const v = V();
    const pts = [];
    for (let i = femur.range.start; i < femur.range.start + femur.range.count; i++) {
      v.fromBufferAttribute(pos, i);
      pts.push(femur.mesh.localToWorld(v.clone()));
    }
    const knee = fig.worldPos('knee_L', V());
    pts.sort((a, b) => a.distanceTo(knee) - b.distanceTo(knee));
    const keep = pts.slice(0, Math.max(1, Math.floor(pts.length / 3)));
    const acc = V();
    for (const p of keep) acc.add(p);
    return acc.multiplyScalar(1 / keep.length);
  };

  // A patella is a flat disc: welded to the wrong segment it SPINS IN PLACE,
  // which a centroid cannot see. Track its orientation instead — the vector
  // from its centroid to its farthest vertex, expressed in the femur's own
  // frame. Glued to the femur that vector is constant; carried by the shin it
  // turns through the whole knee-flexion angle.
  const patellaAxisInFemur = () => {
    const pos = found.mesh.geometry.attributes.position;
    const v = V();
    const c = centroid(found.mesh, found.range);
    let best = null;
    let bestD = -1;
    for (let i = found.range.start; i < found.range.start + found.range.count; i++) {
      v.fromBufferAttribute(pos, i);
      const w = found.mesh.localToWorld(v.clone());
      const d = w.distanceTo(c);
      if (d > bestD) { bestD = d; best = w; }
    }
    const femurNode = fig.surfaceNode ? fig.surfaceNode('hip_L') : fig.nodes.hip_L;
    const a = femurNode.worldToLocal(c.clone());
    const bvec = femurNode.worldToLocal(best.clone());
    return bvec.sub(a).normalize();
  };

  const sample = (label, pose) => {
    fig.resetPose();
    if (pose) fig.setJointDegrees(pose);
    fig.syncAtlasNodes();
    fig.group.updateMatrixWorld(true);
    const p = centroid(found.mesh, found.range);
    const fd = femur ? femurDistal() : null;
    return {
      label,
      distKnee: +p.distanceTo(fig.worldPos('knee_L', V())).toFixed(4),
      distHip: +p.distanceTo(fig.worldPos('hip_L', V())).toFixed(4),
      // THE measurement: how far the knee cap sits from the distal femur it
      // is supposed to be glued to. Constant = welded; growing = sliding.
      offFemur: fd ? +p.distanceTo(fd).toFixed(4) : null,
      axis: patellaAxisInFemur().toArray(),
    };
  };

  // The hp_flex clip drives hip -120 AND knee 110 together, so those are the
  // poses that matter here, not hip flexion alone.
  const out = [
    sample('rest', null),
    sample('hip -60 only', { hip_L: { x: -60 } }),
    sample('hip -120 only', { hip_L: { x: -120 } }),
    sample('knee 55 only', { knee_L: { x: 55 } }),
    sample('knee 110 only', { knee_L: { x: 110 } }),
    sample('clip mid', { hip_L: { x: -60 }, knee_L: { x: 55 } }),
    sample('clip end', { hip_L: { x: -120 }, knee_L: { x: 110 } }),
  ];
  fig.resetPose();
  return { chain, boneName: found.range.name, femurFound: !!femur, samples: out };
});

if (probe.error) {
  console.log(`PROBE FAILED: ${probe.error}`);
} else {
  console.log(`patella bone: "${probe.boneName}"  femur found: ${probe.femurFound}`);
  console.log('');
  console.log('pose             off-femur(cm)   to-knee(cm)  to-hip(cm)');
  const base = probe.samples[0].offFemur;
  for (const s of probe.samples) {
    const d = s.offFemur === null ? '  n/a' : (s.offFemur * 100).toFixed(1).padStart(6);
    const delta = s.offFemur === null ? '' : `   (${((s.offFemur - base) * 100 >= 0 ? '+' : '')}${((s.offFemur - base) * 100).toFixed(1)})`;
    console.log(`${s.label.padEnd(16)} ${d}${delta.padEnd(10)}  ${(s.distKnee * 100).toFixed(1).padStart(6)}      ${(s.distHip * 100).toFixed(1).padStart(6)}`);
  }
  const worst = Math.max(...probe.samples.map((s) => Math.abs((s.offFemur ?? base) - base)));
  console.log('');
  console.log(`Worst separation from the distal femur: ${(worst * 100).toFixed(1)} cm`);

  console.log('');
  console.log("ORIENTATION — how far the knee cap has TURNED inside the femur's frame:");
  const a0 = probe.samples[0].axis;
  let worstTurn = 0;
  for (const s of probe.samples) {
    const dot = Math.max(-1, Math.min(1, s.axis.reduce((acc, n, i) => acc + n * a0[i], 0)));
    const deg = (Math.acos(dot) * 180) / Math.PI;
    worstTurn = Math.max(worstTurn, deg);
    console.log(`  ${s.label.padEnd(16)} ${deg.toFixed(1).padStart(6)}°`);
  }
  console.log('');
  // The knee cap is rigidly part of the thigh here, so both numbers should be
  // ~0. The tolerances are loose enough to absorb the femur-centroid reference
  // shifting slightly as the hip swings, and far tighter than the 22°/1.5 cm
  // the shin-welded version produced.
  const problems = [];
  if (worstTurn > 3) problems.push(`knee cap turns ${worstTurn.toFixed(1)}° inside the femur's frame (tol 3°) — it is riding the shin, not the thigh`);
  if (worst > 0.01) problems.push(`knee cap slides ${(worst * 100).toFixed(1)} cm off the distal femur (tol 1.0 cm)`);
  console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'Knee cap rides the femur through hip and knee flexion.');
  process.exitCode = problems.length ? 1 : 0;
}
await browser.close();
