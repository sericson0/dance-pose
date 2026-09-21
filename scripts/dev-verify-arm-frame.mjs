// Dev check for the ARM FRAME (src/armFrame.js): the shoulder part of a pivot.
//
//  • the frame TURN (Move hips → Frame, app.turnFrame): the two elbows orbit
//    the chest's vertical axis as ONE RIGID PAIR. Measured on the elbow nodes'
//    rendered world matrices (the arm chain has one frame, so that IS the
//    visible elbow): each elbow's HEIGHT and the DISTANCE between them must not
//    change, the midpoint between them must swing about the chest by the yaw
//    that was applied, the FOREARMS must be carried round by that same yaw, and
//    the trunk (chest, pelvis, feet) must not move at all. The shoulder BLADES
//    must take part — one protracting, the other retracting — because a frame
//    turned by the glenohumeral joints alone is the stiff look the tool exists
//    to avoid. Turning out and back must retrace (no ratchet), and a turn past
//    the shoulders' range must CLAMP and keep the frame rigid rather than
//    deform it.
//  • the elbow HOLD (Embrace → Fix elbows, app.setElbowsFixed): with the hold
//    on, rotating the chest, twisting the hips and pivoting the whole dancer
//    must each leave both elbows where they were IN THE ROOM, and the forearms
//    turned as they were. With the hold OFF the same edits must move them —
//    the positive control, or a broken probe reads as a perfect hold.
//  • with "Hold embrace" on, a held follower keeps her hands and the LEADER's
//    open hand comes to her (the embrace treats a held arm as user-owned).
//  • an outright pose (a preset, an undo) re-captures the hold instead of
//    wrenching the new pose's arms back to the old elbows.
//  • REAL input: the Frame tool's ring dragged with the pointer, ←/→ nudges,
//    the panel's checkbox.
//
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch { /* */ } });
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !!window.__app && !document.getElementById('loading-overlay'), { timeout: 60000 });

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`); if (!ok) problems.push(msg); };
const mm = (v) => `${(v * 1000).toFixed(1)} mm`;
const deg = (v) => `${v.toFixed(2)}°`;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const wrap = (a) => ((a + 540) % 360) - 180;

// Let the render loop run its constraint pass a few times.
async function settle(ms = 250) {
  await page.evaluate(() => window.__app.requestSim(8));
  await sleep(ms);
}

async function probe(which = 'follower') {
  return page.evaluate((which) => {
    const app = window.__app;
    const fig = app[which];
    fig.group.updateMatrixWorld(true);
    const pos = (n) => { const e = fig.nodes[n].matrixWorld.elements; return { x: e[12], y: e[13], z: e[14] }; };
    // A node's world axes, unit length.
    const basis = (n) => {
      const e = fig.nodes[n].matrixWorld.elements;
      return [0, 1, 2].map((c) => {
        const v = [e[c * 4], e[c * 4 + 1], e[c * 4 + 2]];
        const l = Math.hypot(...v) || 1;
        return v.map((x) => x / l);
      });
    };
    const rot = (n) => { const r = fig.nodes[n].rotation; return [r.x, r.y, r.z].map((v) => v * 180 / Math.PI); };
    return {
      elbow: { L: pos('elbow_L'), R: pos('elbow_R') },
      wrist: { L: pos('wrist_L'), R: pos('wrist_R') },
      forearm: { L: basis('elbow_L'), R: basis('elbow_R') },
      chest: pos('chest'),
      chestBasis: basis('chest'),
      pelvis: pos('pelvis'),
      ankle: { L: pos('ankle_L'), R: pos('ankle_R') },
      scap: { L: rot('scapula_L'), R: rot('scapula_R') },
      palm: { L: fig.palmPosWorld('L').toArray(), R: fig.palmPosWorld('R').toArray() },
    };
  }, which);
}

// Largest angle between matching axes of two bases (degrees).
const basisAngle = (a, b) => Math.max(...[0, 1, 2].map((i) => {
  const d = a[i][0] * b[i][0] + a[i][1] * b[i][1] + a[i][2] * b[i][2];
  return Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
}));
// Rotate a basis about world +Y by `yawDeg`.
const yawBasis = (basis, yawDeg) => {
  const c = Math.cos(yawDeg * Math.PI / 180);
  const s = Math.sin(yawDeg * Math.PI / 180);
  return basis.map(([x, y, z]) => [x * c + z * s, y, -x * s + z * c]);
};
// Azimuth (about world +Y, the sense a positive rotation.y turns) of p about c.
const azimuth = (p, c) => Math.atan2(p.x - c.x, p.z - c.z) * 180 / Math.PI;
const midOf = (p) => ({ x: (p.elbow.L.x + p.elbow.R.x) / 2, y: (p.elbow.L.y + p.elbow.R.y) / 2, z: (p.elbow.L.z + p.elbow.R.z) / 2 });

const presetIndex = (name) => page.evaluate((name) => {
  const opts = [...document.querySelectorAll('#preset-select option, #preset option')];
  const hit = opts.find((o) => o.textContent.trim().toLowerCase().startsWith(name));
  return hit ? Number(hit.value) : -1;
}, name);

// The pose every case starts from. CLOSE EMBRACE is the one that matters — the
// arms are where a pivot finds them, the follower's elbows pronated to 88° (past
// what a canonical Euler extraction can even represent) and the leader's right
// shoulder 6° from a limit — with Standing as the easy control.
let POSE = 'close embrace';
async function freshPose() {
  await page.evaluate(() => {
    const app = window.__app;
    app.setElbowsFixed(0, false);
    app.setElbowsFixed(1, false);
    app.setEmbrace({ hands: false, close: false });
    app.frameState = null;
  });
  const i = await presetIndex(POSE);
  if (i < 0) throw new Error(`no preset called ${POSE}`);
  await page.evaluate((i) => window.__app.applyPreset(i), i);
  await settle();
}

// ============================================================ 1. frame turn
console.log('\n— frame turn (app.turnFrame) —');
for (const which of ['follower', 'leader']) {
  await freshPose();
  const p0 = await probe(which);
  // The leader turns the other way: in a close embrace his RIGHT arm, round her
  // back, already sits 6° from the shoulder's forward limit, so a + turn is
  // honestly short (~14°, measured — it is the clamp case below).
  const want = which === 'leader' ? -20 : 20;
  const applied = await page.evaluate((which, want) => {
    const app = window.__app;
    let sum = 0;
    // In steps, as a drag delivers it.
    for (let i = 0; i < 10; i++) sum += app.turnFrame(app[which], (want / 10) * Math.PI / 180);
    return sum * 180 / Math.PI;
  }, which, want);
  await settle();
  const p1 = await probe(which);
  check(Math.abs(applied - want) < 0.05, `${which}: a ${want}° frame turn is applied in full (${deg(applied)})`);
  for (const side of ['L', 'R']) {
    check(Math.abs(p1.elbow[side].y - p0.elbow[side].y) < 0.002,
      `${which} ${side} elbow keeps its height (${mm(p1.elbow[side].y - p0.elbow[side].y)})`);
    const fa = basisAngle(p1.forearm[side], yawBasis(p0.forearm[side], applied));
    check(fa < 1.5, `${which} ${side} forearm is carried round by the same yaw (${deg(fa)} off)`);
  }
  const d0 = dist(p0.elbow.L, p0.elbow.R);
  const d1 = dist(p1.elbow.L, p1.elbow.R);
  check(Math.abs(d1 - d0) < 0.002, `${which}: elbow-to-elbow distance is unchanged (${mm(d1 - d0)})`);
  const swing = wrap(azimuth(midOf(p1), p1.chest) - azimuth(midOf(p0), p0.chest));
  check(Math.abs(swing - applied) < 1.0, `${which}: the elbows' midpoint swings about the chest by the yaw applied (${deg(swing)} vs ${deg(applied)})`);
  check(dist(p1.chest, p0.chest) < 1e-4 && basisAngle(p1.chestBasis, p0.chestBasis) < 0.01,
    `${which}: the chest does not move (${mm(dist(p1.chest, p0.chest))}, ${deg(basisAngle(p1.chestBasis, p0.chestBasis))})`);
  check(dist(p1.pelvis, p0.pelvis) < 1e-4 && dist(p1.ankle.L, p0.ankle.L) < 1e-4 && dist(p1.ankle.R, p0.ankle.R) < 1e-4,
    `${which}: pelvis and feet do not move`);
  const dL = p1.scap.L[1] - p0.scap.L[1];
  const dR = p1.scap.R[1] - p0.scap.R[1];
  check(Math.abs(dL) > 3 && Math.abs(dR) > 3 && Math.sign(dL) === Math.sign(dR),
    `${which}: both shoulder blades take part, turning the same way about the trunk — one protracts, one retracts (L ${deg(dL)}, R ${deg(dR)})`);

  // …and back: no ratchet.
  await page.evaluate((which, back) => {
    const app = window.__app;
    for (let i = 0; i < 10; i++) app.turnFrame(app[which], (-back / 10) * Math.PI / 180);
  }, which, applied);
  await settle();
  const p2 = await probe(which);
  const back = Math.max(dist(p2.elbow.L, p0.elbow.L), dist(p2.elbow.R, p0.elbow.R));
  const backScap = Math.max(...['L', 'R'].flatMap((s) => [1, 2].map((ax) => Math.abs(p2.scap[s][ax] - p0.scap[s][ax]))));
  check(back < 0.002 && backScap < 0.5, `${which}: turning back retraces (elbows ${mm(back)}, blades ${deg(backScap)} from the start)`);
  if (which === 'follower') await page.screenshot({ path: `${outDir}/arm-frame-turned.png` });
}

// A turn far past the shoulders' range clamps, and what it DID apply is rigid.
await freshPose();
{
  const p0 = await probe('follower');
  const applied = await page.evaluate(() => {
    const app = window.__app;
    let sum = 0;
    for (let i = 0; i < 30; i++) sum += app.turnFrame(app.follower, 5 * Math.PI / 180);
    return sum * 180 / Math.PI;
  });
  await settle();
  const p1 = await probe('follower');
  const status = await page.evaluate(() => document.getElementById('status-line')?.textContent ?? '');
  check(applied < 149 && applied > 10, `a 150° request clamps at the shoulders' range (applied ${deg(applied)})`);
  const dd = Math.abs(dist(p1.elbow.L, p1.elbow.R) - dist(p0.elbow.L, p0.elbow.R));
  const dy = Math.max(Math.abs(p1.elbow.L.y - p0.elbow.L.y), Math.abs(p1.elbow.R.y - p0.elbow.R.y));
  check(dd < 0.004 && dy < 0.003, `the clamped frame is still rigid (spacing ${mm(dd)}, height ${mm(dy)})`);
  void status;
}

// ============================================================ 2. elbow hold
console.log('\n— elbow hold (app.setElbowsFixed) —');
const EDITS = [
  ['chest rotated 18°', (w) => { const a = window.__app; a.editJoint(a[w], 'chest', () => { a[w].nodes.chest.rotation.y += 18 * Math.PI / 180; }); }],
  ['hips twisted 20°', (w) => { const a = window.__app; a.pivotHips(a[w], 20 * Math.PI / 180); }],
  ['spine + chest side-bent/turned', (w) => { const a = window.__app; a.editJoint(a[w], 'spine', () => { a[w].nodes.spine.rotation.y -= 6 * Math.PI / 180; a[w].nodes.chest.rotation.y -= 12 * Math.PI / 180; }); }],
  ['whole dancer pivoted 15° on the support foot', (w) => { const a = window.__app; a.setMovePivot('foot'); a.turnFigure(a[w], 15 * Math.PI / 180); }],
];
for (const [label, edit] of EDITS) {
  for (const hold of [false, true]) {
    await freshPose();
    const p0 = await probe('follower');
    await page.evaluate((hold) => window.__app.setElbowsFixed('follower', hold), hold);
    await page.evaluate(edit, 'follower');
    await settle(350);
    const p1 = await probe('follower');
    const moved = Math.max(dist(p1.elbow.L, p0.elbow.L), dist(p1.elbow.R, p0.elbow.R));
    const fa = Math.max(basisAngle(p1.forearm.L, p0.forearm.L), basisAngle(p1.forearm.R, p0.forearm.R));
    if (hold) {
      check(moved < 0.003, `HOLD ON, ${label}: both elbows stay put in the room (${mm(moved)})`);
      check(fa < 2.0, `HOLD ON, ${label}: forearms keep their orientation (${deg(fa)})`);
      if (label.startsWith('chest')) {
        const dL = p1.scap.L[1] - p0.scap.L[1];
        const dR = p1.scap.R[1] - p0.scap.R[1];
        check(Math.abs(dL) > 3 && Math.abs(dR) > 3 && Math.sign(dL) === Math.sign(dR),
          `HOLD ON, ${label}: the blades absorb part of it (L ${deg(dL)}, R ${deg(dR)})`);
        await page.screenshot({ path: `${outDir}/arm-frame-hold.png` });
      }
    } else if (!label.startsWith('hips')) {
      // POSITIVE CONTROL. (The hips twist is exempt: it holds the chest still by
      // design, so the elbows do not move with or without the hold.)
      check(moved > 0.02, `hold off, ${label}: the same edit DOES move the elbows (${mm(moved)}) — positive control`);
    }
  }
}

// A forearm the user is posing keeps the orientation they give it.
await freshPose();
{
  await page.evaluate(() => window.__app.setElbowsFixed('follower', true));
  const p0 = await probe('follower');
  await page.evaluate(() => {
    const a = window.__app;
    a.selectJoint(a.follower, 'elbow_L');
    a.editJoint(a.follower, 'elbow_L', () => { a.follower.nodes.elbow_L.rotation.x -= 25 * Math.PI / 180; });
  });
  await settle(600); // past the edit-hold window: the hold must not snap it back
  const p1 = await probe('follower');
  check(basisAngle(p1.forearm.L, p0.forearm.L) > 15, `a held elbow can still be BENT by hand (${deg(basisAngle(p1.forearm.L, p0.forearm.L))} of forearm change survives)`);
  check(dist(p1.elbow.L, p0.elbow.L) < 0.003, `…and its position still holds (${mm(dist(p1.elbow.L, p0.elbow.L))})`);
  await page.evaluate(() => window.__app.deselect());
}

// An outright pose re-captures instead of wrenching.
await freshPose();
{
  await page.evaluate(() => window.__app.setElbowsFixed('follower', true));
  const i = await presetIndex('close embrace');
  await page.evaluate((i) => window.__app.applyPreset(i), i);
  await page.evaluate(() => window.__app.setElbowsFixed('follower', false));
  await settle();
  const free = await probe('follower');
  await page.evaluate((i) => { const a = window.__app; a.setElbowsFixed('follower', true); a.applyPreset(i); }, await presetIndex('standing'));
  await page.evaluate((i) => window.__app.applyPreset(i), i);
  await settle();
  const held = await probe('follower');
  const off = Math.max(dist(held.elbow.L, free.elbow.L), dist(held.elbow.R, free.elbow.R));
  check(off < 0.003, `a preset applied with the hold on lands as authored — the hold re-captures (${mm(off)})`);
  const t = await page.evaluate(() => window.__app.elbowHoldTargets().filter((x) => x.figure === 1));
  const tOff = Math.max(...t.map((x) => dist({ x: x.pos[0], y: x.pos[1], z: x.pos[2] }, held.elbow[x.side])));
  check(tOff < 0.003, `…and its targets sit on the new pose's elbows (${mm(tOff)})`);
}

// With Hold embrace ON, a held follower keeps her hands; the leader comes to her.
await freshPose();
{
  await page.evaluate(() => window.__app.setEmbrace({ hands: true }));
  await settle(600);
  await page.evaluate(() => window.__app.setElbowsFixed('follower', true));
  await settle(300);
  const f0 = await probe('follower');
  await page.evaluate(() => { const a = window.__app; a.editJoint(a.follower, 'chest', () => { a.follower.nodes.chest.rotation.y += 15 * Math.PI / 180; }); });
  await settle(900);
  const f1 = await probe('follower');
  const l1 = await probe('leader');
  const moved = Math.max(dist(f1.elbow.L, f0.elbow.L), dist(f1.elbow.R, f0.elbow.R));
  check(moved < 0.003, `embrace ON + hold: her elbows still hold through a chest turn (${mm(moved)})`);
  const palmMove = Math.hypot(...f1.palm.R.map((v, i) => v - f0.palm.R[i]));
  check(palmMove < 0.01, `embrace ON + hold: her open-side palm stays where it was (${mm(palmMove)})`);
  const clasp = Math.hypot(...f1.palm.R.map((v, i) => v - l1.palm.L[i]));
  check(clasp < 0.06, `embrace ON + hold: the leader's open hand is still with hers (${mm(clasp)} palm to palm)`);
}

// ============================================================ 3. real input
console.log('\n— real input —');
await freshPose();
{
  // Move hips → Frame, through the toolbar.
  await page.click('#mode-buttons button[data-mode="hips"]');
  await page.click('#hips-tools button[data-hips-tool="frame"]');
  await sleep(200);
  const st = await page.evaluate(() => ({
    tool: window.__app.hipsTool,
    plantHidden: document.getElementById('hips-plant').hidden,
  }));
  check(st.tool === 'frame', 'the Frame button selects the frame tool');
  check(st.plantHidden, 'the Planted checkboxes are hidden in Frame (they belong to the slide)');

  // On the follower: both directions are open to her from this pose.
  await page.evaluate(() => window.__app.selectFigure(window.__app.follower));
  const which = 'follower';
  const p0 = await probe(which);
  // ←/→ nudges
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.mouse.move(600, 500);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await settle();
  const p1 = await probe(which);
  const swing = wrap(azimuth(midOf(p1), p1.chest) - azimuth(midOf(p0), p0.chest));
  check(swing > 3, `← nudges turn the frame (${deg(swing)} of midpoint swing about the chest)`);
  check(Math.abs(dist(p1.elbow.L, p1.elbow.R) - dist(p0.elbow.L, p0.elbow.R)) < 0.002, '…rigidly');

  // A REAL pointer drag on the ring. Its on-screen radius depends on the camera
  // distance, so sweep for it (dev-verify-turns.mjs's technique): with orbit
  // disabled a miss does nothing, and the STRONGEST radius is the one measured.
  // The drag is screen-HORIZONTAL — TransformControls turns a Y ring by
  // drag · (axis × eye), which is horizontal on screen.
  const centre = () => page.evaluate((which) => {
    const app = window.__app;
    app.orbit.enabled = false;
    const v = app[which].nodes.chest.getWorldPosition(app[which].group.position.clone()).project(app.camera);
    return [(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight];
  }, which);
  const dragAt = async (x, y, len = 110) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let s = 1; s <= 9; s++) await page.mouse.move(x + s * (len / 9), y);
    await page.mouse.up();
    await settle(120);
  };
  const resetFrame = () => page.evaluate((which) => {
    const app = window.__app;
    app.applyPreset(window.__framePreset);
    app.selectFigure(app[which]);
  }, which);
  await page.evaluate((i) => { window.__framePreset = i; }, await presetIndex(POSE));
  let best = { r: 0, turned: 0 };
  for (let r = 20; r <= 230; r += 10) {
    await resetFrame();
    await settle(80);
    const a = await probe(which);
    const c = await centre();
    await dragAt(c[0] + r, c[1]);
    const b = await probe(which);
    const turned = wrap(azimuth(midOf(b), b.chest) - azimuth(midOf(a), a.chest));
    if (Math.abs(turned) > Math.abs(best.turned)) best = { r, turned };
  }
  if (Math.abs(best.turned) < 2) {
    check(false, 'frame ring: no drag radius turned the frame — the gizmo was never engaged (UNTESTED, not a pass)');
  } else {
    await resetFrame();
    await settle(80);
    const q0 = await probe(which);
    const c = await centre();
    await dragAt(c[0] + best.r, c[1]);
    const q1 = await probe(which);
    const drag = Math.abs(wrap(azimuth(midOf(q1), q1.chest) - azimuth(midOf(q0), q0.chest)));
    check(drag > 3, `a REAL pointer drag on the chest ring turns the frame (${deg(drag)} at r=${best.r}px)`);
    check(Math.abs(dist(q1.elbow.L, q1.elbow.R) - dist(q0.elbow.L, q0.elbow.R)) < 0.002
      && dist(q1.chest, q0.chest) < 1e-4, '…rigidly, with the chest still');
    await page.screenshot({ path: `${outDir}/arm-frame-ring.png` });
  }
  await page.evaluate(() => { window.__app.orbit.enabled = true; });
  await page.click('#hips-tools button[data-hips-tool="slide"]');
  await page.click('#mode-buttons button[data-mode="rotate"]');
}

// The panel's checkbox.
{
  await page.evaluate(() => {
    const a = window.__app;
    a.activateTab?.('pose');
    const s = document.getElementById('embrace-section');
    if (s.classList.contains('collapsed')) s.querySelector('.collapse-toggle').click();
  });
  await page.click('#elbow-fix-1');
  await sleep(150);
  const on = await page.evaluate(() => ({ held: window.__app.elbowsFixed('follower'), leader: window.__app.elbowsFixed('leader') }));
  check(on.held && !on.leader, 'the "follower" box fixes the follower\'s elbows and nobody else\'s');
  await page.screenshot({ path: `${outDir}/arm-frame-panel.png` });
  await page.evaluate(() => window.__app.setElbowsFixed('follower', false));
  await sleep(100);
  const box = await page.evaluate(() => document.getElementById('elbow-fix-1').checked);
  check(!box, 'releasing the hold from code unticks the box');
}

await browser.close();
if (logs.length) { console.log('\nConsole errors:'); for (const l of logs) console.log('  ', l); } else console.log('\nNo console errors.');
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('All arm-frame checks passed.');
