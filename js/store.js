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
