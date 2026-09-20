// Dev check for FLOATING TEXT: a floor annotation of type 'text' anchored to a
// joint, hanging above it, and always turned to face the camera.
//
// The shape of the feature, and so the shape of this script:
//  1. The record is the a-end anchor vocabulary reused — `posAt` beside `pos`,
//     plus a `lift` — and the words really sit that far above the joint's
//     surfacePos (NOT worldPos: the pick sphere hangs on the rig node and the
//     two are up to ~6 cm apart on a leg, so measuring against the wrong one
//     would hide a real offset behind a tolerance).
//  2. It STAYS there once the dancer is posed AND once the dancer is moved. A
//     caption that merely starts over the right joint is a floor label that
//     happens to be lifted — the same class of bug the anchored-line check
//     guards against.
//  3. It faces the camera from several angles, and the sharp case is a
//     CAMERA-ONLY move: main.js renders on demand, so an orbit takes the idle
//     branch and skips the whole solve pass. A billboard driven from the
//     anchored pass (which is gated on anchoredCount) would re-aim only when a
//     dancer happened to move. Angles 2-4 here therefore move the camera
//     DIRECTLY and poke app.requestRender — which is in RENDER_WRAP_SKIP, so
//     unlike every other app.* call it does not secretly request a solve — and
//     they are taken after the wake window has expired, so nothing but the
//     view-only path can be aiming the text. VERIFIED to fail with the
//     idle-branch call removed (the quad stays on the first angle's aim).
//  4. It survives a reload with anchor, lift and text intact, a LEGACY floor
//     text (no posAt, no lift) still loads and stays flat, and a floating text
//     honours `kf.draw` — including that it cannot be CLICKED while filtered
//     out (three's raycaster does not consult `visible`).
//
// Honours DEV_URL (default http://localhost:5173) and BROWSER_PATH.
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

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the scripted API rather than for a fixed 2 s: the GLBs are several
// megabytes and a cold cache (or a machine under load from a previous run's
// browser shutting down) sails straight past it, and the failure then reads as
// "app is undefined" rather than as what it is.
async function ready() {
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => !!window.__app?.draw)) { await sleep(600); return; }
    await sleep(500);
  }
  throw new Error('window.__app never appeared');
}
await ready();

// ---- 1. The record, and where the words actually are ----------------------
const made = await page.evaluate(() => {
  const app = window.__app;
  localStorage.removeItem('tangoPoseStudio.drawings.v1');
  app.applyPreset(1);
  app.clearDrawings();
  app.addDrawText({ fig: 0, joint: 'head' }, 'leader');
  app.addDrawText({ fig: 'follower', joint: 'chest' }, 'follower');
  app.addDrawText({ x: 0.4, z: -1.1 }, 'on the floor');
  const g = app.draw.group;
  const head = app.leader.surfacePos('head');
  const m = g.children[0];
  const flat = g.children[2];
  return {
    list: app.drawings,
    anchoredCount: app.draw.anchoredCount,
    billboardCount: app.draw.billboardCount,
    // The text's own position against the joint it names.
    over: [m.position.x - head.x, m.position.y - head.y, m.position.z - head.z],
    depthTest: m.material.depthTest,
    renderOrder: m.renderOrder,
    billboard: !!m.userData.billboard,
    hasMap: !!(m.material.map?.image?.width > 4),
    // A FLOOR text must be untouched by any of this: flat in the floor plane,
    // depth-tested, not a billboard.
    flatBillboard: !!flat.userData.billboard,
    flatDepth: flat.material.depthTest,
    flatY: flat.position.y,
  };
});
const [a0, a1, a2] = made.list;
if (a0.type !== 'text' || a0.posAt?.joint !== 'head' || a0.posAt.fig !== 0) {
  problems.push(`the text anchor was not stored: ${JSON.stringify(a0)}`);
}
// The floor pair is filled in beside the anchor, exactly as a line's is — a
// hidden dancer or a detach then needs no special case.
if (!Array.isArray(a0.pos) || a0.pos.length !== 2) problems.push(`no floor point kept beside the anchor: ${JSON.stringify(a0.pos)}`);
if (!(a0.lift > 0)) problems.push(`an anchored text got no default lift: ${JSON.stringify(a0.lift)}`);
if (a1.posAt?.fig !== 1) problems.push(`'follower' resolved to ${JSON.stringify(a1.posAt)}`);
// An old-style floor text must keep exactly the record it always had.
if (a2.posAt || a2.lift) problems.push(`a floor text picked up floating fields: ${JSON.stringify(a2)}`);
if (made.anchoredCount !== 2) problems.push(`anchoredCount ${made.anchoredCount}, want 2`);
if (made.billboardCount !== 2) problems.push(`billboardCount ${made.billboardCount}, want 2`);
// Above the joint, and only above it: the lift is world-y, so x/z must agree.
if (Math.abs(made.over[1] - a0.lift) > 0.002) problems.push(`the text sits ${made.over[1].toFixed(3)} m over head, want ${a0.lift}`);
if (Math.hypot(made.over[0], made.over[2]) > 0.002) problems.push(`the text is offset sideways from its joint: ${JSON.stringify(made.over)}`);
if (made.depthTest !== false || made.renderOrder < 6) {
  problems.push(`a floating text is depth-tested / behind the dancers: ${made.depthTest} @ ${made.renderOrder}`);
}
if (!made.billboard || !made.hasMap) problems.push(`floating text flags/texture wrong: ${JSON.stringify(made)}`);
if (made.flatBillboard || made.flatDepth !== true || made.flatY > 0.02) {
  problems.push(`a plain floor text changed behaviour: ${JSON.stringify([made.flatBillboard, made.flatDepth, made.flatY])}`);
}
console.log(`--- Anchored text: ${JSON.stringify(a0.posAt)} lift ${a0.lift}, sits ${made.over[1].toFixed(3)} m over head (${Math.hypot(made.over[0], made.over[2]).toFixed(4)} m sideways), ${made.billboardCount} billboards`);

// ---- 2. It STAYS over the joint through a pose and a move ------------------
const tracked = await page.evaluate(async () => {
  const app = window.__app;
  const gap = () => {
    const h = app.leader.surfacePos('head');
    const m = app.draw.group.children[0].position;
    return Math.hypot(m.x - h.x, m.y - h.y - app.drawings[0].lift, m.z - h.z);
  };
  const before = app.leader.surfacePos('head').clone();
  // A deep trunk bend carries the head a long way, and takes the whole spine
  // with it — a caption that only tracked a translation would be caught here.
  app.leader.setJointDegrees({ spine: { x: 35 }, chest: { x: 20, y: 25 }, neck: { x: 15 } });
  app.requestSim();
  await new Promise((r) => setTimeout(r, 800));
  const posed = { moved: before.distanceTo(app.leader.surfacePos('head')), gap: gap() };
  const at = app.leader.surfacePos('head').clone();
  app.slideFigure(app.leader, 0.6);
  await new Promise((r) => setTimeout(r, 800));
  return { posed, movedBody: at.distanceTo(app.leader.surfacePos('head')), gap: gap() };
});
if (tracked.posed.moved < 0.1) problems.push(`the test pose barely moved the head (${tracked.posed.moved.toFixed(3)} m) — it proves nothing`);
if (tracked.posed.gap > 0.005) problems.push(`after posing, the text is ${tracked.posed.gap.toFixed(3)} m off its joint`);
if (tracked.movedBody < 0.1) problems.push(`the slide barely moved the dancer (${tracked.movedBody.toFixed(3)} m)`);
if (tracked.gap > 0.005) problems.push(`after moving the dancer, the text is ${tracked.gap.toFixed(3)} m off its joint`);
console.log(`--- Rides the dancer: ${tracked.posed.gap.toFixed(4)} m off after a ${tracked.posed.moved.toFixed(2)} m pose change, ${tracked.gap.toFixed(4)} m off after a ${tracked.movedBody.toFixed(2)} m slide`);

// ---- 3. It faces the camera, including on CAMERA-ONLY frames --------------
// How far the text quad is from facing the camera, in degrees.
//
// The billboard is SCREEN-PARALLEL (it copies the camera's own rotation), so
// the invariant to measure is the angle between the quad's orientation and the
// camera's — quaternion to quaternion, which catches a wrong roll as well as a
// wrong aim. Note what is NOT the metric, because it was tried first and reads
// as a permanent ~11° failure: the angle between the quad's normal and the
// direction from the text TO THE CAMERA POSITION. That is parallax, not
// misalignment — an off-centre object is legitimately ~11° off the view axis
// at this field of view, and a billboard that chased it would shear on screen
// instead of staying a clean rectangle. `parallax` is reported here as
// information only.
//
// Vectors/quaternions are borrowed off the scene (the page exposes no THREE),
// exactly as the other draw scripts borrow a Vector3.
const FACING = `(() => {
  const app = window.__app;
  const m = app.draw.group.children.find((o) => o.userData.billboard);
  const fwd = app.camera.position.clone().set(0, 0, 1).applyQuaternion(m.quaternion);
  const toCam = app.camera.position.clone().sub(m.position).normalize();
  return {
    align: m.quaternion.angleTo(app.camera.quaternion) * 180 / Math.PI,
    parallax: fwd.angleTo(toCam) * 180 / Math.PI,
  };
})()`;
async function facingError() {
  return page.evaluate(FACING);
}

// HEADLESS GOTCHA, and it is the reason this reads through a poll rather than a
// sleep: Chrome produces frames only when there is damage to composite, and an
// app that renders ON DEMAND has none while it idles — so requestAnimationFrame
// drops to a trickle (measured: 0-2 callbacks in 1.4 s after the wake window
// expired, varying run to run) and a fixed `await sleep(400)` after a camera
// move reads the PREVIOUS frame's aim about half the time. A screenshot forces
// the compositor to produce a frame, which lets the render loop tick. That
// supplies FRAMES, not the fix: with the billboard pass removed from the idle
// branch, no number of forced frames re-aims the text, because that branch is
// the only one a view-only change ever reaches.
async function settledFacing(limit = 20) {
  let v = await facingError();
  for (let i = 0; i < limit && v.align > 0.5; i++) {
    await page.screenshot({ path: `${outDir}/draw-text-tick.png` });
    await sleep(120);
    v = await facingError();
  }
  return v;
}

// Angle 1 goes through an app method, so the solve pass runs: this is the
// ordinary path.
await page.evaluate(() => window.__app.setView('front'));
await sleep(600);
const face1 = await settledFacing();
await page.screenshot({ path: `${outDir}/draw-text-front.png` });

// Angles 2-4 are CAMERA ONLY. The camera transform is written DIRECTLY — no
// app.* call, because every one of them but requestRender/requestSim is wrapped
// to poke requestSim, which would wake the full solve pass and hide the bug —
// and the wake window is allowed to expire first, so the only thing left that
// can re-aim the text is the view-only branch of the render loop.
const camOnly = [];
for (const [ang, h] of [[2.1, 1.3], [-2.6, 0.5], [0.8, 2.6]]) {
  await sleep(1100); // let the wake window (WAKE_FRAMES ≈ 0.75 s) expire
  const cam = await page.evaluate(([a, y]) => {
    const app = window.__app;
    const t = app.orbit.target;
    app.camera.position.set(t.x + 3.2 * Math.sin(a), y, t.z + 3.2 * Math.cos(a));
    app.camera.lookAt(t);
    app.requestRender(); // view-only: the one app call that does NOT re-solve
    const p = app.camera.position;
    return [p.x, p.y, p.z];
  }, [ang, h]);
  camOnly.push({ ...(await settledFacing()), cam });
}
const aligns = camOnly.map((c) => c.align);
const worst = Math.max(face1.align, ...aligns);
if (worst > 0.5) {
  problems.push(`the text is up to ${worst.toFixed(1)}° off facing the camera (front ${face1.align.toFixed(1)}°, camera-only ${aligns.map((v) => v.toFixed(1)).join('/')}°)`);
}
// Those three views must actually have BEEN different, or a billboard that
// never turned at all would pass by standing still.
const moves = camOnly.slice(1).map((c, i) => Math.hypot(...c.cam.map((v, k) => v - camOnly[i].cam[k])));
if (Math.min(...moves) < 1) problems.push(`the camera-only views barely differ: ${JSON.stringify(moves)}`);
console.log(`--- Billboard: ${face1.align.toFixed(3)}° off through an app call, ${aligns.map((v) => v.toFixed(3)).join('° / ')}° off across three CAMERA-ONLY moves ${moves.map((m) => m.toFixed(1)).join('/')} m apart (parallax to the words ${face1.parallax.toFixed(1)}°)`);
await page.screenshot({ path: `${outDir}/draw-text-orbited.png` });

// A real orbit DRAG, which is what a user does. Note it is NOT the
// discriminating case and is here for realism only: a drag's pointerdown and
// pointerup both poke requestSim, so the full pass is awake throughout and this
// reads a clean 0° even with the idle-branch call removed. The camera-only
// block above is the one that catches it (measured with the fix reverted:
// 120.3° / 149.2° / 50.1° off, against 0.000° with it).
await page.evaluate(() => { window.__app.setView('three'); });
await sleep(600);
await page.mouse.move(750, 420);
await page.mouse.down();
for (let i = 1; i <= 8; i++) { await page.mouse.move(750 - i * 22, 420 - i * 5); await sleep(40); }
const midDrag = await settledFacing();
await page.mouse.up();
await sleep(400);
const afterDrag = await settledFacing();
if (midDrag.align > 0.5 || afterDrag.align > 0.5) {
  problems.push(`during/after a real orbit drag the text is ${midDrag.align.toFixed(1)}° / ${afterDrag.align.toFixed(1)}° off facing`);
}
console.log(`--- Orbit drag: ${midDrag.align.toFixed(3)}° off mid-drag, ${afterDrag.align.toFixed(3)}° after`);

// ---- 3b. Screenshots in both layers ---------------------------------------
// The caption has to read over the clothed avatar AND over the bare bones —
// that it draws through the dancer is what stops it being swallowed by a torso.
await page.evaluate(() => {
  const app = window.__app;
  app.setView('front');
  const sel = document.getElementById('layer-mode');
  sel.value = 'body';
  sel.dispatchEvent(new Event('change'));
});
await sleep(700);
await page.screenshot({ path: `${outDir}/draw-text-body.png` });
await page.evaluate(() => {
  const sel = document.getElementById('layer-mode');
  sel.value = 'skeleton';
  sel.dispatchEvent(new Event('change'));
});
await sleep(700);
await page.screenshot({ path: `${outDir}/draw-text-skeleton.png` });
await page.evaluate(() => {
  const sel = document.getElementById('layer-mode');
  sel.value = 'body';
  sel.dispatchEvent(new Event('change'));
});

// ---- 4. Real click authoring on a joint -----------------------------------
await page.click('#mode-buttons button[data-mode="draw"]');
await page.click('#draw-tools button[data-tool="text"]');
await page.evaluate(() => {
  window.__app.clearDrawings();
  window.prompt = () => 'sacada';
});
await sleep(300);
const [jx, jy] = await page.evaluate(() => {
  const app = window.__app;
  const v = app.leader.worldPos('shoulder_R').clone(); // the pick sphere's node
  v.project(app.camera);
  return [(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight];
});
await page.mouse.move(jx, jy);
await sleep(250);
// The pick spheres are invisible in body view until Draw mode ghosts them, so
// the hover has to light the joint or there is nothing to aim at.
const aim = await page.evaluate(() => ({
  cursor: document.querySelector('#viewport canvas:not(#hud)').style.cursor,
  ghosted: Math.max(...window.__app.leader.pickSpheres.map((s) => s.material.opacity)),
}));
if (aim.cursor !== 'pointer') problems.push(`hovering a joint with the Text tool gives cursor "${aim.cursor}"`);
if (aim.ghosted < 0.25) problems.push(`the Text tool does not ghost the joints (max opacity ${aim.ghosted})`);
await page.mouse.click(jx, jy);
await sleep(350);
const clicked = await page.evaluate(() => {
  const app = window.__app;
  const ann = app.drawings.at(-1);
  const sp = app.leader.surfacePos('shoulder_R');
  const m = app.draw.group.children.at(-1).position;
  return { ann, over: m.y - sp.y, side: Math.hypot(m.x - sp.x, m.z - sp.z) };
});
if (clicked.ann?.posAt?.joint !== 'shoulder_R' || clicked.ann.text !== 'sacada') {
  problems.push(`a click on a joint with the Text tool gave ${JSON.stringify(clicked.ann)}`);
}
if (Math.abs(clicked.over - (clicked.ann?.lift ?? 0)) > 0.005 || clicked.side > 0.005) {
  problems.push(`the click-placed text is not over its joint: ${JSON.stringify(clicked)}`);
}
console.log(`--- Click-authored: ${JSON.stringify(clicked.ann?.posAt)} "${clicked.ann?.text}", ${clicked.over.toFixed(3)} m above the joint`);
await page.click('#mode-buttons button[data-mode="rotate"]');

// ---- 5. Reload, and a legacy floor text -----------------------------------
const before = await page.evaluate(() => {
  const app = window.__app;
  app.clearDrawings();
  app.addDrawText({ fig: 0, joint: 'head' }, 'above the head');
  app.addDrawText({ x: 0.4, z: -1.1 }, 'chalk', 0.75);
  // A record written the way a file saved BEFORE any of this looks: no posAt,
  // no lift. It has to load and stay a flat floor label.
  const legacy = [...app.drawingsJSON(), { type: 'text', pos: [-0.9, 0.7], text: 'legacy', yaw: 0.3 }];
  app.setDrawings(legacy);
  return app.drawingsJSON();
});
await ready();
const after = await page.evaluate(() => {
  const app = window.__app;
  const g = app.draw.group;
  const anchored = g.children.find((o) => o.userData.annotation.posAt);
  const head = app.leader.surfacePos('head');
  const legacy = g.children.find((o) => o.userData.annotation.text === 'legacy');
  return {
    list: app.drawingsJSON(),
    billboardCount: app.draw.billboardCount,
    gap: anchored ? Math.hypot(anchored.position.x - head.x,
      anchored.position.y - head.y - app.drawings.find((a) => a.posAt).lift,
      anchored.position.z - head.z) : null,
    legacyFlat: legacy ? (!legacy.userData.billboard && legacy.material.depthTest === true
      && Math.abs(legacy.rotation.y - 0.3) < 1e-6) : null,
    legacyMap: !!(legacy?.material.map?.image?.width > 4),
  };
});
if (JSON.stringify(before) !== JSON.stringify(after.list)) {
  problems.push(`records changed across the reload:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after.list)}`);
}
if (after.billboardCount !== 1) problems.push(`after the reload ${after.billboardCount} billboards, want 1`);
if (!(after.gap < 0.005)) problems.push(`the restored floating text is ${after.gap} m off its joint`);
if (!after.legacyFlat) problems.push('a legacy floor-text record did not come back flat and yaw-oriented');
if (!after.legacyMap) problems.push('the legacy text has no canvas texture');
console.log(`--- Reload: ${after.list.length} texts, records identical: ${JSON.stringify(before) === JSON.stringify(after.list)}, anchored ${after.gap.toFixed(4)} m off, legacy flat: ${after.legacyFlat}`);

// ---- 6. kf.draw filtering, and it cannot be clicked while filtered out -----
// A REAL click at the words, because three's raycaster does not consult
// `visible` — a drawing a keyframe has filtered out would otherwise still take
// the click, and the user would be selecting and restyling something that is
// not on screen. With the Text tool armed and the prompt returning nothing, a
// click that misses every drawing authors nothing, so "did it select" is the
// whole answer.
await page.evaluate(() => { window.__app.setView('front'); window.prompt = () => ''; });
await sleep(600);
await page.click('#mode-buttons button[data-mode="draw"]');
await page.click('#draw-tools button[data-tool="text"]');
const textScreen = await page.evaluate(() => {
  const app = window.__app;
  const obj = app.draw.group.children.find((o) => o.userData.annotation.posAt);
  const v = obj.position.clone();
  v.project(app.camera);
  return [(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight];
});
await page.mouse.move(textScreen[0], textScreen[1]);
await sleep(200);
await page.mouse.click(textScreen[0], textScreen[1]);
await sleep(300);
const shownPick = await page.evaluate(() => ({
  sel: window.__app.drawSelected?.userData.annotation.text ?? null,
  count: window.__app.draw.count,
}));
const hiddenPick = await page.evaluate(async ([x, y]) => {
  const app = window.__app;
  app.selectDrawing(null);
  const obj = app.draw.group.children.find((o) => o.userData.annotation.posAt);
  const id = obj.userData.annotation.id;
  app.setDrawVisibleIds(app.drawings.map((a) => a.id).filter((i) => i !== id));
  await new Promise((r) => setTimeout(r, 200));
  return { visible: obj.visible, x, y };
}, textScreen);
await page.mouse.click(textScreen[0], textScreen[1]);
await sleep(300);
const afterHiddenClick = await page.evaluate(() => {
  const app = window.__app;
  const out = { sel: app.drawSelected?.userData.annotation.text ?? null, count: app.draw.count };
  app.setDrawVisibleIds(null);
  return { ...out, backVisible: app.draw.group.children.find((o) => o.userData.annotation.posAt).visible };
});
if (shownPick.sel !== 'above the head') problems.push(`a click on the floating text selected ${JSON.stringify(shownPick.sel)}`);
if (hiddenPick.visible) problems.push('kf.draw did not hide the floating text');
if (afterHiddenClick.sel !== null) problems.push(`a filtered-out floating text still took the click: ${afterHiddenClick.sel}`);
if (afterHiddenClick.count !== shownPick.count) problems.push(`the click through the hidden text authored something: ${afterHiddenClick.count}`);
if (!afterHiddenClick.backVisible) problems.push('clearing the filter did not bring the floating text back');
console.log(`--- kf.draw: a click selects it when shown (${shownPick.sel}), hides to ${hiddenPick.visible}, and takes no click while hidden (${afterHiddenClick.sel})`);
await page.click('#mode-buttons button[data-mode="rotate"]');

// Leave the session clean for the next script.
await page.evaluate(() => {
  window.__app.clearDrawings();
  localStorage.removeItem('tangoPoseStudio.drawings.v1');
});

if (problems.length) console.log('\nPROBLEMS:\n' + problems.join('\n'));
else console.log('\nAll floating-text checks passed.');
console.log(logs.length ? `\nConsole errors:\n${logs.join('\n')}` : '\nNo console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
