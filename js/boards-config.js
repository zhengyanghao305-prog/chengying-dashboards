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

  /* —— 组3：供应链中心 —— */
  'product-pipeline': {
    num: 7, title: '新品项目追踪', subtitle: 'Product Pipeline', group: '供应链中心',
    accent: 'green', status: 'live', icon: '🆕',
    desc: '新品从立项到盈利的全项目管控（基建期→打品期→盈利期）',
    future: '收集反馈 → 判断责任人 → 写入飞书 Base → 加速推进',
    filterGroups: [
      { key: 'cycle', label: '周期' },
      { key: 'platform', label: '平台', options: ['拼多多', '天猫'] }
    ],
    fields: [
      { key: 'product', label: '产品', type: 'text', width: 130 },
      { key: 'cycle', label: '周期', type: 'select', options: ['基建期', '打品期', '盈利期'], width: 90 },
      { key: 'stage', label: '环节', type: 'select', width: 190, options: [
        '基建期·市场调研', '基建期·竞品确认', '基建期·产品图册', '基建期·链接素材',
        '基建期·样品', '基建期·成本', '基建期·编码', '基建期·库存',
        '基建期·产品手册', '基建期·客服同步', '基建期·上架准备',
        '打品期·测款验证', '打品期·投流自动化', '打品期·评价口碑',
        '打品期·活动节奏', '打品期·监控预警工单', '打品期·打品复盘',
        '盈利期·销售BI', '盈利期·利润BI', '盈利期·库存周转BI',
        '盈利期·竞品市场BI', '盈利期·盈利预警决策'
      ] },
      { key: 'subtasks', label: '子任务', type: 'computed', width: 110, compute: function(r) {
        var s = r.subtasks || {}; var ks = Object.keys(s).filter(function(k){ return k.charAt(0) !== '_'; });
        if (!ks.length) return '—';
        var d = ks.filter(function(k){ return s[k]; }).length;
        return d + '/' + ks.length;
      } },
      { key: 'owner', label: '负责人', type: 'text', width: 90 },
      { key: 'planDue', label: '计划完成', type: 'date', width: 120 },
      { key: 'actualDue', label: '实际完成', type: 'date', width: 120 },
      { key: 'status', label: '状态', type: 'computed', width: 110, compute: function(r) {
        var d = new Date();
        var t = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        var s = r.subtasks || {}; var ks = Object.keys(s).filter(function(k){ return k.charAt(0) !== '_'; });
        var done = r.actualDue || (r.subtasks && r.subtasks._done) || (ks.length && ks.every(function(k){ return s[k]; }));
        if (done) return '<span style="color:#15803d;font-weight:600">✅ 完成</span>';
        if (r.planDue && r.planDue < t) return '<span style="color:#dc2626;font-weight:600">🔴 逾期</span>';
        if (r.planDue) { var diff = Math.ceil((new Date(r.planDue) - new Date(t)) / 86400000); if (diff <= 7) return '<span style="color:#d97706;font-weight:600">⚠️ 即将到期</span>'; }
        var any = ks.some(function(k){ return s[k]; });
        if (any || (r.subtasks && r.subtasks._started)) return '<span style="color:#6b7280;font-weight:600">➡️ 进行中</span>';
        return '<span style="color:#9ca3af;font-weight:600">⚪ 未开始</span>';
      } },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },







  /* —— 组5：知识系统 —— */
  'automation-log': {
    num: 14, title: '自动化运行日志', subtitle: 'Automation Log', group: '知识系统',
    accent: 'green', status: 'live', icon: '📝',
    desc: '每次自动运行都记一笔：正常 / 需补数据重跑 / 出错',
    future: '由 sync_board_data.py / gen_weekly_report.py 自动写入 data/automation-log.json',
    isLog: true,   // 标记：运行日志专用渲染（彩色状态 + 步骤详情）
    filterGroups: [
      { key: 'task', label: '任务类型', options: ['同步 店铺日报','同步 销售分析与预警','同步 推广投放 ROI','同步 BI销售分析与预警','生成周报'] },
      { key: 'status', label: '状态', options: [{val:'success',label:'✅ 正常'},{val:'error',label:'❌ 失败'},{val:'pending_data',label:'⏳ 待数据'}] }
    ],
    fields: [
      { key: 'ts', label: '时间', type: 'text', width: 150 },
      { key: 'task', label: '任务', type: 'text', width: 140 },
      { key: 'trigger', label: '自动化名称', type: 'text', width: 180 },
      { key: 'status', label: '状态', type: 'status', width: 100 },
      { key: 'summary', label: '摘要', type: 'text' }
    ]
    // 完整输出：点「📂 查看产出」跳转到对应板块查看
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
  /* —— 组5：知识系统 —— 自动化项目管理 */
  'automation-projects': {
    num: 21, title: '自动化项目管理', subtitle: 'Auto Projects', group: '知识系统',
    accent: 'indigo', status: 'live', icon: '🤖',
    desc: '所有自动化任务一览：版本·状态·输出质量',
    future: '由 sync_board_data.py 末尾自动调用 sync_auto_projects.py 聚合更新',
    isLog: false,
    filterGroups: [
      { key: 'board', label: '所属模块' },
      { key: 'outputStatus', label: '输出状态' },
      { key: 'status', label: '运行状态' }
    ],
    fields: [
      { key: 'name', label: '项目名称', type: 'text', width: 240 },
      { key: 'board', label: '模块', type: 'select', width: 90,
        options: ['销售数据', '系统运维', '员工管理'] },
      { key: 'outputStatus', label: '输出状态', type: 'select', width: 100,
        options: ['✅ 完整', '⚠️ 部分', '❌ 异常', '⏳ 等待'] },
      { key: 'status', label: '运行', type: 'select', width: 75,
        options: ['运行中', '已暂停', '待启动', '已完成'] },
      { key: 'version', label: '版本', type: 'text', width: 65 },
      { key: 'iterCount', label: '迭代', type: 'number', width: 60 },
      { key: 'owner', label: '负责人', type: 'text', width: 70 }
    ]
  },

  'data-sync': {
    num: 22, title: '数据抓取中心', subtitle: 'Data Sync Hub', group: '知识系统',
    accent: 'cyan', status: 'live', icon: '🔗',
    desc: '统一编排第三方数据源（卧龙进销存/十速ERP/旺店通），一键抓取并归一化',
    future: '由 connectors/ 后端驱动，connectors.html 触发同步',
    fields: [
      { key: 'source', label: '数据源', type: 'text', width: 140 },
      { key: 'lastSync', label: '最近同步', type: 'text', width: 160 },
      { key: 'records', label: '记录数', type: 'number', width: 90 },
      { key: 'state', label: '状态', type: 'select', width: 90, options: ['ok', 'error', 'idle'] },
      { key: 'note', label: '说明', type: 'text' }
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
