/**
 * auth.js — 橙萤工作台 统一鉴权（单一源码，按版本适配）
 *
 * 通过 window.__EDITION 区分版本：
 *   - 'mgmt'    管理版 / 外网版 / 桌面版：前端直接校验（管理员密码 + 每日动态密码）
 *   - 'employee' 员工版：云端 token 模式（密码 → /api/login → emp_token）
 *
 * 改这里一处，所有版本自动同步（由 sync_all.py 分发）。
 */
(function () {
  var EDITION = window.__EDITION || 'mgmt';

  // ============================================================
  // 共享：每日动态密码算法（mgmt 前端校验用）
  // ============================================================
  var SECRET = '橙萤工作台2026@sunny';
  var MASTER_PASSES = ['zyh304754', 'CYsunny369'];  // Sunny 专属永久免登

  function getDailyPass() {
    var d = new Date();
    var ds = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    var s = SECRET + ds;
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h = h & h;
    }
    var h2 = Math.abs(h) * 16843009;
    var s2 = h2.toString() + 'CY';
    var h3 = 0;
    for (var j = 0; j < s2.length; j++) {
      h3 = ((h3 << 7) - h3) + s2.charCodeAt(j);
      h3 = h3 & h3;
    }
    return 'CY' + Math.abs(h3).toString(36).toUpperCase().slice(0, 6).padStart(6, '0');
  }

  // ============================================================
  // 共享：Cookie / 锁定工具
  // ============================================================
  function setCookie(name, val, days) {
    var expires = '';
    if (days) {
      var d = new Date();
      d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
      expires = ';expires=' + d.toUTCString();
    }
    var secure = (location.protocol === 'https:') ? ';Secure' : '';
    document.cookie = name + '=' + encodeURIComponent(val) + expires +
      ';path=/;SameSite=Lax' + secure;
  }
  function getCookie(name) {
    var c = document.cookie.split(';');
    for (var i = 0; i < c.length; i++) {
      var p = c[i].trim();
      if (p.indexOf(name + '=') === 0)
        return decodeURIComponent(p.substring(name.length + 1));
    }
    return '';
  }
  function lockScreen() {
    // 所有版本都放行聊天组件（未登录也能用 AI 助手）
    var extra = ':not(#blue-chat-widget)';
    var st = document.getElementById('__auth_style');
    if (!st) {
      st = document.createElement('style');
      st.id = '__auth_style';
      st.textContent =
        '.auth-locked body > *:not(#__auth)' + extra + '{display:none !important;}' +
        '.auth-locked, .auth-locked body{background:linear-gradient(135deg,#0f172a,#1e293b) !important;}';
      document.head.appendChild(st);
    }
    document.documentElement.classList.add('auth-locked');
  }
  function unlockScreen() {
    document.documentElement.classList.remove('auth-locked');
  }

  // ============================================================
  // 员工版：云端 token 模式
  // ============================================================
  function employeeAuth() {
    localAuth(); return;  // 员工版与管理版统一：前端密码校验（管理员密码 + 每日动态密码），不再走云端 /api/login
    var CLOUD = 'https://sync-server-production-bdec.up.railway.app';
    function getToken() {
      try { return localStorage.getItem('emp_token') || ''; } catch (e) { return ''; }
    }
    function getExp() {
      try { return parseInt(localStorage.getItem('emp_exp') || '0', 10); } catch (e) { return 0; }
    }
    function setToken(tok, exp) {
      try { localStorage.setItem('emp_token', tok); localStorage.setItem('emp_exp', String(exp)); } catch (e) {}
    }
    function clearToken() {
      try { localStorage.removeItem('emp_token'); localStorage.removeItem('emp_exp'); } catch (e) {}
    }
    function tokenValid() {
      var t = getToken();
      if (!t) return false;
      if (getExp() && Date.now() > getExp()) { clearToken(); return false; }
      return true;
    }

    function checkAuth() {
      if (tokenValid()) { unlockScreen(); return; }
      lockScreen();
      showLogin();
    }

    function showLogin() {
      var div = document.createElement('div');
      div.id = '__auth';
      div.innerHTML =
        '<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.55);' +
        'backdrop-filter:blur(8px);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:#fff;border-radius:16px;padding:32px 36px;width:370px;' +
        'box-shadow:0 25px 60px rgba(0,0,0,0.3);box-sizing:border-box;">' +
        '<div style="text-align:center;margin-bottom:18px;">' +
        '<div style="font-size:36px;margin-bottom:6px;">🐝</div>' +
        '<div style="font-size:18px;font-weight:700;color:#1e293b;">橙萤员工版</div>' +
        '<div style="font-size:12px;color:#94a3b8;margin-top:4px;">数据隐私保护 · 员工密码登录</div>' +
        '</div>' +
        '<input id="__auth_input" type="password" placeholder="请输入员工密码" ' +
        'style="width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;' +
        'font-size:14px;box-sizing:border-box;margin-bottom:10px;outline:none;" autofocus>' +
        '<div id="__auth_err" style="display:none;color:#dc2626;font-size:12px;margin-bottom:8px;"></div>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;' +
        'margin-bottom:14px;cursor:pointer;">' +
        '<input id="__auth_remember" type="checkbox" checked> 记住本设备（7 天内免登）</label>' +
        '<button id="__auth_btn" style="width:100%;padding:11px;background:#f97316;color:#fff;' +
        'border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">验证</button>' +
        '<div style="font-size:10px;color:#94a3b8;text-align:center;margin-top:12px;">' +
        '密码仅用于向云端换取会话凭证，不会存储或落前端</div>' +
        '</div></div>';
      document.body.appendChild(div);

      var input = document.getElementById('__auth_input');
      var errEl = document.getElementById('__auth_err');
      var btn = document.getElementById('__auth_btn');
      var rem = document.getElementById('__auth_remember');

      function doAuth() {
        var val = input.value;
        if (!val) { errEl.style.display = 'block'; errEl.textContent = '请输入员工密码'; return; }
        btn.disabled = true;
        btn.textContent = '验证中…';
        fetch(CLOUD + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: val })
        }).then(function (r) {
          return r.json().then(function (j) { return { status: r.status, body: j }; });
        }).then(function (res) {
          if (res.status === 200 && res.body.ok) {
            var exp = Date.now() + 7 * 24 * 3600 * 1000;
            setToken(res.body.token, exp);
            unlockScreen();
            div.remove();
            if (window.WebSync && window.WebSync.refresh) window.WebSync.refresh();
            else if (window.__boardRerender) window.__boardRerender();
            return;
          }
          if (res.body && res.body.error) throw new Error(res.body.error);
          throw new Error('bad');
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = '验证';
          errEl.style.display = 'block';
          errEl.textContent = (err && err.message === 'not_employee')
            ? '❌ 该密码不是员工登录密码' : '❌ 密码错误，请重试';
          input.value = '';
          input.focus();
        });
      }
      btn.onclick = doAuth;
      input.onkeydown = function (e) { if (e.key === 'Enter') doAuth(); };
    }

    window.empLogout = function () { clearToken(); location.reload(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkAuth);
    else checkAuth();
  }

  // ============================================================
  // 管理版 / 外网版：前端密码模式
  // ============================================================
  function localAuth() {
    function storePerm() {
      try { localStorage.setItem('sunny_perm', '1'); } catch (e) {}
      setCookie('sunny_token', 'permanent', 365);
    }
    function clearPerm() {
      try { localStorage.removeItem('sunny_perm'); } catch (e) {}
      setCookie('sunny_token', '', -1);
    }
    function isPerm() {
      if (getCookie('sunny_token') === 'permanent') return true;
      try { if (localStorage.getItem('sunny_perm') === '1') return true; } catch (e) {}
      return false;
    }

    function afterUnlock() {
      if (typeof window.__syncAll === 'function') {
        try {
          window.__syncAll().then(function () {
            if (typeof window.__boardRerender === 'function') window.__boardRerender();
            if (typeof window.renderEmployeeCockpit === 'function') window.renderEmployeeCockpit();
          });
        } catch (e) {}
      } else {
        if (typeof window.__boardRerender === 'function') window.__boardRerender();
      }
    }

    function checkAuth() {
      if (isPerm()) { unlockScreen(); return; }
      var pass = getDailyPass();
      if (getCookie('sunny_auth') === pass) { unlockScreen(); return; }
      lockScreen();
      showLogin(pass);
    }

    function showLogin(pass) {
      var div = document.createElement('div');
      div.id = '__auth';
      var brand = '橙萤工作台';
      div.innerHTML =
        '<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:linear-gradient(135deg,#0f172a,#1e293b);' +
        'z-index:99999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:#fff;border-radius:16px;padding:32px 36px;width:370px;' +
        'box-shadow:0 25px 60px rgba(0,0,0,0.3);box-sizing:border-box;">' +
        '<div style="text-align:center;margin-bottom:18px;">' +
        '<div style="font-size:36px;margin-bottom:6px;">🔐</div>' +
        '<div style="font-size:18px;font-weight:700;color:#1e293b;">' + brand + '</div>' +
        '<div style="font-size:12px;color:#94a3b8;margin-top:4px;">数据隐私保护 · 密码验证</div>' +
        '</div>' +
        '<input id="__auth_input" type="password" placeholder="请输入密码" ' +
        'style="width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;' +
        'font-size:14px;box-sizing:border-box;margin-bottom:10px;outline:none;" autofocus>' +
        '<div id="__auth_err" style="display:none;color:#dc2626;font-size:12px;margin-bottom:8px;">' +
        '❌ 密码错误，请重试</div>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;' +
        'margin-bottom:14px;cursor:pointer;">' +
        '<input id="__auth_remember" type="checkbox" checked> 我的设备，记住我</label>' +
        '<button id="__auth_btn" style="width:100%;padding:11px;background:#3b82f6;color:#fff;' +
        'border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">验证</button>' +
        '<div style="font-size:10px;color:#94a3b8;text-align:center;margin-top:12px;">' +
        '管理员密码永久有效 · 每日动态密码当天有效</div>' +
        '</div></div>';
      document.body.appendChild(div);

      var input = document.getElementById('__auth_input');
      var errEl = document.getElementById('__auth_err');
      var btn = document.getElementById('__auth_btn');
      var rem = document.getElementById('__auth_remember');

      function doAuth() {
        var val = input.value;
        var isMaster = false;
        for (var k = 0; k < MASTER_PASSES.length; k++) {
          if (val === MASTER_PASSES[k]) { isMaster = true; break; }
        }
        if (isMaster) {
          storePerm();
          unlockScreen();
          div.remove();
          afterUnlock();
          return;
        }
        if (val === pass) {
          if (rem.checked) setCookie('sunny_auth', pass, 1);
          else setCookie('sunny_auth', pass, 0);
          unlockScreen();
          div.remove();
          afterUnlock();
          return;
        }
        errEl.style.display = 'block';
        input.value = '';
        input.focus();
      }
      btn.onclick = doAuth;
      input.onkeydown = function (e) { if (e.key === 'Enter') doAuth(); };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkAuth);
    else checkAuth();
  }

  // ============================================================
  // 路由
  // ============================================================
  if (EDITION === 'employee') employeeAuth();
  else localAuth();
})();
