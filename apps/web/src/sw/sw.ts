// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// The service worker (ADR 0028 decision 7): app-shell cache, push and notification clicks. Built
// as a classic script into `/sw.js` by `scripts/vite-pwa.ts`, which defines the two constants
// below. It stores nothing but the build's own static files: no IndexedDB, cookies or
// `localStorage`, and nothing personal. The logic lives in the pure modules beside it.
import { addNetworkRoutes, cacheName, shouldServeFromCache, staleCaches } from "./cache.ts";
import { clickTarget, goLiveNotification, parsePushPayload } from "./push.ts";

/** Same-origin paths of the shell: the entry's scripts and styles, and the icons. */
declare const __PRECACHE__: readonly string[];
/** A hash of the precache list: a new build with new files gets a new cache. */
declare const __VERSION__: string;

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = cacheName(__VERSION__);
const PRECACHE = new Set(__PRECACHE__);

sw.addEventListener("install", (event) => {
  // No skipWaiting here: the page asks once the viewer chose to reload (the update prompt).
  event.waitUntil(
    Promise.all([addNetworkRoutes(event), caches.open(CACHE).then((cache) => cache.addAll([...PRECACHE]))]),
  );
});

sw.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === "skip-waiting")
    void sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(staleCaches(keys, CACHE).map((key) => caches.delete(key))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  // Not intercepted: the browser handles it exactly as without a worker. Where the Static Routing
  // API exists, such requests never reach this listener at all (`addNetworkRoutes`).
  if (!shouldServeFromCache(request, sw.location.origin, PRECACHE)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }),
  );
});

sw.addEventListener("push", (event) => {
  let data: unknown = null;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  const payload = parsePushPayload(data);
  if (!payload) return;
  const { title, options } = goLiveNotification(payload, sw.navigator.languages);
  event.waitUntil(sw.registration.showNotification(title, options));
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = clickTarget(event.notification.data, sw.location.origin);
  event.waitUntil(
    sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url === target);
      return open ? open.focus() : sw.clients.openWindow(target);
    }),
  );
});
