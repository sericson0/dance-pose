// Hard gate for the skeleton<->mannequin calibration tripwire.
//
// The app (Figure.#assertCalibration) only *warns* when the live calibration
// has drifted from the frozen snapshot in src/rigCalibration.js. This script is
// the pass/fail version: it loads the app, reads each keyed figure's live
// calibration, compares it to the frozen table, prints a per-joint drift table,
// and exits non-zero if anything exceeds tolerance (or there are console
// errors) — so it can gate a commit/build. Re-bake with `npm run bake:rig`.
//
// Usage: node scripts/dev-verify-calibration.mjs   (dev server running)
import puppeteer from 'puppeteer-core';
import { RIG_CALIBRATION } from '../src/rigCalibration.js';

const TOL_MM = 2, TOL_DEG = 0.5;

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const live = await page.evaluate(() => {
  const out = {};
  for (const fig of window.__app.figures) {
    if (!fig.bodyKey || !fig.calibrationJSON) continue;
    out[fig.bodyKey] = { height: fig.height, ...fig.calibrationJSON() };
  }
  return out;
});

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const quatAngleDeg = (a, b) => {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
};

const problems = [];
const keys = Object.keys(RIG_CALIBRATION);
if (!keys.length) problems.push('rigCalibration.js is empty — run `npm run bake:rig` first.');

for (const key of keys) {
  const frozen = RIG_CALIBRATION[key];
  const l = live[key];
  console.log(`\n=== ${key} ===`);
  if (!l) { problems.push(`${key}: no live figure with this bodyKey`); continue; }
  const H = l.height;
  console.log('rest joint drift (frozen vs live), mm:');
  for (const j of Object.keys(frozen.rest || {}).sort()) {
    if (!l.rest[j]) { problems.push(`${key}: ${j} missing live rest`); continue; }
    const mm = dist3(frozen.rest[j], l.rest[j]) * H * 1000;
    console.log(`  ${j.padEnd(12)} ${mm.toFixed(2).padStart(7)} mm`);
    if (mm > TOL_MM) problems.push(`${key}: rest ${j} ${mm.toFixed(2)}mm > ${TOL_MM}mm`);
  }
  console.log('endpoint rotation drift (frozen vs live), deg:');
  for (const j of Object.keys(frozen.endpointR || {}).sort()) {
    if (!l.endpointR[j]) { problems.push(`${key}: ${j} missing live endpointR`); continue; }
    const deg = quatAngleDeg(frozen.endpointR[j], l.endpointR[j]);
    console.log(`  ${j.padEnd(12)} ${deg.toFixed(3).padStart(7)} °`);
    if (deg > TOL_DEG) problems.push(`${key}: endpointR ${j} ${deg.toFixed(2)}° > ${TOL_DEG}°`);
  }
  console.log('endpoint seat-translation drift (frozen vs live), mm:');
  for (const j of Object.keys(frozen.endpointT || {}).sort()) {
    if (!l.endpointT || !l.endpointT[j]) { problems.push(`${key}: ${j} missing live endpointT`); continue; }
    const mm = dist3(frozen.endpointT[j], l.endpointT[j]) * H * 1000;
    console.log(`  ${j.padEnd(12)} ${mm.toFixed(2).padStart(7)} mm`);
    if (mm > TOL_MM) problems.push(`${key}: endpointT ${j} ${mm.toFixed(2)}mm > ${TOL_MM}mm`);
  }
  console.log('endpoint hand-scale drift (frozen vs live):');
  for (const j of Object.keys(frozen.endpointS || {}).sort()) {
    if (!l.endpointS || l.endpointS[j] == null) { problems.push(`${key}: ${j} missing live endpointS`); continue; }
    const d = Math.abs(frozen.endpointS[j] - l.endpointS[j]);
    console.log(`  ${j.padEnd(12)} ${d.toFixed(4).padStart(7)}`);
    if (d > 0.01) problems.push(`${key}: endpointS ${j} ${d.toFixed(3)} > 0.01`);
  }
}

if (problems.length) console.log('\nPROBLEMS (re-bake with `npm run bake:rig`):\n' + problems.join('\n'));
else console.log('\nCalibration matches the frozen snapshot.');
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
