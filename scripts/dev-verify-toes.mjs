// Dev check for the toes (MTP) joint, lumbar/thoracic spine limits, and the
// closed-chain pelvis-height behavior. Numeric diagnostics + screenshots.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

// ---- 1. Rest pose sanity: toes joints exist, nothing below floor, no lift.
const rest = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  const f = app.leader;
  f.group.updateMatrixWorld(true);
  return {
    low: f.lowestPointY(),
    lift: f.group.position.y,
    hasToesJoint: !!f.nodes.toes_L && !!f.nodes.toes_R,
  };
});
console.log('rest:', JSON.stringify(rest));
if (!rest.hasToesJoint) problems.push('toes joints missing');
if (Math.abs(rest.low) > 0.003) problems.push(`rest lowest point ${rest.low}`);
if (Math.abs(rest.lift) > 0.003) problems.push(`rest clamp lift ${rest.lift}`);

// ---- 2. Joint limits: toe curl +35 / lift -70, lumbar twist ±8, thoracic ±35.
const limits = await page.evaluate(() => {
  const app = window.__app;
  const f = app.leader;
  const DEG = Math.PI / 180;
  f.setJointDegrees({ toes_L: { x: 90 }, toes_R: { x: -120 }, spine: { y: 30 }, chest: { y: 30 } });
  return {
    curlClamp: f.nodes.toes_L.rotation.x / DEG,
    liftClamp: f.nodes.toes_R.rotation.x / DEG,
    lumbarClamp: f.nodes.spine.rotation.y / DEG,
    thoracic: f.nodes.chest.rotation.y / DEG,
  };
});
console.log('limits:', JSON.stringify(limits));
if (Math.abs(limits.curlClamp - 35) > 0.01) problems.push(`toe curl clamp ${limits.curlClamp}`);
if (Math.abs(limits.liftClamp + 70) > 0.01) problems.push(`toe lift clamp ${limits.liftClamp}`);
if (Math.abs(limits.lumbarClamp - 8) > 0.01) problems.push(`lumbar twist clamp ${limits.lumbarClamp}`);
if (Math.abs(limits.thoracic - 30) > 0.01) problems.push(`thoracic twist ${limits.thoracic}`);

// ---- 3. Demi-pointe: point both ankles, extend both toes → dancer rises,
// toe pads stay on the floor, nothing penetrates.
const demi = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  const f = app.leader;
  const before = { pelvisY: f.worldPos('pelvis').y };
  f.setJointDegrees({
    ankle_L: { x: 45 }, toes_L: { x: -45 },
    ankle_R: { x: 45 }, toes_R: { x: -45 },
  });
  f.clampToFloor();
  f.group.updateMatrixWorld(true);
  return {
    pelvisRise: f.worldPos('pelvis').y - before.pelvisY,
    heelY: f.worldPos('ankle_L').y,
    toeTipY: f.worldPos('toe_L').y,
    low: f.lowestPointY(),
  };
});
console.log('demi-pointe:', JSON.stringify(demi));
if (demi.pelvisRise < 0.03) problems.push(`demi-pointe did not raise the dancer (rise ${demi.pelvisRise})`);
if (demi.low < -0.003) problems.push(`demi-pointe penetrates floor ${demi.low}`);
if (demi.toeTipY > 0.03) problems.push(`demi-pointe toe tip floated ${demi.toeTipY}`);
await sleep(300);
await page.screenshot({ path: `${outDir}/demi-pointe.png` });

// ---- 4. Closed-chain relevé: extend toes with toes anchored → heel rises,
// ball of the foot stays pinned.
const releve = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.setChainMode('closed');
  const f = app.leader;
  const before = { ankleY: f.worldPos('ankle_L').y, ball: f.worldPos('toes_L').toArray() };
  app.editJoint(f, 'toes_L', () => { f.nodes.toes_L.rotation.x = -30 * Math.PI / 180; });
  f.group.updateMatrixWorld(true);
  const after = { ankleY: f.worldPos('ankle_L').y, ball: f.worldPos('toes_L').toArray() };
  app.setChainMode('open');
  return {
    heelRise: after.ankleY - before.ankleY,
    ballDrift: Math.hypot(after.ball[0] - before.ball[0], after.ball[2] - before.ball[2]),
  };
});
console.log('closed-chain releve:', JSON.stringify(releve));
if (releve.heelRise < 0.02) problems.push(`closed-chain toe extension did not lift heel (${releve.heelRise})`);
if (releve.ballDrift > 0.001) problems.push(`ball of foot drifted ${releve.ballDrift}`);

// ---- 5. Closed-chain pelvis height (the "nothing happens" fix): pelvis
// drops, planted ankles stay put, knees bend.
const crouch = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.setChainMode('closed');
  const f = app.leader;
  const before = {
    pelvisY: f.worldPos('pelvis').y,
    ankleL: f.worldPos('ankle_L').toArray(),
    ankleR: f.worldPos('ankle_R').toArray(),
    kneeX: f.nodes.knee_L.rotation.x,
  };
  app.setPelvisHeight(f, 0.46 * f.height);
  f.group.updateMatrixWorld(true);
  const after = {
    pelvisY: f.worldPos('pelvis').y,
    ankleL: f.worldPos('ankle_L').toArray(),
    ankleR: f.worldPos('ankle_R').toArray(),
    kneeX: f.nodes.knee_L.rotation.x,
  };
  app.setChainMode('open');
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return {
    drop: before.pelvisY - after.pelvisY,
    ankleDriftL: d3(before.ankleL, after.ankleL),
    ankleDriftR: d3(before.ankleR, after.ankleR),
    kneeBend: (after.kneeX - before.kneeX) * 180 / Math.PI,
  };
});
console.log('closed-chain crouch:', JSON.stringify(crouch));
if (crouch.drop < 0.08) problems.push(`closed-chain crouch: pelvis did not drop (${crouch.drop})`);
if (crouch.ankleDriftL > 0.005 || crouch.ankleDriftR > 0.005) {
  problems.push(`closed-chain crouch: ankles drifted L=${crouch.ankleDriftL} R=${crouch.ankleDriftR}`);
}
if (crouch.kneeBend < 10) problems.push(`closed-chain crouch: knees did not bend (${crouch.kneeBend}°)`);
await sleep(300);
await page.screenshot({ path: `${outDir}/ckc-crouch.png` });

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
