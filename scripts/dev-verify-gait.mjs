// Dev check for the gait-phase walk (foot roll + dissociation + animated
// collection) and the embrace naturalness pass. The step must end on an
// honest contact pose — front foot landed heel-first (toe up, heel grazing
// the floor), trailing foot peeled onto the ball (ankle raised, toe pad
// grazing), pelvis yawed into the step with the chest counter-yawed — and
// must pass through a floor-caressing swing mid-animation. Screenshots +
// console errors + numeric diagnostics.
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
await page.waitForFunction(() => !!window.__app, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1000));

const problems = [];

// ---- 1. Forward contact pose: heel-strike ahead, ball-roll behind,
// dissociation in the trunk, everything grazing the floor.
const fwd = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  app.linkCouple = false;
  app.setVisibleFigures('leader');
  const f = app.leader;
  app.stepFigure(f, 1);
  await new Promise((r) => setTimeout(r, 900)); // step fully played + settled
  app.stepFigure(f, 1);                          // second step: from extended stance
  await new Promise((r) => setTimeout(r, 900));
  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
  const swing = f.__swing, support = swing === 'L' ? 'R' : 'L';
  return {
    swing,
    lowSwing: +f.footLowY(swing).toFixed(4),
    lowSupport: +f.footLowY(support).toFixed(4),
    low: +f.lowestPointY().toFixed(4),
    supAnkleY: +f.worldPos(`ankle_${support}`).y.toFixed(3),  // raised = heel peeled
    supToeY: +f.worldPos(`toe_${support}`).y.toFixed(3),      // grazing = on the ball
    swToesY: +f.worldPos(`toes_${swing}`).y.toFixed(3),       // ball off floor = toe up
    pelvisYaw: deg(f.nodes.pelvis.rotation.y),
    chestYaw: deg(f.nodes.chest.rotation.y),
  };
});
console.log('--- forward contact:', JSON.stringify(fwd));
if (Math.abs(fwd.low) > 0.01) problems.push(`contact pose not grounded (low ${fwd.low})`);
if (fwd.lowSupport > 0.005 || fwd.lowSupport < -0.005) problems.push(`trailing foot not grazing (${fwd.lowSupport})`);
if (fwd.supAnkleY < 0.09) problems.push(`trailing heel did not peel (ankle y ${fwd.supAnkleY})`);
if (fwd.lowSwing > 0.006) problems.push(`front foot floating (${fwd.lowSwing})`);
if (fwd.swToesY < 0.03) problems.push(`front foot not heel-first (ball y ${fwd.swToesY})`);
if (Math.abs(fwd.pelvisYaw) < 3) problems.push(`no pelvis dissociation (${fwd.pelvisYaw}°)`);
if (Math.sign(fwd.chestYaw) === Math.sign(fwd.pelvisYaw) || Math.abs(fwd.chestYaw) < 3) {
  problems.push(`chest did not counter-yaw (pelvis ${fwd.pelvisYaw}°, chest ${fwd.chestYaw}°)`);
}
await page.screenshot({ path: `${outDir}/gait-contact.png` });

// ---- 2. Mid-step: the animation is live, the swing foot caresses the floor
// (off it, but barely) while the support stays planted.
const mid = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  app.setVisibleFigures('leader');
  const f = app.leader;
  app.stepFigure(f, 1);
  await new Promise((r) => setTimeout(r, 260));
  const swing = f.__swing, support = swing === 'L' ? 'R' : 'L';
  return {
    animLive: app.stepAnims.length,
    swingLow: +f.footLowY(swing).toFixed(4),
    supportLow: +f.footLowY(support).toFixed(4),
  };
});
console.log('--- mid-step:', JSON.stringify(mid));
if (!mid.animLive) problems.push('step did not animate (no live anim mid-step)');
if (mid.swingLow < 0.001 || mid.swingLow > 0.05) problems.push(`swing foot not caressing (${mid.swingLow})`);
if (Math.abs(mid.supportLow) > 0.005) problems.push(`support foot left the floor mid-step (${mid.supportLow})`);

// ---- 3. Backward step (the follower's walk): pointed-toe reach behind,
// leading foot keeps the floor.
const back = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  app.setVisibleFigures('leader');
  const f = app.leader;
  app.stepFigure(f, -1);
  await new Promise((r) => setTimeout(r, 900));
  const swing = f.__swing, support = swing === 'L' ? 'R' : 'L';
  return {
    lowSwing: +f.footLowY(swing).toFixed(4),
    lowSupport: +f.footLowY(support).toFixed(4),
    low: +f.lowestPointY().toFixed(4),
    swAnkleY: +f.worldPos(`ankle_${swing}`).y.toFixed(3), // raised = pointed reach
  };
});
console.log('--- backward contact:', JSON.stringify(back));
if (Math.abs(back.low) > 0.01) problems.push(`backward pose not grounded (${back.low})`);
if (back.swAnkleY < 0.08) problems.push(`backward reach not pointed (ankle y ${back.swAnkleY})`);
if (back.lowSwing > 0.006 || back.lowSwing < -0.005) problems.push(`backward toe not grazing (${back.lowSwing})`);
await page.screenshot({ path: `${outDir}/gait-backward.png` });

// ---- 4. Close embrace preset: shared forward lean stays grounded, heads tip
// toward each other (his crown toward his right where her head passes, hers
// toward her right against his cheek), bodies touch but never overlap.
const emb = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(1);
  app.setVisibleFigures('both');
  await new Promise((r) => setTimeout(r, 400));
  const L = app.leader, F = app.follower;
  const headL = L.worldPos('head'), headF = F.worldPos('head');
  const neckL = L.worldPos('neck'), neckF = F.worldPos('neck');
  return {
    leanL: +(headL.x - neckL.x).toFixed(4),
    leanF: +(headF.x - neckF.x).toFixed(4),
    clearance: +app.bodyClearance().toFixed(4),
    lowL: +L.lowestPointY().toFixed(4),
    lowF: +F.lowestPointY().toFixed(4),
  };
});
console.log('--- close embrace:', JSON.stringify(emb));
if (emb.leanL > -0.001) problems.push(`leader head not tipped toward partner (${emb.leanL})`);
if (emb.leanF < 0.001) problems.push(`follower head not tipped toward partner (${emb.leanF})`);
if (emb.clearance < -0.004) problems.push(`close embrace bodies overlap (${emb.clearance})`);
if (Math.abs(emb.lowL) > 0.01 || Math.abs(emb.lowF) > 0.01) {
  problems.push(`leaned embrace not grounded (L ${emb.lowL}, F ${emb.lowF})`);
}
await page.screenshot({ path: `${outDir}/gait-embrace.png` });

// ---- 5. Couple walk in close embrace: travels, stays grounded, contact held.
const couple = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(1);
  app.setVisibleFigures('both');
  app.linkCouple = true;
  document.getElementById('embrace-hands').checked = true;
  document.getElementById('embrace-hands').dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('embrace-close').checked = true;
  document.getElementById('embrace-close').dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const L = app.leader, F = app.follower;
  const chest = () => +L.worldPos('chest').distanceTo(F.worldPos('chest')).toFixed(3);
  const start = L.group.position.clone();
  const chestBefore = chest();
  for (let i = 0; i < 3; i++) {
    app.stepFigure(L, 1);
    await new Promise((r) => setTimeout(r, 900));
  }
  return {
    travel: +Math.hypot(L.group.position.x - start.x, L.group.position.z - start.z).toFixed(3),
    chestBefore,
    chestAfter: chest(),
    lowL: +L.lowestPointY().toFixed(4),
    lowF: +F.lowestPointY().toFixed(4),
    clearance: +app.bodyClearance().toFixed(4),
  };
});
console.log('--- couple walk:', JSON.stringify(couple));
if (couple.travel < 0.4) problems.push(`couple walk barely advanced (${couple.travel})`);
// Mid-stride the couple rests where the interleaved legs brush (see
// dev-verify-walk) — a few cm wider than standing contact, but bounded.
if (Math.abs(couple.chestAfter - couple.chestBefore) > 0.12) {
  problems.push(`couple walk broke chest contact (${couple.chestBefore}→${couple.chestAfter})`);
}
if (Math.abs(couple.lowL) > 0.012 || Math.abs(couple.lowF) > 0.012) {
  problems.push(`couple walk not grounded (L ${couple.lowL}, F ${couple.lowF})`);
}
if (couple.clearance < -0.004) problems.push(`couple walk bodies overlap (${couple.clearance})`);
await page.screenshot({ path: `${outDir}/gait-couple.png` });

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
