'use strict';

/**
 * P0 验收测试：按 docs/P0修复记录_v1.1.md 第 8 节的验收步骤逐条验证。
 *
 * 覆盖：
 *   P0-1 身份与授权：角色门禁、禁止自批、请求体无法伪造经办人、默认口令不再硬编码
 *   P0-2 项目隔离：非成员 ?p= 403、项目列表过滤、总览/审计不串项目、基线只含本项目对象
 *   P0-3 状态机与并发：非法迁移 409、失败路径不改状态、普通编辑不写覆盖标记、并发保存 409、CP 版本快照
 *   P0-4 引用完整性：删 FMEA 行清链接并降草稿、批量替换 409+影响清单、删除被引用特性 409+引用清单
 *   P0-5 受控输出：导出默认取批准快照、?v=draft 带非受控标记、打包严格使用提交基线
 *
 * 运行：node tests/p0-acceptance.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const P = require('../lib/parse');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-p0-accept-'));
const DB_PATH = path.join(TEMP, 'qms.db');
const PORT = 23500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api`;

const P1 = 'RES-CHIP-2026-01'; // 演示项目：有 CP 行 / 特性 / 检具 / 初始基线
const PA = 'P0-ACC'; // 验收用新项目：三阶段 CP 均为草稿，数据干净

const PASSWORDS = {
  admin: 'P0Accept-Admin-2026',
  engineer: 'P0Accept-Engineer-2026',
  quality: 'P0Accept-Quality-2026',
  auditor: 'P0Accept-Auditor-2026',
};

const cookies = {};
const results = [];
const planId = {}; // stage -> 该项目真实的控制计划编号
let child = null;
let serverLog = '';

/* ------------------------------------------------------------------ 工具 */

async function api(method, url, options = {}) {
  const { as = 'admin', body, headers = {} } = options;
  const target = url.startsWith('/api/') ? url.slice(4) : url;
  const response = await fetch(BASE + target, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies[as] ? { Cookie: cookies[as] } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString('utf8')); } catch (e) { json = null; }
  return { status: response.status, headers: response.headers, json, buffer };
}

async function login(username, password) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 200) throw new Error(`登录失败 ${username}: ${response.status}`);
  const cookie = response.headers.get('set-cookie');
  return cookie.split(';')[0];
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function expectOk(promise, label) {
  const response = await promise;
  if (response.status !== 200) {
    throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

async function check(id, title, fn) {
  try {
    await fn();
    results.push({ id, title, ok: true, detail: '' });
    process.stdout.write(`  PASS ${id} ${title}\n`);
  } catch (error) {
    results.push({ id, title, ok: false, detail: error.message });
    process.stdout.write(`  FAIL ${id} ${title}\n       ${error.message}\n`);
  }
}

function documentColumns(doc) {
  return Object.fromEntries(doc.sections.flatMap(section => section.fields)
    .filter(field => field.type === 'table')
    .map(field => [field.k, field.cols]));
}

/** 选一个可写的正文字段（优先非表格），用于证明导出内容来源 */
function pickContentField(doc) {
  for (const section of doc.sections || []) {
    if (section.t === '基本信息' || section.t === '签署') continue;
    for (const field of section.fields || []) {
      if (field.type !== 'table') return { key: field.k, table: false };
    }
    for (const field of section.fields || []) {
      if (field.type === 'table') return { key: field.k, table: true, cols: (field.cols || []).length };
    }
  }
  return null;
}

function setMarker(data, field, marker) {
  if (!field.table) {
    data[field.key] = marker;
    return;
  }
  const width = Math.max(1, field.cols || 1);
  const row = Array(width).fill('');
  row[0] = marker;
  data[field.key] = [row];
}

/* --------------------------------------------------------------- 启动服务 */

function startServer(env) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.on('data', chunk => { serverLog += chunk.toString(); });
  proc.stderr.on('data', chunk => { serverLog += chunk.toString(); });
  return proc;
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/meta`);
      if (response.status === 401 || response.ok) return;
    } catch (e) { /* 还没监听 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未在 12 秒内启动\n' + serverLog);
}

async function main() {
  child = startServer({
    ...process.env,
    PORT: String(PORT),
    QMS_DB_PATH: DB_PATH,
    QMS_ADMIN_PASSWORD: PASSWORDS.admin,
    QMS_ENGINEER_PASSWORD: PASSWORDS.engineer,
    QMS_QUALITY_PASSWORD: PASSWORDS.quality,
    QMS_AUDITOR_PASSWORD: PASSWORDS.auditor,
  });
  await waitForServer(PORT);

  for (const [role, username] of [['admin', 'admin'], ['engineer', 'engineer'],
    ['quality', 'quality'], ['auditor', 'auditor']]) {
    cookies[role] = await login(username, PASSWORDS[role]);
  }

  const created = await expectOk(api('POST', '/api/projects', {
    body: {
      name: 'P0 验收项目', project_id: PA, family_id: 'FM',
      part_no: 'RJ-P0-ACC-001', owner: '验收管理员',
    },
  }), '创建验收项目');
  expectEqual(created.project_id, PA, '验收项目编号');
  const createdPlans = await expectOk(api('GET', `/cp?p=${PA}`), '读取验收项目控制计划');
  for (const plan of createdPlans.plans) planId[plan.stage] = plan.cp_id;
  for (const stage of ['PROTO', 'PILOT', 'SOP']) {
    expect(planId[stage], `新项目应自动创建 ${stage} 控制计划`);
  }

  process.stdout.write('\n== P0-1 身份与授权 ==\n');

  await check('P0-1.1', 'engineer 提交审核可以，批准控制计划返回 403', async () => {
    const submit = await api('PATCH', `/cp/${planId.PROTO}?p=${PA}`, {
      as: 'engineer', body: { status: '待审核' },
    });
    expectEqual(submit.status, 200, `engineer 提交待审核 HTTP（${JSON.stringify(submit.json)}）`);
    const approve = await api('PATCH', `/cp/${planId.PROTO}?p=${PA}`, {
      as: 'engineer', body: { status: '已批准' },
    });
    expectEqual(approve.status, 403, 'engineer 批准 HTTP');
    expect(/质量|权限/.test(String(approve.json?.error || '')),
      `错误信息应说明角色不足，实际：${approve.json?.error}`);
  });

  await check('P0-1.2', '请求体 approved_by 被会话身份覆盖（不能伪造“张三”）', async () => {
    const approve = await api('PATCH', `/cp/${planId.PROTO}?p=${PA}`, {
      as: 'quality', body: { status: '已批准', approved_by: '张三' },
    });
    expectEqual(approve.status, 200, `quality 批准 HTTP（${JSON.stringify(approve.json)}）`);
    const cp = await expectOk(api('GET', `/cp?p=${PA}&stage=PROTO`), '读取控制计划');
    const plan = cp.plans.find(item => item.cp_id === planId.PROTO);
    expectEqual(plan.approved_by, '质量工程师', 'control_plan.approved_by');
    expect(plan.approved_by !== '张三', 'control_plan.approved_by 不应是客户端传入的姓名');

    const audit = await expectOk(api('GET', `/audit?p=${PA}`), '读取审计流');
    const forged = audit.list.filter(event => event.actor === '张三');
    expectEqual(forged.length, 0, '审计流中伪造经办人的事件数');
    const approvedEvents = audit.list.filter(event =>
      event.actor === '质量工程师' && event.object_type === 'control_plan');
    expect(approvedEvents.length >= 1, '审计流应记录质量工程师对控制计划的批准');
  });

  await check('P0-1.3', '编制人不得批准自己编制的控制计划（403）', async () => {
    const setPreparer = await api('PATCH', `/cp/${planId.PILOT}?p=${PA}`, {
      body: { prepared_by: '质量工程师' },
    });
    expectEqual(setPreparer.status, 200, `设置编制人 HTTP（${JSON.stringify(setPreparer.json)}）`);
    await expectOk(api('PATCH', `/cp/${planId.PILOT}?p=${PA}`, { body: { status: '待审核' } }),
      '提交待审核');
    const selfApprove = await api('PATCH', `/cp/${planId.PILOT}?p=${PA}`, {
      as: 'quality', body: { status: '已批准' },
    });
    expectEqual(selfApprove.status, 403, '自批 HTTP');
    expect(/自己编制|其他有权限/.test(String(selfApprove.json?.error || '')),
      `错误信息应说明禁止自批，实际：${selfApprove.json?.error}`);
    const approved = await api('PATCH', `/cp/${planId.PILOT}?p=${PA}`, {
      as: 'admin', body: { status: '已批准' },
    });
    expectEqual(approved.status, 200, `管理员批准 HTTP（${JSON.stringify(approved.json)}）`);
  });

  await check('P0-1.4', 'auditor 只读：写接口一律 403', async () => {
    const write = await api('PATCH', `/cp/${planId.SOP}?p=${PA}`, {
      as: 'auditor', body: { status: '待审核' },
    });
    expectEqual(write.status, 403, 'auditor 写操作 HTTP');
  });

  process.stdout.write('\n== P0-2 项目隔离 ==\n');

  await check('P0-2.1', '新项目总览不包含其它项目的特性/控制计划行', async () => {
    const dashboard = await expectOk(api('GET', `/dashboard?p=${PA}`), '读取总览');
    expectEqual(dashboard.charCoverage.length, 0, 'charCoverage 行数');
    expectEqual(dashboard.counts.chars, 0, 'counts.chars');
    expectEqual(dashboard.counts.cpRows, 0, 'counts.cpRows');
    expectEqual(dashboard.counts.baselines, 0, 'counts.baselines');
    const audit = await expectOk(api('GET', `/audit?p=${PA}`), '读取审计流');
    const foreign = audit.list.filter(event => event.project_id && event.project_id !== PA);
    expectEqual(foreign.length, 0, '审计流中其它项目事件数');
  });

  await check('P0-2.2', '非成员访问 ?p= 返回 403，项目列表不再暴露该项目', async () => {
    await expectOk(api('PUT', `/admin/projects/${PA}/members`, {
      body: { user_ids: ['USR-QUALITY', 'USR-ADMIN'] },
    }), '配置项目成员');
    const denied = await api('GET', `/meta?p=${PA}`, { as: 'engineer' });
    expectEqual(denied.status, 403, '非成员访问 HTTP');
    expect(/不是该项目的成员/.test(String(denied.json?.error || '')),
      `错误信息应说明非成员，实际：${denied.json?.error}`);
    const allowed = await api('GET', `/meta?p=${PA}`, { as: 'quality' });
    expectEqual(allowed.status, 200, '成员访问 HTTP');
    const list = await expectOk(api('GET', '/projects', { as: 'engineer' }), '读取项目列表');
    expect(!list.list.some(item => item.project_id === PA), '项目列表不应包含非成员项目');
  });

  await check('P0-2.3', '基线只快照本项目引用的特性与检具', async () => {
    const frozen = await expectOk(api('POST', `/baselines?p=${P1}`, {
      as: 'quality', body: { tag: 'P0 验收基线', scopes: ['CHAR', 'GAUGE'] },
    }), '冻结基线');
    const detail = await expectOk(api('GET', `/baselines/${frozen.id}?p=${P1}`), '读取基线');
    const charIds = new Set(detail.items.filter(item => item.object_type === 'CHAR')
      .map(item => item.object_id));
    const gaugeIds = new Set(detail.items.filter(item => item.object_type === 'GAUGE')
      .map(item => item.object_id));
    const chars = await expectOk(api('GET', `/project-chars?p=${P1}`), '读取项目特性');
    const expectedChars = new Set(chars.items.map(item => item.char_id));
    const cp = await expectOk(api('GET', `/cp?p=${P1}&stage=PILOT`), '读取控制计划');
    const expectedGauges = new Set(cp.rows.map(row => row.gauge_id).filter(Boolean));
    const foreignChars = [...charIds].filter(id => !expectedChars.has(id));
    const foreignGauges = [...gaugeIds].filter(id => !expectedGauges.has(id));
    expectEqual(foreignChars.length, 0, `基线中非本项目特性：${foreignChars.join(',')}`);
    expectEqual(foreignGauges.length, 0, `基线中非本项目检具：${foreignGauges.join(',')}`);
    expect(expectedChars.size > 0, '本项目应有项目特性');
  });

  process.stdout.write('\n== P0-3 状态机与并发 ==\n');

  await check('P0-3.1', '控制计划 草稿 → 已冻结 返回 409', async () => {
    const illegal = await api('PATCH', `/cp/${planId.SOP}?p=${PA}`, { body: { status: '已冻结' } });
    expectEqual(illegal.status, 409, '非法迁移 HTTP');
    expect(/不能从/.test(String(illegal.json?.error || '')),
      `错误信息应说明非法迁移，实际：${illegal.json?.error}`);
  });

  await check('P0-3.2', '监控项创建失败不改变已批准控制计划状态', async () => {
    const before = await expectOk(api('GET', `/cp?p=${P1}&stage=PILOT`), '读取控制计划');
    expectEqual(before.plans.find(item => item.cp_id === 'CP-CHIP-PILOT-r1').status, '已批准',
      '前置条件：演示控制计划应为已批准');
    const failed = await api('POST', `/cp/CP-00030/monitor?p=${P1}`, {
      body: { chart_type: 'Xbar-R', subgroup_n: 11, gauge_id: 'G-014' },
    });
    expect(failed.status >= 400 && failed.status < 500, `非法子组大小应被拒绝，实际 ${failed.status}`);
    expect(/2–10|2-10/.test(String(failed.json?.error || '')),
      `错误信息应说明子组大小范围，实际：${failed.json?.error}`);
    const after = await expectOk(api('GET', `/cp?p=${P1}&stage=PILOT`), '再次读取控制计划');
    expectEqual(after.plans.find(item => item.cp_id === 'CP-CHIP-PILOT-r1').status, '已批准',
      '失败后控制计划状态');
  });

  await check('P0-3.3', '普通 CP 行编辑不写入覆盖标记', async () => {
    const before = await expectOk(api('GET', `/cp?p=${P1}&stage=PILOT`), '读取控制计划');
    expectEqual(before.rows.find(item => item.cp_row_id === 'CP-00025').override_flag, 0,
      '前置条件：CP-00025 初始未覆盖');
    await expectOk(api('PATCH', `/cp/row/CP-00025?p=${P1}`, { body: { sample_size: 7 } }),
      '编辑控制计划行');
    const cp = await expectOk(api('GET', `/cp?p=${P1}&stage=PILOT`), '读取控制计划');
    const row = cp.rows.find(item => item.cp_row_id === 'CP-00025');
    expectEqual(row.override_flag, 0, 'override_flag');
    expectEqual(row.sample_size, 7, 'sample_size');
  });

  await check('P0-3.4', '并发保存交付物：过期 lock_token 返回 409', async () => {
    const doc = await expectOk(api('GET', `/docs/P3-02?p=${PA}`), '读取交付物');
    const field = pickContentField(doc) || { key: 'proj', table: false };
    const data = JSON.parse(JSON.stringify(doc.data || {}));
    setMarker(data, field, 'LOCK-BASE');
    const first = await expectOk(api('PUT', `/docs/P3-02?p=${PA}`, {
      body: { data, cols: documentColumns(doc), status: '草稿', version: doc.version,
        change_note: 'P0 验收：并发保存基线' },
    }), '第一次保存');
    const second = await api('PUT', `/docs/P3-02?p=${PA}`, {
      body: { data, cols: documentColumns(doc), status: '草稿', version: doc.version,
        base_lock_token: first.lock_token },
    });
    expectEqual(second.status, 200, '携带最新令牌的第二次保存 HTTP');
    const third = await api('PUT', `/docs/P3-02?p=${PA}`, {
      body: { data, cols: documentColumns(doc), status: '草稿', version: doc.version,
        base_lock_token: first.lock_token },
    });
    expectEqual(third.status, 409, '过期令牌保存 HTTP');
    expect(/其他会话|刷新/.test(String(third.json?.error || '')),
      `错误信息应提示并发修改，实际：${third.json?.error}`);
  });

  await check('P0-3.5', '控制计划批准后生成版本快照', async () => {
    const revisions = await expectOk(api('GET', `/cp/${planId.PILOT}/revisions?p=${PA}`), '读取 CP 版本');
    expect(revisions.list.length >= 1, '批准后应至少有一条 CP 版本快照');
    expect(revisions.list.some(item => item.status === '已批准'), '快照中应包含已批准版本');
  });

  process.stdout.write('\n== P0-5 受控输出 ==\n');

  const docCase = { code: '', field: null, approvedVersion: '', approvedMarker: '', draftMarker: '' };

  await check('P0-5.1', '批准后修订再导出：默认导出最近批准版本', async () => {
    const candidates = ['P3-02', 'P3-05', 'P3-07', 'P2-02', 'P2-03', 'P2-04', 'P4-01'];
    let picked = null;
    for (const code of candidates) {
      const response = await api('GET', `/docs/${code}?p=${PA}`);
      if (response.status !== 200) continue;
      const field = pickContentField(response.json);
      if (!field) continue;
      picked = { code, doc: response.json, field };
      break;
    }
    expect(picked, '应至少找到一个可编辑的正式交付物');
    const marker = 'P0ACCEPT-APPROVED-' + Date.now().toString(36).toUpperCase();
    const draftMarker = 'P0ACCEPT-DRAFT-' + Date.now().toString(36).toUpperCase();
    const baseData = JSON.parse(JSON.stringify(picked.doc.data || {}));
    setMarker(baseData, picked.field, marker);
    await expectOk(api('PUT', `/docs/${picked.code}?p=${PA}`, {
      body: { data: baseData, cols: documentColumns(picked.doc), status: '草稿',
        version: picked.doc.version, change_note: 'P0 验收：编制批准版本' },
    }), '保存批准版本内容');
    await expectOk(api('POST', `/docs/${picked.code}/submit?p=${PA}`, { body: {} }), '提交审核');
    const approved = await expectOk(api('POST', `/docs/${picked.code}/approve?p=${PA}`, {
      as: 'quality', body: {},
    }), '批准交付物');
    expectEqual(approved.status, '已批准', '批准后状态');
    const approvedVersion = approved.version;

    // 批准后修订：内容改回草稿
    const current = await expectOk(api('GET', `/docs/${picked.code}?p=${PA}`), '读取已批准交付物');
    const revised = JSON.parse(JSON.stringify(current.data || {}));
    setMarker(revised, picked.field, draftMarker);
    const put = await api('PUT', `/docs/${picked.code}?p=${PA}`, {
      body: { data: revised, cols: documentColumns(current), version: current.version,
        change_note: 'P0 验收：批准后修订内容' },
    });
    expectEqual(put.status, 200, `修订保存 HTTP（${JSON.stringify(put.json)}）`);
    expectEqual(put.json.status, '草稿', '修订后状态');

    Object.assign(docCase, {
      code: picked.code, field: picked.field, approvedVersion, approvedMarker: marker, draftMarker,
    });

    const exported = await api('GET', `/docs/${picked.code}/export?p=${PA}&fmt=docx`);
    expectEqual(exported.status, 200, '默认导出 HTTP');
    const files = P.readZip(exported.buffer);
    const xml = (files.get('word/document.xml') || Buffer.from('')).toString('utf8');
    expect(xml.includes(marker), '默认导出应包含最近批准版本的内容');
    expect(!xml.includes(draftMarker), '默认导出不应包含未批准的修订内容');
    const disposition = String(exported.headers.get('content-disposition') || '');
    const decoded = decodeURIComponent(disposition);
    expect(!/_草稿|草稿/.test(decoded), `受控导出的文件名不应带草稿标记：${decoded}`);

    const exportsList = await expectOk(api('GET', `/exports?p=${PA}`), '读取导出记录');
    const records = exportsList.list.filter(item =>
      item.object_type === 'project_doc' && item.object_id === picked.code);
    expect(records.some(item => item.object_version === approvedVersion),
      `导出记录应写批准版本 ${approvedVersion}，实际：${records.map(item => item.object_version).join(',')}`);
    expect(!records.some(item => /草稿/.test(String(item.object_version || ''))),
      '受控导出的记录不应标记草稿');
  });

  await check('P0-5.2', '?v=draft 导出当前内容并明确标注非受控', async () => {
    expect(docCase.code, '前置检查未完成（P0-5.1 失败）');
    const exported = await api('GET', `/docs/${docCase.code}/export?p=${PA}&fmt=docx&v=draft`);
    expectEqual(exported.status, 200, '草稿导出 HTTP');
    const files = P.readZip(exported.buffer);
    const xml = (files.get('word/document.xml') || Buffer.from('')).toString('utf8');
    expect(xml.includes(docCase.draftMarker), '草稿导出应包含当前编辑内容');
    const disposition = decodeURIComponent(String(exported.headers.get('content-disposition') || ''));
    expect(/草稿/.test(disposition), `草稿导出的文件名应带草稿标记：${disposition}`);
    const exportsList = await expectOk(api('GET', `/exports?p=${PA}`), '读取导出记录');
    const records = exportsList.list.filter(item =>
      item.object_type === 'project_doc' && item.object_id === docCase.code);
    expect(records.some(item => /草稿/.test(String(item.object_version || ''))),
      '草稿导出的记录应标注 (草稿)');
  });

  await check('P0-5.3', '未发布的 FMEA/CP 导出带【未受控】标记，已批准的不带', async () => {
    const draftExport = await api('GET', `/quality-tools/cp/export?p=${PA}&stage=SOP&fmt=docx`);
    expectEqual(draftExport.status, 200, '未批准控制计划导出 HTTP');
    const draftXml = (P.readZip(draftExport.buffer).get('word/document.xml') || Buffer.from(''))
      .toString('utf8');
    expect(/未受控/.test(draftXml), '未批准控制计划导出应包含【未受控】标记');

    const approvedExport = await api('GET', `/quality-tools/cp/export?p=${PA}&stage=PROTO&fmt=docx`);
    expectEqual(approvedExport.status, 200, '已批准控制计划导出 HTTP');
    const approvedXml = (P.readZip(approvedExport.buffer).get('word/document.xml') || Buffer.from(''))
      .toString('utf8');
    expect(!/未受控/.test(approvedXml), '已批准控制计划的导出不应标未受控');

    const exportsList = await expectOk(api('GET', `/exports?p=${PA}`), '读取导出记录');
    const records = exportsList.list.filter(item => item.object_type === 'control_plan');
    expect(records.some(item => /SOP/.test(String(item.object_id || ''))
      && /未受控/.test(String(item.object_version || ''))),
      `未受控导出记录应标注未受控，实际：${records.map(item => `${item.object_id}=${item.object_version}`).join(',')}`);
    expect(records.some(item => /PROTO/.test(String(item.object_id || ''))
      && !/未受控/.test(String(item.object_version || ''))),
      '受控导出记录不应标注未受控');
  });

  await check('P0-5.4', '打包严格使用提交基线（之后冻结新基线也不影响）', async () => {
    await expectOk(api('PATCH', `/ppap/submission?p=${PA}`, {
      as: 'quality', body: { level: 1 },
    }), '设置 PPAP 提交等级');
    // B-09：证据先保存为待确认，再由质量角色确认完成
    await expectOk(api('PATCH', '/ppap/18?p=' + PA, {
      body: { status: '待确认', evidence: 'PSW-P0-ACC-001' },
    }), '保存 PPAP 要素 18 证据');
    await expectOk(api('PATCH', '/ppap/18?p=' + PA, {
      as: 'quality', body: { status: '已完成', evidence: 'PSW-P0-ACC-001' },
    }), '完成 PPAP 要素 18');
    const firstPackage = await expectOk(api('POST', `/ppap/package?p=${PA}`, { body: { level: 1 } }),
      '第一次 PPAP 打包');
    const submission = await expectOk(api('GET', `/ppap/submission?p=${PA}`), '读取 PPAP 提交信息');
    const submissionBaseline = submission.submission.baseline_id;
    expect(submissionBaseline, '打包后应绑定提交基线');

    await expectOk(api('POST', `/baselines?p=${PA}`, {
      as: 'quality', body: { tag: '提交后的新基线', version: 'V-ACC-NEW' },
    }), '提交后冻结新基线');

    const secondPackage = await expectOk(api('POST', `/ppap/package?p=${PA}`, { body: { level: 1 } }),
      '第二次 PPAP 打包');
    expect(secondPackage.pkg_id, '第二次打包应返回包号');
    const zip = await api('GET', `/ppap/packages/${secondPackage.pkg_id}/download?p=${PA}`);
    expectEqual(zip.status, 200, '下载 PPAP 包 HTTP');
    const files = P.readZip(zip.buffer);
    const manifest = JSON.parse((files.get('manifest.json') || Buffer.from('{}')).toString('utf8'));
    expectEqual(manifest.baseline.id, submissionBaseline, '打包使用的基线');
    expectEqual(manifest.checklist_source, 'baseline', '清单来源');
    expectEqual(firstPackage.pkg_id !== secondPackage.pkg_id, true, '两次打包应生成不同的包');
  });

  process.stdout.write('\n== P0-4 引用完整性 ==\n');

  await check('P0-4.1', '删除 FMEA 行后清理 CP 链接并降草稿', async () => {
    const removed = await api('DELETE', `/fmea/row/FR-PF-00004?p=${P1}`);
    expectEqual(removed.status, 200, `删除 FMEA 行 HTTP（${JSON.stringify(removed.json)}）`);
    const cp = await expectOk(api('GET', `/cp?p=${P1}&stage=PILOT`), '读取控制计划');
    const plan = cp.plans.find(item => item.cp_id === 'CP-CHIP-PILOT-r1');
    expectEqual(plan.status, '草稿', '受影响控制计划状态');
    const row = cp.rows.find(item => item.cp_row_id === 'CP-00045');
    expect(row, '控制计划行应保留');
    expectEqual(row.fmea_row_id, null, '控制计划行的 FMEA 引用');
    // 若 cp_fmea_link 未清理，删除会因“已进入 FMEA 链接链”被拒绝
    const deleted = await api('DELETE', `/cp/row/CP-00045?p=${P1}`);
    expectEqual(deleted.status, 200, `删除控制计划行 HTTP（${JSON.stringify(deleted.json)}）`);
  });

  await check('P0-4.2', '删除被 SPC/CP 引用的特性返回 409 并列出引用', async () => {
    const response = await api('DELETE', '/chars/CHR-P-0047?p=' + P1);
    expectEqual(response.status, 409, '删除被引用特性 HTTP');
    expect(Array.isArray(response.json?.details?.references) && response.json.details.references.length > 0,
      `应返回引用清单，实际：${JSON.stringify(response.json?.details)}`);
    expect(/引用/.test(String(response.json?.error || '')),
      `错误信息应说明引用情况，实际：${response.json?.error}`);
  });

  await check('P0-4.3', '批量替换被引用工序先 409 列影响面，确认后 FMEA/CP 降草稿', async () => {
    const refused = await api('POST', `/steps/bulk?p=${P1}`, {
      body: { pfd_mode: 'PROCESS', mode: 'replace', names: ['P0 验收替换工序'] },
    });
    expectEqual(refused.status, 409, '未确认批量替换 HTTP');
    const steps = refused.json?.details?.referencing_steps;
    expect(Array.isArray(steps) && steps.length > 0, '应返回被引用工序清单');
    expect(steps.every(item => item.step_id && item.fmea_rows + item.fmea_nodes > 0),
      '影响清单应标明引用数量');

    const confirmed = await api('POST', `/steps/bulk?p=${P1}`, {
      body: { pfd_mode: 'PROCESS', mode: 'replace', names: ['P0 验收替换工序'], confirm_replace: true },
    });
    expectEqual(confirmed.status, 200, `确认替换 HTTP（${JSON.stringify(confirmed.json)}）`);

    const fmea = await expectOk(api('GET', `/fmea?type=PFMEA&p=${P1}`), '读取 PFMEA');
    expectEqual(fmea.header.status, '草稿', '受影响 PFMEA 状态');
    const cp = await expectOk(api('GET', `/cp?p=${P1}&stage=PILOT`), '读取控制计划');
    expectEqual(cp.plans.find(item => item.cp_id === 'CP-CHIP-PILOT-r1').status, '草稿',
      '受影响控制计划状态');
  });

  process.stdout.write('\n== P0-1 默认口令 ==\n');

  await check('P0-1.5', '未配置口令时生成一次性口令并写入仅本机可读文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-p0-creds-'));
    const port = PORT + 7;
    const env = {
      ...process.env, PORT: String(port), QMS_DB_PATH: path.join(dir, 'qms.db'),
    };
    for (const key of ['QMS_ADMIN_PASSWORD', 'QMS_ENGINEER_PASSWORD',
      'QMS_QUALITY_PASSWORD', 'QMS_AUDITOR_PASSWORD']) delete env[key];
    const proc = startServer(env);
    let log = '';
    proc.stdout.on('data', chunk => { log += chunk.toString(); });
    proc.stderr.on('data', chunk => { log += chunk.toString(); });
    try {
      await waitForServer(port);
      // 文件名带库名，避免不同库的口令互相覆盖/混淆
      const file = path.join(dir, 'initial-credentials.qms.txt');
      expect(fs.existsSync(file), '应生成 initial-credentials.qms.txt');
      const content = fs.readFileSync(file, 'utf8');
      expect(/admin\t/.test(content), `文件应包含 admin 一次性口令，实际：${content}`);
      expect(!/admin123|engineer123|quality123|auditor123/.test(content),
        '不应再写入已知默认口令');
      expect(/已生成初始账号口令/.test(log), `启动日志应告警一次性口令，实际：${log.slice(0, 400)}`);
      // 一次性口令必须真的能登录（证明不是只写文件）
      const password = content.split('\n').find(line => line.startsWith('admin\t'))?.split('\t')[1];
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password }),
      });
      expectEqual(response.status, 200, '一次性口令登录 HTTP');
    } finally {
      proc.kill();
      await new Promise(resolve => setTimeout(resolve, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function report() {
  const failed = results.filter(item => !item.ok);
  process.stdout.write('\n================ P0 验收结果 ================\n');
  for (const item of results) {
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.id}  ${item.title}\n`);
    if (!item.ok) process.stdout.write(`      ${item.detail}\n`);
  }
  process.stdout.write(`\n合计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  return failed.length;
}

main()
  .catch(error => {
    process.stderr.write(String(error.stack || error) + '\n');
    results.push({ id: 'FATAL', title: '验收脚本中断', ok: false, detail: error.message });
  })
  .finally(async () => {
    const failed = report();
    if (child) child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (failed) process.exitCode = 1;
  });
