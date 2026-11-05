'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-deliverable-api-'));
const DATABASE = path.join(TEMP, 'integration.db');
const PORT = 22000 + crypto.randomInt(1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const A = 'LINK-API-PROJECT-A';
const B = 'LINK-API-PROJECT-B';
let cookie = '';
let qualityCookie = '';
let serverOutput = '';
let reader;
let checks = 0;

async function request(url, options = {}) {
  const { expectedError, as, ...fetchOptions } = options;
  const response = await fetch(BASE + url, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      Cookie: as || cookie,
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const nextCookie = response.headers.get('set-cookie');
  if (nextCookie && !as) cookie = nextCookie.split(';')[0];
  const result = await response.json();
  if (expectedError) {
    assert.ok(response.status >= 400 && response.status < 500,
      `${url} should reject with a client error; got ${response.status}: ${JSON.stringify(result)}`);
    if (expectedError instanceof RegExp) assert.match(result.error || '', expectedError);
    checks += 1;
    return result;
  }
  assert.equal(response.status, 200, `${url}: ${result.error || JSON.stringify(result)}`);
  return result;
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error('Integration server exited before listening');
    try {
      const response = await fetch(`${BASE}/meta`);
      if (response.status === 401 || response.ok) return;
    } catch (error) { /* The child has not bound its port yet. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Integration server did not start');
}

function databaseSnapshot() {
  const result = {};
  const tables = reader.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  for (const { name } of tables) {
    const escaped = name.replace(/"/g, '""');
    const rows = reader.prepare(`SELECT * FROM "${escaped}" ORDER BY rowid`).all();
    result[name] = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return result;
}

async function assertReadOnly(label, project = A) {
  const before = databaseSnapshot();
  const version = reader.prepare('PRAGMA data_version').get().data_version;
  for (const route of [
    '/meta', '/docs', '/docs/P1-10', '/docs/P3-08', '/project-chars',
    '/steps', '/cp?stage=PILOT', '/msa', '/ppap', '/ppap/evidence/8',
    '/deliverable-links?doc=P3-08', '/closed-loop?type=PFMEA&stage=PILOT',
    '/program-metrics', '/gates', '/related-preview?code=P3-08',
  ]) {
    await request(route + (route.includes('?') ? '&' : '?') + 'p=' + project);
  }
  const after = databaseSnapshot();
  const changed = Object.keys(before).filter(table => before[table] !== after[table]);
  assert.deepEqual(changed, [], `${label}: GET changed tables: ${changed.join(', ')}`);
  assert.equal(reader.prepare('PRAGMA data_version').get().data_version, version,
    `${label}: GET committed database writes even though final values may be equal`);
  checks += 2;
}

function documentColumns(doc) {
  return Object.fromEntries(doc.sections.flatMap(section => section.fields)
    .filter(field => field.type === 'table').map(field => [field.k, field.cols]));
}

async function saveDocument(code, project, update) {
  const doc = await request(`/docs/${code}?p=${project}`);
  const data = JSON.parse(JSON.stringify(doc.data || {}));
  update(data);
  return request(`/docs/${code}?p=${project}`, {
    method: 'PUT', body: {
      data, cols: documentColumns(doc), status: '草稿', version: doc.version,
      user: 'API Tester', change_note: `模拟项目：维护 ${code} 内容`,
    },
  });
}

async function approveDocument(code, project) {
  await request(`/docs/${code}/submit?p=${project}`, { method: 'POST', body: { user: 'API Tester' } });
  const result = await request(`/docs/${code}/approve?p=${project}`, {
    method: 'POST', body: {}, as: qualityCookie,
  });
  assert.equal(result.status, '已批准');
  assert.ok(result.sync && typeof result.sync === 'object', 'Approval must return a sync summary');
  checks += 2;
  return result;
}

function studyData(plan) {
  return Array.from({ length: plan.operators * plan.trials }, (_, row) =>
    Array.from({ length: plan.parts }, (_, part) =>
      10 + part * 0.5 + (row % plan.trials) * 0.0001 + Math.floor(row / plan.trials) * 0.0001));
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), QMS_DB_PATH: DATABASE,
      QMS_ADMIN_PASSWORD: 'integration-admin-password',
      QMS_QUALITY_PASSWORD: 'integration-quality-password', NODE_NO_WARNINGS: '1' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  try {
    await waitForServer(server);
    await request('/auth/login', { method: 'POST',
      body: { username: 'admin', password: 'integration-admin-password' } });
    // 审批链要求“提交人 ≠ 批准人”且批准需质量角色：单独登录 quality 账号执行批准
    const qualityLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'quality', password: 'integration-quality-password' }),
    });
    assert.equal(qualityLogin.status, 200, '质量账号应能登录');
    qualityCookie = qualityLogin.headers.get('set-cookie').split(';')[0];
    for (const project of [A, B]) {
      await request('/projects', { method: 'POST', body: {
        project_id: project, name: project, family_id: 'FM', series_id: 'SR-RJ',
        owner: 'API Tester', part_no: project,
      } });
    }
    await saveDocument('P0-01', A, data => {
      data.members = [
        ['设计', '设计负责人', '设计代表', '设计决策', '顾客工程团队', '有效'],
        ['工艺', '工艺负责人', '过程代表', '过程/产能', '供应商工艺团队', '有效'],
      ];
      data.process_owner = '质量项目经理';
      data.project_manager = '项目经理';
      data.training = 'APQP/FMEA/MSA/SPC 核心工具培训已排期';
      data.communication = '每周项目会；供应商双周会；顾客 Gate 评审';
    });
    await approveDocument('P0-01', A);
    await saveDocument('P0-02', A, data => {
      data.customers = '内部设计/工艺/质量；外部车规客户';
      data.scope = [
        ['纳入', 'RJ-0.25W-10K 产品及成膜、调阻、包封过程', 'RJ-0.25W-10K', 'CSR-RJ-001', '已澄清', '项目经理'],
        ['要求', '安全、可靠性、交付和量产能力要求', '项目全范围', '客户协议 Rev C', '已澄清', '质量负责人'],
      ];
      data.feasibility = '初始设计与预计制造过程可行，待 Gate 2 完成正式确认';
      data.constraints = '量产日期、设备共享和供应商产能为主要约束';
      data.customer_support = '需顾客确认特殊特性分类和安全投产退出准则';
      data.document_control = '所有 APQP 输出按项目版本、批准人和变更原因留痕';
    });
    await approveDocument('P0-02', A);
    await saveDocument('P0-05', A, data => {
      data.suppliers = [[
        '薄膜材料供应商', '镍铬靶材', '一级', '新供应商、无历史量产记录',
        '设计/质量/产能评估进行中', '补充过程审核与 Run@Rate', '采购负责人',
        '2026-12-15', '进行中', '已传递 APQP 要求，等待确认',
      ]];
    });
    await approveDocument('P0-05', A);
    await saveDocument('P1-I-01', A, data => {
      data.voice = [[
        'VOC-001', '顾客访谈/CSR', '阻值精度、耐压安全、湿热可靠性',
        'PPM/可靠性目标及客户协议', '顾客使用环境下长期稳定',
        'RJ-0.25W-10K', 'CSR-RJ-001 Rev C', '质量负责人',
      ]];
      data.communication = '已向设计、工艺、采购和供应商团队传达并记录澄清事项';
    });
    await approveDocument('P1-I-01', A);
    await saveDocument('P1-I-06', A, data => {
      data.requirements = [[
        'CSR-RJ-001-07', 'CSR', '7.2', '阻值精度和安全耐压',
        '满足客户图纸与 AEC-Q200', 'CHR-D-0142/CHR-D-0163',
        'CSR-RJ-001 Rev C', '已适用', '质量负责人',
      ]];
      data.customer_approval = '顾客确认特殊特性分类和安全要求，待正式 Gate 2 签署';
    });
    await approveDocument('P1-I-06', A);
    checks += 10;
    const legacyGateWriter = new DatabaseSync(DATABASE);
    legacyGateWriter.prepare(`INSERT INTO gate_review(
      project_id,phase,decision,reviewer,comment,reviewed_at,checks_json
    ) VALUES(? ,0,'通过','Legacy Reviewer','old criteria',datetime('now'),'[1,1,1]')`).run(B);
    legacyGateWriter.close();
    const legacyGate = (await request(`/gates?p=${B}`)).gates;
    assert.equal(legacyGate[0].needsRevalidation, true,
      'Gate approval recorded against old criteria must be preserved but require re-review');
    assert.equal(legacyGate[0].decision, '待复核');
    assert.equal(legacyGate[1].canReview, false, 'a stale prior gate cannot unlock later gates');
    const initialMetrics = await request(`/program-metrics?p=${A}`);
    assert.ok(initialMetrics.items.some(item => item.code === 'P1-16' && item.name === 'APQP 项目指标'));
    assert.ok(initialMetrics.summary.red > 0 && initialMetrics.summary.total >= 60);
    await saveDocument('P1-16', A, data => {
      data.goals = [['质量', '0 PPM', '一次交验良率', '质量负责人']];
      data.custom_metrics = [['低温焊接稳定性', '试验报告通过', '设计负责人', '2026-12-01', '项目特色指标']];
    });
    await approveDocument('P1-16', A);
    const metricsDoc = await request(`/docs/P1-16?p=${A}`);
    assert.equal(metricsDoc.data.goals[0][1], '0 PPM', '旧项目目标表仍被保留');
    assert.equal(metricsDoc.data.custom_metrics[0][0], '低温焊接稳定性');
    assert.ok(metricsDoc.data._programMetricsSnapshot.captured_at
      && metricsDoc.data._programMetricsSnapshot.approved_by);
    assert.equal(metricsDoc.data._programMetricsSnapshot.items.find(item => item.code === 'P1-16').health,
      'green', '批准的 APQP 指标应冻结当时的准备度快照');
    const invalidPending = await request(`/gates/0?p=${A}`, {
      method: 'POST',
      body: { decision: '待评审', checks: [0, 1, 1], actions: [{ action: '待补', owner: '', due: '' }] },
      expectedError: /措施、责任人和有效计划日期/,
    });
    assert.ok(invalidPending.error);
    const actionDue = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10);
    const pendingGate = await request(`/gates/0?p=${A}`, {
      method: 'POST',
      body: {
        decision: '待评审', checks: [0, 1, 1],
        actions: [{ action: '完成供应商风险评估', owner: '采购负责人', due: actionDue }, {}, {}],
        comment: '待完成供应商评估',
      },
    });
    assert.ok(pendingGate.criteria_version);
    await request(`/gates/1?p=${A}`, {
      method: 'POST', body: { decision: '通过', checks: [1, 1, 1, 1] },
      expectedError: /Gate 0 尚未按当前评审要求通过/,
    });
    await request(`/gates/0?p=${A}`, {
      method: 'POST',
      body: { decision: '通过', checks: [1, 1, 1], comment: 'Gate 0 检查项全部满足，同意进入下一阶段' },
    });
    assert.equal((await request(`/gates?p=${A}`)).gates[0].decision, '通过');
    checks += 5;
    const checklist = await request(`/docs/A-01?p=${A}`);
    const checklistField = checklist.sections.flatMap(section => section.fields)
      .find(field => field.k === 'items');
    assert.equal(checklistField.value.length, 4);
    assert.match(checklistField.guide.guidance, /检查|证据/);
    assert.equal(checklistField.col_guides.length, checklistField.cols.length);
    assert.equal(checklistField.col_guides[2].label, '结论（是/否/不适用）');
    assert.match(checklistField.col_guides[2].guidance, /证据|结论|逐行填写/);
    await request(`/docs/A-01?p=${A}`, {
      method: 'PUT',
      body: { data: checklist.data, cols: documentColumns(checklist), status: '草稿',
        user: 'API Tester', change_note: '模拟项目：保存风险检查草稿' },
    });
    await request(`/docs/A-01/submit?p=${A}`, {
      method: 'POST', body: { user: 'API Tester' }, expectedError: /必须选择是、否或不适用/,
    });
    const checklistData = JSON.parse(JSON.stringify(checklist.data));
    checklistData.items = checklistData.items.map((row, index) =>
      index === 0 ? [row[0], row[1], '否', row[3], '完成供应商风险评估', '采购负责人',
        new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10), '', ''] :
        [row[0], row[1], '是', row[3], '', '', '', '', '']);
    await request(`/docs/A-01?p=${A}`, {
      method: 'PUT',
      body: { data: checklistData, cols: documentColumns(checklist), status: '草稿',
        user: 'API Tester', change_note: '模拟项目：补充风险检查结论' },
    });
    await request(`/docs/A-01/submit?p=${A}`, { method: 'POST', body: { user: 'API Tester' } });
    await request(`/docs/A-01/approve?p=${A}`, { method: 'POST', body: {}, as: qualityCookie });
    checks += 4;
    await request(`/docs/P2-05?p=${A}`, { expectedError: /原型阶段控制计划|系统模块|进入对应模块/ });
    reader = new DatabaseSync(DATABASE, { readOnly: true });
    await assertReadOnly('Fresh project');

    const formPreview = await request(`/related-preview?code=P3-08&p=${A}`);
    assert.equal(formPreview.meta.code, 'P3-08');
    const formPreviewTable = formPreview.sections.flatMap(section => section.fields || [])
      .find(field => field.type === 'table');
    assert.ok(formPreviewTable && formPreviewTable.columns.length && Array.isArray(formPreviewTable.rows),
      'Form table previews must use normalized columns and rows');
    const ppapPreview = await request(`/related-preview?code=P4-04&p=${A}`);
    const ppapTable = ppapPreview.sections.flatMap(section => section.fields || [])
      .find(field => field.type === 'table');
    assert.equal(ppapTable.rows.length, 18, 'PPAP related preview must expose all 18 evidence rows');
    checks += 4;

    const qualityRelations = await Promise.all(['P2-01', 'P3-06', 'P3-06b', 'P4-02', 'P4-03', 'P4-04']
      .map(code => request(`/deliverable-links/relations?doc=${code}&p=${A}`)));
    assert.ok(qualityRelations.every(result =>
      result.items.some(item => item.direction === '上游')
      && result.items.some(item => item.direction === '下游')), 'Every quality tool must expose upstream and downstream links');
    const dfmeaRelations = qualityRelations[0].items;
    assert.ok(dfmeaRelations.some(item => item.sourceCode === 'P1-11' && item.targetCode === 'P2-01'));
    assert.ok(dfmeaRelations.some(item => item.sourceCode === 'P2-01' && item.targetCode === 'P3-06'));
    assert.ok(dfmeaRelations.every(item => item.sourceKind && item.targetKind && item.sourceStatus && item.targetStatus));
    checks += 3;

    const draftMappingOptions = await request(
      `/deliverable-links/fields?source=P1-13&target=P2-10&p=${A}`);
    assert.equal(draftMappingOptions.source.approved, false,
      'Field mapping options must remain available before the upstream document is approved');
    assert.ok(draftMappingOptions.sourceTables.length && draftMappingOptions.targetTables.length);
    assert.ok(draftMappingOptions.targetTables[0].columns.every(column =>
      Object.hasOwn(column, 'sample')), 'Target columns should expose a sample for the selector');
    checks += 3;

    await saveDocument('P0-05', A, data => {
      data.proj = A;
    });
    await approveDocument('P0-05', A);
    const docRevised = await request(`/docs/P0-05/revise?p=${A}`, {
      method: 'POST', body: { reason: 'Approved content needs a controlled revision', user: 'API Tester' },
    });
    assert.equal(docRevised.status, '草稿');
    assert.equal((await request(`/docs/P0-05?p=${A}`)).status, '草稿');
    assert.ok(reader.prepare(`SELECT 1 FROM project_doc_revision
      WHERE project_id=? AND doc_code='P0-05' AND status='已批准'`).get(A),
    'Starting a revision must preserve the prior approved revision history');
    await request(`/docs/P0-05/revise?p=${A}`, {
      method: 'POST', body: { reason: 'Cannot revise twice' }, expectedError: /只有已批准/,
    });
    checks += 3;

    await saveDocument('P0-02', A, data => {
      data.scope = [['纳入', '电流检测电阻', '产品系列 A', '', '', '']];
    });
    const previewMapping = await request('/deliverable-links/fields?p=' + A, { method: 'POST', body: {
      sourceCode: 'P0-02', targetCode: 'P1-07', sourceTable: 'scope', targetTable: 'targets',
      fields: [{ sourceIndex: 0, targetLabel: '特性', relevance: '高' }],
    } });
    assert.equal(previewMapping.preview.rows, 1, 'Configuring a mapping should prefill one blank target row');
    assert.equal(previewMapping.config.sourceKey, 0);
    assert.equal(previewMapping.config.targetKey, 0);
    const previewTarget = await request(`/docs/P1-07?p=${A}`);
    const previewTargets = previewTarget.sections.flatMap(section => section.fields)
      .find(field => field.k === 'targets').value;
    assert.equal(previewTargets[0][0], '纳入', 'The matched upstream value must be written into the target row');
    checks += 4;
    await request('/deliverable-links/fields?p=' + A, { method: 'POST', body: {
      sourceCode: 'P0-02', targetCode: 'P1-07', sourceTable: 'scope', targetTable: 'targets',
      fields: [
        { sourceIndex: 0, targetLabel: '特性', relevance: '高' },
        { sourceIndex: 0, targetLabel: '公差', relevance: '高' },
      ],
    }, expectedError: /同一上游字段/ });

    await saveDocument('P1-10', A, data => {
      data.proj = A;
      data.steps = [
        ['010', 'Incoming inspection', '检验', 'Inspection bench', 'Resistance'],
        ['020', 'Trimming', '制造', 'Laser trimmer', 'Depth'],
      ];
      data._syncRows ||= {};
      data._syncRows.steps = ['duplicated-legacy-id', 'duplicated-legacy-id'];
    });
    const normalizedFlow = await request(`/docs/P1-10?p=${A}`);
    assert.equal(new Set(normalizedFlow.data._syncRows.steps).size, 2,
      'Saving historical rows with duplicate stable IDs must assign fresh unique IDs to every duplicate');
    assert.ok(normalizedFlow.data._syncRows.steps.every(id => id !== 'duplicated-legacy-id'));
    assert.equal((await request(`/steps?mode=INITIAL&p=${A}`)).length, 0,
      'Draft initial flow must not create initial-flow steps');
    checks += 3;
    const firstApproval = await approveDocument('P1-10', A);
    assert.equal(firstApproval.pfd_sync.added, 2);
    assert.ok(Number.isInteger(firstApproval.sync.review_required));
    assert.ok(Number.isInteger(firstApproval.sync.source_missing));
    let steps = await request(`/steps?mode=INITIAL&p=${A}`);
    const firstStep = steps.find(step => step.step_no === '010');
    const secondStep = steps.find(step => step.step_no === '020');
    assert.ok(firstStep && secondStep);
    assert.equal(firstStep.name, 'Incoming inspection');
    const processStepA = await request(`/steps?p=${A}`, {
      method: 'POST',
      body: { mode: 'PROCESS', step_no: '110', name: 'Process inspection', step_type: '检验' },
    });
    const processStepB = await request(`/steps?p=${A}`, {
      method: 'POST',
      body: { mode: 'PROCESS', step_no: '120', name: 'Process trimming', step_type: '工序' },
    });
    const flowLinks = (await request(`/deliverable-links?doc=P1-10&p=${A}`)).items;
    const firstFlowLink = flowLinks.find(item => item.ruleId === 'initial-flow' && item.target.id === firstStep.step_id);
    assert.deepEqual(firstFlowLink.display.fields.map(field => field.label),
      ['工序号', '工序名称', '工序类型', '设备 / 检具', '输出 / 关键特性']);
    assert.equal(firstFlowLink.display.fields.find(field => field.label === '工序号').incomingValue, '010');
    assert.doesNotMatch(JSON.stringify(firstFlowLink.display), /step_id|process_step|PS-DS-/);
    checks += 3;
    await saveDocument('P2-02', A, data => {
      data.items = [
        ['010', '检查来料作业的可行性', '', '设计负责人'],
        ['020', '评估激光调阻的可制造性', '', '工艺负责人'],
      ];
    });
    await request('/deliverable-links/fields?p=' + A, { method: 'POST', body: {
      sourceCode: 'P1-10', targetCode: 'P2-02', sourceTable: 'steps', targetTable: 'items',
      sourceKey: 0, targetKey: 0,
      fields: [{ sourceIndex: 4, targetLabel: '初始流程图关键特性', relevance: '高' }],
    } });
    const mappedOptions = await request(
      `/deliverable-links/fields?source=P1-10&target=P2-02&p=${A}`);
    assert.equal(mappedOptions.mapping.fields[0].relevance, '高');
    assert.equal(mappedOptions.sourceTables[0].columns[4].sample, 'Resistance');
    checks += 2;
    let linkedDfm = await request(`/docs/P2-02?p=${A}`);
    let dfmColumns = documentColumns(linkedDfm).items;
    assert.ok(dfmColumns.includes('初始流程图关键特性'), 'Manual mapping should add a missing target column');
    assert.deepEqual(linkedDfm.data.items.map(row => row[dfmColumns.indexOf('初始流程图关键特性')]),
      ['Resistance', 'Depth'], 'Manual mapping should fill target rows by selected unique keys');
    const firstFlowRowId = normalizedFlow.data._syncRows.steps[0];
    let mappedLink = (await request(`/deliverable-links?doc=P2-02&p=${A}`)).items
      .find(item => item.ruleId.includes('manual-field-map:') && item.source.rowId === firstFlowRowId);
    assert.ok(mappedLink);
    assert.equal(mappedLink.display.fields.find(field => field.label === '初始流程图关键特性').incomingValue, 'Resistance');
    assert.doesNotMatch(JSON.stringify(mappedLink.display), /mapping_id|sourceIndex|targetIndex/);
    checks += 4;
    await saveDocument('P1-10', A, data => {
      data.steps.reverse();
      data._syncRows.steps.reverse();
    });
    await approveDocument('P1-10', A);
    linkedDfm = await request(`/docs/P2-02?p=${A}`);
    dfmColumns = documentColumns(linkedDfm).items;
    assert.deepEqual(linkedDfm.data.items.map(row => row[dfmColumns.indexOf('初始流程图关键特性')]),
      ['Resistance', 'Depth'], 'Reordering the source rows must not break key-based field mapping');
    checks += 1;
    const firstIds = steps.map(step => step.step_id).sort();
    await request(`/deliverable-links/sync?p=${A}`, { method: 'POST', body: {} });
    assert.deepEqual((await request(`/steps?mode=INITIAL&p=${A}`)).map(step => step.step_id).sort(), firstIds,
      'Retrying sync must not duplicate downstream steps');
    checks += 1;

    await saveDocument('P1-10', A, data => {
      data.steps[data._syncRows.steps.indexOf(firstFlowRowId)][1] = 'Unapproved source change';
    });
    assert.equal((await request(`/steps?mode=INITIAL&p=${A}`)).find(step => step.step_id === firstStep.step_id).name,
      'Incoming inspection', 'Upstream draft must not replace the last approved source');
    checks += 1;
    await assertReadOnly('Approved source with a newer draft');
    await approveDocument('P1-10', A);
    assert.equal((await request(`/steps?mode=INITIAL&p=${A}`)).find(step => step.step_id === firstStep.step_id).name,
      'Unapproved source change', 'Newly approved content must update an untouched downstream field');
    checks += 1;

    await request(`/steps/${firstStep.step_id}?p=${A}`, {
      method: 'PATCH', body: { name: 'Locally maintained inspection' },
    });
    await saveDocument('P1-10', A, data => {
      data.steps[data._syncRows.steps.indexOf(firstFlowRowId)][1] = 'New approved inspection';
    });
    await approveDocument('P1-10', A);
    const conflicts = (await request(`/deliverable-links?doc=P1-10&p=${A}`)).items;
    const conflict = conflicts.find(item => item.state === 'conflict' && item.target.id === firstStep.step_id);
    assert.ok(conflict, 'Manual downstream changes must produce a conflict');
    assert.equal((await request(`/steps?mode=INITIAL&p=${A}`)).find(step => step.step_id === firstStep.step_id).name,
      'Locally maintained inspection');
    checks += 2;
    const foreignItems = (await request(`/deliverable-links?doc=P1-10&p=${B}`)).items;
    assert.ok(!foreignItems.some(item => item.id === conflict.id), 'Other projects must not expose source links');
    await request(`/deliverable-links/${conflict.id}/resolve?p=${B}`, {
      method: 'POST', body: { action: 'adopt' }, expectedError: /不存在|当前项目/,
    });
    await request(`/deliverable-links/${conflict.id}/resolve?p=${A}`, {
      method: 'POST', body: { action: 'keep' },
    });
    assert.equal((await request(`/steps?mode=INITIAL&p=${A}`)).find(step => step.step_id === firstStep.step_id).name,
      'Locally maintained inspection');
    checks += 2;

    await saveDocument('P1-11', A, data => {
      data.chars = [['API-SPECIAL-PRODUCT', 'Explicit product pressure', 'CC', 'Customer drawing',
        'Safety assessment', 'PRODUCT', '顾客', 'CSR-API-REQ-12', 'CSR-R3']];
    });
    assert.ok(!(await request(`/project-chars?p=${A}`)).items.some(item => item.char_id === 'API-SPECIAL-PRODUCT'),
      'Unapproved initial characteristics must not appear as project characteristics');
    checks += 1;
    const charDoc = await request(`/docs/P1-11?p=${A}`);
    assert.equal(charDoc.data._syncRows.chars.length, 1, 'Missing legacy row IDs must be assigned during save');
    assert.ok(charDoc.data._syncRows.chars[0]);
    const correctColumns = documentColumns(charDoc);
    await request(`/docs/P1-11?p=${A}`, { method: 'PUT', body: {
      data: charDoc.data, cols: { ...correctColumns, chars: correctColumns.chars.slice(1) },
      status: '草稿', version: charDoc.version,
    }, expectedError: /列|字段/ });
    const renamed = [...correctColumns.chars];
    renamed[1] = 'Changed standard column';
    await request(`/docs/P1-11?p=${A}`, { method: 'PUT', body: {
      data: charDoc.data, cols: { ...correctColumns, chars: renamed }, status: '草稿', version: charDoc.version,
    }, expectedError: /列|字段/ });
    await approveDocument('P1-11', A);
    const initialCharLinks = (await request(`/deliverable-links?doc=P1-11&p=${A}`)).items;
    const initialCharCandidate = initialCharLinks.find(item =>
      item.ruleId === 'initial-special-characteristic' && item.source.rowId);
    assert.ok(initialCharCandidate);
    assert.equal(initialCharCandidate.kind, 'candidate');
    assert.deepEqual(initialCharCandidate.display.fields.map(field => field.label),
      ['编号', '名称', '规格/公差', '分类', '来源', '保证工序', '类型（产品/过程）', '顾客分类', '组织分类/对照', '顾客同意依据']);
    assert.ok(!(await request(`/project-chars?p=${A}`)).items.some(item => item.char_id === 'API-SPECIAL-PRODUCT'),
      'Initial identification must remain a P2-11 candidate until formal approval');
    await request(`/deliverable-links/${initialCharCandidate.id}/resolve?p=${A}`, {
      method: 'POST', body: { action: 'adopt' },
    });
    const formalCharsDoc = await request(`/docs/P2-11?p=${A}`);
    assert.equal(formalCharsDoc.data.chars[0][0], 'API-SPECIAL-PRODUCT');
    assert.equal(formalCharsDoc.data.chars[0][1], 'Explicit product pressure');
    assert.equal(formalCharsDoc.data.chars[0][2], '', 'Initial identification must not invent a tolerance');
    assert.equal(formalCharsDoc.data.chars[0][5], '', 'Initial identification must not invent a guaranteed process');
    await approveDocument('P2-11', A);
    const characteristic = (await request(`/project-chars?p=${A}`)).items
      .find(item => item.char_id === 'API-SPECIAL-PRODUCT');
    assert.equal(characteristic.char_kind, 'PRODUCT',
      'Explicit product type must win over process-like words in the name');
    assert.ok(characteristic.source_ref.includes('CSR-API-REQ-12'),
      'Initial special-characteristic trace should retain the source requirement reference');
    assert.match(characteristic.description, /识别依据：初始识别.*识别主体：顾客.*来源版本：CSR-R3/,
      'Initial special-characteristic trace should retain origin and source revision');
    assert.ok(!(await request(`/project-chars?p=${B}`)).items.some(item => item.char_id === characteristic.char_id));
    checks += 2;

    const regular = await request(`/chars?p=${A}`, { method: 'POST', body: {
      name: 'API regular dimension', char_kind: 'PRODUCT', family_id: 'FM', series_id: 'SR-RJ',
      target: 15, lsl: 5, usl: 25, unit: 'mm', is_special: 0,
    } });
    const imported = await request(`/project-chars/from-dictionary?p=${A}`, {
      method: 'POST', body: { char_id: regular.char_id },
    });
    const projectCharId = imported.item.pchar_id;
    const gaugeIds = [];
    for (let index = 1; index <= 3; index += 1) {
      const gauge = await request(`/gauges?p=${A}`, { method: 'POST', body: {
        code: `API-GAUGE-${index}`, name: `API Gauge ${index}`, resolution: 0.0001,
        calibration_due: '2099-12-31', range_text: '0–30 mm',
      } });
      gaugeIds.push(gauge.gauge_id);
    }
    const pilot = (await request(`/cp?stage=PILOT&p=${A}`)).cp;
    const rowIds = [];
    for (const [index, method] of ['Digital dimensional measurement', 'Alternate digital method', '目视合格/不合格判定'].entries()) {
      const created = await request(`/cp/row?p=${A}`, { method: 'POST', body: {
        cp_id: pilot.cp_id, step_id: index === 1 ? processStepB.step_id : processStepA.step_id,
        project_char_id: projectCharId, gauge_id: index === 1 ? gaugeIds[0] : gaugeIds[index], measure_tech: index === 1
          ? 'Digital dimensional measurement' : method,
        is_spc: false, sample_size: 1, control_method: 'Approved inspection method',
      } });
      rowIds.push(created.cp_row_id);
    }
    assert.equal((await request(`/msa?p=${A}`)).plans.length, 0, 'Draft CP must not create active MSA plans');
    checks += 1;
    // 控制计划状态机：草稿→待审核→已批准（A-02），批准由质量角色执行
    await request(`/cp/${pilot.cp_id}?p=${A}`, { method: 'PATCH', body: { status: '待审核' } });
    await request(`/cp/${pilot.cp_id}?p=${A}`, {
      method: 'PATCH', body: { status: '已批准' }, as: qualityCookie,
    });
    await request(`/cp/${rowIds[0]}/monitor?p=${A}`, {
      method: 'POST', body: { gauge_id: 'MISSING-GAUGE', project_char_id: projectCharId },
      expectedError: /不存在或已报废/,
    });
    assert.equal((await request(`/cp?stage=PILOT&p=${A}`)).cp.status, '已批准',
      'A rejected SPC setup must not draft the approved CP');
    let msa = await request(`/msa?p=${A}`);
    let activePlans = msa.plans.filter(plan => plan.source_active !== 0);
    assert.equal(activePlans.length, 3, 'Non-SPC ordinary measuring systems must all receive separate plans');
    assert.equal(new Set(activePlans.map(plan => plan.gauge_id)).size, 2);
    const numericPlan = activePlans.find(plan => plan.cp_row_id === rowIds[0]);
    assert.equal(numericPlan.study_type, 'GRR');
    assert.equal(numericPlan.tolerance, 20);
    checks += 4;
    await assertReadOnly('Approved CP and active MSA plans');

    const raw = studyData(numericPlan);
    await request(`/msa?p=${A}`, { method: 'POST', body: {
      plan_id: numericPlan.plan_id, data: raw, parts: numericPlan.parts - 1,
    }, expectedError: /计划一致|与计划|研究设计/ });
    await request(`/msa?p=${A}`, { method: 'POST', body: {
      plan_id: numericPlan.plan_id, data: raw, parts: 0,
    }, expectedError: /计划一致|与计划|研究设计/ });
    for (const invalid of ['', null, '   ', false, [], {}]) {
      const invalidData = raw.map(row => [...row]);
      invalidData[0][0] = invalid;
      await request(`/msa?p=${A}`, { method: 'POST', body: {
        plan_id: numericPlan.plan_id, data: invalidData,
      }, expectedError: /有效数值|有效数|不能为空/ });
    }
    await request(`/msa?p=${B}`, { method: 'POST', body: {
      plan_id: numericPlan.plan_id, data: raw,
    }, expectedError: /计划不存在|当前项目/ });
    const previousStudy = await request(`/msa?p=${A}`, { method: 'POST', body: {
      plan_id: numericPlan.plan_id, data: raw,
    } });
    const study = await request(`/msa?p=${A}`, { method: 'POST', body: {
      plan_id: numericPlan.plan_id, data: raw.map(row => row.map(String)),
    } });
    assert.equal(study.plan_id, numericPlan.plan_id, 'Plan-only request must inherit study parameters and equipment');
    assert.equal(study.project_char_id, projectCharId);
    assert.equal(study.tolerance, numericPlan.tolerance);
    assert.equal(study.judgment, '接受');
    assert.equal(study.pctGRR, previousStudy.pctGRR, 'Numeric strings must produce the same result as numeric inputs');
    const studyRecord = reader.prepare('SELECT * FROM msa_study WHERE study_id=?').get(study.study_id);
    const snapshot = JSON.parse(studyRecord.plan_snapshot_json);
    assert.equal(snapshot.plan_id, numericPlan.plan_id);
    assert.equal(snapshot.gauge_id, numericPlan.gauge_id);
    checks += 7;
    await request(`/msa/${previousStudy.study_id}/complete?p=${A}`, {
      method: 'PATCH', body: { completed_by: 'Quality Approver' }, expectedError: /后续研究|当前研究|替代/,
    });
    await request(`/msa/${study.study_id}/complete?p=${A}`, {
      method: 'PATCH', body: { completed_by: 'Quality Approver' },
    });
    const siblingCpRow = (await request(`/cp?stage=PILOT&p=${A}`)).rows
      .find(row => row.cp_row_id === rowIds[1]);
    assert.equal(siblingCpRow.msa_pct, null, 'A completed study from another process step must not qualify this CP row');
    assert.equal(siblingCpRow.msa_warning, true);
    const siblingMatch = await request(`/msa/match?cp_row_id=${encodeURIComponent(rowIds[1])}&gauge_id=${encodeURIComponent(gaugeIds[0])}&p=${A}`);
    assert.equal(siblingMatch.study, null, 'MSA match must not fall back to a sibling process-step study');
    checks += 3;
    await request(`/cp/row/${rowIds[0]}?p=${A}`, {
      method: 'DELETE', expectedError: /MSA.*不能删除|FMEA.*不能删除/,
    });
    assert.ok(reader.prepare('SELECT 1 FROM msa_study WHERE study_id=?').get(study.study_id),
      'A CP row that owns MSA history must not be deleted');
    // C-07：抽样类变更才让控制计划降级并使 MSA 计划待复核（纯文字编辑已不再降级）
    await request(`/cp/row/${rowIds[0]}?p=${A}`, {
      method: 'PATCH', body: { sample_size: 6, measure_tech: 'Revised digital method' },
    });
    await request(`/msa?p=${A}`, { method: 'POST', body: {
      plan_id: activePlans.find(plan => plan.cp_row_id === rowIds[1]).plan_id,
      data: raw,
    }, expectedError: /已变更|未批准|复核/ });
    // 控制计划状态机：草稿→待审核→已批准（A-02），批准由质量角色执行
    await request(`/cp/${pilot.cp_id}?p=${A}`, { method: 'PATCH', body: { status: '待审核' } });
    await request(`/cp/${pilot.cp_id}?p=${A}`, {
      method: 'PATCH', body: { status: '已批准' }, as: qualityCookie,
    });
    msa = await request(`/msa?p=${A}`);
    activePlans = msa.plans.filter(plan => plan.source_active !== 0);
    const revised = activePlans.find(plan => plan.cp_row_id === rowIds[0]);
    const historical = msa.plans.find(plan => plan.plan_id === numericPlan.plan_id);
    assert.notEqual(revised.plan_id, numericPlan.plan_id);
    assert.equal(historical.status, '已完成');
    assert.equal(historical.source_active, 0);
    assert.equal(msa.studies.find(item => item.study_id === study.study_id).status, '已完成');
    assert.equal(JSON.parse(reader.prepare('SELECT plan_snapshot_json FROM msa_study WHERE study_id=?')
      .get(study.study_id).plan_snapshot_json).source_version, numericPlan.source_version);
    checks += 5;

    await saveDocument('P3-08', A, data => {
      data.proj = A;
      data.part_no = A;
      data.plan = [['阻值精度', 'SG-API-NEW', '计划新增X光测厚仪', 'GRR', '10×3×3', '2026-12-20', 'API Tester', '计划']];
      data._syncRows ||= {};
      data._syncRows.plan = ['p308-new-gauge-row'];
    });
    await approveDocument('P3-08', A);
    const plannedGaugeState = await request(`/msa?p=${A}`);
    const plannedOnlyGauge = plannedGaugeState.gauges
      .find(gauge => gauge.planned_only && gauge.name === '计划新增X光测厚仪');
    assert.ok(plannedOnlyGauge, 'MSA plans must expose gauges that exist only in the plan snapshot');
    assert.ok(plannedOnlyGauge.plan_ids.length >= 1);
    const createdPlanGauge = await request(`/gauges?p=${A}`, { method: 'POST', body: {
      code: 'SG-API-NEW', name: '计划新增X光测厚仪', range_text: '0–100 μm', resolution: 0.1,
      calibration_due: '2027-12-31', owner_dept: '计量', user: 'API Tester',
    } });
    const relinkedMsa = await request(`/msa?p=${A}`);
    const linkedGauge = relinkedMsa.gauges.find(gauge => gauge.gauge_id === createdPlanGauge.gauge_id);
    assert.ok(linkedGauge && !linkedGauge.planned_only,
      'Creating a gauge from a plan must turn the plan-only entry into a normal ledger gauge');
    assert.ok(relinkedMsa.plans.some(plan => plan.source_active !== 0
      && plan.gauge_id === createdPlanGauge.gauge_id), 'The MSA plan must relink to the new gauge ledger row');
    checks += 4;
    const approvedPlanDocument = reader.prepare(`SELECT data_json,version,status FROM project_doc
      WHERE project_id=? AND doc_code='P3-08'`).get(A);
    activePlans = (await request(`/msa?p=${A}`)).plans.filter(plan => plan.source_active !== 0);
    const pendingPlans = activePlans.filter(plan => plan.status !== '已完成');
    const attribute = pendingPlans.find(plan => plan.study_type === 'ATTRIBUTE');
    assert.ok(attribute);
    await request(`/msa/external?p=${A}`, { method: 'POST', body: {
      plan_id: attribute.plan_id, evidence_ref: '', method: 'Attribute agreement analysis',
      judgment: '接受', studied_at: new Date().toISOString().slice(0, 10), operator: 'Report Reviewer',
    }, expectedError: /报告编号|研究方法|研究人/ });
    for (const plan of [attribute, ...pendingPlans.filter(item => item.plan_id !== attribute.plan_id)]) {
      const external = await request(`/msa/external?p=${A}`, { method: 'POST', body: {
        plan_id: plan.plan_id, evidence_ref: `CONTROLLED-REPORT-${plan.plan_id}`,
        method: plan.study_type === 'ATTRIBUTE' ? 'Attribute agreement analysis' : 'External GRR report',
        judgment: '接受', studied_at: new Date().toISOString().slice(0, 10), operator: 'Report Reviewer',
      } });
      assert.equal(external.status, '已计算', 'Accepted external report must not auto-complete a study');
      const state = await request(`/msa?p=${A}`);
      const pendingStudy = state.studies.find(item => item.study_id === external.study_id);
      assert.equal(pendingStudy.status, '已计算');
      assert.equal(pendingStudy.result_pct, null, 'External evidence must not fabricate a GRR number');
      assert.equal(pendingStudy.evidence_ref, `CONTROLLED-REPORT-${plan.plan_id}`);
      assert.equal(state.plans.find(item => item.plan_id === plan.plan_id).status, '研究中');
      await request(`/msa/${external.study_id}/complete?p=${A}`, {
        method: 'PATCH', body: { completed_by: 'Quality Approver' },
      });
      checks += 5;
    }
    const protectedDocument = reader.prepare(`SELECT data_json,version,status FROM project_doc
      WHERE project_id=? AND doc_code='P3-08'`).get(A);
    assert.deepEqual(protectedDocument, approvedPlanDocument,
      'Study completion must not rewrite an approved P3-08 document or its version');
    assert.equal((await request(`/deliverable-links?doc=P3-08&p=${A}`)).items
      .filter(item => item.source.docCode === 'MSA_PLAN').length, 0,
    'P3-08 is the plan source and must not receive a reverse MSA_PLAN view sync');
    const evidence = await request(`/ppap/evidence/8?p=${A}`);
    const currentMsaState = await request(`/msa?p=${A}`);
    assert.equal(evidence.workflow.linked_ready, true,
      'All current completed systems must satisfy PPAP MSA readiness: ' +
      JSON.stringify(currentMsaState.plans.filter(plan => plan.source_active !== 0)
        .map(plan => ({ id: plan.plan_id, status: plan.status, source: plan.source_status,
          trigger: plan.trigger_source, cp: plan.cp_status, gauge: plan.gauge_id,
          char: plan.project_char_id }))));
    assert.ok(evidence.msa.studies.some(item => item.plan_id === attribute.plan_id && item.status === '已完成'));
    assert.equal((await request(`/ppap?p=${A}`)).elements.find(item => item.element_no === 8).status, '未完成',
      'PPAP element completion must remain a separate confirmation');
    assert.equal((await request(`/msa?p=${B}`)).plans.length, 0);
    checks += 6;
    await assertReadOnly('Completed MSA and frozen plan-view differences');
    console.log(`Deliverable API integration passed (${checks} checks; isolated temporary database).`);
  } finally {
    if (reader) reader.close();
    if (server.exitCode == null && server.signalCode == null) {
      const exit = once(server, 'exit');
      server.kill();
      await exit;
    }
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String(error.stack || error) + '\n');
  if (serverOutput) process.stderr.write(serverOutput.slice(-6000) + '\n');
  process.exitCode = 1;
});
