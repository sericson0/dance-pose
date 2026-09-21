// Dev check for two Draw-mode features, both measured on the RENDERED meshes
// (a stroke is a unit tube that is only ever re-placed, so its transform IS the
// drawing — a record that says the right thing over geometry that does not is
// the class of bug this suite keeps finding):
//
//  • EXTEND — a line or arrow run on past both of its points, in the same
//    direction. A line pinned hip to hip with `extend: 0.3` must render 0.3 m
//    past EACH hip, stay collinear with the hips once the dancer is posed, and
//    leave its handles on the hips themselves (the ends are where you put
//    them; only the stroke runs on). Records keep NO `extend` key at 0, and a
//    restored legacy record must not inherit the toolbar's running value.
//  • FACING — an arrow defined by another drawing: from that line's midpoint,
//    level with the floor, square to the line. On a hip-to-hip line it must
//    point where the PELVIS faces, follow the hips through a twist while the
//    chest holds (the dissociation it exists to show), and stay LEVEL when the
//    pelvis is tilted so the hip line is not. Flip, the tip handle (length and,
//    across the line, side), the cascade on delete, the reload round trip, and
//    REAL pointer authoring with the toolbar's Facing tool + a REAL drag of the
//    tip are all covered.
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
page.on('dialog', (d) => d.accept());
let first = true;
await page.evaluateOnNewDocument(() => {
  // Cleared once, on the first load only — the reload round trip needs storage.
  if (!sessionStorage.getItem('__seen')) { try { localStorage.clear(); } catch { /* */ } sessionStorage.setItem('__seen', '1'); }
});
const load = async () => {
  await (first ? page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 }) : page.reload({ waitUntil: 'networkidle0', timeout: 60000 }));
  first = false;
  await page.waitForFunction(() => !!window.__app && !document.getElementById('loading-overlay'), { timeout: 60000 });
};
await load();

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`); if (!ok) problems.push(msg); };
const mm = (v) => `${(v * 1000).toFixed(1)} mm`;
const deg = (v) => `${v.toFixed(2)}°`;
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const len = (a) => Math.hypot(...a);
const unit = (a) => a.map((v) => v / (len(a) || 1));
const angle = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(unit(a), unit(b))))) * 180 / Math.PI;
const settle = async (ms = 250) => { await page.evaluate(() => window.__app.requestSim(8)); await sleep(ms); };

// The rendered stroke of drawing `i`: where its tube starts, where the shape
// ENDS (the cone's tip for an arrow, the tube's far end for a line), plus the
// hips / pelvis the checks compare against.
const measure = (i) => page.evaluate((i) => {
  const app = window.__app;
  const o = app.draw.group.children[i];
  const f = app.follower;
  f.group.updateMatrixWorld(true);
  o.updateMatrixWorld(true);
  const [tube, head] = o.children;
  const e = tube.matrixWorld.elements;
  const start = [e[12], e[13], e[14]];
  const axis = [e[4], e[5], e[6]]; // the tube's local +y, scaled by its length
  const tubeEnd = start.map((v, k) => v + axis[k]);
  const tip = head ? [head.matrixWorld.elements[12], head.matrixWorld.elements[13], head.matrixWorld.elements[14]] : tubeEnd;
  const sp = (n) => f.surfacePos(n).toArray();
  const pe = f.nodes.pelvis.matrixWorld.elements;
  const ce = f.nodes.chest.matrixWorld.elements;
  return {
    start, tip, visible: o.visible && tube.visible,
    ann: JSON.parse(JSON.stringify(o.userData.annotation)),
    hipL: sp('hip_L'), hipR: sp('hip_R'),
    pelvisFwd: [pe[8], 0, pe[10]], chestFwd: [ce[8], 0, ce[10]],
    handles: app.draw.handlePoints(o.userData.annotation).map((p) => p.toArray()),
  };
}, i);

const closeEmbrace = () => page.evaluate(() => {
  const i = [...document.querySelectorAll('#preset-select option')].find((o) => o.textContent.trim().toLowerCase().startsWith('close embrace')).value;
  window.__app.applyPreset(Number(i));
});

// ================================================================ 1. extend
console.log('\n— extend —');
await closeEmbrace();
await page.evaluate(() => {
  const app = window.__app;
  app.clearDrawings();
  app.setDrawStyle({ extend: 0 });
  app.addDrawLine({ fig: 'follower', joint: 'hip_L' }, { fig: 'follower', joint: 'hip_R' });
});
await settle();
{
  const m0 = await measure(0);
  check(!('extend' in m0.ann), 'a line drawn with Extend at 0 stores no `extend` key (old records stay byte-identical)');
  check(len(sub(m0.start, m0.hipL)) < 1e-3 && len(sub(m0.tip, m0.hipR)) < 1e-3, 'unextended, the stroke ends on the two hips');

  await page.evaluate(() => { const app = window.__app; app.selectDrawing(app.draw.group.children[0]); app.setDrawStyle({ extend: 0.3 }); });
  await settle();
  const m1 = await measure(0);
  const hipDir = unit(sub(m1.hipR, m1.hipL));
  const overA = dot(sub(m1.hipL, m1.start), hipDir);
  const overB = dot(sub(m1.tip, m1.hipR), hipDir);
  check(m1.ann.extend === 0.3 && m1.ann.id === m0.ann.id, 'Extend on a SELECTED line restyles that line and keeps its id');
  check(Math.abs(overA - 0.3) < 1e-3 && Math.abs(overB - 0.3) < 1e-3, `the stroke runs 0.300 m past each hip (${overA.toFixed(3)} / ${overB.toFixed(3)} m)`);
  check(angle(sub(m1.tip, m1.start), hipDir) < 0.05, `…in the same direction (${deg(angle(sub(m1.tip, m1.start), hipDir))} off the hip line)`);
  check(len(sub(m1.handles[0], m1.hipL)) < 1e-3 && len(sub(m1.handles[1], m1.hipR)) < 1e-3, 'the handles stay ON the hips — the ends are where you put them');

  // Posed: twist the hips, drop one hip. The extended stroke must go on being
  // the hip axis, not a stale segment.
  await page.evaluate(() => { const a = window.__app; a.pivotHips(a.follower, 18 * Math.PI / 180); a.editJoint(a.follower, 'pelvis', () => { a.follower.nodes.pelvis.rotation.z += 8 * Math.PI / 180; }); });
  await settle(350);
  const m2 = await measure(0);
  const d2 = unit(sub(m2.hipR, m2.hipL));
  const moved = len(sub(m2.hipL, m1.hipL));
  check(moved > 0.01, `(the pose change really moved the hip: ${mm(moved)})`);
  check(angle(sub(m2.tip, m2.start), d2) < 0.05
    && Math.abs(dot(sub(m2.hipL, m2.start), d2) - 0.3) < 1e-3 && Math.abs(dot(sub(m2.tip, m2.hipR), d2) - 0.3) < 1e-3,
  'posed, the extended stroke is still the hip axis, 0.300 m past each hip');
  await page.screenshot({ path: `${outDir}/draw-extend.png` });
}

// A floor arrow extends too, head and all; and a restored legacy record does
// NOT pick up the toolbar's running value.
{
  const r = await page.evaluate(() => {
    const app = window.__app;
    app.clearDrawings();
    app.selectDrawing(null);
    app.setDrawStyle({ extend: 0.25 });
    const o = app.addDrawArrow({ x: 0, z: 1 }, { x: 1, z: 1 });
    o.updateMatrixWorld(true);
    // World-space extent of the whole arrow along x.
    let lo = Infinity; let hi = -Infinity;
    o.traverse((m) => {
      if (!m.isMesh) return;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const v = m.localToWorld(m.position.clone().set(pos.getX(i), pos.getY(i), pos.getZ(i)));
        lo = Math.min(lo, v.x); hi = Math.max(hi, v.x);
      }
    });
    const running = app.drawStyle.extend;
    app.setDrawings([{ type: 'line', a: [0, 0], b: [1, 0], color: '#ffffff', width: 0.02 }]);
    const legacy = app.drawings[0];
    app.setDrawStyle({ extend: 0 });
    return { lo, hi, running, legacyHas: 'extend' in legacy };
  });
  check(Math.abs(r.lo + 0.25) < 1e-3 && Math.abs(r.hi - 1.25) < 1e-3, `a floor arrow 0→1 m with Extend 0.25 renders −0.25→1.25 m (${r.lo.toFixed(3)}→${r.hi.toFixed(3)})`);
  check(r.running === 0.25 && !r.legacyHas, 'a restored legacy line does NOT inherit the running Extend value');
}

// ================================================================ 2. facing
console.log('\n— facing arrow —');
await closeEmbrace();
await page.evaluate(() => {
  const app = window.__app;
  app.clearDrawings();
  app.setDrawStyle({ extend: 0 });
  const line = app.addDrawLine({ fig: 'follower', joint: 'hip_L' }, { fig: 'follower', joint: 'hip_R' });
  app.addDrawFacing(line);
});
await settle();
const level = (m) => Math.abs(unit(sub(m.tip, m.start))[1]);
{
  const m = await measure(1);
  const mid = m.hipL.map((v, k) => (v + m.hipR[k]) / 2);
  const dir = sub(m.tip, m.start);
  check(m.ann.type === 'facing' && m.visible, 'addDrawFacing adds a facing arrow standing on the line');
  check(len(sub(m.start, mid)) < 1e-3, `it springs from the MIDPOINT of the hip line (${mm(len(sub(m.start, mid)))})`);
  check(level(m) < 1e-4, `it is parallel to the floor (vertical component ${level(m).toExponential(1)})`);
  check(Math.abs(angle(dir, sub(m.hipR, m.hipL)) - 90) < 0.05, `it is perpendicular to the line (${deg(angle(dir, sub(m.hipR, m.hipL)))})`);
  check(angle(dir, m.pelvisFwd) < 12, `it points where the PELVIS faces, not behind her (${deg(angle(dir, m.pelvisFwd))} from pelvis-forward)`);
  check(Math.abs(len(dir) - Math.abs(m.ann.len)) < 1e-3, `its rendered length is the record's (${len(dir).toFixed(3)} m)`);

  // Dissociation: hips twist under a still chest. The arrow must go with the
  // HIPS — this is the picture the feature exists to draw.
  const chest0 = m.chestFwd;
  await page.evaluate(() => { const a = window.__app; a.pivotHips(a.follower, 20 * Math.PI / 180); });
  await settle(350);
  const t = await measure(1);
  const turned = angle(sub(t.tip, t.start), dir);
  check(Math.abs(turned - 20) < 1.5, `a 20° hips twist turns the arrow ${deg(turned)}`);
  check(angle(t.chestFwd, chest0) < 1 && angle(sub(t.tip, t.start), t.pelvisFwd) < 12,
    `…with the hips, while the chest holds (chest moved ${deg(angle(t.chestFwd, chest0))})`);

  // A dropped hip tilts the LINE; the arrow stays level and square.
  await page.evaluate(() => { const a = window.__app; a.editJoint(a.follower, 'pelvis', () => { a.follower.nodes.pelvis.rotation.z += 10 * Math.PI / 180; }); });
  await settle(350);
  const d = await measure(1);
  const lineTilt = Math.abs(unit(sub(d.hipR, d.hipL))[1]);
  check(lineTilt > 0.05, `(the hip line really is tilted now: ${lineTilt.toFixed(3)})`);
  check(level(d) < 1e-4 && Math.abs(angle(sub(d.tip, d.start), sub(d.hipR, d.hipL)) - 90) < 0.05,
    'on a TILTED hip line the arrow is still level with the floor and square to the line');
  await page.screenshot({ path: `${outDir}/draw-facing-hips.png` });

  // Flip, and the tip handle.
  const before = unit(sub(d.tip, d.start));
  await page.evaluate(() => { const app = window.__app; app.selectDrawing(app.draw.group.children[1]); app.flipDrawFacing(); });
  await settle(100);
  const fl = await measure(1);
  check(angle(sub(fl.tip, fl.start), before) > 179.9 && fl.ann.id === d.ann.id, 'Flip points it out of the other side of the line, keeping its id');
  check(await page.evaluate(() => !document.getElementById('draw-flip').hidden), '⇄ Flip is on the toolbar while a facing arrow is selected');
  await page.evaluate((mid, dirU) => {
    const app = window.__app;
    app.moveDrawHandle(app.draw.group.children[1], 0, { x: mid[0] + dirU[0] * 0.7, z: mid[2] + dirU[2] * 0.7 });
  }, fl.start, before);
  await settle(100);
  const h = await measure(1);
  check(Math.abs(len(sub(h.tip, h.start)) - 0.7) < 2e-3 && angle(sub(h.tip, h.start), before) < 0.1,
    `dragging the tip handle sets length AND side (${len(sub(h.tip, h.start)).toFixed(3)} m, back on the first side)`);
  check(len(sub(h.handles[0], h.tip)) < 1e-3 && h.handles.length === 1, 'its one handle sits on the tip');
}

// Reload: records identical, and the arrow still stands on its line.
{
  const before = await page.evaluate(() => JSON.stringify(window.__app.drawingsJSON()));
  await load();
  await settle(400);
  const after = await page.evaluate(() => JSON.stringify(window.__app.drawingsJSON()));
  check(before === after && JSON.parse(after).length === 2, 'line + facing arrow round-trip a reload record-for-record');
  const m = await measure(1);
  const mid = m.hipL.map((v, k) => (v + m.hipR[k]) / 2);
  check(m.visible && len(sub(m.start, mid)) < 1e-3 && level(m) < 1e-4, 'restored, it is placed on its line again (midpoint, level)');

  // A file that lists the arrow BEFORE its line, and one whose line is missing.
  const r = await page.evaluate((json) => {
    const app = window.__app;
    const [line, facing] = JSON.parse(json);
    app.setDrawings([facing, line]);
    const reordered = app.drawings.map((a) => a.type);
    const o = app.draw.group.children[0];
    const placed = o.children[0].visible;
    app.setDrawings([facing]);
    return { reordered, placed, orphan: app.drawings.length };
  }, after);
  check(r.reordered.join() === 'facing,line' && r.placed, 'a file listing the arrow before its line still places it');
  check(r.orphan === 0, 'a facing arrow whose line is missing from the file is dropped, not drawn pointing nowhere');
}

// Deleting the line takes its arrow; the arrow alone can be deleted.
{
  const r = await page.evaluate(() => {
    const app = window.__app;
    app.clearDrawings();
    const line = app.addDrawLine({ x: -0.5, z: 1.2 }, { x: 0.5, z: 1.2 });
    const f1 = app.addDrawFacing(line);
    app.addDrawFacing(line.userData.annotation.id, { len: -0.3 });
    app.selectDrawing(f1);
    app.removeSelectedDrawing();
    const afterArrow = app.drawings.map((a) => a.type).join();
    app.selectDrawing(app.draw.group.children[0]);
    app.removeSelectedDrawing();
    return { afterArrow, afterLine: app.drawings.length, refused: app.addDrawFacing(app.addDrawCircle({ x: 0, z: 0 }, 0.3)) === null };
  });
  check(r.afterArrow === 'line,facing', 'deleting one facing arrow leaves the line and its other arrow');
  check(r.afterLine === 0, 'deleting the LINE takes its facing arrows with it');
  check(r.refused, 'a circle has no facing — addDrawFacing refuses anything but a line/arrow');
  await page.evaluate(() => window.__app.clearDrawings());
}

// ============================================================ 3. real pointer
console.log('\n— real pointer —');
{
  await page.evaluate(() => { const a = window.__app; a.setView?.('top'); });
  await page.click('#mode-buttons button[data-mode="draw"]');
  await page.evaluate(() => {
    const app = window.__app;
    app.clearDrawings();
    app.addDrawLine({ x: -0.6, z: 1.4 }, { x: 0.6, z: 1.4 });
  });
  await settle(400);
  const toScreen = (p) => page.evaluate((p) => {
    const app = window.__app;
    const r = app.renderer?.domElement?.getBoundingClientRect?.() ?? document.querySelector('canvas').getBoundingClientRect();
    const v = app.leader.group.position.clone().set(p[0], p[1], p[2]).project(app.camera);
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }, p);
  await page.click('#draw-tools button[data-tool="facing"]');
  const [mx, my] = await toScreen([0, 0.008, 1.4]);
  await page.mouse.move(mx, my);
  await sleep(60);
  await page.mouse.click(mx, my);
  await settle(200);
  const made = await page.evaluate(() => {
    const app = window.__app;
    return { types: app.drawings.map((a) => a.type).join(), selected: app.drawSelected?.userData.annotation.type ?? null, len: app.drawings[1]?.len };
  });
  check(made.types === 'line,facing', `a REAL click on a line with the Facing tool adds its arrow (${made.types})`);
  check(made.selected === 'facing', '…and selects it, so its tip handle is up');

  // A click on empty floor with the Facing tool authors nothing.
  const [ex, ey] = await toScreen([1.6, 0, -1.2]);
  await page.mouse.click(ex, ey);
  await settle(100);
  check((await page.evaluate(() => window.__app.drawings.length)) === 2, 'the Facing tool on empty floor draws nothing (it says what it wants instead)');

  // REAL drag of the tip across the line: the arrow flips, the camera holds.
  await page.evaluate(() => { const app = window.__app; app.selectDrawing(app.draw.group.children[1]); });
  await settle(150);
  const m0 = await page.evaluate(() => {
    const app = window.__app;
    const a = app.drawings[1];
    return { tip: app.draw.handlePoints(a)[0].toArray(), len: a.len, cam: app.camera.position.toArray().join() };
  });
  const [hx, hy] = await toScreen(m0.tip);
  const [tx, ty] = await toScreen([m0.tip[0], m0.tip[1], 1.4 - (m0.tip[2] - 1.4) * 1.5]);
  await page.mouse.move(hx, hy);
  await sleep(80);
  await page.mouse.move(hx + 1, hy + 1);
  await sleep(60);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(hx + (tx - hx) * i / 10, hy + (ty - hy) * i / 10); await sleep(16); }
  await page.mouse.up();
  await settle(200);
  const m1 = await page.evaluate(() => {
    const app = window.__app;
    return { n: app.drawings.length, len: app.drawings[1].len, cam: app.camera.position.toArray().join() };
  });
  check(Math.sign(m1.len) === -Math.sign(m0.len) && Math.abs(Math.abs(m1.len) - Math.abs(m0.len) * 1.5) < 0.06,
    `a REAL drag of the tip across the line flips and lengthens it (${m0.len.toFixed(2)} → ${m1.len.toFixed(2)} m)`);
  check(m1.cam === m0.cam && m1.n === 2, '…without orbiting the camera or authoring a shape');

  // The Extend slider, by real input.
  await page.evaluate(() => { const app = window.__app; app.selectDrawing(app.draw.group.children[0]); });
  await page.evaluate(() => {
    const s = document.getElementById('draw-extend');
    s.value = '0.4';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(100);
  const ext = await page.evaluate(() => ({ e: window.__app.drawings[0].extend, slider: document.getElementById('draw-extend').value }));
  check(ext.e === 0.4, `the toolbar's Extend slider extends the selected line (${ext.e})`);
  await page.evaluate(() => window.__app.selectDrawing(null));
  await page.evaluate(() => window.__app.selectDrawing(window.__app.draw.group.children[0]));
  check((await page.evaluate(() => document.getElementById('draw-extend').value)) === '0.4', '…and re-selecting the line hands its extension back to the slider');
  await page.screenshot({ path: `${outDir}/draw-facing-floor.png` });
  await page.evaluate(() => { window.__app.clearDrawings(); });
  await page.click('#draw-tools button[data-tool="line"]');
  await page.click('#mode-buttons button[data-mode="rotate"]');
}

await browser.close();
if (logs.length) { console.log('\nConsole errors:'); for (const l of logs) console.log('  ', l); } else console.log('\nNo console errors.');
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('All extend / facing checks passed.');
