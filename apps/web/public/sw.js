/* App-shell service worker. Registered from components/sw-register.tsx.
   Bump VERSION on any caching-strategy change to invalidate old caches.

   HTML is never cached: pages can carry authenticated content, and a cached
   page outlives the session that produced it (worst case: a redirect chain at
   install time caches the login page under an app route). Offline navigation
   gets the neutral static shell (/offline.html) instead. */
const VERSION = "v2";
const CACHE = `wezesha-${VERSION}`;
const OFFLINE_URL = "/offline.html";

const APP_SHELL = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

/* Drop any HTML that made it into the current cache (older SW versions cached
   navigations). The offline shell is the one deliberate HTML entry. */
async function sweepCachedHtml() {
  const cache = await caches.open(CACHE);
  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname === OFFLINE_URL) continue;
    const res = await cache.match(request);
    const type = res?.headers.get("content-type") || "";
    if (type.includes("text/html")) await cache.delete(request);
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(sweepCachedHtml)
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Hashed build assets never change: cache-first.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Navigations: network only — never cached — offline shell as the fallback.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Everything else (manifest, icons, fonts): stale-while-revalidate, but only
  // non-HTML responses are ever written to the cache.
  event.respondWith(
    caches.match(request).then((hit) => {
      const refresh = fetch(request)
        .then((res) => {
          const type = res.headers.get("content-type") || "";
          if (res.ok && !type.includes("text/html")) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    }),
  );
});
