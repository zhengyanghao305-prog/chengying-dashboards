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
const Store = {
  KEY: function (id) { return 'wb:data:' + id; },

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

    // 浏览器模式：localStorage
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

    // 浏览器模式：localStorage
    try {
      localStorage.setItem(Store.KEY(id), JSON.stringify(rows));
      return true;
    } catch (e) {
      console.error('[Store] 写入失败', id, e);
      alert('保存失败：本地存储可能已满或被禁用。');
      return false;
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
      const resp = await fetch(url);
      if (!resp.ok) { console.warn('[Store] 预置文件不存在或不可读:', url); return false; }
      const data = await resp.json();
      if (!Array.isArray(data)) { console.warn('[Store] 预置文件格式非数组:', url); return false; }
      Store.set(id, data);
      console.log('[Store] 板块', id, '从预置文件加载了', data.length, '条记录');
      return true;
    } catch (e) {
      console.warn('[Store] 预置加载失败:', id, e.message);
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
      const resp = await fetch(url);
      if (!resp.ok) return false;
      const data = await resp.json();
      if (!Array.isArray(data)) return false;
      Store.set(id, data);
      console.log('[Store] 板块', id, '强制刷新为', data.length, '条');
      return true;
    } catch (e) {
      console.warn('[Store] 强制刷新失败:', id, e.message);
      return false;
    }
  }
};
