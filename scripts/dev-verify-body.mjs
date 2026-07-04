// Dev check: the imported clothed body avatars (man.glb / woman.glb) load,
// retarget onto the joint rig, keep their soles on the floor at rest, and
// deform with the joints (knee bend moves foot verts, not head verts).
// Usage: node scripts/dev-verify-body.mjs <outDir>   (dev server must be running)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-body';
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

const problems = [];

const report = await page.evaluate(() => {
  const app = window.__app;
  const out = { figures: [] };
  for (const fig of app.figures) {
    fig.resetPose();
    fig.group.position.set(0, 0, 0);
    fig.group.rotation.set(0, 0, 0);
    fig.group.updateMatrixWorld(true);
    const skinned = fig.layerMeshes.body.filter((m) => m.isSkinnedMesh);
    const r = { name: fig.name, skinnedMeshes: skinned.length };
    if (skinned.length) {
      // Min/max world y over all skinned vertices at rest (sole must graze 0).
      const v = new (Object.getPrototypeOf(fig.group.position).constructor)();
      let minY = Infinity;
      let maxY = -Infinity;
      for (const mesh of skinned) {
        mesh.updateMatrixWorld(true);
        const n = mesh.geometry.attributes.position.count;
        for (let i = 0; i < n; i++) {
          mesh.getVertexPosition(i, v);
          if (v.y < minY) minY = v.y;
          if (v.y > maxY) maxY = v.y;
        }
      }
      r.restMinY = minY;
      r.restMaxY = maxY;
      // Bend the left knee 90°: foot-region verts must move, head verts must not.
      const probe = (mesh, idx) => mesh.getVertexPosition(idx, v).clone();
      const mesh = skinned[0];
      const pos = mesh.geometry.attributes.position;
      let footIdx = 0;
      let headIdx = 0;
      for (let i = 0; i < pos.count; i++) {
        mesh.getVertexPosition(i, v);
        if (v.y < mesh.getVertexPosition(footIdx, new v.constructor()).y) footIdx = i;
        if (v.y > mesh.getVertexPosition(headIdx, new v.constructor()).y) headIdx = i;
      }
      const footBefore = probe(mesh, footIdx);
      const headBefore = probe(mesh, headIdx);
      fig.setJointDegrees({ knee_L: { x: 90 }, knee_R: { x: 90 } });
      fig.group.updateMatrixWorld(true);
      r.footMoved = probe(mesh, footIdx).distanceTo(footBefore);
      r.headMoved = probe(mesh, headIdx).distanceTo(headBefore);
      fig.resetPose();
    }
    out.figures.push(r);
  }
  return out;
});

for (const f of report.figures) {
  if (!f.skinnedMeshes) { problems.push(`${f.name}: no skinned body mesh (fell back to mannequin?)`); continue; }
  if (f.restMinY < -0.01) problems.push(`${f.name}: body sinks ${(-f.restMinY * 100).toFixed(1)} cm below the floor at rest`);
  if (f.restMinY > 0.03) problems.push(`${f.name}: body floats ${(f.restMinY * 100).toFixed(1)} cm above the floor at rest`);
  if (f.footMoved < 0.05) problems.push(`${f.name}: knee bend barely moved the foot (${f.footMoved.toFixed(3)} m)`);
  if (f.headMoved > 0.01) problems.push(`${f.name}: knee bend moved the head (${f.headMoved.toFixed(3)} m)`);
  console.log(`${f.name}: skinned=${f.skinnedMeshes} restY=[${f.restMinY.toFixed(3)}, ${f.restMaxY.toFixed(3)}] kneeBend foot=${f.footMoved.toFixed(3)} head=${f.headMoved.toFixed(4)}`);
}

async function shot(name, fn) {
  await page.evaluate(fn);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${outDir}/${name}.png` });
}
await shot('body-front', () => {
  const a = window.__app;
  a.figures.forEach((f) => f.resetPose());
  a.applyPreset(1);
  a.setVisibleFigures('both');
  a.camera.position.set(0, 1.3, 3.0);
  a.orbit.target.set(0, 1.0, 0);
});
await shot('body-side', () => {
  const a = window.__app;
  a.camera.position.set(2.8, 1.3, 0.2);
  a.orbit.target.set(0, 1.0, 0);
});

if (problems.length) console.log('PROBLEMS:\n' + problems.join('\n'));
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.');
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
