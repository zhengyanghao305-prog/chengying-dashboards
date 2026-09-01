/**
 * web-sync.js — 橙萤工作台 统一云端同步（单一源码，按版本适配）
 *
 * 通过 window.__EDITION 区分版本：
 *   - 'mgmt'    管理版/外网版/桌面版：云端双向同步（Railway 中枢）+ 本地 3588 回写 + 静态回退 + 全量预加载
 *   - 'employee' 员工版：token 模式（X-Session-Token + X-API-Key，仅 emp- 命名空间）
 *
 * 改这里一处，所有版本自动同步（由 sync_all.py 分发）。
 */
(function () {
  if (typeof window === 'undefined' || typeof Store === 'undefined') return;

  var EDITION = window.__EDITION || 'mgmt';
  // 同步中枢：默认指向 dell 本机 3588（局域网 IP，供同事机跨机器访问）；
  // 若 dell IP 变动，可在页面注入 window.__SYNC_BASE 覆盖，或改此处默认值。
  var RAILWAY = (window.__SYNC_BASE && String(window.__SYNC_BASE).trim()) || 'http://192.168.10.187:3588';
  var API_KEY = 'chengying2026';
  var isElectron = Store.isElectron();

  // ============================================================
  // 员工版：token 模式
  // ============================================================
  function employeeSync() {
    function getToken() {
      try { return localStorage.getItem('emp_token') || ''; } catch (e) { return ''; }
    }
    function headers(extra) {
      var h = { 'X-Session-Token': getToken(), 'X-API-Key': API_KEY };
      if (extra) for (var k in extra) h[k] = extra[k];
      return h;
    }
    function parseBoardId() {
      if (!location.pathname.endsWith('board.html')) return null;
      return new URLSearchParams(location.search).get('id');
    }
    async function pull(id) {
      var token = getToken();
      if (!token) return { auth: false };
      try {
        var r = await fetch(RAILWAY + '/api/files/' + encodeURIComponent(id), { method: 'GET', headers: headers() });
        if (r.status === 401 || r.status === 403) return { auth: false };
        if (!r.ok) return { auth: true, data: null };
        var s = await r.json();
        var rows = Array.isArray(s) ? s : (s.data || []);
        return { auth: true, data: rows };
      } catch (e) { return { auth: true, data: null }; }
    }
    async function push(id) {
      var token = getToken();
      if (!token) return;
      try {
        var rows = Store.get(id);
        await fetch(RAILWAY + '/api/files/' + encodeURIComponent(id), {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ data: rows, updatedAt: new Date().toISOString(), source: 'web' })
        });
      } catch (e) { console.warn('[EmpSync] push 失败', id, e); }
    }
    var timers = {};
    function schedulePush(id) {
      if (timers[id]) clearTimeout(timers[id]);
      timers[id] = setTimeout(function () { timers[id] = null; push(id); }, 800);
    }
    Store.forceLoad = async function (id) {
      var res = await pull(id);
      if (res.auth === false) return false;
      if (res.data) { Store.set(id, res.data); return res.data.length > 0; }
      return false;
    };
    Store.preload = async function (id) {
      var ex = Store.get(id);
      if (ex.length > 0) return false;
      var res = await pull(id);
      if (res.auth === false) return false;
      if (res.data && res.data.length) { Store.set(id, res.data); return true; }
      return false;
    };
    ['add', 'update', 'remove'].forEach(function (m) {
      var orig = Store[m].bind(Store);
      Store[m] = function (id) {
        var args = Array.prototype.slice.call(arguments, 1);
        var ret = orig(id, args[0], args[1], args[2]);
        schedulePush(id);
        return ret;
      };
    });
    var boardId = parseBoardId();
    async function refresh() {
      if (!boardId) return;
      var ae = document.activeElement;
      if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
      var res = await pull(boardId);
      if (res.auth && res.data) {
        var local = Store.get(boardId);
        if (JSON.stringify(local) !== JSON.stringify(res.data)) {
          Store.set(boardId, res.data);
          if (window.__boardRerender) window.__boardRerender();
        }
      }
    }
    if (boardId) {
      setInterval(refresh, 60000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    }
    window.WebSync = { enabled: true, refresh: refresh, pull: pull, push: push };
    console.log('[EmpSync] 已启用（员工版云端双向同步）');
  }

  // ============================================================
  // 管理版 / 预览版：云端双向同步（参数化）
  // ============================================================
  function cloudSync(opts) {
    function creds() {
      var h = {};
      if (opts.credentials) h.credentials = opts.credentials;
      h.headers = {};
      try { var t = localStorage.getItem('cy_token'); if (t) h.headers['X-Session-Token'] = t; } catch (e) {}
      h.headers['X-API-Key'] = API_KEY;
      return h;
    }
    function base() {
      if (opts.relative) return '';
      var h = location.host;
      // 优先：注入 __SYNC_BASE 时用它（公共版指向本地实时穿透通道，实现「公共版实时同步本地版」）
      //   __SYNC_BASE === '__static__'  → 纯静态（相对路径兜底）
      //   __SYNC_BASE = 'https://xxx'   → 实时通道（本地版 3588 穿透，数据实时拉取）
      var custom = (window.__SYNC_BASE && String(window.__SYNC_BASE).trim());
      if (custom === '__static__') return '';
      if (custom) return custom;
      // Railway / CloudStudio 公共版（未注入时）：API 与静态文件同域，走相对路径（404 后自动回退 data/*.json），避免拉取内网 192.168.10.187 挂起
      if (h.indexOf('railway.app') >= 0 || h.indexOf('.app.workbuddy.link') >= 0) return '';
      // 本地 3588（localhost / 127.0.0.1 / 本机局域网 IP）：走相对路径，避免绕路到 192.168.10.187 再回来
      if (h.indexOf('localhost:') === 0 || h.indexOf('127.0.0.1:') === 0 || h.indexOf('192.168.10.187:') === 0) return '';
      return RAILWAY;
    }
    function parseBoardId() {
      if (!location.pathname.endsWith('board.html')) return null;
      return new URLSearchParams(location.search).get('id');
    }
    async function pullFromCloud(id) {
      try {
        var r = await fetch(base() + '/api/files/' + encodeURIComponent(id), creds());
        if (r.status === 401) return { auth: false };
        if (!r.ok) return null;
        var s = await r.json();
        var rows = Array.isArray(s) ? s : (s.data || []);
        return rows;
      } catch (e) { return null; }
    }
    async function pullFromStatic(id) {
      // 加时间戳避免浏览器缓存空响应（预览服务大文件首次可能返回空）
      var url = 'data/' + encodeURIComponent(id) + '.json?' + Date.now();
      try {
        var sr = await fetch(url);
        if (!sr.ok) return null;
        var d = await sr.json();
        if (Array.isArray(d)) return d;
      } catch (e) { /* 相对路径失败，走下方 3588 兜底 */ }
      // 兜底：本机 3588（跨源允许 `*`，file:// / 受限环境可用）
      try {
        var sr2 = await fetch('http://localhost:3588/' + url);
        if (!sr2.ok) return null;
        var d2 = await sr2.json();
        return Array.isArray(d2) ? d2 : null;
      } catch (e2) { return null; }
    }
    async function pull(id) {
      var isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      // 本地开发/调试优先走静态文件，避免大文件云端拉取过慢导致页面长时间空白
      if (opts.staticFallback && isLocalHost) {
        var l = await pullFromStatic(id);
        if (l && l.length) return { auth: true, data: l };
      }
      var c = await pullFromCloud(id);
      if (c && c.length) return { auth: true, data: c };
      if (opts.staticFallback && !isLocalHost) {
        var l2 = await pullFromStatic(id);
        if (l2 && l2.length) return { auth: true, data: l2 };
      }
      return { auth: true, data: null };
    }
    async function push(id) {
      try {
        var rows = Store.get(id);
        var o = creds();
        o.method = 'POST';
        o.headers = o.headers || {};
        o.headers['Content-Type'] = 'application/json';
        o.body = JSON.stringify({ data: rows, updatedAt: new Date().toISOString(), source: 'web' });
        await fetch(base() + '/api/files/' + encodeURIComponent(id), o);
        if (opts.localhostRewrite) {
          try {
            await fetch('http://localhost:3588/api/files/' + encodeURIComponent(id), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
              body: o.body
            });
          } catch (e) { /* 本地桌面版未运行时忽略 */ }
        }
      } catch (e) { console.warn('[WebSync] push 失败', id, e); }
    }
    var timers = {};
    function schedulePush(id) {
      if (timers[id]) clearTimeout(timers[id]);
      timers[id] = setTimeout(function () { timers[id] = null; push(id); }, 800);
    }
    Store.forceLoad = async function (id) {
      var res = await pull(id);
      if (res.auth === false) { console.warn('[WebSync] 未登录，无法同步', id); return false; }
      if (res.data) { Store.set(id, res.data); return res.data.length > 0; }
      return false;
    };
    Store.preload = async function (id) {
      var ex = Store.get(id);
      if (ex.length > 0) return false;
      var res = await pull(id);
      if (res.auth === false) return false;
      if (res.data && res.data.length) { Store.set(id, res.data); return true; }
      return false;
    };
    ['add', 'update', 'remove'].forEach(function (m) {
      var orig = Store[m].bind(Store);
      Store[m] = function (id) {
        var args = Array.prototype.slice.call(arguments, 1);
        var ret = orig(id, args[0], args[1], args[2]);
        schedulePush(id);
        return ret;
      };
    });
    var boardId = parseBoardId();
    if (boardId) {
      async function syncPull() {
        var ae = document.activeElement;
        if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
        var res = await pull(boardId);
        if (res.auth && res.data) {
          var local = Store.get(boardId);
          if (JSON.stringify(local) !== JSON.stringify(res.data)) {
            Store.set(boardId, res.data);
            if (window.__boardRerender) window.__boardRerender();
          }
        }
      }
      setInterval(syncPull, 60000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) syncPull(); });
    }
    window.WebSync = { enabled: true, pull: pull, push: push, schedulePush: schedulePush };
    console.log('[WebSync] 已启用（' + EDITION + '，云端双向同步）');

    if (opts.fullSync) {
      var ALL_BOARDS = [
        'daily-pulse', 'sales-alert', 'sales-alert-ship-detail', 'automation-projects', 'automation-log',
        'emp-notice', 'emp-task', 'emp-daily', 'emp-kb', 'emp-performance', 'dept-members'
      ];
      async function syncAll() {
        var results = await Promise.all(ALL_BOARDS.map(function (id) { return pull(id); }));
        var loaded = 0, authed = true;
        for (var i = 0; i < results.length; i++) {
          var res = results[i];
          if (res.auth === false) { authed = false; break; }
          if (res.data && res.data.length) { Store.set(ALL_BOARDS[i], res.data); loaded++; }
        }
        if (!authed) return false;
        console.log('[WebSync] 全量预加载完成，' + loaded + ' 个板块');
        return true;
      }
      window.__syncAll = syncAll;
      async function syncAllWithRetry(max) {
        max = max || 3;
        for (var i = 0; i < max; i++) {
          var ok = await syncAll();
          if (ok) {
            var p = Store.get('daily-pulse');
            if (p && p.length > 0) return true;
          }
          if (i < max - 1) {
            console.log('[WebSync] 数据为空，' + (i + 1) + '/' + max + ' 重试...');
            await new Promise(function (r) { setTimeout(r, 2000); });
          }
        }
        console.warn('[WebSync] ' + max + ' 次重试后仍有板块数据为空');
        return false;
      }
      window.__syncAllWithRetry = syncAllWithRetry;
      if (!boardId) {
        setTimeout(async function () {
          var res = await syncAll();
          if (res && window.__renderDashboard) window.__renderDashboard();
        }, 100);
      }
    }
  }

  // ============================================================
  // 路由
  // ============================================================
  if (EDITION === 'employee') {
    employeeSync();
  } else {
    var isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    var enabled = !isElectron && (location.protocol === 'https:' || isLocalHost);
    if (!enabled) return;
    cloudSync({
      staticFallback: true,
      localhostRewrite: true,
      fullSync: true
    });
  }
})();
