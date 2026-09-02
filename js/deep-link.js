/* ============================================================
 * deep-link.js — 诊断卡片「直达问题本质」的通用深度链接工具
 * 用法：
 *   DeepLink.read()                    // 从 URL ?diag_focus=... 解析出 focus 对象
 *   DeepLink.build(obj)                // 返回 URL 参数字符串（已 encode）
 *   DeepLink.add(href, focus)          // 把 href 和 focus 拼成跳转链接
 *   DeepLink.highlight(sel, text)      // 滚动并高亮文本（持久醒目样式）
 *   DeepLink.toast(title, sub)         // 顶部悬浮「已定位到」提示条
 * ============================================================ */
(function () {
  'use strict';

  var KEY = 'diag_focus';

  // 注入高亮/提示条样式
  (function () {
    var css =
      '.dl-highlight{' +
        'background:#fef3c7 !important;' +
        'box-shadow:0 0 0 3px #f59e0b, 0 0 24px rgba(245,158,11,.45) !important;' +
        'border-radius:8px;' +
        'transition:box-shadow .2s;' +
        'animation:dlPulse 1.6s ease-in-out 4;' +
      '}' +
      '@keyframes dlPulse{' +
        '0%,100%{box-shadow:0 0 0 3px #f59e0b,0 0 14px rgba(245,158,11,.35);}' +
        '50%{box-shadow:0 0 0 6px #fbbf24,0 0 30px rgba(245,158,11,.65);}' +
      '}' +
      '#dlToast{' +
        'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483000;' +
        'max-width:min(560px,92vw);background:#0f172a;color:#fff;border-radius:12px;' +
        'padding:11px 16px;font-size:13px;line-height:1.5;box-shadow:0 8px 30px rgba(15,23,42,.4);' +
        'display:flex;align-items:center;gap:10px;animation:dlSlideDown .3s ease;' +
      '}' +
      '@keyframes dlSlideDown{from{transform:translate(-50%,-16px);opacity:0}to{transform:translate(-50%,0);opacity:1}}' +
      '#dlToast b{color:#fbbf24;}' +
      '#dlToast .dl-close{cursor:pointer;color:#94a3b8;font-size:14px;line-height:1;padding:2px 6px;border-radius:6px;}' +
      '#dlToast .dl-close:hover{color:#fff;background:#334155;}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  })();

  function read() {
    try {
      var s = new URLSearchParams(location.search).get(KEY);
      if (!s) return null;
      return JSON.parse(decodeURIComponent(s));
    } catch (e) { return null; }
  }

  function build(obj) {
    return KEY + '=' + encodeURIComponent(JSON.stringify(obj));
  }

  function add(href, focus) {
    var sep = href.indexOf('?') >= 0 ? '&' : '?';
    return href + sep + build(focus);
  }

  // 顶部悬浮提示条（持久，可手动关闭）
  function toast(title, sub) {
    var old = document.getElementById('dlToast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.id = 'dlToast';
    var icon = document.createElement('span');
    icon.textContent = '🎯';
    var body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0;';
    var b = document.createElement('div');
    b.innerHTML = ''; // 用 textContent 防注入
    var b1 = document.createElement('span');
    b1.textContent = '已定位到：';
    var b2 = document.createElement('b');
    b2.textContent = title || '';
    b.appendChild(b1); b.appendChild(b2);
    var s = document.createElement('div');
    s.style.cssText = 'font-size:11.5px;color:#cbd5e1;margin-top:2px;';
    s.textContent = sub || '';
    body.appendChild(b); body.appendChild(s);
    var close = document.createElement('span');
    close.className = 'dl-close';
    close.textContent = '✕';
    close.onclick = function () { t.remove(); };
    t.appendChild(icon); t.appendChild(body); t.appendChild(close);
    document.body.appendChild(t);
    setTimeout(function () { if (document.getElementById('dlToast') === t) t.remove(); }, 20000);
    return t;
  }

  // 通用高亮/滚动：滚动到目标并把行/卡片标成醒目持久样式（约 12 秒，点击后自动消失）
  function highlight(selector, text, opts) {
    opts = opts || {};
    var wrap = selector ? document.querySelector(selector) : document.body;
    if (!wrap) return null;
    var t = String(text || '').trim();
    var found = null;
    if (!opts.skipTextSearch) {
      var nodes = wrap.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.children && n.children.length) continue;
        if (t && n.textContent.trim().indexOf(t) >= 0) { found = n; break; }
      }
    }
    if (!found && t) {
      var rows = wrap.querySelectorAll('tr, .link-card, [data-idx]');
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].textContent.indexOf(t) >= 0) { found = rows[j]; break; }
      }
    }
    var el = null;
    if (found) {
      el = found.closest('tr, .link-card, [data-idx], .cat-card') || found;
      try { el.scrollIntoView({ behavior: 'smooth', block: opts.block || 'center' }); } catch (e) {}
      el.classList.add('dl-highlight');
      el.setAttribute('data-dl-target', '1');
      var timer = setTimeout(function () { el.classList.remove('dl-highlight'); el.removeAttribute('data-dl-target'); }, opts.keep || 12000);
      el.addEventListener('click', function once() { el.classList.remove('dl-highlight'); el.removeAttribute('data-dl-target'); clearTimeout(timer); el.removeEventListener('click', once); });
    }
    return el;
  }

  // 等待条件后执行 fn
  function waitFor(check, fn, timeout) {
    timeout = timeout || 5000;
    var start = Date.now();
    var t = setInterval(function () {
      if (check() || Date.now() - start > timeout) {
        clearInterval(t);
        fn();
      }
    }, 80);
  }

  window.DeepLink = { read: read, build: build, add: add, highlight: highlight, toast: toast, waitFor: waitFor };
})();
