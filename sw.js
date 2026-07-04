// sw.js — Pool Dashboard service worker. Powers reminders only: background
// routine checks (Periodic Background Sync) and notification clicks. There is no
// fetch handler on purpose — the app loads normally from the network/CDN and we
// don't want to risk intercepting those requests. Shares its logic with the page
// via notify-core.js so "what's due" is computed the same way in both places.
importScripts('notify-core.js');

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

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
