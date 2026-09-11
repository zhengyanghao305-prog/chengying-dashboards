/* === store.js === */
/* ============================================================
 * store.js — 工作台存储引擎（v3 — 支持 Electron IPC + 同步）
 *
 * 数据优先级：
 *   1. Electron 环境 → 直接读写 data/*.json 文件（主进程 IPC）
 *   2. 浏览器环境 → localStorage（用户手动增删改）
 *   3. 预置数据 → data/<board-id>.json（自动化脚本每天写入）
 *
 * 多端同步：通过 window.electronAPI 桥接，主进程负责与云端同步
 * ============================================================ */

/* fetchJSONOnce — 单次 JSON 拉取（带 AbortController 超时） */
async function fetchJSONOnce(url, timeout) {
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var tid = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeout) : null;
  try {
    var resp = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (tid) clearTimeout(tid);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } catch (e) {
    if (tid) clearTimeout(tid);
    throw e;
  }
}

/* fetchJSON — 带超时(AbortController)与重试的 JSON 拉取；optional:true 时失败返回 null 不抛。
 * 主路径多次失败后自动尝试本机 3588 兜底（file:// 或跨源受限环境相对路径 fetch 会被浏览器拦截） */
async function fetchJSON(url, opts) {
  opts = opts || {};
  var timeout = opts.timeout || 12000;
  var retries = (opts.retries == null) ? (opts.optional ? 1 : 2) : opts.retries;
  var lastErr = null;
  for (var attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJSONOnce(url, timeout);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) { await new Promise(function (r) { setTimeout(r, 400 * (attempt + 1)); }); continue; }
    }
  }
  // 兜底：本机 3588（跨源允许 `*`，file:// / 受限环境可用）
  if (opts.localFallback !== false && url.indexOf('http') !== 0) {
    var alt = 'http://localhost:3588/' + url.replace(/^\.?\//, '');
    try {
      return await fetchJSON(alt, { localFallback: false, timeout: timeout, retries: 0, optional: opts.optional });
    } catch (e) { lastErr = e; }
  }
  if (opts.optional) return null;
  throw lastErr || new Error('fetchJSON failed: ' + url);
}

const Store = {
  KEY: function (id) { return 'wb:data:' + id; },

  // 浏览器模式内存兜底：localStorage 配额存不下的大数据板（如 ad-roi）先保留在内存
  _mem: {},

  // ---- 是否在 Electron 环境中运行 ----
  isElectron: function () {
    return typeof window !== 'undefined' && window.electronAPI && window.electronAPI.getBoardData;
  },

  // ---- 基础 CRUD ----

  get: function (id) {
    // Electron 模式：从主进程读取文件
    if (Store.isElectron()) {
      try {
        return window.electronAPI.getBoardData(id);
      } catch (e) {
        console.error('[Store] Electron 读取失败', id, e);
        return [];
      }
    }

    // 浏览器模式：优先读内存兜底（大数据板可能未写 localStorage）
    if (Store._mem[id] !== undefined) {
      return Store._mem[id];
    }
    try {
      const raw = localStorage.getItem(Store.KEY(id));
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('[Store] 读取失败', id, e);
      return [];
    }
  },

  set: function (id, rows) {
    // Electron 模式：写入文件
    if (Store.isElectron()) {
      try {
        return window.electronAPI.setBoardData(id, rows);
      } catch (e) {
        console.error('[Store] Electron 写入失败', id, e);
        return false;
      }
    }

    // 浏览器模式：内存中始终保留；localStorage 仅保存中小数据（避免 ad-roi 2万条超配额）
    Store._mem[id] = rows;
    try {
      const raw = JSON.stringify(rows);
      if (raw.length > 2 * 1024 * 1024) {
        console.warn('[Store] 数据过大（' + (raw.length / 1024 / 1024).toFixed(2) + 'MB），仅保留在内存:', id, rows.length + ' 条');
        return true;
      }
      localStorage.setItem(Store.KEY(id), raw);
      return true;
    } catch (e) {
      console.warn('[Store] localStorage 写入失败，已保留内存副本:', id, e.message);
      return true;
    }
  },

  add: function (id, row) {
    // Electron 模式：直接通过 IPC 添加
    if (Store.isElectron()) {
      try {
        return window.electronAPI.addRecord(id, row);
      } catch (e) {
        console.error('[Store] Electron 添加失败', id, e);
        return false;
      }
    }

    // 浏览器模式
    const rows = Store.get(id);
    rows.unshift(row);
    return Store.set(id, rows);
  },

  update: function (id, idx, row) {
    // Electron 模式：直接通过 IPC 更新
    if (Store.isElectron()) {
      try {
        return window.electronAPI.updateRecord(id, idx, row);
      } catch (e) {
        console.error('[Store] Electron 更新失败', id, e);
        return false;
      }
    }

    // 浏览器模式
    const rows = Store.get(id);
    if (idx < 0 || idx >= rows.length) return false;
    rows[idx] = row;
    return Store.set(id, rows);
  },

  remove: function (id, idx) {
    // Electron 模式：直接通过 IPC 删除
    if (Store.isElectron()) {
      try {
        return window.electronAPI.removeRecord(id, idx);
      } catch (e) {
        console.error('[Store] Electron 删除失败', id, e);
        return false;
      }
    }

    // 浏览器模式
    const rows = Store.get(id);
    if (idx < 0 || idx >= rows.length) return false;
    rows.splice(idx, 1);
    return Store.set(id, rows);
  },

  uid: function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  exportJSON: function (id) {
    return JSON.stringify(Store.get(id), null, 2);
  },

  // ---- 预置数据加载 ----
  // 从 data/<id>.json 拉取并合并到存储。
  // 策略：
  //   - Electron 模式：文件已由主进程加载，无需额外操作（返回 false 表示无新数据）
  //   - 浏览器模式：从 HTTP fetch 加载
  //   - localStorage 为空 → 直接导入
  //   - localStorage 有数据 → 不覆盖（用户手动录入优先）
  // 返回 Promise<boolean>

  preload: async function (id, url) {
    // Electron 模式：数据已通过 IPC 从文件读取，无需预置加载
    if (Store.isElectron()) {
      console.log('[Store] Electron 模式，跳过预置加载');
      return false;
    }

    // 浏览器模式（原有逻辑）
    const existing = Store.get(id);
    if (existing.length > 0) {
      console.log('[Store] 板块', id, '已有', existing.length, '条本地数据，跳过预置加载');
      return false;
    }
    try {
      const data = await fetchJSON(url, { timeout: 12000, retries: 2 });
      if (!Array.isArray(data)) { console.warn('[Store] 预置文件格式非数组:', url); return false; }
      Store.set(id, data);
      console.log('[Store] 板块', id, '从预置文件加载了', data.length, '条记录');
      return true;
    } catch (e) {
      console.warn('[Store] 预置加载失败:', id, e && e.message);
      return false;
    }
  },

  // 强制刷新：用预置文件覆盖存储（用于「同步最新」按钮）
  forceLoad: async function (id, url) {
    // Electron 模式：文件数据已是最新，无需额外操作
    if (Store.isElectron()) {
      console.log('[Store] Electron 模式，跳过强制刷新');
      return false;
    }

    // 浏览器模式：从 HTTP 强制覆盖
    try {
      const data = await fetchJSON(url, { timeout: 12000, retries: 2 });
      if (!Array.isArray(data)) return false;
      Store.set(id, data);
      console.log('[Store] 板块', id, '强制刷新为', data.length, '条');
      return true;
    } catch (e) {
      console.warn('[Store] 强制刷新失败:', id, e && e.message);
      return false;
    }
  }
};


/* === boards-config.js === */
/* ============================================================
 * boards-config.js — 14 大板块字段配置
 * 每个板块 = {
 *   num, title, subtitle, group, accent, status,
 *   icon, desc, future(未来接的真实数据源), fields[]
 * }
 * field = { key, label, type, options?, compute?, width? }
 *   type: text | number | date | select | textarea | computed
 *   options: 下拉选项数组
 *   compute(row): 计算列（只读，不入库）
 * ============================================================ */
const BOARDS = {

  /* —— 组1：经营驾驶舱 —— */
  'daily-pulse': {
    num: 1, title: '店铺日报', subtitle: 'Daily Pulse', group: '经营驾驶舱',
    accent: 'blue', status: 'live', icon: '📊',
    desc: '每天早9点自动推送，一眼看全店铺数据',
    future: '飞书多维表格 Base · 自动推送 → 飞书群',
    fields: [
      { key: 'date', label: '日期', type: 'date' },
      { key: 'platform', label: '平台', type: 'select', options: ['拼多多', '天猫'] },
      { key: 'sales', label: '销售额(元)', type: 'number', width: 110 },
      { key: 'orders', label: '订单数', type: 'number', width: 85 },
      { key: 'visitors', label: '访客数(UV)', type: 'number', width: 105 },
      { key: 'aov', label: '客单价(元)', type: 'computed', width: 110,
        compute: function(r) { var s=parseFloat(r.sales), o=parseInt(r.orders); return (s&&o)?(s/o).toFixed(1):'—'; } },
      { key: 'cvr', label: '转化率', type: 'computed', width: 80,
        compute: function(r) { var o=parseInt(r.orders)||0, v=parseInt(r.visitors)||0; return v?(o/v*100).toFixed(2)+'%':'—'; } },
      { key: 'ctr', label: '点击率', type: 'computed', width: 80,
        compute: function(r) { var o=parseInt(r.orders)||0, v=parseInt(r.visitors)||0; return v?(o/v*100).toFixed(2)+'%':'—'; } },
      { key: 'promotion_cost', label: '推广花费(元)', type: 'number', width: 125 },
      { key: 'promo_video', label: '短视频花费(元)', type: 'number', width: 115 },
      { key: 'promo_ratio', label: '推广占比', type: 'computed', width: 95,
        compute: function(r) { var c=parseFloat(r.promotion_cost)||0, s=parseFloat(r.sales)||0; return (s && c) ? (c/s*100).toFixed(1)+'%' : '—'; } },
      { key: 'roi', label: '投产比', type: 'computed', width: 80,
        compute: function(r) { var s=parseFloat(r.sales)||0, c=parseFloat(r.promotion_cost)||0; return c?(s/c).toFixed(2):'—'; } },
      { key: 'trend', label: '分析', type: 'computed', width: 80,
        // 需要全量数据做趋势判断，签名含 __needsAllData 标记
        __needsAllData: true,
        compute: function(r, all) {
          if (!all || !all.length) return '<span style="color:#9ca3af">正常</span>';
          // 筛选同平台、按日期排序
          var same = all.filter(function(x){ return x.platform === r.platform; })
            .sort(function(a,b){ return (a.date||'').localeCompare(b.date||''); });
          // 用 date+platform 匹配（JSON反序列化后对象引用会变，不能用 ===）
          var idx = same.findIndex(function(x){ return (x.date||'') === (r.date||'') && (x.platform||'') === (r.platform||''); });
          if (idx < 0) return '<span style="color:#9ca3af">正常</span>';
          // 取当前行 + 前6条（共7期）
          var recent = same.slice(Math.max(0, idx-6), idx+1);
          if (recent.length < 3) return '<span style="color:#9ca3af">数据不足</span>';
          var curSales = parseFloat(r.sales) || 0;
          var prevSales = recent.slice(0, -1).map(function(x){ return parseFloat(x.sales)||0; });
          var avg = prevSales.reduce(function(s,v){ return s+v; }, 0) / prevSales.length;
          if (!avg) return '<span style="color:#9ca3af">正常</span>';
          var change = (curSales - avg) / avg;  // 相对7日均值的变化率
          // 连跌检测
          var downStreak = 0;
          for (var i = recent.length - 2; i >= 0; i--) {
            if (parseFloat(recent[i].sales || 0) <= parseFloat(recent[i+1].sales || 0)) break;
            downStreak++;
          }
          // 判断逻辑
          var label, color;
          if (change >= 0.05) {
            label = '📈 增长'; color = '#15803d';   // 比7日均价高 ≥5%
          } else if (change <= -0.15) {
            label = '📉 下滑'; color = '#dc2626';   // 比7日均价低 ≥15%
          } else if (change <= -0.05 || downStreak >= 3) {
            label = '⚠️ 预警'; color = '#d97706';   // 低5-15% 或连跌3天+
          } else {
            label = '➡️ 正常'; color = '#6b7280';   // 波动 ±5% 以内
          }
          return '<span style="color:'+color+';font-weight:600">'+label+'</span>';
        }
      },
      { key: 'note', label: '备注', type: 'text', width: 180 }
    ]
  },

  /* —— 组1：经营驾驶舱 —— */
  'sales-alert': {
    num: 2, title: 'BI销售分析与预警', subtitle: 'BI Sales & Alert', group: '经营驾驶舱',
    accent: 'red', status: 'live', icon: '📈',
    desc: '趋势看得懂、异常第一时间知道',
    future: '数据拉取 → 趋势检测 → 分级判断 → 飞书推送',
    filterGroups: [
      { key: 'dimension', label: '维度' },
      { key: 'platform', label: '平台' }
    ],
    fields: [
      { key: 'date', label: '日期', type: 'date' },
      { key: 'dimension', label: '维度', type: 'select', options: ['日维度', '周维度'] },
      { key: 'platform', label: '平台', type: 'select', options: ['拼多多', '天猫', '双平台'] },
      { key: 'sales', label: '成交金额', type: 'number', width: 110 },
      { key: 'net_sales_pay', label: '净销售额(支付)', type: 'number', width: 120 },
      { key: 'net_sales_ship', label: '净销售额(发货)', type: 'number', width: 120 },
      { key: 'profit_amt', label: '发货利润额', type: 'number', width: 110 },
      { key: 'profit_rate', label: '发货利润率', type: 'number', width: 100 },
      { key: 'ship_diff', label: '发货-支付差额', type: 'number', width: 130 },
      { key: 'ship_status', label: '发货判断', type: 'select', options: ['缺少数据', '发货正常', '发货超前（增长）', '发货滞后（预警）', '发货恢复（增长）'] },
      { key: 'mom', label: '环比(%)', type: 'number', width: 90 },
      { key: 'level', label: '预警级别', type: 'select', options: ['正常', '增长喜报', '下滑预警', '严重下滑(≥30%)'] },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },  'ad-roi': {
    num: 4, title: '推广投放 ROI', subtitle: 'Ad ROI', group: '增长引擎',
    accent: 'rose', status: 'live', icon: '💰',
    desc: '直通车/多多推广花费产出，核心问题不痛一眼看清楚',
    future: '飞书店铺数据日报（天猫多渠道 + 拼多多商品推广）→ 每日自动同步',
    filterGroups: [
      { key: 'platform', label: '平台', options: ['天猫', '拼多多'] }
    ],
    /* ====== 字段说明 ======
     * 天猫数据源：计划级明细（tbl2hx4sz1m6vYDR 商品推广数据 + tblxDvqNapfyonPN 短视频推广数据，场景名字=渠道），真实渠道/计划 ROI 可算
     * 拼多多数据源：计划级明细（tblmYPQd58ZeE3TM 推广数据），真实渠道/计划 ROI 可算
     * 两平台均输出「计划级明细行」，前端 buildAdRoiAggregates 聚合成：日汇总行 + 渠道分组(含真实ROI) + 计划列表
     * 付免占比：天猫=商品推广成交笔数+短视频推广成交笔数(付费) vs 店铺概况总支付子订单数(全店)；拼多多=Σ计划成交笔数(付费) vs 支付订单数(免费)
     * KPI概览卡片 + 聚合详情由 board.html 专属渲染
     */
    fields: [
      { key: 'date',       label: '日期',         type: 'date',   width: 105 },
      { key: 'platform',   label: '平台',         type: 'select', width: 90,   options: ['天猫', '拼多多'] },
      { key: 'channel',    label: '推广渠道',      type: 'select', width: 140,
        options: ['关键词推广', '货品全站推广', '人群推广', '商品推广', '短视频'] },
      // —— 聚合行无产品/计划级明细，详情页展示 ——
      // （product_name/product_id/promo_name/group/bid_method 仅在 plans 明细中有值）
      // —— 投入指标 ——
      { key: 'cost',        label: '花费(元)',     type: 'number', width: 100 },
      // —— 产出指标 ——
      { key: 'total_gmv',  label: '成交额(元)',   type: 'computed', width: 120,
        compute: function(r) {
          var v = parseFloat(r.total_gmv);
          return (v && isFinite(v)) ? '¥' + Number(v).toLocaleString('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:0}) : '—';
        }
      },
      { key: 'orders',     label: '成交笔数',      type: 'number', width: 90 },
      // —— 效率指标 ——
      { key: 'blended_roi',label: '投产比(ROI)',  type: 'computed', width: 110,
        compute: function(r) {
          var roi = parseFloat(r.blended_roi);
          return (roi && isFinite(roi)) ? roi.toFixed(2) : '—';
        }
      },
      { key: 'net_roi',    label: '净投产比',      type: 'number', width: 95 },
      { key: 'cpc',        label: 'CPC(元)',      type: 'computed', width: 85,
        compute: function(r) {
          var cost = parseFloat(r.cost), clicks = parseFloat(r.clicks);
          return (cost && clicks) ? (cost/clicks).toFixed(2) : '—';
        }
      },
      // —— 趋势 ——
      { key: 'roi_change', label: 'ROI环比',       type: 'computed', width: 95,
        __needsAllData: true,
        compute: function(r, all) {
          if (!all || !all.length) return '<span style="color:#9ca3af">—</span>';
          var same = all.filter(function(x){
            return x.platform===r.platform;
          }).sort(function(a,b){ return (a.date||'').localeCompare(b.date||''); });
          var idx = same.findIndex(function(x){
            return (x.date||'')===(r.date||'') && (x.channel||'')===(r.channel||'');
          });
          if (idx<=0) return '<span style="color:#9ca3af">—</span>';
          var prevRoi = same[idx-1];
          if (!prevRoi) return '<span style="color:#9ca3af">—</span>';
          var cur = parseFloat(r.blended_roi);
          var prev = parseFloat(prevRoi.blended_roi);
          if (!cur||!prev||!isFinite(cur)||!isFinite(prev)) return '—';
          var chg = (cur-prev)/prev;
          var label, color;
          if (chg>=0.05)      {label='↑'+(chg*100).toFixed(0)+'%'; color='#15803d';}
          else if (chg<-0.1)  {label='↓'+(Math.abs(chg)*100).toFixed(0)+'%'; color='#dc2626';}
          else if (chg<-0.03) {label='↓'+(Math.abs(chg)*100).toFixed(0)+'%'; color='#d97706';}
          else                {label=(chg*100).toFixed(1)+'%'; color='#6b7280';}
          return '<span style="color:'+color+';font-weight:600">'+label+'</span>';
        }
      },
      { key: 'alert',       label: '状态',          type: 'computed', width: 85,
        __needsAllData: true,
        compute: function(r, all) {
          var roi = parseFloat(r.blended_roi);
          if (!roi||!isFinite(roi)) return '<span style="color:#9ca3af">—</span>';
          var label, color;
          if (roi >= 4.0)       {label='✅ 优秀'; color='#15803d';}
          else if (roi >= 2.5)  {label='🟢 良好'; color='#16a34a';}
          else if (roi >= 1.5)  {label='⚠️ 及格'; color='#d97706';}
          else if (roi >= 1.0)  {label='🔶 微利'; color='#ea580c';}
          else                  {label='🔴 亏损'; color='#dc2626';}
          return '<span style="color:'+color+';font-weight:600">'+label+'</span>';
        }
      },
      // —— 直接/间接拆分（仅拼多多）——
      { key: 'direct_gmv',  label: '直接成交',     type: 'number', width: 110 },
      { key: 'indirect_gmv',label: '间接成交',     type: 'number', width: 110 },
      { key: 'plan_count',  label: '计划数',        type: 'number', width: 70,
        compute: function(r) {
          var n = r.plan_count;
          return n ? n + '条' : '—';
        }
      },
      { key: 'note',       label: '备注',          type: 'text',   width: 160 }
    ]
  },


  'ecom-workflow': {
    num: 6, title: '电商自动化工作流', subtitle: 'E-com Workflow', group: '增长引擎',
    accent: 'red', status: 'live', icon: '🔄',
    desc: '从市场到回本的全链路自动化管理',
    future: '飞书 Base + 各平台后台',
    extraTool: 'payback.html',
    extraToolLabel: '回本周期测算器',
    filterGroups: [
      { key: 'platform', label: '平台', options: ['天猫', '拼多多'] }
    ],
    fields: [
      { key: 'stage', label: '环节', type: 'select', options: ['运营执行'] },
      { key: 'product', label: '产品', type: 'text', width: 120 },
      { key: 'platform', label: '平台', type: 'computed', width: 90,
        compute: function(r) {
          return (r.platform && r.platform !== '—') ? r.platform : '—';
        } },
      { key: 'pipeline', label: '项目阶段', type: 'computed', width: 140,
        compute: function(r) {
          var p = r.__pipeline;
          if (!p) return '—';
          var cycles = ['基建期','打品期','盈利期'];
          var badges = [];
          cycles.forEach(function(c){
            var s = p[c]; if (!s) return;
            var pct = s.total ? Math.round(s.done / s.total * 100) : 0;
            var color = pct >= 100 ? '#16a34a' : (pct > 0 ? '#d97706' : '#9ca3af');
            var bg = pct >= 100 ? '#dcfce7' : (pct > 0 ? '#fef3c7' : '#f3f4f6');
            badges.push('<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 7px;border-radius:10px;background:' + bg + ';color:' + color + ';font-weight:600;white-space:nowrap;">' + c + ' ' + pct + '%</span>');
          });
          return badges.join(' ');
        } },
      { key: 'owner', label: '负责人', type: 'text', width: 90 },
      { key: 'avgPct', label: '平均完成度', type: 'computed', width: 110,
        compute: function(r) {
          var avg = r.__woAvg;
          if (avg == null) avg = r.avgPct;
          if (avg == null) return '—';
          var color = avg >= 100 ? '#16a34a' : (avg > 0 ? '#d97706' : '#9ca3af');
          return '<span style="display:inline-block;width:70px;height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;vertical-align:middle;margin-right:6px;"><span style="display:block;height:100%;width:' + avg + '%;background:linear-gradient(90deg,' + (avg>=100?'#22c55e,#16a34a':'#fb923c,#ea580c') + ');border-radius:4px;"></span></span><span style="font-weight:700;color:' + color + ';">' + avg + '%</span>';
        } },
      { key: 'status', label: '状态', type: 'select', options: ['待启动', '进行中', '已完成', '已暂停'] },
      { key: 'updatedAt', label: '同步时间', type: 'text', width: 150 },
      { key: 'note', label: '备注/批注', type: 'text' }
    ]
  },



  








  


  /* —— 组6：员工协作（员工版同步过来的数据，领导可查看/发布）——
     这些板块由员工版写入云端（emp- 命名空间），领导版以 admin 身份读取。 */
  'emp-notice': {
    num: 15, title: '团队公告(员工)', subtitle: 'Team Notice', group: '员工协作',
    accent: 'amber', status: 'live', icon: '📢',
    desc: '领导发布给员工的公告；也可在此直接发布，员工端实时可见',
    fields: [
      { key: 'date', label: '日期', type: 'date', width: 120 },
      { key: 'title', label: '标题', type: 'text', width: 200 },
      { key: 'content', label: '内容', type: 'textarea' },
      { key: 'priority', label: '优先级', type: 'select', width: 100, options: ['普通', '重要', '紧急'] },
      { key: 'publisher', label: '发布人', type: 'text', width: 100 }
    ]
  },
  'emp-task': {
    num: 16, title: '员工任务(员工)', subtitle: 'My Tasks', group: '员工协作',
    accent: 'blue', status: 'live', icon: '✅',
    desc: '分配给员工的任务，员工更新状态；领导可在此分配/跟踪',
    fields: [
      { key: 'task', label: '任务', type: 'text', width: 240 },
      { key: 'status', label: '状态', type: 'select', width: 110, options: ['待接收', '进行中', '已完成', '已阻塞'] },
      { key: 'due', label: '截止日', type: 'date', width: 120 },
      { key: 'owner', label: '负责人', type: 'text', width: 90 },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },
  'emp-daily': {
    num: 17, title: '员工日报(员工)', subtitle: 'My Daily', group: '员工协作',
    accent: 'green', status: 'live', icon: '📝',
    desc: '员工每日填写的日报，领导可查看团队产出',
    fields: [
      { key: 'date', label: '日期', type: 'date', width: 120 },
      { key: 'employee', label: '员工', type: 'text', width: 90 },
      { key: 'done', label: '今日完成', type: 'textarea' },
      { key: 'plan', label: '明日计划', type: 'textarea' },
      { key: 'blocker', label: '问题/需协助', type: 'textarea' },
      { key: 'hours', label: '工时(h)', type: 'number', width: 90 }
    ]
  },
  'emp-kb': {
    num: 18, title: '产品知识库(员工)', subtitle: 'Product KB', group: '员工协作',
    accent: 'purple', status: 'live', icon: '📚',
    desc: '员工可查的产品知识；领导可维护内容',
    fields: [
      { key: 'title', label: '标题', type: 'text', width: 200 },
      { key: 'employee', label: '贡献人', type: 'text', width: 90 },
      { key: 'type', label: '类型', type: 'select', width: 120, options: ['产品参数', '销售话术', '常见问题', '竞品对比'] },
      { key: 'content', label: '内容', type: 'textarea' },
      { key: 'link', label: '链接/位置', type: 'text', width: 180 }
    ]
  },
  'emp-performance': {
    num: 19, title: '员工业绩(员工)', subtitle: 'My Performance', group: '员工协作',
    accent: 'red', status: 'live', icon: '📈',
    desc: '员工销售额与完成率；目标由领导设定',
    fields: [
      { key: 'date', label: '日期', type: 'date', width: 120 },
      { key: 'employee', label: '员工', type: 'text', width: 90 },
      { key: 'platform', label: '平台', type: 'select', width: 100, options: ['拼多多', '天猫'] },
      { key: 'sales', label: '销售额(元)', type: 'number', width: 110 },
      { key: 'orders', label: '订单数', type: 'number', width: 85 },
      { key: 'target', label: '目标(元)', type: 'number', width: 110 },
      { key: 'rate', label: '完成率', type: 'computed', width: 100,
        compute: function (r) { var t = parseFloat(r.target), s = parseFloat(r.sales); return (!t) ? '—' : (s / t * 100).toFixed(1) + '%'; } }
    ]
  },
  




  'dept-members': {
    num: 20, title: '部门成员管理', subtitle: 'Dept Members', group: '员工协作',
    accent: 'blue', status: 'live', icon: '🏢',
    desc: '部门花名册：姓名/部门/职位/状态，员工贡献数据按姓名自动关联',
    fields: [
      { key: 'name', label: '姓名', type: 'text', width: 110 },
      { key: 'department', label: '部门', type: 'select', width: 120, options: ['运营部', '设计部', '客服部', '仓储部', '综合部'] },
      { key: 'position', label: '职位', type: 'text', width: 120 },
      { key: 'status', label: '状态', type: 'select', width: 100, options: ['在职', '试用', '离职'] },
      { key: 'joinDate', label: '入职日期', type: 'date', width: 120 },
      { key: 'phone', label: '手机', type: 'text', width: 130 },
      { key: 'note', label: '备注', type: 'textarea' }
    ]
  }
};

// 员工版：仅保留 emp- 命名空间板块（服务端也会强制隔离），隐藏领导侧数据
if (window.__EDITION === 'employee') {
  Object.keys(BOARDS).forEach(function (k) {
    if (k.indexOf('emp-') !== 0) delete BOARDS[k];
  });
}

// 便捷查询：按 id 取配置，取不到返回 null
function getBoard(id) {
  return BOARDS[id] || null;
}


/* === diagnostics-config.js === */
/* ============================================================
 * diagnostics-config.js — 全板块诊断规则 v2
 * 「一眼看异常 · 子节点全分析 · 可执行方案」
 *
 * 每个板块 = { analyze(rows, ctx) -> { findings, dimensions, subNodes } }
 *   finding = { severity, title, detail, action, metric?, nodes? }
 *     severity: danger(🔴紧急) | warning(🟠重要) | info(🟡关注)
 *     action : 真正可执行的动作（具体对象 + 数字 + 责任人 + 步骤）
 *     nodes  : [{name, sub}] 该问题涉及的具体子节点（chips 展示）
 *   dimensions = [{ name, segments:[{label,count,danger?,sub?}], note? }]
 *   subNodes  = [{ label, severity, detail, metric? }]  异常子节点明细（最差 TopN）
 *
 * 依赖：window.DIAG_UTIL（见文末）
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 工具 ----------
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function isF(v) { var n = parseFloat(v); return isFinite(n); }
  function sum(arr, k) { return arr.reduce(function (s, r) { return s + num(r[k]); }, 0); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function latestDate(rows, field) {
    field = field || 'date';
    var m = null;
    rows.forEach(function (r) { var d = r[field]; if (d && (!m || d > m)) m = d; });
    return m;
  }
  // Python dict/list 字符串 -> JS 对象（product-links 的 t/plans 是 py repr）
  function parseKV(s) {
    if (s == null) return {};
    if (typeof s !== 'string') return s;
    try {
      var j = String(s)
        .replace(/None/g, 'null').replace(/True/g, 'true').replace(/False/g, 'false')
        .replace(/'/g, '"');
      return JSON.parse(j);
    } catch (e) { return {}; }
  }
  function groupCount(arr, keyFn) {
    var m = {};
    arr.forEach(function (x) { var k = keyFn(x); m[k] = (m[k] || 0) + 1; });
    return m;
  }
  function fmtMoney(v) {
    v = num(v);
    if (v >= 10000) return '¥' + (v / 10000).toFixed(1) + '万';
    return '¥' + v.toFixed(0);
  }
  function fmtPct(v) { return (num(v) * 100).toFixed(1) + '%'; }
  function emptyResult(name) {
    return {
      findings: [{ severity: 'info', title: '暂无数据', detail: (name || '该板块') + '目前没有可分析的数据。', action: '运行对应同步脚本或接入数据源后重试。' }],
      dimensions: [], subNodes: []
    };
  }
  function F(sev, title, detail, action, metric, nodes, deepLink, topic) {
    return { severity: sev, title: title, detail: detail, action: action, metric: metric, nodes: nodes || [], deepLink: deepLink || null, topic: topic || null };
  }

  // 维度段排序：危险优先
  function dimSeg(label, count, danger, sub) { return { label: label, count: count, danger: !!danger, sub: sub || '' }; }

  var DIAGNOSTICS = {};

  /* ════════ 产品链接钻取（核心：细化链接维度 · 口径=最新一天）════════ */
  DIAGNOSTICS['product-links'] = {
    analyze: function (rows) {
      var links = (rows || []).filter(function (l) { return l && l.t; });
      if (!links.length) return emptyResult('产品链接');
      // 关键：只看「最新一天」的推广表现（用户已优化过老计划，累计口径会误报）。
      // 由各推广计划的 daily 数组按日期聚合出每链接最新一天的 花费/成交/订单。
      var P = links.map(function (l) {
        var t = parseKV(l.t);
        var plans = (typeof l.plans === 'string' ? parseKV(l.plans) : l.plans) || [];
        var byDate = {};
        plans.forEach(function (p) {
          (p.daily || []).forEach(function (d) {
            if (!d || !d.d) return;
            var k = String(d.d);
            var e = byDate[k] || (byDate[k] = { c: 0, g: 0, o: 0 });
            e.c += num(d.c); e.g += num(d.g); e.o += num(d.o);
          });
        });
        var dates = Object.keys(byDate).sort();
        var e = dates.length ? byDate[dates[dates.length - 1]] : null;
        return {
          id: l.id, name: l.product || l.name || l.id, plat: l.plat || l.platform || '—',
          date: e ? e.date : '', days: num(t.days),
          cost: e ? e.c : 0, gmv: e ? e.g : 0, orders: e ? e.o : 0,
          roi: (e && e.c > 0) ? e.g / e.c : 0,
          clicks: num(t.i), trend: t.trend, trendPct: num(t.trend_pct)
        };
      });
      // 只统计有最新一天数据的链接；完全无 daily 的链接（数据未接入）跳过异常判断
      var total = P.filter(function (x) { return x.days > 0; }).length || P.length;
      var latestAll = '';
      P.forEach(function (x) { if (x.date > latestAll) latestAll = x.date; });
      if (!latestAll) latestAll = '最新日';

      // —— 维度1：平台分布（含亏损数）——
      var platMap = {};
      P.forEach(function (x) { (platMap[x.plat] = platMap[x.plat] || []).push(x); });
      var platSeg = Object.keys(platMap).map(function (pf) {
        var arr = platMap[pf];
        var lose = arr.filter(function (x) { return x.roi < 1 && x.cost > 0; }).length;
        return dimSeg(pf, arr.length, lose > arr.length * 0.4, '亏损 ' + lose + ' 条');
      });

      // —— 维度2：ROI 分层 ——
      function tier(r) { return r < 1 ? '亏损(<1)' : r < 1.5 ? '微利(1-1.5)' : r < 2.5 ? '及格(1.5-2.5)' : '良好(≥2.5)'; }
      var tierMap = groupCount(P, function (x) { return tier(x.roi); });
      var tierOrder = ['亏损(<1)', '微利(1-1.5)', '及格(1.5-2.5)', '良好(≥2.5)'];
      var tierSeg = tierOrder.map(function (k) { return dimSeg(k, tierMap[k] || 0, k.indexOf('亏损') === 0, ''); });

      // —— 维度3：状态分布（只统计「真实有量」：当天花费≥5元，过滤几毛钱低效链接误报）——
      var losing = P.filter(function (x) { return x.roi < 1 && x.cost >= 5; });
      var waste = P.filter(function (x) { return x.cost > 50 && x.orders === 0; });
      var loweff = P.filter(function (x) { return x.roi >= 1 && x.roi < 1.5 && x.cost > 50; });
      var losingCost = sum(losing, 'cost');
      var wasteCost = sum(waste, 'cost');

      // —— 维度4：产品维度（亏损链接最多的产品 Top6）——
      var prodMap = {};
      losing.forEach(function (x) { (prodMap[x.name] = prodMap[x.name] || []).push(x); });
      var prodSeg = Object.keys(prodMap).map(function (n) {
        var arr = prodMap[n];
        return dimSeg(n, arr.length, true, '亏损花费 ' + fmtMoney(sum(arr, 'cost')));
      }).sort(function (a, b) { return b.count - a.count; }).slice(0, 6);

      var dimensions = [
        { name: '平台分布', segments: platSeg, note: '各平台链接数与亏损数' },
        { name: 'ROI 分层', segments: tierSeg, note: '按投产比分四档' },
        { name: '状态分布', segments: [
            dimSeg('亏损链接(R<1)', losing.length, true, fmtMoney(losingCost)),
            dimSeg('只花钱无成交', waste.length, waste.length > 0, fmtMoney(wasteCost)),
            dimSeg('低效链接(1-1.5)', loweff.length, false, '')
          ], note: '按异常状态归类' },
        { name: '产品维度·亏损Top', segments: prodSeg, note: '亏损链接最集中的产品' }
      ];

      // —— 子节点明细：亏损最严重 Top12（按花费）——
      var subNodes = losing.slice().sort(function (a, b) { return b.cost - a.cost; }).slice(0, 12).map(function (x) {
        return { label: x.name + '·' + x.plat, severity: x.roi < 0.8 ? 'danger' : 'warning',
          detail: 'ROI ' + x.roi.toFixed(2) + ' · 花费 ' + fmtMoney(x.cost) + ' · 成交 ' + x.orders + ' 单', metric: fmtMoney(x.cost) };
      });

      // —— findings（可执行，口径=最新一天）——
      var findings = [];
      if (losing.length) {
        var ratio = (losing.length / total);
        var topL = losing.slice().sort(function (a, b) { return b.cost - a.cost; }).slice(0, 5);
        var top5 = topL.map(function (x) { return x.name + '·' + x.plat; });
        findings.push(F(
          ratio > 0.3 ? 'danger' : 'warning',
          losing.length + ' 条链接在亏本投放（ROI<1）',
          '按 ' + latestAll + ' 最新一天口径：' + total + ' 条链接中，' + losing.length + ' 条（' + fmtPct(ratio) + '）当天花费≥5元且投产比<1，当天亏损花费约 ' + fmtMoney(losingCost) + '（低花费链接已忽略）。平台分布：' +
            platSeg.map(function (s) { return s.label + ' 亏损 ' + s.sub.split(' ')[1]; }).join('、') + '。',
          '执行：① 按「最新一天」口径导出 ROI<1 的链接（见下方子节点明细）；② 对当天花费>200元的亏损链接今日内降出价30%或暂停；③ 3日后复盘，仍<1则转静默。责任人：推广运营（丁朝州/潘）。',
          fmtMoney(losingCost),
          top5.map(function (n) { return { name: n, sub: 'ROI<1' }; }),
          { board: 'product-links', scope: topL[0] ? topL[0].plat : '全部', filter: 'loss', keyword: topL[0] ? topL[0].name : '', linkId: topL[0] ? topL[0].id : '' },
          'ad_loss'
        ));
      }
      if (waste.length) {
        var wtop = waste.slice().sort(function (a, b) { return b.cost - a.cost; }).slice(0, 6);
        var wn = wtop.map(function (x) { return x.name + '·' + x.plat; });
        findings.push(F(
          'danger',
          waste.length + ' 条链接只花钱、零成交',
          latestAll + ' 当天 ' + waste.length + ' 条链接花费合计 ' + fmtMoney(wasteCost) + ' 却无一笔成交，疑似素材/定向失效或已断流。',
          '执行：立即暂停这些链接的推广（名单见子节点明细），检查落地页与关键词；暂停预计止损 ' + fmtMoney(wasteCost) + '/周期。责任人：推广运营。',
          fmtMoney(wasteCost),
          wn.map(function (n) { return { name: n, sub: '0成交' }; }),
          { board: 'product-links', scope: wtop[0] ? wtop[0].plat : '全部', filter: 'waste', keyword: wtop[0] ? wtop[0].name : '', linkId: wtop[0] ? wtop[0].id : '' },
          'ad_waste'
        ));
      }
      if (loweff.length) {
        var lowtop = loweff.slice().sort(function (a, b) { return b.cost - a.cost; }).slice(0, 1)[0] || null;
        findings.push(F(
          'warning',
          loweff.length + ' 条链接微利（ROI 1-1.5）且花费偏高',
          latestAll + ' 当天 ' + loweff.length + ' 条链接投产比仅 1-1.5（微利），但当天花费>50元，规模化后吞噬利润。',
          '执行：对微利链接优化出价与人群，目标 ROI 提到≥1.5；7日内无改善则降预算50%。责任人：推广运营。',
          loweff.length + '条',
          [],
          { board: 'product-links', scope: lowtop ? lowtop.plat : '全部', filter: 'loweff', keyword: lowtop ? lowtop.name : '', linkId: lowtop ? lowtop.id : '' },
          'link_loweff'
        ));
      }
      if (!findings.length) {
        findings.push(F('info', '链接投产健康', '当前链接投产比整体良好，无大面积亏损。', '维持现有投放节奏，持续监控 ROI 分层变化。'));
      }
      return { findings: findings, dimensions: dimensions, subNodes: subNodes };
    }
  };

  /* ════════ 推广投放 ROI（计划级）════════ */
  DIAGNOSTICS['ad-roi'] = DIAGNOSTICS['ad-roi-analysis'] = {
    analyze: function (rows) {
      var all = rows || [];
      if (!all.length) return emptyResult('推广ROI');
      var ld = latestDate(all);
      // 只看最新一天：避免已优化的旧计划继续被误报
      var cur = all.filter(function (r) { return r.date === ld; });
      var withCost = cur.filter(function (r) { return num(r.cost) > 0; });
      if (!withCost.length) return emptyResult('推广ROI');

      // 只统计「真实有量」的亏损：当天花费≥5 元（过滤大量几毛钱低效计划造成的误报）
      var losing = withCost.filter(function (r) { return num(r.cost) >= 5 && (!isF(r.blended_roi) || num(r.blended_roi) < 1); });
      var waste = withCost.filter(function (r) { return num(r.cost) > 50 && num(r.orders) === 0 && (!isF(r.total_gmv) || num(r.total_gmv) === 0); });
      var loseCost = sum(losing, 'cost');

      // 维度：平台 / 渠道
      var platMap = {}, chanMap = {};
      withCost.forEach(function (r) {
        (platMap[r.platform] = platMap[r.platform] || []).push(r);
        var ch = r.channel || '其他';
        (chanMap[ch] = chanMap[ch] || []).push(r);
      });
      var platSeg = Object.keys(platMap).map(function (pf) {
        var arr = platMap[pf];
        var lz = arr.filter(function (r) { return !isF(r.blended_roi) || num(r.blended_roi) < 1; }).length;
        return dimSeg(pf, arr.length, lz > arr.length * 0.3, '亏损 ' + lz + ' 计划');
      });
      var chanSeg = Object.keys(chanMap).map(function (ch) {
        var arr = chanMap[ch];
        var lz = arr.filter(function (r) { return !isF(r.blended_roi) || num(r.blended_roi) < 1; }).length;
        return dimSeg(ch, arr.length, lz > arr.length * 0.3, '亏损 ' + lz);
      }).sort(function (a, b) { return b.count - a.count; });

      var dimensions = [
        { name: '平台分布', segments: platSeg, note: ld + ' 计划数 / 亏损数' },
        { name: '渠道分布', segments: chanSeg, note: '各推广渠道计划数与亏损数' }
      ];

      var subNodes = losing.slice().sort(function (a, b) { return num(b.cost) - num(a.cost); }).slice(0, 12).map(function (r) {
        return { label: (r.plan || r.product || r.channel) + '·' + r.platform,
          severity: num(r.blended_roi) < 0.8 ? 'danger' : 'warning',
          detail: 'ROI ' + (isF(r.blended_roi) ? num(r.blended_roi).toFixed(2) : '—') + ' · 花费 ' + fmtMoney(r.cost) + ' · 成交 ' + num(r.orders) + ' 单',
          metric: fmtMoney(r.cost) };
      });

      var findings = [];
      if (losing.length) {
        var topL = losing.slice().sort(function (a, b) { return num(b.cost) - num(a.cost); }).slice(0, 6);
        var topN = topL.map(function (r) { return (r.plan || r.product || '计划') + '·' + r.platform; });
        findings.push(F(
          losing.length >= withCost.length * 0.5 ? 'danger' : 'warning',
          losing.length + ' 条推广计划亏损（ROI<1）',
          ld + ' 最新一天 ' + withCost.length + ' 条计划中，' + losing.length + ' 条当天花费≥5元且投产比<1，当天亏损花费 ' + fmtMoney(loseCost) + '（低花费计划已忽略，避免误报）。',
          '执行：暂停当天 blended_roi<1 的计划，优先处理花费 Top10（见子节点明细）；预计止损 ' + fmtMoney(loseCost) + '。暂停后把预算挪到 ROI≥2.5 的优质计划。责任人：推广运营。',
          fmtMoney(loseCost),
          topN.map(function (n) { return { name: n, sub: 'ROI<1' }; }),
          { board: 'ad-roi-analysis', scope: topL[0] ? topL[0].platform : '全平台', roi: '亏损', dateMode: '1', keyword: topL[0] ? (topL[0].plan || topL[0].product || '') : '', itemId: topL[0] ? (topL[0].item_id || '') : '' },
          'ad_loss'
        ));
      }
      if (waste.length) {
        var wc = sum(waste, 'cost');
        var wtop = waste.slice().sort(function (a, b) { return num(b.cost) - num(a.cost); }).slice(0, 5);
        findings.push(F('danger', waste.length + ' 条计划只花钱无成交',
          ld + ' 当天 ' + waste.length + ' 条计划花费 ' + fmtMoney(wc) + ' 却零成交。',
          '执行：立即暂停这些计划（名单见明细），检查定向与素材是否失效。责任人：推广运营。', fmtMoney(wc),
          wtop.map(function (r) { return { name: (r.plan || r.product) + '·' + r.platform, sub: '0成交' }; }),
          { board: 'ad-roi-analysis', scope: wtop[0] ? wtop[0].platform : '全平台', roi: '全部', dateMode: '1', keyword: wtop[0] ? (wtop[0].plan || wtop[0].product || '') : '', itemId: wtop[0] ? (wtop[0].item_id || '') : '' },
          'ad_waste'
        ));
      }
      if (!findings.length) {
        findings.push(F('info', '推广投产健康', '当前推广计划投产比整体≥1，无大面积亏损。', '维持节奏，持续监控渠道维度亏损变化。'));
      }
      return { findings: findings, dimensions: dimensions, subNodes: subNodes };
    }
  };

  /* ════════ 店铺日报（子节点=平台）════════ */
  DIAGNOSTICS['daily-pulse'] = {
    analyze: function (rows) {
      var all = rows || [];
      if (!all.length) return emptyResult('店铺日报');
      var ld = latestDate(all);
      var cur = all.filter(function (r) { return r.date === ld; });
      if (!cur.length) cur = all.slice(-4);

      var findings = [], subNodes = [], dimensions = [];
      cur.forEach(function (r) {
        var plat = r.platform || '—';
        var sales = num(r.sales), cost = num(r.promotion_cost), orders = num(r.orders), vis = num(r.visitors);
        var roi = cost ? sales / cost : 0;
        var promoRatio = sales ? cost / sales : 0;
        var cvr = vis ? orders / vis : 0;
        var issues = [];
        if (roi < 1) issues.push('推广亏损(ROI ' + roi.toFixed(2) + ')');
        if (promoRatio > 0.3) issues.push('推广占比 ' + fmtPct(promoRatio));
        if (cvr < 0.005 && vis > 0) issues.push('转化率 ' + fmtPct(cvr));
        if (issues.length) {
          findings.push(F(roi < 1 ? 'danger' : 'warning', plat + ' ' + ld + '：' + issues[0],
            plat + ' 当日销售额 ' + fmtMoney(sales) + '、推广 ' + fmtMoney(cost) + '、ROI ' + roi.toFixed(2) +
              (promoRatio > 0.3 ? '、推广占比 ' + fmtPct(promoRatio) : '') + (cvr < 0.005 ? '、转化率 ' + fmtPct(cvr) : '') + '。',
            '执行：' + (roi < 1 ? '压缩' + plat + '推广预算，暂停 ROI<1 的计划；' : '') +
              (promoRatio > 0.3 ? '将' + plat + '推广占比压回 30% 以内；' : '') +
              (cvr < 0.005 ? '排查' + plat + '落地页/价格/库存，提升转化。' : '') + '责任人：运营。',
            (roi < 1 ? 'ROI ' + roi.toFixed(2) : fmtPct(promoRatio)),
            [{ name: plat, sub: ld }],
            { board: 'daily-pulse', filters: { platform: plat }, search: ld },
            (issues[0] && issues[0].indexOf('推广亏损') >= 0) ? 'ad_loss' : 'daily_issue'
          ));
          subNodes.push({ label: plat + ' ' + ld, severity: roi < 1 ? 'danger' : 'warning',
            detail: issues.join('、'), metric: roi < 1 ? roi.toFixed(2) : fmtPct(promoRatio) });
        }
      });
      // 数据时效（昨天=正常，仅滞后 >1 天才报异常）
      var gap = Math.round((new Date(todayStr()) - new Date(String(ld).replace(/-/g, '/'))) / 86400000);
      if (gap > 1) {
        findings.unshift(F(gap > 7 ? 'danger' : 'warning', '数据滞后 ' + gap + ' 天',
          '店铺日报最新到 ' + ld + '，落后当前 ' + gap + ' 天，决策依据可能失真。',
          '执行：运行数据同步（飞书 Base 抓取）补到最新日期；若飞书无新数据则确认推送任务是否中断。责任人：数据运维。',
          gap + '天',
          [],
          { board: 'daily-pulse' }
        ));
      }
      if (!findings.length) findings.push(F('info', '店铺日报健康', ld + ' 各平台销售/推广指标正常。', '维持日常监控。'));
      return { findings: findings, dimensions: dimensions, subNodes: subNodes };
    }
  };

  /* ════════ BI 销售预警（子节点=维度×平台）════════ */
  DIAGNOSTICS['sales-alert'] = {
    analyze: function (rows) {
      var all = rows || [];
      if (!all.length) return emptyResult('销售预警');
      var ld = latestDate(all);
      var cur = all.filter(function (r) { return r.date === ld; });
      if (!cur.length) cur = all.slice(-6);

      var findings = [], subNodes = [];
      cur.forEach(function (r) {
        var dim = (r.dimension || '日') + '·' + (r.platform || '—');
        var sev = null, issue = '';
        if (/严重下滑/.test(r.level || '')) { sev = 'danger'; issue = '严重下滑(≥30%)'; }
        else if (/下滑预警/.test(r.level || '')) { sev = 'warning'; issue = '下滑预警'; }
        if (/滞后/.test(r.ship_status || '')) { sev = 'danger'; issue = (issue ? issue + ' + ' : '') + '发货滞后'; }
        if (sev) {
          var prof = isF(r.profit_rate) ? num(r.profit_rate) : null;
          findings.push(F(sev, dim + '：' + issue,
            dim + ' 销售额 ' + fmtMoney(r.sales) + (isF(r.mom) ? '、环比 ' + r.mom + '%' : '') +
              (prof != null ? '、利润率 ' + prof + '%' : '') + '。',
            '执行：' + (/下滑/.test(issue) ? '复盘该' + r.platform + r.dimension + '的流量/价格/竞品/活动，2日内出应对；' : '') +
              (/滞后/.test(issue) ? '核查滞后订单并联系仓储加急发货；' : '') + '责任人：运营/客服。',
            (isF(r.mom) ? r.mom + '%' : (prof != null ? prof + '%' : '')),
            [{ name: dim, sub: issue }],
            { board: 'sales-alert', filters: { platform: r.platform || '', dimension: r.dimension || '' }, search: String(r.date || ld) },
            /下滑/.test(issue) ? 'sales_drop' : 'ship_lag'
          ));
          subNodes.push({ label: dim, severity: sev, detail: issue, metric: isF(r.mom) ? r.mom + '%' : '' });
        }
      });
      if (!findings.length) findings.push(F('info', '销售预警正常', ld + ' 各维度无严重下滑/发货滞后。', '维持监控。'));
      return { findings: findings, dimensions: [], subNodes: subNodes };
    }
  };

  /* ════════ 库存预警（子节点=SKU/产品）════════ */
  DIAGNOSTICS['inventory-alert'] = {
    analyze: function (rows) {
      var prods = (rows || []).filter(function (r) { return r && (r.goods_name || r.link_id); });
      if (!prods.length) return emptyResult('库存预警');
      var urgent = prods.filter(function (r) { return /urgent|紧急/.test(r.level || ''); });
      var low = prods.filter(function (r) { return isF(r.doh) && num(r.doh) < 3 && !/urgent|紧急/.test(r.level || ''); });
      var urgentSorted = urgent.slice().sort(function (a, b) { return num(a.doh) - num(b.doh); });
      // 紧急 SKU 总数（一个产品可能含多个紧急 SKU）
      var urgentSku = urgent.reduce(function (s, r) {
        return s + (Array.isArray(r.urgent_skus) ? r.urgent_skus.length : num(r.sku_count));
      }, 0);

      // 维度：等级分布
      var lvMap = groupCount(prods, function (r) { return r.level_label || r.level || '未知'; });
      var lvSeg = Object.keys(lvMap).map(function (k) {
        return dimSeg(k, lvMap[k], /紧急/.test(k), '');
      });
      var dimensions = [{ name: '库存等级分布', segments: lvSeg, note: '共 ' + prods.length + ' 个产品 / ' + urgentSku + ' 个紧急SKU' }];

      var subNodes = urgentSorted.slice(0, 12).map(function (r) {
        var skuN = Array.isArray(r.urgent_skus) ? r.urgent_skus.length : num(r.sku_count);
        return { label: r.goods_name || r.link_id, severity: 'danger',
          detail: '库存天数 ' + num(r.doh).toFixed(1) + ' · 可售 ' + num(r.available) + ' · 紧急SKU ' + skuN,
          metric: num(r.doh).toFixed(1) + '天' };
      });

      var findings = [];
      if (urgent.length) {
        var topN = urgentSorted.slice(0, 6).map(function (r) { return r.goods_name || r.link_id; });
        findings.push(F(urgentSku >= 10 ? 'danger' : 'warning', urgent.length + ' 个产品(' + urgentSku + '个SKU)紧急补货（断货风险）',
          urgent.length + ' 个产品共 ' + urgentSku + ' 个SKU库存天数(doh)极低，面临断货，最紧急的 doh 仅 ' +
            (urgentSorted[0] ? num(urgentSorted[0].doh).toFixed(1) : '?') + ' 天。',
          '执行：今日为头部动销产品下采购单（名单见子节点明细），优先 ' + topN.slice(0, 3).join('、') +
            ' 等；确认到货周期，避免断货损失。责任人：仓储/采购。',
          urgentSku + '个SKU',
          topN.map(function (n) { return { name: n, sub: '紧急' }; }),
          { board: 'inventory-alert', filter: 'urgent', keyword: topN[0] || '' },
          'stock_urgent'
        ));
      }
      if (low.length) {
        var lowtop = low.slice().sort(function (a, b) { return num(a.doh) - num(b.doh); }).slice(0, 1)[0] || null;
        findings.push(F('warning', low.length + ' 个产品库存天数<3天（临近紧急）',
          low.length + ' 个产品 doh  在 3 天以内但未到紧急线，需提前备货。',
          '执行：将这批产品加入本周补货计划，预防进入紧急区间。责任人：仓储。', low.length + '个',
          [],
          { board: 'inventory-alert', filter: 'warning', keyword: lowtop ? (lowtop.goods_name || lowtop.link_id || '') : '' },
          'stock_low'
        ));
      }
      if (!findings.length) findings.push(F('info', '库存健康', '当前无紧急/低库存产品。', '维持库存周转监控。'));
      return { findings: findings, dimensions: dimensions, subNodes: subNodes };
    }
  };


  /* ════════ 竞品分析（子节点=品类）════════ */
  DIAGNOSTICS['competition-analysis'] = {
    analyze: function (rows) {
      // 形态A：完整对象（首页 / data/competition.json）
      if (rows && rows.platforms) {
        var data = rows;
        var findings = [], subNodes = [], dimensions = [];
        var platCounts = [];
        Object.keys(data.platforms).forEach(function (pf) {
          var p = data.platforms[pf] || {};
          var cats = p.categories || [];
          var weak = 0;
          var missing_ours = false;  // 标记：本平台我方产品未接数据源
          cats.forEach(function (c) {
            var ours = c.ours_products || [];
            var lastSeries = (c.series && c.series.length) ? c.series[c.series.length - 1] : null;
            var prevSeries = (c.series && c.series.length > 1) ? c.series[c.series.length - 2] : null;
            var og, oroi, hasReliableRoi = false;
            if (ours.length) {
              og = ours.reduce(function (s, x) { var t = parseKV(x.t); return s + num(t.g); }, 0);
              oroi = ours.reduce(function (s, x) { var t = parseKV(x.t); return s + num(t.r); }, 0) / ours.length;
              hasReliableRoi = true;
            } else {
              missing_ours = true;
              og = num(lastSeries && lastSeries.ours);
              oroi = 0;
            }
            var compLatest = 0;
            (c.competitors || []).forEach(function (cp) {
              var dl = cp.daily || {}; var keys = Object.keys(dl);
              if (keys.length) compLatest = Math.max(compLatest, num(dl[keys[keys.length - 1]]));
            });
            // 份额优先用 series.ours_pct（Excel/飞书权威值），其次用我方/合计
            var share = num(lastSeries && lastSeries.ours_pct);
            if (!share && og + compLatest) share = og / (og + compLatest);
            // 趋势：最近一天 vs 前一天，判断是否在失守
            var shareChg = 0;
            if (lastSeries && prevSeries && isF(prevSeries.ours_pct) && num(prevSeries.ours_pct) > 0) {
              shareChg = (num(lastSeries.ours_pct) - num(prevSeries.ours_pct)) / num(prevSeries.ours_pct);
            }
            var sev, label, action, metric, detail;
            if (hasReliableRoi && oroi < 1 && share && share < 0.2) {
              // 形态 A-1：有产品级 ROI，双确认偏弱
              sev = oroi < 0.7 ? 'danger' : 'warning';
              weak++;
              label = pf + ' ·『' + c.name + '』我方偏弱';
              action = '执行：研究该品类竞品主推款与打法，强化我方『' + (ours[0] ? ours[0].name : c.name) + '』的投流与价格；份额<20% 优先提投流。责任人：运营。';
              findings.push(F(sev, label,
                '我方 GMV ' + fmtMoney(og) + '、平均 ROI ' + oroi.toFixed(2) + '、估算份额 ' + fmtPct(share) + (compLatest ? '（头部竞品最新日销 ' + compLatest + '）' : '') + '。',
                action, oroi.toFixed(2), [{ name: c.name, sub: pf }],
                { board: 'competition-analysis', platform: pf, category: c.name },
                'comp_weak'
              ));
              subNodes.push({ label: c.name + '·' + pf, severity: sev, detail: 'ROI ' + oroi.toFixed(2) + ' · 份额 ' + fmtPct(share), metric: oroi.toFixed(2) });
            } else if (share && share < 0.2) {
              // 形态 A-2：无产品级 ROI，但 series 显示份额已失守 <20%
              sev = shareChg < -0.1 ? 'danger' : 'warning';
              weak++;
              metric = fmtPct(share);
              label = pf + ' ·『' + c.name + '』份额失守（' + metric + '）';
              detail = '最新一天我方份额仅 ' + metric + '，低于 20% 警戒线' +
                (shareChg ? '，较前一日' + (shareChg < 0 ? '下滑 ' : '上升 ') + fmtPct(Math.abs(shareChg)) : '') +
                (compLatest ? '；头部竞品最新日销 ' + fmtMoney(compLatest) : '') + '。';
              action = '执行：研究' + pf + '『' + c.name + '』竞品主推款与价格策略，加大投流或调整活动；目标 7 日内份额回升到 25% 以上。责任人：运营。';
              findings.push(F(sev, label, detail, action, metric, [{ name: c.name, sub: pf }],
                { board: 'competition-analysis', platform: pf, category: c.name }, 'comp_weak'));
              subNodes.push({ label: c.name + '·' + pf, severity: sev, detail: '份额 ' + metric, metric: metric });
            } else if (hasReliableRoi && (oroi < 1.5 || (share && share < 0.3))) {
              findings.push(F('info', pf + ' ·『' + c.name + '』需关注',
                '我方 GMV ' + fmtMoney(og) + '、平均 ROI ' + oroi.toFixed(2) + '、估算份额 ' + fmtPct(share) + '。',
                '执行：跟踪' + pf + '『' + c.name + '』趋势，若持续下滑 7 天则升级为偏弱。'));
            } else if (share && share < 0.3) {
              findings.push(F('info', pf + ' ·『' + c.name + '』份额偏低',
                '最新一天我方份额 ' + fmtPct(share) + '，低于 30%，建议关注。',
                '执行：跟踪' + pf + '『' + c.name + '』趋势，若份额持续下滑则考虑加投流。'));
            }
          });
          platCounts.push(dimSeg(pf, cats.length, weak > cats.length * 0.3, '偏弱 ' + weak));
          if (missing_ours && !cats.length) {
            findings.push(F('info', pf + '·我方产品对照未接数据', 'product-links.json 未含' + pf +'我方产品，导致无法按' + pf +'产品级 ROI 计算「偏弱」判断；当前按 series 兜底判定，整体看起来"全 0"是预期内。', '执行：跑 python gen_product_links.py 生成 product-links.json（或维护 data/product-links.json → products 字段，给每个产品补上 t:{c,g,o,r,...}）。责任人：数据运维。'));
          }
        });
        dimensions.push({ name: '平台品类覆盖', segments: platCounts, note: '各平台品类数与偏弱数' });
        if (!findings.length) findings.push(F('info', '竞品格局健康', '各品类我方 ROI 与份额无明显短板。', '持续监控竞品动向。'));
        return { findings: findings, dimensions: dimensions, subNodes: subNodes };
      }
      // 形态B：扁平化行（竞品分析页 getRows：{platform,category,ours_pct,comp_pct,ours,comp}）
      if (Array.isArray(rows) && rows.length) {
        var f2 = [], sn2 = [], dim2 = [], byPlat = {};
        rows.forEach(function (r) {
          var share = num(r.ours_pct);
          var weak = share < 40;
          if (weak) {
            f2.push(F('warning', (r.platform || '') + ' ·『' + (r.category || '') + '』我方份额偏低',
              '我方份额 ' + (isF(r.ours_pct) ? r.ours_pct + '%' : '—') + (isF(r.comp_pct) ? '、竞品份额 ' + r.comp_pct + '%' : '') + '。',
              '执行：研究该品类竞品主推款与打法，强化我方投流与价格；份额<40% 优先提投流。责任人：运营。',
              (isF(r.ours_pct) ? r.ours_pct + '%' : '—'), [{ name: r.category || '', sub: r.platform || '' }], null, 'comp_weak'));
            sn2.push({ label: (r.category || '') + '·' + (r.platform || ''), severity: 'warning', detail: '份额 ' + (isF(r.ours_pct) ? r.ours_pct + '%' : '—'), metric: isF(r.ours_pct) ? r.ours_pct + '%' : '' });
          }
          var pf = r.platform || '—';
          (byPlat[pf] = byPlat[pf] || { total: 0, weak: 0 }); byPlat[pf].total++; if (weak) byPlat[pf].weak++;
        });
        var seg2 = Object.keys(byPlat).map(function (k) { return dimSeg(k, byPlat[k].total, byPlat[k].weak > byPlat[k].total * 0.3, '偏弱 ' + byPlat[k].weak); });
        dim2.push({ name: '平台品类覆盖', segments: seg2, note: '各平台品类数与偏弱数' });
        if (!f2.length) f2.push(F('info', '竞品格局健康', '各品类我方份额≥40%，无明显短板。', '持续监控竞品动向。'));
        return { findings: f2, dimensions: dim2, subNodes: sn2 };
      }
      return emptyResult('竞品分析');
    }
  };

  /* ════════ 品类分析（数据缺失则提示）════════ */
  DIAGNOSTICS['category-analysis'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('品类分析');
      var decl = arr.filter(function (r) { return r.cls === 'decliner' && isF(r.chg); });
      var findings = [], subNodes = [];
      if (decl.length) {
        var worst = decl.slice().sort(function (a, b) { return a.chg - b.chg; });
        worst.slice(0, 8).forEach(function (r) {
          findings.push(F(decl.length >= 3 ? 'danger' : 'warning', '品类『' + r.name + '』下滑 ' + num(r.chg).toFixed(1) + '%',
            '初/末期日均 ' + num(r.early).toFixed(0) + ' → ' + num(r.late).toFixed(0) + '。',
            '执行：检查该品类流量/价格/竞品动作，必要时调整投流与活动节奏。责任人：运营。',
            num(r.chg).toFixed(1) + '%',
            [{ name: r.name, sub: '下滑' }],
            { board: 'category-analysis', scope: '全平台', filter: '下滑', dMode: '7d', keyword: r.name },
            'category_decline'
          ));
          subNodes.push({ label: r.name, severity: 'warning', detail: '下滑 ' + num(r.chg).toFixed(1) + '%', metric: num(r.chg).toFixed(1) + '%' });
        });
      }
      if (!findings.length) findings.push(F('info', '品类健康', '当前无显著下滑品类。', '维持监控。'));
      return { findings: findings, dimensions: [], subNodes: subNodes };
    }
  };




  /* ════════ 电商工作流（子节点=产品/工单）════════ */
  DIAGNOSTICS['ecom-workflow'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('电商工作流');
      var stuck = arr.filter(function (r) { return r.status === '进行中' && (r.avgPct == null || num(r.avgPct) <= 0); });
      var findings = [], subNodes = [];
      if (stuck.length) {
        findings.push(F('warning', stuck.length + ' 条工单停滞',
          stuck.map(function (r) { return r.product || r.name; }).slice(0, 6).join('、') + ' 进行中但完成度0。',
          '执行：逐条确认负责人与阻塞点，必要时介入推进或重新分配。责任人：项目经理。',
          stuck.length + '条',
          stuck.slice(0, 6).map(function (r) { return { name: r.product || r.name, sub: '停滞' }; })));
      }
      if (!findings.length) findings.push(F('info', '工作流正常', '无停滞工单。', '维持。'));
      return { findings: findings, dimensions: [], subNodes: subNodes };
    }
  };

  /* ════════ 员工协作类（轻量）════════ */
  DIAGNOSTICS['emp-task'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('员工任务');
      var blocked = arr.filter(function (r) { return r.status === '已阻塞'; });
      var od = arr.filter(function (r) { return r.due && r.due < todayStr() && r.status !== '已完成'; });
      var findings = [], subNodes = [];
      if (blocked.length) {
        findings.push(F('danger', blocked.length + ' 个任务被阻塞',
          blocked.map(function (r) { return r.task; }).slice(0, 5).join('、') + '。',
          '执行：联系负责人了解阻塞原因并协调资源（人力/数据/审批）。责任人：主管。', blocked.length + '个',
          blocked.slice(0, 5).map(function (r) { return { name: r.task, sub: '阻塞' }; })));
      }
      if (od.length) {
        findings.push(F('warning', od.length + ' 个任务逾期',
          od.map(function (r) { return r.task; }).slice(0, 5).join('、') + ' 超截止日。',
          '执行：跟进负责人，明确新完成时间。责任人：主管。', od.length + '个'));
      }
      if (!findings.length) findings.push(F('info', '任务健康', '无阻塞/逾期任务。', '维持。'));
      return { findings: findings, dimensions: [], subNodes: subNodes };
    }
  };
  DIAGNOSTICS['emp-daily'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('员工日报');
      var members = {}, latest = {};
      arr.forEach(function (r) { if (r.employee) members[r.employee] = 1; if (r.date) latest[r.employee] = r.date; });
      var mlist = Object.keys(members);
      var missing = mlist.filter(function (e) { return !latest[e]; });
      if (missing.length && mlist.length > 1) {
        return { findings: [F('warning', missing.length + ' 人未提交日报',
          missing.join('、') + ' 暂无日报记录。', '执行：提醒相关员工补齐日报。责任人：主管。', missing.length + '人',
          missing.map(function (n) { return { name: n, sub: '缺日报' }; }))], dimensions: [], subNodes: [] };
      }
      return { findings: [F('info', '日报正常', '日报提交完整。', '维持。')], dimensions: [], subNodes: [] };
    }
  };
  DIAGNOSTICS['emp-performance'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('员工业绩');
      var below = arr.filter(function (r) { return isF(r.target) && num(r.target) > 0 && (num(r.sales) / num(r.target)) < 0.7; });
      if (below.length) {
        return { findings: [F('warning', below.length + ' 人完成率低于70%',
          below.map(function (r) { return r.employee; }).join('、') + ' 业绩完成率不足70%。',
          '执行：单独沟通目标差距与所需支持（流量/培训/资源）。责任人：主管。', below.length + '人',
          below.map(function (r) { return { name: r.employee, sub: (num(r.sales) / num(r.target) * 100).toFixed(0) + '%' }; }))], dimensions: [], subNodes: [] };
      }
      return { findings: [F('info', '业绩正常', '员工业绩完成率达标。', '维持。')], dimensions: [], subNodes: [] };
    }
  };
  DIAGNOSTICS['dept-members'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('部门成员');
      var off = arr.filter(function (r) { return /离职|试用/.test(r.status || ''); });
      if (off.length) {
        return { findings: [F('info', off.length + ' 人非在职',
          off.map(function (r) { return r.name + '(' + r.status + ')'; }).join('、'),
          '执行：确认离职人员工作交接是否完成。责任人：HR。', off.length + '人',
          off.map(function (r) { return { name: r.name, sub: r.status }; }))], dimensions: [], subNodes: [] };
      }
      return { findings: [F('info', '人员正常', '部门成员均在职。', '维持。')], dimensions: [], subNodes: [] };
    }
  };

  window.DIAGNOSTICS = DIAGNOSTICS;
  window.DIAG_UTIL = { num: num, isF: isF, parseKV: parseKV, latestDate: latestDate, fmtMoney: fmtMoney, fmtPct: fmtPct, todayStr: todayStr };
})();


/* === diagnosis.js === */
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


/* === deep-link.js === */
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


/* === home-health.js === */
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
    { id: 'ecom-workflow',      icon: '🔄', href: 'board.html?id=ecom-workflow',        name: '电商工作流' },
    { id: 'competition-analysis',icon: '⚔️', href: 'competition-analysis.html',         name: '竞品分析' },
    { id: 'category-analysis',  icon: '🗂', href: 'category-analysis.html',              name: '品类分析' },
    { id: 'emp-task',           icon: '✅', href: 'board.html?id=emp-task',             name: '员工任务' },
    { id: 'dept-members',       icon: '🏢', href: 'board.html?id=dept-members',         name: '部门成员' }
  ];
  var DATA_FILES = {
    'daily-pulse': 'data/daily-pulse.json',
    'sales-alert': 'data/sales-alert.json',
    'ad-roi': 'data/ad-roi.json',
    'product-links': 'data/product-links.json',
    'ecom-workflow': null,         // ⚠️ 未接数据源（电商工作流尚未接入飞书 Base，回本周期测算器独立可用）
    'competition-analysis': 'data/competition.json',
    'category-analysis': 'data/category-analysis.json',
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


/* === web-sync.js === */
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
        'daily-pulse', 'sales-alert', 'sales-alert-ship-detail',
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


/* === auth.js === */
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


/* === chat-widget.js === */
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
