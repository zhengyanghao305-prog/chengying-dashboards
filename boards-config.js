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
    num: 2, title: '销售分析与预警', subtitle: 'Sales & Alert', group: '经营驾驶舱',
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
  },

  'ad-roi': {
    num: 4, title: '推广投放 ROI', subtitle: 'Ad ROI', group: '增长引擎',
    accent: 'rose', status: 'live', icon: '💰',
    desc: '直通车/多多推广花费产出，核心问题不痛一眼看清楚',
    future: '飞书店铺数据日报（天猫3渠道 + 拼多多）→ 每日自动同步',
    filterGroups: [
      { key: 'platform', label: '平台' },
      { key: 'channel', label: '推广渠道' }
    ],
    /* ====== 字段设计说明 ======
     * 数据粒度：一天一平台一渠道 一行记录
     * 天猫拆为3个渠道：关键词推广(直通车) / 全站推广 / 精准人群推广
     * 拆单后每行可独立算 ROI / PPC / CAC，支持按渠道筛选对比
     * KPI概览卡片由 board.html 专属渲染（不在字段里）
     */
    fields: [
      { key: 'date',       label: '日期',         type: 'date',   width: 105 },
      { key: 'platform',   label: '平台',         type: 'select', width: 90,   options: ['天猫', '拼多多'] },
      { key: 'channel',    label: '推广渠道',      type: 'select', width: 140,
        options: ['关键词推广(直通车)', '全站推广', '精准人群推广', '多多推广', '场景推广', '搜索推广'] },
      // —— 投入指标 ——
      { key: 'cost',       label: '花费(元)',     type: 'number', width: 100 },
      { key: 'cost_pct',   label: '占总花费%',    type: 'computed', width: 95,
        compute: function(r, all) {
          var c = parseFloat(r.cost)||0;
          if (!all || !all.length) return '—';
          var total = all.reduce(function(s,x){ return s+(parseFloat(x.cost)||0); },0);
          return total ? (c/total*100).toFixed(1)+'%' : '—';
        }
      },
      // —— 产出指标 ——
      { key: 'gmv',        label: '带来成交(元)',  type: 'number', width: 120 },
      { key: 'orders',     label: '带来订单数',    type: 'number', width: 100 },
      { key: 'buyers',     label: '带来买家数',    type: 'number', width: 100 },
      // —— 效率指标（computed）——
      { key: 'roi',        label: 'ROI',           type: 'computed', width: 80,
        compute: function(r) {
          var c=parseFloat(r.cost), g=parseFloat(r.gmv);
          return (c&&g) ? (g/c).toFixed(2) : '—';
        }
      },
      { key: 'ppc',        label: 'PPC(元)',       type: 'computed', width: 90,
        compute: function(r) {
          var c=parseFloat(r.cost), clicks=parseInt(r.clicks)||0;
          return (c&&clicks) ? (c/clicks).toFixed(2) : '—';
        }
      },
      { key: 'cac',        label: '获客成本(元)',  type: 'computed', width: 110,
        compute: function(r) {
          var c=parseFloat(r.cost), b=parseInt(r.buyers)||0;
          return (c&&b) ? (c/b).toFixed(1) : '—';
        }
      },
      { key: 'cvr',        label: '渠道转化率',    type: 'computed', width: 100,
        compute: function(r) {
          var b=parseInt(r.buyers)||0, v=parseInt(r.visitors)||0;
          return (v&&b) ? (b/v*100).toFixed(2)+'%' : '—';
        }
      },
      // —— 趋势 & 预警（computed，需全量数据）——
      { key: 'roi_change', label: 'ROI环比',       type: 'computed', width: 95,
        __needsAllData: true,
        compute: function(r, all) {
          if (!all || !all.length) return '<span style="color:#9ca3af">—</span>';
          var same = all.filter(function(x){
            return x.platform===r.platform && x.channel===r.channel;
          }).sort(function(a,b){ return (a.date||'').localeCompare(b.date||''); });
          var idx = same.findIndex(function(x){
            return (x.date||'')===(r.date||'') && (x.channel||'')===(r.channel||'');
          });
          if (idx<=0) return '<span style="color:#9ca3af">—</span>';
          var prevRoi = same[idx-1];
          if (!prevRoi) return '<span style="color:#9ca3af">—</span>';
          var cur = parseFloat(r.gmv)/parseFloat(r.cost);
          var prev = parseFloat(prevRoi.gmv)/parseFloat(prevRoi.cost);
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
          var roi = parseFloat(r.gmv)/parseFloat(r.cost);
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
      // —— 原始字段（用于计算，表格中可隐藏）——
      { key: 'visitors',   label: '展示/访客数',   type: 'number', width: 110 },
      { key: 'clicks',     label: '点击数',        type: 'number', width: 90 },
      { key: 'note',       label: '备注',          type: 'text',   width: 160 }
    ]
  },

  'competitor': {
    num: 5, title: '竞品雷达', subtitle: 'Competitor Radar', group: '增长引擎',
    accent: 'cyan', status: 'pending', icon: '🛰️',
    desc: '对标店铺一举一动看得见',
    future: '店透视类工具 / 手动维护对标清单',
    fields: [
      { key: 'name', label: '竞品名', type: 'text', width: 120 },
      { key: 'platform', label: '平台', type: 'select', options: ['拼多多', '天猫'] },
      { key: 'dim', label: '监控维度', type: 'select', options: ['价格', '活动', '排名', '评价'] },
      { key: 'ours', label: '我方值', type: 'text', width: 100 },
      { key: 'theirs', label: '竞品值', type: 'text', width: 100 },
      { key: 'gap', label: '差距', type: 'text', width: 90 },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },

  'ecom-workflow': {
    num: 6, title: '电商自动化工作流', subtitle: 'E-com Workflow', group: '增长引擎',
    accent: 'red', status: 'pending', icon: '🔄',
    desc: '从市场到回本的全链路自动化管理',
    future: '飞书 Base + 各平台后台',
    extraTool: 'payback.html',
    extraToolLabel: '回本周期测算器',
    fields: [
      { key: 'stage', label: '环节', type: 'select',
        options: ['市场数据分析', '客户需求分析', '打品计划', '回本周期测算', '自动化流转'] },
      { key: 'status', label: '状态', type: 'select', options: ['待启动', '进行中', '已完成', '已暂停'] },
      { key: 'owner', label: '负责人', type: 'text', width: 90 },
      { key: 'due', label: '截止日', type: 'date' },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },

  /* —— 组3：供应链中心 —— */
  'product-pipeline': {
    num: 7, title: '新品项目追踪', subtitle: 'Product Pipeline', group: '供应链中心',
    accent: 'green', status: 'pending', icon: '🆕',
    desc: '新品从立项到上架的全项目管控',
    future: '收集反馈 → 判断责任人 → 写入 Base → 加速推进',
    fields: [
      { key: 'name', label: '产品名', type: 'text', width: 130 },
      { key: 'phase', label: '阶段', type: 'select', options: ['立项', '打样', '定样', '测款', '上架'] },
      { key: 'owner', label: '负责人', type: 'text', width: 90 },
      { key: 'due', label: '截止日', type: 'date' },
      { key: 'risk', label: '风险', type: 'select', options: ['低', '中', '高'] },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },

  'supply-chain': {
    num: 8, title: '供应链', subtitle: 'Supply Chain', group: '供应链中心',
    accent: 'gray', status: 'pending', icon: '📦',
    desc: '备货计划与产销协调',
    future: 'ERP / 进销存',
    fields: [
      { key: 'sku', label: 'SKU', type: 'text', width: 140 },
      { key: 'stock', label: '当前库存', type: 'number', width: 100 },
      { key: 'safe', label: '安全库存', type: 'number', width: 100 },
      { key: 'turn', label: '周转天数', type: 'number', width: 100 },
      { key: 'suggest', label: '补货建议', type: 'select', options: ['充足', '需关注', '紧急补货'] },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },

  'logistics': {
    num: 9, title: '物流发货', subtitle: 'Logistics', group: '供应链中心',
    accent: 'orange', status: 'pending', icon: '🚚',
    desc: '从发货到签收的成本与服务管理',
    future: '快递专家 / 物流系统',
    fields: [
      { key: 'date', label: '日期', type: 'date' },
      { key: 'courier', label: '快递', type: 'select', options: ['圆通', '中通', '韵达', '顺丰', '其他'] },
      { key: 'qty', label: '单量', type: 'number', width: 90 },
      { key: 'abn', label: '异常数', type: 'number', width: 90 },
      { key: 'abnNote', label: '异常说明', type: 'text' }
    ]
  },

  /* —— 组4：组织协同 —— */
  'crm': {
    num: 10, title: '客户关系', subtitle: 'Customer CRM', group: '组织协同',
    accent: 'purple', status: 'pending', icon: '🤝',
    desc: '1688 客户全生命周期管理',
    future: '你来定方向（1688 后台 / 飞书 Base）',
    fields: [
      { key: 'name', label: '客户名', type: 'text', width: 130 },
      { key: 'source', label: '来源', type: 'select', options: ['1688', '天猫', '拼多多', '其他'] },
      { key: 'level', label: '等级', type: 'select', options: ['A', 'B', 'C', '风险'] },
      { key: 'status', label: '跟进状态', type: 'select', options: ['跟进中', '已成交', '已流失', '待激活'] },
      { key: 'owner', label: '负责人', type: 'text', width: 90 },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },

  'team': {
    num: 11, title: '部门成员管理', subtitle: 'Team Hub', group: '组织协同',
    accent: 'purple', status: 'pending', icon: '👥',
    desc: '谁负责什么、进度在哪，一查便知',
    future: '飞书通讯录 / 审批',
    fields: [
      { key: 'name', label: '姓名', type: 'text', width: 90 },
      { key: 'role', label: '角色', type: 'text', width: 120 },
      { key: 'boards', label: '负责板块', type: 'text' },
      { key: 'status', label: '状态', type: 'select', options: ['在职', '请假', '出差'] },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },

  'cross-dept': {
    num: 12, title: '跨部门协调', subtitle: 'Cross-dept', group: '组织协同',
    accent: 'orange', status: 'pending', icon: '🔗',
    desc: '需求流转中枢，别让事卡在中间',
    future: '飞书任务 / 多维表格',
    fields: [
      { key: 'req', label: '需求', type: 'text' },
      { key: 'from', label: '提出方', type: 'text', width: 90 },
      { key: 'to', label: '接收方', type: 'text', width: 90 },
      { key: 'status', label: '状态', type: 'select', options: ['待接收', '处理中', '已完成', '已阻塞'] },
      { key: 'due', label: '截止日', type: 'date' },
      { key: 'note', label: '备注', type: 'text' }
    ]
  },

  'knowledge': {
    num: 13, title: '知识资产', subtitle: 'Knowledge Base', group: '知识系统',
    accent: 'pink', status: 'pending', icon: '📚',
    desc: '公司信息一查便知，不用翻文档',
    future: '长期记忆 / 飞书知识库',
    fields: [
      { key: 'title', label: '标题', type: 'text', width: 150 },
      { key: 'type', label: '类型', type: 'select', options: ['产品参数', '价格体系', '制度文档', '供应商'] },
      { key: 'loc', label: '位置/链接', type: 'text' },
      { key: 'owner', label: '负责人', type: 'text', width: 90 },
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

// 便捷查询：按 id 取配置，取不到返回 null
function getBoard(id) {
  return BOARDS[id] || null;
}
