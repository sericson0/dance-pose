// Bake the skeleton<->mannequin calibration to src/rigCalibration.js.
//
// The clothed body avatar is retargeted onto a "single neutral rest" estimated
// from the skeleton atlas every load (Figure.#atlasLimbRest + #endpointAlignR).
// That estimate is the source of truth, but it is fragile: a changed GLB or
// tuning constant silently moves the layers apart. This script freezes the
// current estimate so the app (and dev-verify-calibration.mjs) can assert it
// hasn't drifted. Re-run whenever a model or a retarget constant changes.
//
// Usage: node scripts/build-calibration.mjs   (dev server running)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, '..', 'src', 'rigCalibration.js');

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

// Read each keyed figure's scale-free calibration.
const table = await page.evaluate(() => {
  const out = {};
  for (const fig of window.__app.figures) {
    if (!fig.bodyKey || !fig.calibrationJSON) continue;
    out[fig.bodyKey] = fig.calibrationJSON();
  }
  return out;
});

if (!Object.keys(table).length) {
  console.error('No keyed figures found — nothing to bake.');
  await browser.close();
  process.exit(1);
}

// Emit stable, rounded numbers so the file diffs cleanly between bakes.
const r = (x) => Number(x.toFixed(6));
const fmtVec = (a) => `[${a.map(r).join(', ')}]`;
const lines = [];
lines.push('// GENERATED — do not edit by hand. Re-generate with `npm run bake:rig`.');
lines.push('//');
lines.push('// Frozen snapshot of the skeleton<->mannequin calibration: the single neutral');
lines.push('// rest each figure resolves at load, used as a *tripwire*. Figure.#build');
lines.push('// recomputes the live calibration from the GLBs every load (that estimate is');
lines.push('// still the source of truth); #assertCalibration compares it to the numbers');
lines.push('// here and console.errors if they have drifted past tolerance — a signal that a');
lines.push('// model or a tuning constant changed and this file must be re-baked. The hard');
lines.push('// pass/fail gate lives in scripts/dev-verify-calibration.mjs.');
lines.push('//');
lines.push('// Keyed by avatar (man/woman have different Biped bind poses). `rest` holds');
lines.push('// canonical joint centers as fractions of stature (scale-free); `endpointR`');
lines.push('// holds the skeletal-hand roll quaternions [x, y, z, w]; `endpointS` holds the');
lines.push('// uniform hand scale; `endpointT` holds the seat translation [x, y, z] as');
lines.push('// fractions of stature (all scale-free).');
lines.push('export const RIG_CALIBRATION = {');
for (const key of Object.keys(table).sort()) {
  const { rest, endpointR, endpointS, endpointT } = table[key];
  lines.push(`  ${key}: {`);
  lines.push('    rest: {');
  for (const j of Object.keys(rest).sort()) lines.push(`      ${j}: ${fmtVec(rest[j])},`);
  lines.push('    },');
  lines.push('    endpointR: {');
  for (const j of Object.keys(endpointR).sort()) lines.push(`      ${j}: ${fmtVec(endpointR[j])},`);
  lines.push('    },');
  lines.push('    endpointS: {');
  for (const j of Object.keys(endpointS || {}).sort()) lines.push(`      ${j}: ${r(endpointS[j])},`);
  lines.push('    },');
  lines.push('    endpointT: {');
  for (const j of Object.keys(endpointT || {}).sort()) lines.push(`      ${j}: ${fmtVec(endpointT[j])},`);
  lines.push('    },');
  lines.push('  },');
}
lines.push('};');
lines.push('');

fs.writeFileSync(outFile, lines.join('\n'));
console.log(`Wrote ${outFile}`);
for (const key of Object.keys(table).sort()) {
  console.log(`  ${key}: ${Object.keys(table[key].rest).length} rest joints, ${Object.keys(table[key].endpointR).length} endpoint rotations`);
}
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length ? 1 : 0);
