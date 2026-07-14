// notify.js — page-side glue for reminders. Exposes window.PoolNotify, used by
// app.jsx. Loads AFTER notify-core.js (which provides self.PoolNotifyCore).
// Everything is feature-detected and failure-tolerant: if notifications, service
// workers or IndexedDB are missing/blocked, the app runs exactly as before.
(function () {
  var CORE = self.PoolNotifyCore;
  var PERIODIC_TAG = 'pool-routine-check';
  var MIN_INTERVAL = 12 * 60 * 60 * 1000; // 12h hint; the browser throttles to ~daily.
  var swReg = null;

  function supported() {
    return typeof Notification !== 'undefined' && 'serviceWorker' in navigator && !!CORE;
  }
  function permission() {
    return (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.register('sw.js').then(function () {
      return navigator.serviceWorker.ready;
    }).then(function (reg) { swReg = reg; return reg; })
      .catch(function (e) { console.warn('[PoolNotify] SW registration failed', e); return null; });
  }

  // Resolve the active registration WITHOUT hanging. navigator.serviceWorker.ready
  // never settles when no worker is registered (e.g. sw.js 404 on the subpath, or
  // registration was blocked), so we prefer getRegistration() and cap .ready with
  // a timeout — callers are fire-and-forget and must never leak a pending promise.
  function readyReg() {
    if (swReg) return Promise.resolve(swReg);
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration().then(function (reg) {
      if (reg && reg.active) { swReg = reg; return reg; }
      return Promise.race([
        navigator.serviceWorker.ready,
        new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 3000); })
      ]).then(function (r) { if (r) swReg = r; return r || null; });
    }).catch(function () { return null; });
  }

  function isEnabled() {
    if (!supported() || permission() !== 'granted') return Promise.resolve(false);
    return CORE.idbGet('enabled').then(function (v) { return !!v; }).catch(function () { return false; });
  }

  function registerPeriodicSync(reg) {
    if (!reg || !reg.periodicSync) return Promise.resolve(false);
    var q = (navigator.permissions && navigator.permissions.query)
      ? navigator.permissions.query({ name: 'periodic-background-sync' })
      : Promise.resolve({ state: 'granted' });
    return q.then(function (status) {
      if (status.state !== 'granted') return false;
      return reg.periodicSync.register(PERIODIC_TAG, { minInterval: MIN_INTERVAL })
        .then(function () { return true; })
        .catch(function (e) { console.warn('[PoolNotify] periodicSync register failed', e); return false; });
    }).catch(function () { return false; });
  }

  function unregisterPeriodicSync(reg) {
    if (!reg || !reg.periodicSync) return Promise.resolve();
    return reg.periodicSync.unregister(PERIODIC_TAG).catch(function () {});
  }

  // Turn reminders on: request permission (must be from a user gesture), register
  // the SW, persist the enabled flag, opt into background sync, and do an
  // immediate foreground check. Resolves {ok, permission, background}.
  function enable() {
    if (!supported()) return Promise.resolve({ ok: false, permission: 'unsupported' });
    return Promise.resolve(Notification.requestPermission()).then(function (perm) {
      if (perm !== 'granted') return { ok: false, permission: perm };
      return registerSW().then(function (reg) {
        return CORE.idbSet('enabled', true).then(function () {
          return registerPeriodicSync(reg).then(function (bg) {
            return checkNow().then(function () {
              return { ok: true, permission: 'granted', background: bg };
            });
          });
        });
      });
    }).catch(function (e) {
      console.warn('[PoolNotify] enable failed', e);
      return { ok: false, permission: permission() };
    });
  }

  function disable() {
    return CORE.idbSet('enabled', false).then(function () {
      return readyReg().then(unregisterPeriodicSync);
    }).catch(function () {});
  }

  // Re-arm on app load if reminders were previously enabled.
  function resume() {
    return isEnabled().then(function (on) {
      if (!on) return;
      return registerSW().then(function (reg) {
        return registerPeriodicSync(reg).then(function () { return checkNow(); });
      });
    }).catch(function () {});
  }

  // Called by the app whenever routines/log change, so the background sync always
  // has a fresh schedule to read. Written even when reminders are off, so that
  // enabling later has current data immediately.
  function writeSchedule(schedule) {
    if (!supported()) return Promise.resolve();
    return CORE.idbSet('schedule', schedule || []).catch(function () {});
  }

  // Earliest local hour a routine reminder may be delivered (see pickDue in
  // notify-core.js). Stored in IndexedDB, not localStorage, because the service
  // worker reads it too.
  function getNotifyHour() {
    if (!CORE) return Promise.resolve(8);
    return CORE.idbGet('notifyHour').then(function (v) {
      return typeof v === 'number' ? v : CORE.DEFAULT_HOUR;
    }).catch(function () { return CORE.DEFAULT_HOUR; });
  }

  // Re-check immediately after saving: moving the hour back to one that has
  // already passed should release anything due today rather than wait a day.
  function setNotifyHour(h) {
    if (!CORE) return Promise.resolve();
    return CORE.idbSet('notifyHour', h).then(checkNow).catch(function () {});
  }

  // Foreground check — only fires when enabled + permission granted.
  function checkNow() {
    return isEnabled().then(function (on) {
      if (!on) return 0;
      return readyReg().then(function (reg) {
        return reg ? CORE.runCheck(reg, Date.now()) : 0;
      });
    }).catch(function () { return 0; });
  }

  // Notify about brand-new PDF action items (foreground only — these only ever
  // appear from an upload the user just performed).
  function notifyTodos(count, firstLabel, dateStr) {
    if (!count) return Promise.resolve();
    return isEnabled().then(function (on) {
      if (!on) return;
      return readyReg().then(function (reg) {
        if (!reg || !reg.showNotification) return;
        var body = count === 1
          ? (firstLabel || '1 new action from your latest test')
          : (count + ' new actions from your ' + (dateStr || 'latest') + ' test');
        return reg.showNotification('Pool test imported', {
          body: body, tag: 'pool-todos', renotify: true,
          icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
          data: { screen: 'dashboard' }
        });
      });
    }).catch(function () {});
  }

  window.PoolNotify = {
    supported: supported, permission: permission, isEnabled: isEnabled,
    enable: enable, disable: disable, resume: resume,
    getNotifyHour: getNotifyHour, setNotifyHour: setNotifyHour,
    writeSchedule: writeSchedule, checkNow: checkNow, notifyTodos: notifyTodos
  };
})();
