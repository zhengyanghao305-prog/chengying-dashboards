/* ============================================================
 * home-health.js — 工作台首页「经营健康总览」v2
 * 顶部「异常速览」：一眼看全最紧急的异常（命名实体+指标，可跳转）
 * 下方：板块健康度网格 + 全部待优化问题
 * ============================================================ */
(function () {
  'use strict';

  var BOARDS = [
    { id: 'daily-pulse',        icon: '📊', href: 'board.html?id=daily-pulse',          name: '店铺日报' },
    { id: 'sales-alert',        icon: '📈', href: 'board.html?id=sales-alert',          name: 'BI销售预警' },
    { id: 'ad-roi',             icon: '💰', href: 'ad-roi-analysis.html',               name: '推广ROI' },
    { id: 'product-links',      icon: '🔗', href: 'product-links.html',                 name: '产品链接' },
    { id: 'product-pipeline',   icon: '🆕', href: 'board.html?id=product-pipeline',     name: '新品追踪' },
    { id: 'ecom-workflow',      icon: '🔄', href: 'board.html?id=ecom-workflow',        name: '电商工作流' },
    { id: 'competition-analysis',icon: '⚔️', href: 'competition-analysis.html',         name: '竞品分析' },
    { id: 'category-analysis',  icon: '🗂', href: 'category-analysis.html',              name: '品类分析' },
    { id: 'automation-log',     icon: '📝', href: 'board.html?id=automation-log',       name: '自动化日志' },
    { id: 'automation-projects',icon: '🤖', href: 'board.html?id=automation-projects',  name: '自动化项目' },
    { id: 'data-sync',          icon: '🔗', href: 'connectors.html',                    name: '数据同步', skipDiag: true },  // 暂不参与诊断
    { id: 'emp-task',           icon: '✅', href: 'board.html?id=emp-task',             name: '员工任务' },
    { id: 'dept-members',       icon: '🏢', href: 'board.html?id=dept-members',         name: '部门成员' }
  ];
  var DATA_FILES = {
    'daily-pulse': 'data/daily-pulse.json',
    'sales-alert': 'data/sales-alert.json',
    'ad-roi': 'data/ad-roi.json',
    'product-links': 'data/product-links.json',
    'product-pipeline': 'data/product-pipeline.json',
    'ecom-workflow': null,         // ⚠️ 未接数据源（电商工作流尚未接入飞书 Base，回本周期测算器独立可用）
    'competition-analysis': 'data/competition.json',
    'category-analysis': 'data/category-analysis.json',
    'automation-log': 'data/automation-log.json',
    'automation-projects': 'data/automation-projects.json',
    'data-sync': 'data/connector_status.json',
    'emp-task': null,              // ⚠️ 未接数据源（员工任务由员工版写入，领导版只读；员工版未启用故空）
    'dept-members': 'data/dept-members.json'
  };
  var EMP_FILES = { 'emp-task': 'data/emp-task.json', 'emp-daily': 'data/emp-daily.json', 'emp-performance': 'data/emp-performance.json', 'dept-members': 'data/dept-members.json' };

  /* ============================================================
   * 数据新鲜度检查
   * 规则：今天应至少能看到「昨天」的数据（如 31 号应看到 30 号数据）。
   *       板块最新日期 < 昨天 → 判定为「数据未更新」，在页面顶部报错提示。
   * 日期来源（自动识别）：
   *   - 对象型数据：updated / generated / end_date 字段（取前 10 位）
   *   - 数组型数据：元素 date 字段的最大值
   *   - data-sync：connector_status 各源的 last_sync 时间戳
   * 取不到日期的板块（如部门成员）不参与新鲜度检查，不误报。
   * ============================================================ */
  var FRESH_TOL = { 'competition-analysis': 2 };  // 个别板块额外容忍天数（竞品数据更新较晚）
  var RAW_CACHE = {};                              // 各板块原始数据（用于提取 updated 等元信息）

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmtTime() {
    var d = new Date(); function p(x) { return String(x).padStart(2, '0'); }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 跨板块去重：同一主题只保留最权威板块，其余合并进详情（避免重复卡片）
  var DEDUP_TOPIC_PRIORITY = {
    'ad_loss': ['ad-roi'],
    'ad_waste': ['ad-roi'],
    'link_loweff': ['product-links'],
    'sales_drop': ['sales-alert'],
    'ship_lag': ['sales-alert'],
    'daily_issue': ['daily-pulse'],
    'category_decline': ['category-analysis'],
    'comp_weak': ['competition-analysis'],
    'sync_error': ['data-sync'],
    'sync_stale': ['data-sync'],
    'pipeline_overdue': ['product-pipeline']
  };
  function dedupFindings(list) {
    var groups = {}, out = [];
    (list || []).forEach(function (x) {
      var t = x.finding && x.finding.topic;
      if (!t) { out.push(x); return; }
      (groups[t] = groups[t] || []).push(x);
    });
    Object.keys(groups).forEach(function (t) {
      var arr = groups[t];
      if (arr.length < 2) { out.push(arr[0]); return; }
      var prio = DEDUP_TOPIC_PRIORITY[t] || [];
      var primary = null;
      arr.forEach(function (y) { if (prio.indexOf(y.board.id) >= 0 && !primary) primary = y; });
      if (!primary) primary = arr[0];
      var others = arr.filter(function (y) { return y !== primary; });
      var extra = others.map(function (y) {
        return y.board.name + '：「' + y.finding.title + '」' + (y.finding.metric ? '(' + y.finding.metric + ')' : '');
      }).join('；');
      if (extra) {
        primary.finding.detail = (primary.finding.detail || '') + '　[已合并 ' + others.length + ' 处重复：' + extra + ']';
      }
      out.push(primary);
    });
    out.sort(function (a, b) { return sevOrder(a.finding.severity) - sevOrder(b.finding.severity); });
    return out;
  }

  async function loadData(id) {
    var url = DATA_FILES[id];
    if (!url) return null;
    try {
      var resp = await fetch(url + '?t=' + Date.now());
      if (!resp.ok) return null;
      var data = await resp.json();
      RAW_CACHE[id] = data;   // 存原始数据，供新鲜度检查提取 updated 等字段
      if (id === 'data-sync') {
        var arr = [];
        Object.keys(data || {}).forEach(function (k) {
          if (k === '_meta') return;
          var s = data[k] || {};
          var lastSync = '';
          if (s.last_sync) { var d = new Date(s.last_sync * 1000); lastSync = d.toLocaleString('zh-CN'); }
          arr.push({ source: s.label || k, lastSync: lastSync || '—', records: (s.sales || 0) + (s.inventory || 0), state: s.state || (s.last_error ? 'error' : 'idle'), note: s.last_error || '' });
        });
        return arr;
      }
      if (id === 'product-links') {
        // 关键修正：分析全量链接（1674），而非只有 hot(20)
        return Array.isArray(data && data.links) ? data.links : [];
      }
      if (id === 'ad-roi') {
        if (Array.isArray(data)) { data.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); }); return data.slice(0, 6000); }
        return [];
      }
      if (id === 'competition-analysis') return data; // 对象，analyze 内部处理
      if (id === 'category-analysis') {
        // category-analysis.json 为 { updated, items } 包装，诊断引擎只需要 items 数组
        return Array.isArray(data) ? data : (Array.isArray(data && data.items) ? data.items : []);
      }
      return Array.isArray(data) ? data : [];
    } catch (e) { return null; }
  }

  /* ---- 提取板块最新数据日期；取不到返回 null（表示该板块不适用新鲜度检查）---- */
  function getLatestDate(id, rows) {
    var raw = RAW_CACHE[id], d = '';
    // 1) 对象型数据：updated / generated / end_date
    if (raw && !Array.isArray(raw) && typeof raw === 'object') {
      var u = raw.updated || raw.generated || raw.end_date;
      if (typeof u === 'string' && u.length >= 10) d = u.slice(0, 10);
    }
    // 2) 数组型数据：元素 date 字段的最大值（优先用原始数组，避免被裁剪）
    var arr = Array.isArray(raw) ? raw : (Array.isArray(rows) ? rows : null);
    if (arr) {
      for (var i = 0; i < arr.length; i++) {
        var r = arr[i];
        if (r && r.date) { var v = String(r.date).slice(0, 10); if (v > d) d = v; }
      }
    }
    // 3) data-sync：connector_status 各数据源的 last_sync 时间戳
    if (id === 'data-sync' && raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) {
        if (k === '_meta') return;
        var s = raw[k] || {};
        if (s.last_sync) {
          var dt = new Date(s.last_sync * 1000);
          var iso = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
          if (iso > d) d = iso;
        }
      });
    }
    return d || null;
  }

  function isoOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  /* ---- 判定新鲜度：返回 { latest, expected, gap, stale, na } ---- */
  function checkFreshness(id, rows) {
    var latest = getLatestDate(id, rows);
    if (!latest) return { na: true };
    var ld = new Date(latest + 'T00:00:00');
    if (isNaN(ld.getTime())) return { na: true };
    var tol = FRESH_TOL[id] || 0;
    var today0 = new Date(); today0.setHours(0, 0, 0, 0);
    var exp = new Date(today0); exp.setDate(exp.getDate() - 1);          // 期望：昨天
    var limit = new Date(exp); limit.setDate(limit.getDate() - tol);     // 含额外容忍
    return {
      na: false, latest: latest, expected: isoOf(exp),
      gap: Math.round((today0.getTime() - ld.getTime()) / 86400000),
      stale: ld.getTime() < limit.getTime()
    };
  }

  function scoreColor(s) { return s >= 90 ? '#16a34a' : s >= 75 ? '#0891b2' : s >= 60 ? '#d97706' : '#dc2626'; }
  function scoreRingSmall(score, size) {
    size = size || 54; var R = size / 2 - 5, C = 2 * Math.PI * R;
    var dash = C * Math.max(0, Math.min(100, score)) / 100; var color = scoreColor(score);
    var cx = size / 2, cy = size / 2;
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" style="display:block;">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="#eef2f7" stroke-width="' + (size / 9) + '"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="' + (size / 9) + '" stroke-linecap="round" stroke-dasharray="' + dash.toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/></svg>' +
      '<text x="' + cx + '" y="' + (cy + size / 8) + '" text-anchor="middle" font-size="' + (size / 3.2) + '" font-weight="800" fill="' + color + '" font-family="inherit">' + score + '</text>';
  }
  function sevOrder(s) { return { danger: 0, warning: 1, info: 2, ok: 3 }[s] != null ? { danger: 0, warning: 1, info: 2, ok: 3 }[s] : 9; }

  function init(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    if (typeof window.DIAG === 'undefined' || typeof window.DIAGNOSTICS === 'undefined') {
      container.innerHTML = '<div style="padding:16px;color:#94a3b8;font-size:13px;">诊断引擎未加载</div>'; return;
    }
    container.innerHTML =
      '<div id="homeHealthBox" style="border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.05);">' +
        '<div id="homeHealthHeader" title="点击展开 / 收起" style="padding:13px 22px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:linear-gradient(135deg,#f8fafc,#eef2ff);border-bottom:1px solid #e2e8f0;cursor:pointer;user-select:none;">' +
          '<div style="display:flex;align-items:center;gap:9px;min-width:0;">' +
            '<span style="font-size:19px;">🩺</span>' +
            '<div style="min-width:0;">' +
              '<div style="font-size:15px;font-weight:800;color:#0f172a;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                '经营健康总览<span id="homeHealthBrief" style="font-size:11px;font-weight:700;color:#64748b;"></span>' +
              '</div>' +
              '<div id="homeHealthSub" style="font-size:11px;color:#64748b;margin-top:1px;">一眼看全工作台需要优化的问题 · 刷新于 ' + fmtTime() + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:9px;flex-shrink:0;">' +
            '<button id="homeHealthRefresh" style="border:1px solid #c7d2fe;background:#eef2ff;color:#4f46e5;font-size:12px;font-weight:700;padding:7px 14px;border-radius:9px;cursor:pointer;">🔄 刷新体检</button>' +
            '<span id="homeHealthChev" style="font-size:11.5px;color:#4f46e5;font-weight:800;white-space:nowrap;background:#fff;border:1px solid #c7d2fe;padding:5px 10px;border-radius:8px;">收起 ▲</span>' +
          '</div>' +
        '</div>' +
        '<div id="homeHealthBody" style="padding:18px 22px;">' +
          '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:28px 0;">⏳ 正在体检各板块数据…</div>' +
        '</div>' +
      '</div>';

    var collapsed = localStorage.getItem('homeHealthCollapsed') === '1';
    var headerEl = document.getElementById('homeHealthHeader');
    var bodyEl = document.getElementById('homeHealthBody');
    var chevEl = document.getElementById('homeHealthChev');
    function applyCollapse() {
      bodyEl.style.display = collapsed ? 'none' : 'block';
      headerEl.style.borderBottom = collapsed ? 'none' : '1px solid #e2e8f0';
      chevEl.textContent = collapsed ? '展开 ▼' : '收起 ▲';
    }
    headerEl.onclick = function () {
      collapsed = !collapsed;
      localStorage.setItem('homeHealthCollapsed', collapsed ? '1' : '0');
      applyCollapse();
    };
    document.getElementById('homeHealthRefresh').onclick = function (e) {
      e.stopPropagation();
      if (collapsed) { collapsed = false; localStorage.setItem('homeHealthCollapsed', '0'); applyCollapse(); }
      runAndRender(container);
    };
    applyCollapse();
    runAndRender(container);
  }

  async function runAndRender(container) {
    var body = document.getElementById('homeHealthBody');
    body.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:28px 0;">⏳ 正在体检各板块数据…</div>';

    var results = await Promise.all(BOARDS.map(async function (b) {
      var rows = await loadData(b.id);
      // skipDiag 板块（如数据同步）暂不参与诊断，不产生异常
      var diag = (!b.skipDiag && (rows && (rows.length || typeof rows === 'object'))) ? window.DIAG.run(b.id, rows) : null;
      return { board: b, rows: rows, diag: diag };
    }));

    var valid = results.filter(function (r) { return r.diag; });
    var scored = valid.filter(function (r) { return r.rows && (Array.isArray(r.rows) ? r.rows.length : true); });
    var overall = scored.length ? Math.round(scored.reduce(function (s, r) { return s + r.diag.summary.score; }, 0) / scored.length) : 0;

    // 收集所有异常发现（跨板块），用于「异常速览」
    var allFindings = [];
    results.forEach(function (r) {
      if (r.diag && r.diag.findings) {
        r.diag.findings.forEach(function (f) {
          if (f.severity === 'danger' || f.severity === 'warning')
            allFindings.push({ board: r.board, finding: f });
        });
      }
    });
    // ── 数据新鲜度检查：数据未更新的板块 → danger 级异常（顶部「异常速览」可见）──
    results.forEach(function (r) { r.fresh = checkFreshness(r.board.id, r.rows); });
    results.forEach(function (r) {
      if (r.board.skipDiag) return;   // 暂不参与诊断的板块不报任何异常
      var f = r.fresh;
      if (f && f.stale) {
        allFindings.push({
          board: r.board,
          finding: {
            severity: 'danger',
            metric: '滞后 ' + f.gap + ' 天',
            title: '数据未更新：最新仅到 ' + f.latest,
            detail: '该板块数据应至少更新到 ' + f.expected + '（今天应能看到昨天的数据），但当前最新日期为 ' + f.latest + '，已滞后 ' + f.gap + ' 天。页面展示的很可能是旧数据，请注意甄别。',
            action: '检查飞书 Base 对应数据表是否录入了最新数据；若已录入，手动补跑 sync_board_data.py 重新同步'
          }
        });
      }
    });

    allFindings.sort(function (a, b) { return sevOrder(a.finding.severity) - sevOrder(b.finding.severity); });

    // ── 跨板块去重：同一问题主题只保留最权威板块，其余合并进详情（避免重复卡片）──
    allFindings = dedupFindings(allFindings);

    var nDanger = allFindings.filter(function (x) { return x.finding.severity === 'danger'; }).length;
    var nWarn = allFindings.filter(function (x) { return x.finding.severity === 'warning'; }).length;

    var rating = overall >= 90 ? ['A · 健康', '#16a34a'] : overall >= 75 ? ['B · 良好', '#0891b2'] : overall >= 60 ? ['C · 合格', '#d97706'] : ['D · 欠佳', '#dc2626'];

    // 生成带深度链接的 href
    function makeHref(b, f) {
      if (f && f.deepLink && typeof DeepLink !== 'undefined') return DeepLink.add(b.href, f.deepLink);
      return b.href;
    }

    // ── 异常速览 banner ──
    // 每个有异常的板块至少保留 1 张卡（新增板块显示了，也不会把其他板块的卡片挤出前 10）
    var byBoard = {};
    allFindings.forEach(function (x) { (byBoard[x.board.id] = byBoard[x.board.id] || []).push(x); });
    var topAnoms = [];
    Object.keys(byBoard).forEach(function (bid) {
      byBoard[bid].sort(function (a, b) { return sevOrder(a.finding.severity) - sevOrder(b.finding.severity); });
      topAnoms.push(byBoard[bid][0]);   // 每板块首条（最严重）
    });
    topAnoms.sort(function (a, b) { return sevOrder(a.finding.severity) - sevOrder(b.finding.severity); });
    // 还有空位则按严重度补入其余条目（同一板块最多补到其全部条数）
    var taken = {}; topAnoms.forEach(function (x) { taken[x.board.id] = (taken[x.board.id] || 0) + 1; });
    allFindings.forEach(function (x) {
      if (topAnoms.length >= 10) return;
      if ((taken[x.board.id] || 0) >= byBoard[x.board.id].length) return;
      topAnoms.push(x); taken[x.board.id] = (taken[x.board.id] || 0) + 1;
    });
    topAnoms.sort(function (a, b) { return sevOrder(a.finding.severity) - sevOrder(b.finding.severity); });
    var anomalyHtml;
    if (!topAnoms.length) {
      anomalyHtml = '<div style="padding:22px;text-align:center;color:#16a34a;font-size:14px;font-weight:700;background:#f0fdf4;border:1px dashed #bbf7d0;border-radius:12px;">✅ 各板块运行正常，暂无需要优化的问题</div>';
    } else {
      var cards = topAnoms.map(function (x, i) {
        var f = x.finding, b = x.board;
        var p = { danger: ['🔴', '#dc2626', '#fef2f2'], warning: ['🟠', '#ea580c', '#fff7ed'] }[f.severity] || ['🟡', '#b45309', '#fefce8'];
        return '<a href="' + makeHref(b, f) + '" style="text-decoration:none;display:block;background:' + p[2] + ';border:1px solid ' + p[1] + '22;border-radius:12px;padding:11px 13px;transition:transform .12s;" onmouseover="this.style.transform=\'translateY(-2px)\'" onmouseout="this.style.transform=\'\'">' +
          '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
            '<span style="font-size:13px;">' + p[0] + '</span>' +
            '<span style="font-size:10.5px;font-weight:800;color:#64748b;background:#fff;padding:2px 7px;border-radius:6px;">' + b.icon + ' ' + b.name + '</span>' +
            (f.metric ? '<span style="font-size:14px;font-weight:800;color:' + p[1] + ';margin-left:auto;">' + esc(f.metric) + '</span>' : '') +
          '</div>' +
          '<div style="font-size:12.5px;font-weight:700;color:#0f172a;margin-top:5px;line-height:1.45;">' + esc(f.title) + '</div>' +
          (f.detail ? '<div style="font-size:11px;color:#475569;margin-top:3px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(f.detail) + '</div>' : '') +
        '</a>';
      }).join('');
      var headLine = (nDanger + nWarn) + ' 个异常待处理' +
        (topAnoms[0] ? ' · 最紧急：' + topAnoms[0].board.name + '「' + topAnoms[0].finding.title + '」' : '');
      anomalyHtml =
        '<div style="background:linear-gradient(135deg,#fff5f5,#fff7ed);border:1px solid #fecaca;border-radius:16px;padding:16px 18px;">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
            '<span style="font-size:14px;font-weight:800;color:#b91c1c;">⚠️ 异常速览</span>' +
            '<span style="font-size:12px;color:#7f1d1d;background:#fee2e2;padding:3px 10px;border-radius:10px;font-weight:700;">🔴 ' + nDanger + ' 紧急</span>' +
            '<span style="font-size:12px;color:#9a3412;background:#ffedd5;padding:3px 10px;border-radius:10px;font-weight:700;">🟠 ' + nWarn + ' 重要</span>' +
            '<span style="font-size:12px;color:#475569;margin-left:auto;">' + headLine + '</span>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">' + cards + '</div>' +
          '<div style="font-size:11px;color:#94a3b8;margin-top:10px;">点击任意卡片直达对应板块处理 · 完整问题清单见下方</div>' +
        '</div>';
    }

    // 板块健康度网格
    var gridHtml = results.map(function (r) {
      var score = r.diag ? r.diag.summary.score : 0;
      var n = r.diag ? (r.diag.summary.danger + r.diag.summary.warning + r.diag.summary.info) : 0;
      var hasData = r.rows && (Array.isArray(r.rows) ? r.rows.length : true);
      var noSource = !DATA_FILES[r.board.id];  // 没数据文件 / 没接入同步
      var scoreView, statusText, cardStyle;
      var stale = r.fresh && r.fresh.stale;      // 数据未更新（最新日期落后于昨天）
      if (r.board.skipDiag || !r.diag) {
        // 暂不参与诊断的板块：中性展示，不报异常
        scoreView = '<div style="font-size:10px;color:#94a3b8;text-align:center;line-height:' + (54 / 2) + 'px;width:54px;">暂不检测</div>';
        statusText = '待优化';
        cardStyle = 'background:#f8fafc;border:1px solid #e2e8f0;';
        return '<a href="' + r.board.href + '" style="text-decoration:none;color:inherit;display:flex;flex-direction:column;align-items:center;gap:8px;' + cardStyle + 'border-radius:14px;padding:14px 10px;box-shadow:0 1px 3px rgba(0,0,0,.04);">' +
          scoreView +
          '<div style="font-size:12.5px;font-weight:700;color:#334155;">' + r.board.icon + ' ' + r.board.name + '</div>' +
          '<div style="font-size:11px;font-weight:800;color:#94a3b8;">暂不检测</div>' +
          '</a>';
      }
      if (hasData) {
        scoreView = scoreRingSmall(score);
        statusText = n ? (n + ' 个问题') : '正常';
        if (stale) statusText = '⚠ 数据滞后' + r.fresh.gap + '天';
      } else if (noSource) {
        scoreView = '<div style="font-size:10px;color:#9ca3af;text-align:center;line-height:' + (54 / 3) + 'px;width:54px;">待接通</div>';
        statusText = '暂无数据源';
      } else {
        scoreView = '<div style="font-size:11px;color:#94a3b8;text-align:center;line-height:' + (54 / 2) + 'px;width:54px;">暂空</div>';
        statusText = '暂无数据';
      }
      cardStyle = stale
        ? 'background:#fff5f5;border:1px solid #fca5a5;'
        : 'background:#f8fafc;border:1px solid #e2e8f0;';
      var staleTip = stale ? ('数据未更新：最新仅到 ' + r.fresh.latest + '（应至少到 ' + r.fresh.expected + '）') : '';
      return '<a href="' + r.board.href + '" title="' + esc(staleTip) + '" style="text-decoration:none;color:inherit;display:flex;flex-direction:column;align-items:center;gap:8px;' + cardStyle + 'border-radius:14px;padding:14px 10px;transition:transform .15s,box-shadow .15s;box-shadow:0 1px 3px rgba(0,0,0,.04);" onmouseover="this.style.transform=\'translateY(-2px)\';this.style.boxShadow=\'0 6px 18px rgba(0,0,0,.08)\'" onmouseout="this.style.transform=\'\';this.style.boxShadow=\'\'">' +
        scoreView +
        '<div style="font-size:12.5px;font-weight:700;color:#334155;">' + r.board.icon + ' ' + r.board.name + '</div>' +
        '<div style="font-size:11px;font-weight:800;color:' + (stale ? '#dc2626' : (n ? (r.diag.summary.danger ? '#dc2626' : '#ea580c') : '#16a34a')) + ';">' + statusText + '</div>' +
        '</a>';
    }).join('');

    body.innerHTML =
      anomalyHtml +
      '<div style="margin-top:18px;display:flex;gap:22px;align-items:center;background:linear-gradient(135deg,#f8fafc,#f0f9ff);border:1px solid #e2e8f0;border-radius:16px;padding:18px 24px;">' +
        scoreRingSmall(overall, 78) +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
            '<span style="font-size:22px;font-weight:800;color:' + rating[1] + ';">' + rating[0] + '</span>' +
            '<span style="font-size:12px;color:#64748b;">' + scored.length + ' 个板块已体检 · 平均分 ' + overall + '</span>' +
          '</div>' +
          '<div style="font-size:13px;color:#475569;margin-top:5px;">' +
            (allFindings.length ? '当前共有 <b style="color:#dc2626;">' + allFindings.length + '</b> 个问题需优化（🔴' + nDanger + ' 紧急 / 🟠' + nWarn + ' 重要）' : '当前各板块均健康，继续保持') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:16px;">' +
        '<div style="font-size:13px;font-weight:800;color:#334155;margin-bottom:10px;">🗂 各板块健康度</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:10px;">' + gridHtml + '</div>' +
      '</div>';

    // 折叠态下头部仍显示关键结论
    var briefEl = document.getElementById('homeHealthBrief');
    if (briefEl) {
      briefEl.innerHTML = '<span style="color:' + rating[1] + ';">' + overall + ' 分 ' + rating[0] + '</span>' +
        (allFindings.length
          ? ' · <span style="color:#dc2626;">🔴 ' + nDanger + ' 紧急</span> · <span style="color:#ea580c;">🟠 ' + nWarn + ' 重要</span>'
          : ' · <span style="color:#16a34a;">✅ 无异常</span>');
    }
    var subEl = document.getElementById('homeHealthSub');
    if (subEl) subEl.textContent = '一眼看全工作台需要优化的问题 · 刷新于 ' + fmtTime();
  }

  window.HomeHealth = { init: init };
})();
