'use strict';

/**
 * MSA 模拟 → 保存研究 → 导出 Excel 的数据链验收。
 *
 *   1. /api/msa/simulate 返回的零件真实值（每条测量链的中心值）随研究一起保存；
 *   2. 导出的 GRR 数据收集表逐格等于模拟读数；
 *   3. 数据表新增“零件真实值（模拟）”行，逐格等于模拟中心值；
 *   4. 报告页 EV/AV/GRR/PV/TV 与 ndc 与服务端计算一致，判定单元格带 %Tol。
 *
 * 运行：node tests/msa-export-chain.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const P = require('../lib/parse');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-msa-chain-'));
const DB_PATH = path.join(TEMP, 'qms.db');
const PORT = 8870 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'RES-CHIP-2026-01';
const PASSWORD = 'MsaChain-Admin-2026!';

async function api(method, url, { body, cookie } = {}) {
  const target = url.startsWith('/api/') ? url.slice(4) : url;
  const response = await fetch(`${BASE}/api${target}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString('utf8')); } catch { json = null; }
  return { status: response.status, json, buffer, headers: response.headers };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/meta`);
      if (response.status === 401 || response.ok) return;
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未启动');
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH,
      QMS_ADMIN_PASSWORD: PASSWORD, QMS_QUALITY_PASSWORD: 'MsaChain-Quality-2026!',
      QMS_ENGINEER_PASSWORD: 'MsaChain-Engineer-2026!', QMS_AUDITOR_PASSWORD: 'MsaChain-Auditor-2026!',
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await waitForServer();
    const login = await api('POST', '/auth/login', { body: { username: 'admin', password: PASSWORD } });
    assert.equal(login.status, 200, '登录失败');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const q = `?p=${encodeURIComponent(PROJECT)}`;

    const msa = await api('GET', `/msa${q}`, { cookie });
    assert.equal(msa.status, 200, `读取 MSA 失败：${JSON.stringify(msa.json)}`);
    const char = (msa.json.projectChars || []).find(item => item.lsl != null && item.usl != null);
    assert.ok(char, '前置条件：项目应有带规范限的特性');
    const today = new Date().toISOString().slice(0, 10);
    // 检具列表现在是“本项目已使用/计划使用”的子集；新项目可能为空，回退到全厂台账再补计划
    const gaugePool = [...(msa.json.gauges || []), ...(msa.json.other_gauges || [])];
    const gauge = gaugePool.find(item => item.calibration_due && item.calibration_due >= today);
    assert.ok(gauge, '前置条件：应有校准有效的检具');

    const parts = 10, ops = 3, trials = 3;
    const simulated = await api('POST', `/msa/simulate${q}`, {
      cookie,
      body: {
        project_char_id: char.pchar_id, gauge_id: gauge.gauge_id,
        parts, operators: ops, trials, target_pct: 10, tolerance: char.usl - char.lsl,
      },
    });
    assert.equal(simulated.status, 200, `模拟失败：${JSON.stringify(simulated.json)}`);
    const data = simulated.json.data;
    const partValues = simulated.json.part_values;
    assert.equal(partValues.length, parts, '模拟应返回每个零件的真实值');

    const saved = await api('POST', `/msa${q}`, {
      cookie,
      body: {
        gauge_id: gauge.gauge_id, project_char_id: char.pchar_id, data,
        tolerance: char.usl - char.lsl, parts, ops, trials, part_values: partValues,
      },
    });
    assert.equal(saved.status, 200, `保存研究失败：${JSON.stringify(saved.json)}`);
    assert.deepEqual(saved.json.part_values, partValues, '保存后应回传零件真实值');

    const exported = await api('GET',
      `/quality-tools/msa/export${q}&fmt=xlsx&study_id=${saved.json.study_id}`, { cookie });
    assert.equal(exported.status, 200, `导出失败：${exported.status}`);
    const parsed = P.parseXlsx(exported.buffer);
    const sheet = parsed.sheets.find(item => item.name === 'GRR数据收集表');
    const report = parsed.sheets.find(item => item.name === 'GRR报告');
    assert.ok(sheet, '导出应包含 GRR 数据收集表');
    assert.ok(report, '导出应包含 GRR 报告页');
    const cell = (target, row, column) => {
      const found = target.cells.get(`${row},${column}`);
      return found ? found.v : '';
    };

    // 数据行：评价人 A/B/C + 试验号；合并单元格导致 A 只在每组首行出现
    const dataRows = [];
    let operator = '';
    for (let row = 4; row < 60 && dataRows.length < ops * trials; row += 1) {
      const label = String(cell(sheet, row, 0)).trim();
      const trial = String(cell(sheet, row, 1)).trim();
      if (/^[A-Z]$/.test(label)) operator = label;
      if (/均值|极差/.test(label)) continue;
      if (operator && /^\d+$/.test(trial)) dataRows.push(row);
    }
    assert.equal(dataRows.length, ops * trials, '导出的数据行数应与研究设计一致');
    let mismatched = 0;
    dataRows.forEach((row, index) => {
      for (let part = 0; part < parts; part += 1) {
        if (Math.abs(Number(cell(sheet, row, part + 2)) - Number(data[index][part])) > 1e-9) mismatched += 1;
      }
    });
    assert.equal(mismatched, 0, '导出数据必须逐格等于模拟/录入的读数');

    // 零件真实值（模拟中心值）
    let trueRow = -1;
    for (let row = 0; row < 80; row += 1) {
      if (String(cell(sheet, row, 0)).includes('零件真实值')) { trueRow = row; break; }
    }
    assert.ok(trueRow > 0, '数据收集表应包含“零件真实值（模拟）”行');
    const exportedParts = Array.from({ length: parts }, (_, part) => Number(cell(sheet, trueRow, part + 2)));
    exportedParts.forEach((value, index) => {
      assert.ok(Math.abs(value - Number(partValues[index])) < 1e-9,
        `零件 ${index + 1} 真实值应等于模拟中心值（导出 ${value}，模拟 ${partValues[index]}）`);
    });

    // 报告页与服务端结果一致
    const result = saved.json;
    const reportValue = (label) => {
      for (let row = 0; row < 40; row += 1) {
        if (String(cell(report, row, 0)).includes(label)) return Number(cell(report, row, 1));
      }
      return NaN;
    };
    assert.ok(Math.abs(reportValue('设备变差 EV') - result.EV) < 1e-4, 'EV 应与服务端一致');
    assert.ok(Math.abs(reportValue('评价者变差 AV') - result.AV) < 1e-4, 'AV 应与服务端一致');
    assert.ok(Math.abs(reportValue('再现性 GRR') - result.GRR) < 1e-4, 'GRR 应与服务端一致');
    assert.ok(Math.abs(reportValue('零件变差 PV') - result.PV) < 1e-4, 'PV 应与服务端一致');
    assert.ok(Math.abs(reportValue('总变差 TV') - result.TV) < 1e-4, 'TV 应与服务端一致');

    const ndcValue = (() => {
      for (let row = 0; row < 40; row += 1) {
        if (String(cell(report, row, 0)).includes('总变差 TV')) return Number(cell(report, row, 4));
      }
      return NaN;
    })();
    assert.equal(ndcValue, result.ndc, '报告 ndc 应为整数并与判定口径一致');
    assert.match(String(cell(report, 5, 5)), new RegExp(String(result.pctTol).replace('.', '\\.')),
      '判定单元格应带 %Tol');

    console.log('msa-export-chain: 模拟→研究→导出 数据链一致（'
      + `${dataRows.length} 行 × ${parts} 列 + 零件真实值 + 报告指标）`);
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 800));
    try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
    if (stderr && /Error/.test(stderr)) console.error(stderr.slice(0, 800));
  }
}

main().catch(error => {
  console.error('MSA 导出数据链验收失败：');
  console.error(error);
  process.exitCode = 1;
});
