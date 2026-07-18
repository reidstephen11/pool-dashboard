// notify-core.js — reminder logic shared by the page (notify.js) and the
// service worker (sw.js, via importScripts). Runs in BOTH the window and the
// ServiceWorkerGlobalScope, so it only touches APIs available in both:
// IndexedDB, and a ServiceWorkerRegistration passed in for showNotification.
//
// Service workers cannot read localStorage, so the app mirrors the routine
// schedule into IndexedDB here; the background sync reads it from the same store.
(function () {
  var DB_NAME = 'poolDashboardNotify';
  var STORE = 'kv';
  var DAY_MS = 86400000;
  var DEFAULT_HOUR = 8; // reminders are held until 08:00 local — see pickDue

  // Local timestamp of hour:00 on the day `now` falls in. Built by mutating a
  // Date rather than dayStart + hour*3600000 so it stays on the wall clock
  // across a DST shift.
  function todayAt(now, hour) {
    var d = new Date(now);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(k) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
        rq.onsuccess = function () { resolve(rq.result ? rq.result.v : undefined); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }

  function idbSet(k, v) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ k: k, v: v });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Pure. Given the schedule ([{id,name,dueTs}]) and the map of already-notified
  // due-cycles ({id: dueTs}), return the routines that have JUST landed (due now
  // and not yet notified for this cycle) plus the updated notified map. Marks are
  // kept only for ids still present in the schedule, so deleted routines are
  // forgotten and a rescheduled routine (new dueTs) can notify again next cycle.
  //
  // Routines are day-precision, so dueTs is local MIDNIGHT — a routine is
  // technically due from 00:00. The background sync tends to run while the phone
  // sits idle on a charger, i.e. overnight, so firing on dueTs alone delivers the
  // reminder at 3am. Nothing is released before `hour` (default 08:00) local: the
  // gate is on the wall clock, not on the item, so a routine that is days overdue
  // can't slip out at night either. It waits for the first check after 08:00.
  function pickDue(schedule, notified, now, hour) {
    schedule = schedule || [];
    notified = notified || {};
    var open = now >= todayAt(now, hour == null ? DEFAULT_HOUR : hour);
    var due = [], next = {};
    schedule.forEach(function (it) {
      next[it.id] = notified[it.id];
      if (open && it.dueTs != null && it.dueTs <= now && notified[it.id] !== it.dueTs) {
        due.push(it);
        next[it.id] = it.dueTs;
      }
    });
    return { due: due, notified: next };
  }

  function overdueDays(item, now) {
    if (item.dueTs == null) return 0;
    return Math.max(0, Math.floor((now - item.dueTs) / DAY_MS));
  }

  // Fire one notification per due routine. Each call is caught individually so a
  // single failure (e.g. permission revoked mid-flight) can't reject the batch;
  // resolves to the ids that were actually shown, so runCheck only marks those.
  function showRoutineNotifications(reg, dueItems, now) {
    if (!reg || !reg.showNotification) return Promise.resolve([]);
    return Promise.all(dueItems.map(function (it) {
      var d = overdueDays(it, now);
      var body = d <= 0
        ? (it.name + ' is due today')
        : (it.name + ' is overdue by ' + d + ' day' + (d === 1 ? '' : 's'));
      return reg.showNotification('Pool reminder', {
        body: body,
        tag: 'routine-' + it.id,
        renotify: true,
        icon: 'icons/icon-192.png',
        badge: 'icons/badge-96.png',
        data: { screen: 'dashboard' }
      }).then(function () { return it.id; }, function () { return null; });
    })).then(function (ids) { return ids.filter(function (x) { return x != null; }); });
  }

  // The full cycle, used by BOTH foreground (page) and background (sync): read
  // state, notify newly-due routines, persist the notified marks. Resolves to the
  // number of notifications shown.
  //
  // All runCheck calls within a context are serialized through _chain: on load
  // both resume() and the schedule effect call checkNow(), and without this they
  // would each read the same un-notified map and double-notify the same cycle.
  // The 'notified' write is based on freshly-read state and marks only routines
  // we actually showed, so a failed notification is retried next cycle.
  var _chain = Promise.resolve();
  function runCheck(reg, now) {
    var run = function () {
      var when = now || Date.now();
      return Promise.all([idbGet('schedule'), idbGet('notified'), idbGet('notifyHour')]).then(function (r) {
        var schedule = r[0] || [], notified = r[1] || {};
        var hour = typeof r[2] === 'number' ? r[2] : DEFAULT_HOUR;
        var res = pickDue(schedule, notified, when, hour);
        if (!res.due.length) return 0;
        return showRoutineNotifications(reg, res.due, when).then(function (shownIds) {
          if (!shownIds.length) return 0;
          var updated = {};
          schedule.forEach(function (it) { updated[it.id] = notified[it.id]; });
          res.due.forEach(function (it) { if (shownIds.indexOf(it.id) !== -1) updated[it.id] = it.dueTs; });
          return idbSet('notified', updated).then(function () { return shownIds.length; });
        });
      });
    };
    _chain = _chain.then(run, run);
    return _chain;
  }

  self.PoolNotifyCore = {
    DEFAULT_HOUR: DEFAULT_HOUR, todayAt: todayAt,
    idbGet: idbGet, idbSet: idbSet, pickDue: pickDue,
    showRoutineNotifications: showRoutineNotifications, runCheck: runCheck
  };
})();
