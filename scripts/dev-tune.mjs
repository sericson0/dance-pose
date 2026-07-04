// Scratch tool: measure floor lift + foot heights for candidate pose params.
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1200,900'],
});
const page = await browser.newPage();
await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));

// For a figure: apply joints+pelvisY on a reset pose, report per-foot sole
// min height and overall lowest point (group.y forced to 0 → true penetration).
const probe = (figName, joints, pelvisY) => page.evaluate(({ figName, joints, pelvisY }) => {
  const app = window.__app;
  const f = app[figName];
  f.resetPose();
  f.setJointDegrees(joints);
  if (pelvisY) f.nodes.pelvis.position.y = pelvisY * f.height;
  f.group.position.y = 0;
  f.group.updateMatrixWorld(true);
  const low = f.lowestPointY();
  const V3 = f.group.position.constructor;
  const foot = (side) => {
    const H = f.height;
    const corners = side === 'L'
      ? [[-0.03, -0.039, -0.055], [0.03, -0.039, -0.055], [0.038, -0.039, 0.135], [-0.038, -0.039, 0.135]]
      : [[0.03, -0.039, -0.055], [-0.03, -0.039, -0.055], [-0.038, -0.039, 0.135], [0.038, -0.039, 0.135]];
    const node = f.nodes[`ankle_${side}`];
    return corners.map(([x, y, z]) => node.localToWorld(new V3(x * H, y * H, z * H)).y);
  };
  return {
    low: low.toFixed(4),
    L: foot('L').map((v) => +v.toFixed(3)),
    R: foot('R').map((v) => +v.toFixed(3)),
  };
}, { figName, joints, pelvisY });

const cases = JSON.parse(process.argv[2] || '[]');
for (const c of cases) {
  const r = await probe(c.fig, c.joints, c.pelvisY);
  console.log(`${c.name}: low=${r.low} L=[${r.L}] R=[${r.R}]`);
}
await browser.close();
