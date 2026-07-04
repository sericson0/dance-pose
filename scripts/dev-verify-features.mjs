// Dev check for weight/tango stats, A→B interpolation + COG path, ghosts,
// pivot tool, and the new vocabulary presets. Screenshots + console errors +
// numeric diagnostics (clamp lift must stay ~0, pivot must pin the foot).
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

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. New presets: apply each, check the floor clamp didn't lift anyone.
const newPresets = ['Back ocho', 'Colgada', 'Volcada', 'Parada', 'Giro'];
for (const prefix of newPresets) {
  const diag = await page.evaluate(async (pfx) => {
    const app = window.__app;
    const i = app.presets.findIndex((p) => p.name.startsWith(pfx));
    if (i < 0) return { error: `preset ${pfx} not found` };
    app.applyPreset(i);
    await new Promise((r) => setTimeout(r, 350)); // let clampToFloor run
    const stats = document.getElementById('stats-panel').innerText.replace(/\n/g, ' | ');
    return {
      liftL: app.leader.group.position.y,
      liftF: app.follower.group.position.y,
      stats,
    };
  }, prefix);
  if (diag.error) { problems.push(diag.error); continue; }
  const slug = prefix.toLowerCase().replace(/[^a-z]+/g, '-');
  await sleep(150);
  await page.screenshot({ path: `${outDir}/preset-${slug}.png` });
  if (Math.abs(diag.liftL) > 0.02 || Math.abs(diag.liftF) > 0.02) {
    problems.push(`${prefix}: clamp lift L=${diag.liftL.toFixed(3)} F=${diag.liftF.toFixed(3)}`);
  }
  console.log(`--- ${prefix}\n    lift L=${diag.liftL.toFixed(3)} F=${diag.liftF.toFixed(3)}\n    ${diag.stats}`);
}

// ---- 2. Weight stats on the standing pose: expect a roughly even split.
const weightText = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  await new Promise((r) => setTimeout(r, 350));
  return document.getElementById('stats-panel').innerText;
});
if (!/Weight L \/ R/.test(weightText)) problems.push('weight line missing from stats');
if (!/Dissociation/.test(weightText)) problems.push('dissociation line missing from stats');
console.log('--- Standing stats\n' + weightText.split('\n').slice(0, 12).join(' | '));

// ---- 3. Interpolation: A = standing, B = walk; scrub to 50%, ghosts on.
await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  document.getElementById('snap-a').click();
  const iWalk = app.presets.findIndex((p) => p.name.startsWith('Walk'));
  app.applyPreset(iWalk);
  document.getElementById('snap-b').click();
});
await sleep(300);
const interpState = await page.evaluate(() => {
  const slider = document.getElementById('interp-slider');
  slider.value = 500;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  return {
    rowHidden: document.getElementById('interp-row').hidden,
    playDisabled: document.getElementById('interp-play').disabled,
    hasInterp: !!window.__app.interpStates,
  };
});
if (interpState.rowHidden || interpState.playDisabled || !interpState.hasInterp) {
  problems.push(`interp not armed: ${JSON.stringify(interpState)}`);
}
await sleep(300);
await page.screenshot({ path: `${outDir}/interp-half.png` });

const ghostState = await page.evaluate(() => {
  const a = document.getElementById('ghost-a');
  a.checked = true;
  a.dispatchEvent(new Event('change', { bubbles: true }));
  return { ghostA: !!window.__app.ghosts.A };
});
if (!ghostState.ghostA) problems.push('ghost A did not build');
await sleep(300);
await page.screenshot({ path: `${outDir}/ghost-a.png` });

// ---- 4. Play A→B end-to-end.
await page.evaluate(() => document.getElementById('interp-play').click());
await sleep(3000);
const playDone = await page.evaluate(() => ({
  t: window.__app.interpT, playing: window.__app.interpPlaying,
}));
if (playDone.playing || playDone.t < 1) problems.push(`play did not finish: ${JSON.stringify(playDone)}`);
await page.screenshot({ path: `${outDir}/interp-end.png` });

// ---- 5. Pivot: rotate the leader 45° about the ball of the support foot.
const pivotDiag = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  const ankle = app.supportAnkle(app.leader);
  const before = app.ballOfFoot(app.leader, ankle).clone();
  app.pivotFigure(app.leader, Math.PI / 4);
  const after = app.ballOfFoot(app.leader, ankle);
  return {
    drift: Math.hypot(after.x - before.x, after.z - before.z),
    yaw: app.leader.group.rotation.y,
  };
});
if (pivotDiag.drift > 1e-4) problems.push(`pivot foot drifted ${pivotDiag.drift.toFixed(5)} m`);
console.log(`--- Pivot: foot drift ${pivotDiag.drift.toExponential(2)} m, yaw ${(pivotDiag.yaw * 180 / Math.PI).toFixed(1)}°`);
await sleep(200);
await page.screenshot({ path: `${outDir}/pivot.png` });

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
