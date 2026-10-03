// Render the procedural radio stations offline (faster than real time) to WAV files for listening.
// Usage: node scripts/render-radio.mjs <outDir>   (needs a build in dist/)
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root = new URL('../dist/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  try { const d = await readFile(normalize(join(root, p))); res.writeHead(200, { 'Content-Type': types[extname(p)] ?? 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4181, r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:4181/index.html?play=1&quality=low');
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 90000 });
const out = process.argv[2];
for (const [station, secs, name] of [[0, 48, 'neon_fm'], [1, 40, 'dust_radio'], [2, 40, 'low_tide']]) {
  const b64 = await page.evaluate(async ([station, secs]) => {
    const g = window.__game;
    g.audio.init();
    const Radio = g.audio.radio.constructor;
    const SR = 32000;
    const octx = new OfflineAudioContext(2, SR * secs, SR);
    let fake = 0;
    const proxy = new Proxy(octx, { get: (t, k) => (k === 'currentTime' ? fake : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    const r = new Radio(proxy, octx.destination);
    r.tune(station);
    r.setLevel(0.9, 0);
    for (fake = 0; fake < secs; fake += 0.05) r.update();
    const buf = await octx.startRendering();
    // stereo 16-bit WAV
    const L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length;
    let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const gain = peak > 0 ? 0.9 / peak : 1;
    const ab = new ArrayBuffer(44 + n * 4), v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) { v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i] * gain)) * 32767, true); v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i] * gain)) * 32767, true); }
    const bytes = new Uint8Array(ab); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return JSON.stringify({ b64: btoa(bin), title: r.songTitle, artist: r.songArtist, peak });
  }, [station, secs]);
  const j = JSON.parse(b64);
  await writeFile(`${out}/${name}.wav`, Buffer.from(j.b64, 'base64'));
  console.log(name, j.artist, '—', j.title, 'raw peak', j.peak.toFixed(3));
}
await browser.close(); server.close();
