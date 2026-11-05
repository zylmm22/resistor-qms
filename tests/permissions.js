'use strict';

/**
 * 人员权限验收（2026-11-05 组织架构）：
 *   - 18 个角色、部门-岗位账号可枚举；
 *   - /api/auth/me 下发 permissions / department / position；
 *   - 交付物按目录 owner 归属授权（设计与工艺互不越权）；
 *   - 模块写守卫按岗位授权（设计不能改控制计划、综合只读不能写）；
 *   - 受控审批按权限点（工程师不能批准、副总只能批本板块）；
 *   - 账号管理：新增 / 改角色 / 停用 / 重置口令 / 不能锁死唯一管理员。
 *
 * 运行：node tests/permissions.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const PM = require('../lib/perm');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-perm-'));
const DB_PATH = path.join(TEMP, 'qms.db');
const PORT = 8855 + Math.floor(Math.random() * 15);
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'PERM-ACC';
const PASSWORDS = {
  admin: 'Perm-Admin-2026!', quality: 'Perm-Quality-2026!',
  engineer: 'Perm-Engineer-2026!', auditor: 'Perm-Auditor-2026!',
};
const cookies = {};
let child = null;
let checks = 0;

async function api(method, url, options = {}) {
  const { as = 'admin', body } = options;
  const target = url.startsWith('/api/') ? url.slice(4) : url;
  const response = await fetch(`${BASE}/api${target}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies[as] ? { Cookie: cookies[as] } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}
async function ok(promise, label) {
  const response = await promise;
  if (response.status !== 200 || !response.json) {
    throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}
async function login(username, password) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, `登录失败 ${username}: ${await response.text()}`);
  return response.headers.get('set-cookie').split(';')[0];
}
/** 填入最小可用内容并提交，避免“缺少必需内容”干扰权限断言 */
async function fillAndSubmit(code, as) {
  const doc = await ok(api('GET', `/docs/${code}`, { as }), `读取 ${code}`);
  const data = {};
  for (const section of doc.sections || []) {
    for (const field of section.fields || []) {
      if (field.type === 'table') {
        if ((field.cols || []).length && !data[field.k]) {
          data[field.k] = [field.cols.map(() => '权限验收')];
        }
      } else if (!(field.k in data)) {
        data[field.k] = '权限验收内容';
      }
    }
  }
  await ok(api('PUT', `/docs/${code}`, { as, body: { data, cols: {}, status: '草稿' } }), `保存 ${code}`);
  await ok(api('POST', `/docs/${code}/submit`, { as, body: { change_note: '权限验收提交' } }), `提交 ${code}`);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/meta`);
      if (response.status === 401 || response.ok) return;
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务未启动');
}
/** 管理员重置某个种子账号的口令并登录，返回其 cookie 与 user */
async function loginAsSeed(username) {
  const users = await ok(api('GET', '/admin/users'), '读取账号列表');
  const user = users.list.find(item => item.username === username);
  assert.ok(user, `应存在种子账号 ${username}`);
  const reset = await ok(api('POST', `/admin/users/${encodeURIComponent(user.user_id)}/reset-password`, {
    body: {},
  }), `重置 ${username} 口令`);
  const cookie = await login(username, reset.initial_password);
  cookies[username] = cookie;
  const readMe = async () => ok(fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    .then(async response => ({ status: response.status, json: await response.json() })), `读取 ${username} 身份`);
  // 重置后是“必须改密”状态，服务端会拒绝其他接口；先改掉，再按新会话重新读取身份
  let me = await readMe();
  if (me.user.must_change_password) {
    const changed = await fetch(`${BASE}/api/auth/change-password`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_password: reset.initial_password,
        new_password: `${reset.initial_password}!r`,
      }),
    });
    assert.equal(changed.status, 200, `${username} 首次改密失败`);
    me = await readMe();
    assert.equal(me.user.must_change_password, false, `${username} 改密后应清除强制改密标记`);
  }
  return { cookie, user: me.user };
}

async function main() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH,
      QMS_ADMIN_PASSWORD: PASSWORDS.admin, QMS_QUALITY_PASSWORD: PASSWORDS.quality,
      QMS_ENGINEER_PASSWORD: PASSWORDS.engineer, QMS_AUDITOR_PASSWORD: PASSWORDS.auditor,
      QMS_SEED_DEPARTMENT_USERS: '1', NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await waitForServer();
    for (const role of ['admin', 'quality', 'engineer', 'auditor']) {
      cookies[role] = await login(role, PASSWORDS[role]);
    }
    await ok(api('POST', '/projects', {
      body: { project_id: PROJECT, name: '权限验收项目', family_id: 'FM' },
    }), '新建项目');

    /* ------------------------------------------- 角色目录与账号 */
    const catalog = await ok(api('GET', '/admin/roles'), '读取角色目录');
    assert.equal(catalog.list.length, 18, '应有 18 个角色');
    assert.ok(catalog.list.some(item => item.role === 'purchase' && item.department === '企业管理部'),
      '企业管理部承担采购角色');
    assert.ok(catalog.list.some(item => item.role === 'vp_ops' && item.board === 'ops'),
      '副总经理按板块拆分');
    checks += 3;

    const users = await ok(api('GET', '/admin/users'), '读取账号列表');
    assert.ok(users.list.length >= 22, `应包含部门岗位账号，实际 ${users.list.length}`);
    const departments = new Set(users.list.map(item => item.department).filter(Boolean));
    ['质量管理部', '科研一所', '技术工艺部', '企业管理部', '安全环保部', '市场一部']
      .forEach(name => assert.ok(departments.has(name), `部门账号应包含 ${name}`));
    checks += 7;

    const facility = users.list.find(item => item.username === 'facility01');
    const metrology = users.list.find(item => item.username === 'metrology01');
    assert.ok(facility && facility.flags.includes('facility'), '安全环保部账号带 facility 标记');
    assert.equal(metrology.role, 'purchase', '计量评定员归企业管理部（采购角色）');
    checks += 2;

    /* ------------------------------------------- 身份与权限下发 */
    const design = await loginAsSeed('design01');
    assert.equal(design.user.department, '科研一所');
    assert.ok(design.user.permissions.includes('doc.edit'), '设计工程师有交付物编制权');
    assert.ok(!design.user.permissions.includes('cp.edit'), '设计工程师没有控制计划编辑权');
    assert.ok(!design.user.permissions.includes('doc.approve'), '设计工程师不能批准交付物');
    checks += 4;

    const facilityUser = await loginAsSeed('facility01');
    assert.ok(facilityUser.user.permissions.includes('facility.edit'),
      '设施账号通过标记获得环境与设施编制权');
    assert.ok(!facilityUser.user.permissions.includes('doc.edit'), '设施账号不因此获得交付物编制权');
    checks += 2;

    /* ------------------------------------------- 交付物归属 */
    const designWrite = await api('PUT', '/docs/P3-02', {
      as: 'design01', body: { data: {}, cols: {}, status: '草稿' },
    });
    assert.equal(designWrite.status, 403, '设计不能编制工艺类交付物');
    assert.match(String(designWrite.json.error), /编制归属|编制权限|归属/, '提示应说明归属');
    checks += 2;

    const designOwn = await api('PUT', '/docs/P2-06', {
      as: 'design01', body: { data: {}, cols: {}, status: '草稿' },
    });
    assert.equal(designOwn.status, 200, '设计可以编制本部门交付物');
    checks += 1;

    const engineerDoc = await api('PUT', '/docs/P3-02', {
      as: 'engineer', body: { data: {}, cols: {}, status: '草稿' },
    });
    assert.equal(engineerDoc.status, 200, '工艺可以编制工艺类交付物');
    checks += 1;

    const engineerDesignDoc = await api('PUT', '/docs/P2-06', {
      as: 'engineer', body: { data: {}, cols: {}, status: '草稿' },
    });
    assert.equal(engineerDesignDoc.status, 403, '工艺不能改设计类交付物');
    checks += 1;

    const renameByEngineer = await api('PATCH', '/docs/P3-02/meta', {
      as: 'engineer', body: { custom_name: '改名测试' },
    });
    assert.equal(renameByEngineer.status, 403, '交付物改名/隐藏属管理动作，工程师不可执行');
    checks += 1;

    /* ------------------------------------------- 模块写守卫 */
    const designCp = await api('POST', '/cp/row', {
      as: 'design01', body: { cp_id: 'CP-PERM', process_step: 'x' },
    });
    assert.equal(designCp.status, 403, '设计不能新增控制计划行');
    assert.match(String(designCp.json.error), /编辑权限/, '模块守卫错误信息应说明权限');

    const designFmea = await api('GET', '/fmea?type=DFMEA', { as: 'design01' });
    assert.equal(designFmea.status, 200, '设计可查看 FMEA');

    const staffUser = await loginAsSeed('staff01');
    const staffWrite = await api('POST', '/process-dict', {
      as: 'staff01', body: { name: '权限测试工序' },
    });
    assert.equal(staffWrite.status, 403, '综合只读不能写字典');
    const staffRead = await api('GET', '/process-dict', { as: 'staff01' });
    assert.equal(staffRead.status, 200, '综合只读可以查看字典');
    checks += 6;

    const auditorWrite = await api('PUT', '/docs/P3-02', { as: 'auditor', body: { data: {} } });
    assert.equal(auditorWrite.status, 403, '内审员只读');

    const purchaseUser = await loginAsSeed('purchase01');
    assert.ok(purchaseUser.user.permissions.includes('msa.gauge.edit'), '计量管理员可维护检具台账');
    assert.ok(purchaseUser.user.permissions.includes('purchase.edit'), '采购可维护供应商');
    const purchaseCp = await api('POST', '/cp/row', {
      as: 'purchase01', body: { cp_id: 'CP-PERM', process_step: 'x' },
    });
    assert.equal(purchaseCp.status, 403, '采购不能新增控制计划行');
    checks += 4;

    /* ------------------------------------------- 受控审批权限点 */
    await fillAndSubmit('P3-02', 'engineer');

    const engineerApprove = await api('POST', '/docs/P3-02/approve', { as: 'engineer', body: {} });
    assert.equal(engineerApprove.status, 403, '工程师不能批准交付物');
    assert.match(String(engineerApprove.json.error), /权限/, '提示应说明权限不足');
    checks += 2;

    const vpTech = await loginAsSeed('vp_tech');
    const vpTechApprove = await api('POST', '/docs/P3-02/approve', { as: 'vp_tech', body: {} });
    assert.equal(vpTechApprove.status, 403, '技术副总不能批准工艺板块交付物');
    assert.match(String(vpTechApprove.json.error), /板块/, '提示应说明板块限制');
    checks += 2;

    const vpOps = await loginAsSeed('vp_ops');
    assert.equal(vpOps.user.role, 'vp_ops');
    const vpOpsApprove = await api('POST', '/docs/P3-02/approve', { as: 'vp_ops', body: {} });
    assert.equal(vpOpsApprove.status, 200,
      `分管工艺的副总可以批准工艺交付物（实际 ${vpOpsApprove.status}：${JSON.stringify(vpOpsApprove.json)}）`);
    checks += 2;

    /* ------------------------------------------- 修订 / 恢复同样受归属约束 */
    // P2-06 此刻仍是草稿：越权方被归属校验挡下（403），归属方通过校验但被状态前置条件拒绝（400）
    const engineerReviseDesign = await api('POST', '/docs/P2-06/revise', {
      as: 'engineer', body: { reason: '工艺越权修订设计图纸' },
    });
    assert.equal(engineerReviseDesign.status, 403, '工艺不能发起设计类交付物的修订');
    checks += 1;
    const designReviseDesign = await api('POST', '/docs/P2-06/revise', {
      as: 'design01', body: { reason: '设计依据顾客图纸更新' },
    });
    assert.equal(designReviseDesign.status, 400,
      `设计应通过归属校验、仅被状态前置条件拦下（实际 ${designReviseDesign.status}：${JSON.stringify(designReviseDesign.json)}）`);
    assert.match(String(designReviseDesign.json.error), /只有已批准/, '应由“只有已批准”状态校验拒绝');
    checks += 2;

    // 总工审批权：P2-06 必须先由归属岗位填好内容并提交，否则批准会被内容校验挡下
    await fillAndSubmit('P2-06', 'design01');
    const chief = await loginAsSeed('chief');
    const chiefApproves = await api('POST', '/docs/P2-06/approve', { as: 'chief', body: {} });
    assert.equal(chiefApproves.status, 200,
      `总工可以批准交付物（实际 ${chiefApproves.status}：${JSON.stringify(chiefApproves.json)}）`);
    checks += 2;
    const designRestore = await api('POST', `/docs/P3-02/restore/${encodeURIComponent('pre-restore')}`, {
      as: 'design01', body: {},
    });
    assert.equal(designRestore.status, 403, '越权恢复同样被拒绝（归属校验先于版本校验）');
    checks += 1;

    /* ------------------------------------------- AI 配置仅管理员 */
    const engineerAiConfig = await api('GET', '/ai/config', { as: 'engineer' });
    assert.equal(engineerAiConfig.status, 403, '非管理员不能读取 AI 配置');
    const adminAiConfig = await api('GET', '/ai/config');
    assert.equal(adminAiConfig.status, 200, '管理员可以读取 AI 配置');
    checks += 2;

    /* ------------------------------------------- 账号管理 */
    const created = await ok(api('POST', '/admin/users', {
      body: {
        username: 'qa_perm01', display_name: '权限测试账号', role: 'inspector',
        department: '质量管理部', position: '检验员',
      },
    }), '新增账号');
    assert.ok(created.initial_password, '未指定口令时回显一次性口令');
    const qaCookie = await login('qa_perm01', created.initial_password);
    const qaMe = await ok(fetch(`${BASE}/api/auth/me`, { headers: { Cookie: qaCookie } })
      .then(async response => ({ status: response.status, json: await response.json() })), '新账号身份');
    assert.equal(qaMe.user.department, '质量管理部');
    assert.ok(qaMe.user.permissions.includes('spc.edit'), '检验员可录入 SPC 数据');
    assert.ok(!qaMe.user.permissions.includes('doc.edit'), '检验员不编制交付物');
    assert.equal(qaMe.user.must_change_password, true, '新账号标记为必须改密');
    // 未改密前业务接口一律拒绝，否则一次性口令会一直留在口令文件里
    const blocked = await fetch(`${BASE}/api/meta?p=${PROJECT}`, { headers: { Cookie: qaCookie } });
    assert.equal(blocked.status, 403, '未改密账号不能访问业务接口');
    assert.equal((await blocked.json()).must_change_password, true, '错误响应标记必须改密');
    checks += 6;

    const duplicate = await api('POST', '/admin/users', {
      body: { username: 'qa_perm01', display_name: '重复', role: 'inspector' },
    });
    assert.equal(duplicate.status, 400, '登录名重复应拒绝');
    const badRole = await api('POST', '/admin/users', {
      body: { username: 'qa_perm02', display_name: '错误角色', role: 'nope' },
    });
    assert.equal(badRole.status, 400, '角色不存在应拒绝');
    const shortPassword = await api('POST', '/admin/users', {
      body: { username: 'qa_perm03', display_name: '短口令', role: 'inspector', password: '123' },
    });
    assert.equal(shortPassword.status, 400, '初始口令过短应拒绝');
    checks += 3;

    const patched = await ok(api('PATCH', `/admin/users/${encodeURIComponent(created.user_id)}`, {
      body: { position: '检验员（夜班）' },
    }), '修改岗位');
    assert.equal(patched.user.position, '检验员（夜班）');
    checks += 1;

    const disable = await ok(api('PATCH', `/admin/users/${encodeURIComponent(created.user_id)}`, {
      body: { status: '停用' },
    }), '停用账号');
    assert.equal(disable.user.status, '停用');
    const afterDisable = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: qaCookie } });
    assert.equal(afterDisable.status, 401, '停用后原会话立即失效');
    checks += 2;

    const adminRow = users.list.find(item => item.username === 'admin');
    const selfDisable = await api('PATCH', `/admin/users/${encodeURIComponent(adminRow.user_id)}`, {
      body: { status: '停用' },
    });
    assert.equal(selfDisable.status, 400, '不能停用自己');
    assert.match(String(selfDisable.json.error), /自己的/, '提示应说明不能停用自己');
    checks += 2;

    /* ------------------------------------------- 权限内核单测 */
    assert.ok(PM.roleCan('quality', 'doc.approve'), '质量工程师可批准交付物');
    assert.ok(!PM.roleCan('inspector', 'doc.approve'), '检验员不能批准交付物');
    assert.ok(PM.roleCan('staff', 'facility.edit', 'facility'), 'staff + facility 标记可维护设施');
    assert.ok(!PM.roleCan('staff', 'facility.edit', ''), '普通只读不能维护设施');
    assert.deepEqual([...PM.rolesForOwner('采购、项目经理')].sort(), ['design', 'purchase'],
      '多 owner 交付物任一归属角色可编制');
    assert.ok(PM.canEditDoc('design', '', '设计'), '设计可编设计类');
    assert.ok(!PM.canEditDoc('design', '', '工艺'), '设计不可编工艺类');
    assert.ok(PM.canEditDoc('admin', '', '任何'), '管理员始终可编');
    assert.ok(PM.boardAllows('vp_ops', '工艺'), '分管工艺副总可批工艺');
    assert.ok(!PM.boardAllows('vp_ops', '设计'), '分管工艺副总不可批设计');
    assert.ok(PM.boardAllows('quality', '设计'), '非副总不受板块限制');
    checks += 10;

    console.log(`permissions: 角色 / 归属 / 模块守卫 / 审批 / 账号管理 通过（${checks} checks）`);
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 400));
    try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
    if (stderr && /Error/.test(stderr)) console.error(stderr.slice(0, 600));
  }
}

main().catch(error => {
  console.error('权限验收失败：');
  console.error(error);
  process.exitCode = 1;
});
