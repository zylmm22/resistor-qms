'use strict';

/**
 * P1-2 特性规范全字段穿透（D-03 / C-04 / M-07 / Q-09）验收测试。
 *
 * 覆盖：
 *   D-03  特性主数据 / P2-11 的 lsl/usl/target/unit/tol_text 同步到项目特性、CP 行与 SPC；
 *   C-04  监控项子组大小/抽样频率不回写 CP 的样本容量与抽样要求；
 *   M-07  计划公差为空时，研究表单可填写公差并写回计划，不再被“与计划一致”卡死；
 *   Q-09  CP 行重挂特性后 SPC 以 cp_row.project_char_id 实时读取并回到待审核。
 *
 * 运行：node tests/p1-2-spec-penetration.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-p1-2-'));
const DB_PATH = path.join(TEMP, 'qms.db');
const PORT = 24200 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api`;
const PROJECT = 'P12-SPEC';
const PASSWORDS = {
  admin: 'P12-Admin-2026',
  engineer: 'P12-Engineer-2026',
  quality: 'P12-Quality-2026',
  auditor: 'P12-Auditor-2026',
};
const cookies = {};
let child = null;
let serverLog = '';
let checks = 0;

async function api(method, url, options = {}) {
  const { as = 'admin', body } = options;
  let target = url.startsWith('/api/') ? url.slice(4) : url;
  if (target !== '/projects' && !target.includes('p=')) {
    target += (target.includes('?') ? '&' : '?') + 'p=' + encodeURIComponent(PROJECT);
  }
  const response = await fetch(BASE + target, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies[as] ? { Cookie: cookies[as] } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString('utf8')); } catch (error) { json = null; }
  return { status: response.status, headers: response.headers, json };
}

async function expectOk(promise, label) {
  const response = await promise;
  if (response.status !== 200) {
    throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

async function login(username, password) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 200) throw new Error(`登录失败 ${username}: ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}

function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      QMS_DB_PATH: DB_PATH,
      QMS_ADMIN_PASSWORD: PASSWORDS.admin,
      QMS_ENGINEER_PASSWORD: PASSWORDS.engineer,
      QMS_QUALITY_PASSWORD: PASSWORDS.quality,
      QMS_AUDITOR_PASSWORD: PASSWORDS.auditor,
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.on('data', chunk => { serverLog += chunk.toString(); });
  proc.stderr.on('data', chunk => { serverLog += chunk.toString(); });
  return proc;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/meta`);
      if (response.status === 401 || response.ok) return;
    } catch (error) { /* 还没监听 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未在 12 秒内启动\n' + serverLog);
}

function documentColumns(doc) {
  return Object.fromEntries(doc.sections.flatMap(section => section.fields)
    .filter(field => field.type === 'table')
    .map(field => [field.k, field.cols]));
}

async function saveDocument(code, update) {
  const doc = await expectOk(api('GET', `/docs/${code}?p=${PROJECT}`), `读取 ${code}`);
  const data = JSON.parse(JSON.stringify(doc.data || {}));
  update(data);
  return expectOk(api('PUT', `/docs/${code}?p=${PROJECT}`, {
    body: {
      data, cols: documentColumns(doc), status: '草稿', version: doc.version,
      change_note: `P1-2 测试维护 ${code}`,
    },
  }), `保存 ${code}`);
}

async function approveDocument(code) {
  await expectOk(api('POST', `/docs/${code}/submit?p=${PROJECT}`, { body: {} }), `提交 ${code}`);
  return expectOk(api('POST', `/docs/${code}/approve?p=${PROJECT}`, {
    as: 'quality', body: {},
  }), `批准 ${code}`);
}

async function approveCp(planId) {
  await expectOk(api('PATCH', `/cp/${planId}?p=${PROJECT}`, { body: { status: '待审核' } }), 'CP 提交审核');
  await expectOk(api('PATCH', `/cp/${planId}?p=${PROJECT}`, {
    as: 'quality', body: { status: '已批准' },
  }), 'CP 批准');
}

function cpSnapshot(rows, rowId) {
  return rows.find(row => row.cp_row_id === rowId);
}

async function readCp(planId) {
  return expectOk(api('GET', `/cp?p=${PROJECT}&stage=PILOT`), '读取 CP');
}

function studyData(plan) {
  return Array.from({ length: plan.operators * plan.trials }, (_, row) =>
    Array.from({ length: plan.parts }, (_, part) =>
      +(10 + part * 0.01 + row * 0.001).toFixed(6)));
}

async function main() {
  child = startServer();
  await waitForServer();
  for (const [role, username] of [['admin', 'admin'], ['quality', 'quality']]) {
    cookies[role] = await login(username, PASSWORDS[role]);
  }

  /* ------------------------------------------------------------ 基础数据 */
  await expectOk(api('POST', '/api/projects', {
    body: {
      name: 'P1-2 特性规范穿透', project_id: PROJECT, family_id: 'FM',
      part_no: 'RJ-P12-001', owner: '验收管理员',
    },
  }), '创建项目');
  const cpList = await expectOk(api('GET', `/cp?p=${PROJECT}`), '读取控制计划');
  const planId = (cpList.plans.find(plan => plan.stage === 'PILOT') || {}).cp_id;
  assert.ok(planId, '新项目应自动创建 PILOT 控制计划');
  const gauge = await expectOk(api('POST', '/api/gauges', {
    body: {
      code: 'P12-G1', name: 'P1-2 数显千分尺', calibration_due: '2099-12-31',
      resolution: 0.001, status: '在用',
    },
  }), '创建检具');
  const step = await expectOk(api('POST', '/api/steps', {
    body: { name: 'P1-2 测量工序', mode: 'PROCESS', step_type: '检验' },
  }), '创建工序');

  const masterA = await expectOk(api('POST', '/api/chars', {
    body: {
      name: 'P1-2 阻值', char_kind: 'PRODUCT', family_id: 'FM',
      target: 10, lsl: 9, usl: 11, unit: 'Ω', tol_text: '10±1 Ω',
    },
  }), '创建特性 A');
  const importedA = await expectOk(api('POST', '/api/project-chars/from-dictionary', {
    body: { char_id: masterA.char_id },
  }), '引入特性 A');
  const pcharA = importedA.item.pchar_id;
  assert.equal(importedA.item.lsl, 9, '项目特性应继承字典下限');
  assert.equal(importedA.item.usl, 11, '项目特性应继承字典上限');

  const rowA = await expectOk(api('POST', '/api/cp/row', {
    body: {
      cp_id: planId, step_id: step.step_id, project_char_id: pcharA, gauge_id: gauge.gauge_id,
      sample_size: 5, freq_value: 2, freq_unit: 'h', measure_tech: '数显千分尺',
    },
  }), '创建 CP 行 A');
  checks += 1;

  let cp = await readCp();
  assert.equal(cpSnapshot(cp.rows, rowA.cp_row_id).spec_text, '10±1 Ω',
    'CP 行应自动带出完整规范文本');
  await approveCp(planId);

  /* ------------------------------------------------- C-04：子组不回写 CP */
  const monitor = await expectOk(api('POST', `/cp/${rowA.cp_row_id}/monitor?p=${PROJECT}`, {
    body: { chart_type: 'I-MR', subgroup_n: 1, freq_value: 4, freq_unit: 'h', gauge_id: gauge.gauge_id },
  }), '创建 SPC 监控项');
  cp = await readCp();
  const rowAfterMonitor = cpSnapshot(cp.rows, rowA.cp_row_id);
  assert.equal(rowAfterMonitor.sample_size, 5, 'C-04：SPC 子组大小不得覆盖 CP 样本容量');
  assert.equal(rowAfterMonitor.freq_value, 2, 'C-04：SPC 抽样频率不得回写 CP 抽样要求');
  checks += 2;
  await expectOk(api('PATCH', `/monitoring/${monitor.mon_id}/review?p=${PROJECT}`, {
    as: 'quality', body: { action: 'approve' },
  }), '审核 SPC 监控项');
  await approveCp(planId);

  /* --------------------------------- D-03：初始规范贯穿 CP/SPC/MSA 一致 */
  let spc = await expectOk(api('GET', `/spc?p=${PROJECT}`), '读取 SPC');
  let spcItem = spc.items.find(item => item.mon_id === monitor.mon_id);
  assert.ok(spcItem, '已批准的监控项应出现在 SPC 列表');
  assert.deepEqual(
    [spcItem.lsl, spcItem.usl, spcItem.target, spcItem.unit, spcItem.tol_text],
    [9, 11, 10, 'Ω', '10±1 Ω'],
    'D-03：SPC 不得出现空规范，必须与项目特性同值'
  );
  checks += 1;
  let msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), '读取 MSA');
  let plan = msa.plans.find(item => item.cp_row_id === rowA.cp_row_id && item.source_active !== 0);
  assert.ok(plan, 'MSA 应自动生成计划');
  assert.deepEqual(
    [plan.char_lsl_snapshot, plan.char_usl_snapshot, plan.tolerance],
    [9, 11, 2],
    'D-03：MSA 计划应带出规范与公差'
  );
  const studyA = await expectOk(api('POST', '/api/msa', {
    body: { plan_id: plan.plan_id, data: studyData(plan) },
  }), '按计划计算 GR&R');
  assert.equal(studyA.tolerance, 2, 'MSA 研究应使用计划公差');
  checks += 2;

  /* --------------------------- D-03：改特性主数据 → CP/SPC/MSA 同事务同值 */
  const masterUpdate = await expectOk(api('PATCH', `/chars/${masterA.char_id}?p=${PROJECT}`, {
    body: { target: 10, lsl: 9.5, usl: 10.5, unit: 'Ω', tol_text: '10±0.5 Ω' },
  }), '修改特性主数据');
  assert.ok(masterUpdate.propagation.project_chars >= 1,
    '修改主数据应在同步结果中报告受影响项目特性');
  assert.ok(masterUpdate.propagation.spec.cp_rows >= 1,
    '同步结果应报告更新后的 CP 行数');
  const charAfterMaster = (await expectOk(api('GET', `/project-chars?p=${PROJECT}`), '读取项目特性'))
    .items.find(item => item.pchar_id === pcharA);
  assert.deepEqual(
    [charAfterMaster.lsl, charAfterMaster.usl, charAfterMaster.target, charAfterMaster.tol_text],
    [9.5, 10.5, 10, '10±0.5 Ω'],
    'D-03：特性主数据数值应穿透到项目特性'
  );
  cp = await readCp();
  const rowAfterMaster = cpSnapshot(cp.rows, rowA.cp_row_id);
  assert.equal(rowAfterMaster.spec_text, '10±0.5 Ω', 'D-03：CP 行规范应与项目特性同值');
  assert.equal(cp.plans.find(item => item.cp_id === planId).status, '草稿',
    'D-03：规范变更应把 CP 降为草稿待复核');
  const pending = await expectOk(api('GET', `/monitoring/pending?p=${PROJECT}`), '读取待审核监控');
  assert.ok(pending.list.some(item => item.mon_id === monitor.mon_id),
    'D-03：规范变更应把关联 SPC 监控项置为待审核');
  msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), '再次读取 MSA');
  plan = msa.plans.find(item => item.cp_row_id === rowA.cp_row_id && item.source_active !== 0);
  assert.deepEqual(
    [plan.char_lsl_snapshot, plan.char_usl_snapshot, plan.tolerance, plan.source_status],
    [9.5, 10.5, 1, '待复核'],
    'D-03：MSA 计划快照与公差应随规范更新并待复核'
  );
  const spcDetail = await expectOk(api('GET', `/spc/${monitor.mon_id}?p=${PROJECT}`), '读取 SPC 详情');
  assert.deepEqual([spcDetail.cpRow.lsl, spcDetail.cpRow.usl], [9.5, 10.5],
    'D-03：SPC 实时读取项目特性规范，不应保留旧值');
  checks += 7;

  // 复核后 SPC 与 MSA 再次同值
  await approveCp(planId);
  await expectOk(api('PATCH', `/monitoring/${monitor.mon_id}/review?p=${PROJECT}`, {
    as: 'quality', body: { action: 'approve' },
  }), '重新审核 SPC 监控项');
  spc = await expectOk(api('GET', `/spc?p=${PROJECT}`), '复核后读取 SPC');
  spcItem = spc.items.find(item => item.mon_id === monitor.mon_id);
  assert.deepEqual([spcItem.lsl, spcItem.usl, spcItem.tol_text], [9.5, 10.5, '10±0.5 Ω'],
    '复核后 SPC 规范应与新项目特性一致');
  msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), '复核后读取 MSA');
  plan = msa.plans.find(item => item.cp_row_id === rowA.cp_row_id && item.source_active !== 0);
  assert.deepEqual([plan.char_lsl_snapshot, plan.char_usl_snapshot, plan.tolerance], [9.5, 10.5, 1],
    '复核后 MSA 新计划应与新规范一致');
  const studyA2 = await expectOk(api('POST', '/api/msa', {
    body: { plan_id: plan.plan_id, data: studyData(plan) },
  }), '按新规范计算 GR&R');
  assert.equal(studyA2.tolerance, 1, 'MSA 研究应使用新公差');
  checks += 3;

  /* ------------------------ D-03：项目特性人工调整同样贯穿下游 */
  await expectOk(api('PATCH', `/project-chars/${encodeURIComponent(pcharA)}?p=${PROJECT}`, {
    body: { lsl: 9.8, usl: 10.2, tol_text: '10±0.2 Ω' },
  }), '调整项目特性规范');
  cp = await readCp();
  assert.equal(cpSnapshot(cp.rows, rowA.cp_row_id).spec_text, '10±0.2 Ω',
    '项目特性调整应同步 CP 行规范');
  msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), '项目特性调整后读取 MSA');
  plan = msa.plans.find(item => item.cp_row_id === rowA.cp_row_id && item.source_active !== 0);
  assert.deepEqual([plan.char_lsl_snapshot, plan.char_usl_snapshot, plan.tolerance], [9.8, 10.2, 0.4],
    '项目特性调整应刷新 MSA 计划快照');
  checks += 2;

  /* --------------------------- D-03：P2-11 正式确认的数值穿透 */
  const masterB = await expectOk(api('POST', '/api/chars', {
    body: { name: 'P2-11 规格特性', char_kind: 'PRODUCT', family_id: 'FM' },
  }), '创建待 P2-11 确认的特性');
  const importedB = await expectOk(api('POST', '/api/project-chars/from-dictionary', {
    body: { char_id: masterB.char_id },
  }), '引入待确认特性');
  assert.equal(importedB.item.lsl, null, '前置条件：字典未维护数值规范');
  const rowB = await expectOk(api('POST', '/api/cp/row', {
    body: {
      cp_id: planId, step_id: step.step_id, project_char_id: importedB.item.pchar_id,
      gauge_id: gauge.gauge_id, sample_size: 5, freq_value: 2, freq_unit: 'h',
      measure_tech: '数显千分尺',
    },
  }), '创建 CP 行 B');
  await approveCp(planId);
  msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), 'P2-11 前读取 MSA');
  let planB = msa.plans.find(item => item.cp_row_id === rowB.cp_row_id && item.source_active !== 0);
  assert.ok(planB, 'CP 行 B 应生成 MSA 计划');
  assert.equal(planB.tolerance, null, '前置条件：计划公差为空');

  await saveDocument('P2-11', data => {
    data.chars = [[masterB.char_id, 'P2-11 规格特性', '20±0.4 mm', 'SC', '顾客图纸', '', 'PRODUCT']];
    if (data._syncRows) delete data._syncRows.chars;
    if (data._syncMeta) delete data._syncMeta.chars;
  });
  const p211 = await approveDocument('P2-11');
  assert.ok(p211.sync.spec.characteristics >= 1,
    'P2-11 批准同步结果应报告项目特性规范更新');
  const charB = (await expectOk(api('GET', `/project-chars?p=${PROJECT}`), '读取项目特性 B'))
    .items.find(item => item.char_id === masterB.char_id);
  assert.deepEqual(
    [charB.target, charB.lsl, charB.usl, charB.unit, charB.tol_text],
    [20, 19.6, 20.4, 'mm', '20±0.4 mm'],
    'D-03：P2-11 的数值规范应解析并写入项目特性'
  );
  cp = await readCp();
  assert.equal(cpSnapshot(cp.rows, rowB.cp_row_id).spec_text, '20±0.4 mm',
    'D-03：P2-11 规范应穿透到已有 CP 行');
  msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), 'P2-11 后读取 MSA');
  planB = msa.plans.find(item => item.cp_row_id === rowB.cp_row_id && item.source_active !== 0);
  assert.deepEqual(
    [planB.char_lsl_snapshot, planB.char_usl_snapshot, planB.tolerance, planB.source_status],
    [19.6, 20.4, 0.8, '待复核'],
    'D-03：P2-11 规范应刷新 MSA 计划快照'
  );
  checks += 4;

  /* ------------------------------------------- M-07：空公差不再卡死 */
  const masterC = await expectOk(api('POST', '/api/chars', {
    body: { name: '空公差特性', char_kind: 'PROCESS', family_id: 'FM' },
  }), '创建空公差特性');
  const importedC = await expectOk(api('POST', '/api/project-chars/from-dictionary', {
    body: { char_id: masterC.char_id },
  }), '引入空公差特性');
  const processStep = await expectOk(api('POST', '/api/steps', {
    body: { name: '空公差工序', mode: 'PROCESS', step_type: '制造' },
  }), '创建空公差工序');
  const rowC = await expectOk(api('POST', '/api/cp/row', {
    body: {
      cp_id: planId, step_id: processStep.step_id, project_char_id: importedC.item.pchar_id,
      gauge_id: gauge.gauge_id, sample_size: 5, freq_value: 2, freq_unit: 'h',
      measure_tech: '数显千分尺',
    },
  }), '创建空公差 CP 行');
  await approveCp(planId);
  msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), '空公差读取 MSA');
  const planC = msa.plans.find(item => item.cp_row_id === rowC.cp_row_id && item.source_active !== 0);
  assert.ok(planC && planC.tolerance == null, '前置条件：计划公差为空');
  const blank = await api('POST', '/api/msa', {
    body: { plan_id: planC.plan_id, tolerance: 0, data: studyData(planC) },
  });
  assert.ok(blank.status >= 400 && blank.status < 500, '空公差且未填写时应被拒绝');
  assert.match(String(blank.json?.error || ''), /计划尚未维护公差|维护项目特性/,
    'M-07：错误文案应指向计划缺公差，而不是“研究设计与计划不一致”');
  const rescued = await expectOk(api('POST', '/api/msa', {
    body: { plan_id: planC.plan_id, tolerance: 4.5, data: studyData(planC) },
  }), 'M-07：填写公差后计算 GR&R');
  assert.equal(rescued.tolerance, 4.5, 'M-07：本次填写的公差应被采用');
  msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), 'M-07 后读取 MSA');
  const planCAfter = msa.plans.find(item => item.plan_id === planC.plan_id);
  assert.equal(planCAfter.tolerance, 4.5, 'M-07：公差应写回 MSA 计划');
  checks += 3;

  /* ------------------------------------- Q-09：CP 行重挂特性 */
  const other = await expectOk(api('POST', '/api/chars', {
    body: {
      name: '重挂目标特性', char_kind: 'PRODUCT', family_id: 'FM',
      target: 30, lsl: 29, usl: 31, unit: 'mm', tol_text: '30±1 mm',
    },
  }), '创建重挂目标特性');
  const importedOther = await expectOk(api('POST', '/api/project-chars/from-dictionary', {
    body: { char_id: other.char_id },
  }), '引入重挂目标特性');
  const remap = await expectOk(api('PATCH', `/cp/row/${rowA.cp_row_id}/characteristic?p=${PROJECT}`, {
    body: { project_char_id: importedOther.item.pchar_id },
  }), 'CP 行重挂特性');
  assert.ok(remap.monitoring_items >= 1, 'Q-09：重挂后关联监控项应回到待审核');
  const detailAfterRemap = await expectOk(api('GET', `/spc/${monitor.mon_id}?p=${PROJECT}`), '重挂后读取 SPC');
  assert.deepEqual([detailAfterRemap.cpRow.lsl, detailAfterRemap.cpRow.usl],
    [29, 31], 'Q-09：SPC 必须实时采用 cp_row.project_char_id 的新规范');
  const pendingAfterRemap = await expectOk(api('GET', `/monitoring/pending?p=${PROJECT}`), '重挂后读取待审核监控');
  assert.ok(pendingAfterRemap.list.some(item => item.mon_id === monitor.mon_id),
    'Q-09：重挂后监控项不得沿用旧特性直接判定 Cpk');
  checks += 3;

  /* ------------------- 主数据变更不得覆盖项目已确认的特定规范 */
  const preserved = await expectOk(api('PATCH', `/chars/${masterA.char_id}?p=${PROJECT}`, {
    body: { target: 10, lsl: 9.9, usl: 10.1, unit: 'Ω', tol_text: '10±0.1 Ω' },
  }), '再次修改特性主数据');
  assert.ok(preserved.propagation.preserved_local >= 1,
    '已是项目特定值的项目特性应被保留，不被共享字典覆盖');
  assert.ok(!preserved.propagation.projects.includes(PROJECT),
    '当前项目没有“仍与主数据一致”的副本，不应报告为已穿透');
  const charPreserved = (await expectOk(api('GET', `/project-chars?p=${PROJECT}`), '读取保留后的项目特性'))
    .items.find(item => item.pchar_id === pcharA);
  assert.deepEqual([charPreserved.lsl, charPreserved.usl, charPreserved.tol_text],
    [9.8, 10.2, '10±0.2 Ω'], '项目已确认规范不得被特性字典回写');
  checks += 3;

  /* --------------------- 不可解析的历史规范文本保留（不做批量硬改） */
  const legacy = await expectOk(api('POST', '/api/cp/row', {
    body: {
      cp_id: planId, step_id: step.step_id, project_char_id: importedB.item.pchar_id,
      gauge_id: gauge.gauge_id, sample_size: 5, freq_value: 2, freq_unit: 'h',
      spec_text: '见顾客图纸', measure_tech: '数显千分尺',
    },
  }), '创建自由文本规范 CP 行');
  await approveCp(planId);
  await expectOk(api('PATCH', `/project-chars/${encodeURIComponent(importedB.item.pchar_id)}?p=${PROJECT}`, {
    body: { lsl: 19.5, usl: 20.5, unit: 'mm', tol_text: '20±0.5 mm' },
  }), '调整项目特性 B 规范');
  cp = await readCp();
  assert.equal(cpSnapshot(cp.rows, legacy.cp_row_id).spec_text, '见顾客图纸',
    '不可解析的历史自由文本不被规范同步静默覆盖');
  msa = await expectOk(api('GET', `/msa?p=${PROJECT}`), '自由文本 CP 行读取 MSA');
  const legacyPlan = msa.plans.find(item => item.cp_row_id === legacy.cp_row_id && item.source_active !== 0);
  assert.deepEqual([legacyPlan.char_lsl_snapshot, legacyPlan.tolerance], [19.5, 1],
    '即使 CP 规范为自由文本，MSA 仍使用项目特性的数值规范');
  checks += 2;

  const audit = await expectOk(api('GET', `/audit?p=${PROJECT}`), '读取审计');
  assert.ok(audit.list.some(event => event.object_type === 'char_master' && event.action === '修改'),
    '规范修改应在审计流中可见');
  checks += 1;

  console.log(`P1-2 characteristic specification penetration tests passed (${checks} checks)`);
}

main()
  .catch(error => {
    console.error('P1-2 验收测试失败：');
    console.error(error);
    if (serverLog) console.error('\n--- server log ---\n' + serverLog);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (child) child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(TEMP, { recursive: true, force: true });
  });
