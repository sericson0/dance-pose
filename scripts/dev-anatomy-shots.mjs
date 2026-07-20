// Close-up screenshots of the new leg/foot anatomy in each layer.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const outDir = process.argv[2] || '.';
mkdirSync(outDir, { recursive: true });
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
await new Promise((r) => setTimeout(r, 2000));

// The three layers are one dropdown: body | skeleton | muscle (muscle shows the
// skeleton behind it). Kept as an (sk, bo, mu) helper so the call sites read the
// same as before.
const setLayers = (sk, bo, mu) => page.evaluate((mode) => {
  const sel = document.getElementById('layer-mode');
  sel.value = mode;
  sel.dispatchEvent(new Event('change'));
}, mu ? 'muscle' : (sk ? 'skeleton' : 'body'));

// Aim at a point between two joints (world space) from a relative offset.
const aim = (jointA, jointB, lerp, ox, oy, oz) => page.evaluate((ja, jb, t, x, y, z) => {
  const a = window.__app;
  const pa = a.leader.worldPos(ja);
  const pb = a.leader.worldPos(jb);
  const tgt = pa.clone().lerp(pb, t);
  a.orbit.target.copy(tgt);
  a.camera.position.set(tgt.x + x, tgt.y + y, tgt.z + z);
}, jointA, jointB, lerp, ox, oy, oz);

await page.evaluate(() => window.__app.setVisibleFigures('leader'));
const shot = async (name) => {
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${outDir}/${name}.png` });
};

// Legs, skeleton layer.
await setLayers(true, false, false);
await aim('hip_L', 'ankle_L', 0.55, 0.3, 0.25, 1.0);
await shot('sk-legs-front');
await aim('hip_L', 'ankle_L', 0.55, 1.0, 0.2, 0.25);
await shot('sk-legs-side');
// Feet close-up, skeleton.
await aim('ankle_L', 'ankle_R', 0.5, 0.15, 0.35, 0.65);
await shot('sk-feet-front');
await aim('ankle_L', 'ankle_R', 0.5, 0.5, 0.18, 0.45);
await shot('sk-feet-34');
// Body layer.
await setLayers(false, true, false);
await aim('hip_L', 'ankle_L', 0.5, 0.35, 0.25, 1.1);
await shot('body-legs-front');
await aim('hip_L', 'ankle_L', 0.5, 1.1, 0.15, 0.35);
await shot('body-legs-side');
await aim('ankle_L', 'ankle_R', 0.5, 0.3, 0.25, 0.65);
await shot('body-feet');
// Muscle layer.
await setLayers(false, false, true);
await aim('hip_L', 'ankle_L', 0.5, 0.8, 0.3, 0.7);
await shot('muscle-legs');
// Pelvis close-ups, skeleton.
await setLayers(true, false, false);
await aim('pelvis', 'pelvis', 0, 0.25, 0.2, 0.55);
await shot('sk-pelvis-front');
await aim('pelvis', 'pelvis', 0, 0.45, 0.15, -0.45);
await shot('sk-pelvis-back');
// Shoulder girdle close-ups, skeleton.
await aim('chest', 'neck', 0.9, 0.3, 0.15, 0.5);
await shot('sk-shoulders-front');
await aim('chest', 'neck', 0.9, 0.4, 0.2, -0.5);
await shot('sk-shoulders-back');
// Pointed trailing foot in skeleton view.
await setLayers(true, false, false);
await page.evaluate(() => {
  const a = window.__app;
  a.setChainMode('open');
  a.editJoint(a.leader, 'ankle_L', () => { a.leader.setJointDegrees({ hip_L: { x: 15 }, knee_L: { x: 36 }, ankle_L: { x: 33 } }); });
});
await aim('knee_L', 'toe_L', 0.6, 0.6, 0.25, 0.6);
await shot('sk-pointed');

console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
