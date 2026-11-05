'use strict';

/**
 * P3 批次：剩余高/中优先级缺陷验收。
 *
 *   F-01 修改既有 FMEA 行 S 不再被自身一致性校验拦截
 *   F-02/F-09 AP 矩阵后端下发；修改已发布 FMEA 明确提示回到草稿
 *   F-03 AP 矩阵 1000 格自愈
 *   M-03 非接受研究可退回计划
 *   M-04 演示 MSA 研究关联项目（seed 后回填）
 *   M-05 已完成研究不能删除，只能作废
 *   M-06 检具编号编辑唯一性
 *   C-05 建 CP 行时样本容量/频率校验
 *   P-03 工序号唯一性
 *   P-05 发布人取会话身份
 *   S-16 DB.tx 拒绝 async 回调
 *   M-12 P3-08 研究设计解析失败需提示
 *   D-06 特性关联重复校验（含历史 status=NULL）
 *   Q-07/Q-08/Q-10/M-15/A-07/A-14 静态断言
 *
 * 运行：node tests/p3-consistency.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let checks = 0;

/* ------------------------------------------------------------ 静态断言 */
assert.match(serverSource, /spcDatasetHash\(mon\.mon_id, subs\)/, 'Q-07：手工录入应使用统一数据哈希');
assert.match(serverSource, /spcDatasetHash\(mon\.mon_id, subgroups\)/, 'Q-07：Excel 导入应使用统一数据哈希');
assert.match(serverSource, /before_sort === 0/, 'Q-08：分选后数据应阻止能力放行');
assert.match(app, /state\.spcId = null;[\s\S]{0,120}已提交审核/, 'Q-10：修订监控后不得指向不可见的待审核项');
assert.match(app, /维度变化会清空已录入/, 'M-15：研究维度变化需二次确认并清空');
assert.match(app, /d\.published_version && !\$\('#docChangeNote'\)/, 'A-07：首次提交不强制变更原因');
assert.match(app, /async function downloadBlob/, 'A-14：导出失败不得整页跳转');
assert.match(app, /await downloadBlob\(`\/api\/docs\//, 'A-14：交付物导出应走 blob 下载');
checks += 7;

/* ------------------------------------------------------------ 单元测试 */
async function unitTests() {
  const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-p3-unit-'));
  process.env.QMS_DB_PATH = path.join(TEMP, 'qms.db');
  delete require.cache[require.resolve('../lib/db')];
  delete require.cache[require.resolve('../lib/doctpl')];
  const DB = require('../lib/db');
  try {
    DB.init();
    const total = DB.db.prepare('SELECT COUNT(*) c FROM ap_matrix').get().c;
    assert.equal(total, 1000, 'F-03：AP 矩阵应为 1000 格');
    DB.db.prepare('DELETE FROM ap_matrix WHERE s=10 AND o=10 AND d=10').run();
    const healed = DB.healApMatrix();
    assert.ok(healed.inserted >= 1, 'F-03：缺格应被自愈');
    assert.equal(DB.db.prepare('SELECT COUNT(*) c FROM ap_matrix').get().c, 1000);
    assert.equal(DB.apLookup(10, 10, 10), 'H', 'F-03：自愈后 AP 查询应命中矩阵');
    checks += 3;

    assert.throws(() => DB.tx(async () => {}), /不支持 async/, 'S-16：async 回调应被拒绝');
    DB.db.prepare('CREATE TABLE tx_probe(id TEXT PRIMARY KEY)').run();
    DB.db.prepare('INSERT INTO tx_probe VALUES(?)').run('after-async-error');
    assert.equal(DB.db.prepare('SELECT COUNT(*) c FROM tx_probe').get().c, 1,
      'S-16：拒绝 async 后事务应回滚且连接仍可用');
    checks += 2;

    // M-12：P3-08 缺少研究设计列时必须提示默认 10×3×3
    DB.db.prepare("INSERT INTO project(project_id,name,family_id) VALUES('P3-UNIT','P3 unit','FM')").run();
    DB.db.prepare(`INSERT INTO char_master(char_id,char_kind,name,unit,lsl,usl)
      VALUES('P3-CHAR','PRODUCT','Diameter','mm',9,11)`).run();
    DB.ensureProjectChar('P3-UNIT', 'P3-CHAR');
    DB.db.prepare("INSERT INTO gauge(gauge_id,code,name,status) VALUES('P3-G','P3-G','Gauge','在用')").run();
    DB.db.prepare("INSERT INTO control_plan(cp_id,project_id,stage,rev,status) VALUES('P3-CP','P3-UNIT','PILOT','r1','已批准')").run();
    DB.db.prepare("INSERT INTO process_step(step_id,project_id,step_no,name) VALUES('P3-STEP','P3-UNIT','010','Step')").run();
    DB.db.prepare(`INSERT INTO cp_row(cp_row_id,cp_id,seq,step_id,char_id,project_char_id,gauge_id,measure_tech,spec_text)
      VALUES('P3-ROW','P3-CP',1,'P3-STEP','P3-CHAR',
        (SELECT pchar_id FROM project_char WHERE project_id='P3-UNIT' AND char_id='P3-CHAR'),'P3-G','Micrometer','10 +/- 1 mm')`).run();
    DB.db.prepare(`INSERT INTO project_doc_revision(
      rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,
      change_note,approved_by,approved_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'P3-REV', 'P3-08', 'P3-UNIT', 'V1.0', '已批准',
      JSON.stringify({ plan: [['Diameter', 'P3-G', 'Gauge', '2026-12-01', 'Owner', '计划']], _syncRows: { plan: ['ROW-1'] } }),
      JSON.stringify({ plan: ['特性', '检具编号', '检具名称', '计划日期', '责任人', '状态'] }),
      'Tester', '2026-11-01', 'P3-08 approved', 'Quality', '2026-11-01',
    );
    const plans = DB.ensureMsaPlans('P3-UNIT');
    const plan = plans.find(item => item.cp_row_id === 'P3-ROW');
    assert.ok(plan, 'M-12：应生成 CP 来源的 MSA 计划');
    const documentPlan = plans.find(item => item.trigger_source === 'P3-08');
    assert.ok(documentPlan, 'M-12：应生成 P3-08 来源的 MSA 计划');
    assert.match(documentPlan.note, /默认 10×3×3/, 'M-12：研究设计无法解析时必须提示默认值');
    checks += 3;

    // M-04：演示种子研究应回填项目关联
    const demoStudies = DB.db.prepare(`SELECT COUNT(*) c FROM msa_study
      WHERE project_id IS NOT NULL AND project_char_id IS NOT NULL`).get().c;
    assert.ok(demoStudies >= 2, 'M-04：演示 MSA 研究应关联项目与项目特性');
    checks += 1;
  } finally {
    try { DB.db.close(); } catch (error) { /* ignore */ }
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ 集成测试 */
async function integrationTests() {
  const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-p3-api-'));
  const DB_PATH = path.join(TEMP, 'qms.db');
  const PORT = 25400 + Math.floor(Math.random() * 300);
  const BASE = `http://127.0.0.1:${PORT}/api`;
  const PROJECT = 'P3-ACC';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QMS_DB_PATH: DB_PATH,
      QMS_ADMIN_PASSWORD: 'P3-Admin-2026', QMS_QUALITY_PASSWORD: 'P3-Quality-2026',
      QMS_ENGINEER_PASSWORD: 'P3-Engineer-2026', QMS_AUDITOR_PASSWORD: 'P3-Auditor-2026',
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const cookies = {};
  const call = async (method, url, body, as = 'admin') => {
    const target = url.startsWith('/api/') ? url.slice(4) : url;
    const suffix = target.includes('p=') || target === '/projects' ? '' : (target.includes('?') ? '&' : '?') + 'p=' + PROJECT;
    const response = await fetch(BASE + target + suffix, {
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
  };
  const login = async (username, password) => {
    const response = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200, `登录失败 ${username}`);
    return response.headers.get('set-cookie').split(';')[0];
  };
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/meta`);
        if (response.status === 401 || response.ok) break;
      } catch (error) { /* not ready */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    cookies.admin = await login('admin', 'P3-Admin-2026');
    cookies.quality = await login('quality', 'P3-Quality-2026');
    await call('POST', '/projects', {
      name: 'P3 验收项目', project_id: PROJECT, family_id: 'FM', owner: 'P3 Owner',
    });

    // P-03 / P-05
    const stepA = await call('POST', '/steps', {
      name: 'P3 工序 A', mode: 'PROCESS', step_no: '010', step_type: '制造',
      equipment: '炉', input_desc: '基体', output_desc: '成品',
    });
    assert.equal(stepA.status, 200, `P-03：创建工序 HTTP ${JSON.stringify(stepA.json)}`);
    const stepDup = await call('POST', '/steps', {
      name: 'P3 工序 B', mode: 'PROCESS', step_no: '010', step_type: '制造',
      equipment: '炉', input_desc: '基体', output_desc: '成品',
    });
    assert.equal(stepDup.status, 409, 'P-03：重复工序号应返回 409');
    const publish = await call('PATCH', `/steps/${stepA.json.step_id}`, {
      status: '已发布', published_by: '伪造发布人',
    });
    assert.equal(publish.status, 200, `P-05：发布工序 HTTP ${JSON.stringify(publish.json)}`);
    const steps = await call('GET', '/steps?mode=PROCESS');
    const publishedStep = steps.json.find(item => item.step_id === stepA.json.step_id);
    assert.notEqual(publishedStep.published_by, '伪造发布人', 'P-05：发布人不得来自请求体');
    assert.equal(publishedStep.published_by, '系统管理员', 'P-05：发布人应取会话身份');
    checks += 4;

    // C-05
    const planList = await call('GET', '/cp');
    const pilotId = (planList.json.plans.find(plan => plan.stage === 'PILOT') || {}).cp_id;
    const invalidRow = await call('POST', '/cp/row', {
      cp_id: pilotId, step_id: stepA.json.step_id, sample_size: 0,
      freq_value: 2, freq_unit: 'h',
    });
    assert.equal(invalidRow.status, 400, 'C-05：样本容量 0 应被拒绝');
    const invalidFreq = await call('POST', '/cp/row', {
      cp_id: pilotId, step_id: stepA.json.step_id, sample_size: 5,
      freq_value: -1, freq_unit: 'h',
    });
    assert.equal(invalidFreq.status, 400, 'C-05：负频率应被拒绝');
    checks += 2;

    // M-06
    const gaugeA = await call('POST', '/gauges', {
      code: 'P3-GA', name: '检具 A', calibration_due: '2099-12-31',
    });
    await call('POST', '/gauges', { code: 'P3-GB', name: '检具 B', calibration_due: '2099-12-31' });
    const gaugeDup = await call('PATCH', `/gauges/${gaugeA.json.gauge_id}`, { code: 'P3-GB' });
    assert.equal(gaugeDup.status, 409, 'M-06：编辑检具编号为已存在编号应返回 409');
    checks += 1;

    // F-01 / F-02 / F-09
    const char = await call('POST', '/chars', {
      name: 'P3 特性', char_kind: 'PRODUCT', family_id: 'FM',
      target: 10, lsl: 9, usl: 11, unit: 'mm',
    });
    const node = await call('POST', '/fmea/node', { fmea_type: 'PFMEA', name: 'P3 工序节点' });
    const func = await call('POST', '/fmea/functions', {
      node_id: node.json.node_id, text: '加工电阻器至 10 mm',
    });
    const rowPayload = {
      fmea_type: 'PFMEA', focus_node_id: node.json.node_id, func_id: func.json.func_id,
      fe_text: '尺寸异常', fm_text: '尺寸偏大', fc_text: '刀具磨损',
      s: 5, o: 5, d: 5, char_id: char.json.char_id, step_id: stepA.json.step_id,
      pc_text: '首件检验', dc_text: '卡尺测量',
    };
    const createdRow = await call('POST', '/fmea/row', rowPayload);
    assert.equal(createdRow.status, 200, `创建 FMEA 行 HTTP ${JSON.stringify(createdRow.json)}`);
    const fmeaBefore = await call('GET', '/fmea?type=PFMEA');
    assert.equal((fmeaBefore.json.apMatrix || []).length, 1000, 'F-02：FMEA 页应下发后端 AP 矩阵');
    const editedRow = await call('POST', '/fmea/row', {
      ...rowPayload, row_id: createdRow.json.row_id, s: 6,
    });
    assert.equal(editedRow.status, 200, `F-01：修改既有行 S 应成功（${JSON.stringify(editedRow.json)}）`);
    assert.equal(editedRow.json.ap, 'M', 'F-01：修改后 AP 应按后端矩阵重算');
    checks += 4;

    const publishFmea = await call('POST', '/fmea/publish', { fmea_type: 'PFMEA' }, 'quality');
    assert.equal(publishFmea.status, 200, `发布 PFMEA HTTP ${JSON.stringify(publishFmea.json)}`);
    const editedAfterPublish = await call('POST', '/fmea/row', {
      ...rowPayload, row_id: createdRow.json.row_id, s: 6, o: 6,
    });
    assert.equal(editedAfterPublish.status, 200, 'F-09：发布后行编辑应成功');
    assert.equal(editedAfterPublish.json.downgraded, true, 'F-09：发布后编辑必须提示回到草稿');
    assert.match(editedAfterPublish.json.message, /草稿/, 'F-09：提示应说明需重新发布');
    checks += 3;

    // D-06
    const productChar = await call('POST', '/chars', {
      name: 'P3 产品特性', char_kind: 'PRODUCT', family_id: 'FM',
    });
    const processChar = await call('POST', '/chars', {
      name: 'P3 过程特性', char_kind: 'PROCESS', family_id: 'FM',
    });
    const linkBody = {
      product_char_id: productChar.json.char_id, process_char_id: processChar.json.char_id,
      mechanism: '工艺参数影响产品尺寸', direction: '正相关', strength: '强',
    };
    const link = await call('POST', '/char-links', linkBody);
    assert.equal(link.status, 200, `D-06：创建关联 HTTP ${JSON.stringify(link.json)}`);
    const linkDup = await call('POST', '/char-links', linkBody);
    assert.equal(linkDup.status, 400, 'D-06：重复关联应被拒绝');
    checks += 2;

    // M-03 / M-05：直接登记计划与研究，验证状态机与作废
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    const pchar = db.prepare("SELECT pchar_id FROM project_char WHERE project_id=? AND char_id=?")
      .get(PROJECT, char.json.char_id);
    db.prepare(`INSERT INTO msa_plan_item(
      plan_id,project_id,project_char_id,char_id,gauge_id,study_type,status,
      source_active,source_status,trigger_source,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'P3-PLAN', PROJECT, pchar.pchar_id, char.json.char_id, gaugeA.json.gauge_id,
      'GRR', '研究中', 1, '有效', 'P3-08', new Date().toISOString(), new Date().toISOString());
    const study = db.prepare(`INSERT INTO msa_study(
      project_id,gauge_id,study_type,char_id,project_char_id,tolerance,judgment,
      studied_at,plan_id,status
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      PROJECT, gaugeA.json.gauge_id, 'GRR', char.json.char_id, pchar.pchar_id, 2,
      '条件接受', new Date().toISOString().slice(0, 10), 'P3-PLAN', '已计算');
    db.prepare('UPDATE msa_plan_item SET study_id=? WHERE plan_id=?').run(study.lastInsertRowid, 'P3-PLAN');
    db.close();
    const reopened = await call('PATCH', '/msa/plans/P3-PLAN', {
      status: '计划', note: '评审不通过，需改善夹具后重做',
    });
    assert.equal(reopened.status, 200, `M-03：退回计划 HTTP ${JSON.stringify(reopened.json)}`);
    assert.equal(reopened.json.item.status, '计划', 'M-03：研究中的计划可退回计划');
    assert.equal(reopened.json.item.study_id, null, 'M-03：退回后解除当前研究引用');
    checks += 2;

    const db2 = new DatabaseSync(DB_PATH);
    db2.prepare("UPDATE msa_plan_item SET status='已完成',study_id=?,completed_at=? WHERE plan_id='P3-PLAN'")
      .run(study.lastInsertRowid, new Date().toISOString());
    db2.prepare("UPDATE msa_study SET status='已完成' WHERE study_id=?").run(study.lastInsertRowid);
    db2.close();
    const deleteCompleted = await call('DELETE', `/msa/${study.lastInsertRowid}`);
    assert.equal(deleteCompleted.status, 409, 'M-05：已完成研究不能删除');
    const voided = await call('PATCH', `/msa/${study.lastInsertRowid}/void`, {
      reason: '结论有误，重新研究',
    }, 'quality');
    assert.equal(voided.status, 200, `M-05：作废研究 HTTP ${JSON.stringify(voided.json)}`);
    const db3 = new DatabaseSync(DB_PATH);
    const planAfterVoid = db3.prepare("SELECT status,study_id,source_active FROM msa_plan_item WHERE plan_id='P3-PLAN'").get();
    db3.close();
    const msa = await call('GET', '/msa');
    const voidedStudy = msa.json.studies.find(item => String(item.study_id) === String(study.lastInsertRowid));
    assert.equal(voidedStudy.status, '作废', 'M-05：作废后保留记录');
    assert.equal(planAfterVoid.status, '计划',
      `M-05：作废后计划退回计划（实际 ${JSON.stringify(planAfterVoid)}）`);
    checks += 5;
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
}

unitTests()
  .then(integrationTests)
  .then(() => console.log(`p3-consistency: ok (${checks} checks)`))
  .catch(error => {
    console.error('P3 验收失败：');
    console.error(error);
    process.exitCode = 1;
  });
