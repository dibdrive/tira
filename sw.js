// Offline support for dibdrive.com/tira: page = network-first with cached fallback; libraries/fonts/icons = cache-first.
const C = "tira-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== C) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (req.mode === "navigate" && u.origin === location.origin) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put("/tira/", cp)); } return r; })
      .catch(() => caches.match("/tira/")));
    return;
  }
  if (u.origin === location.origin && /\/teams\.js$/.test(u.pathname)) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(req.url.split("?")[0], cp)); } return r; })
      .catch(() => caches.match(req.url.split("?")[0])));
    return;
  }
  const staticHost = /^(www\.gstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.football\.org\.il)$/.test(u.hostname);
  const staticLocal = u.origin === location.origin && /\.(png|webmanifest)$/.test(u.pathname);
  if (staticHost || staticLocal) {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(r => {
      if (r.ok || r.type === "opaque") { const cp = r.clone(); caches.open(C).then(c => c.put(req, cp)); }
      return r;
    })));
  }
});
