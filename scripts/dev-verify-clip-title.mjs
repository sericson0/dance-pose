// Dev check: the clip's title block, the degrees it quotes, and the colour of a
// highlighted muscle.
//
//  1. The title HANGS OFF THE DANCER, not the frame: it is placed just above the
//     top of the shot's own projected points (pinned in a corner it ends up
//     stranded across a wide slide from the anatomy it names).
//  2. The readout quotes the textbook granularity — 10° steps for a large arc,
//     5° for a small one, rounded UP at the end range — so hip flexion out of a
//     real tango pose reads the 120° the MOVEMENTS table advertises rather than
//     the 117° this rig measures. Only the DISPLAY rounds; clip.motion stays raw.
//  3. A REAL pointer drag moves the title and does NOT orbit the camera (the
//     grab is armed by hover, since OrbitControls listens on the same canvas).
//  4. The title carries the movement's NAME alone — no plane, axis or degrees.
//  5. A REAL click on a lit belly asks for that CALLOUT's colour (the whole
//     group of bellies it names, since the colour belongs to the callout).
//  6. That colour reaches the muscle AS PICKED (a lit belly used to be mixed
//     halfway to white, which rendered it visibly paler than the swatch), its
//     pill accent and the sidebar tag — and the "Colour strength" slider mixes
//     it back toward the belly's own flesh tone, never toward white.
//  7. "Fade others" fades ON SCREEN, counted in pixels. three bakes
//     `material.transparent` into the shader program, so a belly restyled in
//     place kept rendering solid while its material read opacity 0.06 — a check
//     of the state passes straight through that bug, a check of the picture
//     does not (verified to fail with the fix reverted).
//
// Honours DEV_URL (default http://localhost:5173).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const outDir = process.argv[2] || '.';
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--window-size=1400,900'],
  userDataDir: `${process.env.TEMP}/edge-verify-title`,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const shot = async (name) => {
  const url = await page.evaluate(() => window.__app.photoDataURL(1));
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
};

// ---- 1. Enter the hip-flexion clip in the muscle layer.
await page.evaluate(() => {
  const app = window.__app;
  app.setBackdrop('dark');
  document.getElementById('layer-mode').value = 'muscle';
  document.getElementById('layer-mode').dispatchEvent(new Event('change'));
  app.enterClip('hp_flex', { figure: app.leader, side: 'R', anatomical: true });
});
await sleep(900);

const t0 = await page.evaluate(() => {
  const s = window.__app.studio;
  const camera = window.__app.camera;
  const box = s.titleBox;
  // The projected top of the subject the clip framed.
  const hud = document.getElementById('hud');
  let top = Infinity;
  for (const p of s.clip.shot) {
    const v = p.clone().project(camera);
    if (v.z > 1) continue;
    top = Math.min(top, (-v.y * 0.5 + 0.5) * hud.height);
  }
  return {
    box, subjectTop: top, h: hud.height, w: hud.width,
    endDeg: Math.abs(s.clip.motion.end) * 180 / Math.PI,
    titlePos: s.titlePos,
  };
});
if (!t0.box) problems.push('no title box was recorded');
else {
  const gapFrac = (t0.subjectTop - (t0.box.top + t0.box.height)) / t0.h;
  console.log(`title box top ${(t0.box.top / t0.h).toFixed(3)}h, bottom ${((t0.box.top + t0.box.height) / t0.h).toFixed(3)}h, subject top ${(t0.subjectTop / t0.h).toFixed(3)}h, gap ${gapFrac.toFixed(3)}h`);
  console.log(`title centre x ${((t0.box.left + t0.box.width / 2) / t0.w).toFixed(3)}w`);
  if (gapFrac < 0 || gapFrac > 0.12) problems.push(`title is not hugging the subject (gap ${gapFrac.toFixed(3)}h)`);
}
console.log(`measured end range ${t0.endDeg.toFixed(1)}°`);
await shot('01-title-default');

// ---- 2. The readout rounds up at the end of the stroke.
const readings = [];
for (const p of [0.0, 0.25, 0.5, 0.62]) {
  await page.evaluate((v) => window.__app.scrubClip(v), p);
  await sleep(250);
  readings.push(await page.evaluate(() => ({
    shown: document.getElementById('clip-angle-val').textContent,
    raw: +(Math.abs(window.__app.studio.clip.motion.angle) * 180 / Math.PI).toFixed(1),
  })));
}
console.log('readout:', JSON.stringify(readings));
const endShown = readings[readings.length - 1].shown;
if (endShown !== '120°') problems.push(`hip flexion should read 120° at the hold, read ${endShown}`);
await shot('02-hold-120');

// ---- 3. Drag the title with a REAL pointer drag.
const before = await page.evaluate(() => {
  const b = window.__app.studio.titleBox;
  const gl = document.querySelector('#viewport canvas:not(#hud)');
  const r = gl.getBoundingClientRect();
  const k = r.width / document.getElementById('hud').width;
  return {
    cx: r.left + (b.left + b.width / 2) * k,
    cy: r.top + (b.top + b.height / 2) * k,
    frac: { x: (b.left + b.width / 2) / document.getElementById('hud').width, y: b.top / document.getElementById('hud').height },
    cam: window.__app.camera.position.toArray(),
  };
});
await page.mouse.move(before.cx, before.cy); // hover arms the grab
await sleep(120);
await page.mouse.down();
await page.mouse.move(before.cx - 220, before.cy + 160, { steps: 12 });
await page.mouse.up();
await sleep(300);
const after = await page.evaluate(() => ({
  titlePos: window.__app.studio.titlePos,
  box: window.__app.studio.titleBox,
  cam: window.__app.camera.position.toArray(),
  hudW: document.getElementById('hud').width,
  hudH: document.getElementById('hud').height,
}));
if (!after.titlePos) problems.push('the title did not move on a pointer drag');
else {
  const dx = (after.titlePos.x - before.frac.x) * after.hudW;
  const dy = (after.titlePos.y - before.frac.y) * after.hudH;
  const k = after.hudW / (await page.evaluate(() => document.querySelector('#viewport canvas:not(#hud)').getBoundingClientRect().width));
  console.log(`title moved ${dx.toFixed(0)}, ${dy.toFixed(0)} canvas px (asked ${(-220 * k).toFixed(0)}, ${(160 * k).toFixed(0)})`);
  if (Math.abs(dx - (-220 * k)) > 12 || Math.abs(dy - 160 * k) > 12) problems.push('the title did not track the cursor');
}
const camMoved = Math.hypot(...after.cam.map((v, i) => v - before.cam[i]));
console.log(`camera moved ${(camMoved * 1000).toFixed(1)} mm during the title drag`);
if (camMoved > 1e-4) problems.push(`dragging the title orbited the camera (${camMoved.toFixed(3)} m)`);
await shot('03-title-dragged');

// ---- 4. The subtitle carries no plane / axis / degrees.
const overlay = await page.evaluate(() => {
  // Re-draw the overlay through a text-capturing 2D context.
  const seen = [];
  const hud = document.getElementById('hud');
  const real = hud.getContext('2d');
  const orig = real.fillText.bind(real);
  real.fillText = (t, x, y) => { seen.push(String(t)); return orig(t, x, y); };
  window.__app.studio.renderFrame();
  real.fillText = orig;
  return seen;
});
console.log('overlay text:', JSON.stringify(overlay));
const titleish = overlay.find((t) => /Hip flexion/i.test(t)) ?? '';
if (/plane|axis|°/i.test(titleish)) problems.push(`the title still carries plane/axis/degrees: ${titleish}`);
if (overlay.some((t) => /Sagittal plane\s+·/.test(t))) problems.push('a plane/axis strap line is still drawn under the title');

// ---- 5. A real click on a lit belly asks for that CALLOUT's colour. The
// picker itself is a native dialog, so the hook is stubbed to record the ask.
// The title is put back over the dancer first: dragged onto the thigh it would
// swallow the very clicks this is testing (and rightly so).
const targets = await page.evaluate(() => {
  const app = window.__app;
  app.studio.resetTitlePos();
  app.__asked = null;
  app.ui.__pick = app.ui.pickMuscleColor;
  app.ui.pickMuscleColor = (names) => { app.__asked = [names].flat(); };
  // A clip callout's anchor is a vertex on the camera-facing side of its belly,
  // so it is a point the muscle really covers on screen — but a deep belly
  // (iliacus sits inside the pelvis) can still have others in front of it, so
  // every mover is a candidate and the first that registers wins.
  const gl = document.querySelector('#viewport canvas:not(#hud)');
  const r = gl.getBoundingClientRect();
  return app.labels.items.filter((l) => l.kind === 'muscle' && l.temp).map((lbl) => {
    const v = app.labels.anchorWorld(lbl).project(app.camera);
    return {
      x: r.left + (v.x * 0.5 + 0.5) * r.width,
      y: r.top + (-v.y * 0.5 + 0.5) * r.height,
      text: lbl.text, name: lbl.name,
    };
  });
});
let asked = null;
let clicked = null;
for (const t of targets) {
  await page.mouse.click(t.x, t.y);
  await sleep(200);
  const got = await page.evaluate(() => window.__app.__asked);
  if (got?.length) { asked = got; clicked = t; break; }
}
const lit = await page.evaluate(() => {
  window.__app.ui.pickMuscleColor = window.__app.ui.__pick;
  return [...window.__app.leader.litMuscles ?? []].map((s) => s.split('|')[0]);
});
console.log(`clicked the ${clicked?.text} callout (${clicked?.name}) → asked for ${JSON.stringify(asked)}`);
if (!asked?.length) problems.push('clicking a lit belly did not open its colour picker');
else if (!asked.every((n) => lit.includes(n))) problems.push(`the picker was asked for bellies that are not lit: ${asked}`);

// ---- 6. Recolour a lit muscle; the callout accent follows.
const colorCheck = await page.evaluate(() => {
  const app = window.__app;
  const lit = [...app.leader.litMuscles ?? []];
  const name = lit[0]?.split('|')[0];
  const mesh = app.leader.layerMeshes.muscle.find((m) => m.userData.muscleName === name);
  const before = mesh.material.color.getHexString();
  app.setMuscleColor(name, '#2ecc71');
  const after = mesh.material.color.getHexString();
  const label = app.labels.items.find((l) => l.kind === 'muscle' && l.name === name);
  return {
    name, before, after,
    emissive: mesh.material.emissive.getHexString(),
    accent: label ? app.labels.accentColor(label) : null,
    otherAccent: (() => {
      const o = app.labels.items.find((l) => l.kind === 'muscle' && l.name !== name);
      return o ? app.labels.accentColor(o) : null;
    })(),
    read: app.muscleColor(name),
  };
});
console.log('muscle colour:', JSON.stringify(colorCheck));
if (colorCheck.before === colorCheck.after) problems.push('the belly did not change colour');
if (colorCheck.emissive !== '2ecc71') problems.push(`the glow is ${colorCheck.emissive}, expected 2ecc71`);
if (colorCheck.accent !== '#2ecc71') problems.push(`the callout accent is ${colorCheck.accent}, expected #2ecc71`);
if (colorCheck.otherAccent && colorCheck.otherAccent !== '#e0645f') problems.push('recolouring one belly moved another callout');
// The belly wears the colour AS PICKED (mixing it halfway to white made it
// visibly paler than the swatch it came from) — and the strength slider mixes
// it back toward the muscle's own flesh tone, never toward white.
if (colorCheck.after !== '2ecc71') problems.push(`the belly renders ${colorCheck.after}, not the picked 2ecc71`);
await sleep(300);
await shot('04-muscle-recoloured');

const tinted = await page.evaluate((name) => {
  const app = window.__app;
  const mesh = app.leader.layerMeshes.muscle.find((m) => m.userData.muscleName === name);
  const slider = document.getElementById('muscle-tint');
  const at = (pct) => {
    slider.value = String(pct);
    slider.dispatchEvent(new Event('input'));
    return {
      color: mesh.material.color.getHexString(),
      glow: mesh.material.emissiveIntensity,
    };
  };
  const out = { full: at(100), half: at(50), none: at(0) };
  out.flesh = mesh.userData.muscleBaseColor.toString(16).padStart(6, '0');
  at(100);
  return out;
}, colorCheck.name);
console.log('colour strength:', JSON.stringify(tinted));
if (tinted.full.color !== '2ecc71') problems.push('100% strength is not the picked colour');
if (tinted.none.color !== tinted.flesh) problems.push('0% strength does not fall back to the belly’s own flesh colour');
if (tinted.half.color === tinted.full.color || tinted.half.color === tinted.flesh) {
  problems.push('50% strength does not sit between the two');
}
if (!(tinted.full.glow > tinted.half.glow && tinted.half.glow > tinted.none.glow)) {
  problems.push('the glow does not follow the colour strength');
}

// ---- 7. "Fade others" fades ON SCREEN. Measured in PIXELS on purpose: the bug
// this guards against left every faded belly reading opacity 0.06 while it went
// on rendering solid (three bakes `transparent` into the shader program, so
// flipping it in place changed nothing until the program was rebuilt) — a check
// of the material's state passes straight through it.
const muscleRed = () => page.evaluate(async () => {
  const url = window.__app.photoDataURL(1);
  const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = url; });
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 70 && d[i] > 1.7 * d[i + 1] && d[i] > 1.7 * d[i + 2]) n++; // flesh red
  }
  return n;
});
const setFade = (on) => page.evaluate((v) => {
  const app = window.__app;
  app.scrubClip(0);
  app.setClipOptions({ fade: v, plane: false, angle: false });
}, on);
await setFade(false);
await sleep(400);
const redSolid = await muscleRed();
await setFade(true);
await sleep(400);
const redFaded = await muscleRed();
await shot('05-fade-others');
console.log(`fade others: ${redSolid} flesh-red px solid → ${redFaded} faded (${(100 * redFaded / redSolid).toFixed(0)}% left)`);
if (!(redFaded < 0.35 * redSolid)) problems.push(`"Fade others" did not fade on screen (${redFaded} of ${redSolid} flesh-red px remain)`);
await setFade(false);

// ---- 8. Exit restores.
await page.evaluate(() => window.__app.exitClip());
await sleep(600);
const outState = await page.evaluate(() => ({
  clip: !!window.__app.studio.clip, titlePos: window.__app.studio.titlePos,
}));
if (outState.clip || outState.titlePos) problems.push('exitClip left clip/title state behind');

console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'All checks passed.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
