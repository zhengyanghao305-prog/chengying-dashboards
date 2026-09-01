/**
 * auth.js — 工作台密码保护（本地版 / 网页端通用）
 *
 * 本地版【在前端直接校验】，不依赖服务端 /api/login：
 *   - 管理员密码（zyh304754 / CYsunny369）→ 勾「记住我」写永久免登（365 天）
 *   - 每日动态密码 → 仅当日有效，算法见 getDailyPass()
 *
 * 每日动态密码算法：
 *   固定密钥 '橙萤工作台2026@sunny' + 当天日期 YYYY-MM-DD
 *   双重 BKDR 哈希 + 素数 16843009 扩散 → CY + 6 位 36 进制大写
 *   例：2026-07-11 → CYFR9O3S，2026-07-12 → CY34D3QD
 *
 * 未认证时整页加 auth-locked，除解锁框外不渲染任何后台数据。
 */
(function () {
  var SECRET = '橙萤工作台2026@sunny';
  var MASTER_PASSES = ['zyh304754', 'CYsunny369'];  // Sunny 专属永久免登

  // ── 生成今日密码（双重哈希 + 素数扩散防碰撞）──
  function getDailyPass() {
    var d = new Date();
    var ds = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    var s = SECRET + ds;
    // 第 1 轮 BKDR
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h = h & h;
    }
    // 第 2 轮：用第 1 轮结果做种子再哈希一次，然后乘大素数扩散
    var h2 = Math.abs(h) * 16843009;  // 素数 16843009 做位扩散
    var s2 = h2.toString() + 'CY';
    var h3 = 0;
    for (var i = 0; i < s2.length; i++) {
      h3 = ((h3 << 7) - h3) + s2.charCodeAt(i);
      h3 = h3 & h3;
    }
    return 'CY' + Math.abs(h3).toString(36).toUpperCase().slice(0, 6).padStart(6, '0');
  }

  // ── Cookie 工具 ──
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

  // ── 永久免登：cookie + localStorage 双保险 ──
  function storePerm() {
    try { localStorage.setItem('sunny_perm', '1'); } catch (e) {}
    setCookie('sunny_token', 'permanent', 365);
  }
  function isPerm() {
    if (getCookie('sunny_token') === 'permanent') return true;
    try { if (localStorage.getItem('sunny_perm') === '1') return true; } catch (e) {}
    return false;
  }

  // ── 锁定/解锁整页内容 ──
  function lockScreen() {
    var st = document.getElementById('__auth_style');
    if (!st) {
      st = document.createElement('style');
      st.id = '__auth_style';
      st.textContent =
        '.auth-locked body > *:not(#__auth){display:none !important;}' +
        '.auth-locked, .auth-locked body{background:linear-gradient(135deg,#0f172a,#1e293b) !important;}';
      document.head.appendChild(st);
    }
    document.documentElement.classList.add('auth-locked');
  }
  function unlockScreen() {
    document.documentElement.classList.remove('auth-locked');
  }

  // ── 登录成功后如有全量同步函数则刷新本地数据 ──
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

  // ── 检测是否已认证 ──
  function checkAuth() {
    if (isPerm()) { unlockScreen(); return; }

    var pass = getDailyPass();
    if (getCookie('sunny_auth') === pass) { unlockScreen(); return; }

    lockScreen();
    showLogin(pass);
  }

  // ── 登录界面 ──
  function showLogin(pass) {
    var div = document.createElement('div');
    div.id = '__auth';
    div.innerHTML =
      '<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:linear-gradient(135deg,#0f172a,#1e293b);' +
      'z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:#fff;border-radius:16px;padding:32px 36px;width:370px;' +
      'box-shadow:0 25px 60px rgba(0,0,0,0.3);box-sizing:border-box;">' +
      '<div style="text-align:center;margin-bottom:18px;">' +
      '<div style="font-size:36px;margin-bottom:6px;">🔐</div>' +
      '<div style="font-size:18px;font-weight:700;color:#1e293b;">橙萤工作台</div>' +
      '<div style="font-size:12px;color:#94a3b8;margin-top:4px;">数据隐私保护 · 密码验证</div>' +
      '</div>' +
      '<input id="__auth_input" type="password" placeholder="请输入密码" ' +
      'style="width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;' +
      'font-size:14px;box-sizing:border-box;margin-bottom:10px;outline:none;" autofocus>' +
      '<div id="__auth_err" style="display:none;color:#dc2626;font-size:12px;margin-bottom:8px;">' +
      '❌ 密码错误，请重试</div>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;' +
      'margin-bottom:14px;cursor:pointer;">' +
      '<input id="__auth_remember" type="checkbox" checked> 我的设备，记住我（管理员密码可永久免登）</label>' +
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

      // 情形 1：管理员永久免登密码
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

      // 情形 2：每日动态密码
      if (val === pass) {
        if (rem.checked) setCookie('sunny_auth', pass, 1);
        else setCookie('sunny_auth', pass, 0);
        unlockScreen();
        div.remove();
        afterUnlock();
        return;
      }

      // 密码错误
      errEl.style.display = 'block';
      input.value = '';
      input.focus();
    }

    btn.onclick = doAuth;
    input.onkeydown = function (e) { if (e.key === 'Enter') doAuth(); };
  }

  // ── 启动 ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAuth);
  } else {
    checkAuth();
  }
})();
