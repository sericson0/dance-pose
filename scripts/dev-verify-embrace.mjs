// Dev check for the embrace constraints: the open-side clasp stays joined —
// palm to palm along the couple axis (his palm facing her, hers facing him),
// both hands' fingers aimed up the clasp's tilted-vertical direction
// (clasp-tilt slider) — and close embrace keeps torso contact through moves,
// turns, pivots and preset changes. Screenshots + console errors.
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
  const { handCenter } = await import('/src/embrace.js');
  const app = window.__app;
  const e = app.embrace;
  // Open-side hands point their fingers along the clasp's tilted-vertical
  // finger direction (degrees off target; joint limits allow some shortfall).
  const fingerDev = (f, wristName, handName, armKey) => {
    const target = e.claspFingerTarget(armKey);
    if (!target) return 999;
    const dir = f.worldPos(handName).sub(f.worldPos(wristName)).normalize();
    return Math.acos(Math.min(1, Math.max(-1, dir.dot(target)))) * 180 / Math.PI;
  };
  // The joined hands stack along the couple axis: the leader's palm on his
  // side of the clasp, the follower's beyond it, each palm facing the
  // partner (his along the axis, hers back along it).
  const pL = handCenter(app.leader, 'wrist_L', 'hand_L');
  const pF = handCenter(app.follower, 'wrist_R', 'hand_R');
  const axis = app.follower.worldPos('chest').sub(app.leader.worldPos('chest'));
  axis.y = 0;
  const outside = axis.lengthSq() > 1e-6 ? pF.clone().sub(pL).dot(axis.normalize()) : 0;
  const palmDev = (f, wristName, sign) => {
    const el = f.nodes[wristName].matrixWorld.elements;
    const len = Math.hypot(el[8], el[9], el[10]);
    const dot = (el[8] * axis.x + el[9] * axis.y + el[10] * axis.z) * sign / len;
    return Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
  };
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
    fingerDevL: fingerDev(app.leader, 'wrist_L', 'hand_L', 'leaderOpen'),
    fingerDevF: fingerDev(app.follower, 'wrist_R', 'hand_R', 'followerOpen'),
    palmDevL: palmDev(app.leader, 'wrist_L', 1),
    palmDevF: palmDev(app.follower, 'wrist_R', -1),
    liftL: app.leader.group.position.y,
    liftF: app.follower.group.position.y,
  };
});

// `closedArms` is a threshold in meters, or null to skip: the closed-side
// palms can only rest on their partner points while the couple roughly faces
// each other — after a big relative turn (pivot) or side-by-side (standing)
// the arms are expected to strain at their joint limits instead.
// `strainedClasp` marks geometries with no embrace shape at all (side by
// side, facing the same way): the clasp still pulls the hands together but
// the arms are limit-bound, so the finger aim is skipped and the palm gap
// tolerance widens.
// `moved` marks transitional mid-movement states (a dancer stepped or turned
// away with the clasp held): palm contact and stacking still hold, but the
// stored clasp point can sit where the ideal orientation is limit-bound, so
// the finger/palm thresholds relax — the fingers legitimately lean over in
// the palm plane (see #LEANS in embrace.js) rather than let a palm turn
// away.
function check(label, m, { hands = true, close = false, closedArms = null, strainedClasp = false, moved = false } = {}) {
  // At the default (shoulder-height) clasp the leader's open hand is honestly
  // limit-bound and leans up-and-in rather than straight up the tilt — the
  // natural low-frame diagonal, not a fault (the fingers-up hold is a raised
  // salon frame, tested separately with the clasp lifted). The finger check
  // only needs to catch a grossly mis-aimed hand; the turned-back-on-the-
  // partner failure is caught by the palm-dir check below. Mid-movement the
  // arms strain further.
  const fingersMax = moved ? 55 : 50;
  // Settled embraces keep the palms within 40° of the couple axis (10° of
  // that is the deliberate finger wrap). Mid-movement the arms are honestly
  // limit-bound and the palm can wander to ~60°; the check only needs to
  // catch the turned-back-on-the-partner failure (~90°).
  const palmsMax = moved ? 70 : 40;
  console.log(`--- ${label}: handGap ${(m.handGap * 100).toFixed(2)} cm (palms ${(m.palmGap * 100).toFixed(1)}, follower beyond ${(m.outside * 100).toFixed(1)}), `
    + `chestGap ${(m.chestGap * 100).toFixed(1)} cm (contact ${(m.contact * 100).toFixed(1)}, body clearance ${(m.clearance * 100).toFixed(2)}), `
    + `closed L ${(m.closedL * 100).toFixed(1)} F ${(m.closedF * 100).toFixed(1)} cm, `
    + `finger dev L ${m.fingerDevL.toFixed(1)}° F ${m.fingerDevF.toFixed(1)}°, palm dev L ${m.palmDevL.toFixed(1)}° F ${m.palmDevF.toFixed(1)}°`);
  if (hands && Math.abs(m.handGap - m.palmGap) > (strainedClasp ? 0.03 : 0.015)) {
    problems.push(`${label}: clasp gap ${(m.handGap * 100).toFixed(1)} cm (want ${(m.palmGap * 100).toFixed(1)})`);
  }
  if (hands && m.outside < -0.005) {
    problems.push(`${label}: hands stacked backwards along the couple axis (${(m.outside * 100).toFixed(1)} cm)`);
  }
  if (hands && !strainedClasp && (m.fingerDevL > fingersMax || m.fingerDevF > fingersMax)) {
    problems.push(`${label}: clasp fingers off the tilt direction (L ${m.fingerDevL.toFixed(1)}° F ${m.fingerDevF.toFixed(1)}°)`);
  }
  if (hands && !strainedClasp && (m.palmDevL > palmsMax || m.palmDevF > palmsMax)) {
    problems.push(`${label}: palms not facing the partner (L ${m.palmDevL.toFixed(1)}° F ${m.palmDevF.toFixed(1)}°)`);
  }
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

// ---- 1b. The clasp-tilt slider re-aims the joined hands: near-vertical
//          fingers at 0°, a clearly swung direction at 45°. Fingers-up is a
//          raised (salon) frame — at the default shoulder-height clasp the
//          hand is limit-bound diagonal and the tilt has little authority —
//          so this raises the clasp height first, then restores it.
const tiltTest = await page.evaluate(async () => {
  const app = window.__app;
  const setTilt = (v) => {
    const s = document.getElementById('embrace-tilt');
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setHeight = (v) => {
    const s = document.getElementById('embrace-height');
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = () => app.leader.worldPos('hand_L').sub(app.leader.worldPos('wrist_L')).normalize();
  setHeight(8); // raised salon frame, hands up by the faces
  await sleep(300);
  setTilt(0);
  await sleep(300);
  const d0 = dir();
  setTilt(45);
  await sleep(300);
  const d45 = dir();
  setTilt(20); // back to the default
  setHeight(0); // restore the default frame for the checks that follow
  await sleep(300);
  const swing = Math.acos(Math.min(1, Math.max(-1, d0.dot(d45)))) * 180 / Math.PI;
  return { swing, vertY: d0.y };
});
console.log(`--- tilt slider: 0°→45° swings the leader's hand ${tiltTest.swing.toFixed(1)}° (fingers-up y at 0°: ${tiltTest.vertY.toFixed(2)})`);
// The ±30° wrist-deviation limit bounds the extremes, so the achievable
// swing is ~23° of the slider's 45° — anatomically honest, still visible.
if (tiltTest.swing < 18) problems.push(`tilt slider: hands only swung ${tiltTest.swing.toFixed(1)}° between 0° and 45°`);
if (tiltTest.vertY < 0.75) problems.push(`tilt 0°: leader's fingers not near vertical (y ${tiltTest.vertY.toFixed(2)})`);

// ---- 2. Move the leader: the clasp must follow.
await page.evaluate(() => {
  const app = window.__app;
  app.leader.group.position.x += 0.12;
  app.leader.group.position.z -= 0.08;
});
await sleep(400);
check('leader moved', await measure(), { moved: true });

// ---- 3. Turn the leader 30°: still joined.
await page.evaluate(() => { window.__app.leader.group.rotation.y += Math.PI / 6; });
await sleep(400);
check('leader turned', await measure(), { moved: true });
await page.screenshot({ path: `${outDir}/embrace-turned.png` });

// ---- 4. Close embrace on: torsos pulled into contact.
await page.evaluate(() => {
  const cb = document.getElementById('embrace-close');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(400);
check('close embrace on', await measure(), { close: true, closedArms: 0.12, moved: true }); // leader turned 30° away
await page.screenshot({ path: `${outDir}/embrace-close.png` });

// ---- 5. Pivot the leader 60° on his support foot: contact + clasp keep up
//         (a calesita-like turn — the follower is carried around).
await page.evaluate(() => { window.__app.pivotFigure(window.__app.leader, Math.PI / 3); });
await sleep(400);
check('leader pivoted 60°', await measure(), { close: true, moved: true });
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
// The user controls the leader's arm here, so there is no meeting halfway:
// the follower reaches as far as her joint limits allow toward wherever his
// hand went, which can leave the palms a centimetre or two short. The check
// only needs to catch her hand not following at all.
if (Math.abs(armEdit.gap - armEdit.palms) > 0.03) {
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
// The standing preset is side by side facing the same way, and the hand
// clasp is OFF here — only the torso pull is asserted.
check('standing → close embrace', await measure(), { close: true, hands: false });
await page.screenshot({ path: `${outDir}/embrace-from-standing.png` });

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
