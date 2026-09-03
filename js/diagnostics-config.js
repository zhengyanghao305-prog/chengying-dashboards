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

  /* ════════ 数据抓取中心（子节点=数据源）════════ */
  DIAGNOSTICS['data-sync'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('数据同步');
      var err = arr.filter(function (r) { return r.state === 'error' || /失败|未配置|错误/.test(r.note || '') || /失败|错误/.test(r.state || ''); });
      var stale = arr.filter(function (r) {
        if (!r.lastSync || r.state === 'idle') return false;
        var d = new Date(String(r.lastSync).replace(/-/g, '/'));
        if (isNaN(d)) return false;
        return Math.round((new Date() - d) / 3600000) > 48;
      });
      var findings = [], subNodes = [];
      if (err.length) {
        var names = err.map(function (r) { return r.source; });
        var reason = (err[0] && err[0].note) || '';
        findings.push(F('danger', err.length + ' 个数据源同步失败',
          names.join('、') + ' 同步出错。' + (reason ? ' 典型原因：' + String(reason).slice(0, 80) : ''),
          '执行：打开 connectors.html 逐源点击「重试」；未配置凭据的（如旺店通 sid/appkey）先补全再同步；重试后仍失败则查后端日志。责任人：数据运维。',
          err.length + '个',
          err.map(function (r) { return { name: r.source, sub: '失败' }; }),
          null, 'sync_error'));
        err.forEach(function (r) { subNodes.push({ label: r.source, severity: 'danger', detail: r.note || '同步失败', metric: '✗' }); });
      }
      if (stale.length) {
        findings.push(F('warning', stale.length + ' 个数据源超48小时未同步',
          stale.map(function (r) { return r.source; }).join('、') + ' 长时间未同步，下游报表可能过期。',
          '执行：手动触发这些源同步或检查定时调度是否停止。责任人：数据运维。', stale.length + '个',
          [], null, 'sync_stale'));
      }
      if (!findings.length) findings.push(F('info', '数据同步正常', '所有数据源同步成功且时效正常。', '维持定时调度。'));
      return { findings: findings, dimensions: [], subNodes: subNodes };
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

  /* ════════ 新品项目追踪（子节点=产品）════════ */
  DIAGNOSTICS['product-pipeline'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('新品追踪');
      var t = todayStr();
      var overdue = arr.filter(function (r) { return r.planDue && r.planDue < t && !r.actualDue; });
      var soon = arr.filter(function (r) {
        if (!r.planDue || r.actualDue) return false;
        var diff = Math.ceil((new Date(r.planDue) - new Date(t)) / 86400000);
        return diff > 0 && diff <= 7;
      });
      var findings = [], subNodes = [];
      if (overdue.length) {
        findings.push(F('danger', overdue.length + ' 个新品项目逾期',
          overdue.map(function (r) { return r.product + '(' + (r.cycle || '') + ')'; }).slice(0, 6).join('、') + ' 等超过计划完成日仍未完成。',
          '执行：逐项目列卡点（样品/素材/上架/投流），明确阻塞与责任人，本周内给出新完成时间。责任人：项目经理。',
          overdue.length + '个',
          overdue.slice(0, 6).map(function (r) { return { name: r.product, sub: r.planDue }; }),
          null, 'pipeline_overdue'));
        overdue.slice(0, 10).forEach(function (r) {
          subNodes.push({ label: r.product, severity: 'danger', detail: '逾期 · 计划 ' + r.planDue + ' · ' + (r.owner || ''), metric: '逾期' });
        });
      }
      if (soon.length) {
        findings.push(F('warning', soon.length + ' 个项目7天内到期',
          soon.map(function (r) { return r.product; }).slice(0, 6).join('、') + ' 即将到期。',
          '执行：加快临近项目子任务推进，避免逾期。责任人：对应负责人。', soon.length + '个'));
      }
      if (!findings.length) findings.push(F('info', '新品推进正常', '无逾期/临期项目。', '维持节奏。'));
      return { findings: findings, dimensions: [], subNodes: subNodes };
    }
  };

  /* ════════ 自动化运行日志（子节点=任务）════════ */
  DIAGNOSTICS['automation-log'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('自动化日志');
      var recent = arr.slice(-12);
      var err = recent.filter(function (r) { return /error|failed|失败|异常/.test(r.status || r.status_label || ''); });
      var pending = recent.filter(function (r) { return /pending_data|待数据|等待/.test(r.status || r.status_label || ''); });
      var findings = [], subNodes = [];
      if (err.length) {
        findings.push(F(err.length >= 3 ? 'danger' : 'warning', '近期 ' + err.length + ' 次自动化运行失败',
          '最近 ' + recent.length + ' 次运行中 ' + err.length + ' 次失败' + (pending.length ? '，' + pending.length + ' 次待数据' : '') + '。',
          '执行：点开失败记录看步骤摘要，多为上游数据/编码问题；修复后重跑对应同步任务。责任人：数据运维。',
          err.length + '次',
          err.slice(0, 5).map(function (r) { return { name: (r.task || '').replace('同步 ', ''), sub: (r.ts || '').slice(5, 16) }; })));
        err.slice(0, 6).forEach(function (r) {
          subNodes.push({ label: (r.task || '') + ' · ' + (r.trigger || ''), severity: 'danger', detail: r.summary || r.details || '失败', metric: '✗' });
        });
      } else if (pending.length) {
        findings.push(F('warning', pending.length + ' 次运行等待数据',
          '近期多次"需补数据重跑"，数据链路可能中断。',
          '执行：检查上游数据源（飞书 Base/旺店通）是否还有新数据未抓取。责任人：数据运维。', pending.length + '次'));
      } else {
        findings.push(F('info', '自动化运行健康', '近期运行无失败。', '维持定时调度。'));
      }
      return { findings: findings, dimensions: [], subNodes: subNodes };
    }
  };

  /* ════════ 自动化项目管理（子节点=项目）════════ */
  DIAGNOSTICS['automation-projects'] = {
    analyze: function (rows) {
      var arr = rows || [];
      if (!arr.length) return emptyResult('自动化项目');
      var bad = arr.filter(function (r) { return /异常|部分|等待/.test(r.outputStatus || ''); });
      var stopped = arr.filter(function (r) { return /已暂停|待启动/.test(r.status || ''); });
      var findings = [], subNodes = [];
      if (bad.length) {
        findings.push(F('warning', bad.length + ' 个自动化输出异常/不完整',
          bad.map(function (r) { return r.name; }).join('、') + ' 输出状态异常或部分/等待。',
          '执行：查看自动化日志修复输出不完整的任务，确认依赖数据是否到位。责任人：数据运维。',
          bad.length + '个',
          bad.map(function (r) { return { name: r.name, sub: r.outputStatus }; })));
      }
      if (stopped.length) {
        findings.push(F('info', stopped.length + ' 个自动化未运行',
          stopped.map(function (r) { return r.name; }).join('、') + ' 处于已暂停/待启动。',
          '执行：确认是否需要恢复运行。责任人：数据运维。', stopped.length + '个'));
      }
      if (!findings.length) findings.push(F('info', '自动化项目健康', '所有自动化输出完整且在运行。', '维持。'));
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
