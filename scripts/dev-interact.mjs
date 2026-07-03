// Dev check: exercises selection, gizmos, IK, and the A/B compare through
// window.__app, saving screenshots to the directory given as argv[2].
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 20000 });
await new Promise((r) => setTimeout(r, 2000));

// 1. Select a knee: rotate gizmo + sliders should appear.
await page.evaluate(() => window.__app.selectJoint(window.__app.leader, 'knee_L'));
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${outDir}/5-joint-selected.png` });

// 2. IK: drag the follower's left hand forward and up.
await page.evaluate(() => {
  const app = window.__app;
  app.startIK(app.follower, 'wrist_L');
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: `${outDir}/6-ik-target.png` });

// 3. A/B compare: snapshot, bend a knee + arm, snapshot, table should list deltas.
await page.evaluate(() => {
  document.getElementById('snap-a').click();
  const app = window.__app;
  app.deselect();
  app.leader.setJointDegrees({ knee_L: { x: 60 }, hip_L: { x: -45 }, spine: { x: 15 } });
  document.getElementById('snap-b').click();
});
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${outDir}/7-compare.png` });

console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
