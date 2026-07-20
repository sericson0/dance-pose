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

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
