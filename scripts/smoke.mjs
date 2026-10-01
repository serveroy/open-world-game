// Headless smoke test: serves dist/, loads the game in Chromium, waits for ready,
// collects console errors + stats, takes screenshots. Usage: npm run build && npm run smoke
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('../dist/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(root, p));
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('nf');
  }
});
await new Promise((r) => server.listen(4179, r));

const params = process.argv[2] ?? '';
const waitMs = Number(process.argv[3] ?? 8000);
const outDir = new URL('./out/', import.meta.url).pathname;
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const mobile = !!process.env.SMOKE_MOBILE;
const page = await browser.newPage(mobile
  ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' }
  : { viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (process.env.VERBOSE) console.log('[page]', m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + e.stack));
await page.goto(`http://localhost:4179/index.html${params}`);
try {
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 60000 });
} catch {
  errors.push('game did not become ready in 60s');
}
await page.waitForTimeout(waitMs);
const stats = await page.evaluate(() => (window.__game?.stats ? window.__game.perf() : null));
const name = (params.replace(/[^a-z0-9]+/gi, '_') || 'default') + (mobile ? '_mobile' : '');
await page.screenshot({ path: `${outDir}${name}.png` });
if (process.env.SMOKE_SCRIPT) {
  const extra = await page.evaluate(process.env.SMOKE_SCRIPT);
  console.log('script result:', JSON.stringify(extra));
  await page.waitForTimeout(Number(process.env.SMOKE_WAIT2 ?? 3000));
  await page.screenshot({ path: `${outDir}${name}_2.png` });
  const after = await page.evaluate(() => (window.__game?.stats ? window.__game.perf() : null));
  console.log('after:', JSON.stringify(after));
}
await writeFile(`${outDir}${name}.json`, JSON.stringify({ stats, errors }, null, 2));
console.log('stats:', JSON.stringify(stats));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
