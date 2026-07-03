import puppeteer from 'puppeteer-core';

const outDir = process.argv[2];
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950', '--use-angle=default'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 20000 });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${outDir}/1-embrace-body.png` });

// Skeleton + muscle view
await page.evaluate(() => {
  document.getElementById('layer-body').click();
  document.getElementById('layer-skeleton').click();
  document.getElementById('layer-muscle').click();
});
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${outDir}/2-skeleton-muscle.png` });

// Walk preset, body view again
await page.evaluate(() => {
  document.getElementById('layer-muscle').click();
  document.getElementById('layer-skeleton').click();
  document.getElementById('layer-body').click();
  document.getElementById('preset-select').value = '2';
  document.getElementById('preset-apply').click();
});
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${outDir}/3-walk.png` });

// Apilado preset
await page.evaluate(() => {
  document.getElementById('preset-select').value = '3';
  document.getElementById('preset-apply').click();
});
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${outDir}/4-apilado.png` });

console.log('CONSOLE LOG DUMP:');
console.log(logs.join('\n') || '(no console messages)');
await browser.close();
