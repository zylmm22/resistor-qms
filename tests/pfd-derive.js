'use strict';

/**
 * P1-1 / P-06 / P-02 验收：
 *   - P1-10（INITIAL）→ P3-04（PROCESS）派生，保留 origin_step_id，重复执行幂等
 *   - 一致性检查列出：未派生、过程版新增、已派生后改动、来源作废、重复派生、工序号重复
 *   - 父工序发布前要求全部子工步已发布（P-02）
 *
 * 运行：node tests/pfd-derive.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-pfd-derive-'));
const DB_PATH = path.join(TEMP, 'qms.db');
const PORT = 24000 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api`;
const P = 'P1-DERIVE';
const PASSWORD = 'PfdDerive-Admin-2026';

let cookie = '';
let checks = 0;

function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

function equal(actual, expected, label) {
  assert(actual === expected, `${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function api(method, url, body) {
  const target = url.startsWith('/api/') ? url.slice(4) : url;
  const response = await fetch(BASE + target, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function ok(method, url, body, label) {
  const response = await api(method, url, body);
  if (response.status !== 200) {
    throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/meta`);
      if (response.status === 401) return;
    } catch (e) { /* 等待监听 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未在 12 秒内启动');
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH, NODE_NO_WARNINGS: '1',
      QMS_ADMIN_PASSWORD: PASSWORD,
      QMS_ENGINEER_PASSWORD: 'PfdDerive-Engineer-2026',
      QMS_QUALITY_PASSWORD: 'PfdDerive-Quality-2026',
      QMS_AUDITOR_PASSWORD: 'PfdDerive-Auditor-2026',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk.toString(); });
  child.stderr.on('data', chunk => { log += chunk.toString(); });
  try {
    await waitForServer();
    const login = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    assert(login.status === 200, `登录失败：${login.status}`);
    cookie = login.headers.get('set-cookie').split(';')[0];

    await ok('POST', '/projects', {
      name: 'PFD 派生验收项目', project_id: P, family_id: 'FM', part_no: 'RJ-PFD-DERIVE',
    }, '创建项目');

    // ---- 1. 初始流程图：批量导入 4 道工序
    const bulk = await ok('POST', `/steps/bulk?p=${P}`, {
      pfd_mode: 'INITIAL', mode: 'replace',
      names: ['备料', '涂膜', '激光调阻', '成品检验'],
    }, '批量导入初始工序');
    equal(bulk.count, 4, '初始工序导入数量');

    const initialSteps = await ok('GET', `/steps?p=${P}&mode=INITIAL`, undefined, '读取初始工序');
    equal(initialSteps.length, 4, '初始工序数量');
    const initialByName = new Map(initialSteps.map(step => [step.name, step]));

    // ---- 2. 派生
    const first = await ok('POST', `/pfd/derive-from-initial?p=${P}`, {}, '首次派生');
    equal(first.created_count, 4, '首次派生数量');
    equal(first.skipped_count, 0, '首次派生跳过数量');
    equal(first.initial_total, 4, '派生时初始工序总数');
    assert(first.created.every(item => item.origin_step_id), '派生结果必须带 origin_step_id');

    const processSteps = await ok('GET', `/steps?p=${P}&mode=PROCESS`, undefined, '读取过程工序');
    equal(processSteps.length, 4, '过程工序数量');
    for (const name of ['备料', '涂膜', '激光调阻', '成品检验']) {
      const source = initialByName.get(name);
      const derived = processSteps.find(step => step.name === name);
      assert(derived, `过程版缺少派生工序 ${name}`);
      equal(derived.origin_step_id, source.step_id, `${name} 的来源`);
      equal(derived.origin_name, name, `${name} 来源名称`);
      equal(derived.origin_step_no, source.step_no, `${name} 来源工序号`);
      equal(derived.status, '草稿', `${name} 派生后的状态`);
      equal(derived.step_no, source.step_no, `${name} 工序号沿用初始版`);
    }

    // ---- 3. 幂等
    const second = await ok('POST', `/pfd/derive-from-initial?p=${P}`, {}, '再次派生');
    equal(second.created_count, 0, '重复派生不应新增');
    equal(second.skipped_count, 4, '重复派生应全部跳过');
    equal((await ok('GET', `/steps?p=${P}&mode=PROCESS`, undefined, '重复派生后读取过程工序')).length, 4,
      '重复派生后过程工序数量');

    // ---- 4. 一致性：全部派生且未改动
    let consistency = await ok('GET', `/pfd/consistency?p=${P}`, undefined, '一致性检查（一致）');
    equal(consistency.consistent, true, '两层一致标记');
    equal(consistency.missing_in_process.length, 0, '未派生数量');
    equal(consistency.added_in_process.length, 0, '过程版新增数量');
    equal(consistency.changed.length, 0, '内容差异数量');
    equal(consistency.derived, 4, '已派生数量');

    // ---- 5. 过程版新增一道工序 → 一致性列出
    await ok('POST', `/steps?p=${P}`, {
      mode: 'PROCESS', name: '包装', step_type: '工序',
    }, '过程版新增工序');

    consistency = await ok('GET', `/pfd/consistency?p=${P}`, undefined, '一致性检查（过程版新增）');
    equal(consistency.consistent, false, '有新增工序时不应标记一致');
    equal(consistency.added_in_process.length, 1, '过程版新增数量');
    equal(consistency.added_in_process[0].name, '包装', '过程版新增工序名称');

    // ---- 6. 初始工序改名 → 一致性列出字段差异
    const renameSource = initialByName.get('涂膜');
    await ok('PATCH', `/steps/${renameSource.step_id}?p=${P}`, {
      mode: 'INITIAL', name: '涂膜（改名）',
    }, '修改初始工序名称');
    consistency = await ok('GET', `/pfd/consistency?p=${P}`, undefined, '一致性检查（内容差异）');
    equal(consistency.changed.length, 1, '内容差异数量');
    equal(consistency.changed[0].origin_step_id, renameSource.step_id, '内容差异来源');
    equal(consistency.changed[0].fields.join(','), 'name', '内容差异字段');

    // ---- 7. 初始版新增父工序 + 工步，派生保留层级
    const parent = await ok('POST', `/steps?p=${P}`, {
      mode: 'INITIAL', name: '封装', step_type: '工序', equipment: '封装线',
      input_desc: '芯体', output_desc: '封装件',
    }, '新增初始父工序');
    await ok('POST', `/steps?p=${P}`, {
      mode: 'INITIAL', parent_step_id: parent.step_id, name: '点胶', step_type: '工序',
      equipment: '点胶机', input_desc: '封装件', output_desc: '点胶件',
    }, '新增初始工步');
    const third = await ok('POST', `/pfd/derive-from-initial?p=${P}`, {}, '派生父子工序');
    equal(third.created_count, 2, '派生父子工序数量');
    const processTree = await ok('GET', `/steps?p=${P}&mode=PROCESS`, undefined, '读取过程工序树');
    const derivedParent = processTree.find(step => step.origin_step_id === parent.step_id);
    const derivedChild = processTree.find(step => step.origin_step_id
      && processTree.some(candidate => candidate.step_id === step.parent_step_id
        && candidate.origin_step_id === parent.step_id));
    assert(derivedParent, '父工序应已派生');
    assert(derivedChild, '工步应已派生并挂在派生父工序下');
    equal(derivedChild.parent_step_id, derivedParent.step_id, '派生的父子关系');

    // ---- 8. P-02：父工序发布前要求全部工步已发布
    const early = await api('PATCH', `/steps/${derivedParent.step_id}?p=${P}`, {
      mode: 'PROCESS', status: '已发布',
    });
    equal(early.status, 409, '父工序在工步未发布时发布 HTTP');
    equal((early.json.details?.draft_children || []).length, 1, '应返回未发布工步清单');
    equal(early.json.details.draft_children[0].name, '点胶', '未发布工步名称');
    await ok('PATCH', `/steps/${derivedChild.step_id}?p=${P}`, {
      mode: 'PROCESS', status: '已发布',
    }, '先发布工步');
    const afterChild = await ok('PATCH', `/steps/${derivedParent.step_id}?p=${P}`, {
      mode: 'PROCESS', status: '已发布',
    }, '工步发布后发布父工序');
    equal(afterChild.ver, 'V1.1', '父工序发布后版本');

    // ---- 9. 初始工序作废后，过程版来源失效应被列出
    const obsoleteSource = initialByName.get('备料');
    await ok('PATCH', `/steps/${obsoleteSource.step_id}?p=${P}`, {
      mode: 'INITIAL', status: '作废',
    }, '作废初始工序');
    consistency = await ok('GET', `/pfd/consistency?p=${P}`, undefined, '一致性检查（来源作废）');
    equal(consistency.source_obsolete.length, 1, '来源作废数量');
    equal(consistency.source_obsolete[0].origin_step_id, obsoleteSource.step_id, '来源作废工序');

    process.stdout.write(`PFD derive tests passed (${checks} checks; isolated temporary database).\n`);
  } catch (error) {
    process.stderr.write(String(error.stack || error) + '\n');
    if (log) process.stderr.write('--- server log ---\n' + log.slice(-2000) + '\n');
    process.exitCode = 1;
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
}

main();
