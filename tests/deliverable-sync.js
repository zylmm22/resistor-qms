'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-deliverable-sync-'));
process.env.QMS_DB_PATH = path.join(temporary, 'qms.db');
const DB = require('../lib/db');
const Sync = require('../lib/deliverable-sync');
const PROJECT = 'SYNC-TEST';
let serial = 0;

function run(sql, ...args) { return DB.db.prepare(sql).run(...args); }
function get(sql, ...args) { return DB.db.prepare(sql).get(...args); }
function data(code) {
  return JSON.parse(get('SELECT data_json FROM project_doc WHERE project_id=? AND doc_code=?', PROJECT, code)?.data_json || '{}');
}
function doc(code, value, status = '草稿') {
  run(`INSERT INTO project_doc(doc_code,project_id,status,data_json,version) VALUES(?,?,?,?,'V1.0')
    ON CONFLICT(doc_code,project_id) DO UPDATE SET data_json=excluded.data_json,status=excluded.status`,
  code, PROJECT, status, JSON.stringify(value));
}
function approve(code, value, version = `V1.${++serial}`) {
  doc(code, value, '已批准');
  run(`INSERT INTO project_doc_revision(rev_id,doc_code,project_id,version,status,data_json,
    changed_at,approved_by,approved_at) VALUES(?,?,?,?,'已批准',?,?,?,?)`,
  `REV-${++serial}`, code, PROJECT, version, JSON.stringify(value),
  new Date(Date.now() + serial).toISOString(), '测试批准人', new Date(Date.now() + serial).toISOString());
}
function sourceRows(table, rows, ids) { return { [table]: rows, _syncRows: { [table]: ids } }; }
function syncItem(ruleId) { return Sync.list(PROJECT).items.find(item => item.ruleId === ruleId); }
function targetStatus(code, status) { run('UPDATE project_doc SET status=? WHERE project_id=? AND doc_code=?', status, PROJECT, code); }

try {
  DB.init();
  Sync.init();
  run("INSERT INTO project(project_id,name,owner,status) VALUES(?,?,?,'进行中')", PROJECT, '联动测试项目', '测试责任人');
  run("INSERT INTO fmea_header(fmea_id,project_id,fmea_type,title,status,rev) VALUES(?,?,'DFMEA',?,'草稿','r1')",
    'DF-SYNC', PROJECT, '测试DFMEA');

  doc('P1-10', sourceRows('steps', [['010', '来料', '检验', '卡尺', '外径']], ['flow-1']));
  doc('P1-11', { proj: '表单项目名', part_no: '表单零件号' });
  const projectReferenceBefore = data('P1-11');
  Sync.syncProject(PROJECT);
  const projectReference = Sync.list(PROJECT).items
    .find(row => row.ruleId === 'project-reference:P1-11');
  assert.equal(projectReference.state, 'read_only', '项目元数据应显示为只读引用，不应标成字段已同步');
  assert.equal(projectReference.kind, 'reference');
  assert.equal(projectReference.currentValue, null, '引用快照不能伪装成目标表单现值');
  assert.equal(projectReference.incomingValue.project_name, '联动测试项目');
  assert.equal(projectReference.display.relationLabel, '只读引用');
  assert.equal(projectReference.display.sourceName, '项目基本信息');
  assert.equal(projectReference.display.targetName, '初始产品和过程特殊特性识别');
  assert.deepEqual(projectReference.display.fields.map(field => field.label),
    ['项目名称', '零件号', '顾客', '负责人']);
  assert.doesNotMatch(JSON.stringify(projectReference.display), /project_id|family_id|series_id|SYNC-TEST/);
  assert.deepEqual(data('P1-11'), projectReferenceBefore, '项目引用不能写入交付物的原始字段');
  assert.equal(get('SELECT COUNT(*) n FROM process_step WHERE project_id=?', PROJECT).n, 0, '未批准来源不能同步');

  approve('P1-10', sourceRows('steps', [['010', '来料', '检验', '卡尺', '外径']], ['flow-1']));
  let summary = Sync.syncProject(PROJECT);
  assert.equal(summary.created, 1);
  let step = get('SELECT * FROM process_step WHERE project_id=?', PROJECT);
  assert.equal(step.name, '来料');
  assert.equal(step.pfd_mode, 'INITIAL', 'P1-10 同步记录必须归入初始流程图');
  assert.equal(step.output_desc, '关键特性：外径');
  assert.equal(step.status, '草稿');
  assert.equal(Sync.syncProject(PROJECT).updated, 0, '重复调用不能改写业务数据');

  doc('P1-10', sourceRows('steps', [['010', '未批准编辑', '检验', '游标卡尺', '外径']], ['flow-1']));
  Sync.syncProject(PROJECT);
  assert.equal(get('SELECT name FROM process_step WHERE step_id=?', step.step_id).name, '来料', '来源草稿不替换批准快照');

  run('UPDATE process_step SET name=? WHERE step_id=?', '人工来料名称', step.step_id);
  approve('P1-10', sourceRows('steps', [['020', '批准新名称', '检验', '数显卡尺', '外径']], ['flow-1']));
  Sync.syncProject(PROJECT);
  step = get('SELECT * FROM process_step WHERE step_id=?', step.step_id);
  assert.equal(step.name, '人工来料名称', '保留人工修改');
  assert.equal(step.step_no, '020', '未被人工覆盖字段继续更新');
  assert.equal(step.equipment, '数显卡尺');
  let item = syncItem('initial-flow');
  assert.equal(item.state, 'conflict');
  assert.equal(item.display.sourceName, '初始流程图');
  assert.equal(item.display.sourceCode, 'P1-10');
  assert.equal(item.display.fields.find(field => field.label === '工序名称').currentValue, '人工来料名称');
  assert.equal(item.display.fields.find(field => field.label === '工序名称').incomingValue, '批准新名称');
  assert.doesNotMatch(JSON.stringify(item.display), /step_id|process_step|PS-DS-/);
  Sync.resolve(PROJECT, item.id, 'keep');
  Sync.syncProject(PROJECT);
  assert.equal(get('SELECT name FROM process_step WHERE step_id=?', step.step_id).name, '人工来料名称');
  assert.equal(syncItem('initial-flow').state, 'kept', '上游未再次变更时不重复提示已确认保留的差异');
  approve('P1-10', sourceRows('steps', [['020', '上游第三版名称', '检验', '数显卡尺', '外径']], ['flow-1']));
  Sync.syncProject(PROJECT);
  assert.equal(syncItem('initial-flow').state, 'conflict', '确认保留后，上游再变更仍提示');
  Sync.resolve(PROJECT, item.id, 'adopt');
  assert.equal(get('SELECT name FROM process_step WHERE step_id=?', step.step_id).name, '上游第三版名称');

  run("UPDATE process_step SET status='已发布' WHERE step_id=?", step.step_id);
  approve('P1-10', sourceRows('steps', [['030', '需复核', '检验', '数显卡尺', '外径']], ['flow-1']));
  Sync.syncProject(PROJECT);
  item = syncItem('initial-flow');
  assert.equal(item.state, 'review_required');
  assert.throws(() => Sync.resolve(PROJECT, item.id, 'adopt'), /草稿/);
  assert.equal(get('SELECT step_no FROM process_step WHERE step_id=?', step.step_id).step_no, '020');
  run("UPDATE process_step SET status='草稿' WHERE step_id=?", step.step_id);
  Sync.resolve(PROJECT, item.id, 'adopt');
  assert.equal(get('SELECT step_no FROM process_step WHERE step_id=?', step.step_id).step_no, '030');
  approve('P1-10', sourceRows('steps', [], []));
  Sync.syncProject(PROJECT);
  assert.equal(syncItem('initial-flow').state, 'source_missing');
  assert.ok(get('SELECT * FROM process_step WHERE step_id=?', step.step_id), '来源删除不能删除下游');
  assert.throws(() => Sync.resolve(PROJECT, item.id, 'adopt'), /来源已失效/);
  approve('P1-10', sourceRows('steps', [
    ['040', '重复ID第一行', '制造', '', ''], ['050', '重复ID第二行', '制造', '', ''],
  ], ['duplicate-flow', 'duplicate-flow']));
  Sync.syncProject(PROJECT);
  assert.equal(get("SELECT COUNT(*) n FROM process_step WHERE project_id=? AND step_no IN ('040','050')", PROJECT).n, 0,
    '重复稳定ID的第一行也必须被拒绝，不能任选第一条同步');

  approve('P1-08', { tests: [['耐久', '125°C', '10', '合格']] });
  Sync.syncProject(PROJECT);
  assert.equal(data('P2-03').dvp, undefined, '无稳定ID的历史行不能自动匹配或新增');
  assert.equal(syncItem('legacy:tests').kind, 'needs_confirmation');
  assert.throws(() => Sync.resolve(PROJECT, syncItem('legacy:tests').id, 'adopt'), /稳定行ID/);

  approve('P1-08', sourceRows('tests', [['耐久', '125°C', '10', '无损坏']], ['rel-1']));
  Sync.syncProject(PROJECT);
  item = syncItem('reliability-dvp');
  assert.equal(item.kind, 'candidate');
  assert.equal(item.state, 'review_required');
  Sync.resolve(PROJECT, item.id, 'adopt');
  assert.equal(data('P2-03').dvp[0][2], '耐久');
  assert.equal(data('P2-03').dvp[0][3], '无损坏');
  assert.equal(data('P2-03').dvp[0][7], '', '候选不生成试验结果');
  assert.ok(data('P2-03')._syncRows.dvp[0]);

  approve('P1-11', sourceRows('chars', [['CHR-X', '温度', 'SC', '顾客', '识别依据', '', '顾客']], ['char-1']));
  Sync.syncProject(PROJECT);
  assert.equal(get('SELECT COUNT(*) n FROM project_char WHERE project_id=?', PROJECT).n, 0, '不能根据名称猜产品/过程类型');
  const missingType = syncItem('initial-special-characteristic');
  assert.equal(missingType.kind, 'needs_confirmation', '初始识别必须明确产品/过程类型');
  assert.throws(() => Sync.resolve(PROJECT, missingType.id, 'adopt'), /稳定行ID|显式产品\/过程类型/);
  approve('P1-11', sourceRows('chars', [[
    'CHR-X', '温度', 'SC', '顾客', '识别依据', '产品特性', '顾客', 'REQ-1', 'Rev B',
  ]], ['char-1']));
  Sync.syncProject(PROJECT);
  item = syncItem('initial-special-characteristic');
  assert.equal(item.kind, 'candidate');
  assert.equal(item.state, 'review_required');
  assert.equal(item.display.targetName, '产品和过程特殊特性');
  assert.deepEqual(item.display.fields.map(field => field.label),
    ['编号', '名称', '规格/公差', '分类', '来源', '保证工序', '类型（产品/过程）', '顾客分类', '组织分类/对照', '顾客同意依据']);
  assert.equal(get('SELECT COUNT(*) n FROM project_char WHERE project_id=?', PROJECT).n, 0,
    '初始识别只生成正式特性表候选，不提前建立项目特性');
  Sync.resolve(PROJECT, item.id, 'adopt');
  const formal = data('P2-11');
  assert.deepEqual(formal.chars[0], [
    'CHR-X', '温度', '', 'SC', '初始识别（识别主体：顾客）；顾客；REQ-1；来源版本：Rev B',
    '', 'PRODUCT', 'SC', '', '',
  ]);
  approve('P2-11', formal);
  Sync.syncProject(PROJECT);
  assert.equal(syncItem('initial-special-characteristic').kind, 'reference',
    'A formally confirmed special characteristic remains traceable without creating a duplicate candidate');
  const char = get('SELECT * FROM project_char WHERE project_id=? AND char_id=?', PROJECT, 'CHR-X');
  assert.equal(char.char_kind, 'PRODUCT');
  assert.ok(char.pchar_id, '正式批准后建立项目特性ID');
  assert.equal(char.special_symbol, 'SC');
  assert.equal(get('SELECT char_kind FROM char_master WHERE char_id=?', 'CHR-X').char_kind, 'PRODUCT');
  run(`INSERT INTO char_master(char_id,char_kind,name,family_id,status)
    VALUES('FOREIGN-CHAR','PRODUCT','其他族特性','OTHER-FAMILY','生效')`);
  approve('P1-11', sourceRows('chars', [
    ['FOREIGN-CHAR', '不能跨族复用', 'SC', '', '', '产品特性', '组织'],
    ['SAFE-CHAR', '本项目特性', 'SC', '', '', '产品特性', '组织'],
  ], ['foreign-char', 'safe-char']));
  assert.doesNotThrow(() => Sync.syncProject(PROJECT), '不兼容的单行只记录问题，不使整个批准源同步失败');
  assert.equal(get('SELECT COUNT(*) n FROM project_char WHERE project_id=? AND char_id=?', PROJECT, 'FOREIGN-CHAR').n, 0);
  assert.ok(Sync.list(PROJECT).items.some(row => row.source.rowId === 'foreign-char' && row.kind === 'needs_confirmation'));
  approve('P2-11', sourceRows('chars', [
    ['SAFE-CHAR', '正式确认的项目特性', '', 'SC', '', '', '产品特性'],
  ], ['formal-safe']));
  Sync.syncProject(PROJECT);
  assert.equal(get('SELECT char_kind FROM project_char WHERE project_id=? AND char_id=?', PROJECT, 'SAFE-CHAR').char_kind,
    'PRODUCT');
  approve('P2-11', sourceRows('chars', [
    ['SAFE-CHAR', '缺显式类型的正式行', '', 'SC', '', ''],
  ], ['formal-unsafe']));
  Sync.syncProject(PROJECT);
  assert.equal(get('SELECT name FROM project_char WHERE project_id=? AND char_id=?', PROJECT, 'SAFE-CHAR').name,
    '正式确认的项目特性', '无效正式来源不能覆盖已正式确认的项目特性');
  approve('P2-11', sourceRows('chars', [
    ['SAFE-CHAR', '错误类型正式行', '', 'SC', '', '', '过程特性'],
  ], ['formal-wrong-kind']));
  Sync.syncProject(PROJECT);
  assert.equal(get('SELECT char_kind FROM project_char WHERE project_id=? AND char_id=?', PROJECT, 'SAFE-CHAR').char_kind, 'PRODUCT',
    '现有字典类型与来源类型不同不能跨类型复用编号');
  assert.ok(Sync.list(PROJECT).items.some(row => row.source.rowId === 'formal-wrong-kind' && row.kind === 'needs_confirmation'));
  approve('P2-11', sourceRows('chars', [[
    'SAFE-CHAR', '顾客分类与组织分类不一致', '', '组织分类', '', '', '产品特性',
    '顾客-SC', '组织-CC', '',
  ]], ['formal-classification-conflict']));
  Sync.syncProject(PROJECT);
  assert.equal(get('SELECT char_kind FROM project_char WHERE project_id=? AND char_id=?', PROJECT, 'SAFE-CHAR').char_kind,
    'PRODUCT', '没有顾客认可依据时，组织分类不得覆盖顾客分类');
  assert.ok(Sync.list(PROJECT).items.some(row =>
    row.source.rowId === 'formal-classification-conflict' && row.kind === 'needs_confirmation'));

  approve('P2-03', sourceRows('dvp', [
    ['1', '阻值', '试验A', '准则A', '方法A', '负责人', '2026-11-01', '设计实测A', '通过'],
    ['2', '耐压', '试验B', '准则B', '方法B', '', '', '设计实测B', '通过'],
  ], ['dvp-a', 'dvp-b']));
  Sync.syncProject(PROJECT);
  assert.equal(data('P4-05').tests[0][0], '试验A');
  assert.equal(data('P4-05').tests[0][3], '', '不复制DVP结果为生产实测');
  const targetData = data('P4-05');
  targetData.tests[0][3] = '生产真实测量';
  doc('P4-05', targetData);
  approve('P2-03', sourceRows('dvp', [
    ['2', '耐压', '试验B', '新准则B', '方法B'],
    ['1', '阻值', '试验A', '新准则A', '方法A'],
  ], ['dvp-b', 'dvp-a']));
  Sync.syncProject(PROJECT);
  assert.equal(data('P4-05').tests[0][2], '新准则A', '来源排序变化按稳定ID匹配');
  assert.equal(data('P4-05').tests[0][3], '生产真实测量', '只更新要求，不清除下游真实结果');
  assert.equal(data('P4-05').tests[1][2], '新准则B');
  const linkedRows = Sync.list(PROJECT, 'P4-05').items.filter(row => row.ruleId === 'dvp-production-test');
  assert.equal(linkedRows.length, 2);
  const removedData = data('P4-05');
  removedData.tests.shift();
  removedData._syncRows.tests.shift();
  doc('P4-05', removedData);
  Sync.syncProject(PROJECT);
  assert.equal(data('P4-05').tests.length, 1, '已删下游行不能因读取/再次同步而恢复');
  assert.ok(Sync.list(PROJECT, 'P4-05').items.some(row => row.ruleId === 'dvp-production-test' && row.state === 'conflict'));

  approve('P3-02', sourceRows('pack', [['外箱', '纸箱', '20', '型号批次', '防潮']], ['pack-1']));
  Sync.syncProject(PROJECT);
  assert.ok(data('P4-06').items[0][2].includes('防潮'));
  assert.equal(data('P4-06').items[0][3], '');
  assert.ok(!Sync.list(PROJECT).items.some(row => row.ruleId.includes('AAR')), '包装评价不能变成外观批准');

  const msaPlans = [{ plan_id: 'MP-1', char_name: '阻值', gauge_id: 'G-1', gauge_name: '电桥',
    study_type: 'GRR', parts: 10, operators: 3, trials: 3, planned_date: '2026-11-01', owner: '计量', status: '计划' }];
  doc('P3-08', { approved: '原签署', note: '保留说明' });
  Sync.syncMsaPlanDocument(PROJECT, msaPlans);
  assert.equal(data('P3-08').plan[0][0], '阻值');
  assert.equal(data('P3-08').approved, '原签署');
  targetStatus('P3-08', '已批准');
  const nextPlans = [{ ...msaPlans[0], gauge_name: '新电桥' }];
  const protectedResult = Sync.syncMsaPlanDocument(PROJECT, nextPlans);
  assert.equal(protectedResult.state, 'review_required');
  assert.equal(data('P3-08').plan[0][2], '电桥');
  assert.throws(() => Sync.resolve(PROJECT, protectedResult.id, 'adopt'), /草稿/);
  const before = DB.db.prepare('SELECT total_changes() n').get().n;
  Sync.list(PROJECT);
  Sync.list(PROJECT, 'P3-08');
  assert.equal(DB.db.prepare('SELECT total_changes() n').get().n, before, 'list必须纯只读');

  approve('P1-09', sourceRows('bom', [['1', 'MAT-1', '端帽', '铜', '2', '供应商']], ['bom-1']));
  Sync.syncProject(PROJECT);
  const bomItem = syncItem('bom-dfmea');
  assert.equal(get('SELECT COUNT(*) n FROM fmea_node WHERE fmea_id=?', 'DF-SYNC').n, 0);
  Sync.resolve(PROJECT, bomItem.id, 'adopt');
  assert.equal(get('SELECT name FROM fmea_node WHERE node_id=?', bomItem.target.id).name, '端帽');
  assert.equal(get('SELECT COUNT(*) n FROM fmea_function WHERE node_id=?', bomItem.target.id).n, 0, 'BOM不得自动生成功能');

  approve('P0-10', sourceRows('plan', [['3', '过程评审', '2026-11-01', '2026-11-15', '工艺', 'P3-06']], ['task-1']));
  Sync.syncProject(PROJECT);
  const taskItem = syncItem('project-task');
  assert.equal(get('SELECT due FROM apqp_task WHERE task_id=?', taskItem.target.id).due, '2026-11-15');
  const totalTasks = get('SELECT COUNT(*) n FROM apqp_task WHERE project_id=?', PROJECT).n;
  Sync.syncProject(PROJECT);
  assert.equal(get('SELECT COUNT(*) n FROM apqp_task WHERE project_id=?', PROJECT).n, totalTasks);
  const catalogReference = Sync.list(PROJECT, 'P1-16').items
    .find(link => link.ruleId === 'catalog-reference:P1-16');
  assert.equal(catalogReference.display.sourceName, '项目质量策划时间计划');
  assert.equal(catalogReference.display.sourceCode, 'P0-10');
  assert.match(catalogReference.display.version, /^V\d+(?:\.\d+)*$/);
  assert.equal(catalogReference.display.targetName, 'APQP 项目指标');
  assert.equal(catalogReference.display.fields.length, 0, '目录关系元数据不应冒充业务字段');
  assert.doesNotMatch(JSON.stringify(catalogReference.display), /approved_revision|source_document|REV-/);

  run(`INSERT INTO control_plan(cp_id,project_id,stage,status) VALUES('CP-SYNC',?,'PILOT','草稿')`, PROJECT);
  run(`INSERT INTO cp_row(cp_row_id,cp_id,control_method) VALUES('CPR-SYNC','CP-SYNC','人工控制方法')`);
  const cpOptions = {
    ruleId: 'pfmea-cp:CPR-SYNC', source: { code: 'P3-06', rowId: 'FROW-1', version: 'r1', status: '已发布' },
    target: { type: 'cp_row', id: 'CPR-SYNC' }, values: { control_method: '上游控制方法', measure_tech: '上游测量技术' },
  };
  const cpSync = Sync.syncFields(PROJECT, cpOptions);
  assert.equal(cpSync.state, 'conflict', '首次没有同步历史的非空人工CP字段不能被覆盖');
  assert.equal(get('SELECT control_method FROM cp_row WHERE cp_row_id=?', 'CPR-SYNC').control_method, '人工控制方法');
  assert.equal(get('SELECT measure_tech FROM cp_row WHERE cp_row_id=?', 'CPR-SYNC').measure_tech, '上游测量技术');
  run("UPDATE control_plan SET status='已批准' WHERE cp_id='CP-SYNC'");
  assert.throws(() => Sync.resolve(PROJECT, cpSync.id, 'adopt'), /草稿/);
  run("UPDATE control_plan SET status='草稿' WHERE cp_id='CP-SYNC'");
  Sync.resolve(PROJECT, cpSync.id, 'adopt');
  assert.equal(get('SELECT control_method FROM cp_row WHERE cp_row_id=?', 'CPR-SYNC').control_method, '上游控制方法');
  const createdCp = Sync.syncFields(PROJECT, {
    ...cpOptions, ruleId: 'pfmea-cp:NEW-CPR', target: { type: 'cp_row', id: 'NEW-CPR', cpId: 'CP-SYNC' },
  });
  assert.equal(createdCp.created, 1);
  assert.equal(createdCp.state, 'synced');
  run(`UPDATE cp_row SET override_flag=1,override_fields_json=? WHERE cp_row_id='NEW-CPR'`,
    JSON.stringify(['control_method', 'reaction_plan']));
  const explicitOptions = {
    ...cpOptions, ruleId: 'pfmea-cp:NEW-CPR', source: { ...cpOptions.source, version: 'r2' },
    target: { type: 'cp_row', id: 'NEW-CPR', cpId: 'CP-SYNC' },
    values: { control_method: '上游r2控制', measure_tech: '上游测量技术' },
  };
  const explicitConflict = Sync.syncFields(PROJECT, explicitOptions);
  assert.equal(explicitConflict.state, 'conflict', '同值人工标记覆盖后，上游新值仍须冲突，不仅比较当前值和last');
  assert.equal(get("SELECT control_method FROM cp_row WHERE cp_row_id='NEW-CPR'").control_method, '上游控制方法');
  const beforeKeep = get("SELECT * FROM cp_row WHERE cp_row_id='NEW-CPR'");
  Sync.resolve(PROJECT, explicitConflict.id, 'keep');
  assert.deepEqual(get("SELECT * FROM cp_row WHERE cp_row_id='NEW-CPR'"), beforeKeep, 'keep不得修改CP业务字段或覆盖标记');
  assert.equal(Sync.syncFields(PROJECT, explicitOptions).state, 'kept', '已keep同源值不反复冲突');
  const explicitNew = { ...explicitOptions, source: { ...explicitOptions.source, version: 'r3' },
    values: { ...explicitOptions.values, control_method: '上游r3控制' } };
  assert.equal(Sync.syncFields(PROJECT, explicitNew).state, 'conflict', 'keep后新源值变化再提示');
  Sync.resolve(PROJECT, explicitConflict.id, 'adopt');
  let adoptedCp = get("SELECT * FROM cp_row WHERE cp_row_id='NEW-CPR'");
  assert.equal(adoptedCp.control_method, '上游r3控制');
  assert.deepEqual(JSON.parse(adoptedCp.override_fields_json), ['reaction_plan'], '采用仅清除对应字段，保留其他人工保护');
  assert.equal(adoptedCp.override_flag, 1);
  const afterAdopt = { ...explicitNew, source: { ...explicitNew.source, version: 'r4' },
    values: { ...explicitNew.values, control_method: '上游r4控制' } };
  Sync.syncFields(PROJECT, afterAdopt);
  assert.equal(get("SELECT control_method FROM cp_row WHERE cp_row_id='NEW-CPR'").control_method, '上游r4控制',
    '采用后对应旧override不能再次阻止正常同步');
  run(`UPDATE cp_row SET control_method='重新人工修改',override_flag=1,override_fields_json=?
    WHERE cp_row_id='NEW-CPR'`, JSON.stringify(['control_method']));
  assert.equal(Sync.syncFields(PROJECT, afterAdopt).state, 'conflict',
    '没有keep确认的同源人工改动仍要提示，不能误当作已确认保留');

  const legacyOptions = { ...cpOptions, ruleId: 'pfmea-cp:LEGACY-OVERRIDE',
    target: { type: 'cp_row', id: 'LEGACY-OVERRIDE', cpId: 'CP-SYNC' } };
  Sync.syncFields(PROJECT, legacyOptions);
  run(`UPDATE cp_row SET override_flag=1,override_fields_json='[]' WHERE cp_row_id='LEGACY-OVERRIDE'`);
  const legacyNew = { ...legacyOptions, source: { ...legacyOptions.source, version: 'r2' },
    values: { control_method: 'legacy新控制', measure_tech: 'legacy新测量' } };
  const legacyConflict = Sync.syncFields(PROJECT, legacyNew);
  assert.equal(legacyConflict.state, 'conflict', 'legacy整行override保护所有incoming字段');
  assert.equal(get("SELECT control_method FROM cp_row WHERE cp_row_id='LEGACY-OVERRIDE'").control_method, '上游控制方法');
  assert.equal(get("SELECT measure_tech FROM cp_row WHERE cp_row_id='LEGACY-OVERRIDE'").measure_tech, '上游测量技术');
  Sync.resolve(PROJECT, legacyConflict.id, 'adopt');
  assert.equal(get("SELECT override_flag FROM cp_row WHERE cp_row_id='LEGACY-OVERRIDE'").override_flag, 0,
    '采用后清除已处理的legacy整行override标记');
  const legacyAfterAdopt = { ...legacyNew, source: { ...legacyNew.source, version: 'r3' },
    values: { ...legacyNew.values, control_method: 'legacy再次新控制' } };
  Sync.syncFields(PROJECT, legacyAfterAdopt);
  assert.equal(get("SELECT control_method FROM cp_row WHERE cp_row_id='LEGACY-OVERRIDE'").control_method, 'legacy再次新控制');
  run("UPDATE control_plan SET status='已批准' WHERE cp_id='CP-SYNC'");
  const lockedCp = Sync.syncFields(PROJECT, {
    ...cpOptions, ruleId: 'pfmea-cp:LOCKED-NEW', target: { type: 'cp_row', id: 'LOCKED-NEW', cpId: 'CP-SYNC' },
  });
  assert.equal(lockedCp.state, 'review_required');
  assert.equal(get("SELECT COUNT(*) n FROM cp_row WHERE cp_row_id='LOCKED-NEW'").n, 0);
  const childNode = Sync.syncFields(PROJECT, {
    ruleId: 'pfd-child-test', source: { code: 'P3-04', rowId: 'STEP-CHILD', version: 'V1.1', status: '已发布' },
    target: { type: 'fmea_node', id: 'NODE-CHILD-TEST', fmeaId: 'DF-SYNC' },
    values: { name: '工步候选', level: 2, parent_id: bomItem.target.id },
  });
  assert.equal(childNode.state, 'synced', '新建节点的level默认值不能被误当人工覆盖');
  assert.equal(get('SELECT level FROM fmea_node WHERE node_id=?', 'NODE-CHILD-TEST').level, 2);

  const displayStepId = 'STEP-DISPLAY-010';
  run(`INSERT INTO process_step(step_id,project_id,step_no,name,step_type,seq,status,ver)
    VALUES(?,?,?,?,'制造',1,'已发布','V1.1')`, displayStepId, PROJECT, '010', '来料检验');
  const moduleReference = Sync.syncFields(PROJECT, {
    ruleId: 'module-reference:P3-07:display-test',
    source: { code: 'P3-04', rowId: displayStepId, version: 'V1.1', status: '已发布' },
    target: { type: 'doc', id: 'P3-07' },
    values: { step_id: displayStepId, step_no: '010', version: 'V1.1' },
    kind: 'reference',
  });
  assert.equal(moduleReference.display.sourceName, '过程流程图（PFD）');
  assert.equal(moduleReference.display.sourceCode, 'P3-04');
  assert.equal(moduleReference.display.summary, '工序 010 · 来料检验');
  assert.deepEqual(moduleReference.display.fields.map(field => field.label), ['工序号']);
  assert.doesNotMatch(JSON.stringify(moduleReference.display), /STEP-DISPLAY-010|step_id/);

  const reference = Sync.list(PROJECT).items.find(row => row.ruleId === 'project-reference:P2-03');
  const referenceBefore = get('SELECT total_changes() n').n;
  assert.equal(reference.state, 'read_only');
  assert.equal(reference.target.type, 'reference');
  Sync.resolve(PROJECT, reference.id, 'adopt');
  assert.equal(get('SELECT total_changes() n').n, referenceBefore, '纯引用采用不得写空目标或增加业务记录');
  assert.equal(reference.incomingValue.project_id, PROJECT);

  const unknownReference = Sync.syncFields(PROJECT, {
    ruleId: 'display-unknown-reference',
    source: { code: 'FUTURE-SOURCE', rowId: 'FUTURE-ROW-ID', version: 'sha256-opaque-value', status: '已发布' },
    target: { type: 'doc', id: 'P4-05' },
    values: { future_internal_id: 'REV-OPAQUE-123', future_row: 'FUTURE-ROW-ID',
      future_payload: { source_row_id: 'ROW-OPAQUE-456' } },
    kind: 'reference',
  });
  assert.equal(unknownReference.display.sourceName, '其他来源');
  assert.equal(unknownReference.display.sourceCode, '');
  assert.equal(unknownReference.display.version, '');
  assert.ok(unknownReference.display.fields.every(field => field.label === '其他关联内容'));
  assert.doesNotMatch(JSON.stringify(unknownReference.display),
    /future_internal_id|future_row|future_payload|FUTURE-ROW-ID|sha256-opaque-value|REV-OPAQUE|ROW-OPAQUE/);

  const otherProject = DB.db.prepare('SELECT project_id FROM project WHERE project_id<>? LIMIT 1').get(PROJECT).project_id;
  assert.throws(() => Sync.resolve(otherProject, taskItem.id, 'adopt'), /不存在/, '项目间不能处理其他项目差异');
  console.log('deliverable-sync: approved snapshots, stable rows, conflict resolution, published protection, MSA view and mappings passed');
} finally {
  if (DB.db) DB.db.close();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()), '仅清理本次创建的系统临时目录');
  fs.rmSync(temporary, { recursive: true, force: true });
}
