/* ============================================================
 * freshness-alert.js — 板块页「数据未更新」顶部告警 v3
 *
 * 规则：昨天是底线。tol=0 表示「最新日期 < 昨天」才告警；
 *      tol=N 表示在昨天基础上再额外容忍 N 天（多用于周更/低频板块）。
 *      数据最新时间早于阈值 → 在页面顶部插入醒目告警条，明确告知滞后。
 *      优先用 inline 数据（品类页 __TREND_DATA），避免 fetch + CORS。
 *
 * 用法：在板块页面 <body> 内引入
 *      <script src="js/freshness-alert.js"></script>
 * 板块识别：URL ?id=xxx → 文件名 → 去掉 -analysis 后缀。
 * ============================================================ */
(function () {
  'use strict';

  // 板块 → 数据源；inline=window全局名(品类页用 __TREND_DATA)，tol=在「昨天」基础上额外容忍的天数
  var MAP = {
    'daily-pulse':          { file: 'data/daily-pulse.json',             tol: 0 },   // 日更：昨天正常
    'sales-alert':          { file: 'data/sales-alert.json',             tol: 0 },   // 日更
    'ad-roi':               { file: 'data/ad-roi.json',                  tol: 0 },   // 日更
    'product-pipeline':     { file: 'data/product-pipeline.json',        tol: 6 },   // 周更
    'ecom-workflow':        { file: 'data/ecom-workflow.json',           tol: 6 },   // 周更/按需
    'automation-log':       { file: 'data/automation-log.json',          tol: 0 },   // 日更
    'automation-projects':  { file: 'data/automation-projects.json',     tol: 0 },   // 日更
    'emp-task':             { file: 'data/emp-task.json',                tol: 0 },   // 日更
    'emp-daily':            { file: 'data/emp-daily.json',               tol: 0 },   // 日更
    'emp-performance':      { file: 'data/emp-performance.json',         tol: 0 },   // 日更
    'dept-members':         { file: 'data/dept-members.json',            tol: 0 },   // 日更/按需
    'product-links':        { file: 'data/product-links.json',           tol: 0 },   // 日更
    'inventory-alert':      { file: 'data/inventory-alert.json',         tol: 2 },   // 低频，容忍 2 天
    'inventory-warning':    { file: 'data/inventory-warning.json',       tol: 0 },   // 日更
    'competition-analysis': { file: 'data/competition.json',             tol: 2 },   // 低频，与 home-health.js 一致
    'category-analysis':    { file: 'data/trend-analysis.json',  inline: '__TREND_DATA', tol: 0, scanDates: true },   // 日更
    'trend-analysis':       { file: 'data/trend-analysis.json',  inline: '__TREND_DATA', tol: 0, scanDates: true },   // 日更
    'platform-trend':       { file: 'data/platform-trend.json',          tol: 0 }    // 日更
  };

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function isoTime(d) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function detectId() {
    var m = location.search.match(/[?&]id=([^&#]+)/);
    if (m) {
      var id = decodeURIComponent(m[1]);
      if (MAP[id]) return id;
    }
    var f = (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '');
    if (MAP[f]) return f;
    if (MAP[f.replace(/-analysis$/, '')]) return f.replace(/-analysis$/, '');
    return null;
  }

  function parseTs(s) {
    if (!s) return null;
    var t = String(s).trim().replace(' ', 'T');
    var d = new Date(t);
    if (!isNaN(d.getTime())) return d;
    d = new Date(String(s).slice(0, 10) + 'T00:00:00');
    if (!isNaN(d.getTime())) return d;
    return null;
  }

  // 从数据中提取最新时间点
  function latestInfo(data) {
    if (!data) return null;
    var bestD = null, bestS = '';
    if (!Array.isArray(data) && typeof data === 'object') {
      var u = data.updated || data.generated || data.end_date || data.ts;
      if (u) {
        var d1 = parseTs(u);
        if (d1) { bestD = d1; bestS = String(u); }
      }
    }
    var arr = Array.isArray(data) ? data
            : (data.products || data.items || data.links || data.rows || data.records || null);
    if (Array.isArray(arr)) {
      for (var i = 0; i < arr.length; i++) {
        var r = arr[i];
        if (r && r.date) {
          var rd = parseTs(r.date);
          if (rd && (!bestD || rd > bestD)) { bestD = rd; bestS = String(r.date); }
        }
      }
    }
    if (!bestD) return null;
    var sameDay = (bestD.getHours() === 0 && bestD.getMinutes() === 0 && bestD.getSeconds() === 0);
    return {
      date: iso(bestD),
      ts: bestD.getTime(),
      raw: bestS,
      hasTime: !sameDay,
      timeStr: sameDay ? '' : isoTime(bestD)
    };
  }

  // 品类页/趋势分析专用：从 data.categories 与 data.platforms[*].items[*].dates 扫出数据实际覆盖的最新日期
  function scanTrendDatesMax(data) {
    if (!data || typeof data !== 'object') return null;
    var maxIso = '';
    function upd(d) { if (typeof d === 'string' && d.length >= 10 && d > maxIso) maxIso = d.slice(0, 10); }
    (data.categories || []).forEach(function (c) { (c.dates || []).forEach(upd); });
    var plats = data.platforms || {};
    Object.keys(plats).forEach(function (k) {
      var sec = plats[k]; if (!sec) return;
      (sec.items || []).forEach(function (it) { (it.dates || []).forEach(upd); });
    });
    if (!maxIso) return null;
    var d = new Date(maxIso + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }

  function formatGap(gapMs) {
    if (gapMs < 0) gapMs = 0;
    if (gapMs < 60 * 60000) return Math.round(gapMs / 60000) + ' 分钟';
    var hours = Math.floor(gapMs / 3600000);
    if (hours < 24) return hours + ' 小时';
    var days = Math.floor(hours / 24);
    var remH = hours % 24;
    return remH ? days + ' 天 ' + remH + ' 小时' : days + ' 天';
  }

  function show(info, exp, severity, gapText) {
    if (document.getElementById('freshnessAlertBar')) return;
    var bar = document.createElement('div');
    bar.id = 'freshnessAlertBar';
    bar.setAttribute('role', 'alert');

    var s;
    if (severity === 'danger') {
      s = { color: '#991b1b', bg1: '#fff1f2', bg2: '#fef2f2', border: '#f87171', icon: '🔴', label: '数据未更新：缺少昨天的数据' };
    } else if (severity === 'warning') {
      s = { color: '#9a3412', bg1: '#fff7ed', bg2: '#fefce8', border: '#fb923c', icon: '🟠', label: '数据已滞后' };
    } else {
      s = { color: '#92400e', bg1: '#fefce8', bg2: '#fef9c3', border: '#facc15', icon: '🟡', label: '数据轻微滞后' };
    }

    var timeStr = info.hasTime ? ' ' + info.timeStr : '';

    // 当最新日期早于预期日期（如昨天）时，明确提示缺少哪一天
    var missingText = '';
    if (info.date < exp) {
      missingText = '，<b>缺少 ' + exp + '（昨天）的数据</b>';
    }

    bar.style.cssText = 'position:relative;z-index:9999;margin:0;padding:12px 18px;' +
      'background:linear-gradient(135deg,' + s.bg1 + ',' + s.bg2 + ');' +
      'border-bottom:2px solid ' + s.border + ';' +
      'color:' + s.color + ';font-size:13px;font-weight:700;line-height:1.6;' +
      'display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-family:inherit;';
    bar.innerHTML =
      '<span style="font-size:16px;flex-shrink:0;">' + s.icon + '</span>' +
      '<div style="flex:1;min-width:260px;">' +
        '<b>' + s.label + '</b>：本板块最新数据仅到 <b>' + info.date + '</b>' + timeStr +
        '（应至少到 ' + exp + '）' + missingText + '，已滞后 <b>' + gapText + '</b>。' +
        '<div style="margin-top:3px;font-weight:600;opacity:0.85;font-size:12px;">' +
          '页面展示的是旧数据，分析结论可能失真，请留意。' +
        '</div>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function process(data) {
    if (!data) return;
    var id = detectId();
    var cfg = MAP[id] || {};
    var info;
    // 品类/趋势页：忽略 data.updated（生成时间），改扫 categories 与 platforms.items[*].dates 的实际数据最新日期
    if (cfg.scanDates) {
      var dMax = scanTrendDatesMax(data);
      if (dMax) {
        info = { date: iso(dMax), ts: dMax.getTime(), raw: iso(dMax), hasTime: false, timeStr: '' };
      }
    }
    if (!info) info = latestInfo(data);
    if (!info) return;

    var now = Date.now();
    var gapMs = now - info.ts;
    if (gapMs <= 0) return;  // 数据在未来(异常)或刚好最新，不提示

    // 阈值：昨天是底线；tol 为额外容忍天数
    var today0 = new Date(); today0.setHours(0, 0, 0, 0);
    var yesterday = new Date(today0); yesterday.setDate(yesterday.getDate() - 1);
    var cfg = MAP[detectId()] || {};
    var tol = (cfg.tol != null) ? cfg.tol : 0;
    var limitMs = yesterday.getTime() - tol * 86400000;
    if (info.ts >= limitMs) return;

    var gapText = formatGap(gapMs);

    // 严重度：缺少昨天数据 → danger；否则按滞后时长
    var severity;
    if (info.date < iso(yesterday)) severity = 'danger';
    else if (gapMs >= 48 * 3600000) severity = 'danger';
    else if (gapMs >= 24 * 3600000) severity = 'warning';
    else severity = 'info';

    show(info, iso(yesterday), severity, gapText);
  }

  function run() {
    var id = detectId();
    if (!id) return;
    var cfg = MAP[id];

    // 优先用内内联数据（品类页用 __TREND_DATA；避免 fetch + CORS）
    if (cfg.inline && window[cfg.inline]) {
      try { process(window[cfg.inline]); } catch (e) { /* 内联解析异常静默 */ }
      return;
    }

    fetch(cfg.file + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(process)
      .catch(function () { /* 读取失败静默 */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
