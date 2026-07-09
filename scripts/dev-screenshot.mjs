// Dev check: screenshots of each view + the new controls. Saves to argv[2].
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
await page.screenshot({ path: `${outDir}/a-body.png` });

const setLayers = (sk, bo, mu) => page.evaluate((s, b, m) => {
  document.getElementById('layer-skeleton').checked = s;
  document.getElementById('layer-body').checked = b;
  document.getElementById('layer-muscle').checked = m;
  for (const id of ['layer-skeleton', 'layer-body', 'layer-muscle'])
    document.getElementById(id).dispatchEvent(new Event('change'));
}, sk, bo, mu);

// Skeleton only, zoomed on one dancer.
await setLayers(true, false, false);
await page.evaluate(() => window.__app.setVisibleFigures('leader'));
await page.evaluate(() => {
  const a = window.__app;
  a.camera.position.set(0.6, 1.4, 1.9);
  a.orbit.target.set(-0.35, 1.0, 0);
});
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: `${outDir}/b-skeleton.png` });

// Muscles only.
await setLayers(false, false, true);
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${outDir}/c-muscle.png` });

// Closed-chain: bend the leader's knee, foot should stay planted.
await page.evaluate(() => {
  const a = window.__app;
  a.setVisibleFigures('leader');
  a.selectJoint(a.leader, 'knee_L'); // selecting a leg joint auto-picks a chain mode…
  a.setChainMode('closed');          // …so force closed chain after selecting.
  a.editJoint(a.leader, 'knee_L', () => { a.leader.nodes.knee_L.rotation.x = 1.0; });
});
await setLayers(false, true, false);
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${outDir}/d-closedchain.png` });

console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
