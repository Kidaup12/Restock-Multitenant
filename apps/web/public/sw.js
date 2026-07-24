/* App-shell service worker. Registered from components/sw-register.tsx.
   Bump VERSION on any caching-strategy change to invalidate old caches.

   HTML is never cached: pages can carry authenticated content, and a cached
   page outlives the session that produced it (worst case: a redirect chain at
   install time caches the login page under an app route). Offline navigation
   gets the neutral static shell (/offline.html) instead. */
const VERSION = "v3";
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

  // Never intercept React Server Component / router payloads. They are
  // request-specific (keyed by router-state headers the Cache API ignores), so
  // serving a cached one makes the App Router fall back to a FULL page reload.
  // These carry the RSC header (navigations/prefetches) or the _rsc query; let
  // them reach the network untouched.
  if (
    request.headers.get("RSC") === "1" ||
    request.headers.get("Next-Router-Prefetch") === "1" ||
    url.searchParams.has("_rsc")
  ) {
    return;
  }

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

  // Full-document navigations: network only — never cached — offline shell fallback.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Static shell assets ONLY (icons, manifest, fonts, styles): stale-while-
  // revalidate. Everything else (API calls, dynamic data) is left to the network
  // so nothing request-specific is ever served from cache.
  if (["image", "font", "style", "manifest"].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const refresh = fetch(request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      }),
    );
  }
});
