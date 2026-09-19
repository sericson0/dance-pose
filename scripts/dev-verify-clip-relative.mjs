// Dev check: a movement clip's angle is RELATIVE to the pose the dancer is in,
// and the Muscles panel's look survives a reload.
//
// 1. THE MOTION FRAME. A clip keeps the pose it was opened in (see
//    dev-verify-clip-pose.mjs), so the user goes on posing the dancer while the
//    clip is up — carrying the hip back to show knee extension out of a real
//    tango position. The axis and the zero direction used to be WORLD vectors
//    frozen when the clip was prepared, so every degree of that hip swing was
//    booked as knee movement and then subtracted from the range: a 75° hip
//    change read 70° before the knee had moved at all, and the knee's full 100°
//    extension then quoted 30°. They are now held in the frame of the nearest
//    ancestor the clip does NOT drive — the thigh here — so the whole frame
//    turns with the limb. The exclusion matters: for shoulder abduction the
//    scapula IS driven (the scapulohumeral rhythm splits one 170° swing between
//    the two joints), so the frame has to climb past it to the chest or the
//    girdle's share would be cancelled out of the movement it belongs to.
//
//    This is invisible to dev-verify-studio.mjs by construction: it measures
//    every row from the anatomical position and never touches a joint upstream
//    mid-clip, which is exactly the case where the frozen frame was correct.
//
// 2. THE MUSCLES PANEL. A colour picked for a belly is authored work — it is
//    what ties a lit muscle to the callout naming it on a slide — and a refresh
//    mid-lesson used to throw the whole set away. Checked through the panel's
//    own controls and then across a real page reload, reading the colour off
//    the BELLY's material, not just the state that claims it.
//
// Honours DEV_URL (default http://localhost:5173) and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  // An isolated profile, so the run works beside an open browser — and so the
  // localStorage this checks starts empty.
  userDataDir: path.join(os.tmpdir(), `tangle-clip-relative-${Date.now()}`),
  args: ['--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
const problems = [];

// ---- 1. The angle counts from the pose, whatever is posed above the joint.
const angles = await page.evaluate(async () => {
  const app = window.__app;
  const R2D = 180 / Math.PI;
  const f = app.leader;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const read = () => ({
    hip: +(f.nodes.hip_L.rotation.x * R2D).toFixed(1),
    knee: +(f.nodes.knee_L.rotation.x * R2D).toFixed(1),
    pill: document.getElementById('clip-angle-val')?.textContent,
  });
  const rec = {};
  app.applyPreset(0);
  // Knee extension opens in its own test position (hip -60 / knee 100).
  app.enterClip('kn_ext', { figure: f, side: 'L' });
  app.scrubClip(0);
  await frame();
  rec.atEnter = read();
  // Now carry the hip back, as a teacher building a trailing tango leg does.
  app.editJoint(f, 'hip_L', () => { f.nodes.hip_L.rotation.x = 15 / R2D; });
  await frame();
  rec.hipBack = read();
  // The knee still takes its whole range, measured from there.
  app.scrubClip((app.studio.clip.segs[0].t1 + 0.05) / app.studio.clip.duration);
  await frame();
  rec.atHold = read();
  app.exitClip();
  await frame();
  // A joint the clip DOES drive still counts toward the swing.
  app.enterClip('sh_abd', { figure: f, side: 'R', anatomical: true });
  app.scrubClip((app.studio.clip.segs[0].t1 + 0.05) / app.studio.clip.duration);
  await frame();
  rec.shAbd = { raw: +(app.studio.clip.motion.end * R2D).toFixed(1) };
  app.exitClip();
  return rec;
});
if (angles.atEnter.pill !== '0°') problems.push(`the clip opens reading ${angles.atEnter.pill}, expected 0°`);
if (angles.hipBack.pill !== '0°') {
  problems.push(`posing the hip read as ${angles.hipBack.pill} of knee movement (the knee never moved)`);
}
if (angles.atHold.pill !== '100°') {
  problems.push(`knee extension from the new hip quoted ${angles.atHold.pill}, expected its full 100°`);
}
if (Math.abs(angles.shAbd.raw - 179) > 2) {
  problems.push(`shoulder abduction swings ${angles.shAbd.raw}°, expected ~179° — the driven scapula's share was dropped`);
}
console.log(`--- knee extension: opens ${angles.atEnter.pill} · hip to ${angles.hipBack.hip}° reads ${angles.hipBack.pill} · full range ${angles.atHold.pill}`);
console.log(`--- shoulder abduction (scapula driven): ${angles.shAbd.raw}°`);

// ---- 2. The Muscles panel's look, set through its own controls.
const saved = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#muscle-list .muscle-row')];
  const pick = (name) => rows.find((r) => r.textContent.trim().startsWith(name));
  const light = (name, hex) => {
    const row = pick(name);
    row.querySelector('.muscle-hl').click();
    const sw = row.querySelector('.chip-color');
    sw.value = hex;
    sw.dispatchEvent(new Event('input'));
  };
  light('Sartorius', '#2ecc71');
  light('Deltoid', '#ff00ff');
  pick('Soleus').querySelector('input[type=checkbox]').click(); // uncheck = hide
  const tint = document.getElementById('muscle-tint');
  tint.value = 60;
  tint.dispatchEvent(new Event('input'));
  return JSON.parse(localStorage.getItem('tangoPoseStudio.muscleLook.v1'));
});
if (!saved) problems.push('the Muscles panel wrote nothing to localStorage');

await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
const after = await page.evaluate(() => {
  const f = window.__app.figures[0];
  const rows = [...document.querySelectorAll('#muscle-list .muscle-row')];
  const swatch = (n) => rows.find((r) => r.textContent.trim().startsWith(n))?.querySelector('.chip-color');
  const belly = f.layerMeshes.muscle.find((m) => m.userData.muscleName === 'Sartorius');
  return {
    lit: [...(f.litMuscles ?? [])],
    hidden: [...(f.hiddenMuscles ?? [])],
    tint: document.getElementById('muscle-tint').value,
    swatch: swatch('Sartorius')?.value,
    swatchShown: swatch('Sartorius') ? !swatch('Sartorius').hidden : null,
    // The colour really ON the belly, not merely in the state that claims it.
    emissive: belly ? `#${belly.material.emissive.getHexString()}` : null,
  };
});
if (after.swatch !== '#2ecc71') problems.push(`the restored swatch reads ${after.swatch}, expected #2ecc71`);
if (after.emissive !== '#2ecc71') problems.push(`the belly renders ${after.emissive}, expected the picked #2ecc71`);
if (!after.lit.includes('Sartorius') || !after.lit.includes('Deltoid')) problems.push(`the lit set did not survive: ${after.lit}`);
if (!after.hidden.includes('Soleus')) problems.push(`the hidden set did not survive: ${after.hidden}`);
if (after.tint !== '60') problems.push(`the colour strength came back as ${after.tint}%, expected 60%`);
if (after.swatchShown !== true) problems.push('the restored swatch is hidden although its belly is lit');
console.log(`--- after reload: swatch ${after.swatch} · belly ${after.emissive} · lit ${after.lit.length} · hidden ${after.hidden.length} · tint ${after.tint}%`);

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'All clip-relative checks passed.');
console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
