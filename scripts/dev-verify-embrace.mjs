// Dev check for the embrace constraints: the open-side clasp stays joined —
// palms a hand's thickness apart, the leader's hand on the OUTSIDE of the
// embrace, both wrists holding the finger-wrap flexion — and close embrace
// keeps torso contact through moves, turns, pivots and preset changes.
// Screenshots + console errors.
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

const measure = () => page.evaluate(async () => {
  const { handCenter, CLASP_WRAP_DEG } = await import('/src/embrace.js');
  const app = window.__app;
  const e = app.embrace;
  const wrap = CLASP_WRAP_DEG * Math.PI / 180;
  // Open-side wrists hold the finger-wrap flexion (x = -wrap, y = z = 0).
  const wl = app.leader.nodes.wrist_L.rotation;
  const wr = app.follower.nodes.wrist_R.rotation;
  const wristDev = (w) => Math.max(Math.abs(w.x + wrap), Math.abs(w.y), Math.abs(w.z));
  // The leader's palm should stack on the OUTSIDE of the clasp: past the
  // follower's palm along the horizontal direction out from her chest.
  const pL = handCenter(app.leader, 'wrist_L', 'hand_L');
  const pF = handCenter(app.follower, 'wrist_R', 'hand_R');
  const clasp = e.claspWorld();
  let outside = 0;
  if (clasp) {
    const out = clasp.clone().sub(app.follower.worldPos('chest'));
    out.y = 0;
    if (out.lengthSq() > 1e-6) outside = pL.clone().sub(pF).dot(out.normalize());
  }
  // Closed-side palms vs their (reach-clamped) rest points on the partner.
  const closedL = handCenter(app.leader, 'wrist_R', 'hand_R')
    .distanceTo(e.closedGoalWorld('leaderClosed'));
  const closedF = handCenter(app.follower, 'wrist_L', 'hand_L')
    .distanceTo(e.closedGoalWorld('followerClosed'));
  return {
    handGap: e.handGap(),
    palmGap: e.palmGap(),
    outside,
    chestGap: e.chestGap(),
    contact: e.contactDistance(),
    clearance: app.bodyClearance(),
    closedL, closedF,
    wristDevL: wristDev(wl),
    wristDevF: wristDev(wr),
    liftL: app.leader.group.position.y,
    liftF: app.follower.group.position.y,
  };
});

// `closedArms` is a threshold in meters, or null to skip: the closed-side
// palms can only rest on their partner points while the couple roughly faces
// each other — after a big relative turn (pivot) or side-by-side (standing)
// the arms are expected to strain at their joint limits instead.
function check(label, m, { hands = true, close = false, closedArms = null } = {}) {
  console.log(`--- ${label}: handGap ${(m.handGap * 100).toFixed(2)} cm (palms ${(m.palmGap * 100).toFixed(1)}, leader outside ${(m.outside * 100).toFixed(1)}), `
    + `chestGap ${(m.chestGap * 100).toFixed(1)} cm (contact ${(m.contact * 100).toFixed(1)}, body clearance ${(m.clearance * 100).toFixed(2)}), `
    + `closed L ${(m.closedL * 100).toFixed(1)} F ${(m.closedF * 100).toFixed(1)} cm, `
    + `wrist wrap dev L ${(m.wristDevL * 57.3).toFixed(1)}° F ${(m.wristDevF * 57.3).toFixed(1)}°`);
  if (hands && Math.abs(m.handGap - m.palmGap) > 0.015) {
    problems.push(`${label}: clasp gap ${(m.handGap * 100).toFixed(1)} cm (want ${(m.palmGap * 100).toFixed(1)})`);
  }
  if (hands && m.outside < -0.005) {
    problems.push(`${label}: leader hand not on the outside (${(m.outside * 100).toFixed(1)} cm)`);
  }
  if (hands && (m.wristDevL > 0.02 || m.wristDevF > 0.02)) problems.push(`${label}: clasp wrist not holding the finger wrap`);
  if (closedArms !== null && (m.closedL > closedArms || m.closedF > closedArms)) {
    problems.push(`${label}: closed-side palm off by L ${(m.closedL * 100).toFixed(1)} / F ${(m.closedF * 100).toFixed(1)} cm`);
  }
  // Close embrace pulls to the contact distance — unless the body colliders
  // (collision.js) stop the couple earlier, in which case they must be
  // resting surface-on-surface (clearance ~0), e.g. foot against foot after
  // a pivot, or shoulder to shoulder when pulled together side-on.
  if (close) {
    const atContact = Math.abs(m.chestGap - m.contact) <= 0.01;
    const restingOnBody = m.chestGap > m.contact && m.clearance <= 0.005;
    if (!atContact && !restingOnBody) {
      problems.push(`${label}: torso contact off by ${((m.chestGap - m.contact) * 100).toFixed(1)} cm (body clearance ${(m.clearance * 100).toFixed(1)} cm)`);
    }
  }
}

// ---- 1. Close-embrace preset, engage the hand clasp via the checkbox.
await page.evaluate(async () => {
  window.__app.applyPreset(1);
  const cb = document.getElementById('embrace-hands');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(400);
check('engage hands', await measure(), { closedArms: 0.03 });
// The clasped hands' finger bones must be curled (body avatars).
const fingers = await page.evaluate(() => {
  const app = window.__app;
  const curled = (f, side) => f.fingerBones
    && f.fingerBones[side].some((b) => 2 * Math.acos(Math.min(1, Math.abs(
      b.rest.clone().invert().multiply(b.bone.quaternion).w))) > 0.3);
  return { leader: curled(app.leader, 'L'), follower: curled(app.follower, 'R') };
});
if (!fingers.leader || !fingers.follower) {
  problems.push(`engage hands: clasp fingers not curled (L ${fingers.leader} F ${fingers.follower})`);
}
await page.screenshot({ path: `${outDir}/embrace-hands.png` });

// ---- 2. Move the leader: the clasp must follow.
await page.evaluate(() => {
  const app = window.__app;
  app.leader.group.position.x += 0.12;
  app.leader.group.position.z -= 0.08;
});
await sleep(400);
check('leader moved', await measure());

// ---- 3. Turn the leader 30°: still joined.
await page.evaluate(() => { window.__app.leader.group.rotation.y += Math.PI / 6; });
await sleep(400);
check('leader turned', await measure());
await page.screenshot({ path: `${outDir}/embrace-turned.png` });

// ---- 4. Close embrace on: torsos pulled into contact.
await page.evaluate(() => {
  const cb = document.getElementById('embrace-close');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(400);
check('close embrace on', await measure(), { close: true, closedArms: 0.12 }); // leader turned 30° away
await page.screenshot({ path: `${outDir}/embrace-close.png` });

// ---- 5. Pivot the leader 60° on his support foot: contact + clasp keep up
//         (a calesita-like turn — the follower is carried around).
await page.evaluate(() => { window.__app.pivotFigure(window.__app.leader, Math.PI / 3); });
await sleep(400);
check('leader pivoted 60°', await measure(), { close: true });
await page.evaluate(() => window.__app.setView('top'));
await sleep(300);
await page.screenshot({ path: `${outDir}/embrace-pivot-top.png` });
await page.evaluate(() => window.__app.setView('three'));

// ---- 6. Walk preset with both constraints held.
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(app.presets.findIndex((p) => p.name.startsWith('Walk')));
});
await sleep(400);
const walk = await measure();
// Reach-limited shortfall still lands the palm on the shoulder — allow it.
check('walk preset', walk, { close: true, closedArms: 0.12 });
if (Math.abs(walk.liftL) > 0.02 || Math.abs(walk.liftF) > 0.02) {
  problems.push(`walk: clamp lift L=${walk.liftL.toFixed(3)} F=${walk.liftF.toFixed(3)}`);
}
await page.screenshot({ path: `${outDir}/embrace-walk.png` });

// ---- 7. Editing a connected arm hands control to the user: rotate the
//         leader's open-side shoulder and expect the follower's hand to track.
await page.evaluate(async () => {
  const app = window.__app;
  app.selectJoint(app.leader, 'shoulder_L');
  app.editJoint(app.leader, 'shoulder_L', () => {
    app.leader.nodes.shoulder_L.rotation.x -= 15 * Math.PI / 180;
  });
});
await sleep(400);
const armEdit = await page.evaluate(() => {
  const app = window.__app;
  const gap = app.embrace.handGap();
  const palms = app.embrace.palmGap();
  app.deselect();
  return { gap, palms };
});
console.log(`--- arm edit: follower tracked to ${(armEdit.gap * 100).toFixed(2)} cm`);
if (Math.abs(armEdit.gap - armEdit.palms) > 0.015) {
  problems.push(`arm edit: follower hand did not track (${(armEdit.gap * 100).toFixed(1)} cm)`);
}
await sleep(300);
await page.screenshot({ path: `${outDir}/embrace-arm-edit.png` });

// ---- 8. Come into the embrace from the standing preset (dancers apart).
await page.evaluate(() => {
  const app = window.__app;
  ['embrace-hands', 'embrace-close'].forEach((id) => {
    const cb = document.getElementById(id);
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  app.applyPreset(0);
  const cb = document.getElementById('embrace-close');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(500);
check('standing → close embrace', await measure(), { close: true });
await page.screenshot({ path: `${outDir}/embrace-from-standing.png` });

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
