'use strict';
/** 业务算法：SPC、CP 自动映射、差异对比、看板汇总 */
const DB = require('./db');
const { apLookup, computeGRR, hash, now } = DB;

function measurementSystems(projectId) {
  const today = now().slice(0, 10);
  return DB.listMsaPlans(projectId).filter(plan => plan.source_active !== 0).map(plan => {
    const gauge = DB.db.prepare('SELECT * FROM gauge WHERE gauge_id=?').get(plan.gauge_id) || {};
    const study = plan.study_id
      ? DB.db.prepare('SELECT studied_at FROM msa_study WHERE study_id=? AND project_id=?').get(plan.study_id, projectId)
      : null;
    return { ...gauge, ...plan, name: `${plan.char_name || plan.char_id} / ${gauge.name || plan.gauge_id}`,
      last_pct: plan.study_result, pct: plan.study_result, last_at: study?.studied_at || null,
      qualified: plan.status === '已完成' && plan.study_status === '已完成' && plan.study_judgment === '接受'
        && plan.source_status === '有效' && !['报废', '停用'].includes(gauge.status)
        && !!gauge.calibration_due && gauge.calibration_due >= today };
  });
}
const D2 = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078 };
const A2 = { 2: 1.880, 3: 1.023, 4: 0.729, 5: 0.577, 6: 0.483, 7: 0.419, 8: 0.373, 9: 0.337, 10: 0.308 };
const D3 = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0.076, 8: 0.136, 9: 0.184, 10: 0.223 };
const D4 = { 2: 3.267, 3: 2.574, 4: 2.282, 5: 2.114, 6: 2.004, 7: 1.924, 8: 1.864, 9: 1.816, 10: 1.777 };
const A3 = { 2: 2.659, 3: 1.954, 4: 1.628, 5: 1.427, 6: 1.287, 7: 1.182, 8: 1.099, 9: 1.032, 10: 0.975 };
const C4 = { 2: 0.7979, 3: 0.8862, 4: 0.9213, 5: 0.9400, 6: 0.9515, 7: 0.9594, 8: 0.9650, 9: 0.9693, 10: 0.9727 };
const B3 = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0.030, 7: 0.118, 8: 0.185, 9: 0.239, 10: 0.284 };
const B4 = { 2: 3.267, 3: 2.568, 4: 2.266, 5: 2.089, 6: 1.970, 7: 1.882, 8: 1.815, 9: 1.761, 10: 1.716 };

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

function runRules(values, center, sigma, label = '点', ucl = null, lcl = null) {
  const violations = [];
  const EPS = 1e-9;
  const upper = ucl == null ? center + 3 * sigma : ucl;
  const lower = lcl == null ? center - 3 * sigma : lcl;
  // Q-05：恰好落在控制限上的点也应判异（浮点用 1e-9 容差）。
  // 零变差时上下限重合，无控制意义，不产生“每点都超限”的噪声。
  if (upper > lower + EPS) {
    values.forEach((value, index) => {
      if (value >= upper - EPS) violations.push({ i: index, type: `${label}达到/超出 UCL`, v: +value.toFixed(4) });
      if (value <= lower + EPS) violations.push({ i: index, type: `${label}达到/低于 LCL`, v: +value.toFixed(4) });
    });
  }
  // Q-05：等于中心线的点不属于任何一侧，必须重置连续计数，不能算作“低侧”
  const sideOf = value => value > center + EPS ? 1 : value < center - EPS ? -1 : 0;
  let run = 0;
  let runSide = 0;
  for (let i = 0; i < values.length; i += 1) {
    const side = sideOf(values[i]);
    if (!side) { run = 0; runSide = 0; continue; }
    if (side === runSide) run += 1;
    else { runSide = side; run = 1; }
    if (run >= 7) { violations.push({ i, type: `连续 7 点位于中心线同一侧（${label}）` }); run = 0; runSide = 0; }
  }
  for (let i = 0; i < values.length; i += 1) {
    const side = value => value > center ? 1 : value < center ? -1 : 0;
    if (i >= 5) {
      const deltas = values.slice(i - 5, i + 1)
        .map((value, index, arr) => index ? value - arr[index - 1] : 0).slice(1);
      if (deltas.every(delta => delta > 0)) violations.push({ i, type: `连续 6 点递增（${label}）` });
      if (deltas.every(delta => delta < 0)) violations.push({ i, type: `连续 6 点递减（${label}）` });
    }
    if (i >= 13) {
      const deltas = values.slice(i - 13, i + 1)
        .map((value, index, arr) => index ? value - arr[index - 1] : 0).slice(1);
      if (deltas.every((delta, index) => index === 0 || Math.sign(delta) !== Math.sign(deltas[index - 1]))) {
        violations.push({ i, type: `连续 14 点上下交替（${label}）` });
      }
    }
    const sideSign = side(values[i]);
    if (i >= 2 && sigma > 0) {
      const outside2 = values.slice(i - 2, i + 1).filter(value =>
        sideSign && side(value) === sideSign && Math.abs(value - center) > 2 * sigma).length;
      if (outside2 >= 2) violations.push({ i, type: `3 点中有 2 点超出 2σ 同侧（${label}）` });
    }
    if (i >= 4 && sigma > 0) {
      const outside1 = values.slice(i - 4, i + 1).filter(value =>
        sideSign && side(value) === sideSign && Math.abs(value - center) > sigma).length;
      if (outside1 >= 4) violations.push({ i, type: `5 点中有 4 点超出 1σ 同侧（${label}）` });
    }
    // Q-05：恰在 1σ 上的点同时满足“以内”和“以外”，两类规则都按闭区间处理
    if (i >= 14 && sigma > 0
        && values.slice(i - 14, i + 1).every(value => Math.abs(value - center) <= sigma + EPS)) {
      violations.push({ i, type: `连续 15 点位于 1σ 以内（${label}）` });
    }
    if (i >= 7 && sigma > 0
        && values.slice(i - 7, i + 1).every(value => Math.abs(value - center) >= sigma - EPS)) {
      violations.push({ i, type: `连续 8 点位于 1σ 以外（${label}）` });
    }
  }
  return violations;
}

/**
 * 报表与界面统一的数值显示精度。
 * - 小数最多保留 maxDecimals 位（默认 6），避免浮点尾差（如 0.0165472068000000037）直接外露；
 * - 整数部分越长，允许的小数位越少，保证单个数值不超过约 14 个字符；
 * - 极小/极大值改用科学计数法，避免被四舍五入成 0 或撑破表格列宽。
 * 返回 number（无效值返回空串），便于 Excel 仍按数值单元格写入。
 */
function displayNumber(value, maxDecimals = 6) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 0;
  const abs = Math.abs(n);
  // 6 位小数以下或 1e12 以上：保留 6 位有效数字，交给 Excel/Word 以科学计数法显示
  if (abs < 1e-6 || abs >= 1e12) return +n.toPrecision(6);
  const intDigits = Math.max(1, Math.floor(Math.log10(abs)) + 1);
  // 13 位留给“整数 + 小数点 + 小数”，单个数值不超过 14 个字符
  const decimals = Math.max(0, Math.min(maxDecimals, 13 - intDigits));
  return +n.toFixed(decimals);
}

/** 计算一个数据集的控制图与能力指数 */
function spcCompute(subs, char, options = {}) {
  if (!Array.isArray(subs) || !subs.length || !Array.isArray(subs[0].v) || !subs[0].v.length) {
    throw new Error('SPC 数据集为空或格式错误');
  }
  let chartType = String(options.chartType || 'Xbar-R').toUpperCase();
  if (chartType === 'X-MR') chartType = 'I-MR';
  const subgroupN = subs[0].v.length;
  if (chartType !== 'P' && subs.some(subgroup => !Array.isArray(subgroup.v) || subgroup.v.length !== subgroupN)) {
    throw new Error('SPC 子组大小不一致');
  }
  // Q-01：控制图常数表只到 n=10；超出范围必须显式拒绝，不能静默回退到 n=3/5 的常数
  if (['XBAR-R', 'XBAR-S'].includes(chartType)
      && (!Number.isInteger(subgroupN) || subgroupN < 2 || subgroupN > 10)) {
    throw new Error(`子组大小必须为 2–10 的整数；当前为 ${subgroupN}，不支持自动回退控制图常数`);
  }
  const n = chartType === 'I-MR' || chartType === 'C' ? 1 : subgroupN;
  const labels = subs.map(item => item.t);
  const lsl = char && char.lsl != null ? char.lsl : null;
  const usl = char && char.usl != null ? char.usl : null;
  const tolerance = lsl != null && usl != null ? usl - lsl : null;

  if (chartType === 'P') {
    const pairs = subs.map(item => {
      if (!Array.isArray(item.v) || item.v.length < 2) throw new Error('P 图每行格式应为：不良数, 样本数');
      const defectives = +item.v[0], sampleSize = +item.v[1];
      if (!Number.isFinite(defectives) || !Number.isFinite(sampleSize) || sampleSize <= 0
          || defectives < 0 || defectives > sampleSize) throw new Error('P 图不良数和样本数不合法');
      return { defectives, sampleSize, p: defectives / sampleSize };
    });
    const totalDefects = pairs.reduce((sum, item) => sum + item.defectives, 0);
    const totalSamples = pairs.reduce((sum, item) => sum + item.sampleSize, 0);
    const center = totalDefects / totalSamples;
    const series = pairs.map(item => item.p);
    const ucls = pairs.map(item => center + 3 * Math.sqrt(center * (1 - center) / item.sampleSize));
    const lcls = pairs.map(item => Math.max(0, center - 3 * Math.sqrt(center * (1 - center) / item.sampleSize)));
    // Q-06：每个点用自己的 σ_i 判定区域规则；不能再用“最大样本量”的单一 σ。
    const violations = [];
    series.forEach((value, index) => {
      const sigmaI = Math.sqrt(center * (1 - center) / pairs[index].sampleSize);
      runRules(series.slice(0, index + 1), center, sigmaI, '不良率', ucls[index], lcls[index])
        .filter(item => item.i === index)
        .forEach(item => violations.push(item));
    });
    return {
      method: 'P 图（不良率）', chartType, n: 2, labels,
      // 显示值在计算边界统一取有效位数，避免 0.0165472068000000037 这类浮点尾差进入页面/导出
      series: series.map(value => displayNumber(value)),
      observations: series,
      seriesUcl: ucls.map(value => displayNumber(value)),
      seriesLcl: lcls.map(value => displayNumber(value)),
      center: displayNumber(center), ucl: displayNumber(Math.max(...ucls)),
      lcl: displayNumber(Math.min(...lcls)),
      Xbb: +center.toFixed(6), Rb: null, sigmaWithin: null, sigmaOverall: null,
      cp: null, cpk: null, ppk: null, violations, diagnostics: [],
      controlMethod: 'P 图：CL=总不良数/总样本数，逐点控制限与 σ_i 按各子组样本量计算',
      rangeVsSpecPct: null, secondary: null,
    };
  }

  if (chartType === 'C') {
    const series = subs.map(item => {
      const value = +item.v[0];
      if (!Number.isFinite(value) || value < 0) throw new Error('C 图缺陷数必须为非负数值');
      return value;
    });
    const center = mean(series);
    const sigma = Math.sqrt(center);
    const ucl = center + 3 * sigma;
    const lcl = Math.max(0, center - 3 * sigma);
    return {
      method: 'C 图（缺陷数）', chartType, n: 1, labels,
      series: series.map(value => displayNumber(value)),
      observations: series,
      seriesUcl: series.map(() => displayNumber(ucl)), seriesLcl: series.map(() => displayNumber(lcl)),
      center: displayNumber(center), ucl: displayNumber(ucl), lcl: displayNumber(lcl),
      Xbb: +center.toFixed(4), Rb: null,
      sigmaWithin: +sigma.toFixed(5), sigmaOverall: +sd(series).toFixed(5),
      cp: null, cpk: null, ppk: null,
      violations: runRules(series, center, sigma, '缺陷数', ucl, lcl),
      diagnostics: [], controlMethod: 'C 图：CL=c̄，UCL/LCL=c̄±3√c̄', rangeVsSpecPct: null, secondary: null,
    };
  }

  if (chartType === 'I-MR') {
    const series = subs.map(item => mean(item.v));
    // 单个点没有移动极差，MR̄ 会是 NaN 并扩散到控制限与判异，必须显式拒绝
    if (series.length < 2) throw new Error('I-MR 图至少需要 2 个数据点');
    const movingRange = series.slice(1).map((value, index) => Math.abs(value - series[index]));
    const center = mean(series);
    const mrBar = mean(movingRange);
    const sigmaWithin = mrBar / 1.128;
    const ucl = center + 2.66 * mrBar;
    const lcl = center - 2.66 * mrBar;
    const violations = runRules(series, center, sigmaWithin, '单值');
    if (movingRange.length) {
      const uclMr = 3.267 * mrBar;
      movingRange.forEach((value, index) => {
        if (value > uclMr) violations.push({ i: index + 1, type: '移动极差超出 UCL', v: +value.toFixed(4) });
      });
    }
    return {
      method: 'I-MR 图（单值-移动极差）', chartType, n: 1, labels,
      series: series.map(value => displayNumber(value)),
      observations: series,
      seriesUcl: series.map(() => displayNumber(ucl)), seriesLcl: series.map(() => displayNumber(lcl)),
      center: displayNumber(center), ucl: displayNumber(ucl), lcl: displayNumber(lcl),
      Xbb: +center.toFixed(4), Rb: +mrBar.toFixed(4),
      sigmaWithin: +sigmaWithin.toFixed(5), sigmaOverall: +sd(series).toFixed(5),
      cp: tolerance != null && sigmaWithin > 0 ? +(tolerance / (6 * sigmaWithin)).toFixed(2) : null,
      cpk: (lsl != null || usl != null) && sigmaWithin > 0 ? +Math.min(
        usl != null ? (usl - center) / (3 * sigmaWithin) : Infinity,
        lsl != null ? (center - lsl) / (3 * sigmaWithin) : Infinity
      ).toFixed(2) : null,
      ppk: (lsl != null || usl != null) && sd(series) > 0 ? +Math.min(
        usl != null ? (usl - center) / (3 * sd(series)) : Infinity,
        lsl != null ? (center - lsl) / (3 * sd(series)) : Infinity
      ).toFixed(2) : null,
      violations, diagnostics: [],
      controlMethod: 'I-MR：单值 CL=X̄，UCL/LCL=X̄±2.66·MR̄；移动极差 UCL=3.267·MR̄',
      rangeVsSpecPct: tolerance ? +(mrBar / tolerance * 100).toFixed(1) : null,
      secondary: {
        title: '移动极差 MR',
        values: movingRange.map(value => displayNumber(value)),
        labels: labels.slice(1),
        center: displayNumber(mrBar),
        ucl: displayNumber(3.267 * mrBar),
        lcl: 0,
      },
    };
  }

  const xb = subs.map(s => mean(s.v));
  const R = subs.map(s => Math.max(...s.v) - Math.min(...s.v));
  const Xbb = mean(xb);
  const useS = chartType === 'XBAR-S';
  const S = subs.map(subgroup => sd(subgroup.v));
  const secondaryRaw = useS ? S : R;
  const secondaryBar = mean(secondaryRaw);
  // 常数已在入口校验 2–10，直接查表；缺失即编程错误，不再静默回退
  const sigmaWithin = useS ? secondaryBar / C4[n] : secondaryBar / D2[n];
  const uclX = Xbb + (useS ? A3[n] : A2[n]) * secondaryBar;
  const lclX = Xbb - (useS ? A3[n] : A2[n]) * secondaryBar;
  const uclSecondary = useS ? B4[n] * secondaryBar : D4[n] * secondaryBar;
  const lclSecondary = useS ? B3[n] * secondaryBar : D3[n] * secondaryBar;
  const all = subs.flatMap(s => s.v);
  const sigmaOverall = sd(all);

  const rangeVsSpecPct = tolerance ? secondaryBar / tolerance * 100 : null;
  const diagnostics = [];
  if (tolerance && secondaryBar > tolerance * 0.5) {
    diagnostics.push({
      level: 'warn',
      title: '子组内变差相对公差偏大',
      detail: `子组内平均变差=${secondaryBar.toFixed(4)}，为公差带的 ${rangeVsSpecPct.toFixed(0)}%。控制限由子组内变差计算，因此会被拉宽；这不代表过程能力合格。`,
    });
  }
  if ((lsl != null && Xbb < lsl) || (usl != null && Xbb > usl)) {
    diagnostics.push({
      level: 'bad', title: '过程中心位于规格限外',
      detail: '应先纠正过程中心，再评估控制稳定性和能力指数。',
    });
  }
  // Q-03：零变差时 Cp/Cpk 无定义，返回 null 而不是 Infinity/null 混用
  const cp = lsl != null && usl != null && sigmaWithin > 0
    ? (usl - lsl) / (6 * sigmaWithin) : null;
  const cpk = (lsl != null || usl != null) && sigmaWithin > 0
    ? Math.min(
      usl != null ? (usl - Xbb) / (3 * sigmaWithin) : Infinity,
      lsl != null ? (Xbb - lsl) / (3 * sigmaWithin) : Infinity
    ) : null;
  const ppk = (lsl != null || usl != null) && sigmaOverall > 0
    ? Math.min(
      usl != null ? (usl - Xbb) / (3 * sigmaOverall) : Infinity,
      lsl != null ? (Xbb - lsl) / (3 * sigmaOverall) : Infinity
    ) : null;

  const sigmaX = sigmaWithin / Math.sqrt(n);
  // Q-02：R/S 子图同时判上下限；用 forEach 下标定位，避免 indexOf 把相同极差都指向第一个
  const EPS = 1e-9;
  const secondaryViolations = [];
  secondaryRaw.forEach((value, index) => {
    if (uclSecondary > EPS && value >= uclSecondary - EPS) {
      secondaryViolations.push({ i: index, type: `${useS ? 'S' : 'R'} 点达到/超出 UCL`, v: +value.toFixed(4) });
    }
    if (lclSecondary > EPS && value <= lclSecondary + EPS) {
      secondaryViolations.push({ i: index, type: `${useS ? 'S' : 'R'} 点达到/低于 LCL`, v: +value.toFixed(4) });
    }
  });
  const viol = runRules(xb, Xbb, sigmaX, useS ? '子组均值' : 'X').concat(secondaryViolations);

  return {
    method: useS ? 'Xbar-S 图（均值-标准差）' : 'Xbar-R 图（均值-极差）',
    chartType: useS ? 'Xbar-S' : 'Xbar-R',
    n, labels,
    series: xb.map(value => displayNumber(value)),
    seriesUcl: xb.map(() => displayNumber(uclX)), seriesLcl: xb.map(() => displayNumber(lclX)),
    center: displayNumber(Xbb), ucl: displayNumber(uclX), lcl: displayNumber(lclX),
    Xbb: +Xbb.toFixed(4), Rb: +secondaryBar.toFixed(4),
    sigmaWithin: +sigmaWithin.toFixed(5), sigmaOverall: +sigmaOverall.toFixed(5),
    uclX: +uclX.toFixed(4), lclX: +lclX.toFixed(4),
    uclR: +uclSecondary.toFixed(4), lclR: +lclSecondary.toFixed(4),
    controlMethod: useS
      ? `Xbar-S：UCL/LCL=X̄̄±A3·S̄，n=${n}，A3=${A3[n]}`
      : `Xbar-R：CL=X̄̄，UCL/LCL=X̄̄±A2·R̄，n=${n}，A2=${A2[n]}`,
    rangeVsSpecPct: rangeVsSpecPct == null ? null : +rangeVsSpecPct.toFixed(1),
    diagnostics: diagnostics.concat(tolerance && Math.abs(Xbb - (lsl + usl) / 2) > tolerance * 0.25
      ? [{ level: 'warn', title: '过程中心偏离规格中心', detail: '过程均值偏离规格中心超过公差带 25%，应关注中心调整。' }] : []),
    cp: cp == null ? null : +cp.toFixed(2),
    cpk: cpk == null ? null : +cpk.toFixed(2),
    ppk: ppk == null ? null : +ppk.toFixed(2),
    xbar: xb.map(v => +v.toFixed(4)),
    range: secondaryRaw.map(v => +v.toFixed(4)),
    observations: all.map(v => +v.toFixed(4)),
    violations: viol,
  };
}

/** CP 自动映射：PFMEA 行 + PFD 工序 → CP 行 */
function cpGenerate(cpId) {
  return require('./control-sync').generate(cpId);
}

/** 两个基线的差异对比 */
function baselineDiff(aId, bId) {
  const db = DB.db;
  const A = db.prepare('SELECT * FROM baseline_item WHERE baseline_id=?').all(aId);
  const B = db.prepare('SELECT * FROM baseline_item WHERE baseline_id=?').all(bId);
  const mapA = new Map(A.map(x => [x.object_type + ':' + x.object_id, x]));
  const mapB = new Map(B.map(x => [x.object_type + ':' + x.object_id, x]));
  const out = [];
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  for (const k of keys) {
    const a = mapA.get(k), b = mapB.get(k);
    if (!a) { out.push({ key: k, type: 'ADD', object_type: b.object_type, object_id: b.object_id }); continue; }
    if (!b) { out.push({ key: k, type: 'DELETE', object_type: a.object_type, object_id: a.object_id }); continue; }
    if (a.object_hash !== b.object_hash) {
      const oa = JSON.parse(a.snapshot), ob = JSON.parse(b.snapshot);
      const fields = [];
      for (const f of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
        if (JSON.stringify(oa[f]) !== JSON.stringify(ob[f])) {
          let dir = null;
          if (typeof oa[f] === 'number' && typeof ob[f] === 'number') {
            if (/^lsl$/i.test(f)) dir = ob[f] > oa[f] ? 'TIGHT' : ob[f] < oa[f] ? 'LOOSE' : null;
            else if (/^usl$/i.test(f)) dir = ob[f] < oa[f] ? 'TIGHT' : ob[f] > oa[f] ? 'LOOSE' : null;
            else if (/tol/i.test(f)) dir = Math.abs(ob[f]) < Math.abs(oa[f]) ? 'TIGHT'
              : Math.abs(ob[f]) > Math.abs(oa[f]) ? 'LOOSE' : null;
            else dir = ob[f] > oa[f] ? 'UP' : 'DOWN';
          }
          fields.push({ field: f, from: oa[f], to: ob[f], dir });
        }
      }
      out.push({ key: k, type: 'MODIFY', object_type: a.object_type, object_id: a.object_id, fields });
    }
  }
  return out;
}

// 审计身份必须来自登录会话；调用点传入的姓名只作为无会话场景（启动同步、迁移）的兜底。
let actorResolver = null;
function setActorResolver(fn) {
  actorResolver = typeof fn === 'function' ? fn : null;
}
function audit(actor, action, type, id, before, after, reason) {
  const db = DB.db;
  const projectId = typeof CUR === 'undefined' ? null : CUR;
  const sessionActor = actorResolver ? String(actorResolver() || '').trim() : '';
  const finalActor = sessionActor || actor || '系统';
  db.prepare(`INSERT INTO audit_event(
    actor,action,object_type,object_id,before_json,after_json,reason,created_at,project_id
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(finalActor, action, type, id,
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
    reason || '', now(), projectId);
}

/** 看板汇总 */
function dashboard(projectId) {
  const db = DB.db;
  const q = (s, ...a) => db.prepare(s).get(...a) || {};
  const all = (s, ...a) => db.prepare(s).all(...a);

  const apDist = all(`SELECT r.ap, COUNT(*) c FROM fmea_row r
      JOIN fmea_header h ON h.fmea_id=r.fmea_id
      LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
      WHERE h.project_id=? AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')
      GROUP BY r.ap`, projectId);
  const highNoDecision = all(`SELECT r.row_id, r.ap, r.s, h.fmea_type, n.name fm_name
      FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      LEFT JOIN fmea_node n ON n.node_id=r.fm_id
      LEFT JOIN fmea_decision d ON d.row_id=r.row_id
      LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
      WHERE h.project_id=? AND r.ap='H' AND (d.row_id IS NULL OR d.decision='PENDING')
        AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')`, projectId);

  const overdueActions = all(`SELECT a.*, r.row_id FROM fmea_action a JOIN fmea_row r ON r.row_id=a.row_id
      JOIN fmea_header h ON h.fmea_id=r.fmea_id
      LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
      WHERE h.project_id=? AND a.status<>'已完成'
        AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')
      AND a.due_date < date('now','+8 hours')`, projectId);

  const cpNoSpc = all(`SELECT c.* FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id
      LEFT JOIN monitoring_item m ON m.cp_row_id=c.cp_row_id
      WHERE p.project_id=? AND c.is_spc=1 AND m.mon_id IS NULL`, projectId);

  const msaWarn = measurementSystems(projectId);

  const progress = docProgress(projectId);
  const phases = progress.phases.map(p => ({
    phase: p.phase, name: p.name, gate_criteria: '',
    total: p.total, done: p.done,
    status: p.total && p.done === p.total ? '已完成' : p.done > 0 ? '进行中' : '未开始',
  }));

  const charCoverage = all(`SELECT c.char_id, c.name, c.is_special, c.special_symbol, c.tol_text,
      (SELECT COUNT(*) FROM char_link l
        JOIN project_char pl ON pl.char_id=l.product_char_id AND pl.project_id=?
        JOIN project_char pract ON pract.char_id=l.process_char_id AND pract.project_id=?
        WHERE l.product_char_id=c.char_id AND COALESCE(l.status,'生效')<>'作废') links,
      (SELECT COUNT(DISTINCT cp.cp_row_id) FROM cp_row cp
        JOIN control_plan cpl ON cpl.cp_id=cp.cp_id AND cpl.project_id=?
        WHERE cp.char_id=c.char_id
           OR cp.char_id IN (SELECT l2.process_char_id FROM char_link l2
             JOIN project_char pl2 ON pl2.char_id=l2.product_char_id AND pl2.project_id=?
             WHERE l2.product_char_id=c.char_id)) cps,
      (SELECT COUNT(*) FROM monitoring_item m JOIN cp_row cp2 ON cp2.cp_row_id=m.cp_row_id
        JOIN control_plan cpl2 ON cpl2.cp_id=cp2.cp_id AND cpl2.project_id=?
        WHERE (cp2.char_id=c.char_id
           OR cp2.char_id IN (SELECT l3.process_char_id FROM char_link l3
             JOIN project_char pl3 ON pl3.char_id=l3.product_char_id AND pl3.project_id=?
             WHERE l3.product_char_id=c.char_id))
           AND m.approval_status='已批准') mons,
      (SELECT COUNT(*) FROM cp_row cp3 JOIN control_plan cpl3 ON cpl3.cp_id=cp3.cp_id AND cpl3.project_id=?
        WHERE cpl3.status IN ('已批准','已冻结') AND (cp3.char_id=c.char_id
           OR cp3.char_id IN (SELECT l4.process_char_id FROM char_link l4
             JOIN project_char pl4 ON pl4.char_id=l4.product_char_id AND pl4.project_id=?
             WHERE l4.product_char_id=c.char_id))) cp_approved,
      (SELECT COUNT(*) FROM msa_plan_item p JOIN msa_study ms ON ms.study_id=p.study_id
        WHERE p.project_id=? AND COALESCE(p.source_active,1)<>0 AND ms.judgment='接受'
          AND ms.status='已完成' AND (p.char_id=c.char_id OR p.char_id IN (
            SELECT l5.process_char_id FROM char_link l5
              JOIN project_char pl5 ON pl5.char_id=l5.product_char_id AND pl5.project_id=?
            WHERE l5.product_char_id=c.char_id))) msa_ok
    FROM char_master c WHERE c.char_kind='PRODUCT'
      AND EXISTS (SELECT 1 FROM project_char pc WHERE pc.project_id=? AND pc.char_id=c.char_id)
    ORDER BY c.char_id`, projectId, projectId, projectId, projectId, projectId, projectId,
  projectId, projectId, projectId, projectId, projectId);

  // D-07：覆盖状态改为多级，不再只看“有没有”
  const coverageStage = row => {
    if (!row.links) return { stage: 'unlinked', label: '未关联过程特性' };
    if (!row.cps) return { stage: 'linked', label: '已关联，未进 CP' };
    if (!row.cp_approved) return { stage: 'in_cp', label: '已进 CP，未批准' };
    if (!row.mons) return { stage: 'cp_approved', label: 'CP 已批准，未监控' };
    if (!row.msa_ok) return { stage: 'monitored', label: '已监控，MSA 未接受' };
    return { stage: 'complete', label: '已关联→CP 批准→监控→MSA 接受' };
  };

  const ppapRows = all('SELECT status FROM ppap_element WHERE project_id=?', projectId);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

  return {
    apDist, highNoDecision, overdueActions, cpNoSpc,
    charCoverage: charCoverage.map(row => ({ ...row, ...coverageStage(row) })),
    msaWarn: msaWarn.filter(g => !g.qualified),
    phases,
    docProgress: progress,
    ppapDone: ppapRows.filter(x => x.status === '已完成').length, ppapTotal: ppapRows.length,
    docsDone: progress.done,
    docsTotal: progress.total,
    counts: {
      chars: q('SELECT COUNT(*) c FROM project_char WHERE project_id=?', projectId).c,
      links: q(`SELECT COUNT(*) c FROM char_link l
        JOIN project_char pl ON pl.char_id=l.product_char_id WHERE pl.project_id=?`, projectId).c,
      steps: q('SELECT COUNT(*) c FROM process_step WHERE project_id=?', projectId).c,
      rows: q(`SELECT COUNT(*) c FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
        LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
        WHERE h.project_id=? AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')`, projectId).c,
      cpRows: q(`SELECT COUNT(*) c FROM cp_row c JOIN control_plan p ON p.cp_id=c.cp_id WHERE p.project_id=?`, projectId).c,
      baselines: q('SELECT COUNT(*) c FROM baseline WHERE project_id=?', projectId).c,
    },
    audit: all(`SELECT * FROM audit_event WHERE project_id=? OR project_id IS NULL
      ORDER BY event_id DESC LIMIT 8`, projectId),
  };
}

/** 预警中心：把所有「需要人处理」的事项汇总成一条流 */
function alerts(projectId) {
  const db = DB.db;
  const all = (s, ...a) => db.prepare(s).all(...a);
  const DT = require('./doctpl');
  const out = [];

  // 1) FMEA 高风险（AP=H 且无处置决定）
  const highRows = all(`SELECT r.row_id, r.s, h.fmea_type, n.name fm
      FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      LEFT JOIN fmea_node n ON n.node_id=r.fm_id
      LEFT JOIN fmea_decision d ON d.row_id=r.row_id
      LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
      WHERE h.project_id=? AND r.ap='H' AND (d.row_id IS NULL OR d.decision='PENDING')
        AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')`, projectId);
  for (const r of highRows) {
    out.push({
      level: 'high', type: 'FMEA', title: `高 AP 未处置：${r.fm || r.row_id}`,
      detail: `${r.fmea_type} · S=${r.s} · 需给出处置决定`, ref: r.row_id,
      action: { type: 'module', id: 'fmea', arg: r.fmea_type },
    });
  }
  const overdueDecisions = all(`SELECT r.row_id, r.s, h.fmea_type, d.review_due
    FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
    JOIN fmea_decision d ON d.row_id=r.row_id
    LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
    WHERE h.project_id=? AND d.review_due<>'' AND d.review_due<date('now','+8 hours')
      AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')`, projectId);
  for (const row of overdueDecisions) {
    out.push({
      level: 'mid', type: 'FMEA', title: `处置决定已过复审日期：${row.row_id}`,
      detail: `${row.fmea_type} · S=${row.s} · 复审日期 ${row.review_due}`,
      ref: row.row_id, action: { type: 'module', id: 'fmea', arg: row.fmea_type },
    });
  }

  // 2) 文档待审核
  const pending = all(`SELECT doc_code, updated_at FROM project_doc WHERE project_id=? AND status='待审核'`, projectId);
  for (const p of pending) {
    const meta = DT.CATALOG.find(c => c.code === p.doc_code) || {};
    out.push({
      level: 'mid', type: '评审', title: `待审核：${meta.name || p.doc_code}`,
      detail: `提交时间 ${p.updated_at || '—'}`, ref: p.doc_code,
      action: { type: 'doc', code: p.doc_code },
    });
  }

  // 3) Gate 待评审（S-01：与 Gate 页、驾驶舱共用 gateStatus）
  const gateResult = gateStatus(projectId);
  for (const gate of gateResult.gates) {
    if (gate.no > gateResult.currentPhase) break;
    if (gate.passed) continue;
    out.push({
      level: 'mid', type: '门径', title: `Gate ${gate.no} 尚未通过`,
      detail: gate.needsRevalidation
        ? `检查表已升级，原“${gate.recordedDecision || '通过'}”结论需重新评审`
        : `当前状态：${gate.decision}`,
      ref: String(gate.no),
      action: { type: 'page', id: 'gates' },
    });
  }

  // 4) MSA 预警
  const gauges = measurementSystems(projectId);
  const yearAgo = new Date(Date.now() + 8 * 3600e3 - 365 * 86400e3).toISOString().slice(0, 10);
  for (const g of gauges) {
    if (g.calibration_due && g.calibration_due < new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)) {
      out.push({
        level: 'high', type: 'MSA', title: `检具 ${g.name} 已过校准有效期`,
        detail: `校准到期日 ${g.calibration_due}；校准过期期间测量结果不可用于放行`,
        ref: g.gauge_id, action: { type: 'page', id: 'msa' },
      });
    } else if (g.pct != null && g.pct > 30) {
      out.push({
        level: 'high', type: 'MSA', title: `检具 ${g.name} 的 %GRR = ${g.pct}%`,
        detail: '超过 30%，测量结果不可用于判定；需改进检具或测量方法', ref: g.gauge_id,
        action: { type: 'page', id: 'msa' },
      });
    } else if (!g.qualified || !g.last_at || g.last_at < yearAgo) {
      out.push({
        level: 'mid', type: 'MSA', title: `测量系统 ${g.name} 尚未确认有效`,
        detail: `计划 ${g.status}；来源 ${g.source_status}；最近研究 ${g.last_at || '—'}`, ref: g.gauge_id,
        action: { type: 'page', id: 'msa' },
      });
    }
  }

  // 5) SPC 能力不足
  try {
    const items = all(`SELECT m.*, c.spec_text,
        COALESCE(pc.name,cm.name) cname,
        COALESCE(pc.lsl,cm.lsl) lsl, COALESCE(pc.usl,cm.usl) usl
      FROM monitoring_item m JOIN cp_row c ON c.cp_row_id=m.cp_row_id
      JOIN control_plan cp ON cp.cp_id=c.cp_id
      LEFT JOIN project_char pc ON pc.pchar_id=COALESCE(m.project_char_id,c.project_char_id)
      LEFT JOIN char_master cm ON cm.char_id=COALESCE(m.char_id,c.char_id,pc.char_id)
      WHERE cp.project_id=? AND m.status='启用'`, projectId);
    for (const m of items) {
      const ds = db.prepare('SELECT data_json FROM spc_dataset WHERE mon_id=? ORDER BY dataset_id DESC LIMIT 1').get(m.mon_id);
      if (!ds) continue;
      const st = spcCompute(JSON.parse(ds.data_json), { lsl: m.lsl, usl: m.usl },
        { chartType: m.chart_type });
      const target = m.cpk_target == null ? DB.DEFAULT_CPK_TARGET : +m.cpk_target;
      if (st.cpk != null && st.cpk < target) {
        out.push({
          level: 'high', type: 'SPC', title: `${m.cname || m.mon_id} 的 Cpk = ${st.cpk}`,
          detail: `低于目标 ${target}，需分析变差来源`, ref: m.mon_id,
          action: { type: 'page', id: 'spc' },
        });
      }
    }
  } catch (e) { /* 无数据时忽略 */ }

  // 6) ECR 待审批
  const ecrs = all(`SELECT * FROM ecr WHERE project_id=? AND status='待审批'`, projectId);
  for (const e of ecrs) {
    out.push({
      level: 'mid', type: '变更', title: `ECR 待审批：${e.title}`,
      detail: `影响范围 ${e.scope}`, ref: e.ecr_id,
      action: { type: 'page', id: 'ecr' },
    });
  }

  const order = { high: 0, mid: 1, low: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return { list: out, high: out.filter(a => a.level === 'high').length, total: out.length };
}

/**
 * S-01/S-06：Gate 结论的唯一服务端口径。
 * Gate 页、预警中心、驾驶舱、PPAP 就绪都必须调用本函数，不再各自读 gate_review.decision。
 * 旧版本检查表的记录统一映射为“待复核”；项目阶段由连续通过的 Gate 派生。
 */
function gateStatus(projectId, criteriaVersion) {
  const ST = require('./structure');
  const version = criteriaVersion || ST.GATE_CRITERIA_VERSION;
  const rows = DB.db.prepare('SELECT * FROM gate_review WHERE project_id=?').all(projectId);
  const map = new Map(rows.map(row => [row.phase, row]));
  let previousPassed = true;
  let consecutive = 0;
  const gates = ST.GATES.map(gate => {
    const row = map.get(gate.no);
    const currentVersion = !!row && row.criteria_version === version;
    const decision = !row ? '未发起' : currentVersion ? row.decision : '待复核';
    const passed = currentVersion && decision === '通过';
    const canReview = gate.no === 0 ? true : previousPassed;
    if (passed) {
      if (previousPassed) consecutive += 1;
    } else {
      previousPassed = false;
    }
    return {
      ...gate,
      decision,
      recordedDecision: row?.decision || '',
      needsRevalidation: !!row && !currentVersion,
      reviewer: row?.reviewer || '',
      comment: row?.comment || '',
      reviewed_at: row?.reviewed_at || null,
      checks: currentVersion ? JSON.parse(row.checks_json || '[]') : gate.criteria.map(() => 0),
      actions: currentVersion ? JSON.parse(row.actions_json || '[]') : gate.criteria.map(() => ({})),
      canReview,
      passed,
    };
  });
  const project = DB.db.prepare('SELECT phase FROM project WHERE project_id=?').get(projectId) || {};
  return {
    criteriaVersion: version,
    gates,
    passed: consecutive,
    derivedPhase: Math.min(5, consecutive),
    currentPhase: project.phase ?? 0,
  };
}

/**
 * S-13：唯一的“交付物完成度”投影。
 * 分母 = CATALOG 中非输入类的表单交付物；分子 = 已批准或已完成。
 * 系统模块/活动项只是导航与记录，不进入分母（A-16）。
 */
function docProgress(projectId) {
  const DT = require('./doctpl');
  const rows = DB.db.prepare(`SELECT doc_code,status FROM project_doc
    WHERE project_id=? AND COALESCE(hidden,0)=0`).all(projectId);
  const map = new Map(rows.map(row => [row.doc_code, row.status]));
  const forms = DT.CATALOG.filter(item => item.group !== 'input' && item.kind === 'form');
  const isDone = code => ['已完成', '已批准'].includes(map.get(code));
  const phases = DT.PHASES.map(phase => {
    const items = forms.filter(item => item.phase === phase.no);
    const done = items.filter(item => isDone(item.code)).length;
    return {
      phase: phase.no, name: phase.name, total: items.length, done,
      pct: items.length ? Math.round((done / items.length) * 100) : 0,
    };
  });
  const done = forms.filter(item => isDone(item.code)).length;
  return {
    total: forms.length, done,
    pct: forms.length ? Math.round((done / forms.length) * 100) : 0,
    phases,
  };
}

/** 管理驾驶舱：健康度评分 + 关键指标 */
function cockpit(projectId) {
  const db = DB.db;
  const one = (s, ...a) => db.prepare(s).get(...a) || {};

  // S-13：与阶段页、总览共用同一完成度投影
  const progress = docProgress(projectId);
  const done = progress.done;
  const docPct = progress.total ? progress.done / progress.total : 0;

  // S-01：只看当前检查表版本下、连续通过的 Gate，旧版记录不再计入健康分
  const gateResult = gateStatus(projectId);
  const passed = gateResult.passed;
  const shouldPass = Math.min(gateResult.derivedPhase + 1, 6);
  const gatePct = shouldPass ? Math.min(1, passed / shouldPass) : 0;

  const highRisk = one(`SELECT COUNT(*) c FROM fmea_row r JOIN fmea_header h ON h.fmea_id=r.fmea_id
      LEFT JOIN fmea_decision d ON d.row_id=r.row_id
      LEFT JOIN fmea_node focus ON focus.node_id=r.focus_node_id
      WHERE h.project_id=? AND r.ap='H' AND (d.row_id IS NULL OR d.decision='PENDING')
        AND (r.focus_node_id IS NULL OR COALESCE(focus.status,'生效')<>'作废')`, projectId).c || 0;
  const riskPct = Math.max(0, 1 - highRisk / 5);

  const msas = measurementSystems(projectId);
  const msaBad = msas.filter(m => !m.qualified).length;
  const msaPct = Math.max(0, 1 - msaBad / Math.max(1, msas.length));

  const health = Math.round((docPct * 40 + gatePct * 25 + riskPct * 20 + msaPct * 15));
  const band = health >= 80 ? '健康' : health >= 60 ? '关注' : '风险高';

  return {
    health, band,
    gate: { derivedPhase: gateResult.derivedPhase, currentPhase: gateResult.currentPhase,
      criteriaVersion: gateResult.criteriaVersion },
    metrics: {
      docPct: Math.round(docPct * 100), docsDone: done, docsTotal: progress.total,
      gatePassed: passed, gateShould: shouldPass,
      gateOnTime: Math.round((passed / Math.max(1, shouldPass)) * 100),
      highRisk, msaBad,
      activeProjects: 1,
    },
    breakdown: [
      { name: '交付物完成度', weight: 40, score: Math.round(docPct * 100), value: `${done}/${progress.total}` },
      { name: '门径通过率', weight: 25, score: Math.round(gatePct * 100), value: `${passed}/${shouldPass}` },
      { name: '高风险闭环', weight: 20, score: Math.round(riskPct * 100), value: `未处置 ${highRisk} 项` },
      { name: '测量系统', weight: 15, score: Math.round(msaPct * 100), value: `待改进 ${msaBad} 台` },
    ],
  };
}

module.exports = { spcCompute, runRules, cpGenerate, baselineDiff, audit, setActorResolver,
  dashboard, computeGRR, apLookup, alerts, cockpit, gateStatus, docProgress, displayNumber };
