// Visual QA: capture multiple scripted screenshots in one browser session.
// Usage: node scripts/shots.mjs "<query>" shots.json   (json: [{name, js, wait}])
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('../dist/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  try { const data = await readFile(normalize(join(root, p))); res.writeHead(200, { 'Content-Type': types[extname(p)] ?? 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4180, r));
const query = process.argv[2] ?? '';
const shots = JSON.parse(await readFile(process.argv[3], 'utf8'));
const outDir = new URL('./out/', import.meta.url).pathname;
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const mobile = !!process.env.SMOKE_MOBILE;
const page = await browser.newPage(mobile ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (process.env.VERBOSE) console.log('[page]', m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + e.stack));
await page.goto(`http://localhost:4180/index.html${query}`);
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 90000 }).catch(() => errors.push('not ready'));
await page.waitForTimeout(1500);
for (const s of shots) {
  const r = await page.evaluate(s.js).catch((e) => 'ERR ' + e.message);
  await page.waitForTimeout(s.wait ?? 2500);
  await page.screenshot({ path: `${outDir}shot_${s.name}.png` });
  const st = await page.evaluate(() => window.__game.stats());
  console.log(s.name, JSON.stringify(r), JSON.stringify(st));
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
server.close();
