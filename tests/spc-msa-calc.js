'use strict';

/**
 * P2-1 / P2-3 计算正确性单元测试。
 *   Q-01 子组 n>10 显式拒绝，控制图常数不再静默回退
 *   Q-02 R/S 子图判上下限，索引用 forEach（相同极差不串位）
 *   Q-03 零变差 Cp/Cpk 返回 null，不误报连续 7 点
 *   Q-05 控制限/中心线/1σ 边界语义
 *   Q-06 P 图逐点 σ_i 判异
 *   M-01 GR&R 使用 AIAG K1/K3 倒数
 *   M-14 低于建议样本量给出提示
 *
 * 运行：node tests/spc-msa-calc.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-spc-calc-'));
process.env.QMS_DB_PATH = path.join(TEMP, 'qms.db');
const DB = require('../lib/db');
const L = require('../lib/logic');

const subgroup = (values, label = 's') => ({ t: label, v: values });
const groups = (rows, width) => rows.map((row, index) => subgroup(
  Array.isArray(row) ? row : Array.from({ length: width }, (_, column) => row + column * 0),
  `g${index + 1}`));

try {
  /* ------------------------------------------------------------- Q-01 */
  assert.throws(() => L.spcCompute(groups(Array.from({ length: 12 }, (_, i) => i), 11), {},
    { chartType: 'Xbar-R' }), /2–10|2-10/, 'Q-01：n=11 必须显式拒绝');
  assert.throws(() => L.spcCompute(groups(Array.from({ length: 12 }, (_, i) => i), 1), {},
    { chartType: 'Xbar-R' }), /2–10|2-10/, 'Q-01：n=1 必须显式拒绝');

  /* ------------------------------------------------------------- Q-02 */
  // 极差 5 全部相同，最后一行极差 0.1；n=7 时 LCL>0，应精确命中最后一行
  const rRows = Array.from({ length: 9 }, (_, i) => [i, i + 5, i + 10, i + 15, i + 20, i + 25, i + 30]);
  rRows.push([0, 0.1, 0, 0.1, 0, 0.1, 0]);
  const rChart = L.spcCompute(rRows.map((row, i) => subgroup(row, `r${i}`)), {}, { chartType: 'Xbar-R' });
  const lowRange = rChart.violations.filter(item => /R 点达到\/低于 LCL/.test(item.type));
  assert.ok(lowRange.some(item => item.i === 9), 'Q-02：低于 LCL 的极差应被识别并使用正确下标');

  // 相同极差中有两个越界，下标不能都指向第一个
  const dupRows = Array.from({ length: 10 }, (_, i) => [i, i + 1, i + 2, i + 3, i + 4]);
  dupRows[9] = [0, 10, 0, 10, 0];
  const dupChart = L.spcCompute(dupRows.map((row, i) => subgroup(row, `d${i}`)), {}, { chartType: 'Xbar-R' });
  const highRange = dupChart.violations.filter(item => /R 点达到\/超出 UCL/.test(item.type));
  assert.ok(highRange.some(item => item.i === 9), 'Q-02：越界极差下标应为实际行号');
  assert.ok(!highRange.some(item => item.i === 0), 'Q-02：相同极差不能串位到第一行');

  /* ------------------------------------------------------------- Q-03 */
  const flat = groups(Array.from({ length: 25 }, () => [10, 10, 10, 10, 10]));
  const flatChart = L.spcCompute(flat, { lsl: 9, usl: 11 }, { chartType: 'Xbar-R' });
  assert.equal(flatChart.cp, null, 'Q-03：零变差 Cp 应为 null');
  assert.equal(flatChart.cpk, null, 'Q-03：零变差 Cpk 应为 null');
  assert.equal(flatChart.violations.length, 0, 'Q-03：零变差不得误报连续 7 点或超限');

  /* ------------------------------------------------------------- Q-05 */
  assert.ok(L.runRules([10], 10, 0, 'x', 10, 9).length > 0,
    'Q-05：恰好落在 UCL 上的点应判异');
  assert.equal(L.runRules([10, 10, 10, 10, 10, 10, 10], 10, 1).length, 0,
    'Q-05：等于中心线的点不得组成“连续 7 点同侧”');
  const upperBoundary = L.runRules(Array.from({ length: 15 }, () => 11), 10, 1);
  assert.ok(upperBoundary.some(item => /连续 15 点位于 1σ 以内/.test(item.type)),
    'Q-05：恰在 1σ 上的点应计入 15 点规则');
  assert.ok(upperBoundary.some(item => /连续 8 点位于 1σ 以外/.test(item.type)),
    'Q-05：恰在 1σ 上的点应计入 8 点规则');

  /* ------------------------------------------------------------- Q-06 */
  const pRows = [];
  for (let i = 0; i < 18; i += 1) pRows.push(subgroup([10, 100], `p${i}`)); // p=0.10
  pRows.push(subgroup([17, 100], 'p18')); // p=0.17，大样本
  pRows.push(subgroup([1.7, 10], 'p19')); // p=0.17，小样本
  const pChart = L.spcCompute(pRows, {}, { chartType: 'P' });
  assert.ok(!pChart.violations.some(item => /2σ/.test(item.type)),
    'Q-06：P 图 2σ 规则必须按各点样本量，不能用最大样本量的 σ');
  assert.ok(!pChart.violations.some(item => /UCL|LCL/.test(item.type)),
    'Q-06：P 图逐点控制限内的点不得误报');

  /* ------------------------------------------------------------- M-01 */
  const ideal = Array.from({ length: 9 }, (_, row) =>
    Array.from({ length: 10 }, (_, part) => 10 + part));
  const idealResult = DB.computeGRR(ideal, 10, 3, 3, 20);
  assert.equal(idealResult.GRR, 0, '零件间完全稳定时 GRR 应为 0');
  assert.ok(Math.abs(idealResult.PV - +(9 / 3.179).toFixed(5)) < 1e-4,
    `M-01：PV 应使用 K3 倒数 3.179，实际 ${idealResult.PV}`);
  assert.ok(idealResult.PV < 2.9, 'M-01：PV 不得再按普通极差系数 3.078 放大');

  const repeatOnly = Array.from({ length: 15 }, (_, row) => {
    const trial = row % 5;
    return Array.from({ length: 10 }, () => 10 + trial * 0.05);
  });
  const repeatResult = DB.computeGRR(repeatOnly, 10, 3, 5, 20);
  assert.ok(Math.abs(repeatResult.EV - +(0.2 / 2.481).toFixed(5)) < 1e-4,
    `M-01：5 次试验 EV 应使用 K1 倒数 2.481，实际 ${repeatResult.EV}`);

  /* ------------------------------------------------------------- M-14 */
  const small = DB.computeGRR(Array.from({ length: 6 }, () => [10, 10.1, 9.9, 10.2, 9.8]), 5, 2, 3, 2);
  assert.ok(small.warnings.some(item => /零件数 5/.test(item)), 'M-14：零件数不足应提示');
  assert.ok(small.warnings.every(item => !/评价人/.test(item)), 'M-14：2 名评价人不应提示');

  /* ------------------------------------------------------------- 数值显示精度 */
  assert.equal(L.displayNumber(0.0165472068000000037), 0.016547,
    '显示精度：浮点尾差应截到 6 位小数');
  assert.equal(L.displayNumber(1.355), 1.355, '显示精度：不应补足无意义的尾随 0');
  assert.equal(L.displayNumber(10), 10, '显示精度：整数保持整数');
  assert.equal(L.displayNumber(123456789012).toString().length <= 15, true,
    '显示精度：整数部分较长时应自动减少小数位');
  assert.equal(L.displayNumber(1.2e-9), 1.2e-9, '显示精度：极小值保留有效数字');
  assert.equal(L.displayNumber(''), '', '显示精度：空值返回空');
  assert.equal(L.displayNumber(null), '', '显示精度：null 返回空');
  const decimalsOf = value => {
    const text = String(value);
    return /e/i.test(text) ? 0 : (text.split('.')[1] || '').length;
  };
  const spcWithLongDecimals = L.spcCompute([
    subgroup([10.021700123456789, 9.992400123456789, 10.020600123456789, 10.006900123456789, 10.015700123456789]),
    subgroup([9.985500123456789, 9.987200123456789, 9.971300123456789, 9.990300123456789, 10.007200123456789]),
    subgroup([9.878700123456789, 10.089700123456789, 10.123400123456789, 10.023400123456789, 9.960000123456789]),
  ], { lsl: 9.9, usl: 10.1 }, { chartType: 'Xbar-R' });
  assert.ok(spcWithLongDecimals.series.every(value => decimalsOf(value) <= 6),
    '显示精度：控制图序列最多 6 位小数');
  assert.ok(spcWithLongDecimals.seriesUcl.concat(spcWithLongDecimals.seriesLcl)
    .every(value => decimalsOf(value) <= 6), '显示精度：控制限最多 6 位小数');
  assert.ok(String(spcWithLongDecimals.series[0]).length <= 14, '显示精度：单个数值不超过 14 个字符');

  console.log('spc-msa-calc: Q-01/Q-02/Q-03/Q-05/Q-06/M-01/M-14/显示精度 passed');
} finally {
  try { DB.db.close(); } catch {}
  fs.rmSync(TEMP, { recursive: true, force: true });
}
