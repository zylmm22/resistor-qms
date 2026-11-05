'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

assert.match(app, /function spcSubgroupTable\(/, 'SPC 必须提供子组明细渲染器');
assert.match(app, /子组数据明细/, 'SPC 控制图下必须显示子组数据明细');
assert.doesNotMatch(app, /<th>子组标识<\/th>/, '子组明细不得在 # 列之后重复显示子组标识');
assert.match(app, /JSON\.parse\(\(history\?\.dataset \|\| det\?\.latest\)\?\.data_json/, '明细必须读取当前或历史数据集');
assert.match(css, /\.spc-subgroup-scroll\s*\{/, '大量子组数据需要独立滚动区域');
assert.match(css, /\.spc-subgroup-row-bad\s+td\s*\{/, '判异子组需要在明细中突出显示');
assert.match(app, /新数据批次号（可选）/, '批次号必须明确用于新数据导入');
// 原断言匹配的模板形态已不存在，永远通过；改为检查 spcBatch 输入框不带预填的随机值
const batchInput = app.slice(app.indexOf('id="spcBatch"'), app.indexOf('id="spcBatch"') + 200);
assert.ok(!/value="LOT-\$\{Date\.now/.test(batchInput), '切换历史数据时不得重新生成随机批次号');
// 数值显示：子组明细、tooltip、规范限与控制限都必须走统一精度函数，不能裸插浮点数
const tableBlock = app.slice(app.indexOf('function spcSubgroupTable('), app.indexOf('async function vSpc()'));
assert.doesNotMatch(tableBlock, /num\([^)]*,\s*6\)/, '子组明细不得再使用固定 6 位小数（会显示 1.355000）');
assert.match(tableBlock, /spcNum\(values\[valueIndex\]\)/, '子组明细的测量值必须使用 spcNum 显示');
const chartBlock = app.slice(app.indexOf('function controlChart(stat, char)'), app.indexOf('function spcHistogram'));
assert.doesNotMatch(chartBlock, /：\$\{value\}|：\$\{v\}/, '控制图 tooltip 不得裸插浮点数值');
assert.match(chartBlock, /spcNum\(value\)/, '控制图 tooltip 必须使用 spcNum');
assert.match(app, /const spcNum = \(v, maxDecimals = 6\)/, '必须提供 SPC 统一精度函数');
assert.match(app, /abs >= 1e12/, 'SPC 精度函数必须处理超大数值');
assert.match(app, /abs < 1e-6/, 'SPC 精度函数必须处理极小数值');
assert.match(css, /\.g23\{grid-template-columns:2fr minmax\(0,1fr\)\}/, '右侧列必须允许收缩，避免长数值撑破整行');

console.log('spc-subgroup-ui: ok');
