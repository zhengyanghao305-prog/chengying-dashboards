/* ============================================================
 * diagnosis.js — 橙萤工作台 · 全板块通用诊断引擎 v2
 * 「一眼看异常 · 子节点全分析 · 可执行方案」
 *
 * 能力：
 *   1. 板块诊断：调用 diagnostics-config.js 的 analyze()，输出
 *      - findings（分级发现 + 可执行 action + 涉及子节点 nodes）
 *      - dimensions（维度透视：平台/ROI分层/状态/产品…）
 *      - subNodes（异常子节点明细：具体实体 TopN）
 *   2. AI 深度诊断：复用 /api/chat(mode=analyze)
 *   3. 决策辅助：每条发现可「采纳/暂缓/忽略」
 * ============================================================ */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nowStr() {
    var d = new Date();
    function p(x) { return String(x).padStart(2, '0'); }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var SEV_ORDER = { danger: 0, warning: 1, info: 2, ok: 3 };
  var SEV_META = {
    danger:  { label: '紧急', icon: '🔴', color: '#dc2626', bg: '#fef2f2' },
    warning: { label: '重要', icon: '🟠', color: '#ea580c', bg: '#fff7ed' },
    info:    { label: '关注', icon: '🟡', color: '#b45309', bg: '#fefce8' },
    ok:      { label: '正常', icon: '🟢', color: '#16a34a', bg: '#f0fdf4' }
  };
  function sevScore(sev) { return { danger: 30, warning: 60, info: 80, ok: 100 }[sev] != null ? { danger: 30, warning: 60, info: 80, ok: 100 }[sev] : 100; }
  function scoreColor(s) { return s >= 90 ? '#16a34a' : s >= 60 ? '#d97706' : '#dc2626'; }

  function calcScore(summary) {
    if (summary && summary.empty) return 0;
    var s = 100 - (summary.danger || 0) * 15 - (summary.warning || 0) * 8 - (summary.info || 0) * 3;
    return Math.max(0, Math.min(100, s));
  }
  function ratingOf(score) {
    if (score >= 90) return { grade: 'A · 健康', color: '#16a34a', desc: '整体健康，保持现状' };
    if (score >= 75) return { grade: 'B · 良好', color: '#0891b2', desc: '基本健康，有少量优化点' };
    if (score >= 60) return { grade: 'C · 合格', color: '#d97706', desc: '有需要关注的问题，建议尽快处理' };
    return { grade: 'D · 欠佳', color: '#dc2626', desc: '存在重要问题，建议优先处理' };
  }

  function scoreRing(score) {
    var R = 52, C = 2 * Math.PI * R;
    var pct = Math.max(0, Math.min(100, score));
    var dash = C * pct / 100;
    var color = scoreColor(score);
    return '<svg viewBox="0 0 120 120" width="128" height="128" style="display:block;">' +
      '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="#eef2f7" stroke-width="11"/>' +
      '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="11" stroke-linecap="round"' +
      ' stroke-dasharray="' + dash.toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 60 60)"/>' +
      '<text x="60" y="58" text-anchor="middle" font-size="34" font-weight="800" fill="' + color + '" font-family="inherit">' + score + '</text>' +
      '<text x="60" y="78" text-anchor="middle" font-size="11" fill="#94a3b8" font-family="inherit">健康分</text>' +
      '</svg>';
  }

  // ---------- 运行诊断 ----------
  function run(boardId, rows) {
    var cfg = (window.DIAGNOSTICS && window.DIAGNOSTICS[boardId]) || null;
    var findings = [], dimensions = [], subNodes = [];
    if (cfg && typeof cfg.analyze === 'function') {
      try {
        var res = cfg.analyze(rows || [], { todayStr: nowStr() });
        findings = res.findings || [];
        dimensions = res.dimensions || [];
        subNodes = res.subNodes || [];
      } catch (e) { console.warn('[Diagnosis] analyze 失败', boardId, e); findings = [{ severity: 'info', title: '诊断异常', detail: String(e && e.message || e), action: '' }]; }
    } else {
      findings = [{ severity: 'info', title: '暂无规则', detail: '该板块暂未配置诊断规则。', action: '' }];
    }
    findings.sort(function (a, b) { return (SEV_ORDER[a.severity] != null ? SEV_ORDER[a.severity] : 9) - (SEV_ORDER[b.severity] != null ? SEV_ORDER[b.severity] : 9); });
    var summary = { danger: 0, warning: 0, info: 0, ok: 0, empty: !(rows && rows.length) };
    findings.forEach(function (f) { if (summary[f.severity] != null) summary[f.severity]++; });
    summary.score = calcScore(summary);
    return { boardId: boardId, ts: new Date().toISOString(), rowCount: rows ? rows.length : 0, summary: summary, findings: findings, dimensions: dimensions, subNodes: subNodes };
  }

  // ---------- 决策记录 ----------
  var DECISIONS_KEY = 'wb:decisions';
  function loadDecisions() { try { return JSON.parse(localStorage.getItem(DECISIONS_KEY)) || []; } catch (e) { return []; } }
  function saveDecisions(list) { try { localStorage.setItem(DECISIONS_KEY, JSON.stringify(list)); } catch (e) {} }
  function decisionState(ruleId) {
    var list = loadDecisions();
    var hit = list.filter(function (d) { return d.ruleId === ruleId; });
    return hit.length ? hit[hit.length - 1].decision : null;
  }
  function persistDecision(rec) {
    try {
      var H = { 'Content-Type': 'application/json', 'X-API-Key': 'chengying2026' };
      fetch('/api/files/decision-log', { method: 'GET', headers: H })
        .then(function (r) { return r.json(); })
        .then(function (existing) {
          if (!Array.isArray(existing)) existing = [];
          existing = existing.filter(function (d) { return d.ruleId !== rec.ruleId; });
          existing.push(rec);
          return fetch('/api/files/decision-log', { method: 'POST', headers: H, body: JSON.stringify(existing) });
        })
        .catch(function () {});
    } catch (e) {}
  }
  function decide(ruleId, boardId, title, severity, decision) {
    var rec = { ruleId: ruleId, board: boardId, title: title, severity: severity, decision: decision, ts: new Date().toISOString() };
    var list = loadDecisions();
    list = list.filter(function (d) { return d.ruleId !== ruleId; });
    list.push(rec);
    saveDecisions(list);
    persistDecision(rec);
    return rec;
  }

  function summarizeRows(rows, maxRows) {
    maxRows = maxRows || 40;
    if (!rows || !rows.length) return '（空）';
    var arr = rows.slice();
    var KEY_FIELDS = ['date','platform','channel','product','plat','name','sales','orders','visitors','aov','cvr',
      'promotion_cost','roi','blended_roi','cost','total_gmv','profit_rate','mom','level','ship_status','status',
      'stage','planDue','actualDue','employee','owner','target','rate','doh','goods_name','link_id','t','r','c','g','n'];
    var s = JSON.stringify(arr.slice(0, maxRows).map(function (r) {
      var o = {}; KEY_FIELDS.forEach(function (k) { if (r[k] !== undefined && r[k] !== null && r[k] !== '') o[k] = r[k]; }); return o;
    }));
    return s.length > 7000 ? s.slice(0, 7000) + '…' : s;
  }

  function aiAnalyze(opts, onChunk, onDone, onError) {
    var boardId = opts.boardId, cfg = opts.cfg, rows = opts.rows;
    var msgs = [{ role: 'user', content: '【板块诊断请求】请针对工作台「' + (cfg ? cfg.title : boardId) + '」板块做一次经营诊断。以下是我从该板块导出的数据（JSON，已截取）：\n' + summarizeRows(rows, 40) + '\n\n请输出：\n1. 总体结论（一句话判断该板块当前健康与否）\n2. 发现的问题（每个问题给出严重程度 + 具体数据证据）\n3. 给老板的建议（按优先级，每条建议一句话，附行动对象）\n4. 需要我关注的决策点（若有）\n要求：只基于上面数据，不得编造数字；若数据不足请明说。' }];
    var API_BASE = (window.__EDITION === 'employee') ? 'https://sync-server-production-bdec.up.railway.app' : '';
    fetch(API_BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ messages: msgs, model: 'qwen-turbo', mode: 'analyze' }) })
      .then(function (resp) {
        if (!resp.ok) throw new Error('服务器返回 ' + resp.status);
        var reader = resp.body.getReader(); var decoder = new TextDecoder(); var buf = '', acc = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { onDone(acc); return; }
            buf += decoder.decode(res.value, { stream: true });
            var lines = buf.split('\n'); buf = lines.pop() || '';
            lines.forEach(function (line) {
              line = line.trim();
              if (line.indexOf('data: ') === 0) {
                var dataStr = line.slice(6);
                if (dataStr === '[DONE]') return;
                try { var data = JSON.parse(dataStr); var c = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content; if (c) { acc += c; onChunk(c); } } catch (e) {}
              }
            });
            return pump();
          });
        }
        return pump();
      }).catch(function (e) { onError(e); });
  }

  // ---------- 维度透视渲染 ----------
  function dimsHtml(dimensions) {
    if (!dimensions || !dimensions.length) return '';
    var html = dimensions.map(function (dim) {
      var segs = dim.segments || [];
      var max = segs.reduce(function (m, s) { return Math.max(m, s.count); }, 1);
      var rows = segs.map(function (s) {
        var color = s.danger ? '#dc2626' : '#6366f1';
        var w = max ? Math.max(4, Math.round(s.count / max * 100)) : 4;
        return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
          '<span style="width:96px;font-size:11.5px;color:#475569;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(s.label) + '">' + esc(s.label) + '</span>' +
          '<div style="flex:1;height:16px;background:#f1f5f9;border-radius:4px;overflow:hidden;">' +
            '<div style="height:100%;width:' + w + '%;background:' + color + ';border-radius:4px;"></div>' +
          '</div>' +
          '<span style="width:54px;text-align:right;font-size:12px;font-weight:800;color:' + color + ';flex-shrink:0;">' + s.count + '</span>' +
          (s.sub ? '<span style="width:88px;font-size:10.5px;color:#94a3b8;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(s.sub) + '">' + esc(s.sub) + '</span>' : '<span style="width:88px;flex-shrink:0;"></span>') +
          '</div>';
      }).join('');
      return '<div style="margin-bottom:14px;">' +
        '<div style="font-size:12px;font-weight:800;color:#334155;margin-bottom:8px;">📐 ' + esc(dim.name) + (dim.note ? ' <span style="font-weight:500;color:#94a3b8;font-size:10.5px;">· ' + esc(dim.note) + '</span>' : '') + '</div>' +
        rows + '</div>';
    }).join('');
    return '<div style="margin-top:18px;">' +
      '<div style="font-size:13px;font-weight:800;color:#334155;margin-bottom:12px;">📊 维度透视<span style="font-weight:500;color:#94a3b8;font-size:11px;margin-left:6px;">（一眼看出问题集中在哪）</span></div>' +
      html + '</div>';
  }

  // ---------- 子节点异常明细渲染 ----------
  function subNodesHtml(subNodes) {
    if (!subNodes || !subNodes.length) return '';
    var rows = subNodes.slice(0, 14).map(function (n) {
      var m = SEV_META[n.severity] || SEV_META.info;
      return '<div style="display:flex;align-items:center;gap:10px;padding:7px 12px;background:#fff;border:1px solid #eef2f7;border-left:4px solid ' + m.color + ';border-radius:9px;margin-bottom:6px;">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:' + m.color + ';flex-shrink:0;"></span>' +
        '<span style="flex:1;min-width:0;font-size:12.5px;font-weight:700;color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(n.label) + '">' + esc(n.label) + '</span>' +
        '<span style="font-size:12px;color:#475569;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px;" title="' + esc(n.detail) + '">' + esc(n.detail) + '</span>' +
        (n.metric ? '<span style="font-size:13px;font-weight:800;color:' + m.color + ';flex-shrink:0;">' + esc(n.metric) + '</span>' : '') +
        '</div>';
    }).join('');
    return '<div style="margin-top:18px;">' +
      '<div style="font-size:13px;font-weight:800;color:#334155;margin-bottom:10px;">🔻 异常子节点明细<span style="font-weight:500;color:#94a3b8;font-size:11px;margin-left:6px;">（最严重 Top' + Math.min(14, subNodes.length) + '，按严重程度/花费）</span></div>' +
      rows + '</div>';
  }

  function findingCard(f, i) {
    var m = SEV_META[f.severity] || SEV_META.info;
    var state = decisionState(f.ruleId || ('f' + i));
    var p = { danger: ['P0 · 紧急', '#dc2626'], warning: ['P1 · 重要', '#ea580c'], info: ['P2 · 关注', '#b45309'] }[f.severity] || ['P3 · 参考', '#64748b'];
    var stateHtml = state
      ? '<span style="font-size:11px;font-weight:700;color:' + ({ adopt: '#16a34a', defer: '#b45309', ignore: '#64748b' }[state] || '#64748b') + ';">已' + ({ adopt: '采纳', defer: '暂缓', ignore: '忽略' }[state] || state) + '</span>'
      : '';
    var nodesHtml = (f.nodes && f.nodes.length)
      ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;">' +
        f.nodes.slice(0, 8).map(function (n) {
          return '<span style="font-size:11px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;padding:2px 9px;border-radius:8px;"><b>' + esc(n.name) + '</b>' + (n.sub ? ' <span style="color:#94a3b8;">· ' + esc(n.sub) + '</span>' : '') + '</span>';
        }).join('') + (f.nodes.length > 8 ? '<span style="font-size:11px;color:#94a3b8;align-self:center;">+' + (f.nodes.length - 8) + ' 个</span>' : '') + '</div>'
      : '';
    var actionHtml = f.action
      ? '<div style="margin-top:8px;padding:9px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:9px;font-size:12.5px;color:#14532d;line-height:1.7;"><span style="font-weight:800;">✅ 执行方案：</span>' + esc(f.action) + '</div>'
      : '';
    return '<div data-fidx="' + i + '" style="background:#fff;border:1px solid #e2e8f0;border-left:5px solid ' + m.color + ';border-radius:12px;margin-bottom:10px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.05);">' +
      '<div style="padding:14px 16px;">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span style="font-size:11px;font-weight:800;color:#fff;background:' + p[1] + ';padding:3px 9px;border-radius:8px;flex-shrink:0;">' + p[0] + '</span>' +
          '<span style="font-size:15px;font-weight:800;color:' + m.color + ';">' + esc(f.title) + '</span>' +
          (f.metric ? '<span style="font-size:17px;font-weight:800;color:' + m.color + ';margin-left:auto;flex-shrink:0;">' + esc(f.metric) + '</span>' : '') +
          stateHtml +
        '</div>' +
        '<div style="font-size:12.5px;color:#475569;margin-top:6px;line-height:1.7;">' + esc(f.detail) + '</div>' +
        nodesHtml +
        actionHtml +
        '<div style="display:flex;gap:6px;margin-top:10px;">' +
          '<button data-dec="adopt" style="border:1px solid #bbf7d0;background:#f0fdf4;color:#15803d;font-size:12px;font-weight:700;padding:5px 14px;border-radius:8px;cursor:pointer;">✅ 采纳</button>' +
          '<button data-dec="defer" style="border:1px solid #fde68a;background:#fffbeb;color:#b45309;font-size:12px;font-weight:700;padding:5px 14px;border-radius:8px;cursor:pointer;">⏸ 暂缓</button>' +
          '<button data-dec="ignore" style="border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;font-size:12px;font-weight:700;padding:5px 14px;border-radius:8px;cursor:pointer;">忽略</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderDecisionLog(container) {
    var list = loadDecisions().slice(-8).reverse();
    if (!list.length) return;
    var html = '<div style="font-size:13px;font-weight:800;color:#334155;margin-bottom:8px;">📋 您最近的决策</div>';
    html += '<div style="font-size:12px;color:#475569;line-height:1.9;">';
    list.forEach(function (d) {
      var icon = { adopt: '✅', defer: '⏸', ignore: '🚫' }[d.decision] || '•';
      var label = { adopt: '采纳', defer: '暂缓', ignore: '忽略' }[d.decision] || d.decision;
      var color = { adopt: '#15803d', defer: '#b45309', ignore: '#6b7280' }[d.decision] || '#6b7280';
      html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
        '<span>' + icon + '</span><span style="font-weight:600;color:' + color + ';">[' + label + ']</span>' +
        '<span style="flex:1;min-width:120px;">' + esc(d.title) + '</span>' +
        '<span style="font-size:11px;color:#94a3b8;">' + esc(d.board) + ' · ' + new Date(d.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</span></div>';
    });
    html += '</div>';
    container.innerHTML = html;
  }

  // ---------- 面板 ----------
  function open(opts) {
    var boardId = opts.boardId, cfg = opts.cfg, rows = opts.rows || [];
    var title = (cfg && cfg.title) || boardId;
    var old = document.getElementById('diagPanel');
    if (old) old.parentNode && old.parentNode.removeChild(old);

    var result = run(boardId, rows);
    window.__DIAG_RESULT = Object.assign({}, result, { cfg: cfg, rows: rows });
    var score = result.summary.score;
    var rating = ratingOf(score);
    var nDanger = result.summary.danger, nWarn = result.summary.warning, nInfo = result.summary.info;
    var probCount = nDanger + nWarn + nInfo;

    var findingsHtml = result.findings.length
      ? result.findings.map(function (f, i) { return findingCard(f, i); }).join('')
      : '<div style="padding:28px;text-align:center;color:#16a34a;font-size:14px;font-weight:700;background:#f0fdf4;border:1px dashed #bbf7d0;border-radius:12px;">✅ 所有检查项正常，本板块无需优化</div>';

    var panel = document.createElement('div');
    panel.id = 'diagPanel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.5);display:flex;align-items:flex-start;justify-content:center;padding:3vh 16px;overflow:auto;backdrop-filter:blur(4px);';
    panel.addEventListener('click', function (e) { if (e.target === panel) close(); });

    panel.innerHTML =
      '<div style="width:100%;max-width:920px;background:#fff;border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.3);overflow:hidden;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 22px;background:linear-gradient(135deg,#f8fafc,#eef2ff);border-bottom:1px solid #e2e8f0;">' +
          '<div style="display:flex;align-items:center;gap:11px;min-width:0;">' +
            '<span style="font-size:20px;">' + (cfg && cfg.icon || '🩺') + '</span>' +
            '<div style="min-width:0;"><div style="font-size:16px;font-weight:800;color:#0f172a;">' + esc(title) + ' · 健康体检</div>' +
            '<div style="font-size:11px;color:#64748b;margin-top:1px;">' + nowStr() + ' · 基于 ' + result.rowCount + ' 条数据</div></div>' +
          '</div>' +
          '<button id="diagCloseBtn" style="border:none;background:#f1f5f9;border-radius:50%;width:34px;height:34px;font-size:16px;cursor:pointer;color:#475569;flex-shrink:0;">✕</button>' +
        '</div>' +
        '<div style="padding:22px;max-height:calc(92vh - 120px);overflow:auto;">' +
          '<div style="display:flex;gap:26px;align-items:center;background:linear-gradient(135deg,#f8fafc,#f0f9ff);border:1px solid #e2e8f0;border-radius:16px;padding:20px 26px;">' +
            '<div style="flex-shrink:0;">' + scoreRing(score) + '</div>' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:23px;font-weight:800;color:' + rating.color + ';">' + rating.grade + '</div>' +
              '<div style="font-size:13px;color:#475569;margin-top:4px;">' + rating.desc + '</div>' +
              '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">' +
                '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:12px;background:#fef2f2;color:#dc2626;font-size:12px;font-weight:800;">🔴 紧急 ' + nDanger + '</span>' +
                '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:12px;background:#fff7ed;color:#ea580c;font-size:12px;font-weight:800;">🟠 重要 ' + nWarn + '</span>' +
                '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:12px;background:#fefce8;color:#b45309;font-size:12px;font-weight:800;">🟡 关注 ' + nInfo + '</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          dimsHtml(result.dimensions) +
          '<div style="margin-top:18px;">' +
            '<div style="font-size:13px;font-weight:800;color:#334155;margin-bottom:10px;display:flex;align-items:center;gap:7px;">🛠 需要优化的问题' +
              (probCount ? '<span style="background:#fee2e2;color:#dc2626;font-size:11px;font-weight:800;padding:2px 9px;border-radius:10px;">' + probCount + '</span>' : '') +
              '<span style="font-weight:500;color:#94a3b8;font-size:11px;">（P0 紧急 → P2 关注 · 含执行方案）</span>' +
            '</div>' +
            '<div id="diagFindings">' + findingsHtml + '</div>' +
          '</div>' +
          subNodesHtml(result.subNodes) +
          '<div id="diagDecisionLog" style="margin-top:16px;"></div>' +
          '<div style="margin-top:16px;border-top:1px dashed #e2e8f0;padding-top:14px;">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">' +
              '<div style="font-size:13px;font-weight:800;color:#334155;">🧠 AI 深度诊断</div>' +
              '<button id="diagAiBtn" style="border:none;background:#4f46e5;color:#fff;font-size:13px;font-weight:600;padding:8px 16px;border-radius:10px;cursor:pointer;">✨ 生成深度分析</button>' +
            '</div>' +
            '<div id="diagAiStatus" style="display:none;margin-top:10px;font-size:12px;color:#94a3b8;">⏳ 正在分析板块数据，请稍候…</div>' +
            '<div id="diagAiOut" style="display:none;margin-top:10px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:13px;line-height:1.8;color:#1f2937;white-space:pre-wrap;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(panel);
    document.getElementById('diagCloseBtn').addEventListener('click', close);

    var aiBtn = document.getElementById('diagAiBtn');
    var aiStatus = document.getElementById('diagAiStatus');
    var aiOut = document.getElementById('diagAiOut');
    var aiBusy = false;
    aiBtn.addEventListener('click', function () {
      if (aiBusy) return; aiBusy = true; aiBtn.disabled = true; aiBtn.style.opacity = '.6';
      aiStatus.style.display = 'block'; aiOut.style.display = 'block'; aiOut.textContent = '';
      var full = '';
      aiAnalyze({ boardId: boardId, cfg: cfg, rows: rows },
        function (chunk) { full += chunk; aiOut.textContent = full; },
        function () { aiBusy = false; aiBtn.disabled = false; aiBtn.style.opacity = '1'; aiStatus.style.display = 'none'; },
        function (e) {
          aiBusy = false; aiBtn.disabled = false; aiBtn.style.opacity = '1'; aiStatus.style.display = 'none';
          aiOut.innerHTML = '<span style="color:#b91c1c;">⚠️ AI 诊断暂不可用</span>（' + esc((e && e.message) || e) + '）。当前仅展示规则诊断，本功能在本地版完整可用。';
        });
    });
    renderDecisionLog(document.getElementById('diagDecisionLog'));
    return panel;
  }

  function close() { var p = document.getElementById('diagPanel'); if (p) { p.parentNode && p.parentNode.removeChild(p); } }

  function attachFloat(opts) {
    try {
      if (document.getElementById('diagFloatBtn')) return;
      var btn = document.createElement('button');
      btn.id = 'diagFloatBtn';
      var pos = opts.position || { right: '18px', bottom: '96px' };
      btn.style.cssText = 'position:fixed;' + 'right:' + pos.right + ';bottom:' + pos.bottom +
        ';z-index:2147482990;border:none;background:#4f46e5;color:#fff;font-size:13px;font-weight:700;' +
        'padding:10px 16px;border-radius:24px;cursor:pointer;box-shadow:0 6px 20px rgba(79,70,229,.35);' +
        'display:flex;align-items:center;gap:6px;font-family:inherit;';
      btn.innerHTML = (opts.icon || '🔍') + '<span>' + (opts.label || '诊断') + '</span>';
      btn.addEventListener('click', function () {
        var rows = [];
        try { rows = (opts.getRows && opts.getRows()) || []; } catch (e) {}
        window.DIAG.open({ boardId: opts.boardId, cfg: { title: opts.title || opts.boardId, icon: opts.icon || '🔍' }, rows: rows });
      });
      document.body.appendChild(btn);
    } catch (e) { console.warn('[Diagnosis] 浮动按钮失败', e); }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-dec]') : null;
    if (!btn) return;
    var card = btn.closest('[data-fidx]');
    if (!card) return;
    var idx = parseInt(card.getAttribute('data-fidx'), 10);
    var cache = window.__DIAG_RESULT;
    if (!cache) return;
    var f = cache.findings[idx];
    if (!f) return;
    decide(f.ruleId || ('f' + idx), f.board || cache.boardId, f.title, f.severity, btn.getAttribute('data-dec'));
    open({ boardId: cache.boardId, cfg: cache.cfg, rows: cache.rows });
  });

  window.DIAG = {
    run: run, open: open, close: close, decide: decide,
    summarizeRows: summarizeRows, attachFloat: attachFloat,
    _setCache: function (c) { window.__DIAG_RESULT = c; }
  };
})();
