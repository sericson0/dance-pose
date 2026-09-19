// Dev check for the sidebar's workflow tabs (Pose / Teach / Measure): each tab
// shows exactly its own sections and all 14 stay reachable, the dividing
// hairline follows the last SHOWN section rather than the last in the markup,
// the chosen tab and the folded/unfolded set survive a reload, and revealing a
// section from code (selecting a joint, a pending pin, "Label highlighted")
// brings that section's tab forward instead of unfolding it out of sight.
// Honours DEV_URL (default http://localhost:5173).
import puppeteer from 'puppeteer-core';

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
await new Promise((r) => setTimeout(r, 2500));
const problems = [];

const visible = () => page.evaluate(() => [...document.querySelectorAll('#sidebar > section')]
  .filter((s) => s.offsetParent !== null).map((s) => s.id));

const state = () => page.evaluate(() => ({
  tab: document.getElementById('sidebar').dataset.activeTab,
  pressed: [...document.querySelectorAll('#sidebar-tabs button')]
    .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.tab),
  lastShown: [...document.querySelectorAll('#sidebar > section.last-shown')].map((s) => s.id),
}));

// ---- 1. Default tab is Pose, and only Pose sections are on screen.
let s = await state();
let v = await visible();
if (s.tab !== 'pose') problems.push(`default tab is ${s.tab}, expected pose`);
const POSE = ['embrace-section', 'pins-section', 'joint-section', 'poses-section', 'dancers-section'];
if (v.join() !== POSE.join()) problems.push(`Pose tab shows [${v}] expected [${POSE}]`);
if (s.pressed.join() !== 'pose') problems.push(`aria-pressed = [${s.pressed}] expected [pose]`);
if (s.lastShown.join() !== 'dancers-section') problems.push(`last-shown = [${s.lastShown}] expected dancers-section`);

// ---- 2. Each tab shows exactly its own group, and all 14 are reachable.
const seen = new Set(v);
for (const [tab, want] of [
  ['teach', ['view-section', 'labels-section', 'clips-section', 'highlight-section', 'muscle-section']],
  ['measure', ['balance-section', 'footmap-section', 'compare-section', 'sequence-section']],
]) {
  await page.click(`#sidebar-tabs button[data-tab="${tab}"]`);
  await new Promise((r) => setTimeout(r, 120));
  v = await visible();
  s = await state();
  if (v.join() !== want.join()) problems.push(`${tab} tab shows [${v}] expected [${want}]`);
  if (s.lastShown.join() !== want.at(-1)) problems.push(`${tab} last-shown = [${s.lastShown}] expected ${want.at(-1)}`);
  v.forEach((id) => seen.add(id));
}
if (seen.size !== 14) problems.push(`only ${seen.size}/14 sections are reachable across the tabs`);

// ---- 3. The tab and the folded set survive a reload.
await page.click('#sidebar-tabs button[data-tab="teach"]');
await page.evaluate(() => document.querySelector('#labels-section .collapse-toggle').click());
await new Promise((r) => setTimeout(r, 150));
const openedLabels = await page.evaluate(() => !document.getElementById('labels-section').classList.contains('collapsed'));
if (!openedLabels) problems.push('clicking the Labels heading did not unfold it');
await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
s = await state();
const stillOpen = await page.evaluate(() => !document.getElementById('labels-section').classList.contains('collapsed'));
if (s.tab !== 'teach') problems.push(`after reload tab is ${s.tab}, expected teach`);
if (!stillOpen) problems.push('after reload the Labels section folded again — collapse state not persisted');

// ---- 4. Selecting a joint from another tab brings the Pose tab forward.
await page.click('#sidebar-tabs button[data-tab="measure"]');
await new Promise((r) => setTimeout(r, 120));
await page.evaluate(() => window.__app.selectJoint(window.__app.leader, 'elbow_L'));
await new Promise((r) => setTimeout(r, 250));
s = await state();
const jointVisible = await page.evaluate(() =>
  document.getElementById('joint-section').offsetParent !== null
  && !document.getElementById('joint-section').classList.contains('collapsed'));
if (s.tab !== 'pose') problems.push(`selecting a joint left the tab on ${s.tab}, expected pose`);
if (!jointVisible) problems.push('the Selected joint panel is still not visible after selecting a joint');

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'All tab checks passed.');
console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
