'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-control-sync-'));
process.env.QMS_DB_PATH = path.join(directory, 'qms.db');
const DB = require('../lib/db');
const Control = require('../lib/control-sync');
const DS = require('../lib/deliverable-sync');
const run = (sql, ...args) => DB.db.prepare(sql).run(...args);
const one = (sql, ...args) => DB.db.prepare(sql).get(...args);
const all = (sql, ...args) => DB.db.prepare(sql).all(...args);
const projectId = 'CONTROL-TEST';

try {
  DB.init();
  Control.init();
  run("INSERT INTO project(project_id,name) VALUES(?,?)", projectId, 'Control test');
  run("INSERT INTO fmea_header(fmea_id,project_id,fmea_type,status,rev) VALUES(?,?,'PFMEA','草稿','r1')",
    'PF-CONTROL', projectId);
  for (const stage of ['PROTO', 'PILOT', 'SOP']) {
    run("INSERT INTO control_plan(cp_id,project_id,stage,status,rev,approved_by) VALUES(?,?,?,'草稿','r1','')",
      `CP-${stage}`, projectId, stage);
  }
  run(`INSERT INTO process_step(step_id,project_id,step_no,name,seq,status,ver)
    VALUES('STEP-1',?,'010','Machine',1,'已发布','V1.0')`, projectId);
  run(`INSERT INTO process_step(step_id,project_id,step_no,name,seq,parent_step_id,status,ver)
    VALUES('STEP-1A',?,'010-1','Load',2,'STEP-1','已发布','V1.0')`, projectId);
  run(`INSERT INTO process_step(step_id,project_id,step_no,name,seq,status,ver)
    VALUES('STEP-2',?,'020','Inspection',3,'草稿','V1.0')`, projectId);
  let result = Control.fromPfd(projectId);
  assert.equal(result.nodes, 3, 'All active PFD steps, including drafts, become PFMEA structure');
  assert.equal(result.draft_steps, 1, 'Draft PFD steps must be counted and visibly reported');
  const parentLink = one("SELECT * FROM pfd_fmea_link WHERE project_id=? AND step_id='STEP-1'", projectId);
  const childLink = one("SELECT * FROM pfd_fmea_link WHERE project_id=? AND step_id='STEP-1A'", projectId);
  const draftLink = one("SELECT * FROM pfd_fmea_link WHERE project_id=? AND step_id='STEP-2'", projectId);
  assert.equal(one('SELECT parent_id FROM fmea_node WHERE node_id=?', childLink.node_id).parent_id, parentLink.node_id);
  assert.ok(draftLink && one('SELECT 1 FROM fmea_node WHERE node_id=?', draftLink.node_id),
    'A draft PFD step must still receive a stable PFMEA node');
  result = Control.fromPfd(projectId);
  assert.equal(result.created_nodes, 0, 'Repeated PFD sync must be incremental');
  assert.equal(result.nodes, 3, 'Repeated sync must still report the current structure total');
  run("INSERT INTO fmea_function(func_id,node_id,text,status) VALUES('FUNC-KEEP',?,'Keep function','正式')", parentLink.node_id);
  run("UPDATE fmea_node SET name='Manual structure name' WHERE node_id=?", parentLink.node_id);
  run("UPDATE process_step SET name='New source name',ver='V1.1' WHERE step_id='STEP-1'");
  result = Control.fromPfd(projectId);
  assert.ok(result.conflicts > 0);
  assert.equal(one('SELECT name FROM fmea_node WHERE node_id=?', parentLink.node_id).name, 'Manual structure name');
  assert.ok(one("SELECT * FROM fmea_function WHERE func_id='FUNC-KEEP'"));
  assert.equal(Control.fromPfd(projectId, { with4m: true }).created.length, 12);
  assert.equal(Control.fromPfd(projectId, { with4m: true }).created.length, 0, 'Explicit 4M creation is idempotent');
  run("UPDATE fmea_header SET status='已发布',rev='r2' WHERE fmea_id='PF-CONTROL'");
  run(`INSERT INTO process_step(step_id,project_id,step_no,name,seq,status,ver)
    VALUES('STEP-NEW',?,'030','New operation',4,'已发布','V1.0')`, projectId);
  const nodesBefore = one("SELECT COUNT(*) n FROM fmea_node WHERE fmea_id='PF-CONTROL'").n;
  assert.ok(Control.fromPfd(projectId).conflicts > 0);
  assert.equal(one("SELECT COUNT(*) n FROM fmea_node WHERE fmea_id='PF-CONTROL'").n, nodesBefore,
    'Published PFMEA cannot receive structure changes');
  run("UPDATE fmea_header SET status='草稿' WHERE fmea_id='PF-CONTROL'");
  Control.fromPfd(projectId);

  for (const [charId, kind] of [['CHAR-PRODUCT', 'PRODUCT'], ['CHAR-PROCESS', 'PROCESS']]) {
    run("INSERT INTO char_master(char_id,char_kind,name,tol_text) VALUES(?,?,?,'10 +/- 1')", charId, kind, charId);
    DB.ensureProjectChar(projectId, charId);
  }
  for (const [rowId, pc, dc] of [['FR-1', 'Prevention A', 'Detection A'], ['FR-2', 'Prevention B', 'Detection B']]) {
    run(`INSERT INTO fmea_row(row_id,fmea_id,focus_node_id,step_id,char_id,process_char_id,pc_text,dc_text,seq)
      VALUES(?,'PF-CONTROL',?,'STEP-1','CHAR-PRODUCT','CHAR-PROCESS',?,?,?)`,
    rowId, parentLink.node_id, pc, dc, rowId === 'FR-1' ? 1 : 2);
  }
  run("UPDATE fmea_header SET status='已发布',rev='r3' WHERE fmea_id='PF-CONTROL'");
  result = Control.generate('CP-PILOT');
  assert.equal(result.created.length, 2, 'Both product and process characteristics must become CP rows');
  assert.equal(result.basic.length, 2, 'Other published steps need blank draft control rows');
  const mapped = all("SELECT * FROM cp_row WHERE cp_id='CP-PILOT' AND char_id IS NOT NULL");
  assert.deepEqual(mapped.map(row => row.char_id).sort(), ['CHAR-PROCESS', 'CHAR-PRODUCT']);
  assert.ok(mapped.every(row => row.measure_tech.includes('Detection A') && row.measure_tech.includes('Detection B')));
  assert.ok(mapped.every(row => row.control_method.includes('Prevention A') && row.control_method.includes('Prevention B')));
  assert.equal(one('SELECT COUNT(*) n FROM cp_fmea_link WHERE cp_row_id IN (?,?)',
    mapped[0].cp_row_id, mapped[1].cp_row_id).n, 4, 'Every grouped PFMEA source row must remain traceable');
  assert.ok(mapped.every(row => row.sample_size == null && row.freq_value == null && !row.reaction_plan),
    'Mapping must not invent sampling, frequency or reactions');
  const empty = all("SELECT * FROM cp_row WHERE cp_id='CP-PILOT' AND char_id IS NULL");
  assert.ok(empty.every(row => !row.control_method && !row.measure_tech && !row.spec_text));
  const count = one("SELECT COUNT(*) n FROM cp_row WHERE cp_id='CP-PILOT'").n;
  Control.generate('CP-PILOT');
  assert.equal(one("SELECT COUNT(*) n FROM cp_row WHERE cp_id='CP-PILOT'").n, count);
  const snapshotBeforeDraft = mapped[0].measure_tech;
  run("UPDATE fmea_header SET status='草稿' WHERE fmea_id='PF-CONTROL'");
  run("UPDATE fmea_row SET dc_text='Unapproved draft detection' WHERE row_id='FR-1'");
  Control.generate('CP-PILOT');
  assert.equal(one('SELECT measure_tech FROM cp_row WHERE cp_row_id=?', mapped[0].cp_row_id).measure_tech,
    snapshotBeforeDraft, 'Draft PFMEA changes cannot replace published measurement controls');
  run("UPDATE fmea_header SET status='已发布',rev='r3' WHERE fmea_id='PF-CONTROL'");

  const row = mapped[0];
  run(`UPDATE cp_row SET measure_tech='Human measurement',override_flag=1,
    override_fields_json='["measure_tech"]' WHERE cp_row_id=?`, row.cp_row_id);
  run("UPDATE fmea_row SET dc_text='New detection' WHERE row_id='FR-1'");
  run("UPDATE fmea_header SET rev='r4' WHERE fmea_id='PF-CONTROL'");
  result = Control.generate('CP-PILOT');
  assert.ok(result.conflicts > 0);
  assert.ok(result.overridden.includes(row.cp_row_id));
  assert.equal(one('SELECT measure_tech FROM cp_row WHERE cp_row_id=?', row.cp_row_id).measure_tech, 'Human measurement');
  const measurementConflict = () => DS.list(projectId).items.find(item =>
    item.ruleId === 'control:pfmea-cp:CP-PILOT' && item.target.id === row.cp_row_id);
  assert.equal(measurementConflict().state, 'conflict');
  assert.ok(measurementConflict().details.some(detail => detail.field === 'measure_tech' && detail.state === 'conflict'),
    'Explicitly protected CP fields must still expose upstream differences');
  DS.resolve(projectId, measurementConflict().id, 'keep');
  Control.generate('CP-PILOT');
  assert.equal(measurementConflict().state, 'kept', 'Keeping a human value must silence the same source value');
  run("UPDATE fmea_row SET dc_text='Newer detection' WHERE row_id='FR-1'");
  run("UPDATE fmea_header SET rev='r4-next' WHERE fmea_id='PF-CONTROL'");
  Control.generate('CP-PILOT');
  assert.equal(measurementConflict().state, 'conflict', 'A changed published source must prompt again');
  assert.equal(one('SELECT measure_tech FROM cp_row WHERE cp_row_id=?', row.cp_row_id).measure_tech, 'Human measurement');
  DS.resolve(projectId, measurementConflict().id, 'keep');
  run("UPDATE cp_row SET override_fields_json='[]' WHERE cp_row_id=?", row.cp_row_id);
  const protectedControl = one('SELECT control_method FROM cp_row WHERE cp_row_id=?', row.cp_row_id).control_method;
  run("UPDATE fmea_row SET pc_text='Fully protected source prevention' WHERE row_id='FR-1'");
  run("UPDATE fmea_header SET rev='r4-full' WHERE fmea_id='PF-CONTROL'");
  Control.generate('CP-PILOT');
  assert.equal(one('SELECT control_method FROM cp_row WHERE cp_row_id=?', row.cp_row_id).control_method,
    protectedControl, 'An override flag without a field list protects the complete row');
  assert.equal(measurementConflict().state, 'conflict');
  assert.ok(Object.hasOwn(measurementConflict().incomingValue, 'control_method'),
    'The complete upstream value set must remain available for review');
  run("UPDATE control_plan SET status='已批准',approved_by='Source approver' WHERE cp_id='CP-PILOT'");
  const approvedRows = all("SELECT * FROM cp_row WHERE cp_id='CP-PILOT' ORDER BY cp_row_id");
  run("UPDATE fmea_row SET pc_text='Changed source prevention' WHERE row_id='FR-1'");
  run("UPDATE fmea_header SET rev='r5' WHERE fmea_id='PF-CONTROL'");
  assert.ok(Control.generate('CP-PILOT').conflicts > 0);
  assert.deepEqual(all("SELECT * FROM cp_row WHERE cp_id='CP-PILOT' ORDER BY cp_row_id"), approvedRows,
    'Approved CP rows must remain unchanged');
  result = Control.syncProject(projectId);
  const inherited = all("SELECT * FROM cp_row WHERE cp_id='CP-SOP'");
  assert.equal(inherited.length, count, 'Approved PILOT rows should flow to SOP draft');
  assert.equal(one("SELECT status FROM control_plan WHERE cp_id='CP-SOP'").status, '草稿');
  assert.equal(one("SELECT approved_by FROM control_plan WHERE cp_id='CP-SOP'").approved_by, '');
  assert.equal(one("SELECT COUNT(*) n FROM cp_stage_link WHERE target_cp_id='CP-SOP'").n, count);
  assert.ok(!DS.list(projectId).items.some(item => item.ruleId === 'control:pfmea-cp:CP-SOP'),
    'Inherited SOP rows must follow approved PILOT controls instead of bypassing the stage');
  Control.syncProject(projectId);
  assert.equal(one("SELECT COUNT(*) n FROM cp_row WHERE cp_id='CP-SOP'").n, count);
  assert.ok(DS.list(projectId).items.some(item => item.ruleId.includes('control:') && item.state === 'review_required'));
  run("DELETE FROM fmea_row WHERE fmea_id='PF-CONTROL'");
  run("UPDATE fmea_header SET rev='r6' WHERE fmea_id='PF-CONTROL'");
  Control.generate('CP-PILOT');
  assert.ok(DS.list(projectId).items.some(item =>
    item.ruleId === 'control:pfmea-cp:CP-PILOT' && item.state === 'source_missing'));
  assert.equal(one("SELECT COUNT(*) n FROM cp_row WHERE cp_id='CP-PILOT'").n, count,
    'Removing published analysis must preserve downstream CP records');

  run(`INSERT INTO control_plan(cp_id,project_id,stage,status,rev)
    VALUES('CP-LEGACY',?,'PILOT','草稿','r1')`, projectId);
  run(`INSERT INTO cp_row(cp_row_id,cp_id,step_id,char_id,spec_text)
    VALUES('CP-LEGACY-ROW','CP-LEGACY','STEP-1','CHAR-PRODUCT','Human spec')`);
  run(`INSERT INTO fmea_row(row_id,fmea_id,focus_node_id,step_id,char_id,pc_text,dc_text,seq)
    VALUES('FR-NEW','PF-CONTROL',?,'STEP-1','CHAR-PRODUCT','Prevent','Detect',1)`, parentLink.node_id);
  run("UPDATE fmea_header SET rev='r7' WHERE fmea_id='PF-CONTROL'");
  assert.ok(Control.generate('CP-LEGACY').conflicts > 0);
  assert.equal(one("SELECT COUNT(*) n FROM cp_row WHERE cp_id='CP-LEGACY' AND char_id='CHAR-PRODUCT'").n, 1,
    'Unlinked legacy rows cannot be guessed, overwritten or silently duplicated');
  assert.equal(one("SELECT spec_text FROM cp_row WHERE cp_row_id='CP-LEGACY-ROW'").spec_text, 'Human spec');
  run("INSERT INTO project(project_id,name) VALUES('CONTROL-OTHER','Other project')");
  assert.throws(() => DS.resolve('CONTROL-OTHER',
    DS.list(projectId).items.find(item => item.ruleId === 'control:pfmea-cp:CP-LEGACY').id, 'adopt'),
  /不存在/, 'Cross-project resolution must fail');
  console.log('Control sync unit tests passed');
} finally {
  try { DB.db.close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
}
