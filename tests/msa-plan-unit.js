'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resistor-msa-plan-'));
process.env.QMS_DB_PATH = path.join(tempDir, 'qms.db');
const DB = require('../lib/db');

function setup() {
  DB.init();
  DB.db.exec(`
    INSERT INTO project(project_id,name,owner) VALUES('MSA-P1','MSA test 1','Owner 1');
    INSERT INTO project(project_id,name,owner) VALUES('MSA-P2','MSA test 2','Owner 2');
    INSERT INTO project(project_id,name,owner) VALUES('MSA-P3','MSA plan document','Owner 3');
    INSERT INTO char_master(char_id,char_kind,name,unit,lsl,usl)
      VALUES('MSA-C1','PRODUCT','Diameter','mm',9,11);
    INSERT INTO gauge(gauge_id,code,name,status) VALUES('MSA-G1','MSA-G1','Gauge 1','在用');
    INSERT INTO gauge(gauge_id,code,name,status) VALUES('MSA-G2','MSA-G2','Gauge 2','在用');
    INSERT INTO control_plan(cp_id,project_id,stage,rev,status)
      VALUES('MSA-CP1','MSA-P1','PILOT','r1','已批准');
    INSERT INTO control_plan(cp_id,project_id,stage,rev,status)
      VALUES('MSA-CP2','MSA-P2','PILOT','r1','已冻结');
    INSERT INTO control_plan(cp_id,project_id,stage,rev,status)
      VALUES('MSA-DRAFT','MSA-P1','SOP','r1','草稿');
  `);
  return {
    char1: DB.ensureProjectChar('MSA-P1', 'MSA-C1'),
    char2: DB.ensureProjectChar('MSA-P2', 'MSA-C1'),
    char3: DB.ensureProjectChar('MSA-P3', 'MSA-C1'),
  };
}

function addRow(id, cpId, projectChar, gaugeId, method = 'Micrometer', isSpc = 0) {
  DB.db.prepare(`INSERT INTO process_step(step_id,project_id,step_no,name)
    VALUES(?,?,?,?)`).run(`STEP-${id}`, projectChar.project_id, id, `Step ${id}`);
  DB.db.prepare(`INSERT INTO cp_row(
    cp_row_id,cp_id,seq,step_id,char_id,project_char_id,gauge_id,measure_tech,spec_text,is_spc
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    id, cpId, 1, `STEP-${id}`, projectChar.char_id, projectChar.pchar_id,
    gaugeId, method, '10 +/- 1 mm', isSpc
  );
}

function main() {
  const { char1, char2, char3 } = setup();
  DB.db.exec('CREATE TABLE msa_tx_test(id TEXT PRIMARY KEY)');
  assert.throws(() => DB.tx(() => {
    DB.db.prepare('INSERT INTO msa_tx_test VALUES(?)').run('outer-rollback');
    DB.tx(() => DB.db.prepare('INSERT INTO msa_tx_test VALUES(?)').run('inner-success'));
    throw new Error('rollback outer');
  }), /rollback outer/);
  assert.equal(DB.db.prepare('SELECT COUNT(*) count FROM msa_tx_test').get().count, 0,
    'Releasing an inner savepoint must not commit the outer transaction');
  DB.tx(() => {
    DB.db.prepare('INSERT INTO msa_tx_test VALUES(?)').run('outer-commit');
    assert.throws(() => DB.tx(() => {
      DB.db.prepare('INSERT INTO msa_tx_test VALUES(?)').run('inner-rollback');
      throw new Error('rollback inner');
    }), /rollback inner/);
    assert.equal(DB.db.isTransaction, true, 'An inner failure must leave the outer transaction open');
  });
  assert.deepEqual(DB.db.prepare('SELECT id FROM msa_tx_test').all().map(row => row.id), ['outer-commit']);
  addRow('MSA-R1', 'MSA-CP1', char1, 'MSA-G1');
  addRow('MSA-R2', 'MSA-CP1', char1, 'MSA-G2');
  addRow('MSA-R3', 'MSA-CP1', char1, 'MSA-G1');
  addRow('MSA-D1', 'MSA-DRAFT', char1, 'MSA-G1');
  addRow('MSA-P2-R1', 'MSA-CP2', char2, 'MSA-G1');
  let plans = DB.ensureMsaPlans('MSA-P1');
  assert.equal(plans.length, 3, 'Non-SPC measurement rows and multiple gauges/steps need separate plans');
  assert.ok(plans.every(plan => plan.cp_row_id !== 'MSA-D1'), 'Draft CP must not create formal plans');
  assert.deepEqual(plans.map(plan => plan.cp_row_id).sort(), ['MSA-R1', 'MSA-R2', 'MSA-R3']);
  assert.ok(plans.every(plan => plan.source_version && plan.measure_tech === 'Micrometer'));
  assert.ok(plans.every(plan => plan.step_no && plan.step_name && plan.cp_stage === 'PILOT'));
  assert.ok(plans.every(plan => plan.char_lsl_snapshot === 9 && plan.char_usl_snapshot === 11
    && plan.tolerance === 2 && plan.spec_text === '10 +/- 1 mm'));
  const persisted = DB.db.prepare("SELECT * FROM msa_plan_item WHERE project_id='MSA-P1' ORDER BY plan_id").all();
  DB.ensureMsaPlans('MSA-P1');
  assert.deepEqual(DB.db.prepare("SELECT * FROM msa_plan_item WHERE project_id='MSA-P1' ORDER BY plan_id").all(),
    persisted, 'Repeated ensure must not mutate timestamps or content');
  assert.equal(DB.ensureMsaPlans('MSA-P2').length, 1, 'Projects must remain isolated');

  const completedPlan = plans.find(plan => plan.cp_row_id === 'MSA-R1');
  DB.db.prepare(`UPDATE msa_plan_item SET status='已完成',updated_at='HISTORICAL',
    completed_at='2026-01-01',note='Preserve history' WHERE plan_id=?`).run(completedPlan.plan_id);
  const completedBefore = DB.db.prepare('SELECT * FROM msa_plan_item WHERE plan_id=?').get(completedPlan.plan_id);
  DB.db.prepare("UPDATE cp_row SET gauge_id='MSA-G2' WHERE cp_row_id='MSA-R1'").run();
  plans = DB.ensureMsaPlans('MSA-P1');
  assert.equal(plans.length, 4, 'Changed measurement source must create a new plan');
  const replacedPlan = DB.db.prepare('SELECT * FROM msa_plan_item WHERE plan_id=?').get(completedPlan.plan_id);
  assert.equal(replacedPlan.source_active, 0);
  assert.equal(replacedPlan.source_status, '已替代');
  assert.deepEqual({ ...replacedPlan, source_active: completedBefore.source_active,
    source_status: completedBefore.source_status }, { ...completedBefore },
  'Source flags may change, but completed history must not be overwritten');
  assert.equal(plans.filter(plan => plan.cp_row_id === 'MSA-R1' && plan.source_active === 1).length, 1);

  DB.db.prepare("UPDATE cp_row SET measure_tech='Digital readout' WHERE cp_row_id='MSA-R2'").run();
  assert.equal(DB.ensureMsaPlans('MSA-P1').length, 5, 'Measurement method changes require a new plan');
  DB.db.prepare("UPDATE control_plan SET rev='r2' WHERE cp_id='MSA-CP1'").run();
  plans = DB.ensureMsaPlans('MSA-P1');
  assert.equal(plans.length, 8, 'Source revision changes require new plan snapshots');
  assert.equal(plans.filter(plan => plan.source_active === 1).length, 3);
  DB.db.prepare("UPDATE control_plan SET status='草稿' WHERE cp_id='MSA-CP1'").run();
  plans = DB.ensureMsaPlans('MSA-P1');
  assert.equal(plans.filter(plan => plan.source_active === 1).length, 3,
    'Withdrawing a CP must retain its last approved plans');
  assert.ok(plans.filter(plan => plan.source_active === 1).every(plan => plan.source_status === '待复核'));
  DB.db.prepare("UPDATE control_plan SET status='已批准' WHERE cp_id='MSA-CP1'").run();
  assert.ok(DB.ensureMsaPlans('MSA-P1').filter(plan => plan.source_active === 1)
    .every(plan => plan.source_status === '有效'));

  DB.db.prepare("UPDATE project_char SET lsl=8,usl=12 WHERE pchar_id=?").run(char1.pchar_id);
  DB.ensureMsaPlans('MSA-P1');
  assert.equal(DB.db.prepare('SELECT char_lsl_snapshot FROM msa_plan_item WHERE plan_id=?')
    .get(completedPlan.plan_id).char_lsl_snapshot, 9, 'Completed specifications must remain snapshots');

  const precisePlan = DB.listMsaPlans('MSA-P2')[0];
  const correctStudy = DB.db.prepare(`INSERT INTO msa_study(
    project_id,gauge_id,char_id,project_char_id,result_pct,judgment,studied_at
  ) VALUES(?,?,?,?,?,?,?)`).run('MSA-P2', 'MSA-G1', char2.char_id, char2.pchar_id, 7, '接受', '2026-01-01');
  DB.db.prepare(`INSERT INTO msa_study(project_id,gauge_id,char_id,project_char_id,result_pct,judgment,studied_at)
    VALUES(?,?,?,?,?,?,?)`).run('MSA-P1', 'MSA-G1', char1.char_id, char1.pchar_id, 99, '拒绝', '2026-12-31');
  DB.db.prepare(`UPDATE msa_plan_item SET study_id=? WHERE plan_id=?`)
    .run(correctStudy.lastInsertRowid, precisePlan.plan_id);
  const beforeRead = DB.db.prepare('SELECT total_changes() changes').get().changes;
  const exact = DB.listMsaPlans('MSA-P2')[0];
  assert.equal(exact.study_result, 7, 'Research results must match project, characteristic and gauge');
  assert.equal(DB.db.prepare('SELECT total_changes() changes').get().changes,
    beforeRead, 'listMsaPlans must be read-only');
  assert.equal(DB.latestMsaStudy('MSA-P2', char2.pchar_id, 'MSA-G1').result_pct, 7);
  assert.equal(DB.latestMsaStudy('MSA-P2', char1.pchar_id, 'MSA-G1'), null);
  assert.equal(DB.latestMsaStudy(null, char2.pchar_id, 'MSA-G1'), null);
  DB.db.prepare('UPDATE msa_study SET plan_id=?,plan_snapshot_json=? WHERE study_id=?')
    .run(precisePlan.plan_id, JSON.stringify(precisePlan), correctStudy.lastInsertRowid);
  assert.equal(DB.latestMsaStudy('MSA-P2', char2.pchar_id, 'MSA-G1', 'Micrometer').result_pct, 7);
  assert.equal(DB.latestMsaStudy('MSA-P2', char2.pchar_id, 'MSA-G1', 'Different method'), null);
  DB.db.prepare('DELETE FROM cp_row WHERE cp_row_id=?').run(precisePlan.cp_row_id);
  const orphanedPlan = DB.ensureMsaPlans('MSA-P2').find(plan => plan.plan_id === precisePlan.plan_id);
  assert.equal(orphanedPlan.source_active, 0, 'Removing a source row must retire its plan');
  assert.equal(orphanedPlan.source_status, '来源已失效');
  assert.equal(orphanedPlan.study_status, '已计算', 'Invalidating a source must preserve the linked study history');
  assert.ok(DB.db.prepare('SELECT 1 FROM msa_study WHERE study_id=?').get(correctStudy.lastInsertRowid));
  addRow('MSA-A1', 'MSA-CP1', char1, 'MSA-G1', '目视合格/不合格判定');
  const attribute = DB.ensureMsaPlans('MSA-P1').find(plan => plan.cp_row_id === 'MSA-A1');
  assert.equal(attribute.study_type, 'ATTRIBUTE', 'Explicit attribute methods must not be labelled GRR');
  assert.equal(attribute.study_result, null, 'A plan must not fabricate an algorithm result');

  const insertPlanRevision = (revId, version, row, rowId, approvedAt) => {
    DB.db.prepare(`INSERT INTO project_doc_revision(
      rev_id,doc_code,project_id,version,status,data_json,cols_json,changed_by,changed_at,
      change_note,approved_by,approved_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      revId, 'P3-08', 'MSA-P3', version, '已批准',
      JSON.stringify({ plan: [row], _syncRows: { plan: [rowId] } }),
      JSON.stringify({ plan: ['特性', '检具编号', '检具名称', '研究类型', '零件数×人数×次数', '计划日期', '责任人', '状态'] }),
      'Tester', approvedAt, 'MSA plan approved', 'Quality Approver', approvedAt,
    );
  };
  insertPlanRevision('REV-MSA-P3-1', 'V1.0',
    ['Diameter', 'MSA-G1', 'Gauge 1', 'GRR', '10×3×3', '2026-12-01', 'Owner 3', '计划'],
    'P3-08-ROW-1', '2026-11-01 10:00:00');
  let documentPlans = DB.ensureMsaPlans('MSA-P3');
  assert.equal(documentPlans.length, 1, 'Approved P3-08 row must create an MSA plan');
  assert.equal(documentPlans[0].trigger_source, 'P3-08');
  assert.equal(documentPlans[0].gauge_id, 'MSA-G1');
  assert.equal(documentPlans[0].project_char_id, char3.pchar_id);
  assert.equal(documentPlans[0].source_active, 1);

  insertPlanRevision('REV-MSA-P3-2', 'V1.1',
    ['', '', '划线机', 'GRR', '10×3×3', '2026-12-02', 'Owner 3', '计划'],
    'P3-08-ROW-2', '2026-11-02 10:00:00');
  documentPlans = DB.ensureMsaPlans('MSA-P3');
  const activeDocumentPlans = documentPlans.filter(plan => plan.source_active === 1);
  assert.equal(activeDocumentPlans.length, 1);
  assert.equal(activeDocumentPlans[0].gauge_id, null);
  assert.equal(activeDocumentPlans[0].gauge_name, '划线机',
    'An unmatched gauge name must remain visible on the MSA plan');
  assert.equal(documentPlans.filter(plan => plan.source_active === 0).length, 1);
  DB.ensureMsaPlans('MSA-P3');
  assert.equal(DB.db.prepare("SELECT COUNT(*) n FROM msa_plan_item WHERE project_id='MSA-P3'").get().n, 2,
    'Repeated P3-08 ingestion must not duplicate plans');

  assert.ok(DB.db.prepare('PRAGMA table_info(msa_study)').all().some(column => column.name === 'plan_snapshot_json'));
  DB.db.close();

  const legacyDb = new DatabaseSync(process.env.QMS_DB_PATH);
  legacyDb.exec(`
    DROP TABLE msa_plan_item;
    CREATE TABLE msa_plan_item(
      plan_id TEXT PRIMARY KEY, project_id TEXT, project_char_id TEXT, char_id TEXT,
      gauge_id TEXT, study_type TEXT DEFAULT 'GRR', parts INTEGER DEFAULT 10,
      operators INTEGER DEFAULT 3, trials INTEGER DEFAULT 3, planned_date TEXT,
      owner TEXT, status TEXT DEFAULT '计划', trigger_source TEXT DEFAULT 'SPC',
      study_id INTEGER, cp_row_id TEXT, monitor_id TEXT, note TEXT,
      created_at TEXT, updated_at TEXT, completed_at TEXT,
      UNIQUE(project_id,project_char_id)
    );
    INSERT INTO msa_plan_item(plan_id,project_id,project_char_id,status,study_id,note,updated_at)
      VALUES('LEGACY-PLAN','MSA-P1','LEGACY-CHAR','已完成',12345,'Preserve legacy','LEGACY-TIME');
  `);
  legacyDb.prepare(`INSERT INTO msa_plan_item(
    plan_id,project_id,project_char_id,char_id,gauge_id,cp_row_id,study_type,status,study_id,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'LEGACY-P2', 'MSA-P2', char2.pchar_id, char2.char_id, 'MSA-G1', 'MSA-P2-R1',
    'GRR', '已完成', correctStudy.lastInsertRowid, 'LEGACY-P2-TIME'
  );
  legacyDb.prepare('UPDATE msa_study SET plan_id=? WHERE study_id=?')
    .run('LEGACY-P2', correctStudy.lastInsertRowid);
  legacyDb.close();
  DB.init();
  const legacy = DB.db.prepare("SELECT * FROM msa_plan_item WHERE plan_id='LEGACY-PLAN'").get();
  assert.equal(legacy.study_id, 12345);
  assert.equal(legacy.note, 'Preserve legacy');
  assert.equal(legacy.updated_at, 'LEGACY-TIME');
  const completedLegacy = DB.listMsaPlans('MSA-P2');
  assert.equal(completedLegacy.length, 1, 'A matching legacy completed plan must not be duplicated');
  assert.equal(completedLegacy[0].plan_id, 'LEGACY-P2');
  assert.equal(completedLegacy[0].updated_at, 'LEGACY-P2-TIME');
  const preservedStudy = DB.db.prepare('SELECT * FROM msa_study WHERE study_id=?')
    .get(correctStudy.lastInsertRowid);
  assert.equal(preservedStudy.plan_id, 'LEGACY-P2', 'Legacy study references must survive migration');
  assert.ok(preservedStudy.plan_snapshot_json, 'Stored study snapshots must survive migration');
  DB.db.prepare(`INSERT INTO msa_plan_item(plan_id,project_id,project_char_id,status)
    VALUES('LEGACY-PLAN-2','MSA-P1','LEGACY-CHAR','计划')`).run();
  DB.db.close();
  console.log('MSA plan unit tests passed');
}

try {
  main();
} finally {
  try { DB.db.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
}
