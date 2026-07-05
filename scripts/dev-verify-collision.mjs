// Dev check for dancer-vs-dancer body collision: the two dancers can connect
// (embrace contact is preserved to the millimeter) but can never occupy each
// other's space — walking, kicking or dragging one into the other displaces
// the partner instead of interpenetrating, and the edited dancer always keeps
// their ground. Screenshots + console errors.
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
// Penetration allowance: the resolver's own trigger threshold plus a little
// float/settle noise.
const PEN_TOL = 0.004;

const clearance = () => page.evaluate(() => window.__app.bodyClearance());
const followerPos = () => page.evaluate(() => {
  const p = window.__app.follower.group.position;
  return { x: p.x, z: p.z };
});

// ---- 1. Every preset must settle penetration-free.
const presetCount = await page.evaluate(() => window.__app.presets.length);
for (let i = 0; i < presetCount; i++) {
  const name = await page.evaluate((idx) => {
    window.__app.applyPreset(idx);
    return window.__app.presets[idx].name;
  }, i);
  await sleep(350);
  const c = await clearance();
  console.log(`--- preset "${name}": clearance ${(c * 100).toFixed(2)} cm`);
  if (c < -PEN_TOL) problems.push(`preset "${name}": bodies interpenetrate by ${(-c * 100).toFixed(1)} cm`);
}

// ---- 2. Walk the leader straight into the follower: she must be displaced,
//         not entered (nobody is being edited, so the follower yields).
await page.evaluate(() => window.__app.applyPreset(0));
await sleep(350);
const before = await followerPos();
await page.evaluate(() => {
  const app = window.__app;
  app.leader.group.position.copy(app.follower.group.position);
});
await sleep(400);
let c = await clearance();
let after = await followerPos();
const pushed = Math.hypot(after.x - before.x, after.z - before.z);
console.log(`--- leader onto follower: clearance ${(c * 100).toFixed(2)} cm, follower displaced ${(pushed * 100).toFixed(1)} cm`);
if (c < -PEN_TOL) problems.push(`walk-into: interpenetration ${(-c * 100).toFixed(1)} cm`);
if (pushed < 0.05) problems.push(`walk-into: follower not displaced (${(pushed * 100).toFixed(1)} cm)`);
await page.screenshot({ path: `${outDir}/collision-walk-into.png` });

// ---- 3. The edited dancer keeps their ground: with the follower selected,
//         moving her into the leader must displace HIM.
await page.evaluate(() => window.__app.applyPreset(0));
await sleep(350);
const leaderBefore = await page.evaluate(() => {
  const app = window.__app;
  app.selectJoint(app.follower, 'pelvis');
  return { x: app.leader.group.position.x, z: app.leader.group.position.z };
});
const followerHeld = await page.evaluate(() => {
  const app = window.__app;
  app.follower.group.position.x = app.leader.group.position.x;
  app.follower.group.position.z = app.leader.group.position.z;
  return { x: app.follower.group.position.x, z: app.follower.group.position.z };
});
await sleep(400);
c = await clearance();
const res = await page.evaluate(() => {
  const app = window.__app;
  const out = {
    leader: { x: app.leader.group.position.x, z: app.leader.group.position.z },
    follower: { x: app.follower.group.position.x, z: app.follower.group.position.z },
  };
  app.deselect();
  return out;
});
const leaderPushed = Math.hypot(res.leader.x - leaderBefore.x, res.leader.z - leaderBefore.z);
const followerMoved = Math.hypot(res.follower.x - followerHeld.x, res.follower.z - followerHeld.z);
console.log(`--- follower (edited) into leader: clearance ${(c * 100).toFixed(2)} cm, leader displaced ${(leaderPushed * 100).toFixed(1)} cm, follower held (moved ${(followerMoved * 100).toFixed(2)} cm)`);
if (c < -PEN_TOL) problems.push(`edited push: interpenetration ${(-c * 100).toFixed(1)} cm`);
if (leaderPushed < 0.05) problems.push(`edited push: leader not displaced (${(leaderPushed * 100).toFixed(1)} cm)`);
if (followerMoved > 0.01) problems.push(`edited push: the edited follower was moved (${(followerMoved * 100).toFixed(1)} cm)`);

// ---- 4. A kick into the partner's body displaces her, capsule-precisely.
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  // Face the leader at the follower half a meter away, then swing his left
  // leg horizontally into her.
  app.leader.group.rotation.y = Math.PI / 2;
  app.leader.group.position.set(app.follower.group.position.x - 0.5, 0, app.follower.group.position.z);
});
await sleep(350);
const kickBefore = await followerPos();
await page.evaluate(() => {
  window.__app.leader.setJointDegrees({ hip_L: { x: -90 } });
});
await sleep(400);
c = await clearance();
after = await followerPos();
const kickPush = after.x - kickBefore.x;
console.log(`--- kick: clearance ${(c * 100).toFixed(2)} cm, follower pushed ${(kickPush * 100).toFixed(1)} cm along the kick`);
if (c < -PEN_TOL) problems.push(`kick: interpenetration ${(-c * 100).toFixed(1)} cm`);
if (kickPush < 0.02) problems.push(`kick: follower not pushed along the kick (${(kickPush * 100).toFixed(1)} cm)`);
await page.screenshot({ path: `${outDir}/collision-kick.png` });

// ---- 5. Connection is preserved: close embrace + clasp still reach surface
//         contact — held torso distance to the millimeter, colliders touching
//         but not entered. Precision both ways: no penetration deeper than
//         the tolerance, AND surfaces within 2 cm (the constraint must not
//         hold the couple apart either).
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(1);
  for (const id of ['embrace-hands', 'embrace-close']) {
    const cb = document.getElementById(id);
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await sleep(500);
const emb = await page.evaluate(() => {
  const e = window.__app.embrace;
  return { chestGap: e.chestGap(), contact: e.contactDistance(), clearance: window.__app.bodyClearance() };
});
console.log(`--- close embrace: chestGap ${(emb.chestGap * 100).toFixed(2)} cm (contact ${(emb.contact * 100).toFixed(2)}), clearance ${(emb.clearance * 100).toFixed(2)} cm`);
if (Math.abs(emb.chestGap - emb.contact) > 0.01) {
  problems.push(`close embrace: collision fights torso contact (off by ${((emb.chestGap - emb.contact) * 100).toFixed(1)} cm)`);
}
if (emb.clearance < -PEN_TOL) problems.push(`close embrace: interpenetration ${(-emb.clearance * 100).toFixed(1)} cm`);
if (emb.clearance > 0.02) problems.push(`close embrace: bodies held apart (clearance ${(emb.clearance * 100).toFixed(1)} cm)`);
await page.screenshot({ path: `${outDir}/collision-close-embrace.png` });

// ---- 6. Degenerate overlap (dancers dropped coaxially) still resolves.
await page.evaluate(() => {
  const app = window.__app;
  for (const id of ['embrace-hands', 'embrace-close']) {
    const cb = document.getElementById(id);
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
  app.applyPreset(0);
  app.leader.group.position.set(0, 0, 0);
  app.follower.group.position.set(0, 0, 0);
});
await sleep(400);
c = await clearance();
console.log(`--- coaxial drop: clearance ${(c * 100).toFixed(2)} cm`);
if (c < -PEN_TOL) problems.push(`coaxial drop: interpenetration ${(-c * 100).toFixed(1)} cm`);

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
