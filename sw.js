// sw.js — Pool Dashboard service worker. Two jobs:
//   1. Reminders: background routine checks (Periodic Background Sync) and
//      notification clicks. Shares its logic with the page via notify-core.js so
//      "what's due" is computed the same way in both places.
//   2. Offline: keep the app openable with no network.
//
// The original version deliberately had NO fetch handler, to avoid any risk of
// interfering with the CDN loads the app depends on. That instinct was right
// about the risk and wrong about the cost: with nothing cached, opening the app
// out at the pool with no signal showed a browser error page rather than the app.
// The handler below keeps the original guarantee intact:
//
//   - Same-origin app code (index.html, app.jsx, routines.jsx, styles.css, …) is
//     NETWORK FIRST. Fresh code always wins when there is a connection, so a
//     deploy lands on the next load exactly as it did before, and a stale
//     app.jsx can never be served against a fresh index.html. The cache is only
//     a fallback for when the network fails.
//   - The pinned CDN bundles (React, ReactDOM, Babel, pdf.js) and Google Fonts
//     are CACHE FIRST. Every one of those URLs carries an immutable version, so
//     a cached copy cannot be wrong — and that is where the load time goes.
//   - Anything else is not intercepted at all.
//
// Bump CACHE when the precache list changes.
importScripts('notify-core.js');

var CACHE = 'pool-dashboard-v1';

// Same-origin shell. Relative so it works from the /pool-dashboard/ subpath.
var APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.jsx',
  'routines.jsx',
  'notify-core.js',
  'notify.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/badge-96.png',
  'icons/apple-touch-icon.png'
];

// Immutable, version-pinned third-party URLs — safe to cache indefinitely.
// Keep in sync with index.html and loadPdfJs() in app.jsx.
var VENDOR = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

function isCacheableVendor(url) {
  return /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url) ||
    /^https:\/\/unpkg\.com\/(react|react-dom|@babel)/.test(url) ||
    /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\//.test(url);
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // The app shell must all land; vendor/font entries are best-effort so one
      // unreachable CDN cannot fail the whole install.
      return cache.addAll(APP_SHELL).then(function () {
        return Promise.all(VENDOR.map(function (u) {
          return cache.add(new Request(u, { mode: 'cors' })).catch(function () {});
        }));
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  var sameOrigin = url.origin === self.location.origin;

  if (!sameOrigin && !isCacheableVendor(req.url)) return; // leave everything else alone

  // Same-origin app code and navigations: network first, cache as fallback.
  if (sameOrigin) {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          // A navigation to any in-app URL falls back to the shell.
          if (req.mode === 'navigate') {
            return caches.match('index.html').then(function (idx) {
              return idx || caches.match('./') || Response.error();
            });
          }
          return Response.error();
        });
      })
    );
    return;
  }

  // Version-pinned vendor assets and fonts: cache first.
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      });
    })
  );
});

// Fires roughly daily on installed PWAs (Android/Chromium). Reads the schedule
// the app mirrored into IndexedDB and notifies any routine that has come due.
self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'pool-routine-check') {
    event.waitUntil(self.PoolNotifyCore.runCheck(self.registration, Date.now()));
  }
});

// Focus an existing window, or open the app.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('.');
    })
  );
});
