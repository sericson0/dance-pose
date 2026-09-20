// Dev check for the Draw mode (floor annotations: line / arrow / circle /
// text — scripted API and real two-click pointer authoring) and the COG
// click-to-front highlight. Screenshots + console errors + numeric checks.
// Honours DEV_URL (default http://localhost:5173) so it can run against a
// dev server on another port.
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
const BASE = process.env.DEV_URL || 'http://localhost:5173';
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

await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Screen (CSS px) coordinates of a world point, via any borrowed Vector3.
async function toScreen(x, y, z) {
  return page.evaluate(([wx, wy, wz]) => {
    const app = window.__app;
    const v = app.leader.group.position.clone().set(wx, wy, wz);
    v.project(app.camera);
    return [(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight];
  }, [x, y, z]);
}

// ---- 1. Scripted annotations: one of each type, parameters round-trip.
const diag1 = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.clearDrawings();
  app.addDrawLine({ x: -0.8, z: 0.6 }, { x: -0.2, z: 0.6 });
  app.addDrawArrow({ x: -0.8, z: 0.95 }, { x: -0.1, z: 0.95 });
  app.addDrawCircle({ x: 0.65, z: 0.65 }, 0.35);
  app.addDrawText({ x: 0.1, z: -0.85 }, 'giro');
  const g = app.draw.group;
  const line = g.children[0].children[0];
  const arrowHead = g.children[1].children[1];
  const circle = g.children[2];
  const text = g.children[3];
  return {
    list: app.drawings,
    lineMid: { x: line.position.x, y: line.position.y, z: line.position.z },
    arrowTip: { x: arrowHead.position.x, z: arrowHead.position.z },
    circlePos: { x: circle.position.x, z: circle.position.z },
    circleOuter: circle.geometry.parameters.outerRadius,
    textHasMap: !!(text.material.map && text.material.map.image && text.material.map.image.width > 4),
    count: app.draw.count,
  };
});
const types = diag1.list.map((a) => a.type).join(',');
if (types !== 'line,arrow,circle,text') problems.push(`annotation types wrong: ${types}`);
if (diag1.count !== 4) problems.push(`expected 4 drawings, got ${diag1.count}`);
if (Math.abs(diag1.lineMid.x - -0.5) > 1e-6 || Math.abs(diag1.lineMid.z - 0.6) > 1e-6 || diag1.lineMid.y < 0.003) {
  problems.push(`line mid off: ${JSON.stringify(diag1.lineMid)}`);
}
if (Math.abs(diag1.arrowTip.x - -0.1) > 1e-6 || Math.abs(diag1.arrowTip.z - 0.95) > 1e-6) {
  problems.push(`arrow tip off: ${JSON.stringify(diag1.arrowTip)}`);
}
if (Math.abs(diag1.circlePos.x - 0.65) > 1e-6 || Math.abs(diag1.circleOuter - 0.35) > 0.02) {
  problems.push(`circle off: pos ${JSON.stringify(diag1.circlePos)} outer ${diag1.circleOuter}`);
}
if (!diag1.textHasMap) problems.push('text annotation has no canvas texture');
console.log(`--- Scripted annotations: ${types}, circle outer r ${diag1.circleOuter.toFixed(3)}`);

await page.evaluate(() => window.__app.setView('top'));
await sleep(400);
await page.screenshot({ path: `${outDir}/draw-scripted-top.png` });
await page.evaluate(() => window.__app.setView('three'));
await sleep(400);
await page.screenshot({ path: `${outDir}/draw-scripted-three.png` });

// ---- 2. Remove-last and clear.
const diag2 = await page.evaluate(() => {
  const app = window.__app;
  app.removeLastDrawing();
  const afterRemove = app.draw.count;
  app.clearDrawings();
  return { afterRemove, afterClear: app.draw.count, listAfterClear: app.drawings.length };
});
if (diag2.afterRemove !== 3) problems.push(`removeLast left ${diag2.afterRemove} (want 3)`);
if (diag2.afterClear !== 0 || diag2.listAfterClear !== 0) problems.push(`clear left ${diag2.afterClear}`);
console.log(`--- Remove/clear: ${diag2.afterRemove} after remove, ${diag2.afterClear} after clear`);

// ---- 3. Real two-click authoring: Draw mode via the topbar, arrow tool,
// two floor clicks from the top view; then a text click with prompt stubbed.
await page.evaluate(() => window.__app.setView('top'));
await sleep(500);
await page.click('#mode-buttons button[data-mode="draw"]');
const modeState = await page.evaluate(() => ({
  mode: window.__app.mode,
  toolsHidden: document.getElementById('draw-tools').hidden,
}));
if (modeState.mode !== 'draw') problems.push(`Draw button set mode ${modeState.mode}`);
if (modeState.toolsHidden) problems.push('draw tools stayed hidden in Draw mode');
await page.click('#draw-tools button[data-tool="arrow"]');

const A = [1.15, 0.35], B = [1.15, 1.25];
const [ax, ay] = await toScreen(A[0], 0, A[1]);
await page.mouse.click(ax, ay);
await sleep(150);
const pending = await page.evaluate(() => ({
  pending: !!window.__app.drawPending,
  preview: window.__app.draw.previewGroup.children.length,
}));
if (!pending.pending) problems.push('first draw click did not arm a pending shape');
const [bx, by] = await toScreen(B[0], 0, B[1]);
// Nudge the pointer first so the rubber-band preview path runs too.
await page.mouse.move((ax + bx) / 2, (ay + by) / 2);
await sleep(100);
await page.mouse.click(bx, by);
await sleep(150);
const clicked = await page.evaluate(() => {
  const app = window.__app;
  return {
    pending: !!app.drawPending,
    preview: app.draw.previewGroup.children.length,
    list: app.drawings,
  };
});
if (clicked.pending || clicked.preview !== 0) problems.push('pending/preview not cleared after second click');
const arrow = clicked.list[clicked.list.length - 1];
if (!arrow || arrow.type !== 'arrow') problems.push(`two-click arrow missing: ${JSON.stringify(clicked.list)}`);
else if (Math.hypot(arrow.a[0] - A[0], arrow.a[1] - A[1]) > 0.03
      || Math.hypot(arrow.b[0] - B[0], arrow.b[1] - B[1]) > 0.03) {
  problems.push(`two-click arrow endpoints off: ${JSON.stringify(arrow)}`);
}
console.log(`--- Two-click arrow: ${JSON.stringify(arrow)}`);

await page.evaluate(() => { window.prompt = () => 'ocho'; });
await page.click('#draw-tools button[data-tool="text"]');
const [tx, ty] = await toScreen(-1.15, 0, 0.8);
await page.mouse.click(tx, ty);
await sleep(150);
const textAnn = await page.evaluate(() => window.__app.drawings.at(-1));
if (!textAnn || textAnn.type !== 'text' || textAnn.text !== 'ocho') {
  problems.push(`click-placed text wrong: ${JSON.stringify(textAnn)}`);
}
console.log(`--- Click text: ${JSON.stringify(textAnn)}`);
await sleep(200);
await page.screenshot({ path: `${outDir}/draw-two-click.png` });

// ---- 3b. Chalk colour + stroke width. The toolbar's swatch and slider set the
// look of the NEXT shape when nothing is selected, and restyle the SELECTED
// shape when there is one — one control, two meanings, and the second is the
// half that makes a finished diagram editable.
await page.evaluate(() => {
  const app = window.__app;
  app.clearDrawings();
  app.selectDrawing(null);
  const c = document.getElementById('draw-color');
  c.value = '#66d9ff';
  c.dispatchEvent(new Event('input'));
  const w = document.getElementById('draw-width');
  w.value = '0.05';
  w.dispatchEvent(new Event('input'));
});
const styled = await page.evaluate(() => {
  const app = window.__app;
  app.addDrawLine({ x: -1.0, z: 0.5 }, { x: 0.2, z: 0.5 });
  app.addDrawCircle({ x: 0.9, z: -0.4 }, 0.4);
  const stroke = app.draw.group.children[0].children[0];
  return {
    ann: app.drawings[0],
    matColor: `#${stroke.material.color.getHexString()}`,
    geoW: stroke.geometry.parameters.height,
  };
});
if (styled.ann.color !== '#66d9ff' || Math.abs(styled.ann.width - 0.05) > 1e-9) {
  problems.push(`new line did not take the toolbar style: ${JSON.stringify(styled.ann)}`);
}
// The RENDERED stroke, not just the record: the annotation is the drawing, so
// a style that does not reach the geometry is a style that does not exist.
if (Math.abs(styled.geoW - 0.05) > 1e-9) problems.push(`stroke geometry width ${styled.geoW}, want 0.05`);
if (styled.matColor !== '#66d9ff') problems.push(`stroke material colour ${styled.matColor}, want #66d9ff`);

const restyled = await page.evaluate(() => {
  const app = window.__app;
  app.selectDrawing(app.draw.group.children[0]);
  const handles = app.draw.handleGroup.children.length;
  const c = document.getElementById('draw-color');
  c.value = '#ff5f8a';
  c.dispatchEvent(new Event('input'));
  return {
    handles,
    line: app.drawings[0],
    circle: app.drawings[1],
    order: app.drawings.map((a) => a.type).join(','),
    selectionFollowed: app.drawSelected === app.draw.group.children[0],
    swatch: document.getElementById('draw-color').value,
  };
});
if (restyled.handles !== 2) problems.push(`a selected line showed ${restyled.handles} endpoint handles, want 2`);
if (restyled.line.color !== '#ff5f8a') problems.push(`the swatch did not recolour the selection: ${restyled.line.color}`);
if (restyled.circle.color !== '#66d9ff') problems.push(`recolouring the selection bled onto the circle: ${restyled.circle.color}`);
// A restyle rebuilds the shape from its record; the rebuilt object has to land
// back at its own index, because that order is what ⌫ Last removes from.
if (restyled.order !== 'line,circle') problems.push(`the rebuild reordered the drawings: ${restyled.order}`);
if (!restyled.selectionFollowed) problems.push('the selection did not follow the rebuilt object');
console.log(`--- Style: new line ${styled.ann.color} @ ${styled.geoW}m; restyled selection ${restyled.line.color}, circle left ${restyled.circle.color}`);

// ---- 3c. A line is a SEGMENT with a movable end at each side: scripted first,
// then a real pointer drag (which must move the end, not orbit the camera, and
// must not also author a new shape).
const movedEnd = await page.evaluate(() => {
  const app = window.__app;
  app.moveDrawHandle(app.draw.group.children[0], 1, { x: 0.2, z: 1.4 });
  return {
    ann: app.drawings[0],
    handles: app.draw.handleGroup.children.map((h) => [h.position.x, h.position.z]),
  };
});
if (Math.abs(movedEnd.ann.b[1] - 1.4) > 1e-6) problems.push(`moveDrawHandle did not move the end: ${JSON.stringify(movedEnd.ann)}`);
if (Math.abs(movedEnd.handles[1][1] - 1.4) > 1e-6) problems.push(`the handle did not follow its end: ${JSON.stringify(movedEnd.handles)}`);

const camBefore = await page.evaluate(() => {
  const p = window.__app.camera.position;
  return [p.x, p.y, p.z];
});
const [ex, ey] = await toScreen(movedEnd.ann.a[0], 0.01, movedEnd.ann.a[1]);
const [dx2, dy2] = await toScreen(-0.6, 0.01, -0.9);
// The grab is armed by HOVER, like the clip title's — OrbitControls listens on
// the same canvas and would have started a camera rotate by the time a
// pointerdown handler of ours ran.
await page.mouse.move(ex, ey);
await sleep(200);
await page.mouse.down();
for (let i = 1; i <= 6; i++) {
  await page.mouse.move(ex + (dx2 - ex) * i / 6, ey + (dy2 - ey) * i / 6);
  await sleep(60);
}
await page.mouse.up();
await sleep(250);
const dragged = await page.evaluate(() => {
  const app = window.__app;
  const p = app.camera.position;
  return { ann: app.drawings[0], cam: [p.x, p.y, p.z], count: app.draw.count };
});
const landed = Math.hypot(dragged.ann.a[0] - -0.6, dragged.ann.a[1] - -0.9);
if (landed > 0.06) problems.push(`the endpoint drag landed ${landed.toFixed(3)} m from the cursor: ${JSON.stringify(dragged.ann.a)}`);
const camMoved = Math.hypot(...dragged.cam.map((v, i) => v - camBefore[i]));
if (camMoved > 1e-3) problems.push(`the endpoint drag orbited the camera by ${camMoved.toFixed(3)}`);
if (dragged.count !== 2) problems.push(`the endpoint drag also authored a shape: ${dragged.count} drawings`);
console.log(`--- Endpoint drag: landed within ${landed.toFixed(3)} m, camera moved ${camMoved.toFixed(4)}, ${dragged.count} drawings`);
await page.screenshot({ path: `${outDir}/draw-selected.png` });

// ---- 3d. A click on a finished drawing selects it (and the toolbar follows
// its look) rather than starting a new shape; Delete removes the selection.
await page.evaluate(() => window.__app.selectDrawing(null));
const [mx, my] = await toScreen((dragged.ann.a[0] + dragged.ann.b[0]) / 2, 0.01, (dragged.ann.a[1] + dragged.ann.b[1]) / 2);
await page.mouse.move(mx, my);
await sleep(150);
await page.mouse.click(mx, my);
await sleep(250);
const picked = await page.evaluate(() => ({
  type: window.__app.drawSelected?.userData.annotation.type ?? null,
  pending: !!window.__app.drawPending,
  count: window.__app.draw.count,
  swatch: document.getElementById('draw-color').value,
  delDisabled: document.getElementById('draw-delete').disabled,
}));
if (picked.type !== 'line') problems.push(`a click on a finished drawing selected ${picked.type}`);
if (picked.pending) problems.push('a click on a finished drawing also armed a new shape');
if (picked.swatch !== '#ff5f8a') problems.push(`the toolbar swatch did not follow the selection: ${picked.swatch}`);
if (picked.delDisabled) problems.push('"✕ Selected" stayed disabled with a drawing selected');

// The handles are editing chrome: they belong with the gizmos, out of a photo.
const shot = await page.evaluate(() => {
  const app = window.__app;
  const url = app.photoDataURL(1);
  return { png: url.startsWith('data:image/png'), handlesBack: app.draw.handleGroup.visible };
});
if (!shot.png) problems.push('photoDataURL did not return a PNG with drawings on screen');
if (!shot.handlesBack) problems.push('the photo left the drawing handles hidden');

await page.keyboard.press('Delete');
await sleep(250);
const deleted = await page.evaluate(() => ({
  count: window.__app.draw.count,
  sel: !!window.__app.drawSelected,
  handles: window.__app.draw.handleGroup.children.length,
}));
if (deleted.count !== 1 || deleted.sel || deleted.handles !== 0) problems.push(`Delete left ${JSON.stringify(deleted)}`);
console.log(`--- Click-to-select: ${picked.type}, toolbar ${picked.swatch}; Delete left ${deleted.count} drawing, ${deleted.handles} handles`);

// ---- 3e. ANCHORED ends: a line/arrow end can ride a JOINT instead of the
// floor, which is the only way to annotate the dancer rather than the ground.
// The test that matters is that the end STAYS on its joint when the pose
// changes — a line that merely starts in the right place is a floor line that
// happens to be lifted.
const anchored = await page.evaluate(() => {
  const app = window.__app;
  app.clearDrawings();
  app.applyPreset(1);
  app.addDrawLine({ fig: 0, joint: 'wrist_L' }, { fig: 'follower', joint: 'shoulder_R' });
  const tube = app.draw.group.children[0].children[0];
  const w = app.leader.surfacePos('wrist_L');
  return {
    ann: app.drawings[0],
    count: app.draw.anchoredCount,
    gap: tube.position.distanceTo(w),
    depthTest: tube.material.depthTest,
  };
});
if (anchored.ann.aAt?.joint !== 'wrist_L') problems.push(`the anchor was not stored: ${JSON.stringify(anchored.ann)}`);
// 'follower' has to resolve to the figure INDEX, since that is what a saved
// annotation carries.
if (anchored.ann.bAt?.fig !== 1) problems.push(`'follower' resolved to ${JSON.stringify(anchored.ann.bAt)}`);
if (anchored.count !== 1) problems.push(`anchoredCount ${anchored.count}, want 1`);
if (anchored.gap > 0.005) problems.push(`the anchored end sits ${anchored.gap.toFixed(3)} m from its joint`);
// It has to draw THROUGH the dancer; depth-tested it is buried in the torso.
if (anchored.depthTest !== false) problems.push('an anchored stroke is depth-tested — it would hide inside the body');

const followed = await page.evaluate(async () => {
  const app = window.__app;
  const before = app.leader.surfacePos('wrist_L').clone();
  app.leader.setJointDegrees({ shoulder_L: { x: -80, z: 40 }, elbow_L: { x: -90 } });
  app.requestSim();
  await new Promise((r) => setTimeout(r, 600));
  const tube = app.draw.group.children[0].children[0];
  const now = app.leader.surfacePos('wrist_L');
  return { moved: before.distanceTo(now), gap: tube.position.distanceTo(now) };
});
if (followed.moved < 0.1) problems.push(`the test pose barely moved the wrist (${followed.moved.toFixed(3)} m) — it proves nothing`);
if (followed.gap > 0.005) problems.push(`after posing, the anchored end is ${followed.gap.toFixed(3)} m from its joint`);
console.log(`--- Anchored line: end ${anchored.gap.toFixed(4)} m from wrist_L, still ${followed.gap.toFixed(4)} m after the wrist moved ${followed.moved.toFixed(2)} m`);

// Two REAL clicks, both landing on joints. Aimed at the RIG node, which is
// where the pick sphere hangs — on a leg joint that is ~6 cm from surfacePos.
await page.evaluate(() => { window.__app.clearDrawings(); window.__app.applyPreset(1); });
await sleep(500);
await page.click('#draw-tools button[data-tool="line"]');
async function jointScreen(fig, joint) {
  return page.evaluate(([f, j]) => {
    const v = window.__app.figures[f].worldPos(j).clone();
    v.project(window.__app.camera);
    return [(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight];
  }, [fig, joint]);
}
const [shx, shy] = await jointScreen(0, 'shoulder_R');
const [knx, kny] = await jointScreen(0, 'knee_L');
await page.mouse.move(shx, shy);
await sleep(200);
// The pick spheres are invisible in body view until something ghosts them, so
// the hover has to light the joint or there is nothing to aim at.
const aimable = await page.evaluate(() => ({
  cursor: document.querySelector('#viewport canvas:not(#hud)').style.cursor,
  ghosted: Math.max(...window.__app.leader.pickSpheres.map((s) => s.material.opacity)),
}));
if (aimable.cursor !== 'pointer') problems.push(`hovering a joint in Draw mode gives cursor "${aimable.cursor}"`);
if (aimable.ghosted < 0.25) problems.push(`Draw mode does not ghost the joints (max opacity ${aimable.ghosted}) — nothing to aim at`);
await page.mouse.click(shx, shy);
await sleep(200);
await page.mouse.move(knx, kny);
await sleep(200);
await page.mouse.click(knx, kny);
await sleep(300);
const clicked2 = await page.evaluate(() => window.__app.drawings.at(-1));
if (clicked2?.aAt?.joint !== 'shoulder_R' || clicked2?.bAt?.joint !== 'knee_L') {
  problems.push(`two clicks on joints gave ${JSON.stringify([clicked2?.aAt, clicked2?.bAt])}`);
}
console.log(`--- Click-authored anchors: ${JSON.stringify(clicked2?.aAt)} → ${JSON.stringify(clicked2?.bAt)} (hover ghosted to ${aimable.ghosted})`);
await sleep(200);
await page.screenshot({ path: `${outDir}/draw-anchored.png` });
await page.evaluate(() => window.__app.clearDrawings());

// ---- 4. COG highlight, scripted: depthTest off + late renderOrder while on.
const diag4 = await page.evaluate(() => {
  const app = window.__app;
  app.clearDrawings();
  app.setCogHighlight(true);
  const v = app.cogViz.leader;
  const on = {
    depthTest: v.cogBall.material.depthTest,
    renderOrder: v.cogBall.renderOrder,
    markerDepth: v.marker.material.depthTest,
    state: app.cogHighlight(),
  };
  return on;
});
if (diag4.depthTest !== false || diag4.renderOrder < 10 || diag4.markerDepth !== false) {
  problems.push(`highlight on state wrong: ${JSON.stringify(diag4)}`);
}
if (!diag4.state.leader || !diag4.state.follower || !diag4.state.couple) {
  problems.push(`setCogHighlight(true) missed a viz: ${JSON.stringify(diag4.state)}`);
}
await page.evaluate(() => window.__app.setView('front'));
await sleep(400);
await page.screenshot({ path: `${outDir}/cog-highlight-front.png` });

const diag4b = await page.evaluate(() => {
  const app = window.__app;
  app.setCogHighlight(false);
  const v = app.cogViz.leader;
  return { depthTest: v.cogBall.material.depthTest, renderOrder: v.cogBall.renderOrder, state: app.cogHighlight() };
});
if (diag4b.depthTest !== true || diag4b.renderOrder !== 0 || diag4b.state.leader) {
  problems.push(`highlight off state wrong: ${JSON.stringify(diag4b)}`);
}
await page.screenshot({ path: `${outDir}/cog-normal-front.png` });
console.log(`--- COG scripted toggle: on ${JSON.stringify(diag4)} / off ${JSON.stringify(diag4b)}`);

// ---- 5. COG highlight by clicking the ball (rotate mode, leader only, side
// view; click just above the ball center so the pelvis pick sphere can't be
// the nearer hit).
await page.click('#mode-buttons button[data-mode="rotate"]');
await page.evaluate(() => {
  const app = window.__app;
  app.setVisibleFigures('leader');
  app.setView('side');
});
await sleep(500);
const ballPos = await page.evaluate(() => {
  const p = window.__app.cogViz.leader.cogBall.position;
  return [p.x, p.y, p.z];
});
const [cx, cy] = await toScreen(...ballPos);
await page.mouse.click(cx, cy - 4);
await sleep(150);
const afterClick = await page.evaluate(() => ({
  front: window.__app.cogViz.leader.front,
  selected: !!window.__app.selected,
}));
if (!afterClick.front) problems.push(`clicking the COG ball did not toggle it in front: ${JSON.stringify(afterClick)}`);
if (afterClick.selected) problems.push('COG click also selected a joint');
await page.screenshot({ path: `${outDir}/cog-click-on.png` });
await page.mouse.click(cx, cy - 4);
await sleep(150);
const afterClick2 = await page.evaluate(() => window.__app.cogViz.leader.front);
if (afterClick2) problems.push('second COG click did not toggle the highlight off');
console.log(`--- COG click toggle: on ${afterClick.front}, off again ${!afterClick2}`);

// ---- 6. Joint picking still works next to the COG (regression): click the
// leader's head sphere, far from the ball.
const headPos = await page.evaluate(() => {
  const app = window.__app;
  const v = app.leader.worldPos('head');
  return [v.x, v.y, v.z];
});
const [hx, hy] = await toScreen(...headPos);
await page.mouse.click(hx, hy);
await sleep(150);
const jointSel = await page.evaluate(() => window.__app.selected?.jointName ?? null);
if (!jointSel) problems.push('joint picking broken after COG routing (head click selected nothing)');
console.log(`--- Joint pick after COG routing: selected ${jointSel}`);

await page.evaluate(() => {
  window.__app.deselect();
  window.__app.setVisibleFigures('both');
});

// ---- 7. The COG line's own width and colour. WebGL ignores
// LineBasicMaterial.linewidth, so the drop line is a TUBE and the slider is its
// diameter — that it is a Mesh at all is the thing that makes "thicker"
// expressible, hence the check. Clicking the line selects it, so the controls
// act on one dancer instead of all three.
await page.evaluate(() => { window.__app.applyPreset(1); window.__app.setView('front'); });
await sleep(600);
const lineStyle = await page.evaluate(() => {
  const app = window.__app;
  const v = app.cogViz.leader;
  const isMesh = v.dropLine.isMesh === true;
  app.setCogLineStyle({ width: 0.02 });
  return { isMesh, radius: v.dropLine.scale.x, style: app.cogLineStyle() };
});
if (!lineStyle.isMesh) problems.push('the COG drop line is a THREE.Line — its width cannot be changed at all');
if (Math.abs(lineStyle.radius - 0.01) > 1e-6) problems.push(`width 0.02 gave radius ${lineStyle.radius}, want 0.01`);

const linePt = await page.evaluate(() => {
  const app = window.__app;
  const l = app.cogViz.leader.dropLine;
  const p = l.position.clone();
  p.y += l.scale.y * 0.5; // halfway up the tube, clear of the ball and the floor
  p.project(app.camera);
  return [(p.x * 0.5 + 0.5) * window.innerWidth, (-p.y * 0.5 + 0.5) * window.innerHeight];
});
await page.mouse.click(linePt[0], linePt[1]);
await sleep(300);
const picked2 = await page.evaluate(() => ({
  selected: window.__app.cogLineSelected,
  target: document.getElementById('cog-line-target').textContent,
  posed: !!window.__app.selected,
}));
if (picked2.selected !== 'leader') problems.push(`clicking the leader's COG line selected ${picked2.selected}`);
if (picked2.target !== 'Leader') problems.push(`the View panel names the target "${picked2.target}"`);
if (picked2.posed) problems.push('clicking the COG line also selected a joint');
const recoloured = await page.evaluate(() => {
  const app = window.__app;
  const el = document.getElementById('cog-line-color');
  el.value = '#22ff88';
  el.dispatchEvent(new Event('input'));
  const read = (k) => `#${app.cogViz[k].dropLine.material.color.getHexString()}`;
  const after = { leader: read('leader'), follower: read('follower') };
  document.getElementById('cog-line-reset').click();
  app.cancelPending(); // Esc deselects the line
  return { after, reset: read('leader'), selected: app.cogLineSelected };
});
if (recoloured.after.leader !== '#22ff88') problems.push(`the selected COG line did not recolour: ${recoloured.after.leader}`);
// Identity colours are how the panel says WHOSE balance this is, so a colour
// picked for one line must not touch the others.
if (recoloured.after.follower === '#22ff88') problems.push('recolouring the selected COG line bled onto the follower');
if (recoloured.reset === '#22ff88') problems.push('Reset did not hand the line back its dancer colour');
if (recoloured.selected !== null) problems.push(`Esc left the COG line selected (${recoloured.selected})`);
console.log(`--- COG line: radius ${lineStyle.radius}, selected ${picked2.selected}, recoloured ${recoloured.after.leader} (follower ${recoloured.after.follower}), reset ${recoloured.reset}`);
await page.screenshot({ path: `${outDir}/cog-line-style.png` });
await page.evaluate(() => window.__app.setCogLineStyle({ width: 0.006, color: null }));

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
