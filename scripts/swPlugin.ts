import type { Plugin } from 'vite';

/**
 * Emits `sw.js` after the bundle is written, precaching every emitted file so the game
 * runs fully offline once loaded. Cache name is derived from the file list so new
 * deploys invalidate old caches.
 */
export function swPlugin(): Plugin {
  return {
    name: 'crimson-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const extra = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon.svg'];
      const list = Array.from(new Set([...extra, ...files]));
      let hash = 0;
      for (const f of list) for (let i = 0; i < f.length; i++) hash = (hash * 31 + f.charCodeAt(i)) | 0;
      const version = (hash >>> 0).toString(36);
      const src = `/* Crimson Coast service worker (generated) */
const CACHE = 'crimson-coast-${version}';
const PRECACHE = ${JSON.stringify(list)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((p) => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}
