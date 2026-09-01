/**
 * chat-widget.js — 橙萤工作台 AI 聊天组件 v3
 * 对话记录 | 新对话 | 拖拽 | 四角调大小 | 手机版
 */
(function () {
  'use strict';

  // 后端 API 地址（按版本适配，统一单份源码）：
  //   - 管理版/外网版：同源相对路径 ''（server 已提供 /api/chat）
  //   - 员工版(Electron 无本地后端)：直连云端 Railway /api/chat（CORS:* 无需鉴权）
  var RAILWAY_BASE = 'https://sync-server-production-bdec.up.railway.app';
  var API_BASE = (window.__EDITION === 'employee') ? RAILWAY_BASE : '';

  // ==================== 状态 ====================
  var messages = [];
  var isOpen = false;
  var isStreaming = false;
  var abortController = null;
  var currentModel = 'qwen-turbo';
  var chatMode = 'chat';
  var currentConvId = null;
  var dragMoved = false; // 拖拽标记，防止点击误触

  var MODELS = {
    deepseek: { label: 'DeepSeek', fee: '💰付费' },
    'qwen-turbo': { label: '通义千问 Turbo', fee: '🆓免费' },
    'qwen-plus':  { label: '通义千问 Plus', fee: '🆓免费' },
    'qwen-max':   { label: '通义千问 Max', fee: '🆓免费' },
    ollama:   { label: '本地 Ollama', fee: '🆓免费' },
  };

  var STORAGE_KEY = 'blue-conversations';
  var widgetEl, panelEl, messagesEl, inputEl, sendBtn, bubbleEl, convSidebar, convListEl;
  var sidebarOpen = false;
  var maxed = false, prevGeom = null;

  // ==================== 对话持久化 ====================
  function loadConvs() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveConvs(convs) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(convs));
  }
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function getConv(id) {
    return loadConvs().find(function(c) { return c.id === id; }) || null;
  }

  function saveCurrentConv() {
    var convs = loadConvs();
    var idx = convs.findIndex(function(c) { return c.id === currentConvId; });
    var title = messages.length > 1 ? messages[1].content.substring(0, 30) : '新对话';
    var data = { id: currentConvId, title: title, messages: messages, model: currentModel, mode: chatMode, updatedAt: Date.now() };
    if (idx >= 0) { convs[idx] = data; }
    else { convs.push(data); }
    if (convs.length > 50) convs = convs.slice(-50);
    saveConvs(convs);
  }

  function newConversation() {
    if (currentConvId && messages.length > 1) saveCurrentConv();
    currentConvId = genId();
    messages = [{ role: 'system', content: 'start' }];
    clearMessages();
    addWelcomeMessage();
    renderConvList();
    saveCurrentConv();
  }

  function switchConversation(id) {
    if (isStreaming) abortStream();
    if (currentConvId && messages.length > 1) saveCurrentConv();
    var conv = getConv(id);
    if (!conv) return;
    currentConvId = conv.id;
    messages = conv.messages || [];
    currentModel = conv.model || 'qwen-turbo';
    chatMode = conv.mode || 'chat';
    var info = MODELS[currentModel] || { label: currentModel, fee: '' };
    document.getElementById('blueModelStatus').textContent = info.label + ' · ' + info.fee;
    var trig = document.getElementById('blueModelTrigger');
    if (trig) trig.textContent = info.label + ' ▾';
    clearMessages();
    for (var i = 1; i < messages.length; i++) {
      if (messages[i].role === 'user' || messages[i].role === 'assistant') {
        appendMessage(messages[i].content, messages[i].role);
      }
    }
    closeSidebar();
    renderConvList();
  }

  function deleteConversation(id, e) {
    if (e) e.stopPropagation();
    if (!confirm('删除此对话？')) return;
    var convs = loadConvs().filter(function(c) { return c.id !== id; });
    saveConvs(convs);
    if (id === currentConvId) {
      if (convs.length > 0) switchConversation(convs[0].id);
      else newConversation();
    }
    renderConvList();
  }

  // ==================== 保存/恢复位置 ====================
  function saveGeom() {
    try {
      var r = widgetEl.getBoundingClientRect();
      localStorage.setItem('blue-panel-geom', JSON.stringify({
        l: r.left, t: r.top, w: widgetEl.offsetWidth, h: widgetEl.offsetHeight
      }));
    } catch(e) {}
  }
  function restoreGeom() {
    try {
      var g = JSON.parse(localStorage.getItem('blue-panel-geom'));
      if (g && g.w > 0 && g.h > 0) {
        widgetEl.style.left = g.l + 'px'; widgetEl.style.top = g.t + 'px';
        widgetEl.style.bottom = 'auto'; widgetEl.style.right = 'auto';
        widgetEl.style.width = g.w + 'px'; widgetEl.style.height = g.h + 'px';
        return true;
      }
    } catch(e) {}
    return false;
  }

  // ==================== 统一拖拽（鼠标+触屏） ====================
  function startDrag(e, cx, cy) {
    cx = cx || e.clientX;
    cy = cy || e.clientY;
    var ox = cx - widgetEl.getBoundingClientRect().left;
    var oy = cy - widgetEl.getBoundingClientRect().top;
    // 过滤掉按钮等交互元素
    if (e.target && e.target.closest && e.target.closest('button, select, .blue-model-dropdown')) return;

    widgetEl.style.bottom = 'auto'; widgetEl.style.right = 'auto';
    widgetEl.style.left = (cx - ox) + 'px'; widgetEl.style.top = (cy - oy) + 'px';

    function mm(ev) {
      var nl = Math.max(20, Math.min(ev.clientX - ox, window.innerWidth - widgetEl.offsetWidth - 20));
      var nt = Math.max(20, Math.min(ev.clientY - oy, window.innerHeight - widgetEl.offsetHeight - 20));
      widgetEl.style.left = nl + 'px'; widgetEl.style.top = nt + 'px';
    }
    function tm(ev) { ev.preventDefault(); mm({ clientX: ev.touches[0].clientX, clientY: ev.touches[0].clientY }); }
    function mu() {
      document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
      document.removeEventListener('touchmove', tm); document.removeEventListener('touchend', mu);
      saveGeom();
    }
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
    document.addEventListener('touchmove', tm, { passive: false }); document.addEventListener('touchend', mu);
  }

  // ==================== 气泡拖拽 ====================
  var bubbleTouchId = null;
  function startBubbleDrag(e, cx, cy) {
    cx = cx || e.clientX;
    cy = cy || e.clientY;
    dragMoved = false;
    var rect = widgetEl.getBoundingClientRect();
    var ox = cx - rect.left, oy = cy - rect.top;
    widgetEl.style.bottom = 'auto'; widgetEl.style.right = 'auto';
    widgetEl.style.left = rect.left + 'px'; widgetEl.style.top = rect.top + 'px';

    function mm(ev) {
      var dx = ev.clientX - ox - rect.left, dy = ev.clientY - oy - rect.top;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true;
      var nl = Math.max(10, Math.min(ev.clientX - ox, window.innerWidth - widgetEl.offsetWidth - 10));
      var nt = Math.max(10, Math.min(ev.clientY - oy, window.innerHeight - widgetEl.offsetHeight - 10));
      widgetEl.style.left = nl + 'px'; widgetEl.style.top = nt + 'px';
    }
    function mu() {
      document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
      document.removeEventListener('touchmove', tm); document.removeEventListener('touchend', mu);
      saveGeom();
    }
    function tm(ev) { ev.preventDefault(); mm({ clientX: ev.touches[0].clientX, clientY: ev.touches[0].clientY }); }
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
    document.addEventListener('touchmove', tm, { passive: false }); document.addEventListener('touchend', mu);
  }

  // ==================== 四角调整大小（鼠标+触屏） ====================
  function startResize(dir, e, cx, cy) {
    cx = cx || e.clientX;
    cy = cy || e.clientY;
    var rect = widgetEl.getBoundingClientRect();
    var sx = cx, sy = cy;
    var sw = widgetEl.offsetWidth, sh = widgetEl.offsetHeight;
    var sl = rect.left, st = rect.top;

    function mm(ev) {
      var dx = ev.clientX - sx, dy = ev.clientY - sy;
      var nw = sw, nh = sh, nl = sl, nt = st;
      if (dir.indexOf('e') >= 0) nw = Math.max(300, sw + dx);
      if (dir.indexOf('w') >= 0) { nw = Math.max(300, sw - dx); nl = sl + dx; }
      if (dir.indexOf('s') >= 0) nh = Math.max(350, sh + dy);
      if (dir.indexOf('n') >= 0) { nh = Math.max(350, sh - dy); nt = st + dy; }
      nl = Math.max(10, Math.min(nl, window.innerWidth - nw - 10));
      nt = Math.max(10, Math.min(nt, window.innerHeight - nh - 10));
      widgetEl.style.left = nl + 'px'; widgetEl.style.top = nt + 'px';
      widgetEl.style.width = nw + 'px'; widgetEl.style.height = nh + 'px';
    }
    function tm(ev) { ev.preventDefault(); mm({ clientX: ev.touches[0].clientX, clientY: ev.touches[0].clientY }); }
    function mu() {
      document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
      document.removeEventListener('touchmove', tm); document.removeEventListener('touchend', mu);
      saveGeom();
    }
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
    document.addEventListener('touchmove', tm, { passive: false }); document.addEventListener('touchend', mu);
  }

  // ==================== DOM 构建 ====================
  function createWidget() {
    widgetEl = document.createElement('div');
    widgetEl.id = 'blue-chat-widget';

    // 气泡
    bubbleEl = document.createElement('button');
    bubbleEl.id = 'blue-chat-bubble';
    bubbleEl.innerHTML = '<span class="blue-bubble-icon">🐱</span>';
    bubbleEl.title = '和 Blue 聊天';
    // 点击=开/关面板（dragMoved=true时是拖拽，不触发）
    bubbleEl.addEventListener('click', function(e) {
      if (dragMoved) { dragMoved = false; return; }
      togglePanel();
    });

    var badge = document.createElement('span');
    badge.id = 'blue-chat-badge';
    badge.className = 'blue-badge hidden';
    bubbleEl.appendChild(badge);

    // 面板
    panelEl = document.createElement('div');
    panelEl.id = 'blue-chat-panel';
    panelEl.className = 'blue-panel-closed';

    // ---- 头部（一行：菜单 | 头像+名称 | 模型选择 | 关闭） ----
    var header = document.createElement('div');
    header.className = 'blue-panel-header';
    header.innerHTML =
      '<button class="blue-header-menu" id="blueMenuBtn" title="对话记录">☰</button>' +
      '<div class="blue-header-left">' +
        '<span class="blue-header-avatar">🐱</span>' +
        '<div class="blue-header-info">' +
          '<div class="blue-header-name">Blue</div>' +
          '<div class="blue-header-status" id="blueModelStatus">通义千问 Turbo · 🆓免费</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">' +
        '<div style="position:relative;">' +
          '<button class="blue-model-trigger" id="blueModelTrigger">通义Turbo ▾</button>' +
          '<div class="blue-model-dropdown" id="blueModelDropdown">' +
            '<div class="blue-model-option" data-model="deepseek">DeepSeek<span class="blue-model-fee">💰付费</span></div>' +
            '<div class="blue-model-option blue-model-selected" data-model="qwen-turbo">通义Turbo<span class="blue-model-fee">🆓免费</span></div>' +
            '<div class="blue-model-option" data-model="qwen-plus">通义Plus<span class="blue-model-fee">🆓免费</span></div>' +
            '<div class="blue-model-option" data-model="qwen-max">通义Max<span class="blue-model-fee">🆓免费</span></div>' +
            '<div class="blue-model-option" data-model="ollama">本地Ollama<span class="blue-model-fee">🆓免费</span></div>' +
          '</div>' +
        '</div>' +
        '<button class="blue-header-close" id="blueChatClose" title="关闭">✕</button>' +
      '</div>';

    // ---- 底部操作栏（聊天 | 分析 | 新对话 三合一） ----
    var modeBar = document.createElement('div');
    modeBar.className = 'blue-mode-bar';
    modeBar.innerHTML =
      '<button class="blue-mode-btn blue-mode-active" data-mode="chat">💬 聊天</button>' +
      '<button class="blue-mode-btn" data-mode="analyze">📊 分析</button>' +
      '<button class="blue-mode-newchat" id="blueNewChatBtn">＋新对话</button>';

    modeBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.blue-mode-btn');
      if (btn) {
        chatMode = btn.dataset.mode;
        modeBar.querySelectorAll('.blue-mode-btn').forEach(function (b) {
          b.className = 'blue-mode-btn' + (b.dataset.mode === chatMode ? ' blue-mode-active' : '');
        });
        inputEl.placeholder = chatMode === 'analyze' ? '问工作台数据…' : '问 Blue 点什么…';
        return;
      }
      // 新对话按钮
      if (e.target.closest('#blueNewChatBtn')) {
        if (messages.length > 1) saveCurrentConv();
        newConversation();
      }
    });

    // ---- 对话侧栏 ----
    convSidebar = document.createElement('div');
    convSidebar.id = 'blue-conv-sidebar';
    convSidebar.className = 'blue-conv-closed';
    convSidebar.innerHTML = '<div class="blue-conv-header">对话记录<button class="blue-conv-close" id="blueConvClose">✕</button></div>';
    convListEl = document.createElement('div');
    convListEl.className = 'blue-conv-list';
    convSidebar.appendChild(convListEl);

    // ---- 消息列表 ----
    messagesEl = document.createElement('div');
    messagesEl.id = 'blue-chat-messages';
    messagesEl.className = 'blue-messages';

    // ---- 输入区 ----
    var inputArea = document.createElement('div');
    inputArea.className = 'blue-input-area';
    inputEl = document.createElement('textarea');
    inputEl.id = 'blue-chat-input';
    inputEl.className = 'blue-input';
    inputEl.placeholder = '问 Blue 点什么…';
    inputEl.rows = 1;
    inputEl.addEventListener('input', autoResizeInput);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    sendBtn = document.createElement('button');
    sendBtn.id = 'blue-chat-send';
    sendBtn.className = 'blue-send-btn';
    sendBtn.innerHTML = '➤';
    sendBtn.addEventListener('click', sendMessage);
    inputArea.appendChild(inputEl);
    inputArea.appendChild(sendBtn);

    // ---- 四角调整手柄 ----
    function addCorner(dir) {
      var h = document.createElement('div');
      h.className = 'blue-rz-handle blue-rz-' + dir;
      widgetEl.appendChild(h);
      h.addEventListener('mousedown', function(e) { startResize(dir, e); });
      h.addEventListener('touchstart', function(e) {
        startResize(dir, e, e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: false });
    }
    ['se','sw','ne','nw'].forEach(addCorner);

    // 组装
    panelEl.appendChild(convSidebar);
    panelEl.appendChild(header);
    panelEl.appendChild(messagesEl);
    panelEl.appendChild(modeBar);
    panelEl.appendChild(inputArea);

    widgetEl.appendChild(bubbleEl);
    widgetEl.appendChild(panelEl);
    document.body.appendChild(widgetEl);

    // ---- 设置 widget 尺寸 = panel 尺寸（不然 widget 只有气泡大小，拖拽边界会错） ----
    widgetEl.style.width = panelEl.offsetWidth + 'px';
    widgetEl.style.height = panelEl.offsetHeight + 'px';

    // ---- 监听 panel resize（包括 CSS resize 操作）同步到 widget ----
    // 但面板关闭时不更新（避免 widget 撑大阻挡页面点击）
    if (window.ResizeObserver) {
      new ResizeObserver(function() {
        if (!isOpen) return;  // 关闭状态下不更新尺寸
        widgetEl.style.width = panelEl.offsetWidth + 'px';
        widgetEl.style.height = panelEl.offsetHeight + 'px';
      }).observe(panelEl);
    }

    // ---- 移除四角自定义手柄（改用 CSS resize） ----
    document.querySelectorAll('.blue-rz-handle').forEach(function(h) { h.remove(); });

    // 恢复保存的几何
    if (!restoreGeom()) {
      // 默认右下角
      widgetEl.style.bottom = '24px';
      widgetEl.style.right = '24px';
    }

    // 保证初始状态 widget 只缩到气泡大小（不阻挡页面点击）
    isOpen = false;
    var bw = bubbleEl.offsetWidth || 56;
    var bh = bubbleEl.offsetHeight || 56;
    widgetEl.style.width = bw + 'px';
    widgetEl.style.height = bh + 'px';

    // ---- 拖拽头部 ----
    header.addEventListener('mousedown', function(e) { startDrag(e, e.clientX, e.clientY); });
    header.addEventListener('touchstart', function(e) {
      startDrag(e, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    // ---- 拖拽气泡 ----
    bubbleEl.addEventListener('mousedown', function(e) { startBubbleDrag(e, e.clientX, e.clientY); });
    bubbleEl.addEventListener('touchstart', function(e) {
      startBubbleDrag(e, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    // ---- 双击最大化 ----
    header.addEventListener('dblclick', function() {
      if (maxed) {
        if (prevGeom) {
          widgetEl.style.left = prevGeom.l + 'px'; widgetEl.style.top = prevGeom.t + 'px';
          widgetEl.style.width = prevGeom.w + 'px'; widgetEl.style.height = prevGeom.h + 'px';
        }
        maxed = false;
      } else {
        prevGeom = { l: widgetEl.offsetLeft, t: widgetEl.offsetTop, w: widgetEl.offsetWidth, h: widgetEl.offsetHeight };
        widgetEl.style.left = '20px'; widgetEl.style.top = '20px';
        widgetEl.style.width = (window.innerWidth - 40) + 'px';
        widgetEl.style.height = (window.innerHeight - 40) + 'px';
        maxed = true;
      }
      saveGeom();
    });

    // ---- 事件绑定 ----
    document.getElementById('blueChatClose').addEventListener('click', closePanel);
    document.getElementById('blueMenuBtn').addEventListener('click', function() {
      renderConvList(); toggleSidebar();
    });
    document.getElementById('blueConvClose').addEventListener('click', closeSidebar);

    // 模型下拉
    var trigger = document.getElementById('blueModelTrigger');
    var dd = document.getElementById('blueModelDropdown');
    var statusEl = document.getElementById('blueModelStatus');
    trigger.addEventListener('click', function (e) { e.stopPropagation(); dd.classList.toggle('blue-dropdown-open'); });
    dd.querySelectorAll('.blue-model-option').forEach(function (opt) {
      opt.addEventListener('click', function () {
        var model = this.dataset.model;
        if (!model) return;
        currentModel = model;
        dd.querySelectorAll('.blue-model-option').forEach(function (o) { o.classList.remove('blue-model-selected'); });
        this.classList.add('blue-model-selected');
        var label = this.childNodes[0].textContent.trim();
        var fee = this.querySelector('.blue-model-fee').textContent.trim();
        trigger.textContent = label + ' ▾';
        statusEl.textContent = label + ' · ' + fee;
        dd.classList.remove('blue-dropdown-open');
      });
    });
    document.addEventListener('click', function (e) {
      if (!dd.contains(e.target) && e.target !== trigger) dd.classList.remove('blue-dropdown-open');
    });

    // 初始化对话
    var convs = loadConvs();
    if (convs.length > 0) { switchConversation(convs[0].id); }
    else { newConversation(); }

    // 初始化产品搜索（放在 inputEl 已经建好之后）
    initProductSearch();
  }

  // ==================== 面板 ====================
  function togglePanel() { if (isOpen) closePanel(); else openPanel(); }
  function openPanel() {
    isOpen = true;
    panelEl.className = 'blue-panel-open';
    bubbleEl.style.display = 'none';
    if (!widgetEl.style.left || widgetEl.style.left === 'auto') {
      var r = widgetEl.getBoundingClientRect();
      widgetEl.style.left = r.left + 'px'; widgetEl.style.top = r.top + 'px';
      widgetEl.style.bottom = 'auto'; widgetEl.style.right = 'auto';
    }
    widgetEl.style.width = panelEl.offsetWidth + 'px';
    widgetEl.style.height = panelEl.offsetHeight + 'px';
    // 保证面板不超出视口右侧/底部
    var rect = widgetEl.getBoundingClientRect();
    var maxLeft = window.innerWidth - rect.width - 10;
    var maxTop = window.innerHeight - rect.height - 10;
    if (rect.left > maxLeft) widgetEl.style.left = Math.max(10, maxLeft) + 'px';
    if (rect.top > maxTop) widgetEl.style.top = Math.max(10, maxTop) + 'px';
    setTimeout(function() { inputEl.focus(); }, 300);
    scrollToBottom();
  }
  function closePanel() {
    isOpen = false;
    panelEl.className = 'blue-panel-closed';
    bubbleEl.style.display = '';
    // widget 缩成气泡大小（不再遮挡右侧内容）
    // 同时保持气泡在屏幕上的位置不变，向右上收缩
    var bw = bubbleEl.offsetWidth, bh = bubbleEl.offsetHeight;
    widgetEl.style.width = bw + 'px';
    widgetEl.style.height = bh + 'px';
    // 位置微调：把原来气泡右下角定位变成气泡左上角定位
    widgetEl.style.left = (parseFloat(widgetEl.style.left) || 0) + (panelEl.offsetWidth - bw) + 'px';
    widgetEl.style.top = (parseFloat(widgetEl.style.top) || 0) + (panelEl.offsetHeight - bh) + 'px';
    closeSidebar();
    if (isStreaming) abortStream();
    if (currentConvId && messages.length > 1) saveCurrentConv();
  }

  // ==================== 侧栏 ====================
  function toggleSidebar() { sidebarOpen ? closeSidebar() : openSidebar(); }
  function openSidebar() { sidebarOpen = true; convSidebar.className = 'blue-conv-open'; }
  function closeSidebar() { sidebarOpen = false; convSidebar.className = 'blue-conv-closed'; }

  function renderConvList() {
    var convs = loadConvs();
    convListEl.innerHTML = '';
    if (convs.length === 0) {
      convListEl.innerHTML = '<div class="blue-conv-empty">暂无对话记录</div>';
      return;
    }
    convs.sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    for (var i = 0; i < convs.length; i++) {
      var c = convs[i];
      var div = document.createElement('div');
      div.className = 'blue-conv-item' + (c.id === currentConvId ? ' blue-conv-active' : '');
      var date = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      div.innerHTML =
        '<div class="blue-conv-title">' + escapeHtml(c.title || '新对话') + '</div>' +
        '<div class="blue-conv-meta">' + date + ' · ' + (MODELS[c.model] ? MODELS[c.model].label : c.model) + '</div>';
      div.addEventListener('click', function(id) { return function() { switchConversation(id); }; }(c.id));
      div.addEventListener('contextmenu', function(id, e) { e.preventDefault(); deleteConversation(id, e); }.bind(null, c.id));
      convListEl.appendChild(div);
    }
  }

  // ==================== 消息 ====================
  function addWelcomeMessage() {
    var info = MODELS[currentModel] || { label: currentModel, fee: '' };

    // 时间感知问候
    var hr = new Date().getHours();
    var greet;
    if (hr < 6) greet = '夜深了';
    else if (hr < 9) greet = '早上好 🌅';
    else if (hr < 12) greet = '上午好 ☀️';
    else if (hr < 14) greet = '中午好 🌤️';
    else if (hr < 18) greet = '下午好 🌇';
    else if (hr < 21) greet = '傍晚好 🌆';
    else greet = '晚上好 🌙';

    var welcomeText = greet + '！我是 **Blue 🐱**，你的橙萤工作台 AI 搭档。\n\n' +
      '**我能帮你做什么：**\n' +
      '📊 **查数据** — "今天拼多多卖了多少？" "天猫的转化率怎么样？"\n' +
      '📈 **看趋势** — "这个月和上个月比怎么样？" "哪个平台增长最快？"\n' +
      '⚠️ **预警监控** — "有什么异常吗？" "发货有没有滞后？"\n' +
      '🔧 **自动化项目** — "自动化项目运行正常吗？" "看看最近的运行日志"\n' +
      '💡 **经营建议** — "推广费是不是太高了？" "有什么可以优化的？"\n\n' +
      '当前模型：**' + info.label + '** ' + info.fee +
      '\n\n直接打字问我，或者点下面的快捷问题试试 👇';

    messages.push({ role: 'assistant', content: welcomeText });
    var msgDiv = appendMessage(welcomeText, 'assistant');

    // 添加快捷提问按钮
    var suggestions = [
      '今天销售情况怎么样？',
      '拼多多和天猫哪个转化率高？',
      '最近有什么预警吗？',
      '自动化项目都正常吗？',
    ];
    var btnContainer = document.createElement('div');
    btnContainer.className = 'blue-suggestion-bar';
    btnContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding:0 12px;';
    suggestions.forEach(function(text) {
      var btn = document.createElement('button');
      btn.textContent = text;
      btn.className = 'blue-suggestion-btn';
      btn.style.cssText = 'background:#f0f4ff;border:1px solid #d0d7ff;border-radius:16px;padding:6px 14px;font-size:13px;color:#4a5db8;cursor:pointer;white-space:nowrap;transition:all .2s;';
      btn.onmouseenter = function() { this.style.background = '#e0e7ff'; };
      btn.onmouseleave = function() { this.style.background = '#f0f4ff'; };
      btn.onclick = function() {
        inputEl.value = text;
        inputEl.focus();
        sendMessage();
      };
      btnContainer.appendChild(btn);
    });
    if (msgDiv) msgDiv.after(btnContainer);
  }
  function clearMessages() { messagesEl.innerHTML = ''; }

  function appendMessage(text, role) {
    var div = document.createElement('div');
    div.className = 'blue-msg ' + (role === 'user' ? 'blue-msg-user' : 'blue-msg-assistant');
    var bubble = document.createElement('div');
    bubble.className = 'blue-msg-bubble';
    bubble.innerHTML = renderMessage(text);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function renderMessage(text) {
    if (!text) return '';
    var escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre><code class="blue-code">' + escapeHtml(code.trim()) + '</code></pre>';
    });
    escaped = escaped.replace(/`([^`]+)`/g, '<code class="blue-inline-code">$1</code>');
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    escaped = escaped.replace(/\n/g, '<br>');
    return escaped;
  }

  function updateLastMessage(text) {
    var lastMsg = messagesEl.querySelector('.blue-msg-assistant:last-child .blue-msg-bubble');
    if (lastMsg) { lastMsg.innerHTML = renderMessage(text); scrollToBottom(); }
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'blue-msg blue-msg-assistant blue-msg-typing';
    div.innerHTML = '<div class="blue-msg-bubble blue-typing-dots"><span></span><span></span><span></span></div>';
    div.id = 'blue-typing-indicator';
    messagesEl.appendChild(div); scrollToBottom();
  }
  function hideTyping() { var el = document.getElementById('blue-typing-indicator'); if (el) el.remove(); }
  function scrollToBottom() { requestAnimationFrame(function () { messagesEl.scrollTop = messagesEl.scrollHeight; }); }
  function escapeHtml(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ==================== 产品搜索自动完成 ====================
  var productList = [];
  var productSuggestionEl = null;
  var activeSuggestionIdx = -1;

  function loadProductList() {
    var base = (window.__EDITION === 'employee') ? RAILWAY_BASE : '';
    fetch(base + '/api/product-index')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        productList = data.products || [];
        console.log('[Blue] 已加载 ' + productList.length + ' 个产品供搜索');
      })
      .catch(function() { /* 静默失败，不影响正常聊天 */ });
  }

  function ensureSuggestionEl() {
    if (!productSuggestionEl) {
      productSuggestionEl = document.createElement('div');
      productSuggestionEl.id = 'blue-product-suggestions';
      productSuggestionEl.className = 'blue-suggestions';
      productSuggestionEl.style.cssText = 'position:absolute;bottom:100%;left:12px;right:12px;background:#fff;border:1px solid #e0e0e0;border-radius:8px;max-height:200px;overflow-y:auto;box-shadow:0 -4px 12px rgba(0,0,0,0.08);z-index:100;display:none;';
      inputArea.appendChild(productSuggestionEl);
    }
  }

  function showProductSuggestions(filter) {
    ensureSuggestionEl();
    if (!filter || filter.length < 1 || productList.length === 0) {
      productSuggestionEl.style.display = 'none';
      return;
    }
    var f = filter.toLowerCase();
    var matches = productList.filter(function(p) {
      return p.name.toLowerCase().indexOf(f) >= 0;
    }).slice(0, 8);
    if (matches.length === 0) {
      productSuggestionEl.style.display = 'none';
      return;
    }
    productSuggestionEl.innerHTML = '';
    activeSuggestionIdx = -1;
    matches.forEach(function(p, idx) {
      var item = document.createElement('div');
      item.className = 'blue-suggestion-item';
      item.dataset.index = idx;
      item.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;';
      item.innerHTML = '<span>' + p.name + '</span><span style="font-size:11px;color:#999;">' + (p.platforms || []).join('/') + '</span>';
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        insertProductName(p.name);
      });
      item.addEventListener('mouseenter', function() {
        document.querySelectorAll('.blue-suggestion-item').forEach(function(el) { el.style.background = ''; });
        this.style.background = '#f0f4ff';
        activeSuggestionIdx = parseInt(this.dataset.index);
      });
      productSuggestionEl.appendChild(item);
    });
    productSuggestionEl.style.display = 'block';
  }

  function hideProductSuggestions() {
    if (productSuggestionEl) productSuggestionEl.style.display = 'none';
    activeSuggestionIdx = -1;
  }

  function insertProductName(name) {
    var cursorPos = inputEl.selectionStart || inputEl.value.length;
    var val = inputEl.value;
    var atPos = val.lastIndexOf('@', cursorPos);
    if (atPos >= 0) {
      inputEl.value = val.substring(0, atPos) + '@' + name + ' ';
    } else {
      inputEl.value = '@' + name + ' ';
    }
    hideProductSuggestions();
    inputEl.focus();
    autoResizeInput();
  }

  function initProductSearch() {
    // 在 input 的 input 事件上叠加产品搜索
    inputEl.addEventListener('input', function() {
      var val = inputEl.value;
      var cursorPos = inputEl.selectionStart || 0;
      var textBeforeCursor = val.substring(0, cursorPos);
      var atIdx = textBeforeCursor.lastIndexOf('@');
      if (atIdx >= 0) {
        var afterAt = textBeforeCursor.substring(atIdx + 1);
        if (afterAt.indexOf(' ') < 0) {
          showProductSuggestions(afterAt);
        } else {
          hideProductSuggestions();
        }
      } else {
        hideProductSuggestions();
      }
    });

    // 在 keydown 上叠加上下键导航
    var origKeydown = inputEl._keydownHandler;
    if (origKeydown) {
      inputEl.removeEventListener('keydown', origKeydown);
    }
    inputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }
      if (!productSuggestionEl || productSuggestionEl.style.display === 'none') return;
      var items = productSuggestionEl.querySelectorAll('.blue-suggestion-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeSuggestionIdx = Math.min(activeSuggestionIdx + 1, items.length - 1);
        items.forEach(function(el, idx) { el.style.background = idx === activeSuggestionIdx ? '#f0f4ff' : ''; });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeSuggestionIdx = Math.max(activeSuggestionIdx - 1, -1);
        items.forEach(function(el, idx) { el.style.background = idx === activeSuggestionIdx ? '#f0f4ff' : ''; });
      } else if (e.key === 'Enter' && activeSuggestionIdx >= 0) {
        e.preventDefault();
        var sel = productSuggestionEl.querySelector('[data-index="' + activeSuggestionIdx + '"]');
        if (sel) insertProductName(sel.querySelector('span').textContent);
      }
    });

    // 点击页面关闭
    document.addEventListener('click', function(e) {
      if (productSuggestionEl && !productSuggestionEl.contains(e.target) && e.target !== inputEl) {
        hideProductSuggestions();
      }
    });

    // 更新 placeholder 提示产品搜索
    inputEl.placeholder = '问 Blue 点什么…（@搜产品）';
    loadProductList();
  }

  // ==================== 发送 ====================
  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isStreaming) return;
    // 关闭自动完成下拉
    hideProductSuggestions();
    inputEl.value = ''; autoResizeInput();
    messages.push({ role: 'user', content: text });
    appendMessage(text, 'user');
    showTyping();
    isStreaming = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;
    abortController = new AbortController();
    callChatAPI(messages, abortController.signal);
  }

  function abortStream() {
    if (abortController) { abortController.abort(); abortController = null; }
    hideTyping(); isStreaming = false; inputEl.disabled = false; sendBtn.disabled = false;
  }

  async function callChatAPI(msgs, signal) {
    var accumulated = '';

    // ===== Step 1: 发请求（带自动重试，最多 3 次） =====
    var response;
    for (var retry = 0; retry < 3; retry++) {
      if (retry > 0) {
        updateLastMessage('重试中... (' + (retry + 1) + '/3)');
        await new Promise(function(r) { setTimeout(r, 1500); });
      }
      try {
        var headers = { 'Content-Type': 'application/json' };
        try { var t = localStorage.getItem('cy_token'); if (t) headers['X-Session-Token'] = t; } catch (e) {}
        response = await fetch(API_BASE + '/api/chat', {
          method: 'POST',
          headers: headers,
          credentials: 'same-origin',  // 跨域时不带 cookie，避免与 Allow-Origin:* 冲突导致 Failed to fetch
          body: JSON.stringify({ messages: msgs, model: currentModel, mode: chatMode }),
          signal: signal,
        });
        if (response.ok) break; // ✅ 成功了，跳出重试
        // 服务器返回了错误状态码
        if (retry < 2) { updateLastMessage('服务器暂时不可用，正在重试... (' + (retry + 1) + '/3)'); continue; }
        throw new Error('服务器错误 (' + response.status + ')');
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (retry < 2) continue; // 网络错误也重试
        hideTyping();
        var msg = err.message || '请求失败';
        // 诊断：输出详细错误信息（API_BASE + 完整 URL）到控制台和界面
        var detailUrl = API_BASE + '/api/chat';
        console.error('[Blue Chat] 连接失败:', msg, '| URL:', detailUrl, '| API_BASE:', JSON.stringify(API_BASE), '| origin:', location.origin);
        if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
          msg = '无法连接到服务器 (' + detailUrl + ')。原因: ' + msg + ' | 请按 Ctrl+Shift+R 硬刷新后重试';
        }
        appendMessage('❌ ' + msg, 'assistant');
        accumulated = '';
        return;
      }
    }

    // ===== Step 2: 读取 AI 流式响应 =====
    try {
      hideTyping();
      appendMessage('', 'assistant');
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      while (true) {
        var result = await reader.read();
        if (result.done) break;
        var chunk = decoder.decode(result.value, { stream: true });
        buffer += chunk;
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.startsWith('data: ')) {
            var dataStr = line.slice(6);
            if (dataStr === '[DONE]') break;
            try {
              var data = JSON.parse(dataStr);
              if (data.error) { accumulated = '❌ ' + data.error; updateLastMessage(accumulated); continue; }
              var content = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
              if (content) { accumulated += content; updateLastMessage(accumulated); }
            } catch (e) {}
          }
        }
      }
    } catch (err) {
      hideTyping();
      if (err.name === 'AbortError') return;
      accumulated = '❌ 响应读取失败: ' + (err.message || '');
      appendMessage(accumulated, 'assistant');
    }

    // ===== Step 3: 保存对话 =====
    if (accumulated) {
      var last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') messages.push({ role: 'assistant', content: accumulated });
      else last.content = accumulated;
      saveCurrentConv();
      renderConvList();
    }
    isStreaming = false;
    inputEl.disabled = false;
    sendBtn.disabled = false;
    if (isOpen) inputEl.focus();
  }

  function autoResizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  // ==================== 初始化 ====================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createWidget);
  } else {
    createWidget();
  }
})();
