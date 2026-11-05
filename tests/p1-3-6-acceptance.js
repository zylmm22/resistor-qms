'use strict';

/**
 * P1-3 ～ P1-6 审查问题修订验收测试。
 *
 *   P1-3 PFMEA ↔ CP 硬关联（C-11、F-05、F-06）
 *   P1-4 PPAP 质量门（B-04、B-02、M-13）；M-02 由 tests/msa-judgment.js 覆盖
 *   P1-5 Gate/阶段统一（S-01、S-06、S-07）
 *   P1-6 ECR 落地（E-01、E-03）
 *
 * 运行：node tests/p1-3-6-acceptance.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-p136-'));
const DB_PATH = path.join(TEMP, 'qms.db');
const PORT = 24700 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}/api`;
const PROJECT = 'P136-ACC';
const PASSWORDS = {
  admin: 'P136-Admin-2026', quality: 'P136-Quality-2026', engineer: 'P136-Engineer-2026',
  auditor: 'P136-Auditor-2026',
};
const cookies = {};
let child = null;
let serverLog = '';
let checks = 0;

async function api(method, url, options = {}) {
  const { as = 'admin', body } = options;
  let target = url.startsWith('/api/') ? url.slice(4) : url;
  if (target !== '/projects' && target !== '/auth/login' && !target.includes('p=')) {
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

async function expectStatus(promise, status, label) {
  const response = await promise;
  if (response.status !== status) {
    throw new Error(`${label}: 期望 HTTP ${status}，实际 ${response.status} ${JSON.stringify(response.json)}`);
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
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH,
      QMS_ADMIN_PASSWORD: PASSWORDS.admin, QMS_QUALITY_PASSWORD: PASSWORDS.quality,
      QMS_ENGINEER_PASSWORD: PASSWORDS.engineer, QMS_AUDITOR_PASSWORD: PASSWORDS.auditor,
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
    } catch (error) { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未在 12 秒内启动\n' + serverLog);
}

function directDb(fn) {
  const db = new DatabaseSync(DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

async function approveCp(planId, as = 'quality') {
  await expectOk(api('PATCH', `/cp/${planId}`, { body: { status: '待审核' } }), 'CP 提交审核');
  return api('PATCH', `/cp/${planId}`, { as, body: { status: '已批准' } });
}

async function main() {
  child = startServer();
  await waitForServer();
  for (const [role, username] of [['admin', 'admin'], ['quality', 'quality']]) {
    cookies[role] = await login(username, PASSWORDS[role]);
  }

  await expectOk(api('POST', '/projects', {
    body: {
      name: 'P1-3～P1-6 验收项目', project_id: PROJECT, family_id: 'FM',
      part_no: 'RJ-P136-001', owner: 'P136 项目负责人',
    },
  }), '创建验收项目');
  const plans = await expectOk(api('GET', '/cp'), '读取控制计划');
  const planId = (plans.plans.find(plan => plan.stage === 'PILOT') || {}).cp_id;
  assert.ok(planId, '应自动创建 PILOT 控制计划');
  const step = await expectOk(api('POST', '/steps', {
    body: { name: 'P136 机加工', mode: 'PROCESS', step_type: '制造' },
  }), '创建工序');
  const master = await expectOk(api('POST', '/chars', {
    body: {
      name: 'P136 关键尺寸', char_kind: 'PRODUCT', family_id: 'FM',
      target: 10, lsl: 9, usl: 11, unit: 'mm', tol_text: '10±1 mm', special_symbol: 'CC',
    },
  }), '创建特殊特性');
  const imported = await expectOk(api('POST', '/project-chars/from-dictionary', {
    body: { char_id: master.char_id },
  }), '引入特殊特性');
  const pcharId = imported.item.pchar_id;

  /* ------------------------------------------------------------- P1-3 */
  process.stdout.write('\n== P1-3 PFMEA ↔ CP 硬关联 ==\n');
  const node = await expectOk(api('POST', '/fmea/node', {
    body: { fmea_type: 'PFMEA', name: 'P136 机加工工序' },
  }), '创建 PFMEA 结构节点');
  const func = await expectOk(api('POST', '/fmea/functions', {
    body: { node_id: node.node_id, text: '加工电阻器外形至 10 mm' },
  }), '创建 PFMEA 功能');
  const fmeaRow = await expectOk(api('POST', '/fmea/row', {
    body: {
      fmea_type: 'PFMEA', focus_node_id: node.node_id, func_id: func.func_id,
      fe_text: '尺寸超差', fm_text: '外形尺寸偏大', fc_text: '刀具磨损',
      s: 10, o: 7, d: 7, char_id: master.char_id, step_id: step.step_id,
      pc_text: '首件检验', dc_text: '卡尺测量',
    },
  }), '创建高 AP PFMEA 行');
  assert.equal(fmeaRow.ap, 'H', '前置条件：PFMEA 行应为高 AP');
  await expectOk(api('POST', '/fmea/decision', {
    body: { row_id: fmeaRow.row_id, decision: 'TAKE_ACTION', rationale: '按周期更换刀具并首件确认', status: '待评审' },
  }), '提交高 AP 处置决定');
  await expectOk(api('POST', '/fmea/decision', {
    as: 'quality', body: { row_id: fmeaRow.row_id, status: '已批准', decision: 'TAKE_ACTION' },
  }), '批准高 AP 处置决定');
  await expectOk(api('POST', '/fmea/publish', {
    as: 'quality', body: { fmea_type: 'PFMEA' },
  }), '发布 PFMEA');
  checks += 3;

  const unlinked = await expectOk(api('POST', '/cp/row', {
    body: {
      cp_id: planId, step_id: step.step_id, project_char_id: pcharId,
      sample_size: 5, freq_value: 2, freq_unit: 'h', measure_tech: '卡尺',
    },
  }), '创建无 PFMEA 依据的 CP 行');
  const blocked = await approveCp(planId);
  assert.equal(blocked.status, 409, 'C-11：特殊特性行无 PFMEA 依据不能批准');
  assert.ok(Array.isArray(blocked.json?.details?.cp_rows) && blocked.json.details.cp_rows.length > 0,
    'C-11：应列出缺少依据的 CP 行');
  checks += 2;

  await expectOk(api('DELETE', `/cp/row/${unlinked.cp_row_id}`), '删除无依据 CP 行');
  const linkedRow = await expectOk(api('POST', '/cp/row', {
    body: {
      cp_id: planId, step_id: step.step_id, project_char_id: pcharId,
      fmea_row_id: fmeaRow.row_id,
      sample_size: 5, freq_value: 2, freq_unit: 'h', measure_tech: '卡尺',
    },
  }), '创建有 PFMEA 依据的 CP 行');
  assert.equal(linkedRow.fmea_row_id, fmeaRow.row_id, 'C-11：控制计划行应记录 PFMEA 依据');
  await expectOk(api('PATCH', `/cp/${planId}`, { body: { status: '待审核' } }), 'CP 重新提交审核');
  await expectOk(api('PATCH', `/cp/${planId}`, {
    as: 'quality', body: { status: '已批准' },
  }), 'C-11：有依据的 CP 行可以批准');
  checks += 2;

  // F-05：S/O/D 变化后旧决定失效
  await expectOk(api('POST', '/fmea/row', {
    body: {
      row_id: fmeaRow.row_id, fmea_type: 'PFMEA', focus_node_id: node.node_id,
      func_id: func.func_id, fe_text: '尺寸超差', fm_text: '外形尺寸偏大', fc_text: '刀具磨损',
      s: 10, o: 7, d: 8, char_id: master.char_id, step_id: step.step_id,
      pc_text: '首件检验', dc_text: '卡尺测量',
    },
  }), '修改 PFMEA 行严重度/探测度');
  const fmeaAfter = await expectOk(api('GET', '/fmea?type=PFMEA'), '读取 PFMEA');
  const decisionAfter = fmeaAfter.rows.find(row => row.row_id === fmeaRow.row_id);
  assert.equal(decisionAfter.dstatus, '待评审', 'F-05：S/O/D 变化后原批准决定应回到待评审');
  const publishBlocked = await api('POST', '/fmea/publish', { as: 'quality', body: { fmea_type: 'PFMEA' } });
  assert.equal(publishBlocked.status, 400, 'F-05：决定失效后 PFMEA 不能再次发布');
  assert.match(String(publishBlocked.json?.error || ''), /高 AP|旧 S\/O\/D/);
  checks += 2;

  // F-06：删除 FMEA 行清理链接并降级 CP
  await expectOk(api('DELETE', `/fmea/row/${fmeaRow.row_id}`), '删除 PFMEA 行');
  const cpAfterDelete = await expectOk(api('GET', '/cp?stage=PILOT'), '删除后读取控制计划');
  const affectedRows = cpAfterDelete.rows.filter(row => row.project_char_id === pcharId);
  assert.ok(affectedRows.length > 0, '控制计划行应保留');
  assert.ok(affectedRows.every(row => row.status !== '停用'), '控制计划行不应被删除');
  assert.equal(cpAfterDelete.plans.find(plan => plan.cp_id === planId).status, '草稿',
    'F-06：依据删除后控制计划应降为草稿');
  const deletable = await api('DELETE', `/cp/row/${linkedRow.cp_row_id}`);
  assert.equal(deletable.status, 200, 'F-06：cp_fmea_link 已清理，控制计划行可删除');
  checks += 3;

  /* ------------------------------------------------------------- P1-4 */
  process.stdout.write('\n== P1-4 PPAP 质量门 ==\n');
  const ppap = await expectOk(api('GET', '/ppap'), '读取 PPAP');
  assert.deepEqual(ppap.level_requirements[1], [18], 'B-02：Level 1 只提交 PSW');
  assert.deepEqual(ppap.level_requirements[2], [1, 2, 3, 9, 10, 12, 13, 14, 17, 18],
    'B-02：Level 2 为 PSW + 样品 + 有限支持数据');
  assert.deepEqual(ppap.level_requirements[3], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    'B-02：Level 3 提交全部 18 项');
  assert.deepEqual(ppap.level_requirements[4], [18], 'B-02：Level 4 默认仅 PSW，可由顾客指定覆盖');
  assert.equal(ppap.level_requirements[5].length, 18, 'B-02：Level 5 要求全部 18 项');
  const msaGate = ppap.workflow.find(item => item.no === 8);
  assert.equal(msaGate.gate_ready, false, 'B-04：无 MSA 计划时质量门不应通过');
  assert.match(msaGate.gate_reason, /MSA|计划/);
  const spcGate = ppap.workflow.find(item => item.no === 11);
  assert.equal(spcGate.gate_ready, false, 'B-04：无 SPC 能力研究时质量门不应通过');
  checks += 6;

  const deviation = await expectOk(api('POST', '/ppap/deviations', {
    body: { element_no: 8, reason: '顾客书面同意使用外部实验室 MSA 报告，待补内部研究', valid_until: '2099-12-31' },
  }), '登记 PPAP 书面偏差');
  await expectOk(api('PATCH', `/ppap/deviations/${deviation.deviation_id}`, {
    as: 'quality', body: { action: 'approve', note: '顾客邮件批准' },
  }), '批准 PPAP 书面偏差');
  const ppapWithDeviation = await expectOk(api('GET', '/ppap'), '偏差后读取 PPAP');
  const msaGateWithDeviation = ppapWithDeviation.workflow.find(item => item.no === 8);
  assert.equal(msaGateWithDeviation.gate_ready, true, 'B-04：已批准偏差可放行质量门');
  assert.ok(msaGateWithDeviation.deviation?.deviation_id === deviation.deviation_id);
  checks += 2;

  // B-09：证据先待确认，再由质量角色确认完成
  await expectOk(api('PATCH', '/ppap/18', { body: { status: '待确认', evidence: 'PSW-P136-001' } }),
    '保存 PSW 证据');
  await expectOk(api('PATCH', '/ppap/18', {
    as: 'quality', body: { status: '已完成', evidence: 'PSW-P136-001' },
  }), '完成 PSW 要素');
  await expectOk(api('PATCH', '/ppap/submission', { body: { level: 4 } }), '设置 Level 4');
  const packaged = await expectOk(api('POST', '/ppap/package', { body: { level: 4 } }), 'B-02：Level 4 打包');
  assert.ok(packaged.pkg_id, 'B-02：Level 4 应允许仅按 PSW 打包');
  const level2 = await api('POST', '/ppap/package', { body: { level: 2 } });
  assert.equal(level2.status, 400, 'B-02：Level 2 必须要求设计记录等有限支持数据');
  assert.match(String(level2.json?.error || ''), /设计记录/);
  checks += 3;

  // M-13：来源失效的研究标记并排除
  directDb(db => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO msa_plan_item(
      plan_id,project_id,project_char_id,char_id,status,source_active,source_status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      'MSP-P136-STALE', PROJECT, pcharId, master.char_id, '已完成', 0, '已替代', now, now);
    db.prepare(`INSERT INTO msa_study(
      project_id,gauge_id,study_type,char_id,project_char_id,tolerance,judgment,
      studied_at,plan_id,status
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      PROJECT, 'G-P136', 'GRR', master.char_id, pcharId, 2, '接受', now.slice(0, 10), 'MSP-P136-STALE', '已完成');
  });
  const msa = await expectOk(api('GET', '/msa'), '读取 MSA 研究');
  const staleStudy = msa.studies.find(study => study.plan_id === 'MSP-P136-STALE');
  assert.ok(staleStudy, '应读取到直接登记的研究');
  assert.equal(staleStudy.source_invalid, true, 'M-13：来源已替代的研究应标记依据失效');
  assert.match(staleStudy.source_invalid_reason, /已替代/);
  checks += 2;

  /* ------------------------------------------------------------- P1-5 */
  process.stdout.write('\n== P1-5 Gate/阶段统一 ==\n');
  directDb(db => {
    db.prepare(`INSERT INTO gate_review(
      project_id,phase,decision,reviewer,comment,reviewed_at,checks_json,criteria_version,actions_json
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      PROJECT, 0, '通过', 'Legacy', '旧版检查表', '2026-01-01', '[1,1,1]', 'APQP3-GATE-OLD', '[]');
  });
  const gates = await expectOk(api('GET', '/gates'), '读取 Gate');
  assert.equal(gates.gates[0].decision, '待复核', 'S-01：旧版通过记录应映射为待复核');
  assert.equal(gates.gates[0].needsRevalidation, true);
  assert.equal(gates.gates[1].canReview, false, '旧版 Gate 不能解锁下一道 Gate');
  const alerts = await expectOk(api('GET', '/alerts'), '读取预警');
  const gateAlert = alerts.list.find(item => item.type === '门径' && item.ref === '0');
  assert.ok(gateAlert, 'S-01：预警中心应提示 Gate 0 未通过');
  assert.match(gateAlert.detail, /检查表已升级/);
  const cockpit = await expectOk(api('GET', '/cockpit'), '读取驾驶舱');
  assert.equal(cockpit.metrics.gatePassed, 0, 'S-01：驾驶舱不得把旧版通过计入健康分');
  checks += 4;

  const passGate0 = await expectOk(api('POST', '/gates/0', {
    as: 'quality', body: { checks: [1, 1, 1], decision: '通过', comment: 'P1-5 验收通过 Gate 0' },
  }), 'Gate 0 通过');
  assert.equal(passGate0.derived_phase, 1, 'S-06：Gate 0 通过后派生阶段为 1');
  let meta = await expectOk(api('GET', '/meta'), '读取项目元数据');
  assert.equal(meta.project.phase, 1, 'S-06：project.phase 应跟随 Gate 派生');
  const rejectGate0 = await expectOk(api('POST', '/gates/0', {
    as: 'quality', body: { checks: [1, 1, 1], decision: '驳回', comment: 'S-06 回退验证' },
  }), 'Gate 0 驳回');
  assert.equal(rejectGate0.derived_phase, 0, 'S-06：Gate 驳回后派生阶段应回退');
  meta = await expectOk(api('GET', '/meta'), '再次读取项目元数据');
  assert.equal(meta.project.phase, 0, 'S-06：项目阶段不得只增不减');
  checks += 5;

  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const phaseNameMatch = appJs.match(/const phaseName = n => \[([\s\S]*?)\]\[n\]/);
  assert.ok(phaseNameMatch, '应存在 phaseName 映射');
  assert.match(phaseNameMatch[1], /^\s*'组织与准备'/, 'S-07：阶段名称数组必须与 0-based phase 对齐');
  checks += 1;

  /* ------------------------------------------------------------- P1-6 */
  process.stdout.write('\n== P1-6 ECR 落地 ==\n');
  const ecrChar = await expectOk(api('POST', '/chars', {
    body: {
      name: 'P136 ECR 特性', char_kind: 'PRODUCT', family_id: 'FM',
      target: 5, lsl: 4, usl: 6, unit: 'mm', tol_text: '5±1 mm',
    },
  }), '创建 ECR 目标特性');
  const ecrCharProject = await expectOk(api('POST', '/project-chars/from-dictionary', {
    body: { char_id: ecrChar.char_id },
  }), '引入 ECR 目标特性');
  const ecrPchar = ecrCharProject.item.pchar_id;

  const noImpact = await expectOk(api('POST', '/ecr', {
    body: { title: '无影响分析变更', reason: '验证 E-03 前置条件' },
  }), '创建无影响分析 ECR');
  const approveNoImpact = await api('PATCH', `/ecr/${noImpact.ecr_id}`, {
    as: 'quality', body: { status: '已批准' },
  });
  assert.equal(approveNoImpact.status, 409, 'E-03：无影响分析不得批准');
  await expectOk(api('PATCH', `/ecr/${noImpact.ecr_id}`, {
    as: 'quality', body: { status: '已批准', impact_analysis: '影响分析：仅涉及该特性规范，无其他下游对象变化' },
  }), 'E-03：补充影响分析后批准');
  checks += 2;

  const ecr = await expectOk(api('POST', '/ecr', {
    body: {
      title: 'P136 特性规范收紧', reason: '顾客要求提高精度',
      changes: [
        { object_type: 'project_char', object_id: ecrPchar, field_name: 'lsl', old_value: 4, new_value: 4.5 },
        { object_type: 'project_char', object_id: ecrPchar, field_name: 'tol_text', old_value: '5±1 mm', new_value: '5±0.5 mm' },
      ],
    },
  }), '创建结构化 ECR');
  assert.equal(ecr.changes, 2);
  await expectOk(api('PATCH', `/ecr/${ecr.ecr_id}`, {
    as: 'quality', body: { status: '已批准' },
  }), 'E-01：批准结构化 ECR');
  const applied = await expectOk(api('POST', `/ecr/${ecr.ecr_id}/apply`), 'E-01：实施结构化 ECR');
  assert.equal(applied.applied_changes, 2, 'E-01：应逐项执行 2 个字段变更');
  assert.ok(applied.branch_baseline_id, 'E-01：应生成变更后基线');
  const changedChar = (await expectOk(api('GET', '/project-chars'), '读取变更后的项目特性'))
    .items.find(item => item.pchar_id === ecrPchar);
  assert.equal(changedChar.lsl, 4.5, 'E-01：项目特性 LSL 应已更新');
  assert.equal(changedChar.tol_text, '5±0.5 mm', 'E-01：项目特性公差文本应已更新');
  const impact = await expectOk(api('GET', `/ecr/${ecr.ecr_id}/impact`), '读取 ECR 影响');
  const fieldItems = impact.items.filter(item => item.change_type === 'FIELD');
  assert.equal(fieldItems.length, 2);
  assert.ok(fieldItems.every(item => item.applied_at && item.applied_by), 'E-01：变更项应记录执行时间与执行人');
  checks += 5;

  const closeTooEarly = await api('PATCH', `/ecr/${ecr.ecr_id}`, {
    as: 'quality', body: { status: '已关闭' },
  });
  assert.equal(closeTooEarly.status, 409, 'E-03：无验证结论不得关闭');
  assert.match(String(closeTooEarly.json?.error || ''), /验证结论/);
  await expectOk(api('PATCH', `/ecr/${ecr.ecr_id}`, {
    as: 'quality', body: { status: '已关闭', verification: '首件检验与尺寸报告均确认新规范已生效' },
  }), 'E-03：填写验证结论后关闭');
  checks += 2;

  const stale = await expectOk(api('POST', '/ecr', {
    body: {
      title: 'P136 旧值变更', reason: '验证旧值不一致时拒绝实施',
      changes: [{ object_type: 'project_char', object_id: ecrPchar, field_name: 'usl', old_value: 99, new_value: 100 }],
    },
  }), '创建旧值不一致 ECR');
  await expectOk(api('PATCH', `/ecr/${stale.ecr_id}`, {
    as: 'quality', body: { status: '已批准' },
  }), '批准旧值不一致 ECR');
  const staleApply = await api('POST', `/ecr/${stale.ecr_id}/apply`);
  assert.equal(staleApply.status, 409, 'E-01：旧值不一致应整单拒绝，不能静默覆盖');
  const unchanged = (await expectOk(api('GET', '/project-chars'), '读取未变更特性'))
    .items.find(item => item.pchar_id === ecrPchar);
  assert.equal(unchanged.usl, 6, 'E-01：拒绝实施后目标值保持不变');
  checks += 2;

  const audit = await expectOk(api('GET', '/audit'), '读取审计');
  assert.ok(audit.list.some(event => event.object_type === 'ecr'), 'ECR 变更应在审计流中可见');
  checks += 1;

  console.log(`P1-3～P1-6 acceptance tests passed (${checks} checks)`);
}

main()
  .catch(error => {
    console.error('P1-3～P1-6 验收测试失败：');
    console.error(error);
    if (serverLog) console.error('\n--- server log ---\n' + serverLog);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (child) child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(TEMP, { recursive: true, force: true });
  });
