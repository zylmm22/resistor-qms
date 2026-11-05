'use strict';

/**
 * P3-2 ～ P3-5 剩余项验收。
 *
 *   A-05 模板与交付物绑定唯一、审批同步、按编号定位
 *   A-08 退回写版本、历史快照查看/恢复
 *   A-16/S-13 完成度只统计表单，模块/活动不计入
 *   A-19 自动保存快照不冒充变更原因
 *   A-20 批量提交 / 批量导出
 *   F-07 草稿允许缺 PC/DC，发布强制
 *   F-10 删除节点前影响预览
 *   F-11 只传 S 时回填场景
 *   C-07 文字类 CP 编辑不降级
 *   C-10 安全投产退出日期/原因校验
 *   D-07 覆盖率下钻返回 CP/SPC/MSA 明细
 *   D-09 工序字典生效区间重叠校验
 *   D-10 来源类型受控词表与来源编号格式校验
 *   Q-11 Excel 导入返回跳过行与批次号重复
 *   Q-16 Cpk 默认值由服务端统一下发
 *   P-04 工序发布/撤回快照与恢复
 *   B-09 证据待确认 → 质量确认完成
 *   B-13 PPAP 要素不适用需书面依据
 *   S-15 显式重算接口
 *
 * 运行：node tests/p3-2-5-remaining.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-p325-'));
const DB_PATH = path.join(TEMP, 'qms.db');
const PORT = 25800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}/api`;
const PROJECT = 'P325-ACC';
const PASSWORDS = {
  admin: 'P325-Admin-2026', quality: 'P325-Quality-2026',
  engineer: 'P325-Engineer-2026', auditor: 'P325-Auditor-2026',
};
const cookies = {};
let child = null;
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
  return { status: response.status, json, buffer };
}

async function ok(promise, label) {
  const response = await promise;
  if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(response.json)}`);
  return response.json;
}

async function login(username, password) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, `登录失败 ${username}`);
  return response.headers.get('set-cookie').split(';')[0];
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/meta`);
      if (response.status === 401 || response.ok) return;
    } catch (error) { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未启动');
}

function directDb(fn) {
  const db = new DatabaseSync(DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

async function main() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH,
      QMS_ADMIN_PASSWORD: PASSWORDS.admin, QMS_QUALITY_PASSWORD: PASSWORDS.quality,
      QMS_ENGINEER_PASSWORD: PASSWORDS.engineer, QMS_AUDITOR_PASSWORD: PASSWORDS.auditor,
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  try {
    await waitForServer();
    for (const [role, username] of [['admin', 'admin'], ['quality', 'quality']]) {
      cookies[role] = await login(username, PASSWORDS[role]);
    }
    await ok(api('POST', '/projects', {
      body: { name: 'P3-2~5 验收', project_id: PROJECT, family_id: 'FM', owner: 'Owner' },
    }), '创建项目');

    /* ---------------------------------------------- A-16 / S-13 完成度口径 */
    const docs = await ok(api('GET', '/docs'), '读取交付物');
    const formCount = require('../lib/doctpl').CATALOG
      .filter(item => item.kind === 'form' && item.group !== 'input').length;
    assert.equal(docs.summary.formTotal, formCount, 'S-13：完成度分母只统计表单');
    assert.equal(docs.summary.done, 0, 'A-16：新项目没有已批准表单');
    assert.ok(docs.phases.flatMap(phase => phase.docs)
      .filter(doc => doc.kind === 'module').every(doc => doc.status !== '已完成'),
    'A-16：系统模块不得计入已完成');
    const dashboard = await ok(api('GET', '/dashboard'), '读取总览');
    assert.equal(dashboard.docsTotal, formCount, 'S-13：总览与交付物清单共用分母');
    assert.equal(dashboard.docsDone, 0, 'S-13：总览与交付物清单共用分子');
    const cockpit = await ok(api('GET', '/cockpit'), '读取驾驶舱');
    assert.equal(cockpit.breakdown.find(item => item.name === '交付物完成度').value, `0/${formCount}`,
      'S-13：驾驶舱共用同一完成度投影');
    checks += 5;

    /* ------------------------------------------- Q-16 默认 Cpk 目标 */
    const meta = await ok(api('GET', '/meta'), '读取元数据');
    assert.equal(meta.defaults.cpk_target, 1.33, 'Q-16：Cpk 默认目标由服务端下发');
    assert.match(app, /state\.meta\?\.defaults\?\.cpk_target/, 'Q-16：前端使用服务端默认值');
    checks += 2;

    /* ------------------------------------------------ A-19 变更原因 */
    await ok(api('PUT', '/docs/P3-02', {
      body: {
        data: { proj: 'P3-2 验收', part_no: 'P325', pack: [['外箱', '纸箱', '20', '批次', '防潮']] },
        cols: {}, status: '草稿', version: 'V1.0',
      },
    }), '保存 P3-02');
    await ok(api('POST', '/docs/P3-02/submit', { body: {} }), '提交 P3-02');
    await ok(api('POST', '/docs/P3-02/approve', { as: 'quality', body: {} }), '批准 P3-02');
    await ok(api('POST', '/docs/P3-02/revise', { body: { reason: '包装数量待调整' } }), '发起修订');
    await ok(api('PUT', '/docs/P3-02', {
      body: {
        data: { proj: 'P3-2 验收', part_no: 'P325', pack: [['外箱', '纸箱', '30', '批次', '防潮']] },
        cols: {}, status: '草稿', version: 'V1.1',
      },
    }), '批准后修改 P3-02');
    const revisions = await ok(api('GET', '/docs/P3-02/revisions'), '读取版本历史');
    const autoSave = revisions.list.find(item => item.status === '草稿');
    assert.ok(autoSave, 'A-19：修改应生成版本快照');
    assert.equal(autoSave.change_note, '自动保存快照', 'A-19：未填原因时标记为自动保存快照');
    assert.ok(!Object.hasOwn(autoSave, 'data_json'), 'A-08：历史列表不返回整份数据');
    assert.ok(autoSave.data_size > 0, 'A-08：历史列表返回数据大小');
    const blockedSubmit = await api('POST', '/docs/P3-02/submit', { body: {} });
    assert.equal(blockedSubmit.status, 400, 'A-19：自动快照不能直接提交为变更版本');
    await ok(api('PUT', '/docs/P3-02', {
      body: {
        data: { proj: 'P3-2 验收', part_no: 'P325', pack: [['外箱', '纸箱', '40', '批次', '防潮']] },
        cols: {}, status: '草稿', version: 'V1.1', change_note: '包装数量由 30 调整为 40',
      },
    }), '补充变更原因');
    await ok(api('POST', '/docs/P3-02/submit', { body: {} }), 'A-19：真实原因可提交');
    const pending = await ok(api('GET', '/docs/P3-02'), '读取待审核 P3-02');
    const approvedRev = revisions.list.find(item => item.status === '已批准');
    assert.ok(approvedRev, 'A-08：批准版本在历史列表中');
    checks += 7;

    /* ------------------------------------- A-08 历史快照查看与恢复 */
    const snapshot = await ok(api('GET', `/docs/P3-02/revisions/${encodeURIComponent(approvedRev.rev_id)}`),
      '读取历史快照');
    assert.equal(snapshot.data.pack[0][2], '20', 'A-08：快照内容为批准时的版本');
    const restored = await ok(api('POST', `/docs/P3-02/restore/${encodeURIComponent(approvedRev.rev_id)}`, {
      body: {},
    }), '恢复历史版本');
    assert.equal(restored.status, '草稿', 'A-08：恢复后为草稿');
    const restoredDoc = await ok(api('GET', '/docs/P3-02'), '读取恢复后的 P3-02');
    assert.equal(restoredDoc.sections.flatMap(section => section.fields)
      .find(field => field.k === 'pack').value[0][2], '20', 'A-08：恢复内容正确');
    const afterRestore = await ok(api('GET', '/docs/P3-02/revisions'), '恢复后历史');
    assert.ok(afterRestore.list.some(item => item.status === '恢复前'), 'A-08：恢复前内容保留为快照');
    checks += 4;

    /* --------------------------------------- A-08 退回写版本 */
    await ok(api('POST', '/docs/P3-02/submit', { body: {} }), '再次提交');
    await ok(api('POST', '/docs/P3-02/reject', {
      as: 'quality', body: { reason: '包装尺寸描述不完整' },
    }), '退回 P3-02');
    const rejectedList = await ok(api('GET', '/docs/P3-02/revisions'), '退回后历史');
    assert.ok(rejectedList.list.some(item => item.status === '已退回'
      && /包装尺寸描述不完整/.test(item.change_note)), 'A-08：退回写入版本与原因');
    checks += 1;

    /* ------------------------------------ A-05 模板绑定与审批同步 */
    const custom = await ok(api('POST', '/docs/new', {
      body: { name: 'P325 自定义检查表', phase: 2, isChecklist: false },
    }), '新建自定义交付物');
    const tplId = custom.tpl_id;
    const tplDetail = await ok(api('GET', `/templates/${encodeURIComponent(tplId)}`), '读取模板');
    const duplicateWorkbook = require('../lib/export').buildGridWorkbook([
      { name: 'Sheet1', cells: { A1: '编号', B1: '名称' } },
    ], { title: '重复绑定' });
    const duplicateTpl = await api('POST', '/templates', {
      body: {
        name: '重复绑定', phase: 2, filename: 'dup.xlsx', doc_code: custom.doc_code,
        dataBase64: duplicateWorkbook.toString('base64'),
      },
    });
    assert.equal(duplicateTpl.status, 409, 'A-05：同一编号不能绑定多个模板');
    await ok(api('PUT', `/templates/${encodeURIComponent(tplId)}`, {
      body: { schema: tplDetail.schema },
    }), '保存模板');
    await ok(api('POST', `/templates/${encodeURIComponent(tplId)}/submit`, { body: {} }), '模板提交审核');
    assert.equal((await ok(api('GET', '/docs'), '读取交付物列表')).phases
      .flatMap(phase => phase.docs).find(doc => doc.code === custom.doc_code).status, '待审核',
    'A-05：模板提交后绑定交付物同步待审核');
    await ok(api('POST', `/templates/${encodeURIComponent(tplId)}/approve`, { as: 'quality', body: {} }),
      '模板批准');
    const approvedDoc = (await ok(api('GET', '/docs'), '批准后交付物列表')).phases
      .flatMap(phase => phase.docs).find(doc => doc.code === custom.doc_code);
    assert.equal(approvedDoc.status, '已批准', 'A-05：模板批准后交付物同步已批准');
    const byCode = await ok(api('GET', `/templates/by-code/${encodeURIComponent(custom.doc_code)}`), '按编号定位模板');
    assert.equal(byCode.tpl_id, tplId, 'A-18：按交付物编号可定位绑定模板');
    checks += 6;

    /* ---------------------------------------- A-20 批量提交 / 导出 */
    const plans = await ok(api('GET', '/cp'), '读取控制计划');
    const batchExport = await ok(api('POST', '/docs/batch/export', {
      body: { codes: ['P3-02', custom.doc_code], fmt: 'docx' },
    }), 'A-20：批量导出');
    assert.ok(batchExport.files >= 1, 'A-20：批量导出至少一个文件');
    assert.ok(batchExport.dataBase64 && batchExport.dataBase64.length > 100, 'A-20：返回 ZIP base64');
    checks += 2;

    /* ------------------------------------------- F-07 / F-11 FMEA */
    const node = await ok(api('POST', '/fmea/node', { body: { fmea_type: 'PFMEA', name: 'P325 工序节点' } }),
      '创建 FMEA 节点');
    const func = await ok(api('POST', '/fmea/functions', {
      body: { node_id: node.node_id, text: '加工电阻器至 10 mm' },
    }), '创建功能');
    const row = await ok(api('POST', '/fmea/row', {
      body: {
        fmea_type: 'PFMEA', focus_node_id: node.node_id, func_id: func.func_id,
        fe_text: '尺寸异常', fm_text: '尺寸偏大', fc_text: '刀具磨损', s: 7, o: 5, d: 5,
      },
    }), 'F-07：无 PC/DC 保存草稿行');
    const savedRow = (await ok(api('GET', '/fmea?type=PFMEA'), '读取 FMEA')).rows
      .find(item => item.row_id === row.row_id);
    assert.equal(savedRow.s_user, 7, 'F-11：只传 S 时回填最终用户场景');
    const publishBlocked = await api('POST', '/fmea/publish', { as: 'quality', body: { fmea_type: 'PFMEA' } });
    assert.equal(publishBlocked.status, 409, 'F-07：缺 PC/DC 不能发布');
    assert.match(String(publishBlocked.json?.error || ''), /预防|探测/);
    await ok(api('POST', '/fmea/row', {
      body: {
        row_id: row.row_id, fmea_type: 'PFMEA', focus_node_id: node.node_id,
        func_id: func.func_id, fe_text: '尺寸异常', fm_text: '尺寸偏大', fc_text: '刀具磨损',
        s: 7, o: 5, d: 5, pc_text: '刀具寿命管理', dc_text: '卡尺测量',
      },
    }), '补齐 PC/DC');
    const published = await ok(api('POST', '/fmea/publish', { as: 'quality', body: { fmea_type: 'PFMEA' } }),
      'F-07：补齐后可发布');
    assert.ok(published.rev, 'F-07：发布成功返回版本');
    checks += 6;

    /* ------------------------------------------- F-10 节点影响预览 */
    const impact = await ok(api('GET', `/fmea/node/${encodeURIComponent(node.node_id)}/impact`), 'F-10：节点影响预览');
    assert.ok(impact.nodes >= 1, 'F-10：影响预览节点数');
    assert.ok(impact.child_nodes >= 3, 'F-10：失效影响/模式/原因子节点也应列入');
    assert.equal(impact.rows, 1, 'F-10：影响预览行数');
    assert.ok(Array.isArray(impact.row_ids), 'F-10：返回受影响行清单');
    checks += 3;

    /* ------------------------------------------- C-07 CP 行编辑 */
    const step = await ok(api('POST', '/steps', {
      body: { name: 'P325 工序', mode: 'PROCESS', step_type: '制造', equipment: '炉', input_desc: '基体', output_desc: '成品' },
    }), '创建工序');
    const char = await ok(api('POST', '/chars', {
      body: { name: 'P325 尺寸', char_kind: 'PRODUCT', family_id: 'FM', target: 10, lsl: 9, usl: 11, unit: 'mm' },
    }), '创建特性');
    const imported = await ok(api('POST', '/project-chars/from-dictionary', { body: { char_id: char.char_id } }),
      '引入特性');
    const pilotId = (plans.plans.find(plan => plan.stage === 'PILOT') || {}).cp_id;
    const cpRow = await ok(api('POST', '/cp/row', {
      body: {
        cp_id: pilotId, step_id: step.step_id, project_char_id: imported.item.pchar_id,
        sample_size: 5, freq_value: 2, freq_unit: 'h', measure_tech: '卡尺',
      },
    }), '创建 CP 行');
    await ok(api('PATCH', `/cp/${pilotId}`, { body: { status: '待审核' } }), 'CP 提交');
    await ok(api('PATCH', `/cp/${pilotId}`, { as: 'quality', body: { status: '已批准' } }), 'CP 批准');
    const textEdit = await ok(api('PATCH', `/cp/row/${cpRow.cp_row_id}`, {
      body: { control_method: '首件 + 巡检 + 记录追溯' },
    }), 'C-07：文字编辑');
    assert.equal(textEdit.downgraded, false, 'C-07：文字编辑不降级');
    const cpAfterText = await ok(api('GET', '/cp?stage=PILOT'), '读取 CP');
    assert.equal(cpAfterText.plans.find(plan => plan.cp_id === pilotId).status, '已批准',
      'C-07：文字编辑保留批准状态');
    const samplingEdit = await ok(api('PATCH', `/cp/row/${cpRow.cp_row_id}`, {
      body: { sample_size: 8 },
    }), 'C-07：抽样编辑');
    assert.equal(samplingEdit.downgraded, true, 'C-07：抽样变更触发降级');
    const cpAfterSampling = await ok(api('GET', '/cp?stage=PILOT'), '再次读取 CP');
    assert.equal(cpAfterSampling.plans.find(plan => plan.cp_id === pilotId).status, '草稿',
      'C-07：抽样变更后 CP 降草稿');
    // C-01：人工覆盖必须显式标记并可撤销，普通编辑不写标记
    const markOverride = await ok(api('PATCH', `/cp/row/${cpRow.cp_row_id}`, {
      body: { action: 'override', override_reason: '试产验证取值与自动映射不同' },
    }), 'C-01：标记人工覆盖');
    assert.equal(markOverride.ok, true);
    const cpOverridden = await ok(api('GET', '/cp?stage=PILOT'), '读取覆盖后的 CP');
    const overriddenRow = cpOverridden.rows.find(row => row.cp_row_id === cpRow.cp_row_id);
    assert.equal(overriddenRow.override_flag, 1, 'C-01：显式动作写入覆盖标记');
    assert.match(String(overriddenRow.override_reason || ''), /试产验证/, 'C-01：覆盖原因已记录');
    const clearOverride = await ok(api('PATCH', `/cp/row/${cpRow.cp_row_id}`, {
      body: { action: 'clear-override' },
    }), 'C-01：撤销人工覆盖');
    assert.equal(clearOverride.cleared, true, 'C-01：撤销动作返回结果');
    const cpCleared = await ok(api('GET', '/cp?stage=PILOT'), '读取撤销覆盖后的 CP');
    const clearedRow = cpCleared.rows.find(row => row.cp_row_id === cpRow.cp_row_id);
    assert.equal(clearedRow.override_flag, 0, 'C-01：撤销后覆盖标记清零');
    assert.equal(String(clearedRow.override_reason || ''), '', 'C-01：撤销后覆盖原因清空');
    checks += 7;

    /* ------------------------------------------- C-10 安全投产退出 */
    await ok(api('PATCH', `/cp/${pilotId}`, { body: { effective_date: '2026-06-01' } }), '设置生效日期');
    const badExit = await api('PATCH', `/cp/${pilotId}`, {
      body: {
        safe_launch_applicability: '要求', safe_launch_status: '已退出',
        safe_launch_exited_by: '质量工程师', safe_launch_exited_at: '2026-01-01',
        safe_launch_exit_reason: '按计划退出',
      },
    });
    assert.equal(badExit.status, 400, 'C-10：退出日期早于生效日期应拒绝');
    const noReason = await api('PATCH', `/cp/${pilotId}`, {
      body: {
        safe_launch_applicability: '要求', safe_launch_status: '已退出',
        safe_launch_exited_by: '质量工程师', safe_launch_exited_at: '2026-07-01',
      },
    });
    assert.equal(noReason.status, 400, 'C-10：缺少退出原因应拒绝');
    checks += 2;

    /* ------------------------------------------- D-09 字典区间 */
    const dicts = await ok(api('GET', '/process-dict'), '读取工序字典');
    const duplicateCode = dicts.list.find((item, index, list) =>
      list.some((other, otherIndex) => otherIndex !== index && other.code === item.code));
    assert.ok(duplicateCode, 'D-09：前置条件：存在同编号历史字典记录');
    const other = dicts.list.find(item => item.dict_id !== duplicateCode.dict_id && item.code === duplicateCode.code);
    const overlap = await api('PATCH', `/process-dict/${encodeURIComponent(duplicateCode.dict_id)}`, {
      body: { effective_from: '2026-01-01', effective_to: null },
    });
    assert.equal(overlap.status, 409, 'D-09：同编号生效区间重叠应拒绝');
    checks += 2;

    /* ------------------------------------------- Q-11 Excel 导入 */
    const gauge = await ok(api('POST', '/gauges', {
      body: { code: 'P325-G', name: 'P325 检具', calibration_due: '2099-12-31', resolution: 0.001 },
    }), '创建检具');
    const monitor = await ok(api('POST', `/cp/${cpRow.cp_row_id}/monitor`, {
      body: { chart_type: 'I-MR', gauge_id: gauge.gauge_id },
    }), '创建监控项');
    await ok(api('PATCH', `/monitoring/${monitor.mon_id}/review`, { as: 'quality', body: { action: 'approve' } }),
      '审核监控项');
    const XLSX = require('../lib/export');
    const cells = {};
    for (let row = 1; row <= 8; row += 1) cells[`A${row}`] = row === 4 ? '坏行' : String(10 + row * 0.01);
    const workbook = XLSX.buildGridWorkbook([{ name: '数据', cells }], { title: 'P325' });
    const importedData = await ok(api('POST', `/spc/${monitor.mon_id}/import`, {
      body: { dataBase64: workbook.toString('base64'), batch_no: 'P325-BATCH-1' },
    }), 'Q-11：Excel 导入');
    assert.equal(importedData.accepted, 7, 'Q-11：有效行照常导入');
    assert.equal(importedData.skipped.length, 1, 'Q-11：无效行返回跳过清单');
    assert.equal(importedData.skipped[0].row, 4, 'Q-11：跳过行号准确');
    const duplicateBatch = await api('POST', `/spc/${monitor.mon_id}`, {
      body: {
        batch_no: 'P325-BATCH-1',
        subgroups: Array.from({ length: 5 }, (_, index) => ({ t: `B${index}`, v: [10 + index] })),
      },
    });
    assert.equal(duplicateBatch.status, 409, 'Q-11：重复批次号应拒绝');
    checks += 4;

    /* ------------------------------------------- P-04 工序版本 */
    const stepPublish = await ok(api('PATCH', `/steps/${step.step_id}`, {
      body: { status: '已发布' },
    }), 'P-04：发布工序');
    assert.ok(stepPublish.revision, 'P-04：发布生成版本快照');
    await ok(api('PATCH', `/steps/${step.step_id}`, { body: { status: '草稿' } }), 'P-04：撤回发布');
    const stepRevs = await ok(api('GET', `/steps/${step.step_id}/revisions`), 'P-04：工序历史');
    assert.ok(stepRevs.list.length >= 2, 'P-04：发布与撤回各留一个快照');
    const publishRev = stepRevs.list.find(item => /发布/.test(item.note) && !/撤回/.test(item.note));
    assert.ok(publishRev, 'P-04：发布版本可查');
    await ok(api('POST', `/steps/${step.step_id}/restore/${encodeURIComponent(publishRev.rev_id)}`, { body: {} }),
      'P-04：恢复工序版本');
    const restoredStep = (await ok(api('GET', '/steps?mode=PROCESS'), '读取工序')).find(item => item.step_id === step.step_id);
    assert.equal(restoredStep.status, '草稿', 'P-04：恢复后为草稿');
    checks += 6;

    /* ------------------------------------------- B-09 / B-13 PPAP */
    const pendingEvidence = await ok(api('PATCH', '/ppap/18', {
      body: { status: '待确认', evidence: 'P325-PSW-001' },
    }), 'B-09：证据保存待确认');
    assert.equal(pendingEvidence.status, '待确认', 'B-09：证据先进入待确认');
    const selfConfirm = await api('PATCH', '/ppap/18', {
      as: 'quality', body: { status: '已完成', evidence: 'P325-PSW-001' },
    });
    assert.equal(selfConfirm.status, 200, 'B-09：质量角色确认完成');
    const noWaiver = await api('PATCH', '/ppap/17', { body: { applicability: '不适用' } });
    assert.equal(noWaiver.status, 400, 'B-13：不适用必须填写书面依据');
    const waiver = await ok(api('PATCH', '/ppap/17', {
      body: { applicability: '不适用', waiver_ref: '顾客邮件 2026-10-01 豁免 CSR 清单' },
    }), 'B-13：保存不适用依据');
    assert.equal(waiver.ok, true);
    const ppap = await ok(api('GET', '/ppap'), '读取 PPAP');
    const element17 = ppap.elements.find(item => item.element_no === 17);
    assert.equal(element17.applicability, '不适用', 'B-13：适用性已保存');
    assert.match(String(element17.waiver_ref || ''), /豁免/, 'B-13：豁免依据已保存');
    checks += 4;

    /* ------------------------------------------- S-15 / A-20 重算 */
    const resync = await ok(api('POST', '/admin/resync', { body: { note: 'P3-2 验收重算' } }), 'S-15：显式重算');
    assert.ok(resync.summary && typeof resync.summary.created === 'number', 'S-15：重算返回汇总');
    checks += 1;

    /* ------------------------------------------- D-07 覆盖率下钻 / D-10 来源校验 */
    const sources = await ok(api('GET', '/character-sources'), 'D-10：读取来源词表');
    assert.ok(Array.isArray(sources.source_types) && sources.source_types.includes('客户图纸'),
      'D-10：服务端下发受控来源类型');
    const badRef = await api('PATCH', `/chars/${char.char_id}`, { body: { source_ref: '---' } });
    assert.equal(badRef.status, 400, 'D-10：纯符号来源编号应拒绝');
    const longRef = await api('PATCH', `/chars/${char.char_id}`, {
      body: { source_ref: 'X'.repeat(121) },
    });
    assert.equal(longRef.status, 400, 'D-10：超长来源编号应拒绝');
    const aliasSave = await ok(api('PATCH', `/chars/${char.char_id}`, {
      body: { source_type: '图纸', source_ref: ' DR-2026-999 ' },
    }), 'D-10：别名归一');
    assert.equal(aliasSave.source_warning, '', 'D-10：别名归一到受控类型');
    const charAfterAlias = (await ok(api('GET', '/chars'), 'D-10：读取特性'))
      .find(item => item.char_id === char.char_id);
    assert.equal(charAfterAlias.source_type, '客户图纸', 'D-10：图纸归一为客户图纸');
    assert.equal(charAfterAlias.source_ref, 'DR-2026-999', 'D-10：来源编号去除首尾空白');
    const unknown = await ok(api('PATCH', `/chars/${char.char_id}`, {
      body: { source_type: '自定义来源' },
    }), 'D-10：未知类型兼容保存');
    assert.match(unknown.source_warning || '', /受控词表/, 'D-10：未知类型给出提示');

    const coverageDetail = await ok(api('GET', `/chars/${char.char_id}`), 'D-07：特性覆盖下钻');
    assert.ok(coverageDetail.cpRows.some(row => row.cp_row_id === cpRow.cp_row_id),
      'D-07：下钻返回该特性的 CP 行');
    assert.ok(coverageDetail.cpRows.every(row => 'cp_status' in row), 'D-07：CP 行带批准状态');
    assert.ok(coverageDetail.mons.some(item => item.mon_id === monitor.mon_id),
      'D-07：下钻返回 SPC 监控项');
    assert.ok(Array.isArray(coverageDetail.msaPlans), 'D-07：下钻返回 MSA 计划');
    checks += 10;

    /* ------------------------------------------- 静态断言 */
    assert.match(app, /批量提交草稿/, 'A-20：页面提供批量提交');
    assert.match(app, /批量导出 ZIP/, 'A-20：页面提供批量导出');
    assert.match(app, /data-step-rev/, 'P-04：页面提供工序历史入口');
    assert.match(app, /data-baseline-prev/, 'B-06：基线列表提供与上一版对比');
    assert.match(app, /计划中待建台账/, 'M-11：伪检具单独分组');
    assert.match(app, /msaPlanView/, 'M-10：MSA 计划使用统一状态视图');
    assert.match(app, /charSourceTypes/, 'D-10：特性来源使用受控词表');
    assert.match(app, /data-coverage-char/, 'D-07：覆盖率行可下钻');
    assert.match(app, /特性覆盖缺口/, 'D-07：下钻展示缺口明细');
    // 浏览器逐屏走查发现的问题：宽表兜底滚动、顶部阶段胶囊换行、登录页过期口令提示
    assert.match(app, /function wrapScrollableTables/, 'S-17：宽表统一包横向滚动容器');
    assert.match(styleSource, /\.t-scroll\{overflow-x:auto/, 'S-17：滚动容器样式存在');
    assert.match(styleSource, /\.pill\{[^}]*white-space:nowrap/, 'S-17：阶段胶囊不逐字换行');
    assert.match(styleSource, /grid-template-columns:minmax\(0,1fr\)/, 'S-17：窄屏网格允许收缩');
    assert.ok(!/本地演示账号：admin \/ admin123/.test(app), 'S-04：登录页不再提示已停用的默认口令');
    assert.match(app, /data-override-row/, 'C-01：CP 行提供人工覆盖标记/撤销入口');
    assert.match(serverSource, /clear-override/, 'C-01：服务端支持撤销人工覆盖');
    assert.match(serverSource, /const AUTO_SAVE_NOTE = '自动保存快照'/, 'A-19：自动快照有独立标记');
    assert.match(README, /68 个第三版目录项/, 'S-20：README 与 CATALOG 计数一致');
    assert.equal((app.match(/async function api\(/g) || []).length, 1, 'S-19：前端只保留一份 api()');
    checks += 18;

    console.log(`P3-2～P3-5 remaining tests passed (${checks} checks)`);
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('P3-2～P3-5 验收失败：');
  console.error(error);
  process.exitCode = 1;
});
