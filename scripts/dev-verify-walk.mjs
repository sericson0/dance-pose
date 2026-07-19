// Dev check for the walk/step tool, whole-figure Move consolidation, legs-only
// contextual chain mode, and the sidebar tidy-ups. Verifies stepping travels
// forward while staying grounded (the floor clamp must not lift the dancer),
// feet alternate, the couple walks together, keyboard nudges drive the active
// figure, and the chain toggle only appears for the legs. Screenshots + console
// errors + numeric diagnostics.
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

// ---- 1. Top bar: Move + Walk exist, Turn/Pivot are gone, chain group removed.
const modes = await page.evaluate(() => ({
  modes: [...document.querySelectorAll('#mode-buttons button')].map((b) => b.dataset.mode),
  chainGroup: !!document.getElementById('chain-buttons'),
}));
if (!modes.modes.includes('step')) problems.push('no Walk/Step mode button');
if (modes.modes.includes('turn') || modes.modes.includes('pivot')) problems.push(`stale modes: ${modes.modes}`);
if (modes.chainGroup) problems.push('global chain-buttons group still present');
console.log(`--- modes: [${modes.modes.join(', ')}], chain group removed: ${!modes.chainGroup}`);

// ---- 2. Walk forward from standing: travels forward, stays grounded, alternates.
const walk = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);            // Standing (reset)
  app.linkCouple = false;
  app.setVisibleFigures('leader');
  await new Promise((r) => setTimeout(r, 200));
  const f = app.leader;
  const start = { x: f.group.position.x, z: f.group.position.z };
  const steps = [];
  for (let i = 0; i < 5; i++) {
    app.stepFigure(f, 1);
    await new Promise((r) => setTimeout(r, 60)); // let the loop clamp/settle
    steps.push({
      low: +f.lowestPointY().toFixed(4),      // ~0 = feet on the floor
      swing: f.__swing,                        // which foot just stepped
      dist: +Math.hypot(f.group.position.x - start.x, f.group.position.z - start.z).toFixed(3),
    });
  }
  return { steps };
});
{
  const s = walk.steps;
  const travel = s[s.length - 1].dist;
  const worstLow = Math.max(...s.map((x) => Math.abs(x.low)));
  const order = s.map((x) => x.swing).join('');
  const alternates = s.every((x, i) => i === 0 || x.swing !== s[i - 1].swing);
  console.log(`--- Walk 5 steps: travel ${travel} m, swing order ${order}, worst |lowestY| ${worstLow}`);
  if (travel < 0.4) problems.push(`walk barely advanced (${travel} m over 5 steps)`);
  if (worstLow > 0.015) problems.push(`walk not grounded (|lowestY| up to ${worstLow})`);
  if (!alternates) problems.push(`walk did not alternate feet (swing order ${order})`);
}
await sleep(150);
await page.screenshot({ path: `${outDir}/walk-solo.png` });

// ---- 3. Couple walk: both dancers travel together, chest distance held.
const couple = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(1);            // Close embrace
  app.setVisibleFigures('both');
  app.linkCouple = true;
  document.getElementById('embrace-close').checked = true;
  document.getElementById('embrace-close').dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const L = app.leader, F = app.follower;
  const chest = () => L.worldPos('chest').distanceTo(F.worldPos('chest'));
  const lStart = { x: L.group.position.x, z: L.group.position.z };
  const fStart = { x: F.group.position.x, z: F.group.position.z };
  const chestBefore = chest();
  for (let i = 0; i < 4; i++) { app.stepFigure(L, 1); await new Promise((r) => setTimeout(r, 80)); }
  return {
    leaderTravel: +Math.hypot(L.group.position.x - lStart.x, L.group.position.z - lStart.z).toFixed(3),
    followerTravel: +Math.hypot(F.group.position.x - fStart.x, F.group.position.z - fStart.z).toFixed(3),
    chestBefore: +chestBefore.toFixed(3),
    chestAfter: +chest().toFixed(3),
    liftL: +L.group.position.y.toFixed(4),
    liftF: +F.group.position.y.toFixed(4),
  };
});
console.log(`--- Couple walk: leader ${couple.leaderTravel} m, follower ${couple.followerTravel} m, chest ${couple.chestBefore}→${couple.chestAfter} m`);
if (couple.followerTravel < 0.3) problems.push(`follower did not walk with the couple (${couple.followerTravel} m)`);
// Mid-stride the couple legitimately rests a few cm wider than standing
// contact: the interleaved stepping legs brush thigh-on-thigh (COLLIDERS)
// and the torso pull stops at that surface rest. What must NOT happen is
// unbounded drift — the gap has to stay near the leg-brush equilibrium.
if (Math.abs(couple.chestAfter - couple.chestBefore) > 0.12) problems.push(`couple walk broke chest contact (${couple.chestBefore}→${couple.chestAfter})`);
if (Math.abs(couple.liftL) > 0.03 || Math.abs(couple.liftF) > 0.03) problems.push(`couple walk lifted a dancer (L ${couple.liftL}, F ${couple.liftF})`);
await sleep(150);
await page.screenshot({ path: `${outDir}/walk-couple.png` });

// ---- 4. Keyboard nudges in Move mode: arrows slide/turn the active figure,
// and the turn pivots on the support foot.
const keys = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  app.linkCouple = false;
  document.getElementById('embrace-hands').checked = false;
  document.getElementById('embrace-hands').dispatchEvent(new Event('change', { bubbles: true }));
  app.setVisibleFigures('leader');
  document.querySelector('#mode-buttons button[data-mode="move"]').click();
  app.selectFigure(app.leader);      // becomes the active figure
  const f = app.leader;
  const p0 = { x: f.group.position.x, z: f.group.position.z, yaw: f.group.rotation.y };
  const press = (key, shiftKey = false) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  press('ArrowUp'); press('ArrowUp');
  const afterSlide = { x: f.group.position.x, z: f.group.position.z };
  const ankle = app.supportAnkle(f);
  const ballBefore = app.ballOfFoot(f, ankle).clone();
  press('ArrowLeft'); press('ArrowLeft');
  const ballAfter = app.ballOfFoot(f, ankle);
  return {
    slid: +Math.hypot(afterSlide.x - p0.x, afterSlide.z - p0.z).toFixed(4),
    turned: +((f.group.rotation.y - p0.yaw) * 180 / Math.PI).toFixed(2),
    footDrift: +Math.hypot(ballAfter.x - ballBefore.x, ballAfter.z - ballBefore.z).toFixed(5),
    active: app.activeFigure === f,
  };
});
console.log(`--- Keyboard: slid ${keys.slid} m, turned ${keys.turned}°, pivot-foot drift ${keys.footDrift} m`);
if (!keys.active) problems.push('activeFigure not set by selectFigure');
if (keys.slid < 0.03) problems.push(`ArrowUp did not slide the figure (${keys.slid} m)`);
if (Math.abs(keys.turned) < 3) problems.push(`ArrowLeft did not turn the figure (${keys.turned}°)`);
if (keys.footDrift > 1e-3) problems.push(`keyboard turn did not pivot on the foot (drift ${keys.footDrift} m)`);

// ---- 5. Legs-only contextual chain: leg joint shows the toggle + auto-picks a
// mode; an arm joint hides it and forces open chain.
const chain = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  app.setVisibleFigures('leader');
  document.querySelector('#mode-buttons button[data-mode="rotate"]').click();
  app.selectJoint(app.leader, 'knee_L');
  await new Promise((r) => setTimeout(r, 60));
  const legToggle = !!document.querySelector('.chain-toggle');
  const legMode = app.chainMode;
  app.selectJoint(app.leader, 'elbow_L');
  await new Promise((r) => setTimeout(r, 60));
  const armToggle = !!document.querySelector('.chain-toggle');
  const armMode = app.chainMode;
  return { legToggle, legMode, armToggle, armMode };
});
console.log(`--- Chain: knee → toggle ${chain.legToggle} mode '${chain.legMode}'; elbow → toggle ${chain.armToggle} mode '${chain.armMode}'`);
if (!chain.legToggle) problems.push('leg joint did not show the chain toggle');
if (chain.armToggle) problems.push('arm joint showed the (legs-only) chain toggle');
if (chain.armMode !== 'open') problems.push(`arm joint left chain mode '${chain.armMode}' (should be open)`);

// ---- 6. Sidebar tidy: embrace sliders hidden until the hold is on; sections fold.
const sidebar = await page.evaluate(() => {
  const controls = document.getElementById('embrace-controls');
  const hands = document.getElementById('embrace-hands');
  hands.checked = false; hands.dispatchEvent(new Event('change', { bubbles: true }));
  const hiddenOff = controls.hidden;
  hands.checked = true; hands.dispatchEvent(new Event('change', { bubbles: true }));
  const hiddenOn = controls.hidden;
  hands.checked = false; hands.dispatchEvent(new Event('change', { bubbles: true }));
  // Collapsible: a default-collapsed section folds, and clicking its h2 opens it.
  const section = [...document.querySelectorAll('#sidebar section')].find((s) => s.classList.contains('collapsed'));
  const foldedBefore = section?.classList.contains('collapsed');
  section?.querySelector('h2')?.click();
  const foldedAfter = section?.classList.contains('collapsed');
  return { hiddenOff, hiddenOn, foldedBefore, foldedAfter };
});
console.log(`--- Sidebar: embrace sliders hidden off=${sidebar.hiddenOff} on=${sidebar.hiddenOn}; collapse ${sidebar.foldedBefore}→${sidebar.foldedAfter}`);
if (!sidebar.hiddenOff) problems.push('embrace sliders shown while the hold is off');
if (sidebar.hiddenOn) problems.push('embrace sliders stayed hidden after enabling the hold');
if (!sidebar.foldedBefore || sidebar.foldedAfter) problems.push('collapsible section did not toggle');

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
